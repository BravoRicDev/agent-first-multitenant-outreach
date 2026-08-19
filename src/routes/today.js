import { Router } from "express";
import { query } from "../db.js";
import { logger } from "../services/logger.js";
import { requireAuth, requireAdmin } from "../middleware/auth.js";

const router = Router();
router.use(requireAuth);
router.use(requireAdmin);

// ── Pagina "Oggi" ──
router.get("/today", async (req, res) => {
  try {
    res.render("today", { user: req.user });
  } catch (err) {
    logger.error("Today page error", { error: err.message });
    res.status(500).render("error", {messageKey: "error.load_page" });
  }
});

// ── API stats per la bacheca oggi ──
router.get("/api/today/stats", async (req, res) => {
  try {
    const [
      inviateOggi,
      inCoda,
      aperteOggi,
      cliccateOggi,
      falliteOggi,
      bounced,
      daApprovare,
      followupInAttesa,
      aziendeNuoviOggi,
      aziendeFalliti,
      risposte,
      cronStatus,
      inviiPerCampagna,
      campagnaAttiva,
    ] = await Promise.all([
      // Email inviate oggi
      query(`SELECT COUNT(*)::int AS count FROM companies WHERE inviato_at >= CURRENT_DATE`),

      // In coda (pending/sending)
      query(`SELECT COUNT(*)::int AS count FROM email_queue WHERE status IN ('pending','sending')`),

      // Aperte oggi
      query(`SELECT COUNT(*)::int AS count FROM email_events WHERE event_type = 'open' AND occurred_at >= CURRENT_DATE`),

      // Cliccate oggi
      query(`SELECT COUNT(*)::int AS count FROM email_events WHERE event_type = 'click' AND occurred_at >= CURRENT_DATE`),

      // Fallite oggi
      query(`SELECT COUNT(*)::int AS count FROM email_queue_failed WHERE created_at >= CURRENT_DATE`),

      // Bounced totali
      query(`SELECT COUNT(*)::int AS count FROM companies WHERE email_bounced = true`),

      // Da approvare (con bozza, non ancora approvati, non ancora inviati)
      query(`SELECT COUNT(*)::int AS count FROM companies WHERE bozza_creata = true AND (approvato IS NULL OR approvato = false) AND (inviato IS NULL OR inviato = false)`),

      // Followup schedulati (prossimi 7 giorni)
      query(`SELECT COUNT(*)::int AS count FROM email_sequences WHERE sent_at IS NULL AND cancelled_at IS NULL AND scheduled_at <= NOW() + INTERVAL '7 days'`),

      // Aziende nuovi oggi (importati/scaricati oggi)
      query(`SELECT COUNT(*)::int AS count FROM companies WHERE created_at >= CURRENT_DATE`),

      // Aziende con fallimenti oggi (nome + ultimo errore)
      query(`SELECT d.id, d.nome_studio, d.email,
              (SELECT eqf.error FROM email_queue_failed eqf WHERE eqf.company_id = d.id ORDER BY eqf.created_at DESC LIMIT 1) AS last_error,
              COUNT(eqf.id)::int AS tentativi
             FROM companies d
             JOIN email_queue_failed eqf ON eqf.company_id = d.id
             WHERE eqf.created_at >= CURRENT_DATE
             GROUP BY d.id, d.nome_studio, d.email
             ORDER BY MAX(eqf.created_at) DESC
             LIMIT 10`),

      // Ultime risposte ricevute
      query(`SELECT id, nome_studio, has_replied, replied_at, reply_subject FROM companies WHERE has_replied = true ORDER BY replied_at DESC NULLS LAST LIMIT 10`),

      // Stato cron job
      query(`SELECT name, last_run_at, last_duration_seconds, last_error FROM cron_status ORDER BY last_run_at DESC NULLS LAST`),

      // Email inviate oggi raggruppate per campagna
      query(`SELECT c.id, c.name, COUNT(d.id)::int AS count FROM companies d JOIN campaigns c ON c.id = d.campaign_id WHERE d.inviato_at >= CURRENT_DATE GROUP BY c.id, c.name ORDER BY count DESC`),

      // Campagna attiva corrente
      query(`SELECT id, name FROM campaigns WHERE is_active = true ORDER BY created_at DESC LIMIT 1`),
    ]);

    // Calcola totali
    const sentToday = inviateOggi.rows[0]?.count || 0;
    const pending = inCoda.rows[0]?.count || 0;
    const totalPlanned = sentToday + pending; // stimato
    const progressPct = totalPlanned > 0 ? Math.round((sentToday / totalPlanned) * 100) : 0;

    // Semaforo: verde = tutto ok, giallo = qualche alert, rosso = problemi
    const failedToday = falliteOggi.rows[0]?.count || 0;
    const bouncedCount = bounced.rows[0]?.count || 0;
    const pendingApproval = daApprovare.rows[0]?.count || 0;
    let semaphore = "green";
    if (failedToday > 5 || bouncedCount > 20) {
      semaphore = "red";
    } else if (failedToday > 0 || pendingApproval > 20 || bouncedCount > 10) {
      semaphore = "yellow";
    }

    // Prepara alert
    const alerts = [];
    if (failedToday > 0) {
      alerts.push({ type: "danger", icon: "❌", text: `${failedToday} email non sono state consegnate oggi` });
    }
    if (pendingApproval > 0) {
      alerts.push({ type: "warning", icon: "⏳", text: `${pendingApproval} bozze da approvare` });
    }
    if (bouncedCount > 10) {
      alerts.push({ type: "warning", icon: "⚠️", text: `${bouncedCount} indirizzi email non validi (bounced)` });
    }

    // Timestamp ultimo aggiornamento
    const lastCronRun = cronStatus.rows.find(r => r.name === 'emailQueue')?.last_run_at ||
                         cronStatus.rows[0]?.last_run_at || null;

    res.json({
      today: {
        inviate: sentToday,
        inCoda: pending,
        totaliPianificati: totalPlanned,
        progresso: progressPct,
        aperte: aperteOggi.rows[0]?.count || 0,
        cliccate: cliccateOggi.rows[0]?.count || 0,
        fallite: failedToday,
        bounced: bouncedCount,
        daApprovare: pendingApproval,
        followup: followupInAttesa.rows[0]?.count || 0,
        nuoviAziende: aziendeNuoviOggi.rows[0]?.count || 0,
      },
      semaphore,
      alerts,
      ultimeRisposte: risposte.rows.map(r => ({
        id: r.id,
        nomeStudio: r.nome_studio,
        repliedAt: r.replied_at,
        oggetto: r.reply_subject,
      })),
      inviiPerCampagna: inviiPerCampagna.rows.map(r => ({
        id: r.id,
        nome: r.name,
        count: r.count,
      })),
      aziendeFalliti: aziendeFalliti.rows.map(r => ({
        id: r.id,
        nomeStudio: r.nome_studio,
        email: r.email,
        ultimoErrore: r.last_error,
        tentativi: r.tentativi,
      })),
      campagnaAttiva: campagnaAttiva.rows[0] || null,
      cronJobs: cronStatus.rows.map(r => ({
        nome: r.name,
        ultimaEsecuzione: r.last_run_at,
        durata: r.last_duration_seconds,
        errore: r.last_error,
      })),
      oraAggiornamento: new Date().toISOString(),
    });
  } catch (err) {
    logger.error("Today API error", { error: err.message, stack: err.stack });
    res.status(500).json({ error: "Errore caricamento statistiche" });
  }
});

export default router;
