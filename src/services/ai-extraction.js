import config from "../config.js";
import { callOpenRouter } from "./openrouter.js";
import { fetchUrl, fetchUrlWithBrowser, synthesizeEmailFromUrl } from "./scraper.js";
import { logger } from "./logger.js";
import { checkMemory } from "./memory.js";
import { getSetting } from "./settings.js";
import { URL } from "url";

// Domini social / non scrapabili via HTTP fetch — skip immediato
const UNSCRAPABLE_DOMAINS = [
  "facebook.com", "www.facebook.com", "fb.com",
  "instagram.com", "www.instagram.com",
  "linkedin.com", "www.linkedin.com",
  "twitter.com", "www.twitter.com", "x.com",
  "youtube.com", "www.youtube.com", "youtu.be",
  "tiktok.com", "www.tiktok.com",
];

// Pattern per link interni rilevanti da cercare automaticamente nella homepage
const RELEVANT_LINK_PATTERNS = [
  /contatti?\b/i, /contact\b/i, /chi.siamo\b/i, /about\b/i,
  /team\b/i, /staff\b/i, /medici\b/i, /company(i|a)\b/i,
  /servizi\b/i, /services\b/i, /prestazioni\b/i, /cure\b/i,
  /studio\b/i, /clinica\b/i, /dove.siamo\b/i, /dovesiamo\b/i,
  /orari?\b/i, /dove\b/i, /indirizzo\b/i,
];



const SYSTEM_PROMPT = `Sei un agente di estrazione dati specializzato nell'analisi di siti web di aziende.

IL TUO OBIETTIVO: Analizzare il contenuto TI FORNISCO GIA' (homepage + eventuali pagine interne) ed estrarre informazioni in formato JSON.

REGOLE FONDAMENTALI (leggile con attenzione):
1. NON INVENTARE NIENTE. Se un dato non è presente nel testo fornito, restituisci null.
2. NON usare nomi placeholder come "Mario Rossi", "esempio", "test", "placeholder".
3. L'email DEVE essere reale e verificabile nel testo. Se non c'è, restituisci null.
4. La descrizione DEVE essere sostanziosa (minimo 100 caratteri). Se il testo non contiene abbastanza info, restituisci null.
5. "nome_studio_aziendale" è il nome ufficiale dello studio/clinica (es. "Studio Aziendale Rossi", "Polodent", "Clinica De Carli").
6. "nome_azienda" sono i nomi dei medici (es. "Dott. Paolo De Carli", "Dott. Enrico De Carli").
7. "descrizione" deve essere un riassunto DETTAGLIATO di ciò che offre lo studio: servizi, specializzazioni, tecnologie, sedi, storia, orari, approccio. Deve essere ricavato dal testo REALE, non inventato.
8. Se lo studio ha più sedi (es. "Udine, Trieste, Pordenone..."), includile nella descrizione.
9. I link alle pagine interne vanno indicati SOLO se sono URL reali trovati nel contenuto. Non inventare percorsi.

STRUTTURA JSON OBBLIGATORIA:
{
  "url_sito": "URL finale del sito (string o null)",
  "nome_studio_aziendale": "string o null",
  "nome_azienda": "string o null",
  "email_azienda": "string o null",
  "descrizione": "string (min 100 caratteri) o null",
  "altre_pagine_rilevanti": ["url_reale_1", "url_reale_2"] o []
}

REGOLE DI OUTPUT:
- Restituisci SOLO un oggetto JSON valido, nient'altro.
- Non usare blocchi di codice markdown.
- Output deve iniziare con { e finire con }.`;

export const HALLUCINATED_PATTERNS = [
  /esempio/i, /example/i, /^test\b/i, /placeholder/i, /sample/i,
  /mario rossi/i, /marco bianchi/i, /luca bianchi/i, /giuseppe verdi/i, /luca mesina/i,
  /azienda\s*$/i, /studio professionale\s*$/i, /centro aziendale\s*$/i,
  /società e/i,
];

function isQualityExtraction(data) {
  if (!data) return false;
  if (!data.nome_studio_aziendale || data.nome_studio_aziendale.trim().length < 3) return false;
  for (const p of HALLUCINATED_PATTERNS) {
    if (p.test(data.nome_studio_aziendale)) return false;
  }
  if (!data.descrizione || data.descrizione.trim().length < 100) return false;
  if (data.nome_azienda) {
    for (const p of HALLUCINATED_PATTERNS) {
      if (p.test(data.nome_azienda)) return false;
    }
  }
  return true;
}

