import { Router } from "express";
import { query } from "../db.js";
import { requireAuth, requireAdmin } from "../middleware/auth.js";
import { logger } from "../services/logger.js";
import { z } from "zod";
import { validate } from "../middleware/validate.js";
import { setSetting } from "../services/settings.js";

const router = Router();

router.use(requireAuth);
router.use(requireAdmin);

router.get("/direzione", async (req, res) => {
  try {
    const result = await query("SELECT * FROM direzione WHERE id = 1");
    const direzione = result.rows[0] || {};
    res.render("direzione", { direzione });
  } catch (err) {
    logger.error("Direzione load error", { error: err.message });
    res.status(500).render("error", { messageKey: "error.load_generic" });
  }
});

const direzioneSchema = z.object({
  info_azienda: z.string().max(10000).optional().default(''),
  cta: z.string().max(500).optional().default(''),
  link_cta: z.string().max(2000).optional().default(''),
  email_spunti: z.string().max(50000).optional().default(''),
  email_template_bozza: z.string().max(10000).optional().default(''),
  correzione_prompt: z.string().max(5000).optional().default(''),
}).strict();

router.put("/api/direzione", validate(direzioneSchema), async (req, res) => {
  const { getClient } = await import("../db.js");
  const client = await getClient();
  try {
    await client.query("BEGIN");
    const { info_azienda, cta, link_cta, email_spunti, email_template_bozza, correzione_prompt } = req.body;

    const prev = await client.query("SELECT info_azienda, cta, link_cta, email_template_bozza FROM direzione WHERE id = 1");
    const old = prev.rows[0] || {};
    const campaignFields = ['info_azienda','cta','link_cta','email_template_bozza'];
    const hasChanged = campaignFields.some(f => (req.body[f] ?? '') !== (old[f] ?? ''));

    await client.query(
      `UPDATE direzione SET
        info_azienda = $1, cta = $2, link_cta = $3,
        email_spunti = $4, email_template_bozza = $5,
        correzione_prompt = $6, updated_at = NOW(),
        updated_by = $7
      WHERE id = 1`,
      [info_azienda, cta, link_cta, email_spunti, email_template_bozza, correzione_prompt, req.user.sub]
    );

    await client.query(
      `INSERT INTO audit_log (user_id, action, resource, details)
       VALUES ($1, 'update', 'direzione', $2)`,
      [req.user.sub, JSON.stringify({ updated: Object.keys(req.body) })]
    );

    if (hasChanged) {
      // Salva le followup_sequences della campagna attuale prima di chiuderla
      const oldActive = await client.query(
        "SELECT id FROM campaigns WHERE is_active = true LIMIT 1"
      );
      await client.query("UPDATE campaigns SET ended_at = NOW(), is_active = false WHERE is_active = true");
      const newCamp = await client.query(
        `INSERT INTO campaigns (name, info_azienda_snapshot, cta_snapshot, template_snapshot,
          info_azienda, cta, link_cta, email_template, tenant_id)
         VALUES ($1, $2, $3, $4, $2, $3, $5, $4, $6) RETURNING id`,
        [`Campagna ${new Date().toLocaleDateString('it-IT')}`,
         req.body.info_azienda || '', req.body.cta || '', req.body.email_template_bozza || '',
         req.body.link_cta || '', req.user.tenant_id]
      );
      // Copia le followup_sequences dalla vecchia campagna attiva nella nuova
      if (oldActive.rows.length > 0) {
        await client.query(
          `INSERT INTO followup_sequences (campaign_id, step_order, subject, body, delay_days, tenant_id)
           SELECT $1, step_order, subject, body, delay_days, $3
           FROM followup_sequences WHERE campaign_id = $2`,
          [newCamp.rows[0].id, oldActive.rows[0].id, req.user.tenant_id]
        );
      }
    }

    await client.query("COMMIT");

    res.json({ success: true });
    // setSetting dopo response per non esporre errore all'utente se fallisce
    if (hasChanged) {
      try { await setSetting('current_campaign_id', String(newCamp.rows[0].id), req.user.sub); } catch (e) { logger.error("setSetting current_campaign_id fallito", { error: e.message }); }
    }
  } catch (err) {
    await client.query("ROLLBACK").catch(rbErr => logger.error("ROLLBACK fallito in direzione", { error: rbErr.message }));
    logger.error("Direzione update error", { error: err.message });
    res.status(500).json({ error: "Errore aggiornamento" });
  } finally {
    client.release();
  }
});

router.get("/api/direzione", async (req, res) => {
  try {
    const result = await query("SELECT * FROM direzione WHERE id = 1");
    res.json(result.rows[0] || {});
  } catch (err) {
    res.status(500).json({ error: "Errore caricamento" });
  }
});

router.get("/api/direzione/draft-count", async (req, res) => {
  try {
    const result = await query("SELECT COUNT(*)::int AS count FROM companies WHERE bozza_creata = true AND inviato = false");
    res.json({ count: result.rows[0].count });
  } catch (err) { console.error("Draft count error", err); res.status(500).json({ error: "Errore caricamento" }); }
});

export default router;
