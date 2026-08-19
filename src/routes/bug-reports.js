import { Router } from "express";
import { z } from "zod";
import { query } from "../db.js";
import { requireAuth, requireAdmin } from "../middleware/auth.js";
import { logger } from "../services/logger.js";

const router = Router();

router.use(requireAuth);

router.get("/api/bug-reports", requireAdmin, async (req, res) => {
  try {
    const { status, priority } = req.query;
    const conditions = [];
    const params = [];
    let idx = 1;
    if (status) { conditions.push(`br.status = $${idx++}`); params.push(status); }
    if (priority) { conditions.push(`br.priority = $${idx++}`); params.push(priority); }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const result = await query(
      `SELECT br.*, u.name AS user_name, u.surname AS user_surname
       FROM bug_reports br LEFT JOIN users u ON u.id = br.user_id
       ${where} ORDER BY br.created_at DESC LIMIT 100`,
      params
    );
    res.json(result.rows);
  } catch (err) {
    logger.error("Bug reports list error", { error: err.message });
    res.status(500).json({ error: "Errore caricamento" });
  }
});

const createSchema = z.object({
  categoria: z.string().optional().default(""),
  description: z.string().min(1, "Descrizione richiesta"),
  browser_info: z.string().optional().default(""),
});

router.post("/api/bug-reports", async (req, res) => {
  try {
    const data = createSchema.parse(req.body);
    const result = await query(
      `INSERT INTO bug_reports (user_id, categoria, description, browser_info)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [req.user.sub, data.categoria, data.description, data.browser_info]
    );
    res.status(201).json({ id: result.rows[0].id });
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: err.errors });
    logger.error("Bug report create error", { error: err.message });
    res.status(500).json({ error: "Errore creazione" });
  }
});

router.get("/api/bug-reports/:id", requireAdmin, async (req, res) => {
  try {
    const result = await query(
      `SELECT br.*, u.name AS user_name, u.surname AS user_surname, u.email AS user_email
       FROM bug_reports br LEFT JOIN users u ON u.id = br.user_id
       WHERE br.id = $1`,
      [parseInt(req.params.id, 10)]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: "Non trovata" });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const updateSchema = z.object({
  status: z.enum(["aperto", "in_lavorazione", "risolto", "chiuso"]).optional(),
  priority: z.enum(["bassa", "normale", "alta", "critica"]).optional(),
  note_sviluppatore: z.string().optional(),
});

router.put("/api/bug-reports/:id", requireAdmin, async (req, res) => {
  try {
    const data = updateSchema.parse(req.body);
    const fields = [];
    const params = [];
    let idx = 1;
    if (data.status) { fields.push(`status = $${idx++}`); params.push(data.status); }
    if (data.priority) { fields.push(`priority = $${idx++}`); params.push(data.priority); }
    if (data.note_sviluppatore !== undefined) { fields.push(`note_sviluppatore = $${idx++}`); params.push(data.note_sviluppatore); }
    if (fields.length === 0) return res.status(400).json({ error: "Nessun campo" });
    fields.push("updated_at = NOW()");
    params.push(parseInt(req.params.id, 10));
    await query(`UPDATE bug_reports SET ${fields.join(", ")} WHERE id = $${idx}`, params);
    res.json({ success: true });
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: err.errors });
    res.status(500).json({ error: err.message });
  }
});

export default router;
