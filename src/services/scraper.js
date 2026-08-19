import TurndownService from "turndown";
import { URL } from "url";
import { logger } from "./logger.js";
import { checkMemory } from "./memory.js";
import { cacheGet, cacheSet } from "./cache.js";
import { getSetting } from "./settings.js";
import { acquirePage, isBrowserEnabled } from "./browser-pool.js";

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  emDelimiter: "*",
});

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export function isPrivateUrl(urlStr) {
  try {
    const parsed = new URL(urlStr);
    if (parsed.protocol === 'file:' || parsed.protocol === 'data:') return true;
    if (!['http:', 'https:'].includes(parsed.protocol)) return true;
    const hostname = parsed.hostname.toLowerCase();

    const isPrivate = hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "::1" ||
      hostname.startsWith('[') ||
      hostname.endsWith(".local") ||
      hostname.endsWith(".internal") ||
      /^10\.\d+\.\d+\.\d+$/.test(hostname) ||
      /^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/.test(hostname) ||
      /^192\.168\.\d+\.\d+$/.test(hostname) ||
      /^169\.254\.\d+\.\d+$/.test(hostname) ||
      /^127\.\d+\.\d+\.\d+$/.test(hostname) ||
      /^0\.\d+\.\d+\.\d+$/.test(hostname);
    if (isPrivate) return true;

    // Check allowed domains (same logic as routes/scraper.js)
    const allowedDomains = (getSetting("scraper_allowed_domains") || "*.it,*.eu,*.ch,*.com,*.net,*.org").split(",").map(d => d.trim().toLowerCase());
    const matches = allowedDomains.some(pattern => {
      if (pattern.startsWith("*.")) {
        const suffix = pattern.substring(1);
        return hostname === suffix || hostname.endsWith(suffix);
      }
      return hostname === pattern;
    });
    if (!matches) return true;

    return false;
  } catch { return true; }
}

