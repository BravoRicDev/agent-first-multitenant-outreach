import { z } from "zod";
import agentRouter from "../routes/agent.js";
import { logger } from "./logger.js";
import config from "../config.js";

// ─────────────────────────────────────────────────────────────────────────
// Tool set MCP = introspezione del router /api/agent reale + arricchimento
// opzionale. Un endpoint aggiunto/rimosso da agent.js compare/scompare qui
// al riavvio successivo, senza alcuna azione manuale: è la garanzia di
// allineamento richiesta, non una convenzione da ricordare. TOOL_META
// arricchisce con nome/descrizione/schema leggibili gli endpoint noti; un
// endpoint privo di entry resta comunque un tool funzionante (schema
// generico, mai assente). Vedi MCP.md.
//
// Le description sono bilingue ({en, it}, inglese come base/fallback) e
// risolte per lingua in discoverTools(lang) — stessa convenzione EN-base
// usata dal CMS multi-tenant, garantendo coerenza di stile tra il layer
// agente del CMS e quello di questo servizio outreach.
// ─────────────────────────────────────────────────────────────────────────

function pick(lang, dict) {
  if (!dict) return undefined;
  return dict[lang] || dict.en;
}

function camelToSnake(s) {
  return s.replace(/[A-Z]/g, (c) => "_" + c.toLowerCase());
}

function pathParamNames(path) {
  return [...path.matchAll(/:([a-zA-Z0-9_]+)/g)].map((m) => m[1]);
}

// ── TOOL_META — chiave "METHOD /path/con/:param" ────────────────────────────
// Le chiavi dei campi path-param nello schema sono lo snake_case del nome
// camelCase usato nella route reale (:companyId -> company_id, ecc.).
// Conversione automatica e reversibile, nessuna mappa separata da mantenere.

