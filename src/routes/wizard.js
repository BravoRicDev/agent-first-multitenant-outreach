import { Router } from "express";
import { query } from "../db.js";
import { requireAuth, requireAdmin } from "../middleware/auth.js";
import { getSetting } from "../services/settings.js";

const router = Router();

router.use(requireAuth);

router.get("/admin/wizard", requireAdmin, async (req, res) => {
  if (getSetting('wizard_completed') === 'true') return res.redirect('/dashboard');
  res.render("admin/wizard");
});

router.get("/api/provinces", async (req, res) => {
  try {
    const result = await query("SELECT DISTINCT sigla_provincia FROM municipalities ORDER BY sigla_provincia");
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/api/regions", async (req, res) => {
  try {
    const result = await query("SELECT DISTINCT denominazione_regione FROM municipalities WHERE denominazione_regione IS NOT NULL ORDER BY denominazione_regione");
    res.json(result.rows.map(r => r.denominazione_regione));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
