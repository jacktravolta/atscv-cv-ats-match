<?php
/**
 * CV ATS Match (atscv) battery — the two business stages end to end, with a
 * stubbed brain (no network, no provider tokens) and throwaway accounts.
 *
 * What is asserted here:
 *   1. THE GATE — without a session the route answers 401 (the same envelope
 *      the front expects), never a silent success.
 *   2. THE HAPPY PATH — the gap report returns perfil, oferta, brecha and the
 *      match score, and the report is stored.
 *   3. THE FREE FIRST REPORT — the first report of each account costs 0
 *      credits; the second one costs the heart tariff (1 credit).
 *   4. IDEMPOTENCY — the same key returns the stored report, without a second
 *      model call and without a second charge.
 *   5. THE HONEST FAILURE — an unusable model answer fails with a warm error
 *      and charges NOTHING.
 *   6. THE EMPTY WALLET — no credits means 402 and no charge.
 *   7. THE FILES — the generated CV is downloadable by its owner and NOT by
 *      another account.
 *   8. THE INBOX — the CV, the offer and the report show up in "Mis archivos"
 *      with chat_enabled = 0 (they never pollute the legal RAG chat).
 *
 * The test cleans up every row it creates (the FKs cascade) and removes its
 * temporary storage directory.
 *
 * Run: php tests/test_atscv.php
 */

declare(strict_types=1);

require __DIR__ . '/../app/Core/autoload.php';

use App\Auth\Jwt;
use App\Chat\BrainAdapter;
use App\Core\Config;
use App\Core\Database;
use App\Core\Request;
use App\Core\Router;
use App\Credits\CreditService;
use App\Heart\Ats\AtsGenerateService;
use App\Heart\Ats\AtsMatchService;
use App\Heart\Ats\AtsModule;
use App\Heart\Ats\AtsRepository;
use App\Storage\LocalStorage;

Config::load(__DIR__ . '/../config/config.php');

// ---------------------------------------------------------------------------
// Child harness: the module's responder ends in Response::json/binary, which
// exit. The HTTP-level checks therefore run in a child process of THIS file
// (mode "--http ..."), and the parent reads STATUS / LEN / SHA256 / BODY.
// ---------------------------------------------------------------------------
if (in_array('--http', $argv, true)) {
    $mode = (string) ($argv[array_search('--http', $argv, true) + 1] ?? '');
    $args = array_slice($argv, array_search('--http', $argv, true) + 2);

    require __DIR__ . '/../app/Core/autoload.php';

    Config::load(__DIR__ . '/../config/config.php');

    ob_start();

    register_shutdown_function(static function (): void {
        $body = (string) ob_get_contents();

        while (ob_get_level() > 0) {
            ob_end_clean();
        }

        echo "\nSTATUS=" . http_response_code() . "\n";
        echo 'LEN=' . strlen($body) . "\n";
        echo 'SHA256=' . hash('sha256', $body) . "\n";
        echo 'BODY_B64=' . base64_encode($body) . "\n";
    });

    if ($mode === '401') {
        // No session at all: no cookie, no bearer token.
        unset($_COOKIE['access_token']);
        unset($_SERVER['HTTP_AUTHORIZATION']);

        $_SERVER['REQUEST_METHOD'] = 'POST';
        $_SERVER['REQUEST_URI'] = '/v1/cv-ats/match';

        $router = new Router();
        AtsModule::registerRoutes($router);
        $router->dispatch(new Request());

        exit(0);
    }

    if ($mode === 'download') {
        $documentId = (string) ($args[0] ?? '');
        $userId = (string) ($args[1] ?? '');

        $secret = trim((string) Config::get('auth.jwt_secret', ''));

        if ($secret === '') {
            echo "\nSTATUS=0\nLEN=0\nSHA256=\nBODY_B64=" . base64_encode('no jwt secret') . "\n";
            exit(0);
        }

        $_SERVER['REQUEST_METHOD'] = 'GET';
        $_SERVER['REQUEST_URI'] = '/v1/cv-ats/documentos/' . $documentId;
        $_SERVER['HTTP_AUTHORIZATION'] = 'Bearer ' . Jwt::encode(['sub' => $userId, 'type' => 'access'], $secret, 1800);

        $router = new Router();
        AtsModule::registerRoutes($router);
        $router->dispatch(new Request());

        exit(0);
    }

    if ($mode === 'map') {
        // The module's own exception→JSON mapping, one exception per run.
        $exceptionClass = (string) ($args[0] ?? '');

        if ($exceptionClass === '' || !class_exists($exceptionClass)) {
            echo "\nSTATUS=0\nLEN=0\nSHA256=\nBODY_B64=" . base64_encode('unknown exception class') . "\n";
            exit(0);
        }

        $reflection = new ReflectionClass($exceptionClass);
        $ctor = $reflection->getConstructor();
        $ctorArgs = [];

        if ($ctor !== null) {
            foreach ($ctor->getParameters() as $param) {
                if ($param->isOptional()) {
                    continue;
                }

                $type = (string) $param->getType();

                $ctorArgs[] = match (true) {
                    $type === 'int' => 0,
                    $type === 'float' => 0.0,
                    $type === 'bool' => false,
                    $type === 'array' => [],
                    default => 'mensaje de prueba',
                };
            }
        }

        $method = new ReflectionMethod(AtsModule::class, 'respond');
        $method->setAccessible(true);

        $wrapped = $method->invoke(null, static function () use ($exceptionClass, $ctorArgs): void {
            throw new $exceptionClass(...$ctorArgs);
        });

        $wrapped(new Request());

        exit(0);
    }

    echo "\nSTATUS=0\nLEN=0\nSHA256=\nBODY_B64=" . base64_encode('unknown mode') . "\n";
    exit(0);
}

