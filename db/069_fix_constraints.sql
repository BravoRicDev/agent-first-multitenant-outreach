-- Fix: rendi UNIQUE su followup_sequences per-campaign invece che globale
-- Dopo db/065 che ha aggiunto campaign_id, l'indice globale uq_followup_sequences_step_order
-- impedisce di avere due campagne con lo stesso step_order

DROP INDEX IF EXISTS uq_followup_sequences_step_order;
CREATE UNIQUE INDEX IF NOT EXISTS uq_followup_sequences_campaign_step ON followup_sequences(campaign_id, step_order);

-- Fix: rendi il vincolo UNIQUE su email case-insensitive (la deduplica applicativa usa LOWER(email))
-- e lascia che il vecchio vincolo venga sostituito

DROP INDEX IF EXISTS uq_companies_email_lower;
CREATE UNIQUE INDEX IF NOT EXISTS uq_companies_email_lower ON companies (LOWER(email)) WHERE email IS NOT NULL;

-- Il vecchio vincolo UNIQUE (email) va rimosso manualmente o ignorato:
-- DO $$ BEGIN
--   ALTER TABLE companies DROP CONSTRAINT IF EXISTS uq_companies_email;
-- EXCEPTION WHEN OTHERS THEN NULL;
-- END $$;