export async function fetchUrl(url, redirectCount = 0) {
  checkMemory();

  const cacheKey = `scrape:${url}`;
  const cached = await cacheGet(cacheKey);
  if (cached && cached.page_length > 500) {
    logger.info("Cache hit scrape", { url });
    return cached;
  }
  // Se in cache ma troppo corto, ricarica (potrebbe essere pagina redirect)
  if (cached) logger.info("Cache too short, refetching", { url, len: cached.page_length });

  if (isPrivateUrl(url)) throw new Error(`URL bloccato (rete interna): ${url}`);
  logger.info("Scraping URL", { url });
  const response = await fetch(url, {
    redirect: "manual",
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    },
    signal: AbortSignal.timeout(30000),
  });

  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get("location");
    if (!location) throw new Error(`Redirect senza Location: ${response.status}`);
    const resolvedUrl = new URL(location, url).href;
    if (!['http:', 'https:'].includes(new URL(resolvedUrl).protocol)) {
      throw new Error(`Schema non consentito: ${new URL(resolvedUrl).protocol}`);
    }
    if (isPrivateUrl(resolvedUrl)) throw new Error(`Redirect bloccato (rete interna): ${resolvedUrl}`);
    if (redirectCount > 10) throw new Error("Troppi redirect (" + redirectCount + ")");
    return fetchUrl(resolvedUrl, redirectCount + 1);
  }

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("text/html") && !contentType.includes("application/xhtml+xml")) {
    throw new Error(`Content-Type non supportato: ${contentType}`);
  }

  const contentLengthHeader = response.headers.get("content-length");
  if (contentLengthHeader) {
    const contentLength = parseInt(contentLengthHeader, 10);
    if (contentLength > MAX_RESPONSE_BYTES) {
      throw new Error(`Risposta troppo grande: ${contentLength} bytes (max ${MAX_RESPONSE_BYTES})`);
    }
  }

  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.length;
    if (totalBytes > MAX_RESPONSE_BYTES) {
      logger.warn("Risposta streaming troppo grande", { url, totalBytes, maxBytes: MAX_RESPONSE_BYTES });
      await reader.cancel();
      throw new Error(`Risposta troppo grande: superati ${MAX_RESPONSE_BYTES} bytes`);
    }
    if (totalBytes > MAX_RESPONSE_BYTES * 0.8) {
      logger.warn("Risposta in avvicinamento al limite", { url, totalBytes, maxBytes: MAX_RESPONSE_BYTES });
    }
    chunks.push(value);
  }

  const totalLen = chunks.reduce((acc, c) => acc + c.length, 0);
  const combined = new Uint8Array(totalLen);
  let pos = 0;
  for (const chunk of chunks) { combined.set(chunk, pos); pos += chunk.length; }
  const charsetMatch = contentType.match(/charset=([\w-]+)/);
  const charset = charsetMatch ? charsetMatch[1] : 'utf-8';
  const decoder = new TextDecoder(charset);
  const html = decoder.decode(combined);

  // Segui meta refresh (es. <meta http-equiv="refresh" content="0; url=https://...">)
  const metaRefreshMatch = html.match(/<meta[^>]+http-equiv\s*=\s*["']refresh["'][^>]*content\s*=\s*["'][^"']*url\s*=\s*([^"']+)["'][^>]*>/i);
  if (metaRefreshMatch) {
    const targetUrl = metaRefreshMatch[1].trim();
    const resolvedUrl = new URL(targetUrl, response.url).href;
    if (['http:', 'https:'].includes(new URL(resolvedUrl).protocol) && !isPrivateUrl(resolvedUrl)) {
      if (redirectCount < 10) {
        logger.info("Meta refresh redirect", { from: response.url, to: resolvedUrl });
        return fetchUrl(resolvedUrl, redirectCount + 1);
      }
    }
  }

  const cleaned = removeExtraTags(html);
  const simplified = simplifyOutput(cleaned);
  let markdown;
  try {
    markdown = turndown.turndown(simplified);
  } catch (err) {
    throw new Error(`Conversione Markdown fallita: ${err.message}`);
  }

  const finalUrl = response.url;
  const realCacheKey = `scrape:${finalUrl}`;

  const result = {
    url: finalUrl,
    original_url: url,
    page_content: markdown,
    page_length: markdown.length,
  };

  // Non cacheare pagine troppo corte (probabili redirect/placeholder)
  if (markdown.length >= 500) {
    await cacheSet(realCacheKey, result, 3600);
  }

  return result;
}

export async function fetchUrlWithBrowser(url, options = {}) {
  checkMemory();

  const cacheKey = `browse:${url}`;
  const cached = await cacheGet(cacheKey);
  if (cached && cached.page_length > 500 && !options.force) {
    logger.info("Browser cache hit", { url });
    return cached;
  }
  if (cached) {
    logger.info("Browser cache troppo corta, rifetch", {
      url,
      len: cached.page_length,
    });
  }

  if (!isBrowserEnabled()) {
    throw new Error("Browser headless disabilitato");
  }

  logger.info("Browser scraping", { url, options });

  let pageObj;
  try {
    pageObj = await acquirePage();
  } catch (err) {
    logger.error("Browser pool non disponibile", {
      url,
      error: err.message,
    });
    throw err;
  }

  const { page, release } = pageObj;
  try {
    // Prova networkidle prima, fallback a domcontentloaded su timeout
    try {
      await page.goto(url, {
        waitUntil: "networkidle",
        timeout: parseInt(process.env.BROWSER_TIMEOUT_MS || "20000", 10),
      });
    } catch (gotoErr) {
      logger.warn("Browser networkidle timeout, tento domcontentloaded", {
        url, error: gotoErr.message
      });
      await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: 15000,
      });
    }

    // Scroll to bottom per triggerare lazy loading (Wix, Duda, Squarespace...)
    if (options.scroll !== false) {
      try {
        await page.evaluate(async () => {
          const distance = 400;
          const delay = 100;
          const totalHeight = await new Promise((resolve) => {
            let scrolled = 0;
            const timer = setInterval(async () => {
              window.scrollBy(0, distance);
              scrolled += distance;
              const scrollHeight = document.body.scrollHeight;
              if (scrolled >= scrollHeight) {
                clearInterval(timer);
                resolve(scrollHeight);
              }
            }, delay);
          });
        });
        // Piccola attesa dopo lo scroll per caricamenti asincroni
        await page.waitForTimeout(500);
      } catch (scrollErr) {
        logger.warn("Browser scroll fallito (non bloccante)", {
          url, error: scrollErr.message
        });
      }
    }

    const finalUrl = page.url();
    const html = await page.content();
    const pageLinks = options.extractLinks ? await extractAllLinksFromPage(page, finalUrl) : [];

    release();

    const cleaned = removeExtraTags(html);
    const simplified = simplifyOutput(cleaned);
    let markdown;
    try {
      markdown = turndown.turndown(simplified);
    } catch (err) {
      throw new Error(`Conversione Markdown fallita: ${err.message}`);
    }

    const result = {
      url: finalUrl,
      original_url: url,
      page_content: markdown,
      page_length: markdown.length,
      links: pageLinks,
    };

    if (markdown.length >= 500) {
      await cacheSet(cacheKey, result, 7200);
    }

    return result;
  } catch (err) {
    release();
    logger.error("Browser scraping fallito", { url, error: err.message });
    throw err;
  }
}

