import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/db.js", () => ({
  query: vi.fn(),
  scopeTenant: (tenantId, startIndex = 1) => {
    if (tenantId === null || tenantId === undefined) {
      return { condition: "", values: [] };
    }
    return {
      condition: ` AND (tenant_id IS NULL OR tenant_id = $${startIndex})`,
      values: [tenantId],
    };
  },
}));

const { query } = await import("../../src/db.js");
const { computeFunnelMetrics, FUNNEL_ORDER } = await import("../../src/services/funnel-metrics.js");

function mockSequence(responses) {
  let i = 0;
  query.mockImplementation(() => Promise.resolve(responses[Math.min(i++, responses.length - 1)]));
}

describe("computeFunnelMetrics (requisito 10 — metriche funnel)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("calcola conteggi per stadio, cumulativi e conversion rate coerenti", async () => {
    mockSequence([
      { rows: [
        { funnel_stage: "prospect", count: 100 },
        { funnel_stage: "contacted", count: 40 },
        { funnel_stage: "called", count: 20 },
        { funnel_stage: "booked", count: 10 },
        { funnel_stage: "demo", count: 5 },
        { funnel_stage: "won", count: 2 },
        { funnel_stage: "lost", count: 23 },
      ] }, // stageResult
      { rows: [{ inviate: 65, aperte: 20, cliccate: 8, bounced: 3, risposte: 5 }] }, // emailResult
      { rows: [{ call_status: "interessato", count: 12 }] }, // callResult
      { rows: [{ booking_status: "prenotato", count: 6 }] }, // bookingResult
      { rows: [{ count: 4 }] }, // stuckCountResult
      { rows: [{ id: 1, title: "Azienda X", email: "x@test.it", funnel_stage: "contacted", updated_at: new Date() }] }, // stuckSampleResult
    ]);

    const metrics = await computeFunnelMetrics({});

    expect(metrics.stages.counts).toEqual({
      prospect: 100, contacted: 40, called: 20, booked: 10, demo: 5, won: 2, lost: 23,
    });
    // cumulativo: reached[contacted] = contacted+called+booked+demo+won = 77
    expect(metrics.stages.reached_cumulative.contacted).toBe(40 + 20 + 10 + 5 + 2);
    expect(metrics.stages.reached_cumulative.prospect).toBe(100 + 40 + 20 + 10 + 5 + 2);
    expect(metrics.stages.conversion_rates["prospect_to_contacted_rate"]).toBeCloseTo(
      ((40 + 20 + 10 + 5 + 2) / (100 + 40 + 20 + 10 + 5 + 2)) * 100,
      1
    );
    expect(metrics.email.open_rate).toBeCloseTo((20 / 65) * 100, 1);
    expect(metrics.email.reply_rate).toBeCloseTo((5 / 65) * 100, 1);
    expect(metrics.call_outcomes.interessato).toBe(12);
    expect(metrics.booking_outcomes.prenotato).toBe(6);
    expect(metrics.stuck.count).toBe(4);
    expect(metrics.stuck.sample).toHaveLength(1);
  });

  it("gestisce zero invii senza dividere per zero (rate = null)", async () => {
    mockSequence([
      { rows: [] },
      { rows: [{ inviate: 0, aperte: 0, cliccate: 0, bounced: 0, risposte: 0 }] },
      { rows: [] },
      { rows: [] },
      { rows: [{ count: 0 }] },
      { rows: [] },
    ]);
    const metrics = await computeFunnelMetrics({});
    expect(metrics.email.open_rate).toBeNull();
    expect(metrics.email.reply_rate).toBeNull();
    expect(metrics.stages.counts.prospect).toBe(0);
  });

  it("FUNNEL_ORDER esclude 'lost' (terminale ma non ordinato)", () => {
    expect(FUNNEL_ORDER).not.toContain("lost");
    expect(FUNNEL_ORDER).toEqual(["prospect", "contacted", "called", "booked", "demo", "won"]);
  });

  it("applica il filtro campaign_id ai parametri della query", async () => {
    mockSequence([
      { rows: [] },
      { rows: [{ inviate: 0, aperte: 0, cliccate: 0, bounced: 0, risposte: 0 }] },
      { rows: [] },
      { rows: [] },
      { rows: [{ count: 0 }] },
      { rows: [] },
    ]);
    await computeFunnelMetrics({ campaignId: 7 });
    expect(query.mock.calls[0][0]).toMatch(/campaign_id = \$1/);
    expect(query.mock.calls[0][1]).toEqual([7]);
  });

  it("applica il filtro tenantId a tutte le query quando fornito", async () => {
    mockSequence([
      { rows: [] },
      { rows: [{ inviate: 0, aperte: 0, cliccate: 0, bounced: 0, risposte: 0 }] },
      { rows: [] },
      { rows: [] },
      { rows: [{ count: 0 }] },
      { rows: [] },
    ]);
    await computeFunnelMetrics({ tenantId: 42 });
    // Tutte le query devono includere la condizione tenant
    for (let i = 0; i < query.mock.calls.length; i++) {
      const sql = query.mock.calls[i][0];
      const params = query.mock.calls[i][1];
      expect(sql).toMatch(/tenant_id IS NULL OR tenant_id = \$/);
      expect(params).toContain(42);
    }
  });

  it("non applica filtro tenant quando tenantId è null (retro-compatibilità)", async () => {
    mockSequence([
      { rows: [] },
      { rows: [{ inviate: 0, aperte: 0, cliccate: 0, bounced: 0, risposte: 0 }] },
      { rows: [] },
      { rows: [] },
      { rows: [{ count: 0 }] },
      { rows: [] },
    ]);
    await computeFunnelMetrics({ tenantId: null });
    // Le query NON devono includere la condizione tenant
    for (let i = 0; i < query.mock.calls.length; i++) {
      const sql = query.mock.calls[i][0];
      expect(sql).not.toMatch(/tenant_id IS NULL OR tenant_id = \$/);
    }
  });

  it("combina campaign_id e tenantId nella stessa query", async () => {
    mockSequence([
      { rows: [] },
      { rows: [{ inviate: 0, aperte: 0, cliccate: 0, bounced: 0, risposte: 0 }] },
      { rows: [] },
      { rows: [] },
      { rows: [{ count: 0 }] },
      { rows: [] },
    ]);
    await computeFunnelMetrics({ campaignId: 5, tenantId: 10 });
    const firstCall = query.mock.calls[0];
    expect(firstCall[0]).toMatch(/campaign_id = \$1/);
    expect(firstCall[0]).toMatch(/tenant_id IS NULL OR tenant_id = \$2/);
    expect(firstCall[1]).toEqual([5, 10]);
  });
});