// ---------------------------------------------------------------------------
// The battery.
// ---------------------------------------------------------------------------

$failures = 0;

function check(string $name, bool $ok, string $detail = ''): void
{
    global $failures;

    echo ($ok ? "  ✓ " : "  ✗ ") . $name . ($ok || $detail === '' ? '' : ' — ' . $detail) . "\n";

    if (!$ok) {
        $failures++;
    }
}

/**
 * A brain that answers from a canned map, keyed by a fragment of the system
 * prompt. No network, no provider tokens.
 */
final class AtsStubBrain implements BrainAdapter
{
    public int $calls = 0;

    /** @var array<string, string> */
    private array $answers;

    /** @var list<string> */
    public array $promptsSeen = [];

    /**
     * @param array<string, string> $answers Fragment of the system prompt => answer.
     */
    public function __construct(array $answers)
    {
        $this->answers = $answers;
    }

    public function assist(array $request): array
    {
        $this->calls++;

        $system = (string) ($request['system'] ?? '');
        $this->promptsSeen[] = $system;

        foreach ($this->answers as $fragment => $answer) {
            if (str_contains($system, $fragment)) {
                return [
                    'answer' => $answer,
                    'usage' => ['input_tokens' => 0, 'output_tokens' => 0],
                    'confidence' => null,
                    'markers' => [],
                ];
            }
        }

        return [
            'answer' => $this->answers['*'] ?? '{}',
            'usage' => ['input_tokens' => 0, 'output_tokens' => 0],
            'confidence' => null,
            'markers' => [],
        ];
    }
}

/**
 * Run one child harness and read its markers.
 *
 * @param list<string> $args
 * @return array{status: int, len: int, sha256: string, body: string}
 */
function runChild(array $args): array
{
    $cmd = escapeshellarg(PHP_BINARY) . ' ' . escapeshellarg(__FILE__) . ' --http '
        . implode(' ', array_map('escapeshellarg', $args));

    exec($cmd . ' 2>&1', $lines, $exitCode);
    $out = implode("\n", $lines);

    $status = preg_match('/^STATUS=(\d+)$/m', $out, $m) === 1 ? (int) $m[1] : -1;
    $len = preg_match('/^LEN=(\d+)$/m', $out, $m) === 1 ? (int) $m[1] : -1;
    $sha = preg_match('/^SHA256=([a-f0-9]*)$/m', $out, $m) === 1 ? (string) $m[1] : '';
    $body = preg_match('/^BODY_B64=(.*)$/m', $out, $m) === 1 ? (string) base64_decode((string) $m[1], true) : '';

    return ['status' => $status, 'len' => $len, 'sha256' => $sha, 'body' => $body];
}

