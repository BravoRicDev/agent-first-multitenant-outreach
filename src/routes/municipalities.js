import { Router } from "express";
import { query } from "../db.js";
import { requireAuth, requireAdmin } from "../middleware/auth.js";
import { logger } from "../services/logger.js";
import { getSetting } from "../services/settings.js";

const router = Router();

router.use(requireAuth);

router.get("/municipalities", async (req, res) => {
  try {
    const { regione, provincia, eseguito } = req.query;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const offset = (page - 1) * limit;
    const conditions = [];
    const params = [];
    let idx = 1;

    if (regione) { conditions.push(`denominazione_regione ILIKE $${idx++}`); params.push(`%${regione}%`); }
    if (provincia) { conditions.push(`sigla_provincia ILIKE $${idx++}`); params.push(`%${provincia}%`); }
    if (eseguito === "true") { conditions.push(`eseguito = true`); }
    else if (eseguito === "false") { conditions.push(`(eseguito = false OR eseguito IS NULL)`); }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const countResult = await query(`SELECT COUNT(*)::int FROM municipalities ${where}`, params);
    const total = countResult.rows[0].count;

    const regionStats = await query(`
      SELECT m.denominazione_regione,
        COUNT(DISTINCT m.id)::int AS totale,
        COUNT(DISTINCT m.id) FILTER (WHERE m.eseguito) AS eseguiti,
        COUNT(*) FILTER (WHERE d.id IS NOT NULL) AS aziende_trovati,
        COUNT(*) FILTER (WHERE d.inviato) AS inviati
      FROM municipalities m
      LEFT JOIN companies d ON d.comune = m.denominazione_ita_altra AND d.provincia = m.sigla_provincia
      GROUP BY m.denominazione_regione ORDER BY m.denominazione_regione
    `);

    const result = await query(
      `WITH companies_counts AS (
          SELECT comune, provincia, COUNT(*)::int AS total, COUNT(*) FILTER (WHERE inviato)::int AS sent
          FROM companies WHERE comune IS NOT NULL GROUP BY comune, provincia
        )
        SELECT m.id, m.denominazione_ita_altra, m.sigla_provincia, m.denominazione_regione,
               m.eseguito, m.error_count, m.ultima_lavorazione, m.cap, m.created_at, m.updated_at,
               COALESCE(dc.total, 0) AS company_count,
               COALESCE(dc.sent, 0) AS sent_count
        FROM municipalities m
        LEFT JOIN companies_counts dc ON dc.comune = m.denominazione_ita_altra AND dc.provincia = m.sigla_provincia
        ${where}
        ORDER BY denominazione_ita_altra
        LIMIT $${idx} OFFSET $${idx + 1}`,
      [...params, parseInt(limit, 10), offset]
    );

    const regioni = await query("SELECT DISTINCT denominazione_regione FROM municipalities ORDER BY denominazione_regione");
    const province = await query("SELECT DISTINCT sigla_provincia FROM municipalities ORDER BY sigla_provincia");

    res.render("municipalities/list", {
      municipalities: result.rows,
      regioni: regioni.rows,
      province: province.rows,
      regionStats: regionStats.rows,
      filters: { regione, provincia, eseguito },
      pagination: { page: parseInt(page, 10), limit: parseInt(limit, 10), total, pages: Math.ceil(total / parseInt(limit, 10)) },
    });
  } catch (err) {
    logger.error("Municipalities list error", { error: err.message });
    res.status(500).render("error", {messageKey: "error.load_municipalities" });
  }
});

router.patch("/api/municipalities/:id", requireAdmin, async (req, res) => {
  try {
    const { eseguito } = req.body;
    if (eseguito !== undefined) {
      await query("UPDATE municipalities SET eseguito = $1, updated_at = NOW() WHERE id = $2", [eseguito, req.params.id]);
      await query(
        "INSERT INTO audit_log (user_id, action, resource, resource_id, details) VALUES ($1, 'update', 'municipalities', $2, $3)",
        [req.user.sub, req.params.id, JSON.stringify({ eseguito })]
      );
    }
    res.json({ success: true });
  } catch (err) {
    logger.error("Municipality update error", { error: err.message });
    res.status(500).json({ error: "Errore aggiornamento" });
  }
});

router.post("/api/municipalities/bulk-mark", requireAdmin, async (req, res) => {
  try {
    const { ids, eseguito } = req.body;
    if (!Array.isArray(ids) || ids.length === 0 || ids.some(id => !Number.isInteger(id) || id <= 0)) {
      return res.status(400).json({ error: "IDs non validi" });
    }
    if (typeof eseguito !== 'boolean') {
      return res.status(400).json({ error: "eseguito deve essere un booleano" });
    }
    const result = await query(
      "UPDATE municipalities SET eseguito = $1, updated_at = NOW() WHERE id = ANY($2::int[])",
      [eseguito, ids]
    );
    await query(
      "INSERT INTO audit_log (user_id, action, resource, details) VALUES ($1, 'bulk_mark', 'municipalities', $2)",
      [req.user.sub, JSON.stringify({ ids, eseguito })]
    );
    res.json({ success: true, updated: result.rowCount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
