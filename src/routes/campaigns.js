import { Router } from "express";
import { query, transaction } from "../db.js";
import config from "../config.js";
import { getSetting } from "../services/settings.js";
import { requireAuth, requireAdmin } from "../middleware/auth.js";
import { logger } from "../services/logger.js";
import { withLock } from "../services/locks.js";
import { processEmailQueue } from "./cron.js";
import { validate } from "../middleware/validate.js";
import { campaignBatchSchema } from "../validations/schemas.js";
import { getPipelines } from "../services/cms.js";

const router = Router();

router.use(requireAuth);
router.use(requireAdmin);

router.get("/campaigns", async (req, res) => {
  try {
    const result = await query(
      `SELECT c.id, c.name, c.created_at,
              sa.name AS smtp_name, sa.from_email AS smtp_from,
              COUNT(d.id) FILTER (WHERE d.inviato) AS inviate,
              COUNT(d.id) FILTER (WHERE d.email_opened_at IS NOT NULL) AS aperte,
              COUNT(d.id) FILTER (WHERE d.email_clicked_at IS NOT NULL) AS cliccate,
              COUNT(d.id) FILTER (WHERE d.email_bounced) AS bounced
       FROM campaigns c
       LEFT JOIN companies d ON d.campaign_id = c.id
       LEFT JOIN smtp_accounts sa ON sa.id = c.smtp_account_id
        GROUP BY c.id, sa.name, sa.from_email ORDER BY c.created_at DESC`
    );
    res.render("campaigns/index", { campaigns: result.rows });
  } catch (err) {
    logger.error("Campaigns list error", { error: err.message });
    res.status(500).render("error", {messageKey: "error.load_campaigns" });
  }
});

