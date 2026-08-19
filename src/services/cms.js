import config from "../config.js";
import { logger } from "./logger.js";
import { withRetry } from "./retry.js";
import { query } from "../db.js";

// Integrazione col CMS agent-first (agent-first-simple-newsletter-cms) — sostituisce GHL.
// A differenza di GHL, il CMS è il NOSTRO CRM (mono-tenant, un CMS_SITE_ID per istanza):
// non serve nessuna logica di ownership/tag "pre_existing" come in ghl.js, i contatti sono
// sempre "nostri".

const pipelinesCache = new Map();
const pipelinesCacheTime = new Map();
const PIPELINES_CACHE_MS = 5 * 60 * 1000;

// Rate limit CMS: 120 req/min per IP condiviso su tutto /api/agent/*. Teniamo un margine
// (90/60s) per non saturare il budget quando gira anche altro traffico verso lo stesso CMS.
const RATE_LIMIT_MAX = 90;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const requestTimestamps = [];

async function waitForRateLimitSlot() {
  for (;;) {
    const now = Date.now();
    while (requestTimestamps.length > 0 && now - requestTimestamps[0] > RATE_LIMIT_WINDOW_MS) {
      requestTimestamps.shift();
    }
    if (requestTimestamps.length < RATE_LIMIT_MAX) {
      requestTimestamps.push(now);
      return;
    }
    const waitMs = RATE_LIMIT_WINDOW_MS - (now - requestTimestamps[0]) + 10;
    await new Promise((r) => setTimeout(r, waitMs));
  }
}

export function getCmsConfig() {
  return {
    baseUrl: config.cmsBaseUrl,
    token: config.cmsAgentToken,
    siteId: config.cmsSiteId,
  };
}

export function isCmsConfigured() {
  const cfg = getCmsConfig();
  return !!(cfg.baseUrl && cfg.token && cfg.siteId);
}

export async function cmsFetch(cfg, path, options = {}) {
  if (!cfg?.baseUrl || !cfg?.token) {
    throw new Error("CMS non configurato (CMS_BASE_URL/CMS_AGENT_TOKEN mancanti)");
  }
  const url = `${cfg.baseUrl}${path}`;
  await waitForRateLimitSlot();
  return withRetry(async () => {
    const res = await fetch(url, {
      ...options,
      headers: {
        "Authorization": `Bearer ${cfg.token}`,
        "Content-Type": "application/json",
        ...options.headers,
      },
      signal: AbortSignal.timeout(options.timeout || 20000),
    });
    if (res.status === 429) {
      const retryAfter = parseInt(res.headers.get("Retry-After") || "3", 10);
      const err = new Error("CMS rate limited");
      err.status = 429;
      err.retryAfter = retryAfter;
      throw err;
    }
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      const err = new Error(`CMS ${res.status}: ${t}`);
      err.status = res.status;
      throw err;
    }
    if (res.status === 204) return null;
    return res.json();
  }, { maxRetries: 3, baseDelay: 2000, maxDelay: 15000, retryableStatuses: [429] });
}

function encodeEmail(email) {
  return encodeURIComponent(String(email || "").trim().toLowerCase());
}

/**
 * Crea o aggiorna un contatto sul CMS (upsert nativo dell'endpoint).
 * body: { tags?, status?, notes?, value_estimate? }
 */
export async function upsertContact(siteId, email, body = {}) {
  if (!email) return null;
  const cfg = getCmsConfig();
  return cmsFetch(cfg, `/api/agent/sites/${siteId}/contacts/${encodeEmail(email)}`, {
    method: "PUT",
    body: JSON.stringify(body),
  });
}

export async function tagContact(siteId, email, tags) {
  return upsertContact(siteId, email, { tags });
}

/**
 * Legge il consenso granulare del contatto dal CMS.
 * Ritorna null se il contatto non esiste ancora sul CMS (nessun consenso espresso).
 */
export async function getContactConsent(siteId, email) {
  if (!email) return null;
  const cfg = getCmsConfig();
  try {
    const data = await cmsFetch(cfg, `/api/agent/sites/${siteId}/contacts/${encodeEmail(email)}/extras`);
    const prefs = data?.preferences || {};
    return {
      pref_email: !!prefs.pref_email,
      pref_marketing: !!prefs.pref_marketing,
      pref_sms: !!prefs.pref_sms,
      pref_whatsapp: !!prefs.pref_whatsapp,
      pref_phone: !!prefs.pref_phone,
      pref_token: prefs.pref_token || null,
    };
  } catch (e) {
    if (e.status === 404) return null;
    throw e;
  }
}

/**
 * Segna il contatto come opt-out totale sul CMS (email + marketing), così l'opt-out
 * fatto dal servizio outreach diventa l'unica fonte di verità anche lato CMS per quel sito.
 */
