DELETE FROM email_queue e1 USING email_queue e2
WHERE e1.id < e2.id AND e1.company_id = e2.company_id
  AND e1.status IN ('pending', 'sending') AND e2.status IN ('pending', 'sending');

CREATE UNIQUE INDEX IF NOT EXISTS idx_email_queue_pending_unique
ON email_queue(company_id) WHERE status IN ('pending', 'sending');
