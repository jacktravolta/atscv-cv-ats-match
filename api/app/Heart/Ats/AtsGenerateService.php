<?php
declare(strict_types=1);

namespace App\Heart\Ats;

use App\Chat\BrainAdapter;
use App\Chat\BrainAdapterFactory;
use App\Chat\BrainException;
use App\Core\AppLog;
use App\Credits\CreditService;
use App\Credits\TariffService;
use App\Pdf\DocumentExporter;
use App\Rag\KnowledgeBase;
use App\Storage\LocalStorage;
use App\Storage\StorageInterface;
use Throwable;

/**
 * The adapted CV + cover letter (stage 2, the paid stage).
 *
 * ORDER OF OPERATIONS: brain first, then charge. A brain failure costs the
 * person nothing, and the charge is idempotent by operation id, so a double
 * click never pays twice.
 *
 * THE FILES: the platform has NO ATS template (app/Documents/TemplateRenderer
 * is legal-specific dead code), so the HTML is built here, single column, no
 * tables and no images — the shape an ATS parser understands. The DOCX writer
 * of the platform is text-only (it strips the tags), which is a known
 * limitation: the DOCX keeps the content and loses the styling.
 */
final class AtsGenerateService
{
    /** The templates the front may ask for. */
    /**
     * The templates the generation accepts.
     *
     * The catalogue the panel renders is AtsCatalog::plantillas(); this
     * constant stays for the callers that only need the list of ids.
     */
    public const TEMPLATES = ['harvard', 'simple', 'habilidades', 'ejecutivo', 'compacto'];

    private AtsRepository $repository;
    private BrainAdapter $brain;
    private TariffService $tariffs;
    private CreditService $credits;
    private StorageInterface $storage;
    private KnowledgeBase $knowledgeBase;

    public function __construct(
        ?AtsRepository $repository = null,
        ?BrainAdapter $brain = null,
        ?TariffService $tariffs = null,
        ?CreditService $credits = null,
        ?StorageInterface $storage = null,
        ?KnowledgeBase $knowledgeBase = null
    ) {
        $this->repository = $repository ?? new AtsRepository();
        $this->brain = $brain ?? BrainAdapterFactory::create();
        $this->tariffs = $tariffs ?? new TariffService();
        $this->credits = $credits ?? new CreditService();
        $this->storage = $storage ?? new LocalStorage();
        $this->knowledgeBase = $knowledgeBase ?? new KnowledgeBase();
    }

