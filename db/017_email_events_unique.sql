DELETE FROM email_events a USING email_events b
WHERE a.id > b.id
  AND COALESCE(a.subscriber_id, 0) = COALESCE(b.subscriber_id, 0)
  AND COALESCE(a.campaign_id, 0) = COALESCE(b.campaign_id, 0)
  AND a.event_type = b.event_type
  AND a.occurred_at = b.occurred_at;

ALTER TABLE email_events ADD CONSTRAINT uq_email_events_event
  UNIQUE (subscriber_id, campaign_id, event_type, occurred_at);
