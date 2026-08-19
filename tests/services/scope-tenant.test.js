import { describe, it, expect } from "vitest";
import { scopeTenant } from "../../src/services/scope-tenant.js";

// Unit test dell'helper scopeTenant (Fase 1 multi-tenant, SPEC §4 Fase 1).
// Modulo puro (nessuna dipendenza dal pool DB) => testabile isolato.

describe("scopeTenant (Fase 1 multi-tenant — tenant obbligatorio)", () => {
  it("tenantId nullo/undefined => TypeError (tenant obbligatorio)", () => {
    expect(() => scopeTenant(null)).toThrow(TypeError);
    expect(() => scopeTenant(undefined)).toThrow(TypeError);
  });

  it("tenantId numerico => condizione AND su tenant_id = puro", () => {
    const s = scopeTenant(7);
    expect(s.condition).toBe(" AND tenant_id = $1");
    expect(s.values).toEqual([7]);
  });

  it("multi-tenant esclusivo: ogni dato è di un tenant specifico", () => {
    const s = scopeTenant(7);
    expect(s.condition).toBe(" AND tenant_id = $1");
    expect(s.condition).not.toContain("IS NULL");
  });

  it("startIndex sposta il placeholder (per query con parametri precedenti)", () => {
    const s2 = scopeTenant(7, 2);
    expect(s2.condition).toBe(" AND tenant_id = $2");
    expect(s2.values).toEqual([7]);
    // startIndex non intero => fallback a 1
    expect(scopeTenant(7, "x").condition).toBe(" AND tenant_id = $1");
  });
});
