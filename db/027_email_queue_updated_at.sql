ALTER TABLE email_queue ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();
CREATE INDEX IF NOT EXISTS idx_email_queue_updated_at ON email_queue(updated_at);
