ALTER TABLE companies ADD COLUMN IF NOT EXISTS lat DOUBLE PRECISION;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS lng DOUBLE PRECISION;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS google_row INT;
UPDATE companies SET lat = NULLIF(REGEXP_REPLACE(COALESCE(latitude,''), '[^0-9\.\-]', '', 'g'), '')::DOUBLE PRECISION WHERE latitude IS NOT NULL AND latitude != '';
UPDATE companies SET lng = NULLIF(REGEXP_REPLACE(COALESCE(longitude,''), '[^0-9\.\-]', '', 'g'), '')::DOUBLE PRECISION WHERE longitude IS NOT NULL AND longitude != '';
UPDATE companies SET google_row = NULLIF(REGEXP_REPLACE(COALESCE(foglio_google_riga::text,''), '[^0-9]', '', 'g'), '')::INT WHERE foglio_google_riga IS NOT NULL;
ALTER TABLE municipalities ADD COLUMN IF NOT EXISTS codice_istat_text TEXT;
UPDATE municipalities SET codice_istat_text = LPAD(COALESCE(codice_istat::text, ''), 9, '0') WHERE codice_istat IS NOT NULL;
