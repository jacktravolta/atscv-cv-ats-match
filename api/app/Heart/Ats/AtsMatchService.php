<?php
declare(strict_types=1);

namespace App\Heart\Ats;

use App\Chat\BrainAdapter;
use App\Chat\BrainAdapterFactory;
use App\Chat\BrainException;
use App\Core\AppLog;
use App\Credits\CreditService;
use App\Credits\TariffService;
use App\Ingest\TextIngest;
use App\Rag\KnowledgeBase;
use PDOException;
use Throwable;

/**
 * The gap report (stage 1 of the CV ATS Match product).
 *
 * ORDER OF OPERATIONS (this order IS the contract):
 *   1. Replay check — a stored report for this operation id is returned
 *      as-is: no brain call, no charge.
 *   2. Brain call 1 (profile) and brain call 2 (offer), SEQUENTIALLY.
 *   3. Brain call 3 (compare) over the two validated JSON objects.
 *   4. Validate every answer. An unusable answer fails the request WITHOUT
 *      charging: the person did not get a report, so they do not pay.
 *   5. Charge (the first report of each user is free).
 *   6. Persist the report and show the CV + the offer in "Mis archivos".
 *
 * WHY CALLS 1 AND 2 ARE NOT PARALLEL: the product spec asks for a
 * Promise.all, but this platform has NO concurrency primitive (no curl_multi,
 * no promises). FailoverBrainAdapter rebuilds an AiProviderManager per call
 * and every call carries its own ai.total_budget_s budget (default 30s), so
 * running them at the same time would multiply the provider pressure of one
 * request and break the per-call budget the rotator enforces. The calls are
 * therefore sequential; the total latency grows, the behaviour stays inside
 * the platform's cost governance.
 */
final class AtsMatchService
{
    /** Longest CV text accepted (characters). */
    public const MAX_TEXT_CHARS = 20000;

    private AtsRepository $repository;
    private BrainAdapter $brain;
    private TariffService $tariffs;
    private CreditService $credits;
    private KnowledgeBase $knowledgeBase;
    private TextIngest $textIngest;

    public function __construct(
        ?AtsRepository $repository = null,
        ?BrainAdapter $brain = null,
        ?TariffService $tariffs = null,
        ?CreditService $credits = null,
        ?KnowledgeBase $knowledgeBase = null,
        ?TextIngest $textIngest = null
    ) {
        $this->repository = $repository ?? new AtsRepository();
        $this->brain = $brain ?? BrainAdapterFactory::create();
        $this->tariffs = $tariffs ?? new TariffService();
        $this->credits = $credits ?? new CreditService();
        $this->knowledgeBase = $knowledgeBase ?? new KnowledgeBase();
        $this->textIngest = $textIngest ?? new TextIngest();
    }

