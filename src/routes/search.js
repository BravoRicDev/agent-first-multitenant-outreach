import { Router } from "express";
import { query } from "../db.js";
import { requireAuth } from "../middleware/auth.js";

const router = Router();

router.use(requireAuth);

router.get("/api/search", async (req, res) => {
  try {
    const q = req.query.q;
    if (!q || q.trim().length < 2) return res.json({ companies: [], municipalities: [], audit: [] });
    const searchTerm = `%${q.trim()}%`;

    const [companies, municipalities, audit] = await Promise.all([
      query(
        `SELECT id, nome_studio, comune, email FROM companies WHERE nome_studio ILIKE $1 OR email ILIKE $1 OR comune ILIKE $1 LIMIT 5`,
        [searchTerm]
      ),
      query(
        `SELECT id, denominazione_ita_altra AS name, sigla_provincia FROM municipalities WHERE denominazione_ita_altra ILIKE $1 LIMIT 5`,
        [searchTerm]
      ),
      query(
        `SELECT id, action, resource, resource_id, created_at FROM audit_log WHERE resource ILIKE $1 LIMIT 5`,
        [searchTerm]
      ),
    ]);

    res.json({
      companies: companies.rows,
      municipalities: municipalities.rows,
      audit: audit.rows,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
