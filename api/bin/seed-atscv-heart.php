<?php
declare(strict_types=1);

/*
 * CLI seeder: create (or refresh) the atscv heart.
 *
 * Usage:
 *   php bin/seed-atscv-heart.php
 *   php bin/seed-atscv-heart.php --force
 *   php bin/seed-atscv-heart.php --heart=atscv --force
 *
 * The product (SIP CV ATS MATCH, 3 llamadas): the user uploads a CV and a job
 * offer, the platform extracts both, compares them and returns a gap report
 * (match score + missing keywords + why an ATS would reject). The paid stage
 * rewrites the CV for that specific offer and returns DOCX + PDF + cover letter.
 *
 * What it does, in one idempotent pass:
 *   1. heart_settings.site_title      -> "CV ATS Match"
 *   2. heart_settings.site_skin       -> "indigo" (admin-editable)
 *   3. heart_settings.welcome_bonus   -> 100 credits (same contract as every
 *                                        other heart: one welcome grant per
 *                                        email, tracked in welcome_bonus_grantees)
 *   4. heart_personas                 -> the ATS assistant's role for this
 *                                        heart, in both modes, grounded in the
 *                                        BCN-only rule: official law text is
 *                                        the only quotable source for legal
 *                                        claims, and the assistant never
 *                                        invents experience or requirements.
 *   5. tariffs                        -> heart-scoped rates:
 *                                        chat_simple 1, chat_doc 1 (SIP
 *                                        03_API_SPEC: chat = 1 credit),
 *                                        cv_ats_match 1 (SIP 02_API_SPEC),
 *                                        cv_ats_generate 3 (SIP 02_API_SPEC).
 *                                        A global row would silently price
 *                                        every heart, so heart-scoped rows
 *                                        are mandatory here.
 *
 * Wallets are NOT pre-created: per the multi-heart contract they are created
 * on first use for each user + heart pair.
 *
 * The MIGRATIONS must already be applied (072 cv_ats_trials + the tariffs
 * schema) before running this.
 *
 * Exit codes:
 *   0 = seeded
 *   2 = usage or validation error
 *
 * CLI only. It refuses to run under a web SAPI so it can never be triggered
 * over HTTP.
 */

if (PHP_SAPI !== 'cli') {
    http_response_code(403);
    exit('CLI only.');
}

require_once __DIR__ . '/../app/Core/autoload.php';
\App\Core\Config::load(__DIR__ . '/../config/config.php');

use App\Config\HeartPersonaStore;
use App\Core\Config;
use App\Credits\TariffService;
use App\Notify\HeartSettingStore;

const CV_ATS_MATCH_OPERATION = 'cv_ats_match';
const CV_ATS_GENERATE_OPERATION = 'cv_ats_generate';

$opts = getopt('', ['heart::', 'force']);

$heart = trim((string) ($opts['heart'] ?? 'atscv'));
$force = array_key_exists('force', $opts);

if ($heart === '' || preg_match('/^[a-z0-9_-]{1,64}$/', $heart) !== 1) {
    fwrite(STDERR, "El identificador del corazon no es válido.\n");
    exit(2);
}

echo "Sembrando corazon '{$heart}' en " . Config::get('db.name', '?') . "...\n";

// 1-3. Brand + skin + welcome bonus -------------------------------------------
$store = new HeartSettingStore($heart);
$store->set(HeartSettingStore::SITE_TITLE, 'CV ATS Match', null);
echo "[ok] brand            heart={$heart} site_title=CV ATS Match\n";

$store->set(HeartSettingStore::SITE_SKIN, 'indigo', null);
echo "[ok] skin             heart={$heart} site_skin=indigo\n";

$store->set(HeartSettingStore::WELCOME_BONUS_CREDITS, '100', null);
echo "[ok] welcome_bonus    heart={$heart} credits=100\n";

// 4. Personas -----------------------------------------------------------------
// The chat/RAG surface of this heart answers EMPLOYMENT questions (licencias,
// jornada, finiquito, contrato) with the platform's own RAG over BCN text.
// The persona keeps that surface honest: official text only, no invented
// articles, no promises about hiring outcomes. The ATS extraction prompts are
// product-specific and live in app/Heart/Ats, not here.
$personas = new HeartPersonaStore();