    /**
     * Produce (or replay) one gap report.
     *
     * @param string      $userId    The authenticated owner.
     * @param string      $cvTexto   The CV text (already parsed/OCRed by the front).
     * @param string      $ofertaTexto The offer text (already parsed/OCRed by the front).
     * @param string|null $clientKey The client's idempotency key.
     *
     * @return array<string, mixed> The response data.
     *
     * @throws \InvalidArgumentException On invalid input or a foreign operation id.
     * @throws BrainException            When the brain fails or answers unusably (nothing charged).
     * @throws \App\Credits\InsufficientCreditsException When the wallet cannot pay (nothing charged).
     */
    public function run(string $userId, string $cvTexto, string $ofertaTexto, ?string $clientKey = null): array
    {
        $cvTexto = trim($cvTexto);
        $ofertaTexto = trim($ofertaTexto);

        if ($cvTexto === '' || $ofertaTexto === '') {
            throw new \InvalidArgumentException(
                'Necesitamos tu CV y el texto de la oferta para comparar. Revisa que ambos estén completos e inténtalo de nuevo.'
            );
        }

        if (mb_strlen($cvTexto) > self::MAX_TEXT_CHARS || mb_strlen($ofertaTexto) > self::MAX_TEXT_CHARS) {
            throw new \InvalidArgumentException(
                'Alguno de los textos es demasiado largo. Cada documento admite hasta 20.000 caracteres: '
                . 'resume las partes menos relevantes e inténtalo de nuevo.'
            );
        }

        // Serialization BEFORE the model: the texts reach the LLM only after
        // the platform's own ingestion step has canonicalized them
        // (App\Ingest\TextIngest — control characters stripped, newlines and
        // whitespace collapsed). Existing development, reused instead of a
        // second normalization of our own.
        $cvTexto = $this->textIngest->accept($cvTexto);
        $ofertaTexto = $this->textIngest->accept($ofertaTexto);

        $clientKey = trim((string) $clientKey);
        if ($clientKey === '') {
            $clientKey = self::randomKey();
        }

        $operationId = self::operationId($clientKey);

        // 1. Replay BEFORE the brain: a retry never calls the model again.
        $existing = $this->repository->findAnalysis($operationId);

        if ($existing !== null) {
            if ($existing['user_id'] !== $userId) {
                // The operation id is derived from the heart + the client key,
                // NOT from the user (the product fixes that formula), so two
                // accounts can collide on it. The owner rule wins: the other
                // account's report is never returned, and the operation id is
                // refused instead of being reused for a free run.
                throw new \InvalidArgumentException(
                    'Esta clave de operación ya se usó en otra cuenta. Genera una nueva e inténtalo de nuevo.'
                );
            }

            return $this->response($userId, $existing, true);
        }

        // 2. Calls 1 and 2 — sequential on purpose (see the class comment).
        $perfilRaw = $this->ask(
            $operationId . '-perfil',
            AtsPrompts::extractPerfilSystemPrompt(),
            AtsPrompts::extractPerfilUserPrompt($cvTexto)
        );

        $ofertaRaw = $this->ask(
            $operationId . '-oferta',
            AtsPrompts::extractOfertaSystemPrompt(),
            AtsPrompts::extractOfertaUserPrompt($ofertaTexto)
        );

        // 3. Call 3 — the comparison over the two validated objects.
        $perfil = AtsJson::perfil($this->decode($perfilRaw, 'perfil'));
        $oferta = AtsJson::oferta($this->decode($ofertaRaw, 'oferta'));

        $brechaRaw = $this->ask(
            $operationId . '-brecha',
            AtsPrompts::comparaSystemPrompt(),
            AtsPrompts::comparaUserPrompt($perfil, $oferta)
        );

        // 4. Validation. An unusable answer fails the request with nothing
        //    charged: the person did not get a report, so they do not pay.
        $brecha = AtsJson::brecha($this->decode($brechaRaw, 'brecha'));

        $informe = trim((string) ($brecha['informe_markdown'] ?? ''));
        if ($informe === '') {
            $informe = self::composeInforme($brecha);
        }

        $matchScore = (int) ($brecha['match_score'] ?? 0);

        // 5. Charge. The tariff is heart-scoped and NEVER falls back to the
        //    global row: a missing atscv tariff is a configuration error, not
        //    a silent price of 1 credit.
        $tariffCredits = $this->tariffs->creditsFor(AtsModule::OPERATION_MATCH, AtsModule::HEART);

        if ($tariffCredits === null || $tariffCredits <= 0) {
            throw new \RuntimeException(
                'The ' . AtsModule::OPERATION_MATCH . ' tariff is not configured for the '
                . AtsModule::HEART . ' heart.'
            );
        }

        // The free first report is consumed ONLY now: a failed brain call
        // never burns it.
        $primerInformeGratis = $this->repository->consumeTrial($userId, AtsModule::HEART);
        $creditsCharged = 0;

        if (!$primerInformeGratis) {
            $debit = $this->credits->debit(
                $userId,
                $tariffCredits,
                $operationId,
                AtsModule::OPERATION_MATCH,
                ['format' => AtsModule::OPERATION_MATCH],
                AtsModule::HEART
            );

            $creditsCharged = !empty($debit['idempotent_replay']) ? 0 : $tariffCredits;
        }

        // 6. Persist the report.
        try {
            $this->repository->saveAnalysis([
                'user_id' => $userId,
                'heart_id' => AtsModule::HEART,
                'operation_id' => $operationId,
                'perfil' => $perfil,
                'oferta' => $oferta,
                'brecha' => $brecha,
                'informe_texto' => $informe,
                'match_score' => $matchScore,
                'credits_charged' => $creditsCharged,
                'primer_informe_gratis' => $primerInformeGratis,
            ]);
        } catch (PDOException $e) {
            // A concurrent retry stored the same operation first: return ITS
            // report instead of duplicating it.
            if ((string) $e->getCode() === '23000') {
                $stored = $this->repository->findAnalysis($operationId);

                if ($stored !== null && $stored['user_id'] === $userId) {
                    return $this->response($userId, $stored, true);
                }
            }

            throw $e;
        }

        // "Mis archivos": the CV, the offer and the report become visible in
        // the user's inbox. Best effort — the report is already paid for and
        // stored, a listing problem must not undo it.
        $this->registerArtefacts($userId, $operationId, $cvTexto, $ofertaTexto, $informe);

        return [
            'perfil' => $perfil,
            'oferta' => $oferta,
            'brecha' => $brecha,
            'informe_texto' => $informe,
            'match_score' => $matchScore,
            'creditos_restantes' => $this->credits->balance($userId, AtsModule::HEART),
            'primer_informe_gratis' => $primerInformeGratis,
            'operacion' => $operationId,
            'idempotent_replay' => false,
            // The catalogue travels with the report: the panel paints the
            // document types and the five templates BEFORE the person
            // presses generate, and it can never offer one the API would
            // reject.
            'tipos' => AtsCatalog::tipos(),
            'plantillas' => AtsCatalog::plantillas(),
        ];
    }