router.post("/api/campaigns/send-batch", validate(campaignBatchSchema), async (req, res) => {
  try {
    const { provincia, limit: batchLimit, delay_seconds: delaySec } = req.body;

    const maxPerDay = parseInt(getSetting("max_emails_per_day") || "500", 10);
    const todayCount = await query("SELECT COUNT(*)::int FROM companies WHERE inviato_at >= ((NOW() AT TIME ZONE 'Europe/Rome')::date) AT TIME ZONE 'Europe/Rome'");
    if (todayCount.rows[0].count >= maxPerDay) {
      return res.status(429).json({ error: `Limite giornaliero raggiunto (${maxPerDay})` });
    }

    const conditions = ["approvato = true AND (inviato = false OR inviato IS NULL) AND bozza_creata = true AND consent_status = 'marketing' AND unsubscribed_at IS NULL"];
    const params = [];
    let idx = 1;
    if (provincia) {
      conditions.push(`provincia = $${idx++}`);
      params.push(provincia);
    }
    conditions.push(`tenant_id = $${idx++}`);
    params.push(req.user.tenant_id);

    const companies = await query(
      `SELECT id FROM companies WHERE ${conditions.join(" AND ")} ORDER BY id LIMIT $${idx}`,
      [...params, batchLimit]
    );

    if (companies.rows.length === 0) {
      return res.json({ queued: 0, message: "Nessun azienda da processare" });
    }

    const allParams = companies.rows.map(d => d.id);
    allParams.push(provincia || null);
    allParams.push(req.user.tenant_id || null);
    const placeholders = companies.rows.map((_, i) => `($${i + 1}, $${companies.rows.length + 1}, 'pending', $${companies.rows.length + 2})`).join(", ");

    const result = await query(
      `INSERT INTO email_queue (company_id, provincia, status, tenant_id) VALUES ${placeholders}
       ON CONFLICT (company_id) WHERE status IN ('pending', 'sending') DO NOTHING`,
      allParams
    );

    const { processEmailQueue } = await import("./cron.js");
    const lockOk = await withLock("emailQueue", () => processEmailQueue(delaySec || undefined), 300);
    if (!lockOk) {
      logger.warn("Batch send: coda già in elaborazione, email accodate");
    }

    res.json({ queued: result.rowCount });
  } catch (err) {
    logger.error("Send batch error", { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

router.get("/api/campaigns/progress", async (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  const anchor = await query(
    `SELECT COALESCE(
              MIN(created_at) FILTER (WHERE status IN ('pending','sending')),
              NOW() - INTERVAL '10 minutes'
            ) AS t
     FROM email_queue`
  );
  let batchStartTime = new Date(anchor.rows[0].t.getTime() - 1000).toISOString();

  const emptyCheck = await query("SELECT COUNT(*)::int FROM email_queue WHERE created_at > $1::timestamptz", [batchStartTime]);
  if (emptyCheck.rows[0].count === 0) {
    res.write(`data: {"pending":0,"sent":0,"failed":0}\n\n`);
    res.write("event: done\ndata: {}\n\n");
    res.end();
    return;
  }

  const maxTimeout = setTimeout(() => {
    clearInterval(interval);
    if (!res.writableEnded) res.end();
  }, 10 * 60 * 1000);

  const interval = setInterval(async () => {
    try {
      const result = await query(
        `SELECT
          COUNT(*) FILTER (WHERE status = 'pending')::int AS pending,
          COUNT(*) FILTER (WHERE status = 'sent')::int AS sent,
          COUNT(*) FILTER (WHERE status = 'failed')::int AS failed
         FROM email_queue
         WHERE created_at > $1::timestamptz`,
        [batchStartTime]
      );
      const row = result.rows[0];
      res.write(`data: ${JSON.stringify(row)}\n\n`);
      if (row.pending === 0) {
        clearInterval(interval);
        clearTimeout(maxTimeout);
        res.write("event: done\ndata: {}\n\n");
        res.end();
      }
    } catch (err) {
      logger.error("SSE polling error", { error: err.message });
      clearInterval(interval);
      clearTimeout(maxTimeout);
      if (!res.writableEnded) res.end();
    }
  }, 2000);

  req.on("close", () => {
    clearInterval(interval);
    clearTimeout(maxTimeout);
  });
});

router.post("/api/campaigns/backfill", requireAuth, requireAdmin, async (req, res) => {
  try {
    const { campaign_id } = req.body;
    if (!campaign_id) return res.status(400).json({ error: "campaign_id richiesto" });
    const campaignId = parseInt(campaign_id, 10);
    const result = await query(
      "UPDATE companies SET campaign_id = $1 WHERE campaign_id IS NULL AND tenant_id =$2)",
      [campaignId, req.user.tenant_id || null]
    );
    res.json({ updated: result.rowCount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// View routes
router.get("/campaigns/new", async (req, res) => {
  try {
    const [cmsPipelines, smtpAccounts] = await Promise.all([
      getPipelines(config.cmsSiteId).catch(() => []),
      query("SELECT id, name, from_email FROM smtp_accounts WHERE is_active = true ORDER BY name"),
    ]);
    res.render("campaigns/detail", { campaign: null, cmsPipelines, smtpAccounts: smtpAccounts.rows });
  } catch (err) {
    logger.error("Campaign new error", { error: err.message });
    res.status(500).render("error", {messageKey: "error.load_new_campaign" });
  }
});

router.get("/campaigns/:id(\\d+)", async (req, res) => {
  try {
    const [camp, cmsPipelines, smtpAccounts, stats] = await Promise.all([
      query("SELECT * FROM campaigns WHERE id = $1", [req.params.id]),
      getPipelines(config.cmsSiteId).catch(() => []),
      query("SELECT id, name, from_email FROM smtp_accounts WHERE is_active = true ORDER BY name"),
      query(`SELECT COUNT(d.id) FILTER (WHERE d.inviato) AS inviate,
                    COUNT(d.id) FILTER (WHERE d.email_opened_at IS NOT NULL) AS aperte,
                    COUNT(d.id) FILTER (WHERE d.email_clicked_at IS NOT NULL) AS cliccate,
                    COUNT(d.id) FILTER (WHERE d.email_bounced) AS bounced
             FROM companies d WHERE d.campaign_id = $1`, [req.params.id])
    ]);
    if (!camp.rows[0]) return res.status(404).render("error", {messageKey: "error.campaign_not_found" });
    const campaign = { ...camp.rows[0], ...stats.rows[0] };
    res.render("campaigns/detail", { campaign, cmsPipelines, smtpAccounts: smtpAccounts.rows });
  } catch (err) {
    logger.error("Campaign detail error", { error: err.message });
    res.status(500).render("error", {messageKey: "error.load_campaign" });
  }
});

// API: create campaign
router.post("/api/campaigns", async (req, res) => {
  try {
    const {
      name, info_azienda, cta, link_cta, email_spunti, email_template,
      cms_pipeline_id, cms_stage_map,
      smtp_account_id, html_wrapper, use_html, footer_text, footer_html,
      from_name_override, from_email_override, reply_to_email, daily_email_limit,
      prompt_copywriter, prompt_rewrite,
      followup_prompt,
    } = req.body;
    if (!name) return res.status(400).json({ error: "Nome campagna richiesto" });
    // Normalizza daily_email_limit: stringa vuota → null (evita errore PostgreSQL)
    const dailyEmailLimit = daily_email_limit !== undefined && daily_email_limit !== null && daily_email_limit !== ''
      ? parseInt(daily_email_limit, 10) : null;
    if (dailyEmailLimit !== null && (isNaN(dailyEmailLimit) || dailyEmailLimit < 0 || dailyEmailLimit > 100000)) {
      return res.status(400).json({ error: "Limite giornaliero non valido" });
    }
    let cmsPipelineId = cms_pipeline_id ? parseInt(cms_pipeline_id, 10) : null;
    if (cmsPipelineId) {
      const pipelines = await getPipelines(config.cmsSiteId).catch(() => []);
      if (!pipelines.some(p => p.id === cmsPipelineId)) {
        return res.status(400).json({ error: "Pipeline CMS non valida per questo sito" });
      }
    }
    const result = await query(
      `INSERT INTO campaigns (
         name, info_azienda, cta, link_cta, email_spunti, email_template,
         cms_pipeline_id, cms_stage_map,
         smtp_account_id, html_wrapper, use_html, footer_text, footer_html,
         from_name_override, from_email_override, reply_to_email, daily_email_limit,
         info_azienda_snapshot, cta_snapshot, template_snapshot,
         prompt_copywriter, prompt_rewrite,
         followup_prompt, tenant_id
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24) RETURNING id`,
      [name, info_azienda||'', cta||'', link_cta||'', email_spunti||'', email_template||'',
       cmsPipelineId, cms_stage_map ? JSON.stringify(cms_stage_map) : '{}',
       smtp_account_id||null, html_wrapper||null, use_html||false, footer_text||null, footer_html||null,
       from_name_override||null, from_email_override||null, reply_to_email||null, dailyEmailLimit,
       info_azienda||'', cta||'', email_template||'',
       prompt_copywriter||null, prompt_rewrite||null,
       followup_prompt||null, req.user.tenant_id || null]
    );
    res.json({ success: true, id: result.rows[0].id });
  } catch (err) {
    logger.error("Campaign create error", { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// API: get single campaign
router.get("/api/campaigns/:id(\\d+)", async (req, res) => {
  try {
    const result = await query("SELECT * FROM campaigns WHERE id = $1", [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({errorKey: "error.campaign_not_found" });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API: update campaign
router.put("/api/campaigns/:id(\\d+)", async (req, res) => {
  try {
    const {
      name, info_azienda, cta, link_cta, email_spunti, email_template,
      cms_pipeline_id, cms_stage_map,
      smtp_account_id, html_wrapper, use_html, footer_text, footer_html,
      from_name_override, from_email_override, reply_to_email, daily_email_limit,
      is_active,
      prompt_copywriter, prompt_rewrite,
      followup_prompt,
    } = req.body;
    // Normalizza daily_email_limit: stringa vuota → null (evita errore PostgreSQL)
    const dailyEmailLimit = daily_email_limit !== undefined && daily_email_limit !== null && daily_email_limit !== ''
      ? parseInt(daily_email_limit, 10) : null;
    const cmsPipelineId = cms_pipeline_id !== undefined && cms_pipeline_id !== null && cms_pipeline_id !== ''
      ? parseInt(cms_pipeline_id, 10) : null;
    await query(
      `UPDATE campaigns SET
         name=$1, info_azienda=$2, cta=$3, link_cta=$4, email_spunti=$5, email_template=$6,
         cms_pipeline_id=COALESCE($7, cms_pipeline_id),
         cms_stage_map=COALESCE($8, cms_stage_map),
         smtp_account_id=COALESCE($9, smtp_account_id),
         html_wrapper=COALESCE($10, html_wrapper),
         use_html=COALESCE($11, use_html),
         footer_text=COALESCE($12, footer_text),
         footer_html=COALESCE($13, footer_html),
         from_name_override=COALESCE($14, from_name_override),
         from_email_override=COALESCE($15, from_email_override),
         reply_to_email=COALESCE($16, reply_to_email),
         daily_email_limit=COALESCE($17, daily_email_limit),
         is_active=COALESCE($18, is_active),
         prompt_copywriter=COALESCE($19, prompt_copywriter),
         prompt_rewrite=COALESCE($20, prompt_rewrite),
         followup_prompt=COALESCE($21, followup_prompt)
       WHERE id=$22 AND tenant_id =$23)`,
      [name, info_azienda||'', cta||'', link_cta||'', email_spunti||'', email_template||'',
       cmsPipelineId, cms_stage_map ? JSON.stringify(cms_stage_map) : null,
       smtp_account_id||null, html_wrapper||null, use_html||false, footer_text||null, footer_html||null,
       from_name_override||null, from_email_override||null, reply_to_email||null, dailyEmailLimit,
       is_active,
       prompt_copywriter||null, prompt_rewrite||null,
       followup_prompt||null,
       req.params.id, req.user.tenant_id || null]
    );
    res.json({ success: true });
  } catch (err) {
    logger.error("Campaign update error", { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// API: campaign health for dashboard
router.get("/api/campaigns/health", async (req, res) => {
  try {
    const result = await query(
      `SELECT c.id, c.name,
         COUNT(d.id) FILTER (WHERE d.inviato) AS inviate,
         COUNT(d.id) FILTER (WHERE d.email_opened_at IS NOT NULL) AS aperte,
         COUNT(d.id) FILTER (WHERE d.email_bounced) AS bounced
       FROM campaigns c LEFT JOIN companies d ON d.campaign_id = c.id
       WHERE c.is_active = true GROUP BY c.id ORDER BY c.created_at DESC LIMIT 10`
    );
    res.json(result.rows);
  } catch (err) {
    logger.error("Campaign health error", { error: err.message });
    res.status(500).json({ error: "Errore interno" });
  }
});

// API: list campaigns (flat, for selects)
router.get("/api/campaigns", async (req, res) => {
  try {
    const { sort, order, search, smtp_id, date_from, date_to } = req.query;
    const allowedSort = ["name", "created_at", "inviate", "aperte", "cliccate", "bounced", "smtp_name"];
    const sortCol = allowedSort.includes(sort) ? sort : "created_at";
    const sortDir = order === "asc" ? "ASC" : "DESC";

    const conditions = [];
    const params = [];
    let idx = 1;

    if (search) {
      conditions.push(`c.name ILIKE $${idx++}`);
      params.push(`%${search}%`);
    }
    if (smtp_id) {
      conditions.push(`c.smtp_account_id = $${idx++}`);
      params.push(parseInt(smtp_id, 10));
    }
    if (date_from) {
      conditions.push(`c.created_at >= $${idx++}`);
      params.push(date_from);
    }
    if (date_to) {
      conditions.push(`c.created_at <= $${idx++}`);
      params.push(date_to + "T23:59:59Z");
    }

    const whereClause = conditions.length > 0 ? "WHERE " + conditions.join(" AND ") : "";

    // Map sort column to ORDER BY expression
    let orderExpr;
    switch (sortCol) {
      case "name": orderExpr = `c.name ${sortDir}`; break;
      case "smtp_name": orderExpr = `sa.name ${sortDir} NULLS LAST`; break;
      case "inviate": orderExpr = `COUNT(d.id) FILTER (WHERE d.inviato) ${sortDir} NULLS LAST`; break;
      case "aperte": orderExpr = `COUNT(d.id) FILTER (WHERE d.email_opened_at IS NOT NULL) ${sortDir} NULLS LAST`; break;
      case "cliccate": orderExpr = `COUNT(d.id) FILTER (WHERE d.email_clicked_at IS NOT NULL) ${sortDir} NULLS LAST`; break;
      case "bounced": orderExpr = `COUNT(d.id) FILTER (WHERE d.email_bounced) ${sortDir} NULLS LAST`; break;
      default: orderExpr = `c.created_at ${sortDir}`;
    }

    const result = await query(
      `SELECT c.id, c.name, c.created_at,
              c.smtp_account_id,
              c.is_active,
              sa.name AS smtp_name, sa.from_email AS smtp_from,
              COUNT(d.id) FILTER (WHERE d.inviato)::int AS inviate,
              COUNT(d.id) FILTER (WHERE d.email_opened_at IS NOT NULL)::int AS aperte,
              COUNT(d.id) FILTER (WHERE d.email_clicked_at IS NOT NULL)::int AS cliccate,
              COUNT(d.id) FILTER (WHERE d.email_bounced)::int AS bounced,
              COUNT(d.id)::int AS totale_aziende
       FROM campaigns c
       LEFT JOIN companies d ON d.campaign_id = c.id
       LEFT JOIN smtp_accounts sa ON sa.id = c.smtp_account_id
       ${whereClause}
       GROUP BY c.id, sa.name, sa.from_email
       ORDER BY ${orderExpr}`
      , params);

    // Also return available SMTP accounts for the filter dropdown
    const smtpAccounts = await query(
      "SELECT id, name, from_email FROM smtp_accounts ORDER BY name"
    );

    res.json({ campaigns: result.rows, smtpAccounts: smtpAccounts.rows });
  } catch (err) {
    logger.error("Campaign list API error", { error: err.message });
    res.status(500).json({ error: "Errore interno" });
  }
});

// API: send batch for a specific campaign
router.post("/api/campaigns/:id(\\d+)/send-batch", async (req, res) => {
  try {
    const { limit = 50, delay_seconds } = req.body;
    const campaignId = parseInt(req.params.id, 10);
    const batchLimit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 1000);

    const maxPerDay = parseInt(getSetting("max_emails_per_day") || "500", 10);
    const todayCount = await query("SELECT COUNT(*)::int FROM companies WHERE inviato_at >= ((NOW() AT TIME ZONE 'Europe/Rome')::date) AT TIME ZONE 'Europe/Rome'");
    if (todayCount.rows[0].count >= maxPerDay) {
      return res.status(429).json({ error: `Limite giornaliero raggiunto (${maxPerDay})` });
    }

    const campRow = await query("SELECT daily_email_limit FROM campaigns WHERE id = $1 AND tenant_id =$2)", [campaignId, req.user.tenant_id || null]);
    const campLimit = campRow.rows[0]?.daily_email_limit || 0;
    if (campLimit > 0) {
      const todayCamp = await query("SELECT COUNT(*)::int FROM companies WHERE campaign_id = $1 AND inviato_at >= ((NOW() AT TIME ZONE 'Europe/Rome')::date) AT TIME ZONE 'Europe/Rome'", [campaignId]);
      if (todayCamp.rows[0].count >= campLimit) return res.status(429).json({ error: `Limite giornaliero campagna raggiunto (${campLimit})` });
    }

    const companies = await query(
      `SELECT id FROM companies WHERE campaign_id = $1
         AND approvato = true AND (inviato = false OR inviato IS NULL) AND bozza_creata = true
         AND consent_status = 'marketing' AND unsubscribed_at IS NULL
         AND tenant_id =$3)
       ORDER BY id LIMIT $2`,
      [campaignId, batchLimit, req.user.tenant_id || null]
    );
    if (!companies.rows.length) return res.json({ queued: 0, message: "Nessun azienda da processare" });
    const placeholders = companies.rows.map((_, i) => `($${i+1}, $${companies.rows.length+1}, 'pending', $${companies.rows.length+2})`).join(", ");
    const params = [...companies.rows.map(d => d.id), campaignId, req.user.tenant_id || null];
    const result = await query(
      `INSERT INTO email_queue (company_id, campaign_id, status, tenant_id) VALUES ${placeholders}
       ON CONFLICT (company_id) WHERE status IN ('pending','sending') DO UPDATE SET campaign_id = EXCLUDED.campaign_id`, params
    );
    const { processEmailQueue } = await import("./cron.js");
    await withLock("emailQueue", () => processEmailQueue(delay_seconds || undefined), 300);
    res.json({ queued: result.rowCount });
  } catch (err) {
    logger.error("Send batch campaign error", { error: err.message });
    res.status(500).json({ error: "Errore interno" });
  }
});

// API: activity log for a campaign

// API: activity log for a campaign
router.get("/api/campaigns/:id(\\d+)/activity", async (req, res) => {
  try {
    const result = await query(
      `SELECT al.created_at, u.name AS user_name, al.action, al.details
       FROM audit_log al LEFT JOIN users u ON u.id = al.user_id
       WHERE al.resource = 'campaigns' AND al.resource_id = $1
       ORDER BY al.created_at DESC LIMIT 20`,
      [req.params.id]
    );
    res.json(result.rows);
  } catch (err) {
    logger.error("Campaign activity error", { error: err.message });
    res.status(500).json({ error: "Errore interno" });
  }
});

// API: clear pending queue items for a campaign
router.delete("/api/admin/queue/campaign/:id(\\d+)", async (req, res) => {
  try {
    const result = await query(
      "DELETE FROM email_queue WHERE campaign_id = $1 AND status = 'pending' AND tenant_id =$2)",
      [req.params.id, req.user.tenant_id || null]
    );
    res.json({ deleted: result.rowCount });
  } catch (err) {
    logger.error("Delete queue campaign error", { error: err.message });
    res.status(500).json({ error: "Errore interno" });
  }
});

// API: send test email for campaign
router.post("/api/campaigns/:id(\\d+)/test-email", async (req, res) => {
  try {
    const { to } = req.body;
    if (!to) return res.status(400).json({ error: "to richiesto" });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return res.status(400).json({ error: "Email destinatario non valida" });
    const camp = await query("SELECT * FROM campaigns WHERE id = $1", [req.params.id]);
    if (!camp.rows[0]) return res.status(404).json({errorKey: "error.campaign_not_found" });
    const c = camp.rows[0];
    const smtpAcc = c.smtp_account_id
      ? (await query("SELECT * FROM smtp_accounts WHERE id = $1", [c.smtp_account_id])).rows[0]
      : (await query("SELECT * FROM smtp_accounts WHERE is_active = true ORDER BY rr_position LIMIT 1")).rows[0];
    if (!smtpAcc) return res.status(400).json({ error: "Nessun account SMTP configurato" });

    const sampleBody = (c.info_azienda || "Testo email di esempio per verifica template e firma.").substring(0, 300);
    let body = sampleBody;
    if (smtpAcc.firma_testo) body += "\n\n" + smtpAcc.firma_testo;

    let html = null;
    if (c.use_html) {
      const wrapper = c.html_wrapper || "<div>{{BODY}}</div>";
      html = wrapper.replace("{{BODY}}", body.replace(/\n/g, "<br>"));
    }

    const { default: nodemailer } = await import("nodemailer");
    const transporter = nodemailer.createTransport({
      host: smtpAcc.smtp_host,
      port: parseInt(smtpAcc.smtp_port, 10) || 587,
      secure: parseInt(smtpAcc.smtp_port, 10) === 465,
      auth: { user: smtpAcc.smtp_user, pass: smtpAcc.smtp_pass },
    });
    await transporter.sendMail({
      from: smtpAcc.from_email || smtpAcc.smtp_user,
      to,
      subject: `[TEST] ${c.name || "Campagna"} — verifica template`,
      html: html || undefined,
      text: html ? undefined : body,
    });
    res.json({ success: true });
  } catch (err) {
    logger.error("Test email error", { error: err.message });
    res.status(500).json({ error: "Errore interno" });
  }
});

// API: campaign pre-launch checklist
router.get("/api/campaigns/:id(\\d+)/checklist", async (req, res) => {
  try {
    const id = req.params.id;
    const [camp, smtp, companies] = await Promise.all([
      query("SELECT c.*, sa.name AS smtp_name, sa.firma_testo FROM campaigns c LEFT JOIN smtp_accounts sa ON sa.id = c.smtp_account_id WHERE c.id = $1", [id]),
      query("SELECT COUNT(*)::int AS c FROM smtp_accounts WHERE is_active = true"),
      query("SELECT COUNT(*) FILTER (WHERE approvato = true AND inviato = false AND bozza_creata = true)::int AS pronti, COUNT(*) FILTER (WHERE bozza_creata = false OR bozza_creata IS NULL)::int AS senza_bozza FROM companies WHERE campaign_id = $1", [id])
    ]);
    const c = camp.rows[0];
    const d = companies.rows[0];
    const hasGlobalFirma = await query("SELECT value FROM settings WHERE key = 'default_firma_testo' AND value IS NOT NULL AND value != ''");
    const checks = [
      { label: "Info Azienda", ok: !!(c?.info_azienda), detail: c?.info_azienda ? "Configurata" : "Manca — l'AI non saprà cosa scrivere" },
      { label: "CTA", ok: !!(c?.cta), detail: c?.cta || "Mancante" },
      { label: "Account SMTP", ok: !!(c?.smtp_name || smtp.rows[0]?.c > 0), detail: c?.smtp_name || "Round-robin globale" },
      { label: "Firma email", ok: !!(c?.firma_testo || hasGlobalFirma.rows[0]?.value), detail: c?.firma_testo ? "Da account SMTP" : "Usa default globale" },
      { label: "Pipeline CMS", ok: !!(c?.cms_pipeline_id), detail: c?.cms_pipeline_id ? `Pipeline #${c.cms_pipeline_id}` : "Non configurata (opzionale)" },
      { label: "Contatti pronti", ok: d?.pronti > 0, detail: `${d?.pronti || 0} approvati, ${d?.senza_bozza || 0} senza bozza` },
      { label: "HTML / Testo", ok: true, detail: c?.use_html ? "Formato HTML" : "Testo piatto" },
      { label: "Footer disiscrizione", ok: !!(c?.footer_text || false), detail: c?.footer_text ? "Configurato" : "Non configurato (usato default)" },
    ];
    res.json(checks);
  } catch (err) {
    logger.error("Campaign checklist error", { error: err.message });
    res.status(500).json({ error: "Errore interno" });
  }
});

// ═══════════════════════════════════════════════════════════════
// CAMPAIGN WORKFLOW — API e vista per gestire aziende per campagna
// ═══════════════════════════════════════════════════════════════

// API: Get companies for a campaign with draft/followup status, pagination, sorting
router.get("/api/campaigns/:id(\\d+)/companies", async (req, res) => {
  try {
    const campaignId = parseInt(req.params.id, 10);
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(1000, Math.max(1, parseInt(req.query.limit, 10) || 200));
    const offset = (page - 1) * limit;

    const sortBy = ["nome_azienda", "nome_studio", "email", "comune", "provincia",
      "bozza_creata", "approvato", "inviato", "email_bounced", "lead_score", "created_at",
      "inviato_at", "followup_pending", "followup_sent", "send_scheduled_at"]
      .includes(req.query.sort_by) ? req.query.sort_by : "nome_studio";
    const sortOrder = req.query.sort_order === "asc" ? "ASC NULLS LAST" : "DESC NULLS LAST";

    const filter = req.query.filter || "all";
    const search = req.query.search || "";

    let conditions = [`d.campaign_id = $1`];
    let params = [campaignId];
    let paramIdx = 2;

    if (filter === "pending") conditions.push(`(d.bozza_creata = false OR d.bozza_creata IS NULL)`);
    else if (filter === "draft") conditions.push(`d.bozza_creata = true AND d.approvato = false AND (d.inviato = false OR d.inviato IS NULL)`);
    else if (filter === "approved") conditions.push(`d.approvato = true AND (d.inviato = false OR d.inviato IS NULL) AND NOT EXISTS (SELECT 1 FROM email_sequences es WHERE es.company_id = d.id AND es.step = 0 AND es.sent_at IS NULL AND es.cancelled_at IS NULL)`);
    else if (filter === "scheduled") conditions.push(`d.approvato = true AND (d.inviato = false OR d.inviato IS NULL) AND EXISTS (SELECT 1 FROM email_sequences es WHERE es.company_id = d.id AND es.step = 0 AND es.sent_at IS NULL AND es.cancelled_at IS NULL)`);
    else if (filter === "sent") conditions.push(`d.inviato = true`);
    else if (filter === "bounced") conditions.push(`d.email_bounced = true`);
    else if (filter === "opened") conditions.push(`d.email_opened_at IS NOT NULL`);
    else if (filter === "failed") conditions.push(`EXISTS (SELECT 1 FROM email_queue_failed eqf WHERE eqf.company_id = d.id)`);
    else if (filter === "noemail") conditions.push(`(d.email IS NULL OR d.email = '')`);

    if (search) {
      conditions.push(`(d.nome_azienda ILIKE $${paramIdx} OR d.nome_studio ILIKE $${paramIdx} OR d.email ILIKE $${paramIdx} OR d.comune ILIKE $${paramIdx} OR d.provincia ILIKE $${paramIdx})`);
      params.push(`%${search}%`);
      paramIdx++;
    }

    const where = conditions.join(" AND ");

    const countResult = await query(`SELECT COUNT(*)::int FROM companies d WHERE ${where}`, params);
    const total = countResult.rows[0].count;

    const result = await query(
      `SELECT d.id, d.nome_studio, d.nome_azienda, d.email, d.provincia, d.comune,
              d.bozza_creata, d.bozza_rifai, d.bozza_email_oggetto, d.bozza_email, d.bozza_failed_count,
              d.approvato, d.inviato, d.inviato_at, d.email_opened_at, d.email_clicked_at,
              d.email_bounced, d.lead_score, d.created_at, d.unsubscribed_at, d.consent_status, d.cms_synced_at,
              d.sent_email_subject,
              (SELECT COUNT(*) FROM email_sequences es WHERE es.company_id = d.id AND es.sent_at IS NULL AND es.cancelled_at IS NULL)::int AS followup_pending,
              (SELECT COUNT(*) FROM email_sequences es WHERE es.company_id = d.id AND es.sent_at IS NOT NULL)::int AS followup_sent,
              (SELECT COUNT(*) FROM company_followup_drafts dfd WHERE dfd.company_id = d.id AND dfd.campaign_id = d.campaign_id AND dfd.approvato = true AND dfd.generato = true)::int AS followup_approved,
              (SELECT COUNT(*) FROM company_followup_drafts dfd WHERE dfd.company_id = d.id AND dfd.campaign_id = d.campaign_id AND dfd.generato = true AND dfd.approvato = false)::int AS followup_draft_pending,
              (SELECT es.scheduled_at FROM email_sequences es WHERE es.company_id = d.id AND es.step = 0 AND es.sent_at IS NULL AND es.cancelled_at IS NULL LIMIT 1) AS send_scheduled_at,
              (SELECT COUNT(*) FROM email_queue_failed eqf WHERE eqf.company_id = d.id)::int AS failed_count,
              (SELECT eqf.error FROM email_queue_failed eqf WHERE eqf.company_id = d.id ORDER BY eqf.created_at DESC LIMIT 1) AS last_error
       FROM companies d
       WHERE ${where}
       ORDER BY ${sortBy} ${sortOrder}
       LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
      [...params, limit, offset]
    );

    // Compute counts for KPI
    const kpi = await query(
      `SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE d.bozza_creata = true)::int AS with_draft,
        COUNT(*) FILTER (WHERE d.approvato = true AND (d.inviato = false OR d.inviato IS NULL))::int AS approved,
        COUNT(*) FILTER (WHERE d.approvato = true AND (d.inviato = false OR d.inviato IS NULL)
          AND EXISTS (SELECT 1 FROM email_sequences es WHERE es.company_id = d.id AND es.step = 0 AND es.sent_at IS NULL AND es.cancelled_at IS NULL)
        )::int AS scheduled,
        COUNT(*) FILTER (WHERE d.inviato = true)::int AS sent,
        COUNT(*) FILTER (WHERE d.email_opened_at IS NOT NULL)::int AS opened,
        COUNT(*) FILTER (WHERE d.email_bounced = true)::int AS bounced,
        COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM email_queue_failed eqf WHERE eqf.company_id = d.id))::int AS failed,
        COUNT(*) FILTER (WHERE d.approvato = true AND (d.inviato = false OR d.inviato IS NULL)
          AND NOT EXISTS (SELECT 1 FROM email_sequences es WHERE es.company_id = d.id AND es.step = 0 AND es.sent_at IS NULL AND es.cancelled_at IS NULL)
        )::int AS approved_not_scheduled,
        COUNT(*) FILTER (WHERE d.approvato = true AND (d.inviato = false OR d.inviato IS NULL)
          AND d.consent_status IS DISTINCT FROM 'marketing'
        )::int AS approved_cold
       FROM companies d WHERE d.campaign_id = $1`, [campaignId]
    );

    // Get SMTP availability
    const smtpCount = (await query("SELECT COUNT(*)::int AS c FROM smtp_accounts WHERE is_active = true")).rows[0].c;

    // Add diagnostic block_reason per company
    const companiesWithDiagnostic = result.rows.map(d => {
      let blockReasons = [];
      if (d.inviato) {
        blockReasons.push("già_inviato");
      } else if (d.unsubscribed_at) {
        blockReasons.push("disiscritto");
      } else if (!d.email) {
        blockReasons.push("email_mancante");
      } else if (!d.bozza_creata) {
        blockReasons.push("bozza_mancante");
      } else if (!d.approvato) {
        blockReasons.push("non_approvato");
      } else if (d.failed_count > 0) {
        blockReasons.push("invio_fallito");
      } else if (d.consent_status !== 'marketing') {
        // Cold: mai in schedulazione/sequenza di massa, solo invio manuale one-to-one
        blockReasons.push("cold_richiede_invio_manuale");
      } else if (!d.send_scheduled_at) {
        blockReasons.push("non_schedulato");
      } else {
        blockReasons.push("pronto");
      }
      if (smtpCount === 0) {
        blockReasons.push("nessun_smtp");
      }
      return { ...d, block_reasons: blockReasons, is_marketing_consented: d.consent_status === 'marketing' };
    });

    res.json({
      companies: companiesWithDiagnostic,
      total,
      page,
      limit,
      pages: Math.ceil(total / limit),
      kpi: { ...kpi.rows[0], smtp_available: smtpCount > 0, smtp_count: smtpCount }
    });
  } catch (err) {
    logger.error("Campaign companies list error", { error: err.message });
    res.status(500).json({errorKey: "error.load_companies" });
  }
});

// API: Add companies to campaign (bulk)
router.post("/api/campaigns/:id(\\d+)/companies", async (req, res) => {
  try {
    const { company_ids } = req.body;
    if (!Array.isArray(company_ids) || company_ids.length === 0) {
      return res.status(400).json({ error: "company_ids richiesto (array)" });
    }
    for (const id of company_ids) {
      if (!Number.isInteger(Number(id))) {
        return res.status(400).json({ error: `ID azienda non valido: ${id}` });
      }
    }
    const campaignId = parseInt(req.params.id, 10);
    const placeholders = company_ids.map((_, i) => `$${i + 2}`).join(", ");
    const result = await query(
      `UPDATE companies SET campaign_id = $1 WHERE id IN (${placeholders}) AND (campaign_id IS NULL OR campaign_id != $1) AND tenant_id =$${2 + company_ids.length})`,
      [campaignId, ...company_ids, req.user.tenant_id || null]
    );
    res.json({ updated: result.rowCount });
  } catch (err) {
    logger.error("Add companies to campaign error", { error: err.message });
    res.status(500).json({ error: "Errore aggiunta aziende" });
  }
});

// API: Remove company from campaign
router.delete("/api/campaigns/:campaignId(\\d+)/companies/:companyId(\\d+)", async (req, res) => {
  try {
    await query("UPDATE companies SET campaign_id = NULL, updated_at = NOW() WHERE id = $1 AND campaign_id = $2 AND tenant_id =$3)",
      [req.params.companyId, req.params.campaignId, req.user.tenant_id || null]);
    res.json({ success: true });
  } catch (err) {
    logger.error("Remove company from campaign error", { error: err.message });
    res.status(500).json({ error: "Errore rimozione azienda" });
  }
});

// API: Generate drafts for all companies in campaign (set bozza_rifai=true)
router.post("/api/campaigns/:id(\\d+)/generate-drafts", async (req, res) => {
  try {
    const campaignId = parseInt(req.params.id, 10);
    // Mark all campaign companies without a draft for regeneration
    // Salta quelli già approvati o inviati per non rischiare di cambiare email approvata
    const updated = await query(
      `UPDATE companies SET bozza_rifai = true, bozza_creata = false, approvato = false, updated_at = NOW()
       WHERE campaign_id = $1
         AND (bozza_creata = false OR bozza_creata IS NULL OR bozza_rifai = true)
         AND (approvato = false OR approvato IS NULL)
         AND (inviato = false OR inviato IS NULL)
         AND tenant_id =$2)
       RETURNING id`,
      [campaignId, req.user.tenant_id || null]
    );
    const company_ids = updated.rows.map(r => r.id);
    // Cancel pending followup sequences for these companies
    if (company_ids.length > 0) {
      const placeholders = company_ids.map((_, i) => `$${i + 1}`).join(", ");
      await query(
        `UPDATE email_sequences SET cancelled_at = NOW(), cancel_reason = 'campaign_regenerated'
         WHERE company_id IN (${placeholders}) AND sent_at IS NULL AND cancelled_at IS NULL`,
        company_ids
      );
      // Trigger async draft generation for ALL companies in this campaign (no LIMIT)
      const { generateEmailDrafts } = await import("./cron.js");
      generateEmailDrafts(company_ids).catch(e => logger.error("Campaign draft generation error", { error: e.message }));
    }
    res.json({ triggered: true, marked: company_ids.length });
  } catch (err) {
    logger.error("Generate drafts for campaign error", { error: err.message });
    res.status(500).json({ error: "Errore generazione bozze" });
  }
});

// API: Approve/unapprove a single company in campaign
router.post("/api/campaigns/:campaignId(\\d+)/companies/:companyId(\\d+)/approve", async (req, res) => {
  try {
    const company = await query(
      "SELECT id, approvato, bozza_creata FROM companies WHERE id = $1 AND campaign_id = $2 AND tenant_id =$3)",
      [req.params.companyId, req.params.campaignId, req.user.tenant_id || null]
    );
    if (!company.rows[0]) return res.status(404).json({ error: "Azienda non trovato in questa campagna" });
    if (!company.rows[0].bozza_creata) return res.status(400).json({ error: "Impossibile approvare: bozza non ancora creata" });
    const newApproved = !company.rows[0].approvato;
    await query("UPDATE companies SET approvato = $1, updated_at = NOW() WHERE id = $2 AND tenant_id =$3)",
      [newApproved, req.params.companyId, req.user.tenant_id || null]);
    res.json({ success: true, approvato: newApproved });
  } catch (err) {
    logger.error("Approve company error", { error: err.message });
    res.status(500).json({ error: "Errore approvazione" });
  }
});

// API: Regenerate draft for a single company (sincrono — aspetta il risultato)
router.post("/api/campaigns/:campaignId(\\d+)/companies/:companyId(\\d+)/regenerate", async (req, res) => {
  try {
    // Controlla che il azienda non sia già approvato o inviato
    const check = await query(
      "SELECT id, approvato, inviato FROM companies WHERE id = $1 AND campaign_id = $2 AND tenant_id =$3)",
      [req.params.companyId, req.params.campaignId, req.user.tenant_id || null]
    );
    if (check.rows.length === 0) return res.status(404).json({errorKey: "error.company_not_found" });
    const dent = check.rows[0];
    if (dent.approvato) return res.status(409).json({ error: "Azienda già approvato. Revoca l'approvazione prima di rigenerare." });
    if (dent.inviato) return res.status(409).json({ error: "Email già inviata a questo azienda. Non può essere rigenerata." });

    await query(
      "UPDATE companies SET bozza_rifai = true, bozza_creata = false, approvato = false, bozza_failed_count = 0, updated_at = NOW() WHERE id = $1 AND campaign_id = $2 AND tenant_id =$3)",
      [req.params.companyId, req.params.campaignId, req.user.tenant_id || null]
    );
    // Cancel pending followups
    await query(
      "UPDATE email_sequences SET cancelled_at = NOW(), cancel_reason = 'regenerated' WHERE company_id = $1 AND sent_at IS NULL AND cancelled_at IS NULL",
      [req.params.companyId]
    );
    // Attendi la generazione AI sincrona
    const { generateEmailDrafts } = await import("./cron.js");
    await generateEmailDrafts([req.params.companyId]);
    // Recupera la bozza generata
    const updated = await query(
      "SELECT id, bozza_email_oggetto, bozza_email, bozza_creata, bozza_failed_count FROM companies WHERE id = $1",
      [req.params.companyId]
    );
    res.json({ success: true, company: updated.rows[0] || null });
  } catch (err) {
    logger.error("Regenerate draft error", { error: err.message });
    res.status(500).json({ error: "Errore rigenerazione" });
  }
});

// API: Send approved companies for this campaign
router.post("/api/campaigns/:id(\\d+)/send-approved", async (req, res) => {
  try {
    const campaignId = parseInt(req.params.id, 10);
    const { limit = 50, delay_seconds } = req.body;
    const batchLimit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 1000);

    const maxPerDay = parseInt(getSetting("max_emails_per_day") || "500", 10);
    const todayCount = await query(
      "SELECT COUNT(*)::int FROM companies WHERE inviato_at >= ((NOW() AT TIME ZONE 'Europe/Rome')::date) AT TIME ZONE 'Europe/Rome'"
    );
    if (todayCount.rows[0].count >= maxPerDay) {
      return res.status(429).json({ error: `Limite giornaliero raggiunto (${maxPerDay})` });
    }

    const campRow = await query("SELECT daily_email_limit FROM campaigns WHERE id = $1 AND tenant_id =$2)", [campaignId, req.user.tenant_id || null]);
    const campLimit = campRow.rows[0]?.daily_email_limit || 0;
    if (campLimit > 0) {
      const todayCamp = await query("SELECT COUNT(*)::int FROM companies WHERE campaign_id = $1 AND inviato_at >= ((NOW() AT TIME ZONE 'Europe/Rome')::date) AT TIME ZONE 'Europe/Rome'", [campaignId]);
      if (todayCamp.rows[0].count >= campLimit) return res.status(429).json({ error: `Limite giornaliero campagna raggiunto (${campLimit})` });
    }

    const companies = await query(
      `SELECT id FROM companies WHERE campaign_id = $1
        AND approvato = true AND (inviato = false OR inviato IS NULL) AND bozza_creata = true
        AND consent_status = 'marketing' AND unsubscribed_at IS NULL
        AND tenant_id =$3)
       ORDER BY id LIMIT $2`,
      [campaignId, batchLimit, req.user.tenant_id || null]
    );
    if (!companies.rows.length) return res.json({ queued: 0, message: "Nessun azienda approvato da inviare" });

    const placeholders = companies.rows.map((_, i) => `($${i + 1}, $${companies.rows.length + 1}, 'pending', $${companies.rows.length + 2})`).join(", ");
    const params = [...companies.rows.map(d => d.id), campaignId, req.user.tenant_id || null];
    await query(
      `INSERT INTO email_queue (company_id, campaign_id, status, tenant_id) VALUES ${placeholders}
       ON CONFLICT (company_id) WHERE status IN ('pending','sending') DO UPDATE SET campaign_id = EXCLUDED.campaign_id`,
      params
    );
    const { processEmailQueue } = await import("./cron.js");
    await withLock("emailQueue", () => processEmailQueue(delay_seconds || undefined), 300);
    res.json({ queued: companies.rows.length });
  } catch (err) {
    logger.error("Send approved campaign error", { error: err.message });
    res.status(500).json({ error: "Errore invio" });
  }
});

// API: Get companies not yet assigned to campaign (for "add" modal)
router.get("/api/campaigns/:id(\\d+)/available-companies", async (req, res) => {
  try {
    const { search, provincia, regione, limit: rawLimit = 500 } = req.query;
    const limit = Math.min(Math.max(parseInt(rawLimit, 10) || 500, 1), 1000);
    const conditions = ["(d.campaign_id IS NULL OR d.campaign_id != $1)"];
    const params = [parseInt(req.params.id, 10)];
    let paramIdx = 2;
    
    if (search) {
      conditions.push(`(d.nome_studio ILIKE $${paramIdx} OR d.title ILIKE $${paramIdx} OR d.nome_azienda ILIKE $${paramIdx} OR d.email ILIKE $${paramIdx} OR d.comune ILIKE $${paramIdx})`);
      params.push(`%${search}%`);
      paramIdx++;
    }
    if (provincia) {
      conditions.push(`d.provincia = $${paramIdx++}`);
      params.push(provincia);
    }
    if (regione) {
      conditions.push(`d.provincia IN (SELECT DISTINCT sigla_provincia FROM municipalities WHERE denominazione_regione = $${paramIdx++})`);
      params.push(regione);
    }
    
    const result = await query(
      `SELECT d.id, d.nome_studio, d.title, d.nome_azienda, d.email, d.comune, d.provincia
       FROM companies d WHERE ${conditions.join(" AND ")}
       ORDER BY d.nome_studio, d.nome_azienda LIMIT $${paramIdx}`,
      [...params, limit]
    );
    res.json(result.rows);
  } catch (err) {
    logger.error("Available companies error", { error: err.message });
    res.status(500).json({errorKey: "error.load_companies" });
  }
});

// API: Export campaign companies as CSV for spreadsheet/Excel
router.get("/api/campaigns/:id(\\d+)/companies/export-csv", async (req, res) => {
  try {
    const campaignId = parseInt(req.params.id, 10);
    const companies = await query(
      `SELECT d.id, d.nome_studio, d.nome_azienda, d.email, d.comune, d.provincia, d.phone_number,
              d.lead_score, d.bozza_creata, d.approvato, d.inviato, d.inviato_at, d.email_opened_at, d.email_bounced,
              d.bozza_email_oggetto, d.created_at
       FROM companies d WHERE d.campaign_id = $1
       ORDER BY d.nome_studio, d.nome_azienda`, [campaignId]
    );

    const header = "ID,Studio,Nome,Email,Città,Provincia,Telefono,Lead Score,Bozza Creata,Approvato,Inviato,Inviato il,Aperta,Bounced,Oggetto,Creato il\n";
    const rows = companies.rows.map(d =>
      `"${d.id}","${(d.nome_studio||'').replace(/"/g,'""')}","${(d.nome_azienda||'').replace(/"/g,'""')}","${(d.email||'').replace(/"/g,'""')}","${(d.comune||'').replace(/"/g,'""')}","${(d.provincia||'').replace(/"/g,'""')}","${(d.phone_number||'').replace(/"/g,'""')}",${d.lead_score??0},${d.bozza_creata?'SI':'NO'},${d.approvato?'SI':'NO'},${d.inviato?'SI':'NO'},"${d.inviato_at?new Date(d.inviato_at).toLocaleDateString('it-IT'):''}",${d.email_opened_at?'SI':'NO'},${d.email_bounced?'SI':'NO'},"${(d.bozza_email_oggetto||'').replace(/"/g,'""')}","${d.created_at?new Date(d.created_at).toLocaleDateString('it-IT'):''}"\n`
    ).join('');

    const campaignName = await query("SELECT name FROM campaigns WHERE id = $1", [campaignId]);
    const safeName = (campaignName.rows[0]?.name || 'campagna').replace(/[^a-zA-Z0-9]/g, '_');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="aziende_${safeName}.csv"`);
    res.send('\uFEFF' + header + rows); // BOM per Excel UTF-8
  } catch (err) {
    logger.error("CSV export error", { error: err.message });
    res.status(500).json({ error: "Errore export CSV" });
  }
});

// API: Schedule main email send date for a company (step=0 in email_sequences)
router.post("/api/campaigns/:campaignId(\\d+)/companies/:companyId(\\d+)/schedule", async (req, res) => {
  try {
    const companyId = parseInt(req.params.companyId, 10);
    const { scheduled_at } = req.body;

    if (!scheduled_at) {
      // Clear the schedule (remove step=0)
      await query("DELETE FROM email_sequences WHERE company_id = $1 AND step = 0", [companyId]);
      return res.json({ success: true, cleared: true });
    }

    const scheduleDate = new Date(scheduled_at);
    if (isNaN(scheduleDate.getTime())) {
      return res.status(400).json({ error: "Data non valida" });
    }

    // Verifica consenso: la pianificazione automatica (email_sequences) è riservata ai
    // contatti con consenso marketing. Il cold outreach è manuale one-to-one
    // (POST /api/companies/:id/send), mai schedulato in automatico.
    const companyCheck = await query("SELECT consent_status FROM companies WHERE id = $1", [companyId]);
    if (companyCheck.rows[0]?.consent_status !== 'marketing') {
      return res.status(400).json({
        error: "Impossibile pianificare: contatto senza consenso marketing. Il cold outreach richiede invio manuale one-to-one, non è pianificabile in automatico."
      });
    }

    // Delete existing step=0 schedule, then insert new one — in transazione
    const { getClient } = await import("../db.js");
    const client = await getClient();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM email_sequences WHERE company_id = $1 AND step = 0", [companyId]);
      await client.query(
        "INSERT INTO email_sequences (company_id, step, scheduled_at) VALUES ($1, 0, $2)",
        [companyId, scheduleDate.toISOString()]
      );
      await client.query("COMMIT");
      client.release();
    } catch (e) {
      await client.query("ROLLBACK");
      client.release();
      throw e;
    }

    res.json({ success: true, scheduled_at: scheduleDate.toISOString() });
  } catch (err) {
    logger.error("Schedule send error", { error: err.message });
    res.status(500).json({ error: "Errore programmazione" });
  }
});

// API: Batch schedule send dates for campaign companies
router.post("/api/campaigns/:id(\\d+)/companies/batch-schedule", async (req, res) => {
  try {
    const campaignId = parseInt(req.params.id, 10);
    const { company_ids, scheduled_at } = req.body;

    if (!Array.isArray(company_ids) || company_ids.length === 0) {
      return res.status(400).json({ error: "company_ids richiesto" });
    }
    if (!company_ids.every(id => Number.isInteger(Number(id)) && Number(id) > 0)) {
      return res.status(400).json({ error: "IDs devono essere interi positivi" });
    }
    if (!scheduled_at) {
      return res.status(400).json({ error: "scheduled_at richiesto" });
    }

    const scheduleDate = new Date(scheduled_at);
    if (isNaN(scheduleDate.getTime())) {
      return res.status(400).json({ error: "Data non valida" });
    }

    // Filtra ai soli contatti con consenso marketing (la pianificazione automatica non è
    // mai ammessa per i cold — devono passare dall'invio manuale one-to-one).
    const ids = company_ids.map(id => parseInt(id, 10));
    const valid = await query(
      `SELECT id FROM companies WHERE id = ANY($1) AND consent_status = 'marketing'`,
      [ids]
    );
    const validIds = new Set(valid.rows.map(r => r.id));
    const processed = ids.filter(id => validIds.has(id));
    const skippedCold = ids.filter(id => !validIds.has(id));

    if (processed.length === 0) {
      return res.status(400).json({
        error: `Nessun azienda valido da pianificare. ${skippedCold.length} senza consenso marketing (richiedono invio manuale one-to-one).`,
        skipped_cold: skippedCold.length,
      });
    }

    // Batch insert/update within a transaction
    await transaction(async (client) => {
      for (const id of processed) {
        await client.query("DELETE FROM email_sequences WHERE company_id = $1 AND step = 0", [id]);
        await client.query(
          "INSERT INTO email_sequences (company_id, step, scheduled_at) VALUES ($1, 0, $2)",
          [id, scheduleDate.toISOString()]
        );
      }
    });
    res.json({
      success: true,
      updated: processed.length,
      scheduled_at: scheduleDate.toISOString(),
      skipped_cold: skippedCold.length,
    });
  } catch (err) {
    logger.error("Batch schedule error", { error: err.message });
    res.status(500).json({ error: "Errore programmazione batch" });
  }
});

// ── Spread scheduling (Ticket #14) ──
// Converte orario "muro" Europe/Rome (y,m,d,hh,mm) in istante UTC corretto (DST-aware)
function romeWallToUtc(y, m, d, hh, mm) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Rome', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
  });
  let guess = Date.UTC(y, m - 1, d, hh, mm);
  for (let i = 0; i < 4; i++) {
    const parts = fmt.formatToParts(new Date(guess));
    const get = (t) => parseInt(parts.find(p => p.type === t)?.value, 10);
    const target = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'));
    const delta = Date.UTC(y, m - 1, d, hh, mm) - target;
    if (delta === 0) break;
    guess += delta;
  }
  return new Date(guess);
}

// Aggiunge n giorni lavorativi (lun-ven) a una data calendario (y,m,d) → {y,m,d}
function addBusinessDays(y, m, d, n) {
  let date = new Date(Date.UTC(y, m - 1, d));
  const dow = date.getUTCDay();
  let offset = 0;
  if (dow === 0) offset = 1;      // domenica → lunedì
  else if (dow === 6) offset = 2; // sabato → lunedì
  date = new Date(Date.UTC(y, m - 1, d + offset));
  if (n === 0) {
    return { y: date.getUTCFullYear(), m: date.getUTCMonth() + 1, d: date.getUTCDate() };
  }
  const fullWeeks = Math.floor(n / 5);
  const rem = n % 5;
  let result = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + fullWeeks * 7 + rem));
  const rDow = result.getUTCDay();
  if (rDow === 6) result = new Date(Date.UTC(result.getUTCFullYear(), result.getUTCMonth(), result.getUTCDate() + 2));
  else if (rDow === 0) result = new Date(Date.UTC(result.getUTCFullYear(), result.getUTCMonth(), result.getUTCDate() + 1));
  return { y: result.getUTCFullYear(), m: result.getUTCMonth() + 1, d: result.getUTCDate() };
}

// API: Batch schedule spread — N email al giorno sui giorni lavorativi (Ticket #14)
router.post("/api/campaigns/:id(\\d+)/companies/batch-schedule-spread", async (req, res) => {
  try {
    const campaignId = parseInt(req.params.id, 10);
    const { company_ids, start_date, hour, per_day } = req.body;

    if (!Array.isArray(company_ids) || company_ids.length === 0) {
      return res.status(400).json({ error: "company_ids richiesto" });
    }
    if (!company_ids.every(id => Number.isInteger(Number(id)) && Number(id) > 0)) {
      return res.status(400).json({ error: "IDs devono essere interi positivi" });
    }
    if (!start_date || !/^\d{4}-\d{2}-\d{2}$/.test(start_date)) {
      return res.status(400).json({ error: "start_date richiesto (formato YYYY-MM-DD)" });
    }
    const h = parseInt(hour, 10);
    if (isNaN(h) || h < 8 || h > 17) {
      return res.status(400).json({ error: "Scegli un'ora tra le 8:00 e le 17:00 (finestra di invio)" });
    }
    const perDay = parseInt(per_day, 10);
    if (isNaN(perDay) || perDay < 1 || perDay > 500) {
      return res.status(400).json({ error: "per_day deve essere tra 1 e 500" });
    }

    const [y, m, d] = start_date.split("-").map(Number);

    // Filtra ai soli contatti con consenso marketing (stessa logica di batch-schedule)
    const ids = company_ids.map(id => parseInt(id, 10));
    const valid = await query(
      `SELECT id FROM companies WHERE id = ANY($1) AND consent_status = 'marketing'`,
      [ids]
    );
    const validIds = new Set(valid.rows.map(r => r.id));
    const processed = ids.filter(id => validIds.has(id));
    const skippedCold = ids.filter(id => !validIds.has(id));

    if (processed.length === 0) {
      return res.status(400).json({
        error: `Nessun azienda valido da pianificare. ${skippedCold.length} senza consenso marketing (richiedono invio manuale one-to-one).`,
        skipped_cold: skippedCold.length,
      });
    }

    // Calcola scheduled_at per ogni azienda: perDay al giorno, solo giorni lavorativi
    const perCompany = [];
    processed.forEach((id, i) => {
      const offset = Math.floor(i / perDay);
      const target = addBusinessDays(y, m, d, offset);
      perCompany.push({ id, when: romeWallToUtc(target.y, target.m, target.d, h, 0) });
    });

    await transaction(async (client) => {
      for (const { id, when } of perCompany) {
        await client.query("DELETE FROM email_sequences WHERE company_id = $1 AND step = 0", [id]);
        await client.query(
          "INSERT INTO email_sequences (company_id, step, scheduled_at) VALUES ($1, 0, $2)",
          [id, when.toISOString()]
        );
      }
    });

    const lastOffset = Math.floor((processed.length - 1) / perDay);
    const endDate = addBusinessDays(y, m, d, lastOffset);
    const fmtD = (yy, mm, dd) => `${String(yy).padStart(4, "0")}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;

    res.json({
      success: true,
      updated: processed.length,
      spread: {
        per_day: perDay,
        start_date: fmtD(y, m, d),
        end_date: fmtD(endDate.y, endDate.m, endDate.d),
        business_days: lastOffset + 1
      },
      skipped_cold: skippedCold.length,
    });
  } catch (err) {
    logger.error("Batch schedule spread error", { error: err.message });
    res.status(500).json({ error: "Errore programmazione spalmata" });
  }
});

// API: Get followup details for a single company in campaign
router.get("/api/campaigns/:campaignId(\\d+)/companies/:companyId(\\d+)/followups", async (req, res) => {
  try {
    const campaignId = parseInt(req.params.campaignId, 10);
    const companyId = parseInt(req.params.companyId, 10);

    // Get template sequences for this campaign
    const templates = await query(
      "SELECT * FROM followup_sequences WHERE campaign_id = $1 AND is_active = true ORDER BY step_order",
      [campaignId]
    );

    // Get per-company scheduled sequences
    const sequences = await query(
      "SELECT id, step, scheduled_at, sent_at, cancelled_at, cancel_reason FROM email_sequences WHERE company_id = $1 ORDER BY step",
      [companyId]
    );

    // Get per-company drafts (nuovo)
    const drafts = await query(
      "SELECT step_order, subject, body, approvato, generato FROM company_followup_drafts WHERE company_id = $1 AND campaign_id = $2 ORDER BY step_order",
      [companyId, campaignId]
    );

    // Merge them: show templates with scheduling info + per-company draft
    const merged = templates.rows.map(t => {
      const seq = sequences.rows.find(s => s.step === t.step_order);
      const draft = drafts.rows.find(d => d.step_order === t.step_order);
      return {
        step_order: t.step_order,
        delay_days: t.delay_days,
        template_subject: t.subject,
        template_body: t.body,
        is_active: t.is_active,
        scheduled_at: seq?.scheduled_at || null,
        sent_at: seq?.sent_at || null,
        cancelled_at: seq?.cancelled_at || null,
        cancel_reason: seq?.cancel_reason || null,
        status: seq?.sent_at ? "sent" : seq?.cancelled_at ? "cancelled" : seq?.scheduled_at ? "pending" : "not_scheduled",
        // Campi per-azienda
        draft_subject: draft?.subject || null,
        draft_body: draft?.body || null,
        draft_approvato: draft?.approvato || false,
        draft_generato: draft?.generato || false,
      };
    });

    res.json(merged);
  } catch (err) {
    logger.error("Company followups error", { error: err.message });
    res.status(500).json({ error: "Errore caricamento followup" });
  }
});

// API: Get per-company followup drafts for a campaign company
router.get("/api/campaigns/:campaignId(\\d+)/companies/:companyId(\\d+)/followup-drafts", async (req, res) => {
  try {
    const campaignId = parseInt(req.params.campaignId, 10);
    const companyId = parseInt(req.params.companyId, 10);
    const result = await query(
      `SELECT dfd.*, fs.delay_days
       FROM company_followup_drafts dfd
       JOIN followup_sequences fs ON fs.campaign_id = dfd.campaign_id AND fs.step_order = dfd.step_order AND fs.is_active = true
       WHERE dfd.company_id = $1 AND dfd.campaign_id = $2
       ORDER BY dfd.step_order`,
      [companyId, campaignId]
    );
    res.json(result.rows);
  } catch (err) {
    logger.error("Followup drafts list error", { error: err.message });
    res.status(500).json({ error: "Errore caricamento bozze followup" });
  }
});

// API: Approve/reject a single followup draft for a company
router.post("/api/campaigns/:campaignId(\\d+)/companies/:companyId(\\d+)/followup-drafts/:stepOrder(\\d+)/approve", async (req, res) => {
  try {
    const companyId = parseInt(req.params.companyId, 10);
    const stepOrder = parseInt(req.params.stepOrder, 10);
    const { approvato } = req.body;  // true = approva, false = revoca

    const draft = await query(
      "SELECT id, generato FROM company_followup_drafts WHERE company_id = $1 AND step_order = $2",
      [companyId, stepOrder]
    );
    if (draft.rows.length === 0) return res.status(404).json({ error: "Bozza followup non trovata" });
    if (!draft.rows[0].generato) return res.status(400).json({ error: "Bozza non ancora generata" });

    const val = approvato !== undefined ? approvato : true;
    await query(
      "UPDATE company_followup_drafts SET approvato = $1, updated_at = NOW() WHERE company_id = $2 AND step_order = $3",
      [val, companyId, stepOrder]
    );

    await query(
      `INSERT INTO audit_log (user_id, action, resource, resource_id, details)
       VALUES ($1, 'followup_approve', 'company_followup_drafts', $2, $3)`,
      [req.user.sub, companyId, JSON.stringify({ step_order: stepOrder, approvato: val })]
    );

    res.json({ success: true, approvato: val });
  } catch (err) {
    logger.error("Followup draft approve error", { error: err.message });
    res.status(500).json({ error: "Errore approvazione bozza followup" });
  }
});

// API: Regenerate a single followup draft for a company
router.post("/api/campaigns/:campaignId(\\d+)/companies/:companyId(\\d+)/followup-drafts/:stepOrder(\\d+)/regenerate", async (req, res) => {
  try {
    const campaignId = parseInt(req.params.campaignId, 10);
    const companyId = parseInt(req.params.companyId, 10);
    const stepOrder = parseInt(req.params.stepOrder, 10);

    // Controlla che la bozza non sia già inviata
    const seqCheck = await query(
      "SELECT id FROM email_sequences WHERE company_id = $1 AND step = $2 AND sent_at IS NOT NULL LIMIT 1",
      [companyId, stepOrder]
    );
    if (seqCheck.rows.length > 0) {
      return res.status(409).json({ error: "Follow-up già inviato per questo step. Non può essere rigenerato." });
    }

    // Resetta la bozza per rigenerazione
    await query(
      "UPDATE company_followup_drafts SET generato = false, approvato = false, subject = '', body = '', updated_at = NOW() WHERE company_id = $1 AND step_order = $2",
      [companyId, stepOrder]
    );

    // Trigger generazione asincrona
    const { generateFollowUpDrafts } = await import("./cron.js");
    generateFollowUpDrafts([companyId], campaignId).catch(e =>
      logger.error("Async followup regeneration error", { error: e.message })
    );

    res.json({ success: true, message: "Rigenerazione avviata" });
  } catch (err) {
    logger.error("Followup draft regenerate error", { error: err.message });
    res.status(500).json({ error: "Errore rigenerazione bozza followup" });
  }
});

// API: Inline edit followup draft (update subject/body without resetting generato/approvato)
router.patch("/api/campaigns/:campaignId(\\d+)/companies/:companyId(\\d+)/followup-drafts/:stepOrder(\\d+)", async (req, res) => {
  try {
    const companyId = parseInt(req.params.companyId, 10);
    const stepOrder = parseInt(req.params.stepOrder, 10);
    const { subject, body } = req.body;

    if (subject === undefined && body === undefined) {
      return res.status(400).json({ error: "Almeno uno tra subject e body è richiesto" });
    }

    const draft = await query(
      "SELECT id FROM company_followup_drafts WHERE company_id = $1 AND step_order = $2",
      [companyId, stepOrder]
    );
    if (draft.rows.length === 0) return res.status(404).json({ error: "Bozza followup non trovata" });

    const updates = [];
    const params = [];
    let idx = 1;
    if (subject !== undefined) {
      updates.push(`subject = $${idx++}`);
      params.push(subject);
    }
    if (body !== undefined) {
      updates.push(`body = $${idx++}`);
      params.push(body);
    }
    updates.push(`updated_at = NOW()`);
    params.push(companyId, stepOrder);

    await query(
      `UPDATE company_followup_drafts SET ${updates.join(", ")} WHERE company_id = $${idx++} AND step_order = $${idx}`,
      params
    );

    await query(
      `INSERT INTO audit_log (user_id, action, resource, resource_id, details)
       VALUES ($1, 'followup_draft_edit', 'company_followup_drafts', $2, $3)`,
      [req.user.sub, companyId, JSON.stringify({ step_order: stepOrder, subject, body })]
    );

    res.json({ success: true });
  } catch (err) {
    logger.error("Followup draft edit error", { error: err.message });
    res.status(500).json({ error: "Errore modifica bozza followup" });
  }
});

// API: Followup draft preview with merge tags resolved
router.get("/api/campaigns/:campaignId(\\d+)/companies/:companyId(\\d+)/followup-drafts/:stepOrder(\\d+)/preview", async (req, res) => {
  try {
    const campaignId = parseInt(req.params.campaignId, 10);
    const companyId = parseInt(req.params.companyId, 10);
    const stepOrder = parseInt(req.params.stepOrder, 10);

    const draft = await query(
      "SELECT dfd.* FROM company_followup_drafts dfd WHERE dfd.company_id = $1 AND dfd.step_order = $2 AND dfd.campaign_id = $3",
      [companyId, stepOrder, campaignId]
    );
    if (draft.rows.length === 0) return res.status(404).json({ error: "Bozza followup non trovata" });

    const company = await query(
      "SELECT id, nome_studio, nome_azienda, comune, provincia, email, title FROM companies WHERE id = $1",
      [companyId]
    );
    if (company.rows.length === 0) return res.status(404).json({errorKey: "error.company_not_found" });

    const campaign = await query("SELECT * FROM campaigns WHERE id = $1", [campaignId]);
    if (campaign.rows.length === 0) return res.status(404).json({errorKey: "error.campaign_not_found" });

    const { applyMergeTags } = await import("../services/merge-tags.js");

    let subject = applyMergeTags(draft.rows[0].subject || "", company.rows[0], campaign.rows[0]);
    let body = applyMergeTags(draft.rows[0].body || "", company.rows[0], campaign.rows[0]);

    // Apply SMTP signature
    const smtpAcc = campaign.rows[0].smtp_account_id
      ? (await query("SELECT firma_testo, firma_html FROM smtp_accounts WHERE id = $1", [campaign.rows[0].smtp_account_id])).rows[0]
      : null;
    if (smtpAcc?.firma_testo) {
      body += "\n\n" + smtpAcc.firma_testo;
    }

    let html = null;
    if (campaign.rows[0].use_html) {
      const wrapper = campaign.rows[0].html_wrapper || "<div>{{BODY}}</div>";
      html = wrapper.replace("{{BODY}}", body.replace(/\n/g, "<br>"));
      if (smtpAcc?.firma_html) html = html.replace("</body>", smtpAcc.firma_html + "</body>");
    }

    res.json({ subject, body, html });
  } catch (err) {
    logger.error("Followup draft preview error", { error: err.message });
    res.status(500).json({ error: "Errore anteprima bozza followup" });
  }
});

// API: View sent followup emails for a company
router.get("/api/campaigns/:campaignId(\\d+)/companies/:companyId(\\d+)/followups/sent", async (req, res) => {
  try {
    const companyId = parseInt(req.params.companyId, 10);
    const campaignId = parseInt(req.params.campaignId, 10);

    const result = await query(
      `SELECT dfd.step_order, dfd.sent_subject, dfd.sent_body, dfd.sent_at,
              es.scheduled_at, es.sent_at AS sequence_sent_at
       FROM company_followup_drafts dfd
       LEFT JOIN email_sequences es ON es.company_id = dfd.company_id AND es.step = dfd.step_order
       WHERE dfd.company_id = $1 AND dfd.campaign_id = $2
         AND dfd.sent_at IS NOT NULL
       ORDER BY dfd.step_order`,
      [companyId, campaignId]
    );

    res.json(result.rows);
  } catch (err) {
    logger.error("Sent followups error", { error: err.message });
    res.status(500).json({ error: "Errore caricamento followup inviati" });
  }
});

// API: Batch approve followup drafts for selected companies (all steps)
router.post("/api/campaigns/:id(\\d+)/companies/batch-followup-approve", async (req, res) => {
  try {
    const campaignId = parseInt(req.params.id, 10);
    const { company_ids, approvato } = req.body;
    if (!Array.isArray(company_ids) || company_ids.length === 0) {
      return res.status(400).json({ error: "company_ids richiesto" });
    }

    const val = approvato !== undefined ? approvato : true;
    const placeholders = company_ids.map((_, i) => `$${i + 1}`).join(", ");
    const result = await query(
      `UPDATE company_followup_drafts SET approvato = $${company_ids.length + 1}, updated_at = NOW()
       WHERE company_id IN (${placeholders}) AND campaign_id = $${company_ids.length + 2} AND generato = true`,
      [...company_ids, val, campaignId]
    );

    await query(
      `INSERT INTO audit_log (user_id, action, resource, details)
       VALUES ($1, 'batch_followup_approve', 'company_followup_drafts', $2)`,
      [req.user.sub, JSON.stringify({ count: result.rowCount, approvato: val })]
    );

    res.json({ success: true, updated: result.rowCount });
  } catch (err) {
    logger.error("Batch followup approve error", { error: err.message });
    res.status(500).json({ error: "Errore approvazione batch followup" });
  }
});

// API: Generate followup drafts for entire campaign (or specific companies)
router.post("/api/campaigns/:id(\\d+)/generate-followup-drafts", async (req, res) => {
  try {
    const campaignId = parseInt(req.params.id, 10);
    const { company_ids } = req.body;

    if (company_ids && Array.isArray(company_ids) && company_ids.length > 0) {
      // Reset bozze per aziende specifici
      await query(
        "UPDATE company_followup_drafts SET generato = false, approvato = false, updated_at = NOW() WHERE company_id = ANY($1::int[]) AND campaign_id = $2",
        [company_ids, campaignId]
      );
    } else {
      // Reset tutte le bozze della campagna non ancora approvate
      await query(
        "UPDATE company_followup_drafts SET generato = false, approvato = false, updated_at = NOW() WHERE campaign_id = $1 AND approvato = false",
        [campaignId]
      );
    }

    const { generateFollowUpDrafts } = await import("./cron.js");
    if (company_ids && Array.isArray(company_ids) && company_ids.length > 0) {
      generateFollowUpDrafts(company_ids, campaignId).catch(e =>
        logger.error("Async followup generation error", { error: e.message })
      );
    } else {
      generateFollowUpDrafts(null, campaignId).catch(e =>
        logger.error("Async followup campaign generation error", { error: e.message })
      );
    }

    res.json({ success: true, triggered: true });
  } catch (err) {
    logger.error("Generate followup drafts error", { error: err.message });
    res.status(500).json({ error: "Errore generazione bozze followup" });
  }
});

// API: Remove all no-email companies from campaign
router.post("/api/campaigns/:id(\\d+)/remove-noemail", async (req, res) => {
  try {
    const campaignId = parseInt(req.params.id, 10);
    const result = await query(
      `UPDATE companies SET campaign_id = NULL, updated_at = NOW()
       WHERE campaign_id = $1
         AND (email IS NULL OR email = '')
         AND (approvato = false OR approvato IS NULL)
         AND (inviato = false OR inviato IS NULL)
         AND tenant_id =$2)
       RETURNING id`,
      [campaignId, req.user.tenant_id || null]
    );
    res.json({ removed: result.rowCount, ids: result.rows.map(r => r.id) });
  } catch (err) {
    logger.error("Remove noemail companies error", { error: err.message });
    res.status(500).json({ error: "Errore rimozione aziende senza email" });
  }
});

// API: Batch actions on campaign companies
router.post("/api/campaigns/:id(\\d+)/companies/batch", async (req, res) => {
  try {
    const campaignId = parseInt(req.params.id, 10);
    const { action, company_ids } = req.body;

    if (!Array.isArray(company_ids) || company_ids.length === 0) {
      return res.status(400).json({ error: "company_ids richiesto (array non vuoto)" });
    }
    if (!["approve", "unapprove", "regenerate", "remove"].includes(action)) {
      return res.status(400).json({ error: "Azione non supportata. Usa: approve, unapprove, regenerate, remove" });
    }

    const placeholders = company_ids.map((_, i) => `$${i + 1}`).join(", ");
    let result;

    switch (action) {
      case "approve":
        result = await query(
          `UPDATE companies SET approvato = true, updated_at = NOW()
           WHERE id IN (${placeholders}) AND campaign_id = $${company_ids.length + 1} AND bozza_creata = true AND tenant_id =$${company_ids.length + 2})`,
          [...company_ids, campaignId, req.user.tenant_id || null]
        );
        break;
      case "unapprove":
        result = await query(
          `UPDATE companies SET approvato = false, updated_at = NOW()
           WHERE id IN (${placeholders}) AND campaign_id = $${company_ids.length + 1} AND tenant_id =$${company_ids.length + 2})`,
          [...company_ids, campaignId, req.user.tenant_id || null]
        );
        break;
      case "regenerate":
        result = await query(
          `UPDATE companies SET bozza_rifai = true, bozza_creata = false, approvato = false, bozza_failed_count = 0, updated_at = NOW()
           WHERE id IN (${placeholders}) AND campaign_id = $${company_ids.length + 1} AND tenant_id =$${company_ids.length + 2})`,
          [...company_ids, campaignId, req.user.tenant_id || null]
        );
        // Cancel pending followups for these companies
        await query(
          `UPDATE email_sequences SET cancelled_at = NOW(), cancel_reason = 'batch_regenerated'
           WHERE company_id IN (${placeholders}) AND sent_at IS NULL AND cancelled_at IS NULL`,
          company_ids
        );
        // Trigger draft generation for these specific companies
        const { generateEmailDrafts } = await import("./cron.js");
        generateEmailDrafts(company_ids).catch(e => logger.error("Batch draft generation error", { error: e.message }));
        break;
      case "remove":
        result = await query(
          `UPDATE companies SET campaign_id = NULL, approvato = false, updated_at = NOW()
           WHERE id IN (${placeholders}) AND campaign_id = $${company_ids.length + 1} AND tenant_id =$${company_ids.length + 2})`,
          [...company_ids, campaignId, req.user.tenant_id || null]
        );
        break;
    }

    res.json({ updated: result.rowCount, action });
  } catch (err) {
    logger.error("Batch action error", { error: err.message });
    res.status(500).json({ error: "Errore esecuzione azione batch" });
  }
});

// View: Campaign Workflow Page
router.get("/campaigns/:id(\\d+)/workflow", async (req, res) => {
  try {
    const campaign = await query("SELECT * FROM campaigns WHERE id = $1", [req.params.id]);
    if (!campaign.rows[0]) return res.status(404).render("error", {messageKey: "error.campaign_not_found" });
    res.render("campaigns/workflow", { campaign: campaign.rows[0] });
  } catch (err) {
    logger.error("Campaign workflow error", { error: err.message });
    res.status(500).render("error", {messageKey: "error.load_workflow" });
  }
});

export default router;
