import { query } from "../db.js";
import { getSetting } from "./settings.js";
import { auditInvioRegola } from "./audit.js";

let cache = null;
let cacheTime = 0;
const CACHE_MS = 60000;
export function clearScheduleCache() { cache = null; cacheTime = 0; }

async function getSchedule() {
  if (cache && Date.now() - cacheTime < CACHE_MS) return cache;
  try {
    const result = await query("SELECT dow, hour FROM send_schedule WHERE allowed = true");
    cache = result.rows;
    cacheTime = Date.now();
    return cache;
  } catch {
    return [];
  }
}

/**
 * Contesto di invio (freddi vs consensati) applicato dalla logica di programma/orari.
 * - 'automatic' = campagne/sequenze programmate: riservate ai SOLO consent_status='marketing'.
 * - 'manual'    = invio one-to-one esplicito: ammette anche i 'cold'.
 */
export const SEND_CONTEXT = { AUTOMATIC: "automatic", MANUAL: "manual" };

/**
 * Risolve il contesto di invio di un elemento estratto dalla coda programmata.
 * Default 'automatic': un contatto cold resta quindi escluso da ogni folle
 * automatica programmata; il contesto 'manual' viene marcato esplicitamente dal
 * flusso one-to-one (companies /send).
 */
export function resolveSendContext({ send_context, consent_status } = {}) {
  const status = consent_status || "cold";
  const context = send_context === SEND_CONTEXT.MANUAL
    ? SEND_CONTEXT.MANUAL
    : SEND_CONTEXT.AUTOMATIC;
  return { context, consent_status: status };
}

/**
 * Gate di schedulazione freddi-vs-consensati (condizione FREDDI/CONSENSATI in send-schedule).
 * Applicato PRIMA che un elemento della coda programmata venga inviato:
 *  - 'automatic' → ammette SOLO 'marketing' (il cold non entra mai in folle automatiche)
 *  - 'manual'    → ammette anche 'cold' (flusso one-to-one esplicito)
 */
export function enforceSchedulingConsent({ consent_status, context = SEND_CONTEXT.AUTOMATIC, companyId = null, campaignId = null } = {}) {
  const status = consent_status || "cold";
  let admitted, reason;
  if (status === "marketing") { admitted = true; reason = "consenso marketing presente"; }
  else if (context === SEND_CONTEXT.MANUAL) { admitted = true; reason = "cold in flusso one-to-one manuale"; }
  else { admitted = false; reason = "cold in folle/schedulazione automatica non ammesso"; }
  // Audit 'invio_regola' della gate di schedulazione (motivo ammissione/restrizione).
  auditInvioRegola({
    companyId, campaignId, consentStatus: status,
    context: "schedule:" + context, admitted, reason,
  });
  return { ok: admitted, status, context, reason };
}

/**
 * Stato del budget giornaliero CONVISO (marketing + cold one-to-one consumano lo
 * stesso contatore globale), così il cold non può aggirare il limite 'max_emails_per_day'.
 */
export async function getDailyDispatchState() {
  const rawMax = getSetting("max_emails_per_day");
  const maxDaily = (rawMax !== null && rawMax !== undefined && rawMax !== "")
    ? parseInt(rawMax, 10) : 500;
  const result = await query(
    "SELECT COUNT(*)::int AS sent FROM companies WHERE inviato_at >= ((NOW() AT TIME ZONE 'Europe/Rome')::date) AT TIME ZONE 'Europe/Rome'"
  );
  return { sentToday: result.rows[0]?.sent || 0, maxDaily };
}

/** true quando il limite giornaliero globale (condiviso) è stato raggiunto/non aggirabile dal cold. */
export function isDailyCapReached(state) {
  if (!state) return false;
  return state.maxDaily > 0 && state.sentToday >= state.maxDaily;
}

export async function isWithinSendWindow() {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Rome',
    hour: 'numeric',
    hour12: false,
    weekday: 'short',
  });
  const parts = formatter.formatToParts(now);
  const hour = parseInt(parts.find(p => p.type === 'hour')?.value || '0', 10);
  const dowMap = { 'sun': 0, 'mon': 1, 'tue': 2, 'wed': 3, 'thu': 4, 'fri': 5, 'sat': 6 };
  const weekdayLabel = (parts.find(p => p.type === 'weekday')?.value?.toLowerCase() || 'sun').replace(/\.$/, '');
  const dow = dowMap[weekdayLabel] !== undefined ? dowMap[weekdayLabel] : 0;
  const schedule = await getSchedule();
  const allowed = schedule.some(s => s.dow === dow && s.hour === hour);
  return {
    allowed,
    reason: allowed ? null : `Fuori finestra (giorno ${dow}, ora ${hour})`
  };
}
