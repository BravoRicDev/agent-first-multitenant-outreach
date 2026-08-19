import { Router } from "express";
import { query } from "../db.js";
import { requireAuth, requireAdmin } from "../middleware/auth.js";
import { logger } from "../services/logger.js";

const router = Router();

router.use(requireAuth);
router.use(requireAdmin);

router.get("/api/followup-sequences", async (req, res) => {
  try {
    const { campaign_id } = req.query;
    if (!campaign_id) return res.status(400).json({ error: "campaign_id richiesto" });
    const result = await query(
      "SELECT * FROM followup_sequences WHERE campaign_id = $1 ORDER BY step_order, id",
      [parseInt(campaign_id, 10)]
    );
    res.json(result.rows);
  } catch (err) {
    logger.error("Followup sequences list error", { error: err.message });
    res.status(500).json({ error: "Errore caricamento sequenze" });
  }
});

router.post("/api/followup-sequences", async (req, res) => {
  try {
    const { step_order, delay_days, subject, body, campaign_id } = req.body;
    if (!Number.isInteger(step_order) || step_order < 1) {
      return res.status(400).json({ error: "step_order non valido (deve essere intero >= 1)" });
    }
    if (!Number.isInteger(delay_days) || delay_days < 0) {
      return res.status(400).json({ error: "delay_days non valido (deve essere intero >= 0)" });
    }
    const cid = Number(campaign_id);
    if (!campaign_id || !Number.isFinite(cid) || !Number.isInteger(cid) || cid <= 0) {
      return res.status(400).json({ error: "campaign_id deve essere un intero positivo" });
    }
    const result = await query(
      `INSERT INTO followup_sequences (step_order, delay_days, subject, body, campaign_id, tenant_id, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW()) RETURNING *`,
      [step_order, delay_days, subject || '', body || '', cid, req.user.tenant_id]
    );
    await query(
      `INSERT INTO audit_log (user_id, action, resource, resource_id, details)
       VALUES ($1, 'create', 'followup_sequences', $2, $3)`,
      [req.user.sub, result.rows[0].id, JSON.stringify({ step_order, delay_days })]
    );
    res.json({ success: true, sequence: result.rows[0] });
  } catch (err) {
    logger.error("Followup sequence create error", { error: err.message });
    res.status(500).json({ error: "Errore creazione sequenza" });
  }
});

router.put("/api/followup-sequences/:id(\\d+)", async (req, res) => {
  try {
    const { step_order, delay_days, subject, body, is_active } = req.body;
    const fields = [];
    const params = [];
    let idx = 1;

    if (step_order !== undefined) { fields.push(`step_order = $${idx++}`); params.push(step_order); }
    if (delay_days !== undefined) { fields.push(`delay_days = $${idx++}`); params.push(delay_days); }
    if (subject !== undefined) { fields.push(`subject = $${idx++}`); params.push(subject); }
    if (body !== undefined) { fields.push(`body = $${idx++}`); params.push(body); }
    if (is_active !== undefined) { fields.push(`is_active = $${idx++}`); params.push(is_active); }

    if (fields.length === 0) return res.status(400).json({ error: "Nessun campo" });
    fields.push(`updated_at = NOW()`);
    params.push(parseInt(req.params.id, 10));

    await query(
      `UPDATE followup_sequences SET ${fields.join(", ")} WHERE id = $${idx}`,
      params
    );

    await query(
      `INSERT INTO audit_log (user_id, action, resource, resource_id, details)
       VALUES ($1, 'update', 'followup_sequences', $2, $3)`,
      [req.user.sub, parseInt(req.params.id, 10), JSON.stringify(Object.keys(req.body))]
    );

    res.json({ success: true });
  } catch (err) {
    logger.error("Followup sequence update error", { error: err.message });
    res.status(500).json({ error: "Errore aggiornamento sequenza" });
  }
});

router.delete("/api/followup-sequences/:id(\\d+)", async (req, res) => {
  try {
    const seqId = parseInt(req.params.id, 10);
    await query("DELETE FROM followup_sequences WHERE id = $1", [seqId]);
    await query(
      `INSERT INTO audit_log (user_id, action, resource, resource_id)
       VALUES ($1, 'delete', 'followup_sequences', $2)`,
      [req.user.sub, seqId]
    );
    res.json({ success: true });
  } catch (err) {
    logger.error("Followup sequence delete error", { error: err.message });
    res.status(500).json({ error: "Errore eliminazione sequenza" });
  }
});

export default router;
