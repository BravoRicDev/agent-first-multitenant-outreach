ALTER TABLE smtp_accounts ADD COLUMN IF NOT EXISTS firma_testo TEXT;
ALTER TABLE smtp_accounts ADD COLUMN IF NOT EXISTS firma_html  TEXT;
