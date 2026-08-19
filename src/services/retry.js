import { logger } from "./logger.js";

const RETRYABLE_STATUSES = [408, 429, 500, 502, 503, 504];

function isRetryable(err, options = {}) {
  const customStatuses = options.retryableStatuses || [];
  const allStatuses = [...RETRYABLE_STATUSES, ...customStatuses];
  if (err?.status && allStatuses.includes(err.status)) return true;
  if (err?.cause === "timeout") return true;
  if (err?.name === "AbortError" || err?.name === "TimeoutError") return true;
  if (err?.message?.includes("timeout") || err?.message?.includes("ETIMEDOUT") || err?.message?.includes("ECONNRESET") || err?.message?.includes("AbortError")) return true;
  if (err?.message?.includes("rate limit") || err?.message?.includes("too many requests") || err?.message?.includes("circuit breaker")) return true;
  return false;
}

export async function withRetry(fn, options = {}) {
  const maxRetries = options.maxRetries ?? 3;
  const baseDelay = options.baseDelay ?? 1000;
  const maxDelay = options.maxDelay ?? 16000;

  let lastError;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;

      if (attempt >= maxRetries || !isRetryable(err, options)) {
        break;
      }

      const delay = Math.min(baseDelay * Math.pow(2, attempt), maxDelay);
      const jitter = Math.random() * delay * 0.1;
      const totalDelay = delay + jitter;

      logger.warn(`Retryable error, tentativo ${attempt + 1}/${maxRetries}`, { delay: Math.round(totalDelay), error: err.message });

      await new Promise(r => setTimeout(r, totalDelay));
    }
  }

  throw lastError;
}