$personas->save($heart, 'authenticated', <<<'PROMPT'
Eres el Asistente de Empleo Chile de CV ATS Match. Ayudas a personas que buscan trabajo y están preparando su postulación: analizas su CV contra una oferta, y respondes sus dudas sobre empleo y laws laborales en español de Chile simple y cercano.

REGLAS INQUEBRANTABLES:
1. Sobre el CV y la oferta: usas SOLO los datos que el usuario entregó. NUNCA inventas experiencia, estudios, herramientas ni requisitos que no aparecen en los documentos. Si falta un dato, lo dices y lo pides.
2. Sobre leyes: solo puedes usar el CONTEXTO LEGAL entregado (textos oficiales de la BCN). Nunca inventes leyes, artículos ni jurisprudencia.
3. Si el CONTEXTO no contiene la respuesta, di textual: "No encuentro base legal vigente para eso en la BCN con lo que tengo hoy. ¿Me puedes dar más detalles?".
4. Cuando el texto oficial (BCN / Ley Chile) esté en el contexto, puedes citarlo indicando número de norma y artículo.
5. No prometes que la persona.passará el filtro ATS ni que conseguirá el trabajo: describes el análisis, no el resultado. Todo documento generado requiere revisión humana.

FORMATO DE RESPUESTA (markdown):
**1. En simple:** qué dice tu CV o qué exige la oferta, en 2 líneas.
**2. Lo que te falta:** los requisitos concretos que no aparecen en tu CV.
**3. Qué puedes mejorar hoy:** acciones alcanzables, sin inventar experiencia.
**4. Sobre tu duda legal (si aplica):** la cita de la norma y el siguiente paso.
**5. ¿Quieres que lo dejemos listo?** ofrece el siguiente entregable (CV adaptado, carta, análisis).

TONO: cálido, sin juzgar, sin presionar, sin ocultar costos ni límites. Nunca inventes experiencia ni resultados.
PROMPT);

$personas->save($heart, 'anonymous', <<<'PROMPT'
Eres el Asistente de Empleo Chile de CV ATS Match. Respondes en español de Chile simple y cercano, sin abogadés.

REGLAS: usas SOLO los datos entregados y el CONTEXTO LEGAL entregado; nunca inventas experiencia, herramientas, requisitos, leyes ni artículos; si el contexto no alcanza, dices "No encuentro base legal vigente para eso en la BCN con lo que tengo hoy" y preguntas lo que falta; citas Artículo + Ley cuando el texto oficial (BCN) esté en el contexto; no prometes que la persona pasará un filtro ni conseguirá empleo. Tono cálido, sin juzgar y sin presionar.
PROMPT);

echo "[ok] persona          heart={$heart} modes=authenticated,anonymous\n";

// 5. Tariffs (heart-scoped) ---------------------------------------------------
$tariffs = new TariffService();

$operations = [
    'chat_simple' => 1,                   // SIP 03_API_SPEC: chat consumes 1 credit
    'chat_doc' => 1,                      // SIP 03_API_SPEC: chat consumes 1 credit
    CV_ATS_MATCH_OPERATION => 1,          // SIP 02_API_SPEC: gap report costs 1 credit
    CV_ATS_GENERATE_OPERATION => 3,       // SIP 02_API_SPEC: adapted CV costs 3 credits
];

foreach ($operations as $operation => $credits) {
    $active = $tariffs->current($operation, $heart);

    // current() falls back to the GLOBAL row (heart_id NULL) when the heart
    // has no rate of its own. A global hit is NOT this heart's rate: the SIP
    // spec prices the ATS operations explicitly, so a heart-scoped row is
    // required.
    $activeIsHeartScoped = is_array($active)
        && (string) ($active['heart_id'] ?? '') === $heart;

    if ($activeIsHeartScoped && !$force) {
        echo "[ok] tariff           heart={$heart} operation={$operation} credits={$active['credits_cost']} (ya vigente para este corazon; usa --force para versionar)\n";
        continue;
    }

    $created = $tariffs->create($operation, $credits, null, null, $heart);
    echo "[ok] tariff           heart={$heart} operation={$operation} credits={$created['credits_cost']} version={$created['id']}\n";
}

// 6. Owner --------------------------------------------------------------------
// No service owner is required for this heart: it is a B2C product. Each
// user's wallet is created automatically on first use for this heart.
echo "[info] wallets        se crean solas al primer uso por usuario (contrato multi-corazon)\n";

echo "[done] corazon {$heart} listo.\n";
