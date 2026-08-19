import { query } from "../db.js";
import { getSetting } from "./settings.js";
import { logger } from "./logger.js";

// ─────────────────────────────────────────────────────────────────────────
// Modalità test per tenant (requisito 7, vedi SPEC-MULTITENANT-FUNNEL.md
// nella cartella padre del progetto): se attiva, OGNI invio reale viene
// deviato verso uno dei `test_recipients` — mai verso il destinatario
// normale. Se non è configurato nessun destinatario di test, l'invio viene
// bloccato: nessuna via di mezzo è ammessa. `resolveTestRecipient` è la
// barriera finale, usata da src/services/email-sender.js prima di ogni
// `transporter.sendMail`.
// ─────────────────────────────────────────────────────────────────────────

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isTestModeEnabled() {
  const v = getSetting("test_mode");
  return v === true || v === "true";
}

export async function listTestRecipients() {
  const r = await query(
    "SELECT id, email, note, created_at FROM test_recipients ORDER BY created_at ASC"
  );
  return r.rows;
}

export async function addTestRecipient(email, note, userId, tenantId) {
  if (!tenantId) {
    throw new TypeError("tenantId is required (multi-tenant is now mandatory)");
  }
  const normalized = String(email || "").trim().toLowerCase();
  if (!normalized || !EMAIL_RE.test(normalized)) {
    throw new Error("Email destinatario di test non valida");
  }
  const r = await query(
    `INSERT INTO test_recipients (email, note, created_by, tenant_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (tenant_id, LOWER(email))
     DO UPDATE SET note = COALESCE($2, test_recipients.note)
     RETURNING id, email, note, created_at`,
    [normalized, note || null, userId || null, tenantId]
  );
  return r.rows[0];
}

export async function removeTestRecipient(id) {
  const r = await query("DELETE FROM test_recipients WHERE id = $1 RETURNING id", [id]);
  return r.rows.length > 0;
}

// Risolve il destinatario EFFETTIVO di un invio. Se test_mode è disattivo,
// nessuna deviazione. Se è attivo (globale OR per-tenant): devia sempre verso un
// destinatario di test, o blocca se non ce n'è nessuno — mai `to: realEmail` in modalità test.
// tenantId è opzionale; se presente, consulta isTenantTestMode per il tenant.
export async function resolveTestRecipient(realEmail, tenantId = null) {
  const globalTestMode = isTestModeEnabled();
  let tenantTestMode = false;

  if (tenantId) {
    try {
      const { isTenantTestMode } = await import("./tenants.js");
      tenantTestMode = await isTenantTestMode(tenantId);
    } catch (err) {
      logger.error("resolveTestRecipient: errore verifica tenant.test_mode", { tenantId, error: err.message });
      tenantTestMode = false;
    }
  }

  const testModeActive = globalTestMode || tenantTestMode;
  if (!testModeActive) {
    return { to: realEmail, testMode: false, diverted: false, blocked: false };
  }

  const recipients = await listTestRecipients();
  if (recipients.length === 0) {
    logger.warn("test_mode attivo senza destinatari di test configurati: invio bloccato", { realEmail, tenantId });
    return { to: null, testMode: true, diverted: true, blocked: true, realEmail };
  }
  const to = recipients[0].email;
  logger.info("test_mode attivo: invio deviato verso destinatario di test", { realEmail, to, tenantId, globalTestMode, tenantTestMode });
  return { to, testMode: true, diverted: true, blocked: false, realEmail };
}
