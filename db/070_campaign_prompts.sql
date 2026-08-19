-- Aggiunge campi prompt personalizzabili per campagna
-- Se vuoti, si usano i prompt globali dalle settings

ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS prompt_copywriter TEXT,
  ADD COLUMN IF NOT EXISTS prompt_rewrite TEXT;
