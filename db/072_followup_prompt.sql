-- Add followup_prompt column to campaigns for per-campaign followup AI prompt override
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS followup_prompt TEXT;

-- Add sent_subject and sent_body columns to company_followup_drafts
-- to store the exact content that was sent (post-merge-tags, with signature)
ALTER TABLE company_followup_drafts ADD COLUMN IF NOT EXISTS sent_subject TEXT;
ALTER TABLE company_followup_drafts ADD COLUMN IF NOT EXISTS sent_body TEXT;
ALTER TABLE company_followup_drafts ADD COLUMN IF NOT EXISTS sent_at TIMESTAMPTZ;