export async function setContactOptOut(siteId, email) {
  if (!email) return null;
  const cfg = getCmsConfig();
  try {
    return await cmsFetch(cfg, `/api/agent/sites/${siteId}/contacts/${encodeEmail(email)}/extras`, {
      method: "PUT",
      body: JSON.stringify({ preferences: { pref_email: false, pref_marketing: false } }),
    });
  } catch (e) {
    logger.warn("cms.setContactOptOut fallito", { email, error: e.message });
    return null;
  }
}

/**
 * Crea/aggiorna un'opportunità nella pipeline del CMS. L'endpoint del CMS è idempotente
 * (crea/aggiorna in base a email+pipeline), non serve una ricerca preventiva come in GHL.
 */
export async function ensureOpportunity(siteId, { email, pipeline_id, stage, title, amount, probability, notes }) {
  if (!email || !pipeline_id) {
    logger.warn("cms.ensureOpportunity: dati insufficienti, skip", { email, pipeline_id });
    return null;
  }
  const cfg = getCmsConfig();
  return cmsFetch(cfg, `/api/agent/sites/${siteId}/opportunities`, {
    method: "POST",
    body: JSON.stringify({ email, pipeline_id, stage, title, amount, probability, notes }),
  });
}

export async function addNote(siteId, email, body, authorType = "agent", authorName = "outreach-service") {
  if (!email || !body) return null;
  const cfg = getCmsConfig();
  try {
    return await cmsFetch(cfg, `/api/agent/sites/${siteId}/contacts/${encodeEmail(email)}/notes`, {
      method: "POST",
      body: JSON.stringify({ body, author_type: authorType, author_name: authorName }),
    });
  } catch (e) {
    logger.warn("cms.addNote fallito", { email, error: e.message });
    return null;
  }
}

/**
 * Crea/aggiorna (best-effort, mai bloccante) un'opportunità nel CMS quando un azienda
 * mostra interesse (has_replied=true). Risolve la pipeline della campagna tramite
 * getCmsContextForCampaign (cms_pipeline_id / cms_stage_map, fallback a CMS_PIPELINE_MAP)
 * e lo stage di "replied" dalla stage map se presente. Il lead entra così nel CRM CMS.
 */
export async function ensureOpportunityForReply(company) {
  try {
    if (!company || !company.id || !company.email) return null;
    if (!isCmsConfigured()) return null;
    let campaign = null;
    if (company.campaign_id) {
      const r = await query(
        "SELECT id, funnel, cms_pipeline_id, cms_stage_map FROM campaigns WHERE id = $1",
        [company.campaign_id]
      );
      if (r.rows.length > 0) campaign = r.rows[0];
    }
    const ctx = getCmsContextForCampaign(campaign || {});
    if (!ctx.pipelineId) {
      logger.warn("cms.ensureOpportunityForReply: nessuna pipeline per la campagna, skip", { companyId: company.id });
      return null;
    }
    const stageMap = ctx.stageMap || {};
    const stage = stageMap.replied || stageMap.qualificato || stageMap.qualificato_risposta || null;
    const opp = await ensureOpportunity(ctx.siteId, {
      email: company.email,
      pipeline_id: ctx.pipelineId,
      stage,
      title: company.nome_studio || company.nome_azienda || `Azienda #${company.id}`,
      probability: 60,
      notes: "Interesse manifestato: risposta ricevuta dall'outreach.",
    });
    logger.info("cms.ensureOpportunityForReply: opportunità creata/aggiornata sul CMS", {
      companyId: company.id, pipelineId: ctx.pipelineId, stage,
    });
    return opp;
  } catch (err) {
    logger.warn("cms.ensureOpportunityForReply fallito (best-effort)", { companyId: company?.id, error: err.message });
    return null;
  }
}

/**
 * Crea/aggiorna (best-effort) un'opportunità nel CMS per un avanzamento generico dello
 * stage outreach (setting telefonico, booking videocall). Stessa risoluzione pipeline di
 * ensureOpportunityForReply (cms_pipeline_id/cms_stage_map della campagna, fallback
 * CMS_PIPELINE_MAP), ma con uno "stageKey" arbitrario cercato nella stage map della
 * campagna — permette di mappare gli step outreach (interessato/booked/demo) sugli stage
 * reali della pipeline CMS del cliente, senza assumerne i nomi.
 */
