import { query } from "../db.js";
import { getSetting } from "./settings.js";
import { logger } from "./logger.js";
import { computeFunnelMetrics } from "./funnel-metrics.js";

// ─────────────────────────────────────────────────────────────────────────
// Alert automatizzati sul funnel (requisito 10). Eseguito dal cron
// (src/index.js). Nessuna dipendenza esterna (Telegram rimosso): un alert è
// un log strutturato ("funnel_alert", livello warn) + una riga in
// `audit_log` (action='funnel_alert', resource='funnel'), consultabile anche
// via agent (nessun endpoint dedicato: usa le rotte audit/log esistenti o
// GET /api/agent/funnel-metrics per rileggere lo stato corrente).
// ─────────────────────────────────────────────────────────────────────────

function num(settingKey, fallback) {
  const v = getSetting(settingKey);
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}

export async function checkFunnelAlerts(tenantId = null) {
  if (getSetting("funnel_alert_enabled") === "false") {
    return { checked: false, reason: "disabilitato via settings" };
  }

  const openRateMin = num("funnel_alert_open_rate_min", 15);
  const replyRateMin = num("funnel_alert_reply_rate_min", 2);
  const stuckDays = Math.max(1, parseInt(getSetting("funnel_alert_stuck_days") || "14", 10) || 14);

  const metrics = await computeFunnelMetrics({ stuckDays, tenantId });
  const alerts = [];

  if (metrics.email.inviate > 0 && metrics.email.open_rate !== null && metrics.email.open_rate < openRateMin) {
    alerts.push({
      type: "open_rate_low",
      message: `Open rate ${metrics.email.open_rate}% sotto la soglia ${openRateMin}%`,
      value: metrics.email.open_rate,
      threshold: openRateMin,
    });
  }

  if (metrics.email.inviate > 0 && metrics.email.reply_rate !== null && metrics.email.reply_rate < replyRateMin) {
    alerts.push({
      type: "reply_rate_low",
      message: `Reply rate ${metrics.email.reply_rate}% sotto la soglia ${replyRateMin}%`,
      value: metrics.email.reply_rate,
      threshold: replyRateMin,
    });
  }

  if (metrics.stuck.count > 0) {
    alerts.push({
      type: "prospects_stuck",
      message: `${metrics.stuck.count} prospect bloccati da più di ${stuckDays} giorni in uno stadio non terminale`,
      count: metrics.stuck.count,
      threshold_days: stuckDays,
      sample_ids: metrics.stuck.sample.slice(0, 10).map((c) => c.id),
    });
  }

  if (alerts.length > 0) {
    logger.warn("funnel_alert", { alerts, metrics: { stages: metrics.stages.counts, email: metrics.email } });
    await query(
      `INSERT INTO audit_log (user_id, action, resource, details) VALUES (NULL, 'funnel_alert', 'funnel', $1)`,
      [JSON.stringify({ alerts, checked_at: new Date().toISOString() })]
    ).catch((err) => logger.warn("Persistenza funnel_alert fallita", { error: err.message }));
  } else {
    logger.info("funnel_alert: nessuna soglia superata", { open_rate: metrics.email.open_rate, reply_rate: metrics.email.reply_rate, stuck: metrics.stuck.count });
  }

  return { checked: true, alerts, metrics };
}