/**
 * Estrae tutti i link interni rilevanti da una pagina browser
 */
async function extractAllLinksFromPage(page, baseUrl) {
  try {
    const links = await page.evaluate(() => {
      const anchors = document.querySelectorAll('a[href]');
      return Array.from(anchors).map(a => a.href).filter(h => h && h.startsWith('http'));
    });
    const base = new URL(baseUrl);
    const baseHost = base.hostname;
    const internal = links.filter(h => {
      try { return new URL(h).hostname === baseHost; } catch { return false; }
    });
    // Deduplica
    return [...new Set(internal)];
  } catch {
    return [];
  }
}

/**
 * Estrae dati strutturati direttamente dall'HTML (Layer 1 — zero AI, istantaneo)
 */
export function extractStructuredData(html, url) {
  const result = {
    nome_studio: null,
    email: null,
    telefono: null,
    descrizione: null,
    indirizzo: null,
    orari: null,
  };

  try {
    // 1. JSON-LD / Schema.org — la fonte più affidabile
    const jsonldMatches = html.match(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi) || [];
    for (const block of jsonldMatches) {
      try {
        const json = JSON.parse(block.replace(/<script[^>]+type=["']application\/ld\+json["'][^>]*>/i, '').replace(/<\/script>/i, '').trim());
        const items = Array.isArray(json) ? json : [json];
        for (const item of items) {
          if (!item['@type']) continue;
          if (['Company', 'LocalBusiness', 'MedicalBusiness', 'MedicalClinic', 'Physician'].includes(item['@type']) || item['@type'] === 'Organization') {
            if (!result.nome_studio) result.nome_studio = item.name || null;
            if (!result.email) result.email = item.email || null;
            if (!result.telefono) result.telefono = item.telephone || item.telePhone || null;
            if (!result.descrizione && item.description) result.descrizione = item.description;
            if (!result.indirizzo && item.address) {
              const addr = typeof item.address === 'string' ? item.address :
                [item.address.streetAddress, item.address.addressLocality, item.address.addressRegion, item.address.postalCode].filter(Boolean).join(', ');
              result.indirizzo = addr;
            }
            if (!result.orari && item.openingHoursSpecification) {
              result.orari = JSON.stringify(item.openingHoursSpecification);
            }
          }
        }
      } catch { /* skip invalid JSON-LD */ }
    }

    // 2. Meta tag OG e standard
    const title = (html.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1];
    const ogTitle = (html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["'][^>]*>/i) || [])[1]
      || (html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["'][^>]*>/i) || [])[1];
    const metaDesc = (html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["'][^>]*>/i) || [])[1]
      || (html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["'][^>]*>/i) || [])[1];
    const ogDesc = (html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["'][^>]*>/i) || [])[1]
      || (html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:description["'][^>]*>/i) || [])[1];
    const ogSiteName = (html.match(/<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)["'][^>]*>/i) || [])[1];

    if (!result.nome_studio) result.nome_studio = ogSiteName || ogTitle || title || null;
    const bestDesc = ogDesc || metaDesc;
    if (!result.descrizione && bestDesc) {
      // Se molto corta, non usarla come descrizione completa ma come supplemento
      if (bestDesc.length >= 80) result.descrizione = bestDesc;
    }

    // 3. Indirizzo email da mailto: link
    const mailtoLinks = html.match(/href=["']mailto:([^"']+)["']/gi) || [];
    for (const m of mailtoLinks) {
      const email = (m.match(/mailto:([^"'\?&]+)/i) || [])[1];
      if (email && !result.email) {
        // Filtra email fake/placeholder
        if (!/example|test|placeholder|sample/i.test(email) && email.includes('@') && !email.startsWith('@')) {
          result.email = decodeURIComponent(email);
        }
      }
    }

    // 4. Indirizzo email nel testo semplice (regex base)
    if (!result.email) {
      const textEmail = html.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || [];
      for (const email of textEmail) {
        if (!/example|test|placeholder|sample/i.test(email) && !email.startsWith('@')) {
          result.email = email;
          break;
        }
      }
    }

    // 5. Telefono da tel: link
    const telLinks = html.match(/href=["']tel:([^"']+)["']/gi) || [];
    for (const t of telLinks) {
      const tel = (t.match(/tel:([^"']+)/i) || [])[1];
      if (tel && !result.telefono) {
        result.telefono = decodeURIComponent(tel);
      }
    }
  } catch { /* silent */ }

  return result;
}

/**
 * Sintetizza un'email di default dal dominio del sito
 * Quando nessuna email reale viene trovata, costruisce info@dominio.it
 */
export function synthesizeEmailFromUrl(url) {
  try {
    const parsed = new URL(url);
    let hostname = parsed.hostname.toLowerCase();
    // Rimuovi www. se presente
    hostname = hostname.replace(/^www\./, '');
    // Salta IP, localhost, domini anomali
    if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname) || hostname === 'localhost') return null;
    // Non creare email per social/generici
    if (/facebook|linkedin|instagram|twitter|youtube|google|whatsapp/i.test(hostname)) return null;
    return `info@${hostname}`;
  } catch {
    return null;
  }
}

function removeExtraTags(html) {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<iframe[^>]*>[\s\S]*?<\/iframe>/gi, "")
    .replace(/<object[^>]*>[\s\S]*?<\/object>/gi, "")
    .replace(/<embed[^>]*>[\s\S]*?<\/embed>/gi, "")
    .replace(/<video[^>]*>[\s\S]*?<\/video>/gi, "")
    .replace(/<audio[^>]*>[\s\S]*?<\/audio>/gi, "")
    .replace(/<svg[^>]*>[\s\S]*?<\/svg>/gi, "");
}

function simplifyOutput(html) {
  return html
    // Rimuovi event handler JavaScript (onclick, onload, onerror, onmouseover, etc.)
    .replace(/\s+on\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    // Rimuovi href/javascript: e link dannosi
    .replace(/href\s*=\s*"(?:javascript|data|vbscript):[^"]*"/gi, 'href=""')
    .replace(/href\s*=\s*'(?:javascript|data|vbscript):[^']*'/gi, "href=''")
    // Rimuovi src/javascript: e iframe dannosi
    .replace(/src\s*=\s*"(?:javascript|data|vbscript):[^"]*"/gi, 'src=""')
    .replace(/src\s*=\s*'(?:javascript|data|vbscript):[^']*'/gi, "src=''")
    // Rimuovi attributi formaction pericolosi
    .replace(/\s+formaction\s*=\s*(?:"[^"]*"|'[^']*')/gi, "")
    // Rimuovi attributi style pericolosi con expression()
    .replace(/style\s*=\s*"(?:[^"]*\bexpression\b[^"]*)"/gi, 'style=""')
    .replace(/style\s*=\s*'(?:[^']*\bexpression\b[^']*)'/gi, "style=''");
}
