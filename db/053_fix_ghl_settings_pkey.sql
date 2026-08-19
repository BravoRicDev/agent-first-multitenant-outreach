-- Assicura che ghl_settings abbia una primary key
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conrelid = 'ghl_settings'::regclass AND contype = 'p'
  ) THEN
    ALTER TABLE ghl_settings ADD PRIMARY KEY (id);
  END IF;
END $$;
