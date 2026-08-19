ALTER TABLE companies ADD COLUMN IF NOT EXISTS listmonk_subscriber_id INT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS listmonk_campaign_id INT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS inviato_at TIMESTAMPTZ;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS email_opened_at TIMESTAMPTZ;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS email_clicked_at TIMESTAMPTZ;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS email_bounced BOOLEAN DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_companies_inviato ON companies(inviato);
CREATE INDEX IF NOT EXISTS idx_companies_inviato_at ON companies(inviato_at);
