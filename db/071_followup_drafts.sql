-- Crea tabella per bozze followup per-azienda (ad personam)
-- Ogni riga = un followup step per un'azienda specifica
CREATE TABLE IF NOT EXISTS company_followup_drafts (
  id          SERIAL PRIMARY KEY,
  company_id  INT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  campaign_id INT NOT NULL REFERENCES campaigns(id),
  step_order  INT NOT NULL,
  subject     TEXT NOT NULL DEFAULT '',
  body        TEXT NOT NULL DEFAULT '',
  approvato   BOOLEAN DEFAULT false,
  generato    BOOLEAN DEFAULT false,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(company_id, step_order)
);

CREATE INDEX IF NOT EXISTS idx_followup_drafts_campaign ON company_followup_drafts(campaign_id, step_order);
CREATE INDEX IF NOT EXISTS idx_followup_drafts_company ON company_followup_drafts(company_id);
CREATE INDEX IF NOT EXISTS idx_followup_drafts_pending ON company_followup_drafts(company_id, approvato, generato);
