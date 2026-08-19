-- Migrazione 073: integrazione CMS agent-first + stato consenso (freddi vs consensati)
-- Sostituisce la logica GHL del servizio outreach. Colonna consent_status è la
-- "fotografia" del consenso derivata dal CMS al momento del sync:
--   'cold'      = nessun consenso marketing (solo cold B2B one-to-one con UNSUB)
--   'marketing' = consenso marketing/pref_email espresso (form GDPR / opt-in)

-- companies: stato consenso + fonte + ultimo sync col CMS
ALTER TABLE companies ADD COLUMN IF NOT EXISTS consent_status VARCHAR(20) DEFAULT 'cold'
  CHECK (consent_status IN ('cold','marketing'));
ALTER TABLE companies ADD COLUMN IF NOT EXISTS consent_source VARCHAR(40);  -- form/scrape/manual/cms
ALTER TABLE companies ADD COLUMN IF NOT EXISTS cms_synced_at TIMESTAMPTZ;

-- campaigns: mapping verso la pipeline del CMS (sostituisce i campi ghl_* della pipeline)
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS cms_pipeline_id INTEGER;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS cms_stage_map JSONB;

-- email_queue: stato consenso "fotografato" al momento dell'invio (per audit/compliance)
ALTER TABLE email_queue ADD COLUMN IF NOT EXISTS consent_status VARCHAR(20);

-- indici utili
CREATE INDEX IF NOT EXISTS idx_companies_consent_status ON companies(consent_status);
CREATE INDEX IF NOT EXISTS idx_email_queue_consent ON email_queue(consent_status);
