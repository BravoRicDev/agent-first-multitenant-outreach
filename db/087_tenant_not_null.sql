-- 087: MULTI-TENANT OBBLIGATORIO — Colonna tenant_id NOT NULL sulle tabelle core
-- ===============================================================================
-- Obiettivo: rendere il multi-tenant obbligatorio. Tutti i dati DEVONO appartenere
-- a un tenant esatto. La colonna tenant_id diventa NOT NULL (niente "NULL = tenant 0").
--
-- Questa migrazione è idempotente: può girare più volte senza errore.
-- Usa blocchi DO/CASE per gestire l'idempotenza su ciascuna tabella.
--
-- Nota: questa migrazione suppone che il DB non abbia righe a tenant_id NULL
-- (se ce ne fossero, la migrazione fallirebbe; il deploy dovrà garantire di fare
-- il seed dei dati su tenant specifici prima di questa migrazione).

BEGIN;

-- Helper: function per verificare se una colonna esiste e impostarla NOT NULL
DO $$
DECLARE
  v_col_exists BOOLEAN;
BEGIN
  -- companies
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'companies' AND column_name = 'tenant_id'
  ) INTO v_col_exists;
  IF v_col_exists THEN
    EXECUTE 'ALTER TABLE companies ALTER COLUMN tenant_id SET NOT NULL';
  END IF;

  -- campaigns
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'campaigns' AND column_name = 'tenant_id'
  ) INTO v_col_exists;
  IF v_col_exists THEN
    EXECUTE 'ALTER TABLE campaigns ALTER COLUMN tenant_id SET NOT NULL';
  END IF;

  -- email_queue
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'email_queue' AND column_name = 'tenant_id'
  ) INTO v_col_exists;
  IF v_col_exists THEN
    EXECUTE 'ALTER TABLE email_queue ALTER COLUMN tenant_id SET NOT NULL';
  END IF;

  -- followup_sequences
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'followup_sequences' AND column_name = 'tenant_id'
  ) INTO v_col_exists;
  IF v_col_exists THEN
    EXECUTE 'ALTER TABLE followup_sequences ALTER COLUMN tenant_id SET NOT NULL';
  END IF;

  -- smtp_accounts
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'smtp_accounts' AND column_name = 'tenant_id'
  ) INTO v_col_exists;
  IF v_col_exists THEN
    EXECUTE 'ALTER TABLE smtp_accounts ALTER COLUMN tenant_id SET NOT NULL';
  END IF;

  -- send_schedule
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'send_schedule' AND column_name = 'tenant_id'
  ) INTO v_col_exists;
  IF v_col_exists THEN
    EXECUTE 'ALTER TABLE send_schedule ALTER COLUMN tenant_id SET NOT NULL';
  END IF;

  -- blacklist_patterns
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'blacklist_patterns' AND column_name = 'tenant_id'
  ) INTO v_col_exists;
  IF v_col_exists THEN
    EXECUTE 'ALTER TABLE blacklist_patterns ALTER COLUMN tenant_id SET NOT NULL';
  END IF;

  -- api_tokens
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'api_tokens' AND column_name = 'tenant_id'
  ) INTO v_col_exists;
  IF v_col_exists THEN
    EXECUTE 'ALTER TABLE api_tokens ALTER COLUMN tenant_id SET NOT NULL';
  END IF;

  -- test_recipients
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'test_recipients' AND column_name = 'tenant_id'
  ) INTO v_col_exists;
  IF v_col_exists THEN
    EXECUTE 'ALTER TABLE test_recipients ALTER COLUMN tenant_id SET NOT NULL';
  END IF;
END $$;

COMMIT;
