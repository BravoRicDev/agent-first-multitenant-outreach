ALTER TABLE ghl_settings ADD COLUMN IF NOT EXISTS name TEXT DEFAULT 'Principale';
ALTER TABLE ghl_settings ADD COLUMN IF NOT EXISTS webhook_secret TEXT;
ALTER TABLE ghl_settings DROP CONSTRAINT IF EXISTS ghl_settings_pkey;
ALTER TABLE ghl_settings ADD PRIMARY KEY (id);