const TOOL_META = {
  // ── Me / Servizio ───────────────────────────────────────────────────────
  "GET /api/agent/me": {
    name: "me",
    description: {
      en: "Identity of the authenticated agent account (service, role and token info).",
      it: "Identità dell'account agente autenticato (servizio, ruolo e info token).",
    },
    inputSchema: {},
  },

  // ── Campagne ──────────────────────────────────────────────────────────────
  "GET /api/agent/campaigns": {
    name: "campaigns_list",
    description: {
      en: "List outreach campaigns with aggregate metrics (sent, opened, clicked, bounced) and daily email limit. Read-only.",
      it: "Elenca le campagne outreach con metriche aggregate (inviate, aperte, cliccate, respinte) e limite giornaliero. Solo lettura.",
    },
    inputSchema: {},
  },
  "GET /api/agent/campaigns/:id": {
    name: "campaigns_get",
    description: {
      en: "Get configuration detail of a single campaign (id, pipeline, limits, template length, SMTP from). Read-only, no secret fields.",
      it: "Dettaglio configurazione di una singola campagna (id, pipeline, limiti, lunghezza template, SMTP from). Solo lettura, nessun campo segreto.",
    },
    inputSchema: {
      id: z.union([z.number(), z.string()]).describe("Campaign id (path param)"),
    },
  },
  "GET /api/agent/campaigns/:id/stato": {
    name: "campaigns_stato",
    description: {
      en: "Operational status of a campaign: draft/approved/sent/opened/clicked/bounced counts and daily cap progress. Read-only.",
      it: "Stato operativo di una campagna: conteggi bozze/approvate/inviate/aperte/cliccate/respinte e avanzamento daily cap. Solo lettura.",
    },
    inputSchema: {
      id: z.union([z.number(), z.string()]).describe("Campaign id (path param)"),
    },
  },

  // ── Send schedule ─────────────────────────────────────────────────────────
  "GET /api/agent/send-schedule": {
    name: "send_schedule_get",
    description: {
      en: "Allowed sending time slots (day-of-week × hour) plus global daily cap and whether sending is currently within the window. Read-only.",
      it: "Fasce orarie di invio consentite (giorno × ora) più il daily cap globale e se l'invio è attualmente in finestra. Solo lettura.",
    },
    inputSchema: {},
  },

  // ── Prospect / aziende ────────────────────────────────────────────────────
  "GET /api/agent/companies": {
    name: "companies_list",
    description: {
      en: "List companies (prospects) with optional filters: campaign_id, consent (cold/marketing), q (search), inviato (true/false). Read-only.",
      it: "Elenca le aziende (prospect) con filtri opzionali: campaign_id, consent (cold/marketing), q (ricerca), inviato (true/false). Solo lettura.",
    },
    inputSchema: {
      campaign_id: z.union([z.number(), z.string()]).optional().describe("Filter by campaign id"),
      consent: z.enum(["cold", "marketing"]).optional().describe("Filter by consent_status"),
      q: z.string().optional().describe("Free-text search on title/email/comune/website"),
      inviato: z.enum(["true", "false"]).optional().describe("Filter by sent status"),
      funnel_stage: z.enum(["prospect", "contacted", "called", "booked", "demo", "won", "lost"]).optional().describe("Filter by outreach funnel_stage"),
      limit: z.union([z.number(), z.string()]).optional().describe("Max rows, default 50, max 200"),
    },
  },
  "GET /api/agent/companies/search": {
    name: "companies_search",
    description: {
      en: "Full-text search on title/email/comune/website. Read-only.",
      it: "Ricerca full-text su title/email/comune/website. Solo lettura.",
    },
    inputSchema: {
      q: z.string().describe("Search text (required)"),
      limit: z.union([z.number(), z.string()]).optional().describe("Max rows, default 50, max 200"),
    },
  },
  "POST /api/agent/companies/ingest": {
    name: "companies_ingest",
    description: {
      en: "Ingest an already-scraped prospect: upserts a company by email (or website) and best-effort syncs it to the CMS (upsertContact). Does NOT scrape the web itself — data must be provided by the caller.",
      it: "Ingesta un prospect già scrappato: upsert dell'azienda per email (o website) e sync best-effort verso il CMS (upsertContact). NON fa scraping: i dati vanno forniti dal chiamante.",
    },
    inputSchema: {
      email: z.string().describe("Prospect email (required, used as upsert key)"),
      title: z.string().optional(),
      address: z.string().optional(),
      comune: z.string().optional(),
      provincia: z.string().optional(),
      cap: z.string().optional(),
      website: z.string().optional().describe("Used as fallback upsert key if no email match"),
      phone_number: z.string().optional(),
      position: z.string().optional(),
      category: z.string().optional(),
      descrizione: z.string().optional(),
      booking_links: z.string().optional(),
      campaign_id: z.union([z.number(), z.string()]).optional(),
      tags: z.union([z.array(z.string()), z.string()]).optional().describe("Forwarded to CMS contact tags, not stored locally"),
    },
  },
  "GET /api/agent/companies/:id": {
    name: "companies_get",
    description: {
      en: "Full detail of a company (prospect), including current draft subject/body, funnel_stage, call outcome (call_status/call_notes/next_call_at) and booking status (booking_status/booking_at/booking_link) if present. Read-only.",
      it: "Dettaglio completo di un'azienda (prospect), inclusi oggetto/corpo della bozza corrente, funnel_stage, esito chiamata (call_status/call_notes/next_call_at) e stato booking (booking_status/booking_at/booking_link) se presenti. Solo lettura.",
    },
    inputSchema: {
      id: z.union([z.number(), z.string()]).describe("Company id (path param)"),
    },
  },
  "PUT /api/agent/companies/:id": {
    name: "companies_update",
    description: {
      en: "Update company fields (title, address, comune, provincia, cap, website, phone_number, category, position, booking_links, descrizione/notes, consent_status, campaign_id). tags is forwarded best-effort to the CMS contact, not stored locally.",
      it: "Aggiorna i campi dell'azienda (title, address, comune, provincia, cap, website, phone_number, category, position, booking_links, descrizione/notes, consent_status, campaign_id). tags viene inoltrato best-effort al contatto CMS, non salvato in locale.",
    },
    inputSchema: {
      id: z.union([z.number(), z.string()]).describe("Company id (path param)"),
      title: z.string().optional(),
      address: z.string().optional(),
      comune: z.string().optional(),
      provincia: z.string().optional(),
      cap: z.string().optional(),
      website: z.string().optional(),
      phone_number: z.string().optional(),
      category: z.string().optional(),
      position: z.string().optional(),
      booking_links: z.string().optional(),
      descrizione: z.string().optional(),
      notes: z.string().optional().describe("Alias of descrizione if descrizione is not provided"),
      consent_status: z.enum(["cold", "marketing"]).optional(),
      campaign_id: z.union([z.number(), z.string()]).optional(),
      tags: z.union([z.array(z.string()), z.string()]).optional(),
    },
  },

  // ── Email draft ───────────────────────────────────────────────────────────
  "POST /api/agent/companies/:id/draft": {
    name: "companies_draft_generate",
    description: {
      en: "Generate/regenerate the email draft for ONE company, reusing the same generation pipeline as the batch cron (ai-copywriter). Requires website + enough company data (nome_studio/descrizione) already ingested; does not scrape. Sets bozza_email/bozza_email_oggetto/bozza_creata.",
      it: "Genera/rigenera la bozza email per UNA azienda, riusando la stessa pipeline di generazione del cron batch (ai-copywriter). Richiede website + dati sufficienti (nome_studio/descrizione) già ingestati; non fa scraping. Imposta bozza_email/bozza_email_oggetto/bozza_creata.",
    },
    inputSchema: {
      id: z.union([z.number(), z.string()]).describe("Company id (path param)"),
    },
  },
  "GET /api/agent/companies/:id/draft": {
    name: "companies_draft_get",
    description: {
      en: "Read the current email draft (subject + body) for a company. 404 if no draft exists yet. Read-only.",
      it: "Legge la bozza email corrente (oggetto + corpo) di un'azienda. 404 se non esiste ancora una bozza. Solo lettura.",
    },
    inputSchema: {
      id: z.union([z.number(), z.string()]).describe("Company id (path param)"),
    },
  },

  // ── Invio ─────────────────────────────────────────────────────────────────
  "POST /api/agent/companies/:id/send": {
    name: "companies_send",
    description: {
      en: "One-to-one manual send (send_context='manual'): the only path that admits 'cold' consent. Requires an approved draft, no opt-out; checks the daily cap and send window (informational, does not block queuing — actual delivery is async via the queue/cron). Returns esito: scheduled|skipped + motivo.",
      it: "Invio one-to-one manuale (send_context='manual'): unico percorso che ammette il consenso 'cold'. Richiede bozza approvata, nessun opt-out; verifica daily cap e finestra di invio (informativo, non blocca l'accodamento — l'invio reale è asincrono via coda/cron). Risponde esito: scheduled|skipped + motivo.",
    },
    inputSchema: {
      id: z.union([z.number(), z.string()]).describe("Company id (path param)"),
    },
  },

  // ── Consenso / opt-out ────────────────────────────────────────────────────
  "GET /api/agent/companies/:id/consent": {
    name: "companies_consent_get",
    description: {
      en: "Consent status of a company: from the CMS (getContactConsent) if configured, otherwise from the local consent_status column. Read-only.",
      it: "Stato consenso di un'azienda: dal CMS (getContactConsent) se configurato, altrimenti dalla colonna locale consent_status. Solo lettura.",
    },
    inputSchema: {
      id: z.union([z.number(), z.string()]).describe("Company id (path param)"),
    },
  },
  "POST /api/agent/companies/:id/optout": {
    name: "companies_optout",
    description: {
      en: "Sets a total opt-out (unsubscribed_at) locally and best-effort mirrors it to the CMS (setContactOptOut) — a shared blacklist that MUST be respected, no further sends allowed to this contact.",
      it: "Imposta un opt-out totale (unsubscribed_at) in locale e lo specchia best-effort sul CMS (setContactOptOut) — blacklist condivisa che DEVE essere rispettata, nessun ulteriore invio ammesso a questo contatto.",
    },
    inputSchema: {
      id: z.union([z.number(), z.string()]).describe("Company id (path param)"),
    },
  },

  // ── Bridge CMS ────────────────────────────────────────────────────────────
  "POST /api/agent/companies/:id/cms-sync": {
    name: "companies_cms_sync",
    description: {
      en: "Syncs the company with the CMS (syncCompanyWithCms: upsert contact + consent read-back) and, if the company has replied, ensures a CMS opportunity (ensureOpportunityForReply).",
      it: "Sincronizza l'azienda col CMS (syncCompanyWithCms: upsert contatto + rilettura consenso) e, se l'azienda ha risposto, garantisce un'opportunità sul CMS (ensureOpportunityForReply).",
    },
    inputSchema: {
      id: z.union([z.number(), z.string()]).describe("Company id (path param)"),
    },
  },

  // ── Setting telefonico ────────────────────────────────────────────────────
  "POST /api/agent/companies/:id/call-outcome": {
    name: "companies_call_outcome",
    description: {
      en: "Records the outcome of a cold-call (telephone setting) for a prospect: esito (da_chiamare|non_risponde|richiamare|non_interessato|interessato), optional note, optional richiama_il (ISO datetime for a callback). Advances funnel_stage to 'called' (or 'lost' if not interested), best-effort adds a note on the CMS contact, and best-effort ensures a CMS opportunity when esito='interessato'.",
      it: "Registra l'esito di una chiamata a freddo (setting telefonico) per un prospect: esito (da_chiamare|non_risponde|richiamare|non_interessato|interessato), nota opzionale, richiama_il opzionale (data/ora ISO per un richiamo). Fa avanzare funnel_stage a 'called' (o 'lost' se non interessato), aggiunge best-effort una nota sul contatto CMS e garantisce best-effort un'opportunità CMS quando esito='interessato'.",
    },
    inputSchema: {
      id: z.union([z.number(), z.string()]).describe("Company id (path param)"),
      esito: z.enum(["da_chiamare", "non_risponde", "richiamare", "non_interessato", "interessato"]).describe("Call outcome (required)"),
      note: z.string().optional().describe("Free-text note about the call"),
      richiama_il: z.string().optional().describe("ISO 8601 datetime to call back, if esito='richiamare'"),
    },
  },

  // ── Avanzamento funnel ────────────────────────────────────────────────────
  "PUT /api/agent/companies/:id/funnel-stage": {
    name: "companies_funnel_stage_set",
    description: {
      en: "Explicitly sets the outreach funnel_stage (prospect|contacted|called|booked|demo|won|lost) for a company, e.g. to mark won/lost after CMS pipeline outcome. Optional note is best-effort mirrored to the CMS contact.",
      it: "Imposta esplicitamente il funnel_stage outreach (prospect|contacted|called|booked|demo|won|lost) di un'azienda, es. per marcare won/lost dopo l'esito sulla pipeline CMS. Nota opzionale specchiata best-effort sul contatto CMS.",
    },
    inputSchema: {
      id: z.union([z.number(), z.string()]).describe("Company id (path param)"),
      stage: z.enum(["prospect", "contacted", "called", "booked", "demo", "won", "lost"]).describe("New funnel stage (required)"),
      note: z.string().optional().describe("Free-text note, mirrored to the CMS contact if present"),
    },
  },

  // ── Booking / videocall ───────────────────────────────────────────────────
  "POST /api/agent/companies/:id/booking": {
    name: "companies_booking_set",
    description: {
      en: "Records that a sales videocall has been booked/held for a prospect: status (da_prenotare|prenotato|effettuata|no_show|annullata), optional scheduled_at (ISO datetime), notes, link (to the real CMS/calendar event — this does NOT create the booking itself). Advances funnel_stage to 'booked' or 'demo' and best-effort ensures a CMS opportunity.",
      it: "Registra che una videocall di vendita è stata prenotata/effettuata per un prospect: status (da_prenotare|prenotato|effettuata|no_show|annullata), scheduled_at opzionale (data/ora ISO), notes, link (verso l'evento reale CMS/calendario — NON crea la prenotazione). Fa avanzare funnel_stage a 'booked' o 'demo' e garantisce best-effort un'opportunità CMS.",
    },
    inputSchema: {
      id: z.union([z.number(), z.string()]).describe("Company id (path param)"),
      status: z.enum(["da_prenotare", "prenotato", "effettuata", "no_show", "annullata"]).describe("Booking status (required)"),
      scheduled_at: z.string().optional().describe("ISO 8601 datetime of the videocall"),
      notes: z.string().optional(),
      link: z.string().optional().describe("Link to the real booking/calendar event (CMS calls module or external calendar)"),
    },
  },

  // ── Stato invio ───────────────────────────────────────────────────────────
  "GET /api/agent/email-queue": {
    name: "email_queue_list",
    description: {
      en: "Recent email queue items (email, status, event/error), optionally filtered by status. Read-only.",
      it: "Elementi recenti della coda email (email, status, evento/errore), filtrabili per status. Solo lettura.",
    },
    inputSchema: {
      status: z.string().optional().describe("Filter by queue status (pending/sending/sent/failed)"),
      limit: z.union([z.number(), z.string()]).optional().describe("Max rows, default 50, max 200"),
    },
  },

  // ── Modalità test ─────────────────────────────────────────────────────────
  "GET /api/agent/test-mode": {
    name: "test_mode_get",
    description: {
      en: "Current test_mode state (on/off) and configured test recipients. Read-only, any authenticated agent.",
      it: "Stato corrente di test_mode (attivo/disattivo) e destinatari di test configurati. Solo lettura, ogni agente autenticato.",
    },
    inputSchema: {},
  },
  "PUT /api/agent/test-mode": {
    name: "test_mode_set",
    description: {
      en: "Enables/disables test_mode. When enabled, every real email send is diverted to a test recipient or blocked if none is configured — never sent to the real recipient. Requires 'settings' update permission (RBAC mirrors the calling user's role).",
      it: "Attiva/disattiva test_mode. Se attivo, ogni invio reale viene deviato verso un destinatario di test o bloccato se nessuno è configurato — mai verso il destinatario reale. Richiede il permesso di aggiornamento su 'settings' (RBAC speculare al ruolo dell'utente chiamante).",
    },
    inputSchema: {
      enabled: z.boolean().describe("true = attiva test_mode, false = disattiva (required)"),
    },
  },
  "POST /api/agent/test-mode/recipients": {
    name: "test_mode_recipient_add",
    description: {
      en: "Adds (or updates the note of) a test recipient email, used to divert sends while test_mode is enabled. Requires 'settings' update permission.",
      it: "Aggiunge (o aggiorna la nota di) un destinatario di test, usato per deviare gli invii quando test_mode è attivo. Richiede il permesso di aggiornamento su 'settings'.",
    },
    inputSchema: {
      email: z.string().describe("Test recipient email address (required)"),
      note: z.string().optional().describe("Free-text note"),
    },
  },
  "DELETE /api/agent/test-mode/recipients/:id": {
    name: "test_mode_recipient_remove",
    description: {
      en: "Removes a test recipient. Requires 'settings' update permission.",
      it: "Rimuove un destinatario di test. Richiede il permesso di aggiornamento su 'settings'.",
    },
    inputSchema: {
      id: z.union([z.number(), z.string()]).describe("Test recipient id (path param)"),
    },
  },

  // ── Metriche funnel ───────────────────────────────────────────────────────
  "GET /api/agent/funnel-metrics": {
    name: "funnel_metrics",
    description: {
      en: "Full B2B funnel metrics: per-stage counts, cumulative reached counts, conversion rates between stages (prospect→contacted→called→booked→demo→won), email metrics (sent/opened/clicked/bounced/replied with rates), call/booking outcome breakdowns, and prospects stuck in a non-terminal stage beyond a day threshold. Read-only, optionally filtered by campaign.",
      it: "Metriche complete del funnel B2B: conteggi per stadio, conteggi cumulativi raggiunti, conversion rate tra stadi (prospect→contacted→called→booked→demo→won), metriche email (inviate/aperte/cliccate/bounced/risposte con tassi), esiti chiamata/booking, prospect bloccati in uno stadio non terminale oltre una soglia di giorni. Solo lettura, filtrabile per campagna.",
    },
    inputSchema: {
      campaign_id: z.union([z.number(), z.string()]).optional().describe("Filter by campaign id"),
      stuck_days: z.union([z.number(), z.string()]).optional().describe("Days threshold to consider a prospect 'stuck', default 14"),
    },
  },
};