    /**
     * Produce (or replay) the adapted CV and the cover letter.
     *
     * @param array<string, mixed> $perfil
     * @param array<string, mixed> $oferta
     * @param array<string, mixed> $brecha
     *
     * @return array<string, mixed> The response data.
     */
    public function run(
        string $userId,
        array $perfil,
        array $oferta,
        array $brecha,
        string $plantilla = 'harvard',
        ?string $clientKey = null,
        ?string $analysisOperationId = null,
        ?string $tipo = null
    ): array {
        // The REAL data comes from the stored analysis. The report the
        // person paid for lives in atscv_analyses (perfil, oferta, brecha as
        // JSON), so the document is built from THAT deserialized row and not
        // from whatever the browser sends back: the download always carries
        // the data the analysis was really made with.
        $stored = $this->storedAnalysis($userId, $analysisOperationId);

        if ($stored !== null) {
            $perfil = $stored['perfil'];
            $oferta = $stored['oferta'];
            $brecha = $stored['brecha'];
        }

        if ($perfil === [] || $oferta === [] || $brecha === []) {
            throw new \InvalidArgumentException(
                'Necesitamos el informe de brecha para generar el CV adaptado. Vuelve al paso anterior e inténtalo de nuevo.'
            );
        }

        $tipo = trim((string) $tipo);

        if ($tipo === '') {
            $tipo = AtsCatalog::tipoPorDefecto();
        }

        if (!AtsCatalog::esTipo($tipo)) {
            throw new \InvalidArgumentException(
                'El tipo de documento indicado no existe. Usa "brechas" o "potenciado".'
            );
        }

        $plantilla = trim($plantilla);

        if ($plantilla === '') {
            $plantilla = 'harvard';
        }

        if (!AtsCatalog::esPlantilla($plantilla)) {
            throw new \InvalidArgumentException(
                'La plantilla indicada no existe. Revisa las plantillas disponibles en el panel.'
            );
        }

        $clientKey = trim((string) $clientKey);
        if ($clientKey === '') {
            $clientKey = AtsMatchService::randomKey();
        }

        // The type is part of the money anchor: the two documents are two
        // different products, so buying both never swallows the second one
        // as a replay of the first.
        $operationId = self::operationId($clientKey . '|' . $tipo);

        // 1. Brain call 4.
        //
        // A retry does NOT skip the model here (unlike the gap report, whose
        // whole answer is stored). What the idempotency key guarantees is the
        // MONEY: the charge below is idempotent by operation id, so a double
        // click never costs the person twice. The file ids are derived from
        // the operation id, so the download URLs stay the same and the retry
        // simply refreshes the files.
        $raw = $this->ask(
            $operationId . '-adaptado',
            AtsPrompts::generaAdaptadoSystemPrompt($tipo),
            AtsPrompts::generaAdaptadoUserPrompt($perfil, $oferta, $brecha)
        );

        $decoded = AtsJson::salvage($raw);

        if ($decoded === null || $decoded === []) {
            throw new BrainException('The brain returned an unusable answer for the adapted CV.');
        }

        $adaptado = AtsJson::adaptado($decoded);

        // 2. Charge. Heart-scoped tariff, never the global fallback row.
        $tariffCredits = $this->tariffs->creditsFor(AtsModule::OPERATION_GENERATE, AtsModule::HEART);

        if ($tariffCredits === null || $tariffCredits <= 0) {
            throw new \RuntimeException(
                'The ' . AtsModule::OPERATION_GENERATE . ' tariff is not configured for the '
                . AtsModule::HEART . ' heart.'
            );
        }

        $this->credits->debit(
            $userId,
            $tariffCredits,
            $operationId,
            AtsModule::OPERATION_GENERATE,
            ['format' => AtsModule::OPERATION_GENERATE],
            AtsModule::HEART
        );

        // 3. Build the documents.
        $analysisId = $this->analysisId($userId, $analysisOperationId);

        $cvHtml = $this->cvHtml($perfil, $adaptado, $plantilla);
        $cvText = $this->cvText($perfil, $adaptado, $plantilla);
        $cartaHtml = $this->cartaHtml($perfil, $oferta, $adaptado);
        $cartaText = $this->cartaText($perfil, $oferta, $adaptado);

        $footer = DocumentExporter::footerText();

        $cvFiles = $this->renderFiles('cv', 'cv-adaptado-atscv-' . $tipo, $cvHtml, $cvText, $footer, $operationId, $userId, $analysisId);
        $cartaFiles = $this->renderFiles('carta', 'carta-presentacion-atscv-' . $tipo, $cartaHtml, $cartaText, $footer, $operationId, $userId, $analysisId);

        // 4. "Mis archivos": the adapted CV and the letter become visible.
        $this->registerArtefacts($userId, $operationId, $cvText, $cartaText);

        // The score never reaches 100: a perfect score reads as a generated
        // document, and the person who reads it deserves the truth.
        $nuevoMatch = (int) ($adaptado['nuevo_match_estimado'] ?? 0);
        $nuevoMatch = max(0, min(AtsCatalog::MAX_MATCH_SCORE, $nuevoMatch));

        return [
            'nuevo_match_score' => $nuevoMatch,
            'tipo' => $tipo,
            'plantilla' => $plantilla,
            'cv' => [
                'texto' => $cvText,
                'docx_url' => self::downloadUrl($cvFiles['docx']['id']),
                'pdf_url' => self::downloadUrl($cvFiles['pdf']['id']),
            ],
            'carta' => [
                'texto' => $cartaText,
                'docx_url' => self::downloadUrl($cartaFiles['docx']['id']),
                'pdf_url' => self::downloadUrl($cartaFiles['pdf']['id']),
            ],
            'creditos_restantes' => $this->credits->balance($userId, AtsModule::HEART),
            'operacion' => $operationId,
        ];
    }

    /**
     * The operation id of a generation request.
     *
     * A DIFFERENT namespace than the match ('gen' inside the hash and a
     * different prefix): the two stages share the globally unique
     * credit_transactions.operation_id, so they must never collide.
     */
    public static function operationId(string $clientKey): string
    {
        return 'atscv_gen_' . substr(hash('sha256', AtsModule::HEART . '|gen|' . $clientKey), 0, 40);
    }

