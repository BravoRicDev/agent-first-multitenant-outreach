import crypto from "crypto";
import { query } from "../db.js";

const TOKEN_PREFIX = "agtok_";

export function hashToken(rawToken) {
  return crypto.createHash("sha256").update(rawToken).digest("hex");
}

export function isApiTokenFormat(rawToken) {
  return typeof rawToken === "string" && rawToken.startsWith(TOKEN_PREFIX);
}

// Il valore in chiaro esiste solo qui, al momento della creazione — mai
// salvato, mai più recuperabile dopo (stesso modello dei PAT GitHub/Stripe).
export async function createApiToken(userId, name, expiresInDays = 365, tenantId = null) {
  const raw = TOKEN_PREFIX + crypto.randomBytes(32).toString("hex");
  const prefix = raw.slice(0, 14) + "…";
  const expiresAt =
    expiresInDays > 0
      ? new Date(Date.now() + expiresInDays * 86400000)
      : null;

  const result = await query(
    `INSERT INTO api_tokens (user_id, name, token_hash, token_prefix, expires_at, tenant_id)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, created_at`,
    [userId, name.slice(0, 255), hashToken(raw), prefix, expiresAt, tenantId]
  );

  return {
    id: result.rows[0].id,
    token: raw,
    prefix,
    expiresAt,
    createdAt: result.rows[0].created_at,
  };
}

// Verifica un token API agente. Restituisce l'utente (forma dei campi di un
// JWT agente) o null se sconosciuto/scaduto/revocato/utente disabilitato.
// Il confronto tra hash usa timingSafeEqual (confronto sicuro).
export async function verifyApiToken(rawToken) {
  if (!isApiTokenFormat(rawToken)) return null;

  const digest = hashToken(rawToken);
  const result = await query(
    "SELECT id, token_hash, user_id, expires_at, revoked_at, tenant_id FROM api_tokens WHERE token_hash = $1",
    [digest]
  ).catch(() => ({ rows: [] }));
  const row = result.rows[0];
  if (!row) return null;

  const provided = Buffer.from(digest, "hex");
  const stored = Buffer.from(row.token_hash, "hex");
  const equal =
    provided.length === stored.length && crypto.timingSafeEqual(provided, stored);
  if (!equal) return null;
  if (row.revoked_at) return null;
  if (row.expires_at && new Date(row.expires_at) <= new Date()) return null;

  const u = await query(
    "SELECT id, email, name, role FROM users WHERE id = $1 AND status = 'active'",
    [row.user_id]
  ).catch(() => ({ rows: [] }));
  const userRow = u.rows[0];
  if (!userRow) return null;

  query("UPDATE api_tokens SET last_used_at = NOW() WHERE id = $1 AND tenant_id =$2)", [row.id, row.tenant_id]).catch(() => {});

  return {
    sub: userRow.id,
    email: userRow.email,
    name: userRow.name,
    role: userRow.role,
    tenant_id: row.tenant_id,
    agent: true,
    api_token: true,
  };
}

export async function listApiTokens(userId) {
  return (
    await query(
      `SELECT id, name, token_prefix, expires_at, last_used_at, revoked_at, created_at
       FROM api_tokens WHERE user_id = $1 ORDER BY created_at DESC`,
      [userId]
    )
  ).rows;
}

export async function revokeApiToken(userId, tokenId) {
  await query(
    "UPDATE api_tokens SET revoked_at = NOW() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL",
    [tokenId, userId]
  );
}

export async function revokeApiTokenById(tokenId) {
  await query(
    "UPDATE api_tokens SET revoked_at = NOW() WHERE id = $1 AND revoked_at IS NULL",
    [tokenId]
  );
}

export async function listAllApiTokens() {
  return (
    await query(
      `SELECT t.id, t.name, t.token_prefix, t.expires_at, t.last_used_at, t.revoked_at,
              t.created_at, t.tenant_id, t.user_id, u.name AS user_name, u.email AS user_email
       FROM api_tokens t
       LEFT JOIN users u ON t.user_id = u.id
       ORDER BY t.created_at DESC`
    )
  ).rows;
}
