CREATE TABLE IF NOT EXISTS email_tracking (
  id UUID PRIMARY KEY,
  company_id INT NOT NULL REFERENCES companies(id),
  smtp_account_id INT REFERENCES smtp_accounts(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE companies ADD COLUMN IF NOT EXISTS tracking_id UUID;
CREATE INDEX IF NOT EXISTS idx_email_tracking_company ON email_tracking(company_id);
CREATE INDEX IF NOT EXISTS idx_email_tracking_id ON email_tracking(id);

-- Event tracking sfrutta già la tabella email_events
ALTER TABLE email_events ALTER COLUMN subscriber_id DROP NOT NULL;
ALTER TABLE email_events ALTER COLUMN campaign_id DROP NOT NULL;
