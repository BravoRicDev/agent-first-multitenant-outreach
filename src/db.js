import pg from "pg";
import config from "./config.js";
import { logger } from "./services/logger.js";

if (!config.databaseUrl) {
  throw new Error("DATABASE_URL non configurata");
}

const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: 15,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on("error", (err) => {
  logger.error("Unexpected error on idle client", { error: err.message });
});

export async function query(text, params) {
  return pool.query(text, params);
}

export async function getClient() {
  return pool.connect();
}

// --- FASE 1 MULTI-TENANT: helper di scope (SPEC §4 Fase 1) ---
// Re-export dal modulo puro src/services/scope-tenant.js (testabile isolato).
// Semantica: record appartiene a un tenant se tenant_id == fornito OPPURE NULL
// (tenant 0/mono-tenant storico). Il tenant arriva SEMPRE dalla config/risoluzione
// del token, mai da argomento runtime. In questo giro è esposto ma non applicato
// alle query: l'applicazione per-rotta avviene in fase successiva con test, così
// zero variazioni di comportamento oggi.
export { scopeTenant } from "./services/scope-tenant.js";

export async function transaction(callback) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export default pool;
