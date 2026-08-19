import { query, scopeTenant } from "../db.js";

// ─────────────────────────────────────────────────────────────────────────
// Metriche di funnel B2B (requisito 10, vedi SPEC-MULTITENANT-FUNNEL.md nella
// cartella padre del progetto): conteggi per stadio + tassi di conversione
// tra stadi + metriche email (inviate/aperte/click/risposte) + esiti
// chiamata/booking. Usato sia dalla rotta agent GET /api/agent/funnel-metrics
// sia dal controllo alert automatizzato (src/services/funnel-alerts.js) — una
// sola query, nessuna logica duplicata. Fase 4: per-tenant (se tenantId
// fornito, scopa a quel tenant; null/undefined → comportamento invariato).
// ─────────────────────────────────────────────────────────────────────────

// Ordine del funnel outreach (vedi AGENT.md → "Funnel B2B lato outreach").
// "lost" è terminale ma non ordinato: può accadere da qualunque stadio, viene
// tracciato a parte e mai incluso nei conteggi "cumulativi raggiunti".
export const FUNNEL_ORDER = ["prospect", "contacted", "called", "booked", "demo", "won"];

function pct(num, den) {
  if (!den) return null;
  return Math.round((num / den) * 10000) / 100; // 2 decimali
}

export async function computeFunnelMetrics({ campaignId = null, stuckDays = 14, tenantId = null } = {}) {
  const params = [];
  let campaignFilter = "";
  if (campaignId) {
    params.push(campaignId);
    campaignFilter = ` AND campaign_id = $${params.length}`;
  }

  const tenantScope = scopeTenant(tenantId, params.length + 1);
  const tenantFilter = tenantScope.condition;
  params.push(...tenantScope.values);

  const stageResult = await query(
    `SELECT funnel_stage, COUNT(*)::int AS count FROM companies WHERE 1=1${campaignFilter}${tenantFilter} GROUP BY funnel_stage`,
    params
  );
  const byStage = {};
  for (const row of stageResult.rows) byStage[row.funnel_stage] = row.count;
  const lostCount = byStage.lost || 0;

  // Conteggi cumulativi ("quanti prospect hanno raggiunto almeno questo stadio"):
  // funnel_stage non retrocede mai (vedi agent.js), quindi la posizione corrente
  // è un buon proxy di "raggiunto". "lost" è escluso dal cumulo (esce dal funnel).
  const reached = {};
  for (let i = 0; i < FUNNEL_ORDER.length; i++) {
    let sum = 0;
    for (let j = i; j < FUNNEL_ORDER.length; j++) sum += byStage[FUNNEL_ORDER[j]] || 0;
    reached[FUNNEL_ORDER[i]] = sum;
  }

  const conversions = {};
  for (let i = 0; i < FUNNEL_ORDER.length - 1; i++) {
    const from = FUNNEL_ORDER[i];
    const to = FUNNEL_ORDER[i + 1];
    conversions[`${from}_to_${to}_rate`] = pct(reached[to], reached[from]);
  }

  const emailResult = await query(
    `SELECT COUNT(*) FILTER (WHERE inviato)::int AS inviate,
            COUNT(*) FILTER (WHERE email_opened_at IS NOT NULL)::int AS aperte,
            COUNT(*) FILTER (WHERE email_clicked_at IS NOT NULL)::int AS cliccate,
            COUNT(*) FILTER (WHERE email_bounced)::int AS bounced,
            COUNT(*) FILTER (WHERE has_replied)::int AS risposte
     FROM companies WHERE 1=1${campaignFilter}${tenantFilter}`,
    params
  );
  const email = emailResult.rows[0];

  const callResult = await query(
    `SELECT call_status, COUNT(*)::int AS count FROM companies
     WHERE call_status IS NOT NULL${campaignFilter}${tenantFilter} GROUP BY call_status`,
    params
  );
  const byCallStatus = {};
  for (const row of callResult.rows) byCallStatus[row.call_status] = row.count;

  const bookingResult = await query(
    `SELECT booking_status, COUNT(*)::int AS count FROM companies
     WHERE booking_status IS NOT NULL${campaignFilter}${tenantFilter} GROUP BY booking_status`,
    params
  );
  const byBookingStatus = {};
  for (const row of bookingResult.rows) byBookingStatus[row.booking_status] = row.count;

  const stuckParams = [...params, stuckDays];
  const stuckWhere = `funnel_stage NOT IN ('won', 'lost')${campaignFilter}${tenantFilter}
       AND updated_at < NOW() - ($${stuckParams.length}::text || ' days')::interval`;
  const [stuckCountResult, stuckSampleResult] = await Promise.all([
    query(`SELECT COUNT(*)::int AS count FROM companies WHERE ${stuckWhere}`, stuckParams),
    query(
      `SELECT id, title, email, funnel_stage, updated_at FROM companies
       WHERE ${stuckWhere} ORDER BY updated_at ASC LIMIT 50`,
      stuckParams
    ),
  ]);

  return {
    stages: {
      counts: {
        prospect: byStage.prospect || 0,
        contacted: byStage.contacted || 0,
        called: byStage.called || 0,
        booked: byStage.booked || 0,
        demo: byStage.demo || 0,
        won: byStage.won || 0,
        lost: lostCount,
      },
      reached_cumulative: reached,
      conversion_rates: conversions,
    },
    email: {
      inviate: email.inviate,
      aperte: email.aperte,
      cliccate: email.cliccate,
      bounced: email.bounced,
      risposte: email.risposte,
      open_rate: pct(email.aperte, email.inviate),
      click_rate: pct(email.cliccate, email.aperte),
      reply_rate: pct(email.risposte, email.inviate),
      bounce_rate: pct(email.bounced, email.inviate),
    },
    call_outcomes: byCallStatus,
    booking_outcomes: byBookingStatus,
    stuck: {
      threshold_days: stuckDays,
      count: stuckCountResult.rows[0].count,
      sample: stuckSampleResult.rows,
    },
  };
}
