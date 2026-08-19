-- 084: FASE 1 MULTI-TENANT — Colonna tenant_id sulle tabelle core
-- =================================================================
-- Obiettivo (SPEC-MULTITENANT-FUNNEL §4 Fase 1): un solo deploy di outreach
-- serve N siti CMS, ciascun dato scoping per tenant_id, risolto dalla
-- config/pannello (token agente -> site_id), MAI da argomento a runtime.
--
-- Questa migrazione è la parte SICURA e RETRO-COMPATIBILE della Fase 1:
-- aggiunge la colonna tenant_id (nullable) a tutte le tabelle core. Null
-- rappresenta il "tenant 0" / istanza mono-tenant attuale (dati esistenti
-- invariati). L'applicazione dello scope nelle query (helper scopeTenant)
-- avviene in seguito, gradualmente, senza cambiare comportamento oggi.
--
-- Nessuna cancellazione, nessun default distruttivo: soli ALTER ADD COLUMN
-- IF NOT EXISTS + indici composti. Riavviabile a piacere (idempotente).

BEGIN;

-- companies — entità principale
ALTER TABLE companies ADD COLUMN IF NOT EXISTS tenant_id INTEGER;
CREATE INDEX IF NOT EXISTS idx_companies_tenant ON companies(tenant_id, id);

-- campaigns
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS tenant_id INTEGER;
CREATE INDEX IF NOT EXISTS idx_campaigns_tenant ON campaigns(tenant_id, id);

-- email_queue
ALTER TABLE email_queue ADD COLUMN IF NOT EXISTS tenant_id INTEGER;
CREATE INDEX IF NOT EXISTS idx_email_queue_tenant ON email_queue(tenant_id, id);

-- followup_sequences
ALTER TABLE followup_sequences ADD COLUMN IF NOT EXISTS tenant_id INTEGER;
CREATE INDEX IF NOT EXISTS idx_followup_sequences_tenant ON followup_sequences(tenant_id, id);

-- smtp_accounts
ALTER TABLE smtp_accounts ADD COLUMN IF NOT EXISTS tenant_id INTEGER;
CREATE INDEX IF NOT EXISTS idx_smtp_accounts_tenant ON smtp_accounts(tenant_id, id);

-- send_schedule
ALTER TABLE send_schedule ADD COLUMN IF NOT EXISTS tenant_id INTEGER;
CREATE INDEX IF NOT EXISTS idx_send_schedule_tenant ON send_schedule(tenant_id, id);

-- blacklist_patterns
ALTER TABLE blacklist_patterns ADD COLUMN IF NOT EXISTS tenant_id INTEGER;
CREATE INDEX IF NOT EXISTS idx_blacklist_patterns_tenant ON blacklist_patterns(tenant_id, id);

-- test_recipients (da 081) — allinea l'indice esistente al default di scope
-- (già predisposta con tenant_id; indice già presente su COALESCE).

COMMIT;
