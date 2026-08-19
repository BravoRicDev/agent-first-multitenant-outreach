import { query } from "../db.js";
import { logger } from "./logger.js";
import crypto from "crypto";

const INSTANCE_ID = crypto.randomUUID();

export async function acquireLock(name, ttlSeconds = 300) {
  const actualTtl = Math.min(typeof ttlSeconds === 'number' && !isNaN(ttlSeconds) ? ttlSeconds : 300, 3600);
  try {
    const result = await query(
      `WITH updated AS (
         UPDATE app_locks SET locked_at = NOW(), instance_id = $3
         WHERE name = $1 AND locked_at < NOW() - (CAST($2 AS TEXT) || ' seconds')::INTERVAL
         RETURNING name, instance_id
       ), inserted AS (
         INSERT INTO app_locks (name, locked_at, ttl_seconds, instance_id)
         SELECT $1, NOW(), $4, $3
         WHERE NOT EXISTS (SELECT 1 FROM updated)
           AND NOT EXISTS (SELECT 1 FROM app_locks WHERE name = $1)
         RETURNING name, instance_id
       )
       SELECT COUNT(*)::int > 0 AS acquired FROM (
         SELECT name FROM updated UNION ALL SELECT name FROM inserted
       ) AS result`,
      [name, actualTtl, INSTANCE_ID, actualTtl]
    );
    return result.rows[0]?.acquired || false;
  } catch (err) {
    logger.error("Lock acquire error", { name, error: err.message });
    return false;
  }
}

export async function releaseLock(name) {
  try {
    await query("DELETE FROM app_locks WHERE name = $1 AND instance_id = $2", [name, INSTANCE_ID]);
  } catch (err) {
    logger.error("Lock release error", { name, error: err.message });
  }
}

export const lastRunTimes = new Map();

export async function withLock(name, fn, ttlSeconds = 300) {
  const acquired = await acquireLock(name, ttlSeconds);
  if (!acquired) {
    logger.warn("Lock non acquisito, skip", { name, instance: INSTANCE_ID });
    return false;
  }
  logger.info("Lock acquisito", { name, instance: INSTANCE_ID });
  const startTime = Date.now();
  let lastError = null;
  try {
    await fn();
    lastRunTimes.set(name, new Date().toISOString());
    return true;
  } catch (err) {
    logger.error("Lock execution error", { name, error: err.message });
    lastError = err;
    lastRunTimes.set(name, `ERR: ${err.message}`);
    throw err;
  } finally {
    const duration = Math.round((Date.now() - startTime) / 1000);
    try {
      await query(
        `INSERT INTO cron_status (name, last_run_at, last_duration_seconds, last_error)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (name) DO UPDATE SET last_run_at = $2, last_duration_seconds = $3, last_error = $4`,
        [name, new Date().toISOString(), duration, lastError?.message || null]
      );
    } catch (dbErr) {
      logger.warn("Failed to persist cron_status", { name, error: dbErr.message });
    }
    await releaseLock(name);
    logger.info("Lock rilasciato", { name, instance: INSTANCE_ID });
  }
}

export const locks = {
  get municipalityLock() { throw new Error("Usa withLock('municipality', ...) invece di locks.municipalityLock"); },
  get emailDraftLock() { throw new Error("Usa withLock('emailDraft', ...) invece di locks.emailDraftLock"); },
  get cleanupLock() { throw new Error("Usa withLock('cleanup', ...) invece di locks.cleanupLock"); },
  get queueLock() { throw new Error("Usa withLock('emailQueue', ...) invece di locks.queueLock"); },
  get followUpLock() { throw new Error("Usa withLock('followUp', ...) invece di locks.followUpLock"); },
};