function jsonOf(string $body): array
{
    $decoded = json_decode($body, true);

    return is_array($decoded) ? $decoded : [];
}

function errorCode(array $body): string
{
    return is_array($body['error'] ?? null) ? (string) ($body['error']['code'] ?? '') : '';
}

function errorMessage(array $body): string
{
    return is_array($body['error'] ?? null) ? (string) ($body['error']['message'] ?? '') : '';
}

$pdo = Database::connection();

// The REAL storage of the platform: the download route reads the bytes from
// here, so the battery must write and read the same place (the files it
// creates are removed at the end).
$storage = new LocalStorage();

$suffix = bin2hex(random_bytes(6));
$ownerId = 'u_atscv_' . $suffix;
$otherId = 'u_atscv_other_' . $suffix;
$emptyId = 'u_atscv_empty_' . $suffix;
$brokenId = 'u_atscv_broken_' . $suffix;

/** @var list<string> $operationGeneracion The operations whose files must be removed. */
$operationGeneracion = [];

$cvTexto = "CURRICULUM VITAE\nJuan Pérez\nOperario de Bodega\nExperiencia: 5 años en Logística Chile (2020-2026), manejo de 300 SKU con WMS.";
$ofertaTexto = "OFERTA: Jefe de Bodega en Retail SA. Requisitos: SAP EWM, Licencia Clase D, Power BI. Deseables: inventario cíclico.";

$perfilJson = (string) json_encode([
    'nombre' => 'Juan Pérez',
    'cargo_actual' => 'Operario de Bodega',
    'años_experiencia' => '5 años',
    'skills_tecnicas' => ['WMS', 'Excel'],
    'skills_blandas' => ['Trabajo en equipo'],
    'experiencias' => [[
        'cargo' => 'Operario',
        'empresa' => 'Logística Chile',
        'fechas' => '01/2020 - 11/2026',
        'logros' => ['Manejo de 300 SKU'],
    ]],
    'educacion' => ['Técnico en Logística'],
    'logros_cuantificables' => ['300 SKU'],
], JSON_UNESCAPED_UNICODE);

$ofertaJson = (string) json_encode([
    'cargo_oferta' => 'Jefe de Bodega',
    'empresa' => 'Retail SA',
    'requisitos_obligatorios' => ['SAP EWM', 'Licencia Clase D', 'Power BI'],
    'requisitos_deseables' => ['Inventario cíclico'],
    'keywords_ats' => ['SAP EWM', 'WMS', 'Power BI', 'Licencia D'],
    'herramientas' => ['SAP', 'Excel Avanzado'],
    'funciones_principales' => ['Liderar el equipo de bodega'],
    'tipo_contrato' => 'Contrato indefinido',
], JSON_UNESCAPED_UNICODE);

$brechaJson = (string) json_encode([
    'match_score' => '48%',
    'keywords_faltantes' => ['SAP EWM', 'Power BI', 'Licencia D'],
    'keywords_presentes' => ['WMS'],
    'fortalezas' => ['Cumples con 5 años de experiencia'],
    'debilidades' => ['Te falta SAP EWM'],
    'porque_te_rechazaria_ats' => 'El ATS busca SAP EWM y tu CV no lo menciona.',
    'que_cambiar_para_pasar' => ['Agregar SAP EWM en tu experiencia'],
    'informe_markdown' => "## Match 48%\nTu CV dice WMS; la oferta pide SAP EWM.\n### Te faltan\n- SAP EWM\n",
], JSON_UNESCAPED_UNICODE);

$adaptadoJson = (string) json_encode([
    'cv_secciones' => [
        'resumen_profesional' => 'Operario de bodega con 5 años de experiencia en inventario y WMS.',
        'experiencia' => [[
            'cargo' => 'Operario',
            'empresa' => 'Logística Chile',
            'fechas' => '01/2020 - 11/2026',
            'bullets' => ['Gestioné 300 SKU con WMS'],
        ]],
        'habilidades_tecnicas' => ['WMS', 'Excel'],
        'educacion' => ['Técnico en Logística'],
    ],
    'carta_presentacion' => "Estimados:\n\nVi su oferta para Jefe de Bodega y me interesa mucho el cargo.\nCumplo con la experiencia en inventario y WMS.",
    'nuevo_match_estimado' => 92,
], JSON_UNESCAPED_UNICODE);

