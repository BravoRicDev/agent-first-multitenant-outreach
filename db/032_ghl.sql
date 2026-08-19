CREATE TABLE IF NOT EXISTS ghl_settings (
  id               SERIAL PRIMARY KEY,
  api_url          TEXT NOT NULL DEFAULT 'https://rest.gohighlevel.com/v1',
  api_key          TEXT NOT NULL,
  location_id      TEXT NOT NULL,
  pipeline_id      TEXT,
  stage_new_lead   TEXT,
  stage_email_sent TEXT,
  stage_opened     TEXT,
  stage_replied    TEXT,
  our_tag          TEXT NOT NULL DEFAULT 'outreach-service',
  is_active        BOOLEAN DEFAULT true,
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE companies ADD COLUMN IF NOT EXISTS ghl_contact_id TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS ghl_status TEXT CHECK (ghl_status IN ('synced','already_exists','error',NULL));
CREATE INDEX IF NOT EXISTS idx_companies_ghl_contact ON companies(ghl_contact_id) WHERE ghl_contact_id IS NOT NULL;
