import { query } from "../db.js";
import { logger } from "./logger.js";

let cachedPatterns = [];
let lastCacheRefresh = 0;
const CACHE_TTL_MS = 5 * 60 * 1000;

async function getActivePatterns() {
  const now = Date.now();
  if (cachedPatterns.length === 0 || now - lastCacheRefresh > CACHE_TTL_MS) {
    try {
      const result = await query("SELECT id, pattern, description FROM blacklist_patterns WHERE is_active = true ORDER BY id");
      cachedPatterns = result.rows.map(r => {
        try {
          return {
            id: r.id,
            regex: new RegExp(r.pattern, 'i'),
            pattern: r.pattern,
            description: r.description,
          };
        } catch (regexErr) {
          logger.error("Blacklist: pattern regex invalido, saltato", { pattern: r.pattern, error: regexErr.message });
          return null;
        }
      }).filter(Boolean);
      lastCacheRefresh = now;
    } catch (err) {
      logger.warn("Blacklist: cannot load patterns from DB, using empty list", { error: err.message });
      return [];
    }
  }
  return structuredClone(cachedPatterns);
}

export async function checkBlacklist(text) {
  if (!text || text.trim().length < 20) {
    return true; // testi troppo brevi: non blacklistati (safe)
  }

  const patterns = await getActivePatterns();
  const sample = text.slice(0, 5000);
  for (const p of patterns) {
    let matched = false;
    try { matched = p.regex.test(sample); } catch (_) { matched = false; }
    if (matched) {
      logger.warn("Blacklist: pattern match", { pattern: p.pattern, description: p.description });
      await incrementBlockedCount(p.id);
      return false;
    }
  }

  return true;
}

export async function incrementBlockedCount(patternId) {
  try {
    const pattern = await query("SELECT tenant_id FROM blacklist_patterns WHERE id = $1", [patternId]);
    if (!pattern.rows[0]) return;
    const tenantId = pattern.rows[0].tenant_id;
    await query(
      "UPDATE blacklist_patterns SET blocked_count = blocked_count + 1 WHERE id = $1 AND tenant_id =$2)",
      [patternId, tenantId]
    );
  } catch (_) {}
}

export function clearPatternCache() {
  cachedPatterns = [];
  lastCacheRefresh = 0;
}
