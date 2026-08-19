ALTER TABLE smtp_accounts ADD COLUMN IF NOT EXISTS warming_enabled BOOLEAN DEFAULT false;
ALTER TABLE smtp_accounts ADD COLUMN IF NOT EXISTS warming_start_date DATE;
ALTER TABLE smtp_accounts ADD COLUMN IF NOT EXISTS warming_start_limit INT DEFAULT 20;
ALTER TABLE smtp_accounts ADD COLUMN IF NOT EXISTS warming_increment INT DEFAULT 20;
ALTER TABLE smtp_accounts ADD COLUMN IF NOT EXISTS warming_max_limit INT DEFAULT 200;
