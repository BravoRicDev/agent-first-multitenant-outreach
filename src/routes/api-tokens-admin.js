import { Router } from "express";
import { query } from "../db.js";
import { requireAdmin } from "../middleware/auth.js";
import { logger } from "../services/logger.js";
import {
  createApiToken,
  listAllApiTokens,
  revokeApiTokenById,
} from "../services/api-tokens.js";

const router = Router();

router.use("/admin", requireAdmin);
router.use("/api/admin", requireAdmin);

router.get("/admin/api-tokens", async (req, res) => {
  try {
    const tokens = await listAllApiTokens();
    const usersResult = await query(
      "SELECT id, name, email FROM users WHERE status = 'active' ORDER BY name"
    );
    res.render("admin/api-tokens", {
      tokens,
      users: usersResult.rows,
    });
  } catch (err) {
    logger.error("API tokens list error", { error: err.message });
    res.status(500).render("error", {messageKey: "error.load_token" });
  }
});

router.post("/api/admin/api-tokens", async (req, res) => {
  try {
    const { user_id, name, tenant_id, expires_in_days } = req.body;

    if (!user_id || !name) {
      return res
        .status(400)
        .json({ error: "user_id e name sono obbligatori" });
    }

    const userId = parseInt(user_id, 10);
    const expiresInDays = expires_in_days
      ? parseInt(expires_in_days, 10)
      : 365;
    const tenantIdParsed = tenant_id ? parseInt(tenant_id, 10) : null;

    if (isNaN(userId) || isNaN(expiresInDays)) {
      return res.status(400).json({ error: "Valori numerici non validi" });
    }

    const userExists = await query(
      "SELECT id FROM users WHERE id = $1",
      [userId]
    );
    if (userExists.rows.length === 0) {
      return res.status(404).json({ error: "Utente non trovato" });
    }

    const result = await createApiToken(userId, name, expiresInDays, tenantIdParsed);

    res.json({
      id: result.id,
      token: result.token,
      prefix: result.prefix,
      expires_at: result.expiresAt,
      tenant_id: tenantIdParsed,
    });
  } catch (err) {
    logger.error("Create API token error", { error: err.message });
    res.status(500).json({ error: "Errore creazione token" });
  }
});

router.post("/api/admin/api-tokens/:id/revoke", async (req, res) => {
  try {
    const tokenId = parseInt(req.params.id, 10);

    if (isNaN(tokenId)) {
      return res.status(400).json({ error: "ID token non valido" });
    }

    const tokenExists = await query(
      "SELECT id, revoked_at, tenant_id FROM api_tokens WHERE id = $1",
      [tokenId]
    );

    if (tokenExists.rows.length === 0) {
      return res.status(404).json({ error: "Token non trovato" });
    }

    if (tokenExists.rows[0].revoked_at) {
      return res.status(400).json({ error: "Token già revocato" });
    }

    const tokenTenantId = tokenExists.rows[0].tenant_id;
    await query(
      "UPDATE api_tokens SET revoked_at = NOW() WHERE id = $1 AND revoked_at IS NULL AND tenant_id = $2",
      [tokenId, tokenTenantId]
    );

    res.json({ success: true });
  } catch (err) {
    logger.error("Revoke API token error", { error: err.message });
    res.status(500).json({ error: "Errore revoca token" });
  }
});

export default router;
