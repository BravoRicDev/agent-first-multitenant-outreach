import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/db.js", () => ({ query: vi.fn().mockResolvedValue({ rows: [] }) }));
vi.mock("../../src/services/settings.js", () => ({ getSetting: vi.fn() }));
vi.mock("../../src/services/funnel-metrics.js", () => ({ computeFunnelMetrics: vi.fn() }));

const { query } = await import("../../src/db.js");
const { getSetting } = await import("../../src/services/settings.js");
const { computeFunnelMetrics } = await import("../../src/services/funnel-metrics.js");
const { checkFunnelAlerts } = await import("../../src/services/funnel-alerts.js");

function baseSettings(overrides = {}) {
  const defaults = {
    funnel_alert_enabled: "true",
    funnel_alert_open_rate_min: "15",
    funnel_alert_reply_rate_min: "2",
    funnel_alert_stuck_days: "14",
    ...overrides,
  };
  getSetting.mockImplementation((k) => (k in defaults ? defaults[k] : null));
}

function metricsWith({ open_rate = 30, reply_rate = 10, inviate = 100, stuckCount = 0 } = {}) {
  return {
    email: { inviate, open_rate, reply_rate },
    stuck: { count: stuckCount, sample: [] },
    stages: { counts: {} },
  };
}

describe("checkFunnelAlerts (requisito 10 — alert automatizzati)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("non fa nulla se funnel_alert_enabled è 'false'", async () => {
    baseSettings({ funnel_alert_enabled: "false" });
    const result = await checkFunnelAlerts();
    expect(result.checked).toBe(false);
    expect(computeFunnelMetrics).not.toHaveBeenCalled();
  });

  it("nessun alert quando le metriche sono sopra soglia e nessuno stuck", async () => {
    baseSettings();
    computeFunnelMetrics.mockResolvedValue(metricsWith({ open_rate: 30, reply_rate: 10, stuckCount: 0 }));
    const result = await checkFunnelAlerts();
    expect(result.alerts).toHaveLength(0);
    expect(query).not.toHaveBeenCalled(); // nessun audit_log persistito se non ci sono alert
  });

  it("alert open_rate_low quando sotto soglia", async () => {
    baseSettings();
    computeFunnelMetrics.mockResolvedValue(metricsWith({ open_rate: 5, reply_rate: 10 }));
    const result = await checkFunnelAlerts();
    expect(result.alerts.map((a) => a.type)).toContain("open_rate_low");
    expect(query).toHaveBeenCalled(); // persistito in audit_log
  });

  it("alert reply_rate_low quando sotto soglia", async () => {
    baseSettings();
    computeFunnelMetrics.mockResolvedValue(metricsWith({ open_rate: 30, reply_rate: 0.5 }));
    const result = await checkFunnelAlerts();
    expect(result.alerts.map((a) => a.type)).toContain("reply_rate_low");
  });

  it("alert prospects_stuck quando ci sono prospect bloccati", async () => {
    baseSettings();
    computeFunnelMetrics.mockResolvedValue({
      email: { inviate: 100, open_rate: 30, reply_rate: 10 },
      stuck: { count: 3, sample: [{ id: 1 }, { id: 2 }, { id: 3 }] },
      stages: { counts: {} },
    });
    const result = await checkFunnelAlerts();
    const stuckAlert = result.alerts.find((a) => a.type === "prospects_stuck");
    expect(stuckAlert).toBeDefined();
    expect(stuckAlert.count).toBe(3);
  });

  it("nessun alert sui tassi se non è stata inviata nessuna email (evita falsi allarmi a freddo)", async () => {
    baseSettings();
    computeFunnelMetrics.mockResolvedValue(metricsWith({ open_rate: null, reply_rate: null, inviate: 0 }));
    const result = await checkFunnelAlerts();
    expect(result.alerts.filter((a) => a.type.includes("rate"))).toHaveLength(0);
  });

  it("propaga tenantId a computeFunnelMetrics quando fornito", async () => {
    baseSettings();
    computeFunnelMetrics.mockResolvedValue(metricsWith());
    await checkFunnelAlerts(99);
    expect(computeFunnelMetrics).toHaveBeenCalledWith({ stuckDays: 14, tenantId: 99 });
  });

  it("passa tenantId null quando non fornito (cron system-wide)", async () => {
    baseSettings();
    computeFunnelMetrics.mockResolvedValue(metricsWith());
    await checkFunnelAlerts();
    expect(computeFunnelMetrics).toHaveBeenCalledWith({ stuckDays: 14, tenantId: null });
  });
});
