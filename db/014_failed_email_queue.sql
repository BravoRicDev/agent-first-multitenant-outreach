CREATE TABLE IF NOT EXISTS email_queue_failed (
    id            SERIAL PRIMARY KEY,
    queue_id      INTEGER REFERENCES email_queue(id) ON DELETE SET NULL,
    company_id    INTEGER REFERENCES companies(id) ON DELETE SET NULL,
    provincia     TEXT,
    status        TEXT DEFAULT 'failed',
    error         TEXT,
    retry_count   INTEGER DEFAULT 0,
    last_retry_at TIMESTAMPTZ,
    created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_email_queue_failed_retry ON email_queue_failed(retry_count, last_retry_at);
