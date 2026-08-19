-- 082: Soglie configurabili per gli alert automatizzati sul funnel B2B
-- (requisito 10 — metriche funnel + alert). Nessuna nuova tabella: gli alert
-- innescati vengono registrati in audit_log (action='funnel_alert') e in log
-- strutturato (vedi src/services/funnel-alerts.js), niente Telegram (rimosso).
BEGIN;

INSERT INTO settings (key, value, category, description) VALUES
  ('funnel_alert_enabled', 'true', 'funnel', 'Abilita il controllo automatico (cron) degli alert sul funnel'),
  ('funnel_alert_open_rate_min', '15', 'funnel', 'Soglia minima open rate (%) sotto la quale scatta un alert'),
  ('funnel_alert_reply_rate_min', '2', 'funnel', 'Soglia minima reply rate (%) sotto la quale scatta un alert'),
  ('funnel_alert_stuck_days', '14', 'funnel', 'Giorni senza avanzamento di stadio oltre i quali un prospect è considerato "bloccato"')
ON CONFLICT (key) DO NOTHING;

COMMIT;
