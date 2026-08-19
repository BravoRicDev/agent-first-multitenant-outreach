ALTER TABLE companies ADD COLUMN IF NOT EXISTS phone_normalized TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS lead_score INT DEFAULT 0;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS has_replied BOOLEAN DEFAULT false;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS replied_at TIMESTAMPTZ;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS reply_subject TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_companies_phone_normalized ON companies(phone_normalized) WHERE phone_normalized IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_companies_lead_score ON companies(lead_score DESC);
CREATE INDEX IF NOT EXISTS idx_companies_has_replied ON companies(has_replied) WHERE has_replied = true;
