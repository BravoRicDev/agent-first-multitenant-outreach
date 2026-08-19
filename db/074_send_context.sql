-- Migrazione 074: contesto di invio in email_queue (freddi vs consensati)
-- Distingue il canale di invio per applicare correttamente la regola freddi/consensati
-- nella coda programmata (send-schedule):
--   'automatic' = campagna/sequenza programmata → riservata ai SOLO consent_status='marketing'
--   'manual'    = invio one-to-one esplicito     → ammette anche i 'cold'
-- Il flusso automatico (folle marketer) opera unicamente sui marketing; i cold restano
-- confinati al one-to-one manuale e non entrano mai nelle folle programmate.
ALTER TABLE email_queue ADD COLUMN IF NOT EXISTS send_context VARCHAR(16) DEFAULT 'automatic'
  CHECK (send_context IN ('automatic','manual'));
CREATE INDEX IF NOT EXISTS idx_email_queue_send_context ON email_queue(send_context);
