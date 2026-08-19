-- 075_api_tokens.sql
-- Token API statici per l'accesso agente/MCP del servizio outreach
-- (pattern agtok_, in stile CMS agent-first). Il valore in chiaro esiste solo al
-- momento della creazione: qui si salva l'hash SHA-256 + un prefisso leggibile
-- per la UI. Nessun segreto in chiaro nel DB né nei file.
CREATE TABLE IF NOT EXISTS api_tokens (
    id            SERIAL PRIMARY KEY,
    user_id       INTEGER REFERENCES users(id) ON DELETE CASCADE,
    name          VARCHAR(255) NOT NULL,
    token_hash    VARCHAR(64) NOT NULL UNIQUE,
    token_prefix  VARCHAR(20) NOT NULL,
    expires_at    TIMESTAMPTZ,
    last_used_at  TIMESTAMPTZ,
    revoked_at    TIMESTAMPTZ,
    created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_api_tokens_user ON api_tokens(user_id);
