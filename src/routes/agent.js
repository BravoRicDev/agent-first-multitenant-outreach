import { Router } from "express";
import { query } from "../db.js";
import scopeTenant from "../services/scope-tenant.js";
import { requireAgent, agentLimiter } from "../middleware/agent-auth.js";
import { authorize } from "../middleware/authorize.js";
import { getDailyDispatchState, isDailyCapReached, isWithinSendWindow } from "../services/send-schedule.js";
import { enforceConsent } from "../services/email-sender.js";
import { isTestModeEnabled, listTestRecipients, addTestRecipient, removeTestRecipient } from "../services/test-mode.js";
import { setSetting } from "../services/settings.js";
import { computeFunnelMetrics } from "../services/funnel-metrics.js";
import {
  isCmsConfigured,
  upsertContact,
  getContactConsent,
  setContactOptOut,
  syncCompanyWithCms,
  ensureOpportunityForReply,
  ensureOpportunityForStage,
  addNote,
} from "../services/cms.js";
import { logger } from "../services/logger.js";
import config from "../config.js";

const router = Router();

// Ogni rotta /api/agent è protetta dal middleware agente (Bearer agtok_)
// e soggetta al rate limit dedicato. Le rotte sono definite col path completo
// "/api/agent/..." (stile CMS agent-first) perché mcp-tools.js le introspeziona
// iterando layer.route.path che deve iniziare con "/api/agent".
router.use("/api/agent", agentLimiter);
router.use("/api/agent", requireAgent);

// GET /api/agent/me — identità dell'account agente autenticato
router.get("/api/agent/me", async (req, res, next) => {
  try {
    res.json({
      agent: true,
      service: "outreach-service",
      user: {
        id: req.user.sub,
        email: req.user.email,
        name: req.user.name,
        role: req.user.role,
      },
      auth: "api_token",
    });
  } catch (err) {
    next(err);
  }
});

// ── Campagne ────────────────────────────────────────────────────────────────
// Solo lettura/config: nessun invio reale da queste rotte (l'invio avviene
// esclusivamente tramite i flussi batch del CMS/UI con relativo gate di
// consenso). Ogni rotta è read-only e protetta da requireAgent (montato sopra).

// GET /api/agent/campaigns — lista campagne con metriche aggregate
router.get("/api/agent/campaigns", async (req, res, next) => {
  try {
    const tenantId = req.user.tenant_id;
    const tenantScope = scopeTenant(tenantId);
    const result = await query(
      `SELECT c.id, c.name, c.is_active, c.created_at,
              c.daily_email_limit,
              sa.name AS smtp_name, sa.from_email AS smtp_from,
              COUNT(d.id)::int AS totale_aziende,
              COUNT(d.id) FILTER (WHERE d.inviato)::int AS inviate,
              COUNT(d.id) FILTER (WHERE d.email_opened_at IS NOT NULL)::int AS aperte,
              COUNT(d.id) FILTER (WHERE d.email_clicked_at IS NOT NULL)::int AS cliccate,
              COUNT(d.id) FILTER (WHERE d.email_bounced)::int AS bounced
       FROM campaigns c
       LEFT JOIN companies d ON d.campaign_id = c.id
       LEFT JOIN smtp_accounts sa ON sa.id = c.smtp_account_id
       ${tenantScope.condition ? `WHERE 1=1${tenantScope.condition.replaceAll("tenant_id", "c.tenant_id")}` : ""}
       GROUP BY c.id, sa.name, sa.from_email
       ORDER BY c.created_at DESC`,
      tenantScope.values
    );
    res.json({ campaigns: result.rows });
  } catch (err) {
    logger.error("Agent campaigns list error", { error: err.message });
    next(err);
  }
});

// GET /api/agent/campaigns/:id — dettaglio configurazione campagna (read-only)
router.get("/api/agent/campaigns/:id", async (req, res, next) => {
  try {
    const tenantId = req.user.tenant_id;
    const tenantScope = scopeTenant(tenantId, 2);
    const result = await query(
      `SELECT c.id, c.name, c.is_active, c.created_at,
              c.cms_pipeline_id, c.daily_email_limit, c.followup_prompt,
              c.use_html, c.reply_to_email, c.from_name_override, c.from_email_override,
              LENGTH(c.email_template) AS email_template_chars,
              sa.name AS smtp_name, sa.from_email AS smtp_from
       FROM campaigns c
       LEFT JOIN smtp_accounts sa ON sa.id = c.smtp_account_id
       WHERE c.id = $1 ${tenantScope.condition.replaceAll("tenant_id", "c.tenant_id")}`,
      [req.params.id, tenantScope.values[0]]
    );
    if (result.rows.length === 0) return res.status(404).json({errorKey: "error.campaign_not_found" });
    res.json({ campaign: result.rows[0] });
  } catch (err) {
    logger.error("Agent campaign detail error", { error: err.message });
    next(err);
  }
});