// ── Generic fallback for routes not (yet) in TOOL_META ──────────────────────

function autoName(method, path) {
  const slug = path
    .replace(/^\/api\/agent\//, "")
    .replace(/[:/]/g, "_")
    .replace(/-/g, "_")
    .replace(/__+/g, "_")
    .replace(/_$/, "");
  return `${method.toLowerCase()}_${slug}`;
}

function genericInputSchema(path) {
  const shape = {};
  for (const p of pathParamNames(path)) {
    shape[camelToSnake(p)] = z.union([z.string(), z.number()]);
  }
  shape.extra = z.record(z.any()).optional().describe("Other body/query fields, not yet individually documented — see AGENT.md for this endpoint.");
  return shape;
}

// ── Discovery: iterates the real router, merges introspection + TOOL_META ──

export function discoverTools(lang = "en") {
  const tools = [];
  const seen = new Set();

  for (const layer of agentRouter.stack) {
    if (!layer.route || typeof layer.route.path !== "string") continue;
    const path = layer.route.path;
    if (!path.startsWith("/api/agent")) continue;

    const methods = Object.keys(layer.route.methods).filter((m) => layer.route.methods[m]);
    for (const method of methods) {
      const httpMethod = method.toUpperCase();
      const key = `${httpMethod} ${path}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const meta = TOOL_META[key];
      tools.push({
        method: httpMethod,
        path,
        name: meta?.name || autoName(httpMethod, path),
        description: meta ? pick(lang, meta.description) : `Agent endpoint ${httpMethod} ${path} — generic schema, see AGENT.md.`,
        inputSchema: meta?.inputSchema || genericInputSchema(path),
        multipart: meta?.multipart || false,
        enriched: !!meta,
      });
    }
  }
  return tools;
}

// ── Internal HTTP proxy: same REST code, no duplicated logic ────────────────

function resolvePath(pathTemplate, args) {
  const consumed = new Set();
  const resolved = pathTemplate.replace(/:([a-zA-Z0-9_]+)/g, (_, camelParam) => {
    const snakeKey = camelToSnake(camelParam);
    consumed.add(snakeKey);
    const val = args[snakeKey];
    if (val === undefined || val === null) throw new Error(`Missing parameter: ${snakeKey}`);
    return encodeURIComponent(String(val));
  });

  const rest = {};
  for (const [k, v] of Object.entries(args)) {
    if (consumed.has(k)) continue;
    if (k === "extra" && v && typeof v === "object") { Object.assign(rest, v); continue; }
    if (v !== undefined) rest[k] = v;
  }
  return { resolved, rest };
}

async function buildRequestBody(tool, rest) {
  if (!tool.multipart) {
    return { body: Object.keys(rest).length > 0 ? JSON.stringify(rest) : undefined, headers: { "Content-Type": "application/json" } };
  }
  const rawB64 = String(rest.content_base64 || "");
  if (!rawB64 || !/^[A-Za-z0-9+/]*={0,2}$/.test(rawB64) || rawB64.length % 4 !== 0) {
    return { error: "content_base64 non è un base64 valido" };
  }
  let buf;
  try {
    buf = Buffer.from(rawB64, "base64");
    if (buf.length === 0 || !buf.equals(Buffer.from(buf.toString("base64"), "base64"))) throw new Error("bad base64");
  } catch {
    return { error: "content_base64 non è un base64 valido" };
  }
  const form = new FormData();
  form.append("file", new Blob([buf]), rest.filename || "upload.bin");
  return { body: form, headers: {} };
}

async function contentFromResponse(resp) {
  const contentType = resp.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    const data = await resp.json().catch(() => null);
    return { content: [{ type: "text", text: JSON.stringify(data) }], isError: !resp.ok };
  }
  if (contentType.startsWith("text/")) {
    const text = await resp.text();
    return { content: [{ type: "text", text }], isError: !resp.ok };
  }
  const buf = Buffer.from(await resp.arrayBuffer());
  return {
    content: [{
      type: "resource",
      resource: { uri: `internal://mcp-proxy${resp.url ? new URL(resp.url).pathname : ""}`, mimeType: contentType || "application/octet-stream", blob: buf.toString("base64") },
    }],
    isError: !resp.ok,
  };
}