    /**
     * The download path of one generated file.
     */
    public static function downloadUrl(string $documentId): string
    {
        return '/v1/cv-ats/documentos/' . $documentId;
    }

    /**
     * One brain call through the platform's rotator.
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
     * The analysis this generation belongs to (optional link).
     */
    private function analysisId(string $userId, ?string $analysisOperationId): ?string
    {
        $operationId = trim((string) $analysisOperationId);

        if ($operationId === '') {
            return null;
        }

        $analysis = $this->repository->findAnalysis($operationId);

        if ($analysis === null || $analysis['user_id'] !== $userId) {
            return null;
        }

        return (string) $analysis['id'];
    }

    /**
     * The stored analysis of this person, when there is one.
     *
     * This is where the REAL data comes from: the report the person paid for
     * is kept in atscv_analyses with its perfil, oferta and brecha as JSON.
     * Reading it back and deserializing it is what makes the downloadable
     * document carry the data the analysis was really made with, instead of
     * whatever the browser happened to send back.
     *
     * A foreign or unknown operation id returns null: the caller then falls
     * back to the payload it received, and the owner rule of analysisId()
     * still protects the stored row.
     *
     * @return array{perfil: array<string, mixed>, oferta: array<string, mixed>, brecha: array<string, mixed>}|null
     */
    private function storedAnalysis(string $userId, ?string $analysisOperationId): ?array
    {
        $operationId = trim((string) $analysisOperationId);

        if ($operationId === '') {
            return null;
        }

        $analysis = $this->repository->findAnalysis($operationId);

        if ($analysis === null || (string) $analysis['user_id'] !== $userId) {
            return null;
        }

        $perfil = is_array($analysis['perfil'] ?? null) ? $analysis['perfil'] : [];
        $oferta = is_array($analysis['oferta'] ?? null) ? $analysis['oferta'] : [];
        $brecha = is_array($analysis['brecha'] ?? null) ? $analysis['brecha'] : [];

        if ($perfil === [] || $oferta === [] || $brecha === []) {
            return null;
        }

        return ['perfil' => $perfil, 'oferta' => $oferta, 'brecha' => $brecha];
    }

    /**
     * Render the DOCX and the PDF of one document and store both.
     *
     * @return array{docx: array<string, mixed>, pdf: array<string, mixed>}
     */
    private function renderFiles(
        string $kind,
        string $baseName,
        string $html,
        string $plainText,
        string $footer,
        string $operationId,
        string $userId,
        ?string $analysisId
    ): array {
        $files = [];

        $docxBytes = DocumentExporter::docx($html, $footer);

        $files['docx'] = $this->storeFile(
            $kind,
            'docx',
            $baseName . '.docx',
            $docxBytes,
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            $operationId,
            $userId,
            $analysisId
        );

        // The Chrome printer is not available on every host (and can fail):
        // the pure-PHP text PDF is the honest fallback (same footer, same
        // content). A printer failure must never cost the person their files.
        $pdfBytes = null;

        try {
            $pdfBytes = DocumentExporter::htmlPdf($html, $footer);
        } catch (\Throwable $e) {
            AppLog::warning('atscv', 'html pdf printer failed, using the text fallback', [
                'operation_id' => $operationId,
                'error' => $e->getMessage(),
            ]);
        }

        if ($pdfBytes === null || $pdfBytes === '') {
            $pdfBytes = DocumentExporter::textPdf($plainText, $footer);
        }

        $files['pdf'] = $this->storeFile(
            $kind,
            'pdf',
            $baseName . '.pdf',
            $pdfBytes,
            'application/pdf',
            $operationId,
            $userId,
            $analysisId
        );

        return $files;
    }

    /**
     * Encrypt the bytes at rest, record the metadata and return the row.
     *
     * @return array<string, mixed>
     */
    private function storeFile(
        string $kind,
        string $format,
        string $filename,
        string $bytes,
        string $mime,
        string $operationId,
        string $userId,
        ?string $analysisId
    ): array {
        $id = AtsRepository::documentId($operationId, $kind, $format);
        $extension = $format === 'pdf' ? 'pdf' : 'docx';
        $storageKey = $operationId . '_' . $kind . '_' . $format . '.' . $extension;

        $this->storage->put($bytes, $storageKey);

        $this->repository->saveDocument([
            'id' => $id,
            'user_id' => $userId,
            'analysis_id' => $analysisId,
            'kind' => $kind,
            'format' => $format,
            'filename' => $filename,
            'storage_key' => $storageKey,
            'mime' => $mime,
            'bytes_len' => strlen($bytes),
        ]);

        return [
            'id' => $id,
            'filename' => $filename,
            'mime' => $mime,
            'bytes_len' => strlen($bytes),
            'storage_key' => $storageKey,
        ];
    }

