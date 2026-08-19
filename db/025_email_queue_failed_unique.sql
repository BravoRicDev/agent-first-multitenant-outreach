DELETE FROM email_queue_failed e1 USING email_queue_failed e2
WHERE e1.id > e2.id AND e1.queue_id = e2.queue_id;
CREATE UNIQUE INDEX IF NOT EXISTS idx_email_queue_failed_queue_id ON email_queue_failed(queue_id);
