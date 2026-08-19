import config from "../config.js";
import { query } from "../db.js";
import { logger } from "./logger.js";
import { withRetry } from "./retry.js";
import { cacheGet, cacheSet } from "./cache.js";
import { getSetting } from "./settings.js";

async function tryAcquireDailySlot() {
  const dailyLimit = parseInt(getSetting("serper_daily_limit") || "100", 10);
  if (dailyLimit <= 0) throw new Error("Limite giornaliero Serper non valido o disabilitato");
  const result = await query(
    `INSERT INTO daily_api_usage (service, date, count) VALUES ('serper', (NOW() AT TIME ZONE 'Europe/Rome')::date, 1)
     ON CONFLICT (service, date) DO UPDATE SET count = daily_api_usage.count + 1
     WHERE daily_api_usage.count < $1
     RETURNING count`,
    [dailyLimit]
  );
  if (result.rows.length === 0) {
    const current = await query(
      "SELECT count FROM daily_api_usage WHERE service = 'serper' AND date = (NOW() AT TIME ZONE 'Europe/Rome')::date"
    );
    const used = current.rows.length > 0 ? current.rows[0].count : 0;
    throw new Error(`Limite giornaliero Serper raggiunto (${used}/${dailyLimit})`);
  }
  return result.rows[0].count;
}

export async function searchCompanies(comune) {
  const apiKey = getSetting("serper_api_key") || config.serperApiKey;
  if (!apiKey) {
    throw new Error("SERPER_API_KEY non configurata");
  }

  const cacheKey = `serper:${comune}`;
  const cached = await cacheGet(cacheKey);
  if (cached) {
    logger.info("Cache hit Serper", { comune });
    return cached.places || [];
  }

  logger.info("Ricerca aziende via Serper.dev", { comune });

  const usedToday = await tryAcquireDailySlot();
  logger.info("Serper chiamata #" + usedToday + " oggi", { comune });

  let data;
  try {
    data = await withRetry(async () => {
      const response = await fetch("https://google.serper.dev/places", {
        method: "POST",
        headers: {
          "X-API-KEY": apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          q: `azienda a ${comune}, Italia`,
          gl: "it",
          hl: "it",
          num: 100,
        }),
        signal: AbortSignal.timeout(15000),
      });

      if (!response.ok) {
        const err = new Error(`Serper.dev HTTP ${response.status}`);
        err.status = response.status;
        throw err;
      }

      return response.json();
    }, { maxRetries: 1, baseDelay: 2000 });
  } catch (err) {
    // Rimborsa lo slot consumato
    await query("UPDATE daily_api_usage SET count = GREATEST(count - 1, 0) WHERE service = 'serper' AND date = (NOW() AT TIME ZONE 'Europe/Rome')::date AND count > 0").catch(() => {});
    throw err;
  }

  if (data.places?.length > 0) {
    await cacheSet(cacheKey, data, 86400);
  } else {
    await cacheSet(cacheKey, data, 3600);
  }

  return data.places || [];
}

export { tryAcquireDailySlot };
