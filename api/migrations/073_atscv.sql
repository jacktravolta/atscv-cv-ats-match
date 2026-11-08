-- 073: analyses + generated documents of the CV ATS MATCH heart (2026-11-05).
--
-- The product has two business stages:
--   etapa 1 - Informe de Brecha (3 llamadas LLM): 1 credito, la PRIMERA vez
--             de cada usuario es gratis (marcador en cv_ats_trials, 072).
--   etapa 2 - CV adaptado + carta (1 llamada LLM): 3 creditos.
--
-- atscv_analyses is the durable copy of every gap report. It is also the
-- IDEMPOTENCY ANCHOR of stage 1: operation_id is UNIQUE, so a retried
-- request (a double click, a flaky connection, two tabs) finds the stored
-- report and returns it WITHOUT calling the model again and WITHOUT paying
-- again. That is why the whole report lives here and not only in the ledger.
--
-- operation_id carries the heart in its hash because
-- credit_transactions.operation_id is UNIQUE GLOBALLY: the same client key
-- on two hearts must never share one ledger row.
--
-- atscv_documents records the metadata of every generated file (CV / carta,
-- DOCX / PDF). The BYTES live encrypted at rest in the platform's local
-- storage (AES-256-GCM); this table only holds the pointer, the mime type,
-- the size and the owner. user_id is the OWNER RULE: a download verifies
-- that the row belongs to the caller, and the FK deletes the metadata with
-- the account.
--
-- FK to users with ON DELETE CASCADE: when the person deletes their
-- account, the reports and the file metadata go with them.

CREATE TABLE IF NOT EXISTS atscv_analyses (
    id CHAR(36) NOT NULL,
    user_id CHAR(36) NOT NULL,
    heart_id VARCHAR(64) NOT NULL,
    operation_id VARCHAR(64) NOT NULL,
    perfil JSON NOT NULL,
    oferta JSON NOT NULL,
    brecha JSON NOT NULL,
    informe_texto MEDIUMTEXT NULL,
    match_score INT NOT NULL DEFAULT 0,
    credits_charged INT NOT NULL DEFAULT 0,
    primer_informe_gratis TINYINT(1) NOT NULL DEFAULT 0,
    created_at DATETIME(6) NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_atscv_analyses_operation (operation_id),
    INDEX idx_atscv_analyses_user_created (user_id, created_at),
    CONSTRAINT fk_atscv_analyses_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='informes de brecha ATS del corazon atscv (idempotencia de la etapa 1)';

CREATE TABLE IF NOT EXISTS atscv_documents (
    id CHAR(36) NOT NULL,
    user_id CHAR(36) NOT NULL,
    analysis_id CHAR(36) NULL,
    kind VARCHAR(32) NOT NULL,
    format VARCHAR(8) NOT NULL,
    filename VARCHAR(255) NOT NULL,
    storage_key VARCHAR(255) NOT NULL,
    mime VARCHAR(127) NOT NULL,
    bytes_len INT NOT NULL,
    created_at DATETIME(6) NOT NULL,
    PRIMARY KEY (id),
    INDEX idx_atscv_documents_user_created (user_id, created_at),
    CONSTRAINT fk_atscv_documents_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='archivos generados (cv/carta en docx y pdf) del corazon atscv';