function getExtractionPrompt() {
  return getSetting("prompt_extraction") || SYSTEM_PROMPT;
}

/**
 * Trova link interni rilevanti da un set di link (da browser extraction)
 */
function findRelevantLinks(links, baseUrl) {
  try {
    const base = new URL(baseUrl);
    const baseHost = base.hostname;
    const relevant = links.filter(h => {
      try {
        const parsed = new URL(h);
        if (parsed.hostname !== baseHost) return false;
        const path = parsed.pathname.toLowerCase();
        return RELEVANT_LINK_PATTERNS.some(p => p.test(path));
      } catch { return false; }
    });
    return [...new Set(relevant)];
  } catch { return []; }
}

/**
 * Estrae dati via AI in singola chiamata (Layer 3)
 * Contenuto già raccolto dalle fasi precedenti, nessun tool calling
 */
async function extractWithAI(finalUrl, combinedContent) {
  const userContent = `URL del sito: ${finalUrl}\n\nCONTENUTO COMPLETO (homepage + pagine interne):\n${combinedContent.slice(0, 40000)}`;

  const messages = [
    { role: "system", content: getExtractionPrompt() },
    { role: "user", content: userContent },
  ];

  try {
    const content = await callOpenRouter(
      getSetting("openrouter_model_extraction") || config.openrouterModelExtraction,
      messages,
      {
        topP: 0.3,
        temperature: 0.1,
        responseFormat: { type: "json_object" },
      }
    );

    const parsed = JSON.parse(content.replace(/```json|```/g, "").trim());
    const result = {
      url_sito: parsed.url_sito || finalUrl,
      nome_studio_aziendale: parsed.nome_studio_aziendale || null,
      nome_azienda: parsed.nome_azienda || null,
      email_azienda: parsed.email_azienda || synthesizeEmailFromUrl(finalUrl),
      descrizione: parsed.descrizione || null,
      altre_pagine_rilevanti: Array.isArray(parsed.altre_pagine_rilevanti)
        ? parsed.altre_pagine_rilevanti.join(", ") : null,
    };

    if (!isQualityExtraction(result)) {
      logger.warn("Estrazione AI scartata: output bassa qualità/allucinato", {
        url: finalUrl,
        nome: result.nome_studio_aziendale,
        desc_len: (result.descrizione || '').length,
        email: result.email_azienda,
      });
      return null;
    }
    return result;
  } catch (err) {
    logger.error("AI extraction fallita", { url: finalUrl, error: err.message });
    return null;
  }
}

/**
 * Estrazione multi-layer da un sito web
 *
 * Layer 1: HTML strutturato (metatag, JSON-LD, mailto — zero AI, zero browser)
 * Layer 2: Browser smart (scroll, link extraction, subpage fetch)
 * Layer 3: AI single-pass con tutti i contenuti combinati
 */
