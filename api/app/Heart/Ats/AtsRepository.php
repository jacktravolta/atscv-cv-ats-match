<?php
declare(strict_types=1);

namespace App\Heart\Ats;

use App\Core\Database;
use PDOException;

/**
 * Persistence for the CV ATS Match heart (atscv).
 *
 * Three tables are involved:
 *   - atscv_analyses    : one row per gap report (the idempotency anchor).
 *   - atscv_documents   : one row per generated file (CV / carta, DOCX / PDF).
 *   - cv_ats_trials     : the "first report is free" ledger (migration 072).
 *
 * WHY DETERMINISTIC IDS: the operation id already identifies the work, so the
 * row ids are derived from it. A retried request therefore lands on the SAME
 * rows: the second attempt overwrites instead of duplicating, and the replay
 * can find what the first attempt produced without a second brain call.
 */
final class AtsRepository
{
    /**
     * The stored report for an operation id, or null.
     *
     * The owner is NOT filtered here on purpose: the caller decides what a
     * foreign operation id means (see AtsMatchService::run).
     *
     * @return array<string, mixed>|null
     */
    public function findAnalysis(string $operationId): ?array
    {
        $statement = Database::connection()->prepare(
            'SELECT id, user_id, heart_id, operation_id, perfil, oferta, brecha, informe_texto, '
            . 'match_score, credits_charged, primer_informe_gratis, created_at '
            . 'FROM atscv_analyses WHERE operation_id = :operation_id LIMIT 1'
        );
        $statement->execute([':operation_id' => $operationId]);

        $row = $statement->fetch(\PDO::FETCH_ASSOC);

        if (!is_array($row)) {
            return null;
        }

        return [
            'id' => (string) $row['id'],
            'user_id' => (string) $row['user_id'],
            'heart_id' => (string) $row['heart_id'],
            'operation_id' => (string) $row['operation_id'],
            'perfil' => self::decodeJson($row['perfil'] ?? null),
            'oferta' => self::decodeJson($row['oferta'] ?? null),
            'brecha' => self::decodeJson($row['brecha'] ?? null),
            'informe_texto' => (string) ($row['informe_texto'] ?? ''),
            'match_score' => (int) ($row['match_score'] ?? 0),
            'credits_charged' => (int) ($row['credits_charged'] ?? 0),
            'primer_informe_gratis' => ((int) ($row['primer_informe_gratis'] ?? 0)) === 1,
            'created_at' => (string) ($row['created_at'] ?? ''),
        ];
    }

    /**
     * Store one gap report.
     *
     * @param array<string, mixed> $data
     * @return string The analysis id.
     *
     * @throws PDOException On a duplicate operation id (a concurrent retry).
     */
    public function saveAnalysis(array $data): string
    {
        $id = self::uuid4();

        Database::connection()->prepare(
            'INSERT INTO atscv_analyses '
            . '(id, user_id, heart_id, operation_id, perfil, oferta, brecha, informe_texto, '
            . 'match_score, credits_charged, primer_informe_gratis, created_at) '
            . 'VALUES (:id, :user_id, :heart_id, :operation_id, :perfil, :oferta, :brecha, :informe_texto, '
            . ':match_score, :credits_charged, :primer_informe_gratis, :created_at)'
        )->execute([
            ':id' => $id,
            ':user_id' => (string) $data['user_id'],
            ':heart_id' => (string) $data['heart_id'],
            ':operation_id' => (string) $data['operation_id'],
            ':perfil' => self::encodeJson($data['perfil'] ?? []),
            ':oferta' => self::encodeJson($data['oferta'] ?? []),
            ':brecha' => self::encodeJson($data['brecha'] ?? []),
            ':informe_texto' => (string) ($data['informe_texto'] ?? ''),
            ':match_score' => (int) ($data['match_score'] ?? 0),
            ':credits_charged' => (int) ($data['credits_charged'] ?? 0),
            ':primer_informe_gratis' => !empty($data['primer_informe_gratis']) ? 1 : 0,
            ':created_at' => self::now(),
        ]);

        return $id;
    }

    /**
     * Consume the free first report of this user on this heart.
     *
     * The ledger is the PRIMARY KEY (user_id, heart_id): the first INSERT wins
     * and every later one collides. A collision means "already used", so the
     * caller charges normally.
     *
     * @return bool True when the trial was consumed by THIS call.
     */
    public function consumeTrial(string $userId, string $heartId): bool
    {
        try {
            Database::connection()->prepare(
                'INSERT INTO cv_ats_trials (user_id, heart_id, granted_at) '
                . 'VALUES (:user_id, :heart_id, :granted_at)'
            )->execute([
                ':user_id' => $userId,
                ':heart_id' => $heartId,
                ':granted_at' => self::now(),
            ]);

            return true;
        } catch (PDOException $e) {
            // Duplicate key: the free report was already granted.
            if ((string) $e->getCode() === '23000') {
                return false;
            }

            throw $e;
        }
    }