// GET /api/agent/campaigns/:id/stato — stato operativo di una campagna
router.get("/api/agent/campaigns/:id/stato", async (req, res, next) => {
  try {
    const tenantId = req.user.tenant_id;
    const tenantScope = scopeTenant(tenantId, 2);
    const camp = await query(
      `SELECT id, name, is_active, daily_email_limit FROM campaigns WHERE id = $1 ${tenantScope.condition}`,
      [req.params.id, tenantScope.values[0]]
    );
    if (camp.rows.length === 0) return res.status(404).json({errorKey: "error.campaign_not_found" });

    const stats = await query(
      `SELECT COUNT(d.id)::int AS totale,
              COUNT(d.id) FILTER (WHERE d.bozza_creata)::int AS bozze,
              COUNT(d.id) FILTER (WHERE d.approvato)::int AS approvate,
              COUNT(d.id) FILTER (WHERE d.inviato)::int AS inviate,
              COUNT(d.id) FILTER (WHERE d.email_opened_at IS NOT NULL)::int AS aperte,
              COUNT(d.id) FILTER (WHERE d.email_clicked_at IS NOT NULL)::int AS cliccate,
              COUNT(d.id) FILTER (WHERE d.email_bounced)::int AS bounced,
              COUNT(d.id) FILTER (WHERE d.consent_status = 'marketing' AND d.unsubscribed_at IS NULL)::int AS consensati_invio
       FROM companies d WHERE d.campaign_id = $1 ${tenantScope.condition}`,
      [req.params.id, tenantScope.values[0]]
    );
    // Invii di oggi per questa campagna (rispetto al daily cap specifico)
    const todayCamp = await query(
      `SELECT COUNT(*)::int AS inviati_oggi FROM companies
       WHERE campaign_id = $1 ${tenantScope.condition} AND inviato_at >= ((NOW() AT TIME ZONE 'Europe/Rome')::date) AT TIME ZONE 'Europe/Rome'`,
      [req.params.id, tenantScope.values[0]]
    );
    const c = camp.rows[0];
    const dailyCap = c.daily_email_limit || null;
    res.json({
      campaign: { id: c.id, name: c.name, is_active: c.is_active },
      stats: stats.rows[0],
      daily: {
        daily_email_limit: dailyCap,
        inviati_oggi: todayCamp.rows[0].inviati_oggi,
        cap_raggiunto: dailyCap !== null && todayCamp.rows[0].inviati_oggi >= dailyCap,
      },
    });
  } catch (err) {
    logger.error("Agent campaign stato error", { error: err.message });
    next(err);
  }
});

// ── Send schedule ───────────────────────────────────────────────────────────

// GET /api/agent/send-schedule — fascia oraria consentita + daily cap
router.get("/api/agent/send-schedule", async (req, res, next) => {
  try {
    const tenantId = req.user.tenant_id;
    const tenantScope = scopeTenant(tenantId);
    const [slots, daily, window] = await Promise.all([
      query(
        `SELECT dow, hour, allowed FROM send_schedule WHERE allowed = true ${tenantScope.condition} ORDER BY dow, hour`,
        tenantScope.values
      ),
      getDailyDispatchState(),
      isWithinSendWindow(),
    ]);
    res.json({
      send_schedule: slots.rows,
      daily: {
        sent_today: daily.sentToday,
        max_per_day: daily.maxDaily,
        cap_raggiunto: isDailyCapReached(daily),
      },
      now: {
        in_finestra: window.allowed,
        motivo: window.reason,
      },
    });
  } catch (err) {
    logger.error("Agent send-schedule error", { error: err.message });
    next(err);
  }
});

// ── Prospect / aziende ──────────────────────────────────────────────────────
// Ingestione dati GIÀ scrappati dall'agente esterno (mai scraping dal servizio).
// Nessuna duplicazione di CRM: consenso/opportunità restano sul CMS (src/services/cms.js).

const COMPANY_LIST_FIELDS =
  "id, title, comune, provincia, consent_status, inviato, bozza_creata, email, website, campaign_id, funnel_stage";

// Funnel B2B lato outreach (vedi GAP-ANALYSIS-FUNNEL.md): prospect -> contacted ->
// called -> booked -> demo -> won/lost. L'ordine dell'array serve anche a decidere se
// un aggiornamento automatico (call-outcome/booking) può "avanzare" lo stage senza
// mai retrocedere uno stage già più avanti (es. non declassare un "demo" a "called").
const FUNNEL_STAGES = ["prospect", "contacted", "called", "booked", "demo", "won", "lost"];
const CALL_STATUSES = ["da_chiamare", "non_risponde", "richiamare", "non_interessato", "interessato"];
const BOOKING_STATUSES = ["da_prenotare", "prenotato", "effettuata", "no_show", "annullata"];