    /**
     * Show the adapted CV and the letter in "Mis archivos" (best effort).
     */
    private function registerArtefacts(string $userId, string $operationId, string $cvText, string $cartaText): void
    {
        $artefacts = [
            ['cv-adaptado', 'CV adaptado a la oferta', $cvText],
            ['carta', 'Carta de presentación', $cartaText],
        ];

        foreach ($artefacts as [$suffix, $title, $text]) {
            try {
                $this->knowledgeBase->registrarArtefacto(
                    $title,
                    $text,
                    'user',
                    $userId,
                    AtsRepository::artefactId($operationId, $suffix),
                    null,
                    AtsModule::HEART
                );
            } catch (Throwable $e) {
                AppLog::warning('atscv', 'failed to register inbox artefact', [
                    'operation_id' => $operationId,
                    'artefact' => $suffix,
                    'error' => $e->getMessage(),
                ]);
            }
        }
    }

    /**
     * The blocks of the adapted CV: [heading, lines] pairs.
     *
     * @param array<string, mixed> $perfil
     * @param array<string, mixed> $adaptado
     * @return list<array{heading: string, lines: list<string>}>
     */
    private function cvBlocks(array $perfil, array $adaptado, string $plantilla): array
    {
        $secciones = is_array($adaptado['cv_secciones'] ?? null) ? $adaptado['cv_secciones'] : [];

        $header = [];

        $nombre = AtsJson::text($perfil['nombre'] ?? '');
        if ($nombre !== '') {
            $header[] = $nombre;
        }

        $cargo = AtsJson::text($perfil['cargo_actual'] ?? '');
        if ($cargo !== '') {
            $header[] = $cargo;
        }

        $resumen = AtsJson::text($secciones['resumen_profesional'] ?? '');
        $habilidades = AtsJson::textList($secciones['habilidades_tecnicas'] ?? []);
        $educacion = AtsJson::textList($secciones['educacion'] ?? []);

        $experiencia = [];

        foreach ((is_array($secciones['experiencia'] ?? null) ? $secciones['experiencia'] : []) as $item) {
            if (!is_array($item)) {
                continue;
            }

            $linea = trim(AtsJson::text($item['cargo'] ?? ''));

            $empresa = trim(AtsJson::text($item['empresa'] ?? ''));
            if ($empresa !== '') {
                $linea = $linea === '' ? $empresa : $linea . ' | ' . $empresa;
            }

            $fechas = trim(AtsJson::text($item['fechas'] ?? ''));
            if ($fechas !== '') {
                $linea = $linea === '' ? $fechas : $linea . ' | ' . $fechas;
            }

            if ($linea !== '') {
                $experiencia[] = $linea;
            }

            foreach (AtsJson::textList($item['bullets'] ?? []) as $bullet) {
                $experiencia[] = '- ' . $bullet;
            }
        }

        $blocks = [];

        if ($header !== []) {
            $blocks[] = ['heading' => '', 'lines' => $header];
        }

        // The template decides the order and the headings: five ATS-safe
        // layouts, one catalogue (AtsCatalog) shared with the panel.
        $layout = AtsCatalog::layout($plantilla);

        $contenido = [
            'resumen' => $resumen === '' ? [] : [$resumen],
            'habilidades' => $habilidades,
            'experiencia' => $experiencia,
            'educacion' => $educacion,
        ];

        foreach ($layout['orden'] as $seccion) {
            $lineas = $contenido[$seccion] ?? [];

            if ($lineas === []) {
                continue;
            }

            $blocks[] = [
                'heading' => $layout['titulos'][$seccion] ?? $seccion,
                'lines' => $lineas,
            ];
        }

        return $blocks;
    }