    /**
     * Store the metadata of one generated file.
     *
     * The id is derived from the operation id (see documentId), so a retried
     * generation lands on the SAME row: the upsert refreshes the metadata
     * instead of failing with a duplicate key.
     *
     * @param array<string, mixed> $data
     */
    public function saveDocument(array $data): string
    {
        $id = (string) ($data['id'] ?? self::uuid4());

        Database::connection()->prepare(
            'INSERT INTO atscv_documents '
            . '(id, user_id, analysis_id, kind, format, filename, storage_key, mime, bytes_len, created_at) '
            . 'VALUES (:id, :user_id, :analysis_id, :kind, :format, :filename, :storage_key, :mime, :bytes_len, '
            . ':created_at) '
            . 'ON DUPLICATE KEY UPDATE '
            . 'analysis_id = VALUES(analysis_id), filename = VALUES(filename), '
            . 'storage_key = VALUES(storage_key), mime = VALUES(mime), bytes_len = VALUES(bytes_len)'
        )->execute([
            ':id' => $id,
            ':user_id' => (string) $data['user_id'],
            ':analysis_id' => $data['analysis_id'] ?? null,
            ':kind' => (string) $data['kind'],
            ':format' => (string) $data['format'],
            ':filename' => (string) $data['filename'],
            ':storage_key' => (string) $data['storage_key'],
            ':mime' => (string) $data['mime'],
            ':bytes_len' => (int) $data['bytes_len'],
            ':created_at' => self::now(),
        ]);

        return $id;
    }

    /**
     * One generated file, whatever its owner.
     *
     * @return array<string, mixed>|null
     */
    public function findDocument(string $documentId): ?array
    {
        $statement = Database::connection()->prepare(
            'SELECT id, user_id, analysis_id, kind, format, filename, storage_key, mime, bytes_len, created_at '
            . 'FROM atscv_documents WHERE id = :id LIMIT 1'
        );
        $statement->execute([':id' => $documentId]);

        $row = $statement->fetch(\PDO::FETCH_ASSOC);

        return is_array($row) ? $row : null;
    }

    /**
     * One generated file OWNED by the given user.
     *
     * The owner filter is the whole point of this method: a download for
     * somebody else's file must find nothing.
     *
     * @return array<string, mixed>|null
     */
    public function findDocumentForOwner(string $documentId, string $userId): ?array
    {
        $statement = Database::connection()->prepare(
            'SELECT id, user_id, analysis_id, kind, format, filename, storage_key, mime, bytes_len, created_at '
            . 'FROM atscv_documents WHERE id = :id AND user_id = :user_id LIMIT 1'
        );
        $statement->execute([':id' => $documentId, ':user_id' => $userId]);

        $row = $statement->fetch(\PDO::FETCH_ASSOC);

        return is_array($row) ? $row : null;
    }

    /**
     * The inbox id of one artefact of an operation (36 chars, "ats_" prefix).
     *
     * The front labels these rows "atscv" (see RagController::listSources).
     */
    public static function artefactId(string $operationId, string $suffix): string
    {
        return 'ats_' . substr(hash('sha256', $operationId . '|' . $suffix), 0, 32);
    }

    /**
     * The deterministic id of one generated file (a UUID-shaped string).
     */
    public static function documentId(string $operationId, string $kind, string $format): string
    {
        $hex = substr(hash('sha256', $operationId . '|' . $kind . '|' . $format), 0, 32);
        $hex[12] = '5';
        $hex[16] = dechex((hexdec($hex[16]) & 0x3) | 0x8);

        return substr($hex, 0, 8) . '-' . substr($hex, 8, 4) . '-' . substr($hex, 12, 4)
            . '-' . substr($hex, 16, 4) . '-' . substr($hex, 20, 12);
    }

    /**
     * @return array<string, mixed>
     */
    private static function decodeJson(mixed $value): array
    {
        if (is_array($value)) {
            return $value;
        }

        if (!is_string($value) || trim($value) === '') {
            return [];
        }

        $decoded = json_decode($value, true);

        return is_array($decoded) ? $decoded : [];
    }

    /**
     * @param mixed $value
     */
    private static function encodeJson($value): string
    {
        $json = json_encode($value, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);

        return $json === false ? '{}' : $json;
    }

    private static function now(): string
    {
        return (new \DateTimeImmutable('now', new \DateTimeZone('UTC')))->format('Y-m-d H:i:s.u');
    }

    private static function uuid4(): string
    {
        $data = random_bytes(16);
        $data[6] = chr((ord($data[6]) & 0x0f) | 0x40);
        $data[8] = chr((ord($data[8]) & 0x3f) | 0x80);

        return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($data), 4));
    }
}