export async function extractFromWebsite(url) {
  checkMemory();

  // Skip immediato per social/non scrapabili
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase();
    if (UNSCRAPABLE_DOMAINS.some(d => hostname === d || hostname.endsWith('.' + d))) {
      logger.info("Extraction: skip dominio non scrapabile", { url, hostname });
      return null;
    }
  } catch {}

  logger.info("Extraction multi-layer", { url });

  // ====== LAYER 1: HTML Structured Data (zero AI, zero browser) ======
  try {
    logger.info("Layer 1: HTML structured data", { url });
    const scraped = await fetchUrl(url);
    const finalUrl = scraped.url || url;
    const pageContent = scraped.page_content;

    // Fetch HTML grezzo per estrazione strutturata (JSON-LD, meta, mailto)
    if (pageContent.length >= 500) {
      // Tentiamo un fetch raw per l'estrazione HTML strutturata
      try {
        const rawResponse = await fetch(url, {
          redirect: "follow",
          headers: { "User-Agent": "Mozilla/5.0" },
          signal: AbortSignal.timeout(10000),
        });
        if (rawResponse.ok) {
          const rawHtml = await rawResponse.text();
          const htmlData = (await import("./scraper.js")).extractStructuredData(rawHtml, finalUrl);

          if (htmlData.nome_studio && htmlData.descrizione && htmlData.descrizione.length >= 100) {
            // Controllo qualità: nome studio deve essere un nome, non una frase
            const isName = htmlData.nome_studio.length <= 50
              && !htmlData.nome_studio.includes('  ') // No spazi doppi
              && !/^(dedichiamo|benvenuto|perché|scopri|il tuo|la tua|al tuo|il nostro|benvenut)/i.test(htmlData.nome_studio);

            if (isName) {
              logger.info("Layer 1: HTML extraction sufficiente!", {
                url: finalUrl,
                nome_studio: htmlData.nome_studio,
                desc_len: htmlData.descrizione.length,
                email: htmlData.email,
              });
              return {
                url_sito: finalUrl,
                nome_studio_aziendale: htmlData.nome_studio,
                nome_azienda: null,
                email_azienda: htmlData.email || synthesizeEmailFromUrl(finalUrl),
                descrizione: htmlData.descrizione,
                altre_pagine_rilevanti: null,
              };
            }
            logger.info("Layer 1: nome_studio sospetto (troppo lungo o non valido), passo a Layer 2", {
              nome_studio: htmlData.nome_studio?.slice(0, 40),
            });
          }
          logger.info("Layer 1: HTML extraction parziale, passo a Layer 2", {
            nome_studio: htmlData.nome_studio?.slice(0, 30),
            desc_len: htmlData.descrizione?.length || 0,
            email: htmlData.email,
          });
        }
      } catch { /* raw fetch fallito, continuo */ }
    }
  } catch { /* Layer 1 fallito, continuo con Layer 2 */ }

  // ====== LAYER 2: Browser Smart ======
  let browserContent = null;
  let browserFinalUrl = url;
  let allContent = "";
  let allLinks = [];
  let visitedSubpages = [];

  try {
    logger.info("Layer 2: Browser smart", { url });

    // 2a. Browser homepage con scroll + link extraction
    const browserScraped = await fetchUrlWithBrowser(url, {
      extractLinks: true,
      scroll: true,
    });
    browserContent = browserScraped.page_content;
    browserFinalUrl = browserScraped.url || url;
    allLinks = browserScraped.links || [];

    if (browserContent.length < 500) {
      logger.warn("Layer 2: Browser contenuto insufficiente", {
        url, len: browserContent.length
      });
      return null;
    }

    allContent = `--- HOMEPAGE ---\n${browserContent}`;

    // 2b. Trova link rilevanti e fetcha le pagine interne
    const relevantLinks = findRelevantLinks(allLinks, browserFinalUrl);
    logger.info("Layer 2: Link interni trovati", {
      total: allLinks.length,
      relevant: relevantLinks.length,
      links: relevantLinks.slice(0, 10),
    });

    // Fetcha le prime 3 pagine interne rilevanti
    const toVisit = relevantLinks.slice(0, 3);
    for (const link of toVisit) {
      try {
        checkMemory();
        const subScraped = await fetchUrlWithBrowser(link, {
          extractLinks: false,
          scroll: true,
        });
        visitedSubpages.push(link);
        allContent += `\n\n--- PAGINA: ${link} ---\n${subScraped.page_content}`;
      } catch (subErr) {
        logger.warn("Layer 2: Subpage fetch fallito", {
          url: link, error: subErr.message
        });
        // Prova HTTP fetch fallback
        try {
          const subScraped = await fetchUrl(link);
          visitedSubpages.push(link);
          allContent += `\n\n--- PAGINA: ${link} ---\n${subScraped.page_content}`;
        } catch { /* skip */ }
      }
    }

    logger.info("Layer 2: Browser smart completato", {
      url: browserFinalUrl,
      homepage_len: browserContent.length,
      total_len: allContent.length,
      subpages_visited: visitedSubpages.length,
    });
  } catch (err) {
    logger.error("Layer 2: Browser smart fallito", { url, error: err.message });
    // Se Layer 1 ha già parziali, tentiamo Layer 3 lo stesso
    if (!browserContent || browserContent.length < 500) return null;
  }

  // ====== LAYER 3: AI Single-Pass ======
  logger.info("Layer 3: AI extraction single-pass", {
    url: browserFinalUrl,
    content_len: allContent.length,
  });

  return await extractWithAI(browserFinalUrl, allContent);
}
