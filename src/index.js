import crypto from "crypto";
import express from "express";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import jwt from "jsonwebtoken";
import expressLayouts from "express-ejs-layouts";
import rateLimit from "express-rate-limit";
import path from "path";
import { fileURLToPath } from "url";
import config from "./config.js";
import { addNote, setContactOptOut } from "./services/cms.js";
import { loadSettings, getSetting } from "./services/settings.js";
import { logger } from "./services/logger.js";
import { requestId } from "./middleware/request-id.js";
import { requireAuth, requireAdmin } from "./middleware/auth.js";
import { query, getClient } from "./db.js";

import { i18nMiddleware } from "./middleware/i18n.js";
import i18nRoutes from "./routes/i18n.js";
import authRoutes from "./routes/auth.js";
import companiesRoutes from "./routes/companies.js";
import municipalitiesRoutes from "./routes/municipalities.js";
import direzioneRoutes from "./routes/direzione.js";
import scraperRoutes from "./routes/scraper.js";
import cronRoutes from "./routes/cron.js";
import usersRoutes from "./routes/users.js";
import settingsRoutes from "./routes/settings.js";
import webhookRoutes from "./routes/webhooks.js";
import campaignRoutes from "./routes/campaigns.js";
import followupSequencesRoutes from "./routes/followup-sequences.js";
import searchRoutes from "./routes/search.js";
import wizardRoutes from "./routes/wizard.js";
// GHL rimosso a favore del CMS agent-first (fase 2): route e servizi legacy
// (routes/ghl.js, services/ghl.js) sono stati eliminati nelle fasi 10 e ricognizione 3;
// la dashboard /admin/ghl non è più esposta. Il CMS agent-first è il nostro CRM mono-tenant.
import sendScheduleRoutes from "./routes/send-schedule.js";
import bugReportsRoutes from "./routes/bug-reports.js";
import imapRoutes from "./routes/imap.js";
import todayRoutes from "./routes/today.js";
import agentRoutes from "./routes/agent.js";
import mcpRoutes from "./routes/mcp.js";
import apiTokensAdminRoutes from "./routes/api-tokens-admin.js";
import tenantsAdminRoutes from "./routes/tenants-admin.js";
import { gracefulShutdown as shutdownBrowser, getBrowser, isBrowserEnabled } from "./services/browser-pool.js";
import { processMunicipalities, generateEmailDrafts, cleanupErrors, processFollowUps, processEmailQueue, retryFailedEmails, processCmsSync, generateFollowUpDrafts, processCmsEngagementSync } from "./routes/cron.js";
import { resetDailyCounts } from "./services/smtp-router.js";
import { checkFunnelAlerts } from "./services/funnel-alerts.js";
import { withLock } from "./services/locks.js";
import { stringify } from "csv-stringify/sync";
import "./middleware/env-check.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));





const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  message: { error: "Troppe richieste. Riprova tra 15 minuti." },
  standardHeaders: true,
  legacyHeaders: false,
  // Il proxy MCP (mcp-tools.js) fa fetch interni a 127.0.0.1 per ogni tool
  // call: esentare il loopback evita 429 incrociati legati al bucket del
  // singolo client. Il proxy è già limitato sull'endpoint /api/mcp.
  skip: (req) => {
    if (req.path === "/api/auth/logout" || req.path.startsWith("/api/webhooks/")) return true;
    const ip = req.ip || "";
    return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
  },
});

// Rate limit dedicato a /api/mcp: più stretto e con skip del loopback,
// così le chiamate interne del proxy MCP non si auto-bloccano.
const mcpLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  message: { error: "Troppe richieste MCP. Riprova tra 1 minuto." },
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => {
    const ip = req.ip || "";
    return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
  },
});

const heavyLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  message: { error: "Troppe richieste per operazione pesante. Riprova tra 1 minuto." },
  standardHeaders: true,
  legacyHeaders: false,
});

let server;

