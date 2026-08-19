import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SUPPORTED_LANGS = ["it", "en"];
const FALLBACK_LANG = "en";

let localeCache = {};

function loadLocales() {
  if (Object.keys(localeCache).length > 0) {
    return localeCache;
  }
  const localesDir = path.join(__dirname, "..", "..", "locales");
  for (const lang of SUPPORTED_LANGS) {
    const filePath = path.join(localesDir, `${lang}.json`);
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      localeCache[lang] = JSON.parse(content);
    } catch (err) {
      console.warn(`Failed to load ${lang}.json`, err.message);
      localeCache[lang] = {};
    }
  }
  return localeCache;
}

export function translate(lang, key, vars = {}) {
  const locales = loadLocales();
  const dict = locales[lang] || {};
  const fallbackDict = locales[FALLBACK_LANG] || {};

  let text = dict[key] || fallbackDict[key] || key;

  // Interpolation: replace {var} with value
  Object.entries(vars).forEach(([k, v]) => {
    text = text.replace(new RegExp(`{${k}}`, "g"), String(v));
  });

  return text;
}

export function readLocaleMarkdown(lang, filename) {
  const localesDir = path.join(__dirname, "..", "..", "locales");
  const langDir = path.join(localesDir, lang);
  let filePath = path.join(langDir, filename);

  if (!fs.existsSync(filePath) && lang !== FALLBACK_LANG) {
    filePath = path.join(localesDir, FALLBACK_LANG, filename);
  }

  if (fs.existsSync(filePath)) {
    return fs.readFileSync(filePath, "utf-8");
  }

  return "";
}

export function resolveLang(req, defaultLang = "en") {
  if (req.cookies?.lang && SUPPORTED_LANGS.includes(req.cookies.lang)) {
    return req.cookies.lang;
  }
  return defaultLang;
}

export function i18nMiddleware(defaultLang = "en") {
  return (req, res, next) => {
    const lang = resolveLang(req, defaultLang);
    req.lang = lang;
    res.locals.lang = lang;
    res.locals.t = (key, vars) => translate(lang, key, vars);
    next();
  };
}

export { SUPPORTED_LANGS, FALLBACK_LANG };
