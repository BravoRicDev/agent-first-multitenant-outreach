ALTER TABLE followup_sequences ADD COLUMN IF NOT EXISTS campaign_id INT REFERENCES campaigns(id);

-- Assicurarsi che esista almeno una campagna prima di procedere
INSERT INTO campaigns (name) SELECT 'Default' WHERE NOT EXISTS (SELECT 1 FROM campaigns);

UPDATE followup_sequences
SET campaign_id = (SELECT id FROM campaigns ORDER BY created_at DESC LIMIT 1)
WHERE campaign_id IS NULL;

ALTER TABLE followup_sequences ALTER COLUMN campaign_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_followup_campaign ON followup_sequences(campaign_id, is_active, step_order);
