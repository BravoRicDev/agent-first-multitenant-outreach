-- Sostituisce il vincolo UNIQUE su colonne grezze con un indice UNIQUE
-- su espressioni COALESCE, in modo che ON CONFLICT (COALESCE(...), ...) 
-- nel webhook di Listmonk possa fare inferenza.
-- Vedi: B1 nella review bug

ALTER TABLE email_events DROP CONSTRAINT IF EXISTS uq_email_events_event;
DROP INDEX IF EXISTS uq_email_events_coalesced;
CREATE UNIQUE INDEX IF NOT EXISTS uq_email_events_coalesced
  ON email_events (COALESCE(subscriber_id, 0), COALESCE(campaign_id, 0), event_type, occurred_at);