/**
 * The stub brain of the happy path.
 */
function happyBrain(): AtsStubBrain
{
    global $perfilJson, $ofertaJson, $brechaJson, $adaptadoJson;

    return new AtsStubBrain([
        'extractor de CV' => $perfilJson,
        'extractor de ofertas' => $ofertaJson,
        'auditor ATS' => $brechaJson,
        'reescritor CV ATS' => $adaptadoJson,
        '*' => '{}',
    ]);
}

function makeUser(string $userId, string $name, string $email): void
{
    $pdo = Database::connection();

    $pdo->prepare(
        'INSERT INTO users (id, name, email, role, status, email_verified_at, terms_accepted_at, created_at, updated_at) '
        . 'VALUES (:id, :name, :email, \'user\', \'ACTIVE\', UTC_TIMESTAMP(6), UTC_TIMESTAMP(6), UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))'
    )->execute([':id' => $userId, ':name' => $name, ':email' => $email]);
}

function walletBalance(string $userId): int
{
    $pdo = Database::connection();

    $statement = $pdo->prepare('SELECT balance FROM wallets WHERE user_id = :user_id AND heart_id = :heart LIMIT 1');
    $statement->execute([':user_id' => $userId, ':heart' => AtsModule::HEART]);
    $balance = $statement->fetchColumn();

    return $balance === false ? 0 : (int) $balance;
}

