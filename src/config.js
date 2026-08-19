import dotenv from "dotenv";
dotenv.config();

const jwtSecret = process.env.JWT_SECRET;
if (!jwtSecret || jwtSecret.length < 32) {
  throw new Error("JWT_SECRET deve essere configurato e avere almeno 32 caratteri");
}

const portStr = process.env.PORT || "3000";
const port = parseInt(portStr, 10);
if (isNaN(port) || port < 0 || port > 65535) {
  throw new Error(`PORT deve essere un numero tra 0 e 65535, ricevuto "${portStr}"`);
}

export default {
  port,
  nodeEnv: process.env.NODE_ENV || "development",

  databaseUrl: process.env.DATABASE_URL,
  jwtSecret,
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || "24h",

  trustProxy: process.env.TRUST_PROXY === "true"
    ? true
    : (/^\d+$/.test(process.env.TRUST_PROXY || "") ? parseInt(process.env.TRUST_PROXY, 10) : false),

  smtpHost: process.env.SMTP_HOST || "",
  smtpPort: parseInt(process.env.SMTP_PORT || "587", 10),
  smtpUser: process.env.SMTP_USER || "",
  smtpPass: process.env.SMTP_PASS || "",
  emailFrom: process.env.EMAIL_FROM || "noreply@outreach.local",

  // Branding del servizio (configurabile, default generici "Outreach Service").
  brand: {
    name: process.env.OUTR_APP_NAME || "Outreach Service",
    defaultFromName: process.env.OUTR_DEFAULT_FROM_NAME || "Outreach Service",
    supportEmail: process.env.OUTR_SUPPORT_EMAIL || "",
    supportUrl: process.env.OUTR_SUPPORT_URL || "",
    refererUrl: process.env.OUTR_REFERER_URL || "",
    openRouterTitle: process.env.OUTR_OPENROUTER_TITLE || "Outreach Service",
    footerCompany: process.env.OUTR_FOOTER_COMPANY || "",
    footerVat: process.env.OUTR_FOOTER_VAT || "",
    footerAddress: process.env.OUTR_FOOTER_ADDRESS || "",
    footerPhone: process.env.OUTR_FOOTER_PHONE || "",
  },

  magicLinkBaseUrl: process.env.MAGIC_LINK_BASE_URL || "http://localhost:3000",
  magicLinkExpiryMs: parseInt(process.env.MAGIC_LINK_EXPIRY_MS || "900000", 10),

  openrouterApiKey: process.env.OPENROUTER_API_KEY || "",
  openrouterBaseUrl: process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1",
  openrouterModelExtraction: process.env.OPENROUTER_MODEL_EXTRACTION || "google/gemini-2.0-flash-lite-preview",
  openrouterModelCopywriter: process.env.OPENROUTER_MODEL_COPYWRITER || "openai/gpt-4o-mini",
  openrouterModelValidator: process.env.OPENROUTER_MODEL_VALIDATOR || "google/gemini-2.0-flash-lite-preview",

  serperApiKey: process.env.SERPER_API_KEY || "",

  groqApiKey: process.env.GROQ_API_KEY || "",

  outreachSmtpHost: process.env.OUTREACH_SMTP_HOST || "",
  outreachSmtpPort: parseInt(process.env.OUTREACH_SMTP_PORT || "465", 10),
  outreachSmtpUser: process.env.OUTREACH_SMTP_USER || "",
  outreachSmtpPass: process.env.OUTREACH_SMTP_PASS || "",
  outreachEmailFrom: process.env.OUTREACH_EMAIL_FROM || "",

  // Integrazione col CMS agent-first (agent-first-simple-newsletter-cms), sostituisce GHL.
  // Servizio mono-tenant: un'istanza = un CMS_SITE_ID. Token statico "agtok_..." generato
  // via /admin/api-tokens sul CMS (nessuna OTP necessaria per un servizio esterno).
  cmsBaseUrl: (process.env.CMS_BASE_URL || "").replace(/\/+$/, ""),
  cmsAgentToken: process.env.CMS_AGENT_TOKEN || "",
  cmsSiteId: process.env.CMS_SITE_ID ? parseInt(process.env.CMS_SITE_ID, 10) : null,
  // Mappa opzionale funnel -> pipeline_id di fallback quando una campagna non ha un
  // cms_pipeline_id esplicito. Formato JSON, es: {"aziende":1,"aziende":2}
  cmsPipelineMap: (() => {
    if (!process.env.CMS_PIPELINE_MAP) return {};
    try { return JSON.parse(process.env.CMS_PIPELINE_MAP); }
    catch { return {}; }
  })(),

  logLevel: process.env.LOG_LEVEL || "info",

  defaultLang: process.env.DEFAULT_LANG || "en",
};
