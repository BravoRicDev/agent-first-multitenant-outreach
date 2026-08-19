import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { query } from "../../src/db.js";

// Mock del modulo db (usato da cms.js per risolvere la pipeline della campagna)
vi.mock("../../src/db.js", () => ({ query: vi.fn() }));

// Config CMS fittizia (nessun segreto reale: token placeholder)
vi.mock("../../src/config.js", () => ({
  default: {
    cmsBaseUrl: "https://cms.test.local",
    cmsAgentToken: "agtok_test_placeholder",
    cmsSiteId: 42,
    cmsPipelineMap: { aziende: 100 },
  },
}));

const { ensureOpportunityForStage, addNote } = await import("../../src/services/cms.js");

function mockFetchOk(body = {}) {
  global.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => body, text: async () => "" }));
}

describe("cms.ensureOpportunityForStage — avanzamento funnel B2B (setting/booking)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
    query.mockResolvedValue({ rows: [] });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete global.fetch;
  });

  it("risolve la pipeline dalla campagna e crea l'opportunità con lo stage mappato", async () => {
    query.mockResolvedValueOnce({
      rows: [{ id: 5, funnel: "aziende", cms_pipeline_id: 100, cms_stage_map: { interessato: "Interessato telefonico" } }],
    });
    mockFetchOk({ id: 901 });

    const result = await ensureOpportunityForStage(
      { id: 7, email: "azienda@test.it", campaign_id: 5, nome_studio: "Azienda Test" },
      { stageKey: "interessato", probability: 50, notes: "Interessato al telefono." }
    );

    expect(result).toBeDefined();
    const [url, opts] = global.fetch.mock.calls[0];
    expect(url).toContain("/api/agent/sites/42/opportunities");
    const body = JSON.parse(opts.body);
    expect(body.stage).toBe("Interessato telefonico");
    expect(body.pipeline_id).toBe(100);
    expect(body.probability).toBe(50);
  });

  it("fa fallback a CMS_PIPELINE_MAP quando la campagna non ha cms_pipeline_id esplicito", async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 5, funnel: "aziende", cms_pipeline_id: null, cms_stage_map: null }] });
    mockFetchOk({ id: 902 });

    await ensureOpportunityForStage(
      { id: 8, email: "altra@test.it", campaign_id: 5 },
      { stageKey: "booked", probability: 55, notes: "Videocall prenotata." }
    );

    const [, opts] = global.fetch.mock.calls[0];
    const body = JSON.parse(opts.body);
    expect(body.pipeline_id).toBe(100); // da cmsPipelineMap { aziende: 100 }
    expect(body.stage).toBeNull(); // nessuna stage map -> stage non risolto, ma la chiamata avviene comunque
  });

  it("è best-effort: nessuna pipeline risolvibile -> non chiama il CMS e non lancia", async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 6, funnel: "sconosciuto", cms_pipeline_id: null, cms_stage_map: null }] });
    const result = await ensureOpportunityForStage(
      { id: 9, email: "senza-pipeline@test.it", campaign_id: 6 },
      { stageKey: "demo", probability: 70 }
    );
    expect(result).toBeNull();
  });

  it("è best-effort: un errore del CMS non propaga", async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 5, funnel: "aziende", cms_pipeline_id: 100, cms_stage_map: {} }] });
    global.fetch = vi.fn(async () => ({ ok: false, status: 403, json: async () => ({}), text: async () => "forbidden" }));
    await expect(
      ensureOpportunityForStage({ id: 10, email: "errore@test.it", campaign_id: 5 }, { stageKey: "demo", probability: 70 })
    ).resolves.toBeNull();
  });

  it("senza email o id, ritorna null senza toccare il DB/CMS", async () => {
    const result = await ensureOpportunityForStage({ id: null, email: "senza-id@test.it" }, { stageKey: "demo" });
    expect(result).toBeNull();
    expect(query).not.toHaveBeenCalled();
  });

  it("addNote è best-effort: un errore del CMS non propaga (usato da call-outcome/booking)", async () => {
    global.fetch = vi.fn(async () => ({ ok: false, status: 403, json: async () => ({}), text: async () => "forbidden" }));
    await expect(addNote(42, "nota@test.it", "Esito chiamata: interessato")).resolves.toBeNull();
  });
});