async function start() {
  try {
    await loadSettings();
  } catch (err) {
    logger.warn("Settings load fallito, continuo con env vars", { error: err.message });
  }

  const app = express();

  const trustProxy = config.trustProxy !== false ? config.trustProxy : (config.nodeEnv === "production");
  app.set("trust proxy", trustProxy);

  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:"],
        formAction: ["'self'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  }));
  app.use(cookieParser());
  app.use(requestId);

  app.use(express.urlencoded({ extended: false, limit: "1mb" }));
  app.use(express.json({ limit: "1mb" }));

  app.use((req, _res, next) => {
    const token = req.cookies?.token;
    if (token) {
      try { req.user = jwt.verify(token, config.jwtSecret, { algorithms: ["HS256"] }); }
      catch (err) {
        logger.warn("JWT verification failed", { error: err.message });
        req.user = null;
      }
    }
    next();
  });

  app.set("view engine", "ejs");
  app.set("views", path.join(__dirname, "..", "views"));
  app.set("layout", "layout");
  app.use(expressLayouts);
  app.use(express.static(path.join(__dirname, "..", "public"), { maxAge: "7d", etag: true }));

  app.use(i18nMiddleware(config.defaultLang));

  app.use(async (req, res, next) => {
    res.locals.user = req.user || null;
    res.locals.path = req.path;
    res.locals.brand = config.brand;
    res.locals.app = { name: config.brand.name };
    res.locals.protectedUserEmail = process.env.PROTECTED_USER_EMAIL || '';
    next();
  });

  // Helper globali EJS per formattazione date safe
  app.locals.fmtDate = (d, locale = 'it-IT') => {
    if (!d) return '—';
    try { return new Date(d).toLocaleString(locale); } catch { return '—'; }
  };
  app.locals.fmtDateShort = (d, locale = 'it-IT') => {
    if (!d) return '—';
    try { return new Date(d).toLocaleDateString(locale); } catch { return '—'; }
  };

  function verifyUnsubToken(token) {
    const dotIdx = token.indexOf('.');
    if (dotIdx > 0) {
      const rawId = token.slice(0, dotIdx);
      const sig = token.slice(dotIdx + 1);
      const expected = crypto.createHmac("sha256", config.jwtSecret).update(rawId).digest("hex").slice(0, 16);
      if (sig === expected && /^\d+$/.test(rawId)) {
        return parseInt(rawId, 10);
      }
    }
    return null;
  }

  app.get("/unsubscribe/:token", async (req, res) => {
    try {
      const parsedId = verifyUnsubToken(req.params.token);
      if (parsedId === null) return res.render("unsubscribe", { status: "not_found", email: "" });
      const d = await query(
        "SELECT id, email FROM companies WHERE id = $1",
        [parsedId]
      );
      if (!d.rows[0]) return res.render("unsubscribe", { status: "not_found", email: "" });
      const client = await getClient();
      try {
        await client.query("BEGIN");
        await client.query(
          "UPDATE companies SET unsubscribed_at = COALESCE(unsubscribed_at, NOW()), approvato = false WHERE id = $1",
          [d.rows[0].id]
        );
        await client.query(
          "UPDATE email_sequences SET cancelled_at = NOW(), cancel_reason = 'unsubscribed' WHERE company_id = $1 AND sent_at IS NULL AND cancelled_at IS NULL",
          [d.rows[0].id]
        );
        await client.query("COMMIT");
        // CMS: nota di unsubscribe + opt-out totale condiviso (blacklist CMS)
        try {
          await setContactOptOut(config.cmsSiteId, d.rows[0].email);
        } catch (_) { /* silent fail, best-effort */ }
        try {
          await addNote(config.cmsSiteId, d.rows[0].email, "🚫 Il contatto si è disiscritto dalle email (unsubscribe)");
        } catch (_) { /* silent fail cms note */ }
        res.render("unsubscribe", { status: "ok", email: d.rows[0].email });
      } catch (txErr) {
        await client.query("ROLLBACK").catch(() => {});
        throw txErr;
      } finally {
        client.release();
      }
    } catch (err) {
      res.render("unsubscribe", { status: "error", email: "" });
    }
  });

  // ── Event tracking (sostituisce webhook Listmonk) ──
  app.get("/track/open/:trackingId", async (req, res) => {
    try {
      const { trackingId } = req.params;
      if (trackingId) {
        await query(
          "UPDATE companies SET email_opened_at = COALESCE(email_opened_at, NOW()) WHERE id = (SELECT company_id FROM email_tracking WHERE id = $1)",
          [trackingId]
        ).catch(() => {});
        await query(
          "INSERT INTO email_events (company_id, event_type, occurred_at) VALUES ((SELECT company_id FROM email_tracking WHERE id = $1), 'open', NOW()) ON CONFLICT DO NOTHING",
          [trackingId]
        ).catch(() => {});
        // CMS: nota apertura email
        const d = await query("SELECT id, email, nome_studio, campaign_id FROM companies WHERE id = (SELECT company_id FROM email_tracking WHERE id = $1)", [trackingId]).catch(() => ({ rows: [] }));
        if (d.rows[0]?.email) {
          await addNote(config.cmsSiteId, d.rows[0].email, "👁️ Email aperta dal destinatario").catch(() => {});
        }
      }
    } catch (_) { /* silent fail tracking */ }
    res.writeHead(200, {
      "Content-Type": "image/gif",
      "Content-Length": 43,
      "Cache-Control": "no-store, no-cache, must-revalidate",
    });
    res.end(Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64"));
  });

  app.get("/track/click/:trackingId", async (req, res) => {
    try {
      const { trackingId } = req.params;
      const url = req.query.url;
      if (trackingId && url) {
        await query(
          "UPDATE companies SET email_clicked_at = COALESCE(email_clicked_at, NOW()) WHERE id = (SELECT company_id FROM email_tracking WHERE id = $1)",
          [trackingId]
        ).catch(() => {});
        await query(
          "INSERT INTO email_events (company_id, event_type, meta, occurred_at) VALUES ((SELECT company_id FROM email_tracking WHERE id = $1), 'click', $2, NOW()) ON CONFLICT DO NOTHING",
          [trackingId, JSON.stringify({ url })]
        ).catch(() => {});
        const companyRow = await query("SELECT id, email, nome_studio, campaign_id FROM companies WHERE id = (SELECT company_id FROM email_tracking WHERE id = $1)", [trackingId]).catch(() => ({ rows: [] }));
        if (companyRow.rows[0]) {
          await query(
            "UPDATE email_sequences SET cancelled_at = NOW(), cancel_reason = 'click' WHERE company_id = $1 AND sent_at IS NULL AND cancelled_at IS NULL",
            [companyRow.rows[0].id]
          ).catch(() => {});
          // CMS: nota di click
          if (companyRow.rows[0].email) {
            await addNote(config.cmsSiteId, companyRow.rows[0].email, `🖱️ Click su link: ${url}`).catch(() => {});
          }
        }
      }
    } catch (_) { /* silent fail tracking */ }
    const destination = req.query.url || "/";
    // Solo path relativi interni: rifiuta anche gli URL protocol-relative ("//host"),
    // le varianti backslash ("/\\host") e i separator con spazi/controlli ("/\t/…", "/ /…")
    // che alcuni client normalizzano come assoluti/scheme-relative.
    const isSafePath = typeof destination === "string"
      && destination.startsWith("/")
      && !destination.startsWith("//")
      && !destination.startsWith("/\\")
      && !/^\/[\s\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(destination);
    if (!isSafePath) return res.redirect(302, "/");
    res.redirect(302, destination);
  });

  app.get("/health", async (req, res) => {
    const checks = {
      db: false,
      browser: !isBrowserEnabled() ? "disabled" : false,
      uptime: process.uptime(),
      memory_mb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
    };
    try {
      await query("SELECT 1");
      checks.db = true;
    } catch (err) {
      logger.warn("Health check DB failed", { error: err.message });
    }
    if (isBrowserEnabled()) {
      try {
        const b = await getBrowser();
        checks.browser = b?.isConnected() || "not_started";
      } catch (err) {
        checks.browser = false;
      }
    }
    const ok = checks.db;
    res.status(ok ? 200 : 503).json({ ok, checks });
  });

  app.get("/metrics", async (req, res) => {
    try {
      const token = req.cookies?.token;
      if (!token) return res.status(401).json({ error: "Autenticazione richiesta" });
      let user;
      try { user = jwt.verify(token, config.jwtSecret, { algorithms: ["HS256"] }); }
      catch (err) {
        logger.warn("Metrics JWT verification failed", { error: err.message });
        return res.status(401).json({ error: "Token non valido" });
      }
      if (user.role !== "superadmin") return res.status(403).json({ error: "Accesso negato" });

      const [companiesCount, municipalitiesCount, emailCount, approvedCount, sentCount] = await Promise.all([
        query("SELECT COUNT(*)::int AS count FROM companies"),
        query("SELECT COUNT(*)::int AS count FROM municipalities"),
        query("SELECT COUNT(*)::int AS count FROM companies WHERE bozza_creata = true"),
        query("SELECT COUNT(*)::int AS count FROM companies WHERE approvato = true"),
        query("SELECT COUNT(*)::int AS count FROM companies WHERE inviato = true"),
      ]);
      const mem = process.memoryUsage();
      res.json({
        uptime: Math.floor(process.uptime()),
        memory_mb: Math.round(mem.heapUsed / 1024 / 1024),
        companies_total: companiesCount.rows[0].count,
        municipalities_total: municipalitiesCount.rows[0].count,
        emails_generated: emailCount.rows[0].count,
        emails_approved: approvedCount.rows[0].count,
        emails_sent: sentCount.rows[0].count,
        db: "ok",
      });
    } catch (err) {
      logger.error("Metrics error", { error: err.message });
      res.status(500).json({ error: "Errore metrics" });
    }
  });

  app.get("/dashboard", async (req, res) => {
    if (!req.user) return res.redirect("/login");
    const now = Date.now();
    // dashboard cache TTL 30 secondi
    const _dashCache = global._dashboardCache || {};
    if (_dashCache.data && _dashCache.time && (now - _dashCache.time) < 30000) {
      return res.render("dashboard", _dashCache.data);
    }
    if (global._dashboardCachePending) {
      await global._dashboardCachePending;
      const cached = global._dashboardCache || {};
      if (cached.data) return res.render("dashboard", cached.data);
    }
    let resolvePending = null;
    global._dashboardCachePending = new Promise(r => { resolvePending = r; });
    try {
      const [
        total, conEmail, conBozza, approvati, inviati,
        comuniEseguiti, totalComuni, aperti, cliccati, bounced,
          dailySends, provinceDist, provinceDetail, allProvince,
          dailySparkline, followupPending, pendingApproval, readyToSend, overdueFollowups, unprocessedMunicipalities, aiStats
        ] = await Promise.all([
        query("SELECT COUNT(*)::int FROM companies"),
        query("SELECT COUNT(*)::int FROM companies WHERE email IS NOT NULL AND email != ''"),
        query("SELECT COUNT(*)::int FROM companies WHERE bozza_creata = true"),
        query("SELECT COUNT(*)::int FROM companies WHERE approvato = true"),
        query("SELECT COUNT(*)::int FROM companies WHERE inviato = true"),
        query("SELECT COUNT(*)::int FROM municipalities WHERE eseguito = true"),
        query("SELECT COUNT(*)::int FROM municipalities"),
        query("SELECT COUNT(*)::int FROM companies WHERE email_opened_at IS NOT NULL"),
        query("SELECT COUNT(*)::int FROM companies WHERE email_clicked_at IS NOT NULL"),
        query("SELECT COUNT(*)::int FROM companies WHERE email_bounced = true"),
        query(`SELECT DATE(inviato_at) AS giorno, COUNT(*)::int AS cnt
               FROM companies WHERE inviato_at IS NOT NULL
               GROUP BY DATE(inviato_at) ORDER BY giorno DESC LIMIT 30`),
        query(`SELECT provincia, COUNT(*)::int AS cnt
               FROM companies WHERE inviato = true AND provincia IS NOT NULL
               GROUP BY provincia ORDER BY cnt DESC LIMIT 10`),
        query(`SELECT provincia,
                      COUNT(*)::int AS totale,
                      COUNT(*) FILTER (WHERE bozza_creata) AS bozze,
                      COUNT(*) FILTER (WHERE approvato) AS approvate,
                      COUNT(*) FILTER (WHERE inviato) AS inviate,
                      COUNT(*) FILTER (WHERE email_opened_at IS NOT NULL) AS aperte
               FROM companies
               WHERE provincia IS NOT NULL
               GROUP BY provincia
               ORDER BY totale DESC
               LIMIT 20`),
        query(`SELECT provincia FROM companies WHERE provincia IS NOT NULL GROUP BY provincia ORDER BY provincia`),
        query(`SELECT giorno, COALESCE(trovati, 0) AS totali, COALESCE(inviati, 0) AS inviati, COALESCE(approvati, 0) AS approvati, COALESCE(bozze, 0) AS bozze FROM (SELECT DATE(created_at) AS giorno, COUNT(*) AS trovati, 0 AS inviati, 0 AS approvati, 0 AS bozze FROM companies WHERE created_at > NOW() - INTERVAL '7 days' GROUP BY DATE(created_at) UNION ALL SELECT DATE(inviato_at) AS giorno, 0, COUNT(*), 0, 0 FROM companies WHERE inviato_at > NOW() - INTERVAL '7 days' GROUP BY DATE(inviato_at) UNION ALL SELECT DATE(updated_at) AS giorno, 0, 0, COUNT(*), 0 FROM companies WHERE approvato = true AND updated_at > NOW() - INTERVAL '7 days' GROUP BY DATE(updated_at) UNION ALL SELECT DATE(created_at) AS giorno, 0, 0, 0, COUNT(*) FROM companies WHERE bozza_creata = true AND created_at > NOW() - INTERVAL '7 days' GROUP BY DATE(created_at)) sub ORDER BY giorno`),
        query(`SELECT COUNT(*)::int FROM email_sequences WHERE sent_at IS NULL AND cancelled_at IS NULL AND scheduled_at <= NOW() + INTERVAL '7 days'`),
        query(`SELECT COUNT(*)::int FROM companies WHERE bozza_creata = true AND approvato = false AND (inviato = false OR inviato IS NULL)`),
        query(`SELECT COUNT(*)::int FROM companies WHERE approvato = true AND inviato = false`),
        query(`SELECT COUNT(*)::int FROM email_sequences WHERE sent_at IS NULL AND cancelled_at IS NULL AND scheduled_at <= NOW()`),
        query(`SELECT COUNT(*)::int FROM municipalities WHERE eseguito = false OR eseguito IS NULL`),
        query(`SELECT
          COUNT(*) FILTER (WHERE action = 'generate_email')::int AS generate,
          COUNT(*) FILTER (WHERE action = 'rewrite_email')::int AS rewrite,
          COUNT(*) FILTER (WHERE action = 'extract_from_website')::int AS extraction
         FROM audit_log WHERE action IN ('generate_email','rewrite_email','extract_from_website') AND created_at > NOW() - INTERVAL '7 days'`),
      ]);

      const apertiCount = aperti.rows[0]?.count || 0;
      const cliccatiCount = cliccati.rows[0]?.count || 0;
      const bouncedCount = bounced.rows[0]?.count || 0;
      const invCount = inviati.rows[0]?.count || 0;
      const inv = invCount || 1;
      const openRate = inv > 0 ? Math.round((apertiCount / inv) * 100) : 0;
      const clickRate = inv > 0 ? Math.round((cliccatiCount / inv) * 100) : 0;
      const bounceRate = inv > 0 ? Math.round((bouncedCount / inv) * 100) : 0;

      const fullStats = {
        total: total.rows[0].count,
        conEmail: conEmail.rows[0].count,
        conBozza: conBozza.rows[0].count,
        approvati: approvati.rows[0].count,
        inviati: invCount,
        comuniEseguiti: comuniEseguiti.rows[0].count,
        totalComuni: totalComuni.rows[0].count,
        aperti: apertiCount,
        cliccati: cliccatiCount,
        bounced: bouncedCount,
        openRate,
        clickRate,
        bounceRate,
        dailySends: dailySends.rows,
        provinceDist: provinceDist.rows,
        provinceDetail: provinceDetail.rows,
        allProvince: allProvince.rows,
        dailySparkline: dailySparkline.rows,
        followupPending: followupPending.rows[0].count,
        pendingApproval: pendingApproval.rows[0].count,
        readyToSend: readyToSend.rows[0].count,
        overdueFollowups: overdueFollowups.rows[0].count,
        unprocessedMunicipalities: unprocessedMunicipalities.rows[0].count,
        aiStats: aiStats.rows[0],
      };
      global._dashboardCache = { data: { stats: fullStats }, time: Date.now() }; if (typeof resolvePending === 'function') resolvePending(); global._dashboardCachePending = null;
      res.render("dashboard", { stats: fullStats });
    } catch (err) {
      logger.error("Dashboard error", { error: err.message });
      if (global._dashboardCachePending) {
        try { if (typeof resolvePending === 'function') resolvePending(); } catch (_) {}
        global._dashboardCachePending = null;
      }
      res.render("dashboard", { stats: null });
    }
  });


  app.use(async (req, res, next) => {
    if (!req.user) return next();
    if (req.path === '/admin/wizard' || req.path === '/login' || req.path === '/login/verify' || req.path.startsWith('/api/')) return next();
    if (req.user.role !== 'superadmin' && req.user.role !== 'admin') return next();
    try {
      const completed = getSetting('wizard_completed');
      if (completed === 'true') return next();
      const infoResult = await query("SELECT info_azienda FROM direzione LIMIT 1");
      const munResult = await query("SELECT COUNT(*)::int FROM municipalities WHERE eseguito = true");
      if ((!infoResult.rows[0]?.info_azienda || munResult.rows[0].count === 0) && req.path !== '/login') {
        return res.redirect('/admin/wizard');
      }
      next();
    } catch (_) { next(); }
  });

  app.use("/api/scraper", heavyLimiter);
  app.use("/api/cron", heavyLimiter);
  app.use("/api", apiLimiter);
  // Layer agente/MCP (rotte /api/agent, stile CMS). Montato QUI — subito dopo
  // l'apiLimiter e PRIMA dei router con `router.use(requireAuth)` senza path
  // (direzione, scraper, ecc.): quei router, montati a root, agirebbero come
  // middleware globale user-JWT e intercetterebbero /api/agent/me prima del
  // nostro requireAgent (Bearer agtok_). Con l'auth agente interna a
  // middleware/agent-auth.js resta comunque tutto protetto.
  app.use(agentRoutes);
  app.use("/api/mcp", mcpLimiter);
  app.use(mcpRoutes);
  app.use(i18nRoutes);
  app.use(authRoutes);
  app.use(companiesRoutes);
  app.use(municipalitiesRoutes);
  app.use(direzioneRoutes);
  app.use(scraperRoutes);
  app.use(cronRoutes);
  app.use(usersRoutes);
  app.use(settingsRoutes);
  app.use(webhookRoutes);
  app.use(campaignRoutes);
  app.use(followupSequencesRoutes);
  // GHL rimosso a favore del CMS agent-first (fase 2): route legacy eliminate (fase 10).
  app.use(sendScheduleRoutes);
  app.use(bugReportsRoutes);
  app.use(imapRoutes);
  app.use(todayRoutes);
  app.use(searchRoutes);
  app.use(wizardRoutes);
  app.use(apiTokensAdminRoutes);
  app.use(tenantsAdminRoutes);

  // Bug report page routes
  app.get("/bug-reports", requireAuth, async (req, res) => {
    res.render("admin/bug-reports-list");
  });
  app.get("/bug-reports/new", requireAuth, async (req, res) => {
    res.render("admin/bug-reports-form");
  });
  app.get("/bug-reports/:id", requireAuth, async (req, res) => {
    try {
      const result = await query(
        `SELECT br.*, u.name AS user_name, u.surname AS user_surname, u.email AS user_email
         FROM bug_reports br LEFT JOIN users u ON u.id = br.user_id WHERE br.id = $1`,
        [req.params.id]
      );
      if (result.rows.length === 0) return res.status(404).render("errors/not-found");
      res.render("admin/bug-reports-detail", { report: result.rows[0] });
    } catch (err) {
      logger.error("Error loading bug report", { error: err.message });
      res.status(500).render("error", { message: "Errore caricamento" });
    }
  });

  // Wrapper per handler async Express 4 — evita unhandledRejection
  const asyncH = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

  app.get("/api/admin/report", requireAuth, requireAdmin, asyncH(async (req, res) => {
    const daysParam = parseInt(req.query.period, 10); const days = !isNaN(daysParam) && daysParam > 0 ? daysParam : 7;
    const result = await query(`
      SELECT d.provincia,
        COUNT(*)::int AS totale,
        COUNT(*) FILTER (WHERE d.inviato) AS inviate,
        COUNT(*) FILTER (WHERE d.email_opened_at IS NOT NULL) AS aperte,
        COUNT(*) FILTER (WHERE d.email_clicked_at IS NOT NULL) AS cliccate,
        COUNT(*) FILTER (WHERE d.email_bounced) AS bounced
      FROM companies d
      WHERE d.created_at > NOW() - $1::interval
      GROUP BY d.provincia ORDER BY d.provincia
    `, [`${days} days`]);
    const csv = stringify(result.rows, { header: true, delimiter: ',' });
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="report-${days}d.csv"`);
    res.send(csv);
  }));

  app.use((req, res) => {
    if (req.path.startsWith("/api")) return res.status(404).json({ error: "Endpoint non trovato" });
    res.status(404).render("errors/not-found");
  });

  app.use((err, req, res, next) => {
    logger.error("Request error", { method: req.method, path: req.path, error: err.message, stack: config.nodeEnv !== "production" ? err.stack : undefined });
    if (req.path.startsWith("/api")) {
      return res.status(err.status || 500).json({ error: "Errore interno" });
    }
    res.status(err.status || 500).render("error", { message: "Errore interno" });
  });

  server = app.listen(config.port, async () => {
    logger.info(`${config.brand.name} running on port ${config.port}`);

    try {
      const cron = (await import("node-cron")).default;

      function safeCron(name, settingKey, fn) {
        return async () => {
          try {
            if (settingKey) {
              const enabled = getSetting(settingKey);
              if (enabled === 'false') return;
            }
            await fn();
          } catch (err) {
            logger.error("Cron execution failed", { cron: name, error: err.message });
          }
        };
      }

      cron.schedule("*/3 * * * *", safeCron("municipality", "cron_municipality_enabled", async () => {
        const ok = await withLock("municipality", processMunicipalities, 1200);
        if (!ok) logger.warn("Lock municipality busy, skip");
      }));

      cron.schedule("*/10 * * * *", safeCron("emailDraft", "cron_draft_enabled", async () => {
        const ok = await withLock("emailDraft", generateEmailDrafts, 600);
        if (!ok) logger.warn("Lock emailDraft busy, skip");
      }));

      cron.schedule("0 3 * * *", safeCron("cleanup", null, async () => {
        const ok = await withLock("cleanup", cleanupErrors, 300);
        if (!ok) logger.warn("Lock cleanup busy, skip");
      }), { timezone: "Europe/Rome" });

      cron.schedule("30 3 * * *", safeCron("cleanupMagicLinks", null, async () => {
        const ok = await withLock("cleanupMagicLinks", async () => {
          const result = await query("DELETE FROM magic_links WHERE expires_at < NOW() - INTERVAL '1 day' OR (used_at IS NOT NULL AND created_at < NOW() - INTERVAL '7 days')");
          if (result.rowCount > 0) {
            logger.info(`Pulizia magic_links: ${result.rowCount} record eliminati`);
          }
        }, 120);
        if (!ok) logger.warn("Lock cleanupMagicLinks busy, skip");
      }), { timezone: "Europe/Rome" });

      cron.schedule("0 * * * *", safeCron("followUp", "cron_followup_enabled", async () => {
        const ok = await withLock("followUp", processFollowUps, 300);
        if (!ok) logger.warn("Lock followUp busy, skip");
      }));

      // Generazione bozze followup per-azienda — ogni 30 minuti
      cron.schedule("*/30 * * * *", safeCron("generateFollowUpDrafts", "cron_followup_enabled", async () => {
        const ok = await withLock("generateFollowUpDrafts", () => generateFollowUpDrafts(null, null), 600);
        if (!ok) logger.warn("Lock generateFollowUpDrafts busy, skip");
      }));

      cron.schedule("* * * * *", safeCron("emailQueue", "cron_queue_enabled", async () => {
        const ok = await withLock("emailQueue", processEmailQueue, 300);
        if (!ok) logger.warn("Lock emailQueue busy, skip");
      }));

      cron.schedule("*/30 * * * *", safeCron("retryFailed", "cron_queue_enabled", async () => {
        const ok = await withLock("retryFailed", retryFailedEmails, 120);
        if (!ok) logger.warn("Lock retryFailed busy, skip");
      }));

cron.schedule("1 0 * * *", safeCron("smtpReset", null, async () => {
  const ok = await withLock("smtpReset", resetDailyCounts, 60);
  if (!ok) logger.warn("Lock smtpReset busy, skip");
}), { timezone: "Europe/Rome" });

      cron.schedule("*/2 * * * *", safeCron("cmsSync", null, async () => {
        const ok = await withLock("cmsSync", processCmsSync, 120);
        if (!ok) logger.warn("Lock cmsSync busy, skip");
      }));

      // CMS engagement (inviata/aperta/cliccata) — ogni 10 minuti
      cron.schedule("*/10 * * * *", safeCron("cmsEngagement", null, async () => {
        const ok = await withLock("cmsEngagement", processCmsEngagementSync, 120);
        if (!ok) logger.warn("Lock cmsEngagement busy, skip");
      }));

      // IMAP reply checker — ogni 10 minuti per ogni account SMTP attivo
      cron.schedule("*/10 * * * *", safeCron("imapReplies", null, async () => {
        try {
          const { checkReplies } = await import("./services/imap-checker.js");
          const accounts = await query(
            "SELECT * FROM smtp_accounts WHERE imap_host IS NOT NULL AND is_active = true"
          );
          for (const acc of accounts.rows) {
            await checkReplies(acc).catch(e =>
              logger.error("IMAP check fallito", { account: acc.id, error: e.message })
            );
          }
        } catch (e) {
          logger.error("IMAP reply checker fallito", { error: e.message });
        }
      }));

      cron.schedule("0 * * * *", safeCron("cacheCleanup", null, async () => {
        const result = await query("DELETE FROM response_cache WHERE expires_at < NOW()");
        if (result.rowCount > 0) {
          logger.info(`Pulizia response_cache: ${result.rowCount} record eliminati`);
        }
      }));

      // Alert automatizzati sul funnel (requisito 10) — ogni ora, soglie in settings.
      cron.schedule("20 * * * *", safeCron("funnelAlerts", "funnel_alert_enabled", async () => {
        const ok = await withLock("funnelAlerts", checkFunnelAlerts, 120);
        if (!ok) logger.warn("Lock funnelAlerts busy, skip");
      }));

      logger.info("Job scheduler avviato (cron)");
    } catch (e) {
      logger.warn(`node-cron non disponibile, scheduler disabilitato: ${e.message}`);
    }
  });
}

start().catch(err => {
  logger.error("Failed to start server", { error: err.message, stack: err.stack });
  process.exit(1);
});

function gracefulShutdown(err, type) {
  logger.error(type, { error: err?.message || err, stack: err?.stack });
  shutdownBrowser().catch(() => {});
  if (server) {
    server.close(() => process.exit(1));
  } else {
    process.exit(1);
  }
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled Rejection", { error: reason?.message || String(reason), stack: reason?.stack });
});
process.on("uncaughtException", (err) => gracefulShutdown(err, "Uncaught Exception"));
