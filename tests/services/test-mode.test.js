import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/db.js", () => ({ query: vi.fn() }));
vi.mock("../../src/services/settings.js", () => ({ getSetting: vi.fn() }));
vi.mock("../../src/services/tenants.js", () => ({ isTenantTestMode: vi.fn() }));

const { query } = await import("../../src/db.js");
const { getSetting } = await import("../../src/services/settings.js");
const { isTenantTestMode } = await import("../../src/services/tenants.js");
const {
  isTestModeEnabled,
  listTestRecipients,
  addTestRecipient,
  removeTestRecipient,
  resolveTestRecipient,
} = await import("../../src/services/test-mode.js");

describe("test-mode (requisito 7 — modalità test + destinatari test)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    query.mockResolvedValue({ rows: [] });
  });

  describe("isTestModeEnabled", () => {
    it("false quando la setting è 'false' o assente", () => {
      getSetting.mockReturnValue("false");
      expect(isTestModeEnabled()).toBe(false);
      getSetting.mockReturnValue(null);
      expect(isTestModeEnabled()).toBe(false);
    });
    it("true quando la setting è 'true'", () => {
      getSetting.mockReturnValue("true");
      expect(isTestModeEnabled()).toBe(true);
    });
  });

  describe("resolveTestRecipient — la barriera finale", () => {
    it("test_mode disattivo: nessuna deviazione, invio al reale", async () => {
      getSetting.mockReturnValue("false");
      const r = await resolveTestRecipient("cliente.reale@example.com");
      expect(r).toEqual({ to: "cliente.reale@example.com", testMode: false, diverted: false, blocked: false });
    });

    it("test_mode attivo con destinatari: devia SEMPRE, mai al reale", async () => {
      getSetting.mockReturnValue("true");
      query.mockResolvedValueOnce({ rows: [{ id: 1, email: "test@interno.local", note: null, created_at: new Date() }] });
      const r = await resolveTestRecipient("cliente.reale@example.com");
      expect(r.testMode).toBe(true);
      expect(r.diverted).toBe(true);
      expect(r.blocked).toBe(false);
      expect(r.to).toBe("test@interno.local");
      expect(r.to).not.toBe("cliente.reale@example.com");
    });

    it("test_mode attivo SENZA destinatari: blocca, 'to' è null (impossibile inviare al reale)", async () => {
      getSetting.mockReturnValue("true");
      query.mockResolvedValueOnce({ rows: [] });
      const r = await resolveTestRecipient("cliente.reale@example.com");
      expect(r.blocked).toBe(true);
      expect(r.to).toBeNull();
    });

    it("test_mode per-tenant attivo (globale disattivo): devia verso destinatario test", async () => {
      getSetting.mockReturnValue("false");
      isTenantTestMode.mockResolvedValueOnce(true);
      query.mockResolvedValueOnce({ rows: [{ id: 1, email: "test@interno.local", note: null, created_at: new Date() }] });
      const r = await resolveTestRecipient("cliente.reale@example.com", 100);
      expect(r.testMode).toBe(true);
      expect(r.diverted).toBe(true);
      expect(r.blocked).toBe(false);
      expect(r.to).toBe("test@interno.local");
    });

    it("test_mode per-tenant disattivo: invio al reale", async () => {
      getSetting.mockReturnValue("false");
      isTenantTestMode.mockResolvedValueOnce(false);
      const r = await resolveTestRecipient("cliente.reale@example.com", 100);
      expect(r).toEqual({ to: "cliente.reale@example.com", testMode: false, diverted: false, blocked: false });
    });

    it("test_mode per-tenant attivo SENZA destinatari: blocca", async () => {
      getSetting.mockReturnValue("false");
      isTenantTestMode.mockResolvedValueOnce(true);
      query.mockResolvedValueOnce({ rows: [] });
      const r = await resolveTestRecipient("cliente.reale@example.com", 100);
      expect(r.blocked).toBe(true);
      expect(r.to).toBeNull();
    });

    it("test_mode: errore verifica tenant (non blocca, default conservativo)", async () => {
      getSetting.mockReturnValue("false");
      isTenantTestMode.mockRejectedValueOnce(new Error("DB error"));
      const r = await resolveTestRecipient("cliente.reale@example.com", 100);
      expect(r.blocked).toBe(false);
      expect(r.to).toBe("cliente.reale@example.com");
    });
  });

  describe("listTestRecipients / addTestRecipient / removeTestRecipient", () => {
    it("listTestRecipients interroga la tabella test_recipients", async () => {
      query.mockResolvedValueOnce({ rows: [{ id: 1, email: "a@b.it" }] });
      const rows = await listTestRecipients();
      expect(rows).toHaveLength(1);
      expect(query.mock.calls[0][0]).toMatch(/FROM test_recipients/);
    });

    it("addTestRecipient rifiuta un'email non valida senza toccare il DB", async () => {
      await expect(addTestRecipient("non-una-email", null, 1, 100)).rejects.toThrow(/non valida/);
      expect(query).not.toHaveBeenCalled();
    });

    it("addTestRecipient richiede tenantId (multi-tenant obbligatorio)", async () => {
      await expect(addTestRecipient("test@example.com", null, 1, null)).rejects.toThrow(/tenantId.*required/);
      expect(query).not.toHaveBeenCalled();
    });

    it("addTestRecipient normalizza (trim + lowercase) e inserisce", async () => {
      query.mockResolvedValueOnce({ rows: [{ id: 2, email: "test@example.com", note: "nota", created_at: new Date() }] });
      const r = await addTestRecipient("  Test@Example.com  ", "nota", 7, 100);
      expect(query.mock.calls[0][1][0]).toBe("test@example.com");
      expect(r.email).toBe("test@example.com");
    });

    it("removeTestRecipient restituisce false se l'id non esiste", async () => {
      query.mockResolvedValueOnce({ rows: [] });
      const removed = await removeTestRecipient(999);
      expect(removed).toBe(false);
    });
  });
});
