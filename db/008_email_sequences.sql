CREATE TABLE IF NOT EXISTS email_sequences (
    id              SERIAL PRIMARY KEY,
    company_id      INT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    step            INT NOT NULL DEFAULT 1,
    scheduled_at    TIMESTAMPTZ NOT NULL,
    sent_at         TIMESTAMPTZ,
    cancelled_at    TIMESTAMPTZ,
    cancel_reason   TEXT,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_email_sequences_pending ON email_sequences(scheduled_at, sent_at, cancelled_at);
CREATE INDEX IF NOT EXISTS idx_email_sequences_company ON email_sequences(company_id);
