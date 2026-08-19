import config from "../config.js";
import { logger } from "../services/logger.js";

const REQUIRED_ENV = [
  ["jwtSecret", "JWT_SECRET"],
  ["databaseUrl", "DATABASE_URL"],
  ["openrouterApiKey", "OPENROUTER_API_KEY"],
];

const MISSING = REQUIRED_ENV.filter(([key]) => !config[key]);
if (MISSING.length > 0) {
  logger.error(`FATAL: Env vars mancanti: ${MISSING.map(([, env]) => env).join(", ")}`);
  process.exit(1);
}

const WARN_ENV = [
  ["serperApiKey", "SERPER_API_KEY"],
  ["groqApiKey", "GROQ_API_KEY"],
  ["smtpHost", "SMTP_HOST"],
];
WARN_ENV.forEach(([key, env]) => {
  if (!config[key]) logger.warn(`${env} non configurata`);
});
