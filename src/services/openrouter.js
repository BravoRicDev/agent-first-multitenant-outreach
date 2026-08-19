import config from "../config.js";
import { logger } from "./logger.js";
import { withRetry } from "./retry.js";
import { getSetting } from "./settings.js";

async function openRouterFetch(model, messages, options = {}) {
  const totalLen = messages.reduce((acc, m) => acc + (m.content?.length || 0), 0);
  if (totalLen > 300000) {
    throw new Error(`OpenRouter: messaggi troppo lunghi (${totalLen} caratteri, max 300000)`);
  }
  const body = {
    model,
    messages,
    top_p: options.topP ?? 1,
    max_tokens: options.maxTokens || 4096,
    temperature: options.temperature ?? 0.7,
  };

  if (!options.skipResponseFormat) {
    const fmt = options.responseFormat || { type: "json_object" };
    if (!options.responseFormat) {
      logger.warn("openRouterFetch: using default response_format json_object", { model });
    }
    body.response_format = fmt;
  }

  const baseUrl = getSetting("openrouter_base_url") || config.openrouterBaseUrl;
  const apiKey = getSetting("openrouter_api_key") || config.openrouterApiKey;

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": getSetting("openrouter_referer") || process.env.OPENROUTER_REFERER || config.brand.refererUrl,
      "X-Title": config.brand.openRouterTitle,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(options.timeout || 60000),
  });

  if (response.status === 429) {
    const retryAfter = parseInt(response.headers.get("Retry-After") || "60", 10);
    const err = new Error(`OpenRouter HTTP 429 rate limited`);
    err.status = 429;
    err.retryAfter = retryAfter;
    throw err;
  }
  if (!response.ok) {
    const text = await response.text();
    const err = new Error(`OpenRouter HTTP ${response.status}: ${text}`);
    err.status = response.status;
    throw err;
  }

  const data = await response.json();
  const msg = data.choices?.[0]?.message;
  if (!msg?.content && msg?.reasoning) {
    logger.info("openRouterFetch: model returned reasoning-only, extracting from reasoning", { model });
  }
  return msg?.content ?? '';
}

export async function callOpenRouter(model, messages, options = {}) {
  const apiKey = getSetting("openrouter_api_key") || config.openrouterApiKey;
  if (!apiKey || !apiKey.trim()) {
    throw new Error("OPENROUTER_API_KEY non configurata");
  }

  try {
    const result = await withRetry(async () => {
      return await openRouterFetch(model, messages, options);
    }, { maxRetries: 2, baseDelay: 2000, maxDelay: 10000 });
    return result;
  } catch (err) {
    if (err?.status === 400 && !options.skipResponseFormat) {
      logger.warn("OpenRouter: response_format non supportato, ritento senza", { model });
      const result = await withRetry(async () => {
        return await openRouterFetch(model, messages, { ...options, skipResponseFormat: true });
      }, { maxRetries: 1, baseDelay: 2000 });
      return result;
    }
    throw err;
  }
}

async function groqFetch(model, messages, options = {}) {
  const body = {
    model: model || "mixtral-8x7b-32768",
    messages,
  };

  if (!options.skipResponseFormat) {
    const fmt = options.responseFormat || { type: "json_object" };
    if (!options.responseFormat) {
      logger.warn("groqFetch: using default response_format json_object", { model });
    }
    body.response_format = fmt;
  }

  const groqApiKey = getSetting("groq_api_key") || config.groqApiKey;

  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${groqApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(options.timeout || 30000),
  });

  if (!response.ok) {
    const text = await response.text();
    const err = new Error(`Groq HTTP ${response.status}: ${text}`);
    err.status = response.status;
    throw err;
  }

  const data = await response.json();
  return data.choices?.[0]?.message?.content || "";
}

export async function callGroq(model, messages, options = {}) {
  const apiKey = getSetting("groq_api_key") || config.groqApiKey;
  if (!apiKey || !apiKey.trim()) {
    throw new Error("GROQ_API_KEY non configurata");
  }

  try {
    return await withRetry(async () => {
      return await groqFetch(model, messages, options);
    }, { maxRetries: 1, baseDelay: 2000 });
  } catch (err) {
    if (err?.status === 400 && !options.skipResponseFormat) {
      logger.warn("Groq: response_format non supportato, ritento senza", { model });
      return await withRetry(async () => {
        return await groqFetch(model, messages, { ...options, skipResponseFormat: true });
      }, { maxRetries: 1, baseDelay: 2000 });
    }
    throw err;
  }
}
