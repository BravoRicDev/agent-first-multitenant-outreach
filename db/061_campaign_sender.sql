ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS from_name_override TEXT;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS from_email_override TEXT;
