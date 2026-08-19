import { Router } from "express";
import { query } from "../db.js";
import { getAllSettings, getSetting, setSetting, loadSettings } from "../services/settings.js";
import { clearPatternCache } from "../services/blacklist.js";
import { requireAuth, requireAdmin } from "../middleware/auth.js";
import { logger, setLogLevel } from "../services/logger.js";
import config from "../config.js";

const router = Router();

router.use(requireAuth);
router.use(requireAdmin);

router.get("/admin/settings", async (req, res) => {
  try {
    res.render("admin/settings");
  } catch (err) {
    res.status(500).send({ messageKey: "error.load_page" });
  }
});

router.get("/api/admin/settings", async (req, res) => {
  try {
    const result = await query(
      `SELECT key,
          CASE WHEN sensitive AND value IS NOT NULL AND value != '' THEN NULL ELSE value END AS value,
          category, description, sensitive,
          CASE WHEN sensitive THEN value IS NOT NULL AND value != '' ELSE true END AS "hasValue"
   FROM settings ORDER BY category, key`
    );
    res.json(result.rows);
  } catch (err) {
    logger.error("Settings list error", { error: err.message });
    res.status(500).json({ error: "Errore caricamento impostazioni" });
  }
});

router.put("/api/admin/settings/:key", async (req, res) => {
  try {
    const { key } = req.params;
    const { value } = req.body;

    // Se la chiave è sensibile e il valore è vuoto, non sovrascrivere
    const meta = await query("SELECT sensitive FROM settings WHERE key = $1", [key]);
    if (meta.rows[0]?.sensitive && (value === undefined || value === null || value === "")) {
      return res.json({ success: true, message: "Valore sensibile invariato" });
    }

    try {
      await setSetting(key, value, req.user.sub);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
    await query(
      `INSERT INTO audit_log (user_id, action, resource, details)
       VALUES ($1, 'update', 'settings', $2)`,
      [req.user.sub, JSON.stringify({ key })]
    );

    if (key.startsWith("outreach_")) {
      // Campi speciali per outreach SMTP → non fare nulla di speciale
    }
    if (key === "log_level") {
      setLogLevel(String(value));
    }

    res.json({ success: true });
  } catch (err) {
    logger.error("Settings update error", { error: err.message });
    res.status(500).json({ error: "Errore aggiornamento" });
  }
});

router.get("/api/admin/blacklist", async (req, res) => {
  try {
    const result = await query(
      "SELECT bp.*, u.name AS created_by_name FROM blacklist_patterns bp LEFT JOIN users u ON u.id = bp.created_by ORDER BY bp.id"
    );
    res.json(result.rows);
  } catch (err) {
    logger.error("Blacklist list error", { error: err.message });
    res.status(500).json({ error: "Errore caricamento blacklist" });
  }
});

router.post("/api/admin/blacklist", async (req, res) => {
  try {
    const { pattern, description } = req.body;
    if (!pattern) return res.status(400).json({ error: "Pattern richiesto" });
    if (pattern.length > 500) return res.status(400).json({ error: "Pattern troppo lungo (max 500 caratteri)" });
    try { new RegExp(pattern); } catch (e) { return res.status(400).json({ error: "Pattern regex non valido" }); }

    const result = await query(
      `INSERT INTO blacklist_patterns (pattern, description, created_by, tenant_id)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [pattern, description || '', req.user.sub, req.user.tenant_id]
    );
    clearPatternCache();

    await query(
      `INSERT INTO audit_log (user_id, action, resource, resource_id, details)
       VALUES ($1, 'create', 'blacklist_patterns', $2, $3)`,
      [req.user.sub, result.rows[0].id, JSON.stringify({ pattern })]
    );

    res.json({ success: true, pattern: result.rows[0] });
  } catch (err) {
    logger.error("Blacklist create error", { error: err.message });
    res.status(500).json({ error: "Errore creazione pattern" });
  }
});

router.put("/api/admin/blacklist/:id", async (req, res) => {
  try {
    const { pattern, description, is_active } = req.body;
    const fields = [];
    const params = [];
    let idx = 1;

    if (pattern !== undefined) { fields.push(`pattern = $${idx++}`); params.push(pattern); }
    if (description !== undefined) { fields.push(`description = $${idx++}`); params.push(description); }
    if (is_active !== undefined) { fields.push(`is_active = $${idx++}`); params.push(is_active); }

    if (fields.length === 0) return res.status(400).json({ error: "Nessun campo" });
    params.push(req.params.id);

    await query(`UPDATE blacklist_patterns SET ${fields.join(", ")} WHERE id = $${idx}`, params);
    clearPatternCache();
    res.json({ success: true });
  } catch (err) {
    logger.error("Blacklist update error", { error: err.message });
    res.status(500).json({ error: "Errore aggiornamento pattern" });
  }
});

router.delete("/api/admin/blacklist/:id", async (req, res) => {
  try {
    await query("DELETE FROM blacklist_patterns WHERE id = $1", [req.params.id]);
    clearPatternCache();
    res.json({ success: true });
  } catch (err) {
    logger.error("Blacklist delete error", { error: err.message });
    res.status(500).json({ error: "Errore eliminazione pattern" });
  }
});

router.post("/api/admin/settings/test/smtp", requireAuth, requireAdmin, async (req, res) => {
  try {
    // Verifica SMTP direttamente
    const smtpAccounts = await query(
      "SELECT smtp_host, smtp_port, smtp_user, smtp_pass, from_email, from_name FROM smtp_accounts LIMIT 1"
    );
    if (!smtpAccounts.rows[0]) {
      return res.status(500).json({ error: "Nessun account SMTP configurato" });
    }

    // Invia email di test reale
    const nodemailer = await import("nodemailer");
    const transporter = nodemailer.createTransport({
      host: smtpAccounts.rows[0].smtp_host,
      port: smtpAccounts.rows[0].smtp_port,
      secure: smtpAccounts.rows[0].smtp_port === 465,
      auth: {
        user: smtpAccounts.rows[0].smtp_user,
        pass: smtpAccounts.rows[0].smtp_pass,
      },
    });
    await transporter.sendMail({
      from: `${smtpAccounts.rows[0].from_name || config.brand.defaultFromName} <${smtpAccounts.rows[0].from_email || smtpAccounts.rows[0].smtp_user}>`,
      to: req.user.email,
      subject: `Test email da ${config.brand.name}`,
      html: `<p>Questa è una email di test inviata da ${req.user.name}.</p><p>Se ricevi questo messaggio, la configurazione SMTP è corretta.</p>`,
    });
    transporter.close();
    res.json({ success: true, message: "SMTP configurato correttamente, email di test inviata" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// SMTP accounts CRUD
router.get("/admin/smtp-accounts", async (req, res) => {
  try {
    res.render("admin/smtp-accounts");
  } catch (err) { res.status(500).render("error", {messageKey: "error.load_smtp" }); }
});

router.get("/api/admin/smtp-accounts", async (req, res) => {
  try {
    const result = await query(
      `SELECT id, name, smtp_host, smtp_port, smtp_user, from_email, from_name,
              imap_host, imap_port, imap_user, daily_limit, sent_today, rr_position,
              is_active, bounce_count, firma_testo, firma_html,
              warming_enabled, warming_start_date, warming_start_limit, warming_increment, warming_max_limit,
              (smtp_pass IS NOT NULL AND smtp_pass != '') AS has_smtp_pass,
              (imap_pass IS NOT NULL AND imap_pass != '') AS has_imap_pass
       FROM smtp_accounts ORDER BY rr_position, id`
    );
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: "Errore caricamento" }); }
});

router.get("/api/admin/smtp-accounts/:id", async (req, res) => {
  try {
    const r = await query("SELECT * FROM smtp_accounts WHERE id = $1", [req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: "Non trovato" });
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post("/api/admin/smtp-accounts", async (req, res) => {
  try {
    const { name, smtp_host, smtp_port, smtp_user, smtp_pass, from_email, from_name, imap_host, imap_port, imap_user, imap_pass, daily_limit, firma_testo, firma_html, warming_enabled, warming_start_date, warming_start_limit, warming_increment, warming_max_limit } = req.body;
    await query(
      `INSERT INTO smtp_accounts (name, smtp_host, smtp_port, smtp_user, smtp_pass, from_email, from_name, imap_host, imap_port, imap_user, imap_pass, daily_limit, firma_testo, firma_html, warming_enabled, warming_start_date, warming_start_limit, warming_increment, warming_max_limit, tenant_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
      [name, smtp_host, Number.isFinite(parseInt(smtp_port, 10)) ? parseInt(smtp_port, 10) : 465, smtp_user, smtp_pass, from_email, from_name||config.brand.defaultFromName, imap_host||null, Number.isFinite(parseInt(imap_port, 10)) ? parseInt(imap_port, 10) : 993, imap_user||null, imap_pass||null, Number.isFinite(parseInt(daily_limit, 10)) ? parseInt(daily_limit, 10) : 100, firma_testo||null, firma_html||null, warming_enabled||false, warming_start_date||null, Number.isFinite(parseInt(warming_start_limit, 10)) ? parseInt(warming_start_limit, 10) : null, Number.isFinite(parseInt(warming_increment, 10)) ? parseInt(warming_increment, 10) : null, Number.isFinite(parseInt(warming_max_limit, 10)) ? parseInt(warming_max_limit, 10) : null, req.user.tenant_id]
    );
    await query(
      `INSERT INTO audit_log (user_id, action, resource, details)
       VALUES ($1, 'create', 'smtp_accounts', $2)`,
      [req.user.sub, JSON.stringify({ name, smtp_host })]
    );
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.patch("/api/admin/smtp-accounts/:id", async (req, res) => {
  try {
    const { name, smtp_host, smtp_port, smtp_user, smtp_pass, from_email, from_name, imap_host, imap_port, imap_user, imap_pass, daily_limit, is_active, firma_testo, firma_html, warming_enabled, warming_start_date, warming_start_limit, warming_increment, warming_max_limit } = req.body;
    const fields = [];
    const params = [];
    let idx = 1;
    if (name !== undefined) { fields.push(`name = $${idx++}`); params.push(name); }
    if (smtp_host !== undefined) { fields.push(`smtp_host = $${idx++}`); params.push(smtp_host); }
    if (smtp_port !== undefined) { fields.push(`smtp_port = $${idx++}`); params.push(Number.isFinite(parseInt(smtp_port, 10)) ? parseInt(smtp_port, 10) : 465); }
    if (smtp_user !== undefined) { fields.push(`smtp_user = $${idx++}`); params.push(smtp_user); }
    if (smtp_pass !== undefined) { fields.push(`smtp_pass = $${idx++}`); params.push(smtp_pass); }
    if (from_email !== undefined) { fields.push(`from_email = $${idx++}`); params.push(from_email); }
    if (from_name !== undefined) { fields.push(`from_name = $${idx++}`); params.push(from_name); }
    if (imap_host !== undefined) { fields.push(`imap_host = $${idx++}`); params.push(imap_host); }
    if (imap_port !== undefined) { fields.push(`imap_port = $${idx++}`); params.push(Number.isFinite(parseInt(imap_port, 10)) ? parseInt(imap_port, 10) : 993); }
    if (imap_user !== undefined) { fields.push(`imap_user = $${idx++}`); params.push(imap_user); }
    if (imap_pass !== undefined) { fields.push(`imap_pass = $${idx++}`); params.push(imap_pass); }
    if (daily_limit !== undefined) { fields.push(`daily_limit = $${idx++}`); params.push(Number.isFinite(parseInt(daily_limit, 10)) ? parseInt(daily_limit, 10) : 100); }
    if (is_active !== undefined) { fields.push(`is_active = $${idx++}`); params.push(is_active); }
    if (firma_testo !== undefined) { fields.push(`firma_testo = $${idx++}`); params.push(firma_testo); }
    if (firma_html !== undefined) { fields.push(`firma_html = $${idx++}`); params.push(firma_html); }
    if (warming_enabled !== undefined) { fields.push(`warming_enabled = $${idx++}`); params.push(warming_enabled); }
    if (warming_start_date !== undefined) { fields.push(`warming_start_date = $${idx++}`); params.push(warming_start_date); }
    if (warming_start_limit !== undefined) { fields.push(`warming_start_limit = $${idx++}`); params.push(Number.isFinite(parseInt(warming_start_limit, 10)) ? parseInt(warming_start_limit, 10) : null); }
    if (warming_increment !== undefined) { fields.push(`warming_increment = $${idx++}`); params.push(Number.isFinite(parseInt(warming_increment, 10)) ? parseInt(warming_increment, 10) : null); }
    if (warming_max_limit !== undefined) { fields.push(`warming_max_limit = $${idx++}`); params.push(Number.isFinite(parseInt(warming_max_limit, 10)) ? parseInt(warming_max_limit, 10) : null); }
    if (fields.length === 0) return res.status(400).json({ error: "Nessun campo" });
    fields.push("updated_at = NOW()");
    params.push(req.params.id);
    await query(`UPDATE smtp_accounts SET ${fields.join(", ")} WHERE id = $${idx}`, params);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post("/api/admin/smtp-accounts/:id/test", async (req, res) => {
  const acc = await query("SELECT * FROM smtp_accounts WHERE id = $1", [req.params.id]);
  if (!acc.rows[0]) return res.status(404).json({ error: "Account non trovato" });
  const a = acc.rows[0];
  try {
    const nodemailer = (await import("nodemailer")).default;
    const t = nodemailer.createTransport({
      host: a.smtp_host, port: a.smtp_port,
      secure: a.smtp_port === 465,
      auth: { user: a.smtp_user, pass: a.smtp_pass }
    });
    await t.verify();
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

router.post("/api/admin/smtp-accounts/:id/test-send", async (req, res) => {
  const acc = await query("SELECT * FROM smtp_accounts WHERE id = $1", [req.params.id]);
  if (!acc.rows[0]) return res.status(404).json({ error: "Account non trovato" });
  const a = acc.rows[0];
  const { to, subject, text } = req.body;
  if (!to) return res.status(400).json({ error: "Destinatario richiesto" });
  try {
    const nodemailer = (await import("nodemailer")).default;
    const t = nodemailer.createTransport({
      host: a.smtp_host, port: a.smtp_port,
      secure: a.smtp_port === 465,
      auth: { user: a.smtp_user, pass: a.smtp_pass }
    });
    await t.sendMail({
      from: `"${a.from_name || config.brand.defaultFromName}" <${a.from_email || a.smtp_user}>`,
      to,
      subject: subject || ("Test SMTP — " + a.name),
      text: text || ("Email di test inviata correttamente dall'account " + a.name),
    });
    res.json({ success: true, message: "Email di test inviata" });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

router.get("/api/admin/smtp-accounts/:id/stats", async (req, res) => {
  const r = await query(
    `SELECT COUNT(*) FILTER (WHERE eq.created_at > NOW() - INTERVAL '7 days')::int AS sent_7d,
            COUNT(*) FILTER (WHERE d.email_bounced AND eq.created_at > NOW() - INTERVAL '7 days')::int AS bounced_7d,
            COUNT(*)::int AS sent_total
     FROM email_queue eq LEFT JOIN companies d ON d.id = eq.company_id
     WHERE eq.smtp_account_id = $1 AND eq.status = 'sent'`,
    [req.params.id]
  );
  res.json(r.rows[0]);
});

router.delete("/api/admin/smtp-accounts/:id", async (req, res) => {
  try {
    await query("DELETE FROM smtp_accounts WHERE id = $1", [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: "Errore eliminazione" }); }
});



router.get("/api/admin/openrouter-models", requireAuth, requireAdmin, async (req, res) => {
  try {
    const apiKey = getSetting("openrouter_api_key") || config.openrouterApiKey;
    if (!apiKey) return res.status(400).json({ error: "API Key OpenRouter non configurata" });

    const baseUrl = getSetting("openrouter_base_url") || config.openrouterBaseUrl;
    const response = await fetch(`${baseUrl}/models`, {
      headers: { "Authorization": `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) return res.status(502).json({ error: "OpenRouter non raggiungibile" });

    const data = await response.json();
    const models = (data.data || []).map(m => ({
      id: m.id,
      context_length: m.context_length || 0,
      prompt_cost: m.pricing?.prompt || 0,
      completion_cost: m.pricing?.completion || 0,
    })).sort((a, b) => a.id.localeCompare(b.id));

    res.json(models);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/api/admin/ai-prompts/defaults", requireAuth, requireAdmin, async (req, res) => {
  try {
    const { COPYWRITER_PROMPT, REWRITE_PROMPT } = await import("../services/ai-copywriter.js");
    const { VALIDATOR_PROMPT } = await import("../services/ai-validator.js");
    res.json({
      prompt_copywriter: COPYWRITER_PROMPT,
      prompt_rewrite: REWRITE_PROMPT,
      prompt_validator: VALIDATOR_PROMPT,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
