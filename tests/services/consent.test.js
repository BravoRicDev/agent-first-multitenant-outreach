import { describe, it, expect } from "vitest";
import { enforceConsent } from "../../src/services/email-sender.js";

describe("enforceConsent (freddi vs consensati)", () => {
  it("permette l'invio di un contatto marketing in contesto automatico", () => {
    const r = enforceConsent({ id: 1, consent_status: "marketing" }, { consentContext: "automatic" });
    expect(r.ok).toBe(true);
    expect(r.status).toBe("marketing");
  });

  it("blocca un contatto cold in campagna/sequenza automatica", () => {
    const r = enforceConsent({ id: 2, consent_status: "cold" }, { consentContext: "automatic" });
    expect(r.ok).toBe(false);
    expect(r.status).toBe("cold");
  });

  it("permette un cold solo nel flusso one-to-one manuale", () => {
    const r = enforceConsent({ id: 3, consent_status: "cold" }, { consentContext: "manual" });
    expect(r.ok).toBe(true);
  });

  it("default cold=bloccato se manca explicit consent in contesto automatico", () => {
    const r = enforceConsent({ id: 4 }, { consentContext: "automatic" });
    expect(r.ok).toBe(false);
  });
});

describe("enforceConsent — consenso granulare per canale (retro-compatibilità e per-canale)", () => {
  it("consent_channels NULL → comportamento IDENTICO a oggi (marketing ammesso)", () => {
    const r = enforceConsent(
      { id: 100, consent_status: "marketing", consent_channels: null },
      { consentContext: "automatic" }
    );
    expect(r.ok).toBe(true);
    expect(r.reason).toContain("consenso marketing presente");
  });

  it("consent_channels NULL → comportamento IDENTICO a oggi (cold in automatic bloccato)", () => {
    const r = enforceConsent(
      { id: 101, consent_status: "cold", consent_channels: null },
      { consentContext: "automatic" }
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("cold in contesto automatico");
  });

  it("consent_channels NULL → comportamento IDENTICO a oggi (cold in manual ammesso)", () => {
    const r = enforceConsent(
      { id: 102, consent_status: "cold", consent_channels: null },
      { consentContext: "manual" }
    );
    expect(r.ok).toBe(true);
    expect(r.reason).toContain("one-to-one manuale");
  });

  it("consent_channels = {email: true} → ammesso (per-canale)", () => {
    const r = enforceConsent(
      { id: 200, consent_channels: { email: true, sms: false, phone: false, whatsapp: false } },
      { consentContext: "automatic" }
    );
    expect(r.ok).toBe(true);
    expect(r.reason).toContain("consenso email per canale presente");
    expect(r.reason).toContain("legitimate_interest");
  });

  it("consent_channels = {email: false} → bloccato (default rigido)", () => {
    const r = enforceConsent(
      { id: 201, consent_channels: { email: false, sms: false, phone: false, whatsapp: false } },
      { consentContext: "automatic" }
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("email non consentita");
    expect(r.reason).toContain("default rigido");
  });

  it("consent_channels = {} → bloccato (canale email mancante = default rigido)", () => {
    const r = enforceConsent(
      { id: 202, consent_channels: {} },
      { consentContext: "automatic" }
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("email non consentita");
  });

  it("consent_channels = {email: true} con consent_basis = 'consent' → registrato in audit", () => {
    const r = enforceConsent(
      {
        id: 203,
        consent_channels: { email: true, sms: true, phone: false },
        consent_basis: "consent",
      },
      { consentContext: "automatic", campaignId: 50 }
    );
    expect(r.ok).toBe(true);
    expect(r.reason).toContain("consent");
  });

  it("consent_channels = {email: true} default consent_basis = 'legitimate_interest'", () => {
    const r = enforceConsent(
      { id: 204, consent_channels: { email: true } },
      { consentContext: "automatic" }
    );
    expect(r.ok).toBe(true);
    expect(r.reason).toContain("legitimate_interest");
  });

  it("consente solo email=true, ignora altri canali", () => {
    const r = enforceConsent(
      {
        id: 205,
        consent_channels: { email: true, sms: false, phone: false, whatsapp: false },
      },
      { consentContext: "automatic" }
    );
    expect(r.ok).toBe(true);
  });
});
