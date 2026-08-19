CREATE TABLE IF NOT EXISTS ghl_events (
  id SERIAL PRIMARY KEY,
  company_id INT REFERENCES companies(id) ON DELETE SET NULL,
  account_id INT,
  event_type TEXT NOT NULL,
  payload JSONB,
  response JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ghl_events_company ON ghl_events(company_id);
CREATE INDEX IF NOT EXISTS idx_ghl_events_created ON ghl_events(created_at DESC);
