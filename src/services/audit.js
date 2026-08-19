import { query } from "../db.js";
import { logger } from "./logger.js";

export async function audit(userId, action, resource, resourceId = null, details = null, req = null) {
  try {
    const forwarded = req?.headers?.['x-forwarded-for'];
    const ipAddress = req?.ip || (forwarded ? forwarded.split(',')[0].trim() : null);
    await query(
      `INSERT INTO audit_log (user_id, action, resource, resource_id, details, ip_address)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [userId, action, resource, resourceId, details ? JSON.stringify(details) : null, ipAddress]
    );
  } catch (err) {
    logger.error("Audit log error", { action, resource, error: err.message });
  }
}

// Route files che usano ancora query inline invece di audit():
// routes/direzione.js, routes/municipalities.js, routes/followup-sequences.js,
// routes/companies.js, routes/scraper.js, routes/auth.js,
// routes/settings.js, routes/cron.js, services/csv-importer.js

/**
 * Audit strutturato "invio_regola" (§ compliance freddi-vs-consensati).
 * Per ogni invio (o tentativo di invio) registra il motivo di AMMISSIONE o di
 * RESTRIZIONE (cold vs marketing) in base al consent_status e al contesto
 * (automatic = campagne/sequenze riservate ai marketing; manual = one-to-one
 * che ammette anche i cold). Best-effort e NON bloccante: un errore di audit
 * non deve mai far fallire l'invio.
 *
 * Output: log strutturato con chiave `invio_regola` + riga persistita su
 * `audit_log` (action='invio_regola', resource='email', resource_id=azienda)
 * per trace verbality/compliance.
 */
export function auditInvioRegola({
  companyId = null,
  queueId = null,
  campaignId = null,
  trackingId = null,
  consentStatus = "cold",
  context = "automatic",
  admitted = false,
  reason = "",
}) {
  const details = {
    invio_regola: true,
    consent_status: consentStatus,
    context,
    admitted,
    reason,
    campaign_id: campaignId,
    queue_id: queueId,
    tracking_id: trackingId,
  };
  (admitted ? logger.info : logger.warn)("invio_regola", details);
  query(
    `INSERT INTO audit_log (user_id, action, resource, resource_id, details)
     VALUES (NULL, 'invio_regola', 'email', $1, $2)`,
    [companyId, JSON.stringify(details)]
  ).catch(err => logger.warn("Audit invio_regola persist fallito", { companyId, error: err.message }));
}
