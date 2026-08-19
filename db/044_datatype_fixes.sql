ALTER TABLE municipalities ALTER COLUMN cap TYPE VARCHAR(10) USING cap::text;
ALTER TABLE municipalities DROP COLUMN IF EXISTS codice_istat_text;
-- Pulisci duplicati prima di creare indice UNIQUE
DELETE FROM followup_sequences a USING followup_sequences b WHERE a.id > b.id AND a.step_order = b.step_order;
CREATE UNIQUE INDEX IF NOT EXISTS uq_followup_sequences_step_order ON followup_sequences(step_order);
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uq_blacklist_patterns_pattern') THEN ALTER TABLE blacklist_patterns ADD CONSTRAINT uq_blacklist_patterns_pattern UNIQUE (pattern); END IF; END $$;
-- Pulisci email duplicate (tieni la row con id minore)
DELETE FROM companies WHERE id NOT IN (SELECT MIN(id) FROM companies WHERE email IS NOT NULL GROUP BY email) AND email IS NOT NULL;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uq_companies_email') THEN ALTER TABLE companies ADD CONSTRAINT uq_companies_email UNIQUE (email); END IF; END $$;
