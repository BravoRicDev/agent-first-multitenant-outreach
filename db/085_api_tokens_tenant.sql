-- 085: FASE 2A MULTI-TENANT — Binding api_tokens a tenant_id
-- ============================================================
-- Obiettivo: legare ogni token agente (agtok_...) a un tenant, per risolvere
-- il tenant_id dell'agente e applicare scopeTenant alle rotte agent.
-- Null = tenant 0 (mono-tenant storico, retro-compatibile).
--
-- Semantica: un agente NON può scegliere il tenant — arriva SOLO dalla
-- risoluzione del token. Query di lettura su tabelle core applicheranno
-- scopeTenant(tenantId), escludendo agenti from altri tenant.
--
-- Nessuna cancellazione, nessun default distruttivo: solo ALTER ADD COLUMN
-- IF NOT EXISTS + indice composto. Idempotente.

BEGIN;

-- api_tokens — nuova colonna tenant_id
ALTER TABLE api_tokens ADD COLUMN IF NOT EXISTS tenant_id INTEGER;
CREATE INDEX IF NOT EXISTS idx_api_tokens_tenant ON api_tokens(tenant_id, id);

COMMIT;
