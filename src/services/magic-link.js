import crypto from "crypto";
import { query } from "../db.js";
import { sendEmail } from "./email.js";
import { logger } from "./logger.js";
import config from "../config.js";
import { getSetting } from "./settings.js";

const MAGIC_LINK_EXPIRY_MS = 15 * 60 * 1000;
const verifyAttempts = new Map();
const VERIFY_MAX_ATTEMPTS = 10;
const VERIFY_WINDOW_MS = 15 * 60 * 1000;

export async function generateAndSend(email) {
  const userResult = await query(
    "SELECT id, email, name FROM users WHERE LOWER(email) = LOWER($1) AND status = 'active'",
    [email]
  );
  if (userResult.rows.length === 0) {
    return { sent: false, reason: "Utente non trovato o disabilitato" };
  }
  const user = userResult.rows[0];

  const token = crypto.randomBytes(48).toString("hex");
  const otp = crypto.randomInt(100000, 999999).toString();
  const expiresAt = new Date(Date.now() + MAGIC_LINK_EXPIRY_MS);

  const client = await (await import("../db.js")).getClient();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM magic_links WHERE user_id = $1 AND used_at IS NULL", [user.id]);
    await client.query(
      "INSERT INTO magic_links (user_id, token, otp, expires_at) VALUES ($1, $2, $3, $4)",
      [user.id, token, otp, expiresAt]
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  const baseUrl = getSetting("magic_link_base_url") || config.magicLinkBaseUrl;
  const link = `${baseUrl}/login/verify?token=${token}`;

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:20px;">
<h2>${config.brand.name} — Accesso</h2>
<p>Hai richiesto l'accesso alla piattaforma ${config.brand.name}.</p>
<p><strong>Il tuo codice OTP:</strong></p>
<div style="font-size:32px;letter-spacing:8px;font-weight:bold;text-align:center;padding:20px;background:#f5f5f5;border-radius:8px;margin:16px 0;">${otp}</div>
<p>Oppure clicca sul link sottostante:</p>
<a href="${link}" style="display:inline-block;padding:12px 24px;background:#4f46e5;color:white;text-decoration:none;border-radius:6px;margin:8px 0;">Accedi a ${config.brand.name}</a>
<p style="color:#666;font-size:12px;margin-top:24px;">Link valido 15 minuti. Se non hai richiesto tu questo accesso, ignora questa email.</p>
</body></html>`;

  try {
    await sendEmail({ to: email, subject: `${config.brand.name} — Il tuo codice di accesso`, html });
  } catch (err) {
    logger.error("Failed to send magic link email: " + err.message);
    return { sent: false, reason: "Errore invio email" };
  }
  return { sent: true };
}

export async function verify(token, otp) {
  const attempts = verifyAttempts.get(token) || [];
  const now = Date.now();
  const recent = attempts.filter(t => now - t < VERIFY_WINDOW_MS);
  if (recent.length >= VERIFY_MAX_ATTEMPTS) return null;
  recent.push(now);
  verifyAttempts.set(token, recent);
  // Cleanup periodico Map
  if (verifyAttempts.size > 1000) {
    for (const [k, v] of verifyAttempts) {
      if (v.every(t => now - t >= VERIFY_WINDOW_MS)) verifyAttempts.delete(k);
    }
  }

  const result = await query(
    `WITH updated AS (
       UPDATE magic_links SET used_at = NOW()
       WHERE token = $1 AND otp = $2 AND used_at IS NULL AND expires_at > NOW()
         AND user_id IN (SELECT id FROM users WHERE status = 'active')
       RETURNING user_id
     )
     SELECT u.id, u.email, u.name, u.role, u.status
     FROM updated ml
     JOIN users u ON u.id = ml.user_id`,
    [token, otp]
  );

  if (result.rows.length === 0) return null;
  const link = result.rows[0];
  if (link.status === "disabled") return { disabled: true };
  return { id: link.id, email: link.email, name: link.name, role: link.role };
}
