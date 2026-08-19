-- 078: Aggiunge la colonna nome_azienda a companies.
--
-- Il codice (routes/companies.js, routes/campaigns.js, routes/cron.js, services/*)
-- referenzia la colonna `nome_azienda` come nome dell'azienda target B2B
-- (fallback preferito di `nome_studio`). Questa migrazione allinea lo schema
-- al codice (colonna nullable/opzionale, quindi non distruttiva per i dati esistenti).
BEGIN;

ALTER TABLE companies ADD COLUMN IF NOT EXISTS nome_azienda TEXT;

COMMIT;
