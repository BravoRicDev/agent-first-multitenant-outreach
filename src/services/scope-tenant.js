// FASE 1 MULTI-TENANT — helper di scope (SPEC §4 Fase 1)
// =======================================================
// Scoping per tenant_id: ogni record appartiene a UN tenant esatto.
// Il tenant è OBBLIGATORIO a runtime — non esiste più il concetto di "tenant 0" /
// dato visibile a tutti. Tenant arriva SEMPRE dalla config/risoluzione token
// (mai da argomento runtime utente).
//
// Modulo puro (nessuna dipendenza dal pool DB) per poterlo testare isolato.
// Uso previsto:
//   const { scopeTenant } = await import("../services/scope-tenant.js");
//   const scope = scopeTenant(tenantId);   // { condition, values }
//   await query(`SELECT * FROM companies WHERE 1=1 ${scope.condition}`, scope.values);
//
// tenantId obbligatorio: se nullo/undefined, lancia TypeError. Multi-tenant è ora
// semantica esclusiva — ogni dato è di un tenant specifico, niente neutralità.
export function scopeTenant(tenantId, startIndex = 1) {
  if (tenantId === null || tenantId === undefined) {
    throw new TypeError("tenantId is required (multi-tenant is now mandatory)");
  }
  const i = Number.isInteger(startIndex) ? startIndex : 1;
  return {
    condition: ` AND tenant_id = $${i}`,
    values: [tenantId],
  };
}

export default scopeTenant;
