ALTER TABLE companies ADD COLUMN IF NOT EXISTS bozza_email_oggetto_b TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS ab_variant CHAR(1) CHECK (ab_variant IN ('A','B'));
ALTER TABLE companies ADD COLUMN IF NOT EXISTS ab_winner BOOLEAN DEFAULT false;
CREATE INDEX IF NOT EXISTS idx_companies_ab_variant ON companies(ab_variant) WHERE ab_variant IS NOT NULL;
