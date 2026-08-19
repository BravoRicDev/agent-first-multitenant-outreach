CREATE TABLE IF NOT EXISTS email_queue (
    id              SERIAL PRIMARY KEY,
    company_id      INT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    provincia       TEXT,
    status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','sending','sent','failed')),
    error           TEXT,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    processed_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_email_queue_pending ON email_queue(status, created_at);
CREATE INDEX IF NOT EXISTS idx_email_queue_provincia ON email_queue(provincia);
