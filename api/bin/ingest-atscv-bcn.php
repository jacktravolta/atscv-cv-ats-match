<?php
declare(strict_types=1);

/*
 * CLI: ingest the Chilean labor-law corpus into a heart's global RAG.
 *
 * The text comes VERBATIM from the BCN (Ley Chile) through the platform's own
 * BcnClient scraper — never from LLM recall (SIP 02_INGESTA_BCN.md). The
 * corpus itself (norm list, article selection, block headers) lives in
 * App\Legal\LaboralCorpus so every heart that needs it ingests the SAME truth.
 *
 * Usage:
 *   php bin/ingest-atscv-bcn.php                  # ingest into the atscv heart
 *   php bin/ingest-atscv-bcn.php --heart=leylaboral
 *   php bin/ingest-atscv-bcn.php --dry-run        # counts only, no DB writes
 *   php bin/ingest-atscv-bcn.php --force          # re-ingest (replaces the source)
 *
 * Idempotency: one source per title per heart. A second run without --force
 * reports "[skip] ya existe" and writes nothing.
 *
 * Exit codes:
 *   0 = ok
 *   1 = partial failure
 *   2 = usage error
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

use App\Legal\BcnClient;
use App\Legal\LaboralCorpus;
use App\Rag\KnowledgeBase;

const DEFAULT_HEART = 'atscv';

$opts = getopt('', ['dry-run', 'force', 'heart:']);
$dryRun = array_key_exists('dry-run', $opts);
$force = array_key_exists('force', $opts);
$heart = trim((string) ($opts['heart'] ?? DEFAULT_HEART));

if ($heart === '') {
    fwrite(STDERR, "Uso: php bin/ingest-atscv-bcn.php [--heart=atscv] [--dry-run] [--force]\n");
    exit(2);
}

$client = new BcnClient();
$pdo = \App\Core\Database::connection();
$kb = new KnowledgeBase();

echo "heart={$heart} vigencia=" . LaboralCorpus::VIGENCIA
    . " chunk_chars=" . \App\Core\Config::get('rag.chunk_chars', '?')
    . " overlap=" . \App\Core\Config::get('rag.chunk_overlap', '?') . "\n";

try {
    $documents = LaboralCorpus::collect($client);
} catch (\Throwable $e) {
    echo "[error] no se pudo leer el corpus del BCN: " . get_class($e) . ': ' . $e->getMessage() . "\n";
    exit(1);
}

$failures = 0;

foreach ($documents as $doc) {
    echo "[bcn] {$doc['ley']}: idNorma={$doc['idNorma']} articulos={$doc['articles']}"
        . " chars=" . strlen($doc['text'])
        . " vigente=" . ($doc['vigente'] ? 'si' : 'no') . "\n";

    if ($dryRun) {
        continue;
    }

    // Idempotency: one source per title per heart.
    $existing = $pdo->prepare(
        "SELECT id FROM knowledge_sources WHERE title = :title AND heart_id = :heart LIMIT 1"
    );
    $existing->execute([':title' => $doc['title'], ':heart' => $heart]);
    $oldId = $existing->fetchColumn();

    if ($oldId !== false) {
        if (!$force) {
            echo "[skip] {$doc['ley']}: la fuente ya existe ({$oldId}); usa --force para re-ingestar\n";
            continue;
        }

        $pdo->prepare('DELETE FROM knowledge_chunks WHERE source_id = :id')->execute([':id' => $oldId]);
        $pdo->prepare('DELETE FROM knowledge_sources WHERE id = :id')->execute([':id' => $oldId]);
        echo "[force] {$doc['ley']}: fuente anterior eliminada\n";
    }

    try {
        $ingested = $kb->ingestText($doc['title'], $doc['text'], 'global', null, null, null, null, $heart);
        echo "[ok] {$doc['ley']}: source_id={$ingested['source_id']} chunks={$ingested['chunks']}\n";
    } catch (\Throwable $e) {
        echo "[error] {$doc['ley']}: " . get_class($e) . ': ' . $e->getMessage() . "\n";
        $failures++;
    }
}

if ($dryRun) {
    echo "[dry-run] nada fue escrito en la base de datos.\n";
    exit($failures > 0 ? 1 : 0);
}

// Final state read back from the database (truth, not the loop's memory).
$sources = $pdo->prepare(
    "SELECT id, title, status, (SELECT COUNT(*) FROM knowledge_chunks c WHERE c.source_id = k.id) AS chunks
     FROM knowledge_sources k WHERE heart_id = :heart AND scope = 'global'"
);
$sources->execute([':heart' => $heart]);

echo "\n=== estado real del RAG (heart={$heart}, scope=global) ===\n";
foreach ($sources as $row) {
    echo "status={$row['status']} chunks={$row['chunks']} | {$row['title']}\n";
}

exit($failures > 0 ? 1 : 0);