// GET /api/agent/companies — lista aziende con filtri base
router.get("/api/agent/companies", async (req, res, next) => {
  try {
    const tenantId = req.user.tenant_id;
    const tenantScope = scopeTenant(tenantId);
    const { campaign_id, consent, q, inviato, funnel_stage } = req.query;
    const conditions = [];
    const params = [];
    let idx = 1;

    if (campaign_id) {
      conditions.push(`campaign_id = $${idx++}`);
      params.push(parseInt(campaign_id, 10));
    }
    if (consent) {
      conditions.push(`consent_status = $${idx++}`);
      params.push(consent);
    }
    if (funnel_stage) {
      if (!FUNNEL_STAGES.includes(funnel_stage)) {
        return res.status(400).json({ error: `funnel_stage deve essere uno tra: ${FUNNEL_STAGES.join(", ")}` });
      }
      conditions.push(`funnel_stage = $${idx++}`);
      params.push(funnel_stage);
    }
    if (inviato === "true") conditions.push("inviato = true");
    else if (inviato === "false") conditions.push("(inviato = false OR inviato IS NULL)");
    if (q) {
      conditions.push(`(title ILIKE $${idx} OR email ILIKE $${idx} OR comune ILIKE $${idx} OR website ILIKE $${idx})`);
      params.push(`%${q}%`);
      idx++;
    }

    if (tenantScope.condition) {
      conditions.push(`tenant_id =$${idx++})`);
      params.push(tenantId);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const result = await query(
      `SELECT ${COMPANY_LIST_FIELDS} FROM companies ${where} ORDER BY updated_at DESC LIMIT $${idx}`,
      [...params, limit]
    );
    res.json({ companies: result.rows });
  } catch (err) {
    logger.error("Agent companies list error", { error: err.message });
    next(err);
  }
});

// GET /api/agent/companies/search?q= — ricerca full-text (deve precedere /:id)
router.get("/api/agent/companies/search", async (req, res, next) => {
  try {
    const tenantId = req.user.tenant_id;
    const tenantScope = scopeTenant(tenantId, 2);
    const q = (req.query.q || "").trim();
    if (!q) return res.status(400).json({ error: "Parametro q richiesto" });
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const result = await query(
      `SELECT ${COMPANY_LIST_FIELDS} FROM companies
       WHERE (title ILIKE $1 OR email ILIKE $1 OR comune ILIKE $1 OR website ILIKE $1) ${tenantScope.condition}
       ORDER BY updated_at DESC LIMIT $3`,
      [`%${q}%`, tenantScope.values[0], limit]
    );
    res.json({ companies: result.rows });
  } catch (err) {
    logger.error("Agent companies search error", { error: err.message });
    next(err);
  }
});

// POST /api/agent/companies/ingest — upsert prospect (dati già scrappati dall'agente)
router.post("/api/agent/companies/ingest", async (req, res, next) => {
  try {
    const {
      email, title, address, comune, provincia, cap, website, phone_number,
      position, category, descrizione, booking_links, campaign_id, tags,
    } = req.body || {};

    if (!email || typeof email !== "string" || !email.trim()) {
      return res.status(400).json({ error: "email richiesta" });
    }
    const emailNorm = email.trim().toLowerCase();
    const websiteNorm = website && typeof website === "string" && website.trim() ? website.trim() : null;

    const existing = await query(
      `SELECT id FROM companies
       WHERE tenant_id = $1 AND (LOWER(email) = $2
          OR ($3::text IS NOT NULL AND LOWER(website) = LOWER($3)))
       ORDER BY (LOWER(email) = $2) DESC
       LIMIT 1`,
      [req.user.tenant_id, emailNorm, websiteNorm]
    );

    let company;
    let created = false;

    if (existing.rows.length > 0) {
      const fields = [];
      const params = [];
      let idx = 1;
      const set = (col, val) => {
        if (val !== undefined && val !== null && val !== "") {
          fields.push(`${col} = $${idx++}`);
          params.push(val);
        }
      };
      set("email", emailNorm);
      set("title", title);
      set("address", address);
      set("comune", comune);
      set("provincia", provincia);
      set("cap", cap);
      set("website", websiteNorm);
      set("phone_number", phone_number);
      set("position", position);
      set("category", category);
      set("descrizione", descrizione);
      set("booking_links", booking_links);
      if (campaign_id !== undefined) {
        fields.push(`campaign_id = $${idx++}`);
        params.push(campaign_id);
      }
      fields.push("updated_at = NOW()");
      params.push(existing.rows[0].id);
      const updated = await query(
        `UPDATE companies SET ${fields.join(", ")} WHERE id = $${idx} RETURNING *`,
        params
      );
      company = updated.rows[0];
    } else {
      const inserted = await query(
        `INSERT INTO companies
           (email, title, address, comune, provincia, cap, website, phone_number,
            position, category, descrizione, booking_links, campaign_id, consent_status, tenant_id,
            created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'cold', $14, NOW(), NOW())
         RETURNING *`,
        [
          emailNorm, title || null, address || null, comune || null, provincia || null, cap || null,
          websiteNorm, phone_number || null, position || null, category || null, descrizione || null,
          booking_links || null, campaign_id || null, req.user.tenant_id,
        ]
      );
      company = inserted.rows[0];
      created = true;
    }

    let cms_synced = false;
    if (isCmsConfigured() && company.email) {
      try {
        await upsertContact(config.cmsSiteId, company.email, {
          tags: Array.isArray(tags) ? tags : (tags ? [String(tags)] : ["outreach"]),
          notes: company.title || null,
        });
        cms_synced = true;
      } catch (err) {
        logger.warn("Agent ingest: CMS upsertContact fallito (best-effort)", { companyId: company.id, error: err.message });
      }
    }

    res.status(created ? 201 : 200).json({ company, created, cms_synced });
  } catch (err) {
    if (err.code === "23505") return res.status(409).json({ error: "Conflitto: email o website già associati ad un'altra azienda" });
    logger.error("Agent ingest error", { error: err.message });
    next(err);
  }
});

// GET /api/agent/companies/:id — dettaglio completo
router.get("/api/agent/companies/:id", async (req, res, next) => {
  try {
    const tenantId = req.user.tenant_id;
    const tenantScope = scopeTenant(tenantId, 2);
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: "ID non valido" });
    const result = await query(
      `SELECT id, title, address, comune, provincia, cap, website, phone_number, category, position, booking_links,
              nome_studio, descrizione, email, consent_status, unsubscribed_at, approvato, inviato, inviato_at,
              bozza_creata, bozza_email, bozza_email_oggetto, campaign_id, lead_score, has_replied,
              funnel_stage, call_status, call_notes, call_outcome_at, next_call_at,
              booking_status, booking_at, booking_notes, booking_link,
              created_at, updated_at
       FROM companies WHERE id = $1 ${tenantScope.condition}`,
      [id, tenantScope.values[0]]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: "Azienda non trovata" });
    res.json({ company: result.rows[0] });
  } catch (err) {
    logger.error("Agent company detail error", { error: err.message });
    next(err);
  }
});

