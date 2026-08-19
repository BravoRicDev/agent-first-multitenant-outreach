-- 081: Modalità test + destinatari di test (requisito 7 — scenario d'uso
-- generico, vedi SPEC-MULTITENANT-FUNNEL.md nella cartella padre del progetto).
--
-- Quando `settings.test_mode = 'true'`, OGNI invio reale (campagna, follow-up,
-- one-to-one manuale) viene deviato verso uno dei `test_recipients` — mai verso
-- il destinatario normale. Se non c'è nessun destinatario di test configurato,
-- l'invio viene bloccato (mai una via di mezzo). Vedi src/services/test-mode.js
-- e il gate applicato in src/services/email-sender.js.
--
-- `tenant_id` è già presente (nullable, non ancora usato: oggi il servizio è
-- single-tenant) per restare pronti alla fase 1 del blueprint multi-tenant
-- senza dover ri-migrare questa tabella in futuro.
BEGIN;

CREATE TABLE IF NOT EXISTS test_recipients (
    id          SERIAL PRIMARY KEY,
    tenant_id   INTEGER,           -- predisposizione multi-tenant (oggi sempre NULL)
    email       VARCHAR(255) NOT NULL,
    note        VARCHAR(255),
    created_by  INTEGER REFERENCES users(id),
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Un solo destinatario per email per tenant (COALESCE per trattare NULL come
-- un unico "tenant 0" finché il servizio resta single-tenant).
CREATE UNIQUE INDEX IF NOT EXISTS idx_test_recipients_tenant_email
  ON test_recipients (COALESCE(tenant_id, 0), LOWER(email));

INSERT INTO settings (key, value, category, description)
VALUES ('test_mode', 'false', 'sicurezza',
        'Se true, ogni invio email viene deviato SOLO verso i destinatari di test (test_recipients); blocca ogni invio verso destinatari normali.')
ON CONFLICT (key) DO NOTHING;

COMMIT;
