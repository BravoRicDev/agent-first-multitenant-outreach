import { query } from "../db.js";
import { logger } from "./logger.js";

export async function cacheGet(key) {
  const result = await query(
    "SELECT value FROM response_cache WHERE key = $1 AND expires_at > NOW()",
    [key]
  );
  return result.rows.length > 0 ? result.rows[0].value : null;
}

export async function cacheSet(key, value, ttlSeconds = 3600) {
  if (value === undefined) {
    logger.warn("cacheSet: tentativo di cache con undefined", { key });
    return;
  }
  const ttl = Number(ttlSeconds);
  const safeTtl = Number.isFinite(ttl) && ttl >= 0 ? Math.floor(ttl) : 3600;
  const serialized = JSON.stringify(value);
  await query(
    `INSERT INTO response_cache (key, value, expires_at)
     VALUES ($1, $2::jsonb, NOW() + $3::text::INTERVAL)
     ON CONFLICT (key) DO UPDATE SET value = $2::jsonb, expires_at = NOW() + $3::text::INTERVAL`,
    [key, serialized, `${safeTtl} seconds`]
  );
}

export async function cacheClear(prefix) {
  await query("DELETE FROM response_cache WHERE key LIKE $1", [`${prefix}%`]);
}