// PUT /api/agent/companies/:id — aggiorna campi
router.put("/api/agent/companies/:id", async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: "ID non valido" });

    const {
      title, address, comune, provincia, cap, website, phone_number, category, position,
      booking_links, descrizione, notes, consent_status, campaign_id, tags,
    } = req.body || {};

    if (consent_status !== undefined && !["cold", "marketing"].includes(consent_status)) {
      return res.status(400).json({ error: "consent_status deve essere 'cold' o 'marketing'" });
    }

    const fields = [];
    const params = [];
    let idx = 1;
    const set = (col, val) => {
      if (val !== undefined) {
        fields.push(`${col} = $${idx++}`);
        params.push(val);
      }
    };
    set("title", title);
    set("address", address);
    set("comune", comune);
    set("provincia", provincia);
    set("cap", cap);
    set("website", website);
    set("phone_number", phone_number);
    set("category", category);
    set("position", position);
    set("booking_links", booking_links);
    set("descrizione", descrizione !== undefined ? descrizione : notes);
    set("consent_status", consent_status);
    set("campaign_id", campaign_id);

    let company;
    if (fields.length > 0) {
      fields.push("updated_at = NOW()");
      params.push(id);
      const result = await query(`UPDATE companies SET ${fields.join(", ")} WHERE id = $${idx} RETURNING *`, params);
      if (result.rows.length === 0) return res.status(404).json({ error: "Azienda non trovata" });
      company = result.rows[0];
    } else if (tags !== undefined) {
      const found = await query("SELECT * FROM companies WHERE id = $1", [id]);
      if (found.rows.length === 0) return res.status(404).json({ error: "Azienda non trovata" });
      company = found.rows[0];
    } else {
      return res.status(400).json({ error: "Nessun campo da aggiornare" });
    }

    let cms_synced = false;
    if (tags !== undefined && isCmsConfigured() && company.email) {
      try {
        await upsertContact(config.cmsSiteId, company.email, { tags: Array.isArray(tags) ? tags : [String(tags)] });
        cms_synced = true;
      } catch (err) {
        logger.warn("Agent update: CMS tag sync fallito (best-effort)", { companyId: id, error: err.message });
      }
    }

    res.json({ success: true, company, cms_synced });
  } catch (err) {
    if (err.code === "23505") return res.status(409).json({ error: "Conflitto: email o website già in uso" });
    logger.error("Agent company update error", { error: err.message });
    next(err);
  }
});

// ── Email draft ──────────────────────────────────────────────────────────────

// POST /api/agent/companies/:id/draft — genera/rigenera la bozza (riusa cron.generateEmailDrafts)
router.post("/api/agent/companies/:id/draft", async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: "ID non valido" });
    const existing = await query("SELECT id FROM companies WHERE id = $1", [id]);
    if (existing.rows.length === 0) return res.status(404).json({ error: "Azienda non trovata" });

    const { generateEmailDrafts } = await import("./cron.js");
    await generateEmailDrafts([id]);

    const result = await query(
      "SELECT bozza_email, bozza_email_oggetto, bozza_creata, bozza_failed_count FROM companies WHERE id = $1",
      [id]
    );
    const company = result.rows[0];
    if (!company.bozza_creata || !company.bozza_email) {
      return res.status(422).json({
        error: "Generazione bozza non riuscita (dati insufficienti, website mancante, oppure azienda già approvato/inviato)",
        bozza_failed_count: company.bozza_failed_count || 0,
      });
    }
    res.json({ oggetto: company.bozza_email_oggetto, contenuto: company.bozza_email });
  } catch (err) {
    logger.error("Agent draft generation error", { error: err.message });
    next(err);
  }
});

