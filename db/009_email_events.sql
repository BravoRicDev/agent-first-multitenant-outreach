CREATE TABLE IF NOT EXISTS email_events (
    id              SERIAL PRIMARY KEY,
    company_id      INT REFERENCES companies(id) ON DELETE SET NULL,
    event_type      TEXT NOT NULL,
    campaign_id     INT,
    subscriber_id   INT,
    meta            JSONB,
    occurred_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_email_events_company ON email_events(company_id);
CREATE INDEX IF NOT EXISTS idx_email_events_event ON email_events(event_type);
CREATE INDEX IF NOT EXISTS idx_email_events_campaign ON email_events(campaign_id);
