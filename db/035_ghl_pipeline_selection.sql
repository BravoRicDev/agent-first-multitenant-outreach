ALTER TABLE ghl_settings ADD COLUMN IF NOT EXISTS pipeline_name TEXT;
ALTER TABLE ghl_settings ADD COLUMN IF NOT EXISTS stage_new_lead_name TEXT;
ALTER TABLE ghl_settings ADD COLUMN IF NOT EXISTS stage_email_sent_name TEXT;
ALTER TABLE ghl_settings ADD COLUMN IF NOT EXISTS stage_opened_name TEXT;
ALTER TABLE ghl_settings ADD COLUMN IF NOT EXISTS stage_replied_name TEXT;