// GET /api/agent/companies/:id/draft — legge la bozza corrente
router.get("/api/agent/companies/:id/draft", async (req, res, next) => {
  try {
    const tenantId = req.user.tenant_id;
    const tenantScope = scopeTenant(tenantId, 2);
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: "ID non valido" });
    const result = await query(
      `SELECT bozza_email, bozza_email_oggetto, bozza_creata FROM companies WHERE id = $1 ${tenantScope.condition}`,
      [id, tenantScope.values[0]]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: "Azienda non trovata" });
    const c = result.rows[0];
    if (!c.bozza_creata || !c.bozza_email) return res.status(404).json({ error: "Nessuna bozza presente" });
    res.json({ oggetto: c.bozza_email_oggetto, contenuto: c.bozza_email });
  } catch (err) {
    logger.error("Agent draft read error", { error: err.message });
    next(err);
  }
});

// ── Invio ────────────────────────────────────────────────────────────────────

// POST /api/agent/companies/:id/send — invio one-to-one manuale cold (riusa la logica di companies.js)
router.post("/api/agent/companies/:id/send", async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: "ID non valido" });
    const result = await query("SELECT * FROM companies WHERE id = $1 AND tenant_id = $2", [id, req.user.tenant_id]);
    if (result.rows.length === 0) return res.status(404).json({ error: "Azienda non trovata" });
    const company = result.rows[0];

    if (company.unsubscribed_at) {
      return res.status(400).json({ esito: "skipped", motivo: "Contatto disiscritto (opt-out): invio non consentito" });
    }
    if (!company.bozza_creata || !company.approvato || company.inviato) {
      return res.status(400).json({
        esito: "skipped",
        motivo: company.inviato ? "Email già inviata" : !company.bozza_creata ? "Nessuna bozza presente" : "Bozza non approvata",
      });
    }

    const consent = enforceConsent(company, { consentContext: "manual", campaignId: company.campaign_id });
    if (!consent.ok) {
      return res.status(400).json({ esito: "skipped", motivo: consent.reason });
    }

    const [dispatch, sendWindow] = await Promise.all([getDailyDispatchState(), isWithinSendWindow()]);
    const capReached = isDailyCapReached(dispatch);

    await query(
      "INSERT INTO email_queue (company_id, provincia, status, send_context, tenant_id) VALUES ($1, $2, 'pending', 'manual', $3) ON CONFLICT (company_id) WHERE status IN ('pending', 'sending') DO NOTHING",
      [company.id, company.provincia, req.user.tenant_id]
    );
    await query(
      `INSERT INTO audit_log (user_id, action, resource, resource_id, details)
       VALUES ($1, 'queue', 'companies', $2, $3)`,
      [req.user.sub, company.id, JSON.stringify({ method: "agent_email_queue" })]
    );
    // Primo contatto cold in uscita: avanza il funnel da "prospect" a "contacted"
    // (mai retrocede uno stage già più avanti, es. un rinvio dopo una chiamata).
    if (company.funnel_stage === "prospect") {
      await query("UPDATE companies SET funnel_stage = 'contacted' WHERE id = $1", [company.id]);
    }

    res.json({
      success: true,
      queued: true,
      esito: "scheduled",
      cap_raggiunto: capReached,
      in_finestra: sendWindow.allowed,
      motivo: !sendWindow.allowed
        ? sendWindow.reason
        : (capReached ? "Limite giornaliero raggiunto: verrà processato quando disponibile" : null),
    });
  } catch (err) {
    logger.error("Agent send error", { error: err.message });
    next(err);
  }
});

// ── Consenso / opt-out ────────────────────────────────────────────────────────

// GET /api/agent/companies/:id/consent — stato consenso (CMS se configurato, altrimenti locale)
router.get("/api/agent/companies/:id/consent", async (req, res, next) => {
  try {
    const tenantId = req.user.tenant_id;
    const tenantScope = scopeTenant(tenantId, 2);
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: "ID non valido" });
    const result = await query(
      `SELECT email, consent_status, consent_source, unsubscribed_at FROM companies WHERE id = $1 ${tenantScope.condition}`,
      [id, tenantScope.values[0]]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: "Azienda non trovata" });
    const company = result.rows[0];

    let source = "local";
    let cmsPreferences = null;
    if (isCmsConfigured() && company.email) {
      try {
        cmsPreferences = await getContactConsent(config.cmsSiteId, company.email);
        if (cmsPreferences) source = "cms";
      } catch (err) {
        logger.warn("Agent consent: lettura CMS fallita, uso stato locale", { companyId: id, error: err.message });
      }
    }

    res.json({
      consent_status: company.consent_status || "cold",
      unsubscribed: !!company.unsubscribed_at,
      source,
      cms_preferences: cmsPreferences,
    });
  } catch (err) {
    logger.error("Agent consent read error", { error: err.message });
    next(err);
  }
});

