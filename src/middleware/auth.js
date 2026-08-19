import jwt from "jsonwebtoken";
import config from "../config.js";
import { query } from "../db.js";
import { logger } from "../services/logger.js";

const userStatusCache = new Map();
const USER_CACHE_TTL = 60000;

// Cleanup periodico della cache ogni 5 minuti
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of userStatusCache) {
    if (v.expires <= now) userStatusCache.delete(k);
  }
}, 300000).unref();

export async function requireAuth(req, res, next) {
  const fromCookie = !!req.cookies?.token;
  let token = req.cookies?.token || req.headers.authorization?.replace("Bearer ", "");

  if (!token) {
    if (req.path.startsWith("/api")) {
      return res.status(401).json({ error: "Autenticazione richiesta" });
    }
    return res.redirect("/login");
  }

  try {
    const decoded = jwt.verify(token, config.jwtSecret, { algorithms: ["HS256"] });
    const user = await query("SELECT id, email, name, role FROM users WHERE id = $1 AND status = 'active'", [decoded.sub]);
    if (!user.rows[0]) {
      if (fromCookie) res.clearCookie("token", { httpOnly: true, secure: config.nodeEnv === "production", sameSite: "lax" });
      if (req.path.startsWith("/api")) return res.status(401).json({ error: "Account non attivo o non trovato" });
      return res.redirect("/login");
    }
    req.user = { sub: user.rows[0].id, email: user.rows[0].email, name: user.rows[0].name, role: user.rows[0].role };

    const cached = userStatusCache.get(req.user.sub);
    if (cached && cached.expires > Date.now()) {
      if (cached.status !== "active") {
        if (fromCookie) res.clearCookie("token", { httpOnly: true, secure: config.nodeEnv === "production", sameSite: "lax" });
        if (req.path.startsWith("/api")) return res.status(401).json({ error: "Account non attivo" });
        return res.redirect("/login");
      }
      res.locals.user = req.user;
      return next();
    }

    const userCheck = await query("SELECT status FROM users WHERE id = $1", [req.user.sub]);
    if (userCheck.rows.length === 0 || userCheck.rows[0].status !== "active") {
      if (fromCookie) res.clearCookie("token", { httpOnly: true, secure: config.nodeEnv === "production", sameSite: "lax" });
      if (req.path.startsWith("/api")) return res.status(401).json({ error: "Account non attivo" });
      return res.redirect("/login");
    }
    userStatusCache.set(req.user.sub, { status: "active", expires: Date.now() + USER_CACHE_TTL });
    res.locals.user = req.user;
    next();
  } catch (err) {
    if (err?.name === 'TokenExpiredError' || err?.name === 'JsonWebTokenError' || err?.code === 'ERR_JWT_EXPIRED' || err?.code === 'ERR_JWT_INVALID') {
      if (fromCookie) res.clearCookie("token", { httpOnly: true, secure: config.nodeEnv === "production", sameSite: "lax" });
      if (req.path.startsWith("/api")) {
        return res.status(401).json({ error: "Token non valido" });
      }
      return res.redirect("/login");
    }
    if (fromCookie) res.clearCookie("token", { httpOnly: true, secure: config.nodeEnv === "production", sameSite: "lax" });
    logger.error("Auth middleware error", { error: err?.message, stack: err?.stack });
    return res.status(500).json({ error: "Errore interno autenticazione" });
  }
}

export function requireAdmin(req, res, next) {
  if (!req.user || (req.user.role !== "superadmin" && req.user.role !== "admin")) {
    if (req.path.startsWith("/api")) {
      return res.status(403).json({ error: "Accesso negato" });
    }
    return res.status(403).render("error", { message: "Accesso negato" });
  }
  next();
}

export function clearUserCache(userId) {
  userStatusCache.delete(userId);
}