export function makeToolHandler(tool) {
  return async (args, extra) => {
    const authHeader = extra?.requestInfo?.headers?.authorization;
    if (!authHeader) {
      return { content: [{ type: "text", text: JSON.stringify({ error: "Missing Authorization header in the MCP request" }) }], isError: true };
    }

    let resolved, rest;
    try {
      ({ resolved, rest } = resolvePath(tool.path, args || {}));
    } catch (err) {
      return { content: [{ type: "text", text: JSON.stringify({ error: err.message }) }], isError: true };
    }

    const isBodyMethod = ["POST", "PUT", "PATCH"].includes(tool.method);
    let url = `http://127.0.0.1:${config.port}${resolved}`;
    let fetchOptions = { method: tool.method, headers: { Authorization: authHeader } };

    if (isBodyMethod) {
      const built = await buildRequestBody(tool, rest);
      if (built.error) {
        return { content: [{ type: "text", text: JSON.stringify({ error: built.error }) }], isError: true };
      }
      const { body, headers } = built;
      fetchOptions.body = body;
      fetchOptions.headers = { ...fetchOptions.headers, ...headers };
    } else if (Object.keys(rest).length > 0) {
      url += "?" + new URLSearchParams(Object.fromEntries(Object.entries(rest).map(([k, v]) => [k, String(v)]))).toString();
    }

    try {
      const resp = await fetch(url, { ...fetchOptions, signal: AbortSignal.timeout(60_000) });
      return await contentFromResponse(resp);
    } catch (err) {
      logger.error(`MCP proxy: call to ${tool.method} ${resolved} failed: ${err.message}`);
      return { content: [{ type: "text", text: JSON.stringify({ error: "Internal call failed: " + err.message }) }], isError: true };
    }
  };
}

export default { discoverTools, makeToolHandler, TOOL_META };
