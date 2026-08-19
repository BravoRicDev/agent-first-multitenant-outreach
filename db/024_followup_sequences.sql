CREATE TABLE IF NOT EXISTS followup_sequences (
  id SERIAL PRIMARY KEY,
  step_order INT NOT NULL,
  delay_days INT NOT NULL DEFAULT 4,
  subject TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO followup_sequences (step_order, delay_days, subject, body)
SELECT 1, 4, COALESCE(followup_step2_subject, ''), COALESCE(followup_step2_body, '')
FROM direzione WHERE id = 1
UNION ALL
SELECT 2, 9, COALESCE(followup_step3_subject, ''), COALESCE(followup_step3_body, '')
FROM direzione WHERE id = 1
ON CONFLICT DO NOTHING;
