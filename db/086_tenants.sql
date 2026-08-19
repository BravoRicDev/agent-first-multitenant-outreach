-- 086: FASE 5 MULTI-TENANT — Catalogo tenants (gestione UI)
-- ==========================================================
-- Obiettivo: creare una tabella di catalogo dei tenant per il pannello
-- admin di gestione. Consente di attivare/disattivare tenant, impostare
-- quota email giornaliera per-tenant, e test_mode per-tenant.
--
-- Semantica: ogni riga rappresenta un tenant gestito (id > 0, NULL = tenant 0
-- mono-tenant non catalogato). Idempotente, con seed dai tenant_id già presenti.
-- Nessuna cancellazione, nessun default distruttivo.

BEGIN;

-- Tabella catalogo tenants
CREATE TABLE IF NOT EXISTS tenants (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  site_id       INTEGER,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  daily_email_quota INTEGER,
  test_mode     BOOLEAN NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE tenants IS
  'Catalogo tenant: id > 0 rappresenta un tenant gestito. NULL/0 = mono-tenant storico.
   is_active: se FALSE, il tenant è disabilitato e non consuma quote.
   daily_email_quota: NULL = illimitato; altrimenti email/giorno per questo tenant.
   test_mode: se TRUE, email del tenant vanno in test (no invio reale).
   site_id: collegamento opzionale a istanza CMS.';

COMMENT ON COLUMN tenants.id IS 'Identificatore tenant > 0';
COMMENT ON COLUMN tenants.name IS 'Nome leggibile tenant';
COMMENT ON COLUMN tenants.is_active IS 'Se FALSE, tenant è disabilitato';
COMMENT ON COLUMN tenants.daily_email_quota IS 'Quota email/giorno per tenant; NULL = illimitato';
COMMENT ON COLUMN tenants.test_mode IS 'Se TRUE, email non sono inviate (test mode)';
COMMENT ON COLUMN tenants.site_id IS 'ID CMS collegato (opzionale, 1:1)';

-- Indice per ricerche frequenti
CREATE INDEX IF NOT EXISTS idx_tenants_active ON tenants(is_active);
CREATE INDEX IF NOT EXISTS idx_tenants_site ON tenants(site_id);

-- Seed: importa tenant_id già presenti in companies, api_tokens, etc.
-- ON CONFLICT DO NOTHING per idempotenza: se il tenant esiste già, non fare nulla.
INSERT INTO tenants (id, name, is_active, created_at, updated_at)
SELECT DISTINCT
  COALESCE(tenant_id, 0) AS id,
  'Tenant ' || COALESCE(tenant_id, 0)::TEXT AS name,
  TRUE,
  NOW(),
  NOW()
FROM companies
WHERE tenant_id IS NOT NULL AND tenant_id > 0
ON CONFLICT (id) DO NOTHING;

INSERT INTO tenants (id, name, is_active, created_at, updated_at)
SELECT DISTINCT
  COALESCE(tenant_id, 0) AS id,
  'Tenant ' || COALESCE(tenant_id, 0)::TEXT AS name,
  TRUE,
  NOW(),
  NOW()
FROM api_tokens
WHERE tenant_id IS NOT NULL AND tenant_id > 0
ON CONFLICT (id) DO NOTHING;

COMMIT;
