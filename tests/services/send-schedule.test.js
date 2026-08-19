import { describe, it, expect } from "vitest";
import { resolveSendContext, enforceSchedulingConsent, SEND_CONTEXT } from "../../src/services/send-schedule.js";

describe("send-schedule: gate freddi vs consensati (folle automatiche)", () => {
  it("risolve il default come contesto 'automatic'", () => {
    const c = resolveSendContext({ consent_status: "marketing" });
    expect(c.context).toBe(SEND_CONTEXT.AUTOMATIC);
    expect(c.consent_status).toBe("marketing");
  });

  it("marca esplicitamente 'manual' l'invio one-to-one", () => {
    const c = resolveSendContext({ send_context: "manual", consent_status: "cold" });
    expect(c.context).toBe(SEND_CONTEXT.MANUAL);
  });

  it("ammette SOLO i marketing nelle folle/schedulazione automatica", () => {
    expect(enforceSchedulingConsent({ consent_status: "marketing", context: SEND_CONTEXT.AUTOMATIC }).ok).toBe(true);
    expect(enforceSchedulingConsent({ consent_status: "cold", context: SEND_CONTEXT.AUTOMATIC }).ok).toBe(false);
  });

  it("blocca il cold anche quando manca esplicitamente il consenso in automatico", () => {
    const r = enforceSchedulingConsent({ consent_status: undefined, context: SEND_CONTEXT.AUTOMATIC });
    expect(r.ok).toBe(false);
    expect(r.status).toBe("cold");
  });

  it("ammette il cold SOLO nel flusso one-to-one manuale", () => {
    const r = enforceSchedulingConsent({ consent_status: "cold", context: SEND_CONTEXT.MANUAL });
    expect(r.ok).toBe(true);
  });

  it("il cold ammesso resta comunque un cold (non viene promosso a marketing)", () => {
    const r = enforceSchedulingConsent({ consent_status: "cold", context: SEND_CONTEXT.MANUAL });
    expect(r.status).toBe("cold");
  });
});