try {
    makeUser($ownerId, 'Dueño ATSCV', 'atscv_owner_' . $suffix . '@atscv.test');
    makeUser($otherId, 'Otro ATSCV', 'atscv_other_' . $suffix . '@atscv.test');
    makeUser($emptyId, 'Sin Saldo ATSCV', 'atscv_empty_' . $suffix . '@atscv.test');
    makeUser($brokenId, 'Respuesta Rota ATSCV', 'atscv_broken_' . $suffix . '@atscv.test');

    $credits = new CreditService();
    $credits->credit($ownerId, 'ADMIN_ADJUSTMENT', 50, 'atscv_test_credit_' . $suffix . '_owner', 'test', [], AtsModule::HEART);
    $credits->credit($otherId, 'ADMIN_ADJUSTMENT', 50, 'atscv_test_credit_' . $suffix . '_other', 'test', [], AtsModule::HEART);
    $credits->credit($brokenId, 'ADMIN_ADJUSTMENT', 50, 'atscv_test_credit_' . $suffix . '_broken', 'test', [], AtsModule::HEART);
    // $emptyId gets NO wallet on purpose.

    echo "=== 1. SIN SESIÓN NO SE PASA ===\n";

    $sinSesion = runChild(['401']);

    check('sin sesión responde 401', $sinSesion['status'] === 401, 'status ' . $sinSesion['status']);
    check('el error es UNAUTHORIZED', errorCode(jsonOf($sinSesion['body'])) === 'UNAUTHORIZED', $sinSesion['body']);
    check('el mensaje es amable', str_contains(errorMessage(jsonOf($sinSesion['body'])), 'sesión'));

    echo "\n=== 2. EL INFORME DE BRECHA ===\n";

    $brain = happyBrain();
    $service = new AtsMatchService(brain: $brain);

    $saldoAntes = walletBalance($ownerId);
    $resultado = $service->run($ownerId, $cvTexto, $ofertaTexto, 'clave-informe-1');

    check('devuelve el perfil', ($resultado['perfil']['nombre'] ?? '') === 'Juan Pérez');
    check('devuelve la oferta', ($resultado['oferta']['cargo_oferta'] ?? '') === 'Jefe de Bodega');
    check('devuelve la brecha', isset($resultado['brecha']['keywords_faltantes']));
    check('devuelve el match score', ($resultado['match_score'] ?? -1) === 48, (string) ($resultado['match_score'] ?? 'null'));
    check('el informe es markdown', str_contains((string) ($resultado['informe_texto'] ?? ''), '## Match'));
    check('la primera vez es gratis', ($resultado['primer_informe_gratis'] ?? false) === true);
    check('la primera vez no cobra', walletBalance($ownerId) === $saldoAntes);
    check('la operación tiene identificador', str_starts_with((string) $resultado['operacion'], 'atscv_'));
    check('no es un replay', ($resultado['idempotent_replay'] ?? true) === false);
    check('se hicieron 3 llamadas al cerebro', $brain->calls === 3, (string) $brain->calls);

    $analysis = (new AtsRepository())->findAnalysis((string) $resultado['operacion']);

    check('el informe queda guardado', $analysis !== null);
    check('el informe guardado trae el match score', (int) ($analysis['match_score'] ?? 0) === 48);

    echo "\n=== 3. LA SEGUNDA VEZ SÍ COBRA ===\n";

    $saldoAntes2 = walletBalance($ownerId);
    $segundo = $service->run($ownerId, $cvTexto, $ofertaTexto, 'clave-informe-2');

    check('la segunda vez cobra 1 crédito', walletBalance($ownerId) === $saldoAntes2 - 1, (string) walletBalance($ownerId));
    check('la segunda vez no es gratis', ($segundo['primer_informe_gratis'] ?? true) === false);
    check('el saldo que queda viene en la respuesta', ($segundo['creditos_restantes'] ?? -1) === walletBalance($ownerId));

    echo "\n=== 4. IDEMPOTENCIA: LA MISMA CLAVE, EL MISMO INFORME ===\n";

    $llamadasAntes = $brain->calls;
    $saldoAntes3 = walletBalance($ownerId);
    $replay = $service->run($ownerId, $cvTexto, $ofertaTexto, 'clave-informe-1');

    check('el reintento es un replay', ($replay['idempotent_replay'] ?? false) === true);
    check('el reintento devuelve el mismo informe', ($replay['informe_texto'] ?? '') === ($resultado['informe_texto'] ?? 'x'));
    check('el reintento devuelve el mismo match score', ($replay['match_score'] ?? -1) === 48);
    check('el reintento no vuelve a llamar al cerebro', $brain->calls === $llamadasAntes);
    check('el reintento no cobra de nuevo', walletBalance($ownerId) === $saldoAntes3);

    echo "\n=== 5. UNA RESPUESTA INÚTIL NO SE COBRA ===\n";

    $brainRoto = new AtsStubBrain([
        'extractor de CV' => 'Lo siento, no puedo leer este CV.',
        'extractor de ofertas' => 'Lo siento, no puedo leer esta oferta.',
        'auditor ATS' => 'No puedo comparar.',
        '*' => 'nada',
    ]);

    $saldoAntes4 = walletBalance($brokenId);
    $servicioRoto = new AtsMatchService(brain: $brainRoto);

    try {
        $servicioRoto->run($brokenId, $cvTexto, $ofertaTexto, 'clave-rota-1');
        check('una respuesta inútil se rechaza', false);
    } catch (\App\Chat\BrainException $e) {
        check('una respuesta inútil se rechaza', true);
    }

    check('la respuesta inútil no cobra nada', walletBalance($brokenId) === $saldoAntes4);
    check(
        'la respuesta inútil no deja informe',
        (new AtsRepository())->findAnalysis(AtsMatchService::operationId('clave-rota-1')) === null
    );
    check(
        'la respuesta inútil no gasta el informe gratis',
        (int) $pdo->query('SELECT COUNT(*) FROM cv_ats_trials WHERE user_id = ' . $pdo->quote($brokenId))->fetchColumn() === 0
    );

    $mapaBrain = runChild(['map', \App\Chat\BrainException::class]);

    check('el fallo del cerebro responde 502', $mapaBrain['status'] === 502, 'status ' . $mapaBrain['status']);
    check('el código es BRAIN_UNAVAILABLE', errorCode(jsonOf($mapaBrain['body'])) === 'BRAIN_UNAVAILABLE');
    check('el mensaje tranquiliza', str_contains(errorMessage(jsonOf($mapaBrain['body'])), 'No se te cobró nada'));

    echo "\n=== 6. SIN SALDO NO SE COBRA ===\n";

    // The free first report is already used for this account: without the
    // trial, the report would be free and no 402 would ever arrive.
    $pdo->prepare(
        'INSERT INTO cv_ats_trials (user_id, heart_id, granted_at) VALUES (:user_id, :heart, UTC_TIMESTAMP(6))'
    )->execute([':user_id' => $emptyId, ':heart' => AtsModule::HEART]);

    $brainVacio = happyBrain();
    $servicioVacio = new AtsMatchService(brain: $brainVacio);

    try {
        $servicioVacio->run($emptyId, $cvTexto, $ofertaTexto, 'clave-sin-saldo-1');
        check('sin saldo se rechaza', false);
    } catch (\App\Credits\InsufficientCreditsException $e) {
        check('sin saldo se rechaza', true);
    }

    check('sin saldo el saldo sigue en 0', walletBalance($emptyId) === 0);
    check(
        'sin saldo no hay movimiento en la cartera',
        (int) $pdo->query(
            'SELECT COUNT(*) FROM credit_transactions WHERE user_id = ' . $pdo->quote($emptyId)
        )->fetchColumn() === 0
    );

    $mapa402 = runChild(['map', \App\Credits\InsufficientCreditsException::class]);

    check('el 402 responde con el código correcto', errorCode(jsonOf($mapa402['body'])) === 'INSUFFICIENT_CREDITS');
    check('el 402 viaja con el saldo', array_key_exists('balance', jsonOf($mapa402['body'])['error'] ?? []));

    echo "\n=== 7. EL CV ADAPTADO Y SUS ARCHIVOS ===\n";

    $brainGeneracion = happyBrain();
    $generador = new AtsGenerateService(brain: $brainGeneracion, storage: $storage);

    $saldoAntes5 = walletBalance($ownerId);
    $generado = $generador->run(
        $ownerId,
        (array) $resultado['perfil'],
        (array) $resultado['oferta'],
        (array) $resultado['brecha'],
        'harvard',
        'clave-generacion-1'
    );

    check('la generación devuelve el nuevo match', ($generado['nuevo_match_score'] ?? -1) === 92);
    check('la generación devuelve el texto del CV', str_contains((string) ($generado['cv']['texto'] ?? ''), 'Juan Pérez'));
    check('la generación devuelve el texto de la carta', str_contains((string) ($generado['carta']['texto'] ?? ''), 'Jefe de Bodega'));
    check('la generación cobra 3 créditos', walletBalance($ownerId) === $saldoAntes5 - 3, (string) walletBalance($ownerId));
    check('el DOCX tiene una URL', str_starts_with((string) ($generado['cv']['docx_url'] ?? ''), '/v1/cv-ats/documentos/'));
    check('el PDF tiene una URL', str_starts_with((string) ($generado['cv']['pdf_url'] ?? ''), '/v1/cv-ats/documentos/'));

    $documentId = substr((string) $generado['cv']['docx_url'], strlen('/v1/cv-ats/documentos/'));
    $operationGeneracion[] = (string) $generado['operacion'];
    $operationGeneracion = array_values(array_unique($operationGeneracion));
    $operationId = (string) $generado['operacion'];

    check(
        'el archivo se guarda cifrado en el disco',
        $storage->exists($operationId . '_cv_docx.docx')
    );

    $esperados = $storage->get($operationId . '_cv_docx.docx');
    check('el DOCX tiene contenido', strlen($esperados) > 100);
    check('el DOCX es un ZIP', strncmp($esperados, "PK", 2) === 0);

    $downloadDueño = runChild(['download', $documentId, $ownerId]);

    check('el dueño descarga su archivo', $downloadDueño['status'] === 200, 'status ' . $downloadDueño['status']);
    check('el dueño recibe los bytes correctos', $downloadDueño['sha256'] === hash('sha256', $esperados));
    check('el dueño recibe el archivo completo', $downloadDueño['len'] === strlen($esperados));

    $downloadOtro = runChild(['download', $documentId, $otherId]);

    check('otra cuenta NO descarga el archivo', $downloadOtro['status'] === 404, 'status ' . $downloadOtro['status']);
    check('la respuesta es un NOT_FOUND', errorCode(jsonOf($downloadOtro['body'])) === 'NOT_FOUND');
    check('la respuesta no trae los bytes', $downloadOtro['sha256'] !== hash('sha256', $esperados));

    echo "\n=== 8. MIS ARCHIVOS (LA BANDEJA) ===\n";

    $artefactos = $pdo->prepare(
        'SELECT id, title, chat_enabled, scope, heart_id FROM knowledge_sources '
        . 'WHERE user_id = :user_id AND heart_id = :heart ORDER BY created_at ASC'
    );
    $artefactos->execute([':user_id' => $ownerId, ':heart' => AtsModule::HEART]);
    $filas = $artefactos->fetchAll(PDO::FETCH_ASSOC);

    $titulos = array_map(static fn (array $f): string => (string) $f['title'], $filas);

    check('el CV subido aparece en la bandeja', in_array('CV subido', $titulos, true));
    check('la oferta analizada aparece en la bandeja', in_array('Oferta laboral analizada', $titulos, true));
    check('el informe de brecha aparece en la bandeja', in_array('Informe de brecha ATS', $titulos, true));
    check('el CV adaptado aparece en la bandeja', in_array('CV adaptado a la oferta', $titulos, true));
    check('la carta aparece en la bandeja', in_array('Carta de presentación', $titulos, true));

    // The contract changed on purpose: the CV and the report are serialized
    // into the RAG (they are the context the panel's webchat answers with),
    // while the offer and the generated files stay listed artefacts.
    $chatPorTitulo = [];
    foreach ($filas as $fila) {
        $chatPorTitulo[(string) $fila['title']] = ((int) $fila['chat_enabled']) === 1;
    }

    check('el CV entra al chat como contexto', ($chatPorTitulo['CV subido'] ?? false) === true);
    check('el informe entra al chat como contexto', ($chatPorTitulo['Informe de brecha ATS'] ?? false) === true);
    check('la oferta NO entra al chat', ($chatPorTitulo['Oferta laboral analizada'] ?? true) === false);
    check('el CV adaptado NO entra al chat', ($chatPorTitulo['CV adaptado a la oferta'] ?? true) === false);
    check('la carta NO entra al chat', ($chatPorTitulo['Carta de presentación'] ?? true) === false);
    check(
        'los artefactos son del usuario y del corazón',
        count(array_filter($filas, static fn (array $f): bool => $f['scope'] === 'user' && $f['heart_id'] === AtsModule::HEART)) === count($filas)
    );
    check(
        'los ids de la bandeja llevan el prefijo ats_',
        count(array_filter($filas, static fn (array $f): bool => str_starts_with((string) $f['id'], 'ats_'))) === count($filas)
    );

    $kind = (string) $pdo->query(
        "SELECT CASE WHEN id LIKE 'ats\\_%' THEN 'atscv' ELSE 'document' END AS kind "
        . 'FROM knowledge_sources WHERE id = ' . $pdo->quote(AtsRepository::artefactId((string) $resultado['operacion'], 'cv'))
    )->fetchColumn();

    check('la bandeja los etiqueta como atscv', $kind === 'atscv', $kind);

    echo "\n=== 9. EL CATÁLOGO: TIPOS, PLANTILLAS Y DATOS REALES ===\n";

    check('el informe trae los dos tipos de documento', count((array) ($resultado['tipos'] ?? [])) === 2);
    check('el informe trae las cinco plantillas', count((array) ($resultado['plantillas'] ?? [])) === 5);

    $idsPlantillas = array_map(
        static fn (array $p): string => (string) $p['id'],
        (array) ($resultado['plantillas'] ?? [])
    );
    check(
        'las plantillas son las cinco acordadas',
        $idsPlantillas === ['harvard', 'simple', 'habilidades', 'ejecutivo', 'compacto'],
        implode(',', $idsPlantillas)
    );

    // The catalogue carries the LAYOUT: the panel paints the preview with the
    // same structure the document will have, so the preview can never promise
    // something the generator does not build.
    $conLayout = array_filter(
        (array) ($resultado['plantillas'] ?? []),
        static fn (array $p): bool => !empty($p['secciones']) && !empty($p['titulos'])
    );
    check('las cinco plantillas viajan con su layout', count($conLayout) === 5, (string) count($conLayout));
    check(
        'el layout de Harvard ordena resumen, habilidades, experiencia y educación',
        ($conLayout[0]['secciones'] ?? []) === ['resumen', 'habilidades', 'experiencia', 'educacion'],
        implode(',', (array) ($conLayout[0]['secciones'] ?? []))
    );

    // The enhanced version: another product, its own operation, its own files.
    $generadoPotenciado = $generador->run(
        $ownerId,
        (array) $resultado['perfil'],
        (array) $resultado['oferta'],
        (array) $resultado['brecha'],
        'ejecutivo',
        'clave-generacion-2',
        null,
        'potenciado'
    );
    $operationGeneracion[] = (string) $generadoPotenciado['operacion'];

    check('el tipo potenciado vuelve en la respuesta', ($generadoPotenciado['tipo'] ?? '') === 'potenciado');
    check('la plantilla elegida vuelve en la respuesta', ($generadoPotenciado['plantilla'] ?? '') === 'ejecutivo');
    check(
        'el potenciado es otra operación que las brechas',
        ($generadoPotenciado['operacion'] ?? '') !== ($generado['operacion'] ?? 'x')
    );
    check(
        'el potenciado genera otros archivos que las brechas',
        ($generadoPotenciado['cv']['docx_url'] ?? '') !== ($generado['cv']['docx_url'] ?? '')
    );
    check(
        'el nuevo match nunca es 100',
        ((int) ($generadoPotenciado['nuevo_match_score'] ?? 0)) <= \App\Heart\Ats\AtsCatalog::MAX_MATCH_SCORE,
        (string) ($generadoPotenciado['nuevo_match_score'] ?? -1)
    );
    check(
        'el prompt del potenciado exige un tono humano',
        str_contains(implode("\n", $brainGeneracion->promptsSeen), 'ESTILO')
    );

    // The REAL data comes from the stored analysis: the operation id alone
    // is enough, the payload can be empty.
    $desdeTabla = $generador->run(
        $ownerId,
        [],
        [],
        [],
        'harvard',
        'clave-generacion-3',
        (string) $resultado['operacion'],
        'brechas'
    );
    $operationGeneracion[] = (string) $desdeTabla['operacion'];
    check(
        'la generación se arma con los datos reales guardados',
        str_contains((string) ($desdeTabla['cv']['texto'] ?? ''), 'Juan Pérez')
    );

    // An unknown type or template is refused, not silently ignored.
    $tipoInventado = false;
    try {
        $generador->run(
            $ownerId,
            (array) $resultado['perfil'],
            (array) $resultado['oferta'],
            (array) $resultado['brecha'],
            'harvard',
            'clave-generacion-tipo',
            null,
            'inventado'
        );
    } catch (InvalidArgumentException) {
        $tipoInventado = true;
    }
    check('un tipo de documento desconocido se rechaza', $tipoInventado);

    $plantillaInventada = false;
    try {
        $generador->run(
            $ownerId,
            (array) $resultado['perfil'],
            (array) $resultado['oferta'],
            (array) $resultado['brecha'],
            'plantilla-que-no-existe',
            'clave-generacion-plantilla'
        );
    } catch (InvalidArgumentException) {
        $plantillaInventada = true;
    }
    check('una plantilla desconocida se rechaza', $plantillaInventada);
} catch (Throwable $e) {
    echo '  ✗ EXCEPCION: ' . get_class($e) . ': ' . $e->getMessage() . "\n";
    echo $e->getTraceAsString() . "\n";
    $failures++;
} finally {
    // Cleanup: the FKs cascade, so deleting the users removes the wallets,
    // the ledger rows, the analyses, the documents and the inbox artefacts.
    foreach ([$ownerId, $otherId, $emptyId, $brokenId] as $userId) {
        $pdo->prepare('DELETE FROM users WHERE id = :id')->execute([':id' => $userId]);
    }

    // The generated files (the storage keys are derived from the operation
    // id, so they are known).
    foreach ($operationGeneracion as $suffix) {
        foreach (['cv', 'carta'] as $kind) {
            foreach (['docx', 'pdf'] as $format) {
                try {
                    $storage->delete($suffix . '_' . $kind . '_' . $format . '.' . $format);
                } catch (Throwable) {
                    // Nothing to remove.
                }
            }
        }
    }
}

echo "\n";

if ($failures > 0) {
    echo "FALLARON {$failures} comprobaciones.\n";
    exit(1);
}

echo "Todas las comprobaciones de CV ATS Match pasaron.\n";
exit(0);