// POST /api/agent/companies/:id/optout — opt-out totale (blacklist condivisa col CMS)
router.post("/api/agent/companies/:id/optout", async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: "ID non valido" });
    const result = await query(
      "UPDATE companies SET unsubscribed_at = NOW(), updated_at = NOW() WHERE id = $1 RETURNING id, email",
      [id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: "Azienda non trovata" });
    const company = result.rows[0];

    let cms_synced = false;
    if (company.email) {
      const cmsResult = await setContactOptOut(config.cmsSiteId, company.email);
      cms_synced = cmsResult !== null;
    }

    res.json({ success: true, unsubscribed: true, cms_synced });
  } catch (err) {
    logger.error("Agent optout error", { error: err.message });
    next(err);
  }
});

// ── Bridge CMS ────────────────────────────────────────────────────────────────

// POST /api/agent/companies/:id/cms-sync — sync contatto + opportunità se interesse (has_replied)
router.post("/api/agent/companies/:id/cms-sync", async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: "ID non valido" });
    const result = await query("SELECT * FROM companies WHERE id = $1", [id]);
    if (result.rows.length === 0) return res.status(404).json({ error: "Azienda non trovata" });
    const company = result.rows[0];

    const consentStatus = await syncCompanyWithCms(company);
    let opportunity = null;
    if (company.has_replied) {
      opportunity = await ensureOpportunityForReply(company);
    }

    const updated = await query(
      "SELECT consent_status, consent_source, cms_synced_at FROM companies WHERE id = $1",
      [id]
    );
    res.json({
      success: true,
      consent_status: updated.rows[0]?.consent_status || consentStatus || "cold",
      cms_synced_at: updated.rows[0]?.cms_synced_at || null,
      opportunity_synced: !!opportunity,
    });
  } catch (err) {
    logger.error("Agent cms-sync error", { error: err.message });
    next(err);
  }
});

// ── Setting telefonico ────────────────────────────────────────────────────────

// POST /api/agent/companies/:id/call-outcome — registra l'esito di una chiamata di
// setting telefonico. Se l'esito è "interessato", fa avanzare il funnel a "called" e
// garantisce (best-effort) un'opportunità sul CMS; ogni esito aggiunge comunque una
// nota sul contatto CMS (collega l'esito della chiamata alla timeline del contatto,
// gap segnalato in GAP-ANALYSIS-FUNNEL.md tra call-recordings e opportunities del CMS).
router.post("/api/agent/companies/:id/call-outcome", async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: "ID non valido" });
    const { esito, note, richiama_il } = req.body || {};
    if (!esito || !CALL_STATUSES.includes(esito)) {
      return res.status(400).json({ error: `esito deve essere uno tra: ${CALL_STATUSES.join(", ")}` });
    }
    let nextCallAt = null;
    if (richiama_il !== undefined && richiama_il !== null && richiama_il !== "") {
      const d = new Date(richiama_il);
      if (isNaN(d.getTime())) return res.status(400).json({ error: "richiama_il deve essere una data valida (ISO 8601)" });
      nextCallAt = d.toISOString();
    }

    const existing = await query("SELECT * FROM companies WHERE id = $1", [id]);
    if (existing.rows.length === 0) return res.status(404).json({ error: "Azienda non trovata" });
    const company = existing.rows[0];

    const newFunnelStage = esito === "non_interessato"
      ? (company.funnel_stage === "won" ? company.funnel_stage : "lost")
      : (FUNNEL_STAGES.indexOf(company.funnel_stage) < FUNNEL_STAGES.indexOf("called") ? "called" : company.funnel_stage);

    const updated = await query(
      `UPDATE companies
       SET call_status = $1, call_notes = $2, call_outcome_at = NOW(), next_call_at = $3,
           funnel_stage = $4, updated_at = NOW()
       WHERE id = $5
       RETURNING id, call_status, call_notes, call_outcome_at, next_call_at, funnel_stage`,
      [esito, note || null, nextCallAt, newFunnelStage, id]
    );
    const result = updated.rows[0];

    await query(
      `INSERT INTO audit_log (user_id, action, resource, resource_id, details)
       VALUES ($1, 'call_outcome', 'companies', $2, $3)`,
      [req.user.sub, id, JSON.stringify({ esito, richiama_il: nextCallAt })]
    );

    let opportunity_synced = false;
    let cms_note_synced = false;
    if (company.email && isCmsConfigured()) {
      const noteBody = `Esito chiamata (setting telefonico): ${esito}${note ? ` — ${note}` : ""}`;
      const noteResult = await addNote(config.cmsSiteId, company.email, noteBody, "agent", "outreach-service");
      cms_note_synced = !!noteResult;

      if (esito === "interessato") {
        const opp = await ensureOpportunityForStage({ ...company, ...result }, {
          stageKey: "interessato",
          probability: 50,
          notes: note ? `Interessato al telefono: ${note}` : "Interessato al telefono (setting).",
        });
        opportunity_synced = !!opp;
      }
    }

    res.json({ success: true, company: result, opportunity_synced, cms_note_synced });
  } catch (err) {
    logger.error("Agent call-outcome error", { error: err.message });
    next(err);
  }
});

