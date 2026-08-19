ALTER TABLE email_queue ADD COLUMN IF NOT EXISTS smtp_account_id INT;
CREATE INDEX IF NOT EXISTS idx_email_queue_smtp ON email_queue(smtp_account_id) WHERE smtp_account_id IS NOT NULL;