    /**
     * The operation id of a match request.
     *
     * The heart is part of the hash because credit_transactions.operation_id
     * is UNIQUE GLOBALLY: the same client key on two hearts must never share
     * one ledger row.
     */
    public static function operationId(string $clientKey): string
    {
        return 'atscv_' . substr(hash('sha256', AtsModule::HEART . '|' . $clientKey), 0, 40);
    }

    /**
     * A random client key (v4), used when the front sends none.
     */
    public static function randomKey(): string
    {
        $data = random_bytes(16);
        $data[6] = chr((ord($data[6]) & 0x0f) | 0x40);
        $data[8] = chr((ord($data[8]) & 0x3f) | 0x80);

        return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($data), 4));
    }

    /**
     * One brain call through the platform's rotator.
     *
     * The brain is NEVER called directly: BrainAdapterFactory resolves the
     * configured rotator (failover over the provider manager).
     */
    private function ask(string $operationId, string $system, string $user): string
    {
        $response = $this->brain->assist([
            'query' => $user,
            'context' => [],
            'history' => [],
            'operation_id' => $operationId,
            'system' => $system,
            'user' => $user,
        ]);

        return (string) ($response['answer'] ?? '');
    }

    /**
     * Decode one answer, or fail the request (nothing charged).
     *
     * @return array<string, mixed>
     */
    private function decode(string $answer, string $what): array
    {
        $decoded = AtsJson::salvage($answer);

        if ($decoded === null || $decoded === []) {
            throw new BrainException(
                'The brain returned an unusable answer for the ' . $what . ' step.'
            );
        }

        return $decoded;
    }

    /**
     * The response of a stored report.
     *
     * @param array<string, mixed> $analysis
     * @return array<string, mixed>
     */
    private function response(string $userId, array $analysis, bool $replay): array
    {
        $brecha = is_array($analysis['brecha']) ? $analysis['brecha'] : [];

        return [
            'perfil' => is_array($analysis['perfil']) ? $analysis['perfil'] : [],
            'oferta' => is_array($analysis['oferta']) ? $analysis['oferta'] : [],
            'brecha' => $brecha,
            'informe_texto' => (string) ($analysis['informe_texto'] ?? ''),
            'match_score' => (int) ($analysis['match_score'] ?? 0),
            'creditos_restantes' => $this->credits->balance($userId, AtsModule::HEART),
            'primer_informe_gratis' => (bool) ($analysis['primer_informe_gratis'] ?? false),
            'operacion' => (string) ($analysis['operation_id'] ?? ''),
            'idempotent_replay' => $replay,
            'tipos' => AtsCatalog::tipos(),
            'plantillas' => AtsCatalog::plantillas(),
        ];
    }

    /**
     * Show the CV, the offer and the report in "Mis archivos" — and give the
     * webchat its context.
     *
     * The CV and the report go through the platform's EXISTING ingestion
     * development (KnowledgeBase::ingestText) instead of being stored as
     * inert text: they are serialized into the data model — knowledge_sources
     * row + embedded knowledge_chunks, heart-scoped, chat_enabled = 1 — which
     * is exactly what the retrieval query requires for a chunk to reach the
     * model as context. Without that step the webchat cannot answer "why
     * didn't I pass?" with THIS analysis.
     *
     * The offer stays a listed artefact (chat_enabled = 0, no embedding): the
     * report already quotes its requirements verbatim, so the chat has them
     * without paying a second embedding for the raw posting.
     *
     * Best effort, like the listing: the report is already paid for and
     * stored, an indexing problem must not undo it. A provider failure is
     * deferred for retry by indexChunks, not lost.
     */
    private function registerArtefacts(
        string $userId,
        string $operationId,
        string $cvTexto,
        string $ofertaTexto,
        string $informe
    ): void {
        $knowledge = [
            ['cv', 'CV subido', $cvTexto],
            ['informe', 'Informe de brecha ATS', $informe],
        ];

        foreach ($knowledge as [$suffix, $title, $text]) {
            try {
                $this->knowledgeBase->ingestText(
                    $title,
                    $text,
                    'user',
                    $userId,
                    AtsRepository::artefactId($operationId, $suffix),
                    null,
                    null,
                    AtsModule::HEART
                );
            } catch (Throwable $e) {
                AppLog::warning('atscv', 'failed to index analysis artefact', [
                    'operation_id' => $operationId,
                    'artefact' => $suffix,
                    'error' => $e->getMessage(),
                ]);
            }
        }

        try {
            $this->knowledgeBase->registrarArtefacto(
                'Oferta laboral analizada',
                $ofertaTexto,
                'user',
                $userId,
                AtsRepository::artefactId($operationId, 'oferta'),
                null,
                AtsModule::HEART
            );
        } catch (Throwable $e) {
            AppLog::warning('atscv', 'failed to register inbox artefact', [
                'operation_id' => $operationId,
                'artefact' => 'oferta',
                'error' => $e->getMessage(),
            ]);
        }
    }

    /**
     * A readable report built from the gap data, used when the model did not
     * write the markdown itself. The person always gets something to read.
     *
     * @param array<string, mixed> $brecha
     */
    private static function composeInforme(array $brecha): string
    {
        $score = (int) ($brecha['match_score'] ?? 0);
        $lines = ['## Match ' . $score . '%'];

        $faltantes = $brecha['keywords_faltantes'] ?? [];
        if (is_array($faltantes) && $faltantes !== []) {
            $lines[] = '### Te faltan';
            $lines[] = '- ' . implode("\n- ", array_map([AtsJson::class, 'text'], $faltantes));
        }

        $presentes = $brecha['keywords_presentes'] ?? [];
        if (is_array($presentes) && $presentes !== []) {
            $lines[] = '### Ya tienes';
            $lines[] = '- ' . implode("\n- ", array_map([AtsJson::class, 'text'], $presentes));
        }

        $cambios = $brecha['que_cambiar_para_pasar'] ?? [];
        if (is_array($cambios) && $cambios !== []) {
            $lines[] = '### Qué puedes cambiar';
            $lines[] = '- ' . implode("\n- ", array_map([AtsJson::class, 'text'], $cambios));
        }

        return implode("\n\n", $lines);
    }
}
