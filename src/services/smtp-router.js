import { query } from "../db.js";
import { logger } from "./logger.js";

export async function getSmtpForCampaign(campaignId) {
  if (campaignId) {
    // Tentativo account dedicato — incrementa sent_today atomicamente.
    // Sistema internal (cron); campagna è filtrata per ID specifico, quindi tenant-scoped indirettamente.
    const r = await query(
      `UPDATE smtp_accounts sa SET sent_today = sent_today + 1
       FROM campaigns c WHERE c.smtp_account_id = sa.id AND c.id = $1 AND sa.is_active = true
         AND sa.sent_today < sa.daily_limit
       RETURNING sa.*`,
      [campaignId]
    );
    if (r.rows[0]) return r.rows[0];
  }
  // Fallback al round-robin globale (già incrementa sent_today)
  return getNextSmtpAccount();
}

export async function getNextSmtpAccount() {
  // Round-robin globale di sistema: seleziona account indipendente da tenant per bilanciamento carico.
  // Scoping NON applicato: è una selezione system-wide, non per tenant specifico.
  // Apply warming plan before selecting account
  await query(`
    UPDATE smtp_accounts
    SET daily_limit = GREATEST(1, LEAST(
      COALESCE(warming_max_limit, 50),
      COALESCE(warming_start_limit, warming_max_limit, 50) + warming_increment * (CURRENT_DATE - warming_start_date)::int
    ))
    WHERE warming_enabled = true
      AND warming_start_date IS NOT NULL
      AND CURRENT_DATE >= warming_start_date
      AND daily_limit < warming_max_limit
  `).catch(e => console.error("Warming plan update error", e));

  const countResult = await query("SELECT COUNT(*)::int AS cnt FROM smtp_accounts WHERE is_active = true");
  const totalActive = Math.max(countResult.rows[0]?.cnt || 1, 1);
  const result = await query(
    `UPDATE smtp_accounts
     SET rr_position = (rr_position + 1) % $1, sent_today = sent_today + 1
     WHERE id = (
       SELECT id FROM smtp_accounts
       WHERE is_active = true AND sent_today < daily_limit
       ORDER BY rr_position LIMIT 1
       FOR UPDATE SKIP LOCKED
     )
     RETURNING *`,
    [totalActive]
  );
  return result.rows[0] || null;
}

export async function markBounce(accountId) {
  // Sistema internal; legge tenant_id dell'account e applica scope
  const acc = await query("SELECT tenant_id FROM smtp_accounts WHERE id = $1", [accountId]);
  if (!acc.rows[0]) return;
  const tenantId = acc.rows[0].tenant_id;
  await query(
    "UPDATE smtp_accounts SET bounce_count = COALESCE(bounce_count, 0) + 1 WHERE id = $1 AND tenant_id =$2)",
    [accountId, tenantId]
  );
}

export async function resetDailyCounts() {
  // Cron giornaliero globale: reset dei conteggi daily su tutti gli account attivi.
  // Scoping NON applicato: operazione system-wide indipendente da tenant.
  await query("UPDATE smtp_accounts SET sent_today = 0 WHERE is_active = true");
  logger.info("SMTP daily counts reset");
}
