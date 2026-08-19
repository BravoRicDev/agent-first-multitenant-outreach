ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS info_azienda   TEXT;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS cta            TEXT;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS link_cta       TEXT;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS email_spunti   TEXT;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS email_template TEXT;

UPDATE campaigns
SET info_azienda = info_azienda_snapshot,
    cta          = cta_snapshot,
    email_template = template_snapshot
WHERE info_azienda IS NULL;
