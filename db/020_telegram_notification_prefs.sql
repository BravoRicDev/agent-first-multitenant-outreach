CREATE TABLE IF NOT EXISTS telegram_notification_prefs (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_type VARCHAR(50) NOT NULL,
  enabled BOOLEAN DEFAULT true,
  min_severity INT DEFAULT 1,
  schedule_time TIME DEFAULT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, event_type)
);

INSERT INTO telegram_notification_prefs (user_id, event_type, enabled)
SELECT u.id, e.event_type, true
FROM users u
CROSS JOIN (VALUES ('cron_completed'), ('cron_error'), ('email_sent'), ('bulk_completed'), ('daily_summary')) AS e(event_type)
WHERE u.notify_telegram_reports = true
ON CONFLICT DO NOTHING;
