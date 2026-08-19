CREATE TABLE IF NOT EXISTS company_email_versions (
  id         SERIAL PRIMARY KEY,
  company_id INT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  oggetto    TEXT,
  contenuto  TEXT,
  source     TEXT DEFAULT 'manual',
  created_by INT REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_email_versions_company ON company_email_versions(company_id, created_at DESC);