    /**
     * The HTML of the adapted CV.
     *
     * Every line ends with <br>: the platform's DOCX writer strips the tags
     * and only <br> becomes a line break there, so the Word file keeps one
     * paragraph per line.
     *
     * @param array<string, mixed> $perfil
     * @param array<string, mixed> $adaptado
     */
    private function cvHtml(array $perfil, array $adaptado, string $plantilla): string
    {
        $blocks = $this->cvBlocks($perfil, $adaptado, $plantilla);
        $html = '';
        $first = true;

        foreach ($blocks as $block) {
            if ($block['heading'] !== '') {
                $html .= '<h2>' . self::escape($block['heading']) . '</h2>';
            }

            foreach ($block['lines'] as $line) {
                $html .= $first
                    ? '<h1>' . self::escape($line) . '</h1>'
                    : self::escape($line) . '<br>';

                $first = false;
            }
        }

        return $html;
    }

    /**
     * The plain text of the adapted CV (the response text and the PDF
     * fallback).
     *
     * @param array<string, mixed> $perfil
     * @param array<string, mixed> $adaptado
     */
    private function cvText(array $perfil, array $adaptado, string $plantilla): string
    {
        $lines = [];

        foreach ($this->cvBlocks($perfil, $adaptado, $plantilla) as $block) {
            if ($block['heading'] !== '') {
                $lines[] = mb_strtoupper($block['heading'], 'UTF-8');
            }

            foreach ($block['lines'] as $line) {
                $lines[] = $line;
            }
        }

        return implode("\n", $lines);
    }

    /**
     * The blocks of the cover letter.
     *
     * @param array<string, mixed> $perfil
     * @param array<string, mixed> $oferta
     * @param array<string, mixed> $adaptado
     * @return list<array{heading: string, lines: list<string>}>
     */
    private function cartaBlocks(array $perfil, array $oferta, array $adaptado): array
    {
        $blocks = [];
        $header = [];

        $nombre = AtsJson::text($perfil['nombre'] ?? '');
        if ($nombre !== '') {
            $header[] = $nombre;
        }

        $destino = trim(AtsJson::text($oferta['cargo_oferta'] ?? ''));

        $empresa = AtsJson::text($oferta['empresa'] ?? '');
        if ($empresa !== '') {
            $destino = $destino === '' ? $empresa : $destino . ' | ' . $empresa;
        }

        if ($destino !== '') {
            $header[] = $destino;
        }

        if ($header !== []) {
            $blocks[] = ['heading' => '', 'lines' => $header];
        }

        $letter = AtsJson::text($adaptado['carta_presentacion'] ?? '');
        $paragraphs = [];

        foreach (preg_split('/\r\n|\r|\n/', $letter) ?: [] as $paragraph) {
            $paragraph = trim($paragraph);

            if ($paragraph !== '') {
                $paragraphs[] = $paragraph;
            }
        }

        if ($paragraphs !== []) {
            $blocks[] = ['heading' => 'Carta de presentación', 'lines' => $paragraphs];
        }

        return $blocks;
    }

    /**
     * The HTML of the cover letter.
     *
     * @param array<string, mixed> $perfil
     * @param array<string, mixed> $oferta
     * @param array<string, mixed> $adaptado
     */
    private function cartaHtml(array $perfil, array $oferta, array $adaptado): string
    {
        $html = '';
        $first = true;

        foreach ($this->cartaBlocks($perfil, $oferta, $adaptado) as $block) {
            if ($block['heading'] !== '') {
                $html .= '<h2>' . self::escape($block['heading']) . '</h2>';
            }

            foreach ($block['lines'] as $line) {
                $html .= $first
                    ? '<h1>' . self::escape($line) . '</h1>'
                    : self::escape($line) . '<br>';

                $first = false;
            }
        }

        return $html;
    }

    /**
     * The plain text of the cover letter.
     *
     * @param array<string, mixed> $perfil
     * @param array<string, mixed> $oferta
     * @param array<string, mixed> $adaptado
     */
    private function cartaText(array $perfil, array $oferta, array $adaptado): string
    {
        $lines = [];

        foreach ($this->cartaBlocks($perfil, $oferta, $adaptado) as $block) {
            if ($block['heading'] !== '') {
                $lines[] = mb_strtoupper($block['heading'], 'UTF-8');
            }

            foreach ($block['lines'] as $line) {
                $lines[] = $line;
            }
        }

        return implode("\n", $lines);
    }

    private static function escape(string $value): string
    {
        return htmlspecialchars($value, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
    }
}
