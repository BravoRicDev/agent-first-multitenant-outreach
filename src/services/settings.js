import { query } from "../db.js";
import { logger } from "./logger.js";

let cache = {};
let loaded = false;
let lastLoad = 0;
let refreshing = false;
const CACHE_TTL_MS = 60000;

let refreshPromise = null;

export async function loadSettings() {
  if (refreshing) return;
  refreshing = true;
  try {
    const result = await query("SELECT key, value FROM settings");
    const newCache = {};
    for (const row of result.rows) {
      newCache[row.key] = row.value;
    }
    Object.assign(cache, newCache);
    loaded = true;
    lastLoad = Date.now();
    logger.info(`Loaded ${Object.keys(cache).length} settings from DB`);
  } catch (err) {
    logger.warn("Settings not available from DB, using env vars", { error: err.message });
    loaded = false;
  } finally {
    refreshing = false;
  }
}

async function refreshSettings() {
  if (refreshPromise) return refreshPromise;
  refreshPromise = loadSettings().finally(() => { refreshPromise = null; });
  return refreshPromise;
}

export function getSetting(key) {
  if (loaded && Date.now() - lastLoad > CACHE_TTL_MS && !refreshing) {
    refreshSettings().catch(err => logger.warn("Settings refresh fallito", { error: err.message }));
  }
  if (cache[key] !== undefined && cache[key] !== null) {
    return cache[key];
  }
  const envKey = key.toUpperCase();
  return process.env[envKey] || null;
}

export function getAllSettings() {
  return { ...cache };
}

const ALLOWED_SETTING_KEYS = new Set([
  "smtp_host", "smtp_port", "smtp_user", "smtp_pass", "smtp_config_hash", "email_from",
  "openrouter_api_key", "openrouter_base_url", "openrouter_model_extraction",
  "openrouter_model_copywriter", "openrouter_model_validator",
  "openrouter_referer",
  "prompt_copywriter", "prompt_extraction", "prompt_rewrite", "prompt_validator",
  "serper_api_key", "serper_daily_limit",
  "groq_api_key",
  "magic_link_base_url",
  "outreach_smtp_host", "outreach_smtp_port", "outreach_smtp_user",
  "outreach_smtp_pass", "outreach_email_from",
  "queue_batch_size", "queue_delay_seconds",
  "log_level",
  "cron_municipality_enabled", "cron_queue_enabled", "cron_draft_enabled", "cron_followup_enabled", "current_campaign_id",
  "max_emails_per_day",
  "guardrail_bounce_rate_max", "guardrail_consecutive_errors_max",
  "guardrail_send_window_start", "guardrail_send_window_end",
  "scraper_allowed_domains",
  "wizard_completed",
  "default_firma_testo", "default_firma_html",
  "default_html_wrapper",
  "default_footer_text", "default_footer_html",
  "test_mode",
  "funnel_alert_enabled", "funnel_alert_open_rate_min", "funnel_alert_reply_rate_min",
  "funnel_alert_stuck_days",
]);

export async function setSetting(key, value, userId) {
  if (!ALLOWED_SETTING_KEYS.has(key)) {
    throw new Error(`Chiave settings non consentita: ${key}`);
  }
  await query(
    `INSERT INTO settings (key, value, updated_at, updated_by)
     VALUES ($1, $2, NOW(), $3)
     ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW(), updated_by = $3`,
    [key, value, userId]
  );
  cache[key] = value;
  lastLoad = 0;
}
