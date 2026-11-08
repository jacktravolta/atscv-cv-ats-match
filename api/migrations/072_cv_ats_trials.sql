-- 072: prueba gratuita unica del informe CV ATS MATCH (2026-11-05).
--
-- El PRD del producto CV ATS MATCH (atscv) define dos etapas de negocio:
--   etapa 1 - Informe de Brecha (3 llamadas LLM): 1 credito, pero la PRIMERA
--             vez de cada usuario es gratis (credito BONOS regalo).
--   etapa 2 - CV adaptado + carta (1 llamada LLM): 3 creditos.
--
-- "La primera vez" necesita un marcador durable y atomico: sin el, un doble
-- clic o dos pestanas simultaneas cobrarian dos veces el bonus, o lo
-- grantarian dos veces. Esta tabla es ese marcador: la fila se inserta una
-- sola vez por (user_id, heart_id); el segundo intento choca con la PRIMARY
-- KEY y la operacion se cobra normalmente.
--
-- heart_id se incluye porque el bonus es POR CORAZON: el mismo usuario puede
-- tener en otro corazon (judicial, leylaboral, ...) su propio primer informe
-- gratis. FK a users con ON DELETE CASCADE: si el usuario borra su cuenta,
-- el marcador se borra con el y no sobrevive como residuo.

CREATE TABLE IF NOT EXISTS cv_ats_trials (
    user_id CHAR(36) NOT NULL,
    heart_id VARCHAR(64) NOT NULL,
    granted_at DATETIME(6) NOT NULL,
    PRIMARY KEY (user_id, heart_id),
    CONSTRAINT fk_cv_ats_trials_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
