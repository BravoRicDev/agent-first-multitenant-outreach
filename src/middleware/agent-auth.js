import rateLimit from "express-rate-limit";
import { verifyApiToken } from "../services/api-tokens.js";
import { logger } from "../services/logger.js";

// Rate limit dedicato a /api/agent (più stretto dell'apiLimiter generico):
// l'agente/MCP può chiamare in modo rapido ma non deve poter martellare il DB.
export const agentLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Troppe richieste agente. Riprova tra 1 minuto." },
  skip: () => false,
});

// Middleware di autenticazione agente: Authorization: Bearer agtok_...
// Confronto sicuro (timingSafeEqual) via services/api-tokens.js.
// Propaga tenant_id dal token per il scoping delle query.
export async function requireAgent(req, res, next) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";

  if (!token) {
    return res.status(401).json({ error: "Autenticazione agente richiesta" });
  }

  const user = await verifyApiToken(token).catch((err) => {
    logger.error("Verifica token agente fallita", { error: err.message });
    return null;
  });

  if (!user) {
    return res.status(401).json({ error: "Token agente non valido o scaduto" });
  }

  req.user = user;
  res.locals.user = user;
  next();
}