export async function ensureOpportunityForStage(company, { stageKey, probability, notes } = {}) {
  try {
    if (!company || !company.id || !company.email) return null;
    if (!isCmsConfigured()) return null;
    let campaign = null;
    if (company.campaign_id) {
      const r = await query(
        "SELECT id, funnel, cms_pipeline_id, cms_stage_map FROM campaigns WHERE id = $1",
        [company.campaign_id]
      );
      if (r.rows.length > 0) campaign = r.rows[0];
    }
    const ctx = getCmsContextForCampaign(campaign || {});
    if (!ctx.pipelineId) {
      logger.warn("cms.ensureOpportunityForStage: nessuna pipeline per la campagna, skip", { companyId: company.id, stageKey });
      return null;
    }
    const stageMap = ctx.stageMap || {};
    const stage = stageMap[stageKey] || null;
    const opp = await ensureOpportunity(ctx.siteId, {
      email: company.email,
      pipeline_id: ctx.pipelineId,
      stage,
      title: company.nome_studio || company.nome_azienda || `Azienda #${company.id}`,
      probability,
      notes,
    });
    logger.info("cms.ensureOpportunityForStage: opportunità creata/aggiornata sul CMS", {
      companyId: company.id, pipelineId: ctx.pipelineId, stage, stageKey,
    });
    return opp;
  } catch (err) {
    logger.warn("cms.ensureOpportunityForStage fallito (best-effort)", { companyId: company?.id, stageKey, error: err.message });
    return null;
  }
}

export async function getPipelines(siteId) {
  const cacheKey = String(siteId);
  const now = Date.now();
  if (pipelinesCache.has(cacheKey) && now - (pipelinesCacheTime.get(cacheKey) || 0) < PIPELINES_CACHE_MS) {
    return pipelinesCache.get(cacheKey);
  }
  const cfg = getCmsConfig();
  const data = await cmsFetch(cfg, `/api/agent/sites/${siteId}/pipelines`);
  const result = Array.isArray(data) ? data : (data?.pipelines || []);
  pipelinesCache.set(cacheKey, result);
  pipelinesCacheTime.set(cacheKey, now);
  return result;
}

export function clearPipelinesCache(siteId) {
  if (siteId != null) {
    const k = String(siteId);
    pipelinesCache.delete(k);
    pipelinesCacheTime.delete(k);
  } else {
    pipelinesCache.clear();
    pipelinesCacheTime.clear();
  }
}

/**
 * Risolve pipeline_id/stage map da usare per una campagna: priorità alle colonne
 * campaigns.cms_pipeline_id/cms_stage_map, fallback a CMS_PIPELINE_MAP (env, mappa globale
 * funnel->pipeline_id) se la campagna non ha un mapping esplicito.
 */
export function getCmsContextForCampaign(campaign) {
  const siteId = config.cmsSiteId;
  let pipelineId = campaign?.cms_pipeline_id || null;
  let stageMap = campaign?.cms_stage_map || null;
  if (!pipelineId && campaign?.funnel && config.cmsPipelineMap?.[campaign.funnel]) {
    pipelineId = config.cmsPipelineMap[campaign.funnel];
  }
  return { siteId, pipelineId, stageMap: stageMap || {} };
}

/**
 * Sincronizza un azienda col CMS: upsert del contatto + sync dello stato di consenso.
 * Best-effort (mai bloccante): se il CMS non è configurato o fallisce, il azienda
 * resta col default. Aggiorna consent_status / consent_channels / consent_basis / consent_source / cms_synced_at.
 * - 'marketing' solo se CMS conferma pref_marketing && pref_email, altrimenti 'cold'
 * - consent_channels = {email, sms, phone, whatsapp} da pref_* CMS, con pref_marketing come guardia per email
 * - consent_basis = 'consent' se pref_marketing, altrimenti 'legitimate_interest'
 */
export async function syncCompanyWithCms(company) {
  if (!company || !company.email || !company.id) return null;
  const siteId = config.cmsSiteId;
  if (!siteId || !config.cmsBaseUrl || !config.cmsAgentToken) {
    return null; // CMS non configurato: nessun sync
  }
  try {
    await upsertContact(siteId, company.email, {
      tags: ["outreach"],
      notes: company.nome_studio || company.nome_azienda || null,
    });
    const consent = await getContactConsent(siteId, company.email);
    const marketing = !!(consent && consent.pref_marketing && consent.pref_email);
    const consentStatus = marketing ? "marketing" : "cold";
    const consentSource = consent ? "cms" : (company.consent_source || "scrape");

    let consentChannels = null;
    let consentBasis = "legitimate_interest";

    if (consent) {
      consentChannels = {
        email: !!(consent.pref_marketing && consent.pref_email),
        sms: !!consent.pref_sms,
        phone: !!consent.pref_phone,
        whatsapp: !!consent.pref_whatsapp,
      };
      if (consent.pref_marketing) {
        consentBasis = "consent";
      }
    }

    await query(
      `UPDATE companies SET consent_status = $1, consent_channels = $2, consent_basis = $3, consent_source = $4, cms_synced_at = NOW() WHERE id = $5 AND tenant_id = $6)`,
      [consentStatus, JSON.stringify(consentChannels), consentBasis, consentSource, company.id, company.tenant_id]
    );
    return consentStatus;
  } catch (err) {
    logger.warn("cms.syncCompanyWithCms fallito (best-effort)", { id: company.id, error: err.message });
    return null;
  }
}
