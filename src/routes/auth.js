import { Router } from "express";
import jwt from "jsonwebtoken";
import { z } from "zod";
import config from "../config.js";
import { generateAndSend, verify } from "../services/magic-link.js";
import { query } from "../db.js";
import { logger } from "../services/logger.js";
import rateLimit from "express-rate-limit";

const router = Router();

const loginSchema = z.object({ email: z.string().trim().email() });

router.get("/login", (req, res) => {
  if (req.user) return res.redirect("/dashboard");
  const errors = { session_expired: "Sessione scaduta, riaccedi per favore." };
  res.render("login", { error: errors[req.query.error] || null, layout: false });
});

router.get("/login/verify", async (req, res) => {
  try {
    if (req.user) return res.redirect("/dashboard");
    const { token } = req.query;
    if (!token) return res.redirect("/login");
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
    res.render("verify", { token, layout: false, expiresAt });
  } catch (err) {
    res.redirect("/login?error=errore");
  }
});

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 10,
  message: { error: "Troppi tentativi di login. Riprova tra 15 minuti." },
  standardHeaders: true, legacyHeaders: false,
});

router.post("/api/auth/login", loginLimiter, async (req, res, next) => {
  try {
    const { email } = loginSchema.parse(req.body);
    const result = await generateAndSend(email);
    return res.json({ sent: true, message: "Se l'email esiste, riceverai un codice di accesso." });
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: "Email non valida" });
    return next(err);
  }
});

const verifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 10,
  message: { error: "Troppi tentativi di verifica. Riprova tra 15 minuti." },
  standardHeaders: true, legacyHeaders: false,
});

router.post("/api/auth/verify", verifyLimiter, async (req, res, next) => {
  try {
    const { token, otp } = req.body;
    if (!token || !otp) return res.status(400).json({ error: "Token e OTP richiesti" });

    const user = await verify(token, otp.trim());
    if (!user) return res.status(401).json({ error: "Codice non valido o scaduto" });
    if (user.disabled) return res.status(403).json({ error: "Utente disabilitato", disabled: true });

    const jwtToken = jwt.sign(
      { sub: user.id, email: user.email, name: user.name, role: user.role },
      config.jwtSecret,
      { algorithm: "HS256", expiresIn: config.jwtExpiresIn }
    );
    res.cookie("token", jwtToken, {
      httpOnly: true, secure: config.nodeEnv === "production",
      sameSite: "lax", maxAge: 24 * 60 * 60 * 1000,
    });

    await query(
      `INSERT INTO audit_log (user_id, action, resource, details, ip_address)
       VALUES ($1, 'login', 'auth', $2, $3)`,
      [user.id, JSON.stringify({ email: user.email }), req.ip]
    );
    return res.json({ success: true, redirect: "/dashboard" });
  } catch (err) {
    return next(err);
  }
});

router.post("/api/auth/logout", async (req, res) => {
  if (req.user) {
    await query(
      `INSERT INTO audit_log (user_id, action, resource) VALUES ($1, 'logout', 'auth')`,
      [req.user.sub]
    ).catch(err => logger.error("Audit logout fallito", { userId: req.user.sub, error: err.message }));
  }
  res.clearCookie("token");
  res.redirect("/login");
});

export default router;
