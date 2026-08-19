ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS smtp_account_id INT REFERENCES smtp_accounts(id);