// ── Avanzamento funnel ───────────────────────────────────────────────────────

// PUT /api/agent/companies/:id/funnel-stage — imposta esplicitamente lo stage del
// funnel lato outreach (prospect|contacted|called|booked|demo|won|lost). Gli stadi
// "called" e "booked/demo" vengono normalmente aggiornati in automatico da
// call-outcome/booking; questa rotta serve per correzioni manuali o per marcare
// won/lost (esito finale, allineato manualmente col CMS dove vive la vendita vera).
router.put("/api/agent/companies/:id/funnel-stage", async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: "ID non valido" });
    const { stage, note } = req.body || {};
    if (!stage || !FUNNEL_STAGES.includes(stage)) {
      return res.status(400).json({ error: `stage deve essere uno tra: ${FUNNEL_STAGES.join(", ")}` });
    }
    const existing = await query("SELECT id, email FROM companies WHERE id = $1", [id]);
    if (existing.rows.length === 0) return res.status(404).json({ error: "Azienda non trovata" });
    const company = existing.rows[0];

    const updated = await query(
      "UPDATE companies SET funnel_stage = $1, updated_at = NOW() WHERE id = $2 RETURNING id, funnel_stage",
      [stage, id]
    );

    let cms_note_synced = false;
    if (company.email && isCmsConfigured() && note) {
      const noteResult = await addNote(config.cmsSiteId, company.email, `Funnel: ${stage} — ${note}`, "agent", "outreach-service");
      cms_note_synced = !!noteResult;
    }

    res.json({ success: true, company: updated.rows[0], cms_note_synced });
  } catch (err) {
    logger.error("Agent funnel-stage update error", { error: err.message });
    next(err);
  }
});

// ── Booking / videocall ──────────────────────────────────────────────────────

// POST /api/agent/companies/:id/booking — registra che una videocall è stata
// prenotata/effettuata per questo prospect. NON duplica lo scheduling del CMS
// (moduli calls/availability/booking pubblico): "link" punta all'evento reale creato
// sul CMS o su un calendario esterno, qui si tiene solo lo stato sintetico per far
// avanzare il funnel lato outreach e sincronizzare (best-effort) l'opportunità CMS.
router.post("/api/agent/companies/:id/booking", async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: "ID non valido" });
    const { status, scheduled_at, notes, link } = req.body || {};
    if (!status || !BOOKING_STATUSES.includes(status)) {
      return res.status(400).json({ error: `status deve essere uno tra: ${BOOKING_STATUSES.join(", ")}` });
    }
    let bookingAt = null;
    if (scheduled_at !== undefined && scheduled_at !== null && scheduled_at !== "") {
      const d = new Date(scheduled_at);
      if (isNaN(d.getTime())) return res.status(400).json({ error: "scheduled_at deve essere una data valida (ISO 8601)" });
      bookingAt = d.toISOString();
    }

    const existing = await query("SELECT * FROM companies WHERE id = $1", [id]);
    if (existing.rows.length === 0) return res.status(404).json({ error: "Azienda non trovata" });
    const company = existing.rows[0];

    const stageByStatus = { prenotato: "booked", effettuata: "demo" };
    const targetStage = stageByStatus[status];
    const newFunnelStage = targetStage && FUNNEL_STAGES.indexOf(company.funnel_stage) < FUNNEL_STAGES.indexOf(targetStage)
      ? targetStage
      : company.funnel_stage;

    const updated = await query(
      `UPDATE companies
       SET booking_status = $1, booking_at = $2, booking_notes = $3, booking_link = $4,
           funnel_stage = $5, updated_at = NOW()
       WHERE id = $6
       RETURNING id, booking_status, booking_at, booking_notes, booking_link, funnel_stage`,
      [status, bookingAt, notes || null, link || null, newFunnelStage, id]
    );
    const result = updated.rows[0];

    let opportunity_synced = false;
    let cms_note_synced = false;
    if (company.email && isCmsConfigured()) {
      const noteBody = `Booking videocall: ${status}${bookingAt ? ` il ${bookingAt}` : ""}${notes ? ` — ${notes}` : ""}${link ? ` (${link})` : ""}`;
      const noteResult = await addNote(config.cmsSiteId, company.email, noteBody, "agent", "outreach-service");
      cms_note_synced = !!noteResult;

      if (status === "prenotato" || status === "effettuata") {
        const opp = await ensureOpportunityForStage({ ...company, ...result }, {
          stageKey: status === "effettuata" ? "demo" : "booked",
          probability: status === "effettuata" ? 70 : 55,
          notes: notes || (status === "effettuata" ? "Videocall effettuata." : "Videocall prenotata."),
        });
        opportunity_synced = !!opp;
      }
    }

    res.json({ success: true, company: result, opportunity_synced, cms_note_synced });
  } catch (err) {
    logger.error("Agent booking error", { error: err.message });
    next(err);
  }
});

