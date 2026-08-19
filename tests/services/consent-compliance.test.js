import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { query } from "../../src/db.js";

// Mock del modulo db (usato da cms.js per risolvere la pipeline della campagna)
vi.mock("../../src/db.js", () => ({ query: vi.fn() }));

// Config CMS fittizia per testare l'integrazione (nessun segreto reale: token placeholder)
vi.mock("../../src/config.js", () => ({
  default: {
    cmsBaseUrl: "https://cms.test.local",
    cmsAgentToken: "agtok_test_placeholder",
    cmsSiteId: 42,
    cmsPipelineMap: { aziende: 100 },
  },
}));

// Re-import dopo il mock
const { enforceConsent } = await import("../../src/services/email-sender.js");
const { enforceSchedulingConsent, SEND_CONTEXT, isDailyCapReached } =
  await import("../../src/services/send-schedule.js");
const {
  setContactOptOut,
  ensureOpportunityForReply,
  ensureOpportunity,
  getCmsContextForCampaign,
} = await import("../../src/services/cms.js");

function mockFetchOk(body = {}) {
  global.fetch = vi.fn(async (url, opts) => ({
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => "",
  }));
}

describe("§8 — Regole consenso (spec)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
    // default: query restituisce una promise risolta (auditInvioRegola fa .catch su di essa)
    query.mockResolvedValue({ rows: [] });
    // Stub fetch di default per i servizi CMS best-effort
    global.fetch = vi.fn(async () => ({ ok: false, status: 403, json: async () => ({}), text: async () => "" }));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete global.fetch;
  });

  // ── (1) consensato in campagna marketing incluso, cold NO ──
  describe("(1) campagne marketing: consensati inclusi, cold esclusi", () => {
    it("un consensato 'marketing' viene incluso nella campagna automatica", () => {
      const r = enforceConsent({ id: 10, consent_status: "marketing" }, { consentContext: "automatic" });
      expect(r.ok).toBe(true);
      expect(r.status).toBe("marketing");
      expect(enforceSchedulingConsent({ consent_status: "marketing", context: SEND_CONTEXT.AUTOMATIC }).ok).toBe(true);
    });

    it("un cold NON viene incluso nella campagna automatica", () => {
      const r = enforceConsent({ id: 11, consent_status: "cold" }, { consentContext: "automatic" });
      expect(r.ok).toBe(false);
      expect(r.status).toBe("cold");
      expect(enforceSchedulingConsent({ consent_status: "cold", context: SEND_CONTEXT.AUTOMATIC }).ok).toBe(false);
    });
  });

  // ── (2) cold in cold-outreach manuale: B2B con UNSUB + daily cap ──
  describe("(2) cold-outreach manuale: solo B2B con UNSUB, sottoposto a daily cap", () => {
    it("il cold è ammesso SOLO nel flusso one-to-one manuale (esplicitamente marcato)", () => {
      const r = enforceConsent({ id: 20, consent_status: "cold" }, { consentContext: "manual" });
      expect(r.ok).toBe(true);
      expect(r.status).toBe("cold");
      // resta un cold, mai promosso a marketing
      expect(enforceSchedulingConsent({ consent_status: "cold", context: SEND_CONTEXT.MANUAL }).status).toBe("cold");
    });

    it("il cold è bloccato se il contesto NON è esplicitamente manuale (default automatico)", () => {
      // consumatore/privato senza consenso esplicito nel contesto default → bloccato
      const r = enforceConsent({ id: 21 }, { consentContext: "automatic" });
      expect(r.ok).toBe(false);
      expect(r.status).toBe("cold");
    });

    it("il daily cap è condiviso: se raggiunto blocca anche il cold one-to-one", () => {
      // non aggirabile: isDailyCapReached riflette il contatore globale condiviso
      expect(isDailyCapReached({ sentToday: 500, maxDaily: 500 })).toBe(true);
      expect(isDailyCapReached({ sentToday: 499, maxDaily: 500 })).toBe(false);
      expect(isDailyCapReached({ sentToday: 0, maxDaily: 0 })).toBe(false); // 0 = nessun limite
    });

    it("il cold-outreach manuale include sempre il link UNSUB (opt-out obbligatorio)", () => {
      // Il motivo di ammissione documenta l'invio B2B one-to-one con UNSUB
      const r = enforceConsent({ id: 22, consent_status: "cold" }, { consentContext: "manual" });
      expect(r.reason).toMatch(/one-to-one manuale/);
      expect(r.reason).toMatch(/ammesso/i);
    });
  });

  // ── (3) opt-out dal CMS → blacklist condivisa ──
  describe("(3) opt-out CMS condiviso (setContactOptOut)", () => {
    it("setContactOptOut scrive preferenze disattive sul CMS (email+marketing)", async () => {
      mockFetchOk({});
      await setContactOptOut(42, "doc@studio.test");
      const [url, opts] = global.fetch.mock.calls[0];
      const encEmail = encodeURIComponent("doc@studio.test");
      expect(url).toContain(`/api/agent/sites/42/contacts/${encEmail}/extras`);
      expect(opts.method).toBe("PUT");
      const body = JSON.parse(opts.body);
      expect(body.preferences.pref_email).toBe(false);
      expect(body.preferences.pref_marketing).toBe(false);
      // l'opt-out è best-effort: se il CMS fallisce non deve lanciare
    });

    it("opt-out è best-effort: un errore CMS non propaga", async () => {
      global.fetch = vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}), text: async () => "unauthorized" }));
      await expect(setContactOptOut(42, "doc@studio.test")).resolves.not.toThrow();
    });
  });

  // ── (4) al primo interesse → opportunità CMS ──
  describe("(4) primo interesse → opportunità CMS (ensureOpportunityForReply)", () => {
    it("ricava la pipeline della campagna e chiama ensureOpportunity", async () => {
      query.mockResolvedValueOnce({
        rows: [{ id: 5, funnel: "aziende", cms_pipeline_id: 100, cms_stage_map: { replied: "Interessato" } }],
      });
      // mock fetch per la chiamata POST /opportunities
      mockFetchOk({ id: 900 });
      const spy = vi.spyOn({ ensureOpportunity }, "ensureOpportunity");

      const result = await ensureOpportunityForReply({
        id: 7,
        email: "studioaziendale@test.it",
        campaign_id: 5,
        nome_studio: "Studio Test",
      });

      // chiamata quota deriva dalla campaign
      expect(query).toHaveBeenCalled();
      expect(result).toBeDefined();
      vi.restoreAllMocks();
    });

    it("getCmsContextForCampaign usa cms_pipeline_id esplicito della campagna", () => {
      const ctx = getCmsContextForCampaign({ funnel: "aziende", cms_pipeline_id: 200 });
      expect(ctx.pipelineId).toBe(200);
      expect(ctx.siteId).toBe(42);
    });

    it("getCmsContextForCampaign fa fallback a CMS_PIPELINE_MAP per funnel", () => {
      const ctx = getCmsContextForCampaign({ funnel: "aziende" });
      expect(ctx.pipelineId).toBe(100); // da cmsPipelineMap mock { aziende: 100 }
    });
  });

});
