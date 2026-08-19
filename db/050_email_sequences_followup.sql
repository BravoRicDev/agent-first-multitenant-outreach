ALTER TABLE email_sequences ADD COLUMN IF NOT EXISTS followup_sequence_id INT REFERENCES followup_sequences(id);
