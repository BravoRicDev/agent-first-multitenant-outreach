import { chromium } from "playwright-core";
import { logger } from "./logger.js";
import { checkMemory } from "./memory.js";

const BROWSER_ENABLED = process.env.BROWSER_ENABLED === "true";
const MAX_PAGES = parseInt(process.env.BROWSER_MAX_PAGES || "4", 10);
const CHROMIUM_PATH = process.env.CHROMIUM_PATH || "/usr/bin/chromium-browser";

let browserInstance = null;
let isLaunching = false;
let launchPromise = null;
let contextCounter = 0;

// Coda semplice per serializzare accesso a contextCounter (thread-safe)
let contextLock = Promise.resolve();

export function isBrowserEnabled() {
  return BROWSER_ENABLED;
}

export async function getBrowser() {
  if (!BROWSER_ENABLED) {
    throw new Error("Browser headless disabilitato (BROWSER_ENABLED != true)");
  }

  if (browserInstance && browserInstance.isConnected()) {
    return browserInstance;
  }

  if (isLaunching) {
    return launchPromise;
  }

  isLaunching = true;
  launchPromise = (async () => {
    checkMemory();
    logger.info("Avvio browser Chromium...", { executablePath: CHROMIUM_PATH });

    browserInstance = await chromium.launch({
      executablePath: CHROMIUM_PATH,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--disable-software-rasterizer",
        "--no-zygote",
        "--disable-background-networking",
        "--disable-background-timer-throttling",
        "--disable-backgrounding-occluded-windows",
        "--disable-breakpad",
        "--disable-component-update",
        "--disable-domain-reliability",
        "--disable-extensions",
        "--disable-features=AudioServiceOutOfProcess",
        "--disable-hang-monitor",
        "--disable-ipc-flooding-protection",
        "--disable-notifications",
        "--disable-offer-store-unmasked-wallet-cards",
        "--disable-popup-blocking",
        "--disable-print-preview",
        "--disable-prompt-on-repost",
        "--disable-renderer-backgrounding",
        "--disable-speech-api",
        "--disable-sync",
        "--hide-scrollbars",
        "--ignore-gpu-blacklist",
        "--metrics-recording-only",
        "--mute-audio",
        "--no-default-browser-check",
        "--no-first-run",
        "--no-pings",
        "--password-store=basic",
        "--use-mock-keychain",
      ],
    });

    browserInstance.on("disconnected", () => {
      logger.warn("Chromium disconnesso, verrà ricreato alla prossima richiesta");
      browserInstance = null;
    });

    logger.info("Browser Chromium avviato");

    return browserInstance;
  })();

  try {
    const result = await launchPromise;
    return result;
  } finally {
    isLaunching = false;
  }
}

// Acquires a page context in a thread-safe manner
async function acquireContextLock() {
  let release;
  const prevLock = contextLock;
  contextLock = new Promise(resolve => { release = resolve; });
  await prevLock;
  return release;
}

export async function acquirePage() {
  if (!BROWSER_ENABLED) {
    throw new Error("Browser headless disabilitato (BROWSER_ENABLED != true)");
  }

  const releaseLock = await acquireContextLock();
  try {
    if (contextCounter >= MAX_PAGES) {
      throw new Error(
        `Limite pagine browser raggiunto (${MAX_PAGES}), riprova più tardi`
      );
    }

    const browser = await getBrowser();

    const context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      viewport: { width: 1920, height: 1080 },
      locale: "it-IT",
      javaScriptEnabled: true,
      ignoreHTTPSErrors: true,
    });

    const page = await context.newPage();
    contextCounter++;

    releaseLock();

    return {
      page,
      context,
      release: () => {
        context.close().catch((err) => {
          logger.warn("Errore chiusura contesto browser", { error: err.message });
        }).finally(() => {
          contextCounter--;
        });
      },
    };
  } catch (err) {
    releaseLock();
    throw err;
  }
}

export async function gracefulShutdown() {
  if (browserInstance?.isConnected()) {
    logger.info("Chiusura browser Chromium in corso...");
    try {
      await browserInstance.close();
      logger.info("Browser Chromium chiuso correttamente");
    } catch (err) {
      logger.warn("Errore chiusura browser", { error: err.message });
    }
    browserInstance = null;
  }
}
