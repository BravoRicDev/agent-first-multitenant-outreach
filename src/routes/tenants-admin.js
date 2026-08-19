import { Router } from "express";
import { query } from "../db.js";
import { requireAdmin } from "../middleware/auth.js";
import { logger } from "../services/logger.js";
import {
  getTenantById,
  listTenants,
  createTenant,
  toggleTenantActive,
  updateTenantQuota,
  updateTenantTestMode,
} from "../services/tenants.js";

const router = Router();

router.use("/admin", requireAdmin);
router.use("/api/admin", requireAdmin);

router.get("/admin/tenants", async (req, res) => {
  try {
    const tenants = await listTenants();
    res.render("admin/tenants", { tenants });
  } catch (err) {
    logger.error("Tenants list error", { error: err.message });
    res.status(500).render("error", {messageKey: "error.load_tenant" });
  }
});

router.post("/api/admin/tenants", async (req, res) => {
  try {
    const { name, site_id, daily_email_quota, test_mode } = req.body;

    if (!name || name.trim() === "") {
      return res.status(400).json({ error: "name è obbligatorio" });
    }

    const siteIdParsed = site_id ? parseInt(site_id, 10) : null;
    const quotaParsed = daily_email_quota ? parseInt(daily_email_quota, 10) : null;
    const testModeBool = test_mode === true || test_mode === "true";

    if (siteIdParsed !== null && isNaN(siteIdParsed)) {
      return res.status(400).json({ error: "site_id deve essere un numero" });
    }

    if (quotaParsed !== null && isNaN(quotaParsed)) {
      return res.status(400).json({ error: "daily_email_quota deve essere un numero" });
    }

    const result = await createTenant(
      name.trim(),
      siteIdParsed,
      quotaParsed,
      testModeBool
    );

    res.json(result);
  } catch (err) {
    logger.error("Create tenant error", { error: err.message });
    res.status(500).json({ error: "Errore creazione tenant" });
  }
});

router.post("/api/admin/tenants/:id/toggle", async (req, res) => {
  try {
    const tenantId = parseInt(req.params.id, 10);

    if (isNaN(tenantId) || tenantId <= 0) {
      return res.status(400).json({ error: "ID tenant non valido" });
    }

    const tenant = await getTenantById(tenantId);
    if (!tenant) {
      return res.status(404).json({ error: "Tenant non trovato" });
    }

    const newState = !tenant.is_active;
    const result = await toggleTenantActive(tenantId, newState);

    res.json(result);
  } catch (err) {
    logger.error("Toggle tenant error", { error: err.message });
    res.status(500).json({ error: "Errore aggiornamento tenant" });
  }
});

router.post("/api/admin/tenants/:id/quota", async (req, res) => {
  try {
    const tenantId = parseInt(req.params.id, 10);
    const { daily_email_quota } = req.body;

    if (isNaN(tenantId) || tenantId <= 0) {
      return res.status(400).json({ error: "ID tenant non valido" });
    }

    const tenant = await getTenantById(tenantId);
    if (!tenant) {
      return res.status(404).json({ error: "Tenant non trovato" });
    }

    let quotaParsed = null;
    if (daily_email_quota !== null && daily_email_quota !== undefined && daily_email_quota !== "") {
      quotaParsed = parseInt(daily_email_quota, 10);
      if (isNaN(quotaParsed)) {
        return res.status(400).json({ error: "daily_email_quota deve essere un numero" });
      }
    }

    const result = await updateTenantQuota(tenantId, quotaParsed);

    res.json(result);
  } catch (err) {
    logger.error("Update tenant quota error", { error: err.message });
    res.status(500).json({ error: "Errore aggiornamento quota" });
  }
});

router.post("/api/admin/tenants/:id/test-mode", async (req, res) => {
  try {
    const tenantId = parseInt(req.params.id, 10);
    const { test_mode } = req.body;

    if (isNaN(tenantId) || tenantId <= 0) {
      return res.status(400).json({ error: "ID tenant non valido" });
    }

    const tenant = await getTenantById(tenantId);
    if (!tenant) {
      return res.status(404).json({ error: "Tenant non trovato" });
    }

    const testModeBool = test_mode === true || test_mode === "true";

    const result = await updateTenantTestMode(tenantId, testModeBool);

    res.json(result);
  } catch (err) {
    logger.error("Update tenant test_mode error", { error: err.message });
    res.status(500).json({ error: "Errore aggiornamento test_mode" });
  }
});

export default router;