// ── Stato invio ───────────────────────────────────────────────────────────────

// GET /api/agent/email-queue — coda email recenti
router.get("/api/agent/email-queue", async (req, res, next) => {
  try {
    const tenantId = req.user.tenant_id;
    const tenantScope = scopeTenant(tenantId);
    const { status } = req.query;
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const conditions = [];
    const params = [];
    let idx = 1;
    if (status) {
      conditions.push(`eq.status = $${idx++}`);
      params.push(status);
    }
    if (tenantScope.condition) {
      conditions.push(`(d.tenant_id IS NULL OR d.tenant_id = $${idx++})`);
      params.push(tenantId);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const result = await query(
      `SELECT eq.id, eq.status, eq.error AS evento, eq.send_context, eq.created_at, eq.processed_at,
              d.id AS company_id, d.email, d.title
       FROM email_queue eq
       JOIN companies d ON d.id = eq.company_id
       ${where}
       ORDER BY eq.created_at DESC
       LIMIT $${idx}`,
      [...params, limit]
    );
    res.json({ email_queue: result.rows });
  } catch (err) {
    logger.error("Agent email-queue error", { error: err.message });
    next(err);
  }
});

// ── Modalità test (requisito 7) ────────────────────────────────────────────
// Lettura aperta a qualunque agente autenticato (come le altre GET read-only
// di questo router); le rotte di scrittura richiedono il permesso
// 'settings'/update (RBAC speculare — vedi AGENT.md § Permessi agenti):
// stessa tabella roles_permissions usata dall'admin UI, nessun ruolo nuovo.

// GET /api/agent/test-mode — stato corrente + destinatari di test
router.get("/api/agent/test-mode", async (req, res, next) => {
  try {
    const recipients = await listTestRecipients();
    res.json({ test_mode: isTestModeEnabled(), test_recipients: recipients });
  } catch (err) {
    logger.error("Agent test-mode read error", { error: err.message });
    next(err);
  }
});

// PUT /api/agent/test-mode — attiva/disattiva la modalità test
router.put("/api/agent/test-mode", authorize("settings", "update"), async (req, res, next) => {
  try {
    const { enabled } = req.body || {};
    if (typeof enabled !== "boolean") {
      return res.status(400).json({ error: "enabled deve essere un booleano" });
    }
    await setSetting("test_mode", enabled ? "true" : "false", req.user.sub);
    await query(
      `INSERT INTO audit_log (user_id, action, resource, details) VALUES ($1, 'update', 'test_mode', $2)`,
      [req.user.sub, JSON.stringify({ enabled })]
    );
    res.json({ success: true, test_mode: enabled });
  } catch (err) {
    logger.error("Agent test-mode update error", { error: err.message });
    next(err);
  }
});

// POST /api/agent/test-mode/recipients — aggiunge/aggiorna un destinatario di test
router.post("/api/agent/test-mode/recipients", authorize("settings", "update"), async (req, res, next) => {
  try {
    const { email, note } = req.body || {};
    const recipient = await addTestRecipient(email, note, req.user.sub, req.user.tenant_id);
    res.status(201).json({ success: true, recipient });
  } catch (err) {
    if (err.message?.includes("non valida")) return res.status(400).json({ error: err.message });
    logger.error("Agent test-mode recipient add error", { error: err.message });
    next(err);
  }
});

// DELETE /api/agent/test-mode/recipients/:id — rimuove un destinatario di test
router.delete("/api/agent/test-mode/recipients/:id", authorize("settings", "update"), async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: "ID non valido" });
    const removed = await removeTestRecipient(id);
    if (!removed) return res.status(404).json({ error: "Destinatario di test non trovato" });
    res.json({ success: true });
  } catch (err) {
    logger.error("Agent test-mode recipient remove error", { error: err.message });
    next(err);
  }
});

// ── Metriche funnel (requisito 10) ─────────────────────────────────────────

// GET /api/agent/funnel-metrics — conteggi per stadio, conversion rate tra
// stadi, metriche email, esiti chiamata/booking, prospect bloccati. Solo
// lettura, filtrabile per campagna. Fase 4: scoping per tenant dell'agente.
router.get("/api/agent/funnel-metrics", async (req, res, next) => {
  try {
    const campaignId = req.query.campaign_id ? parseInt(req.query.campaign_id, 10) : null;
    if (req.query.campaign_id && isNaN(campaignId)) {
      return res.status(400).json({ error: "campaign_id deve essere numerico" });
    }
    const stuckDays = req.query.stuck_days ? parseInt(req.query.stuck_days, 10) : 14;
    if (isNaN(stuckDays) || stuckDays < 1) {
      return res.status(400).json({ error: "stuck_days deve essere un intero positivo" });
    }
    const metrics = await computeFunnelMetrics({ campaignId, stuckDays, tenantId: req.user.tenant_id });
    res.json(metrics);
  } catch (err) {
    logger.error("Agent funnel-metrics error", { error: err.message });
    next(err);
  }
});

export default router;
