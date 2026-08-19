CREATE TABLE IF NOT EXISTS campaigns (
  id                    SERIAL PRIMARY KEY,
  name                  TEXT NOT NULL,
  info_azienda_snapshot TEXT,
  cta_snapshot          TEXT,
  template_snapshot     TEXT,
  is_active             BOOLEAN DEFAULT true,
  ab_test_enabled       BOOLEAN DEFAULT false,
  created_at            TIMESTAMPTZ DEFAULT NOW(),
  ended_at              TIMESTAMPTZ
);

ALTER TABLE companies ADD COLUMN IF NOT EXISTS campaign_id INT REFERENCES campaigns(id);
ALTER TABLE email_queue ADD COLUMN IF NOT EXISTS campaign_id INT REFERENCES campaigns(id);
ALTER TABLE email_sequences ADD COLUMN IF NOT EXISTS campaign_id INT REFERENCES campaigns(id);
