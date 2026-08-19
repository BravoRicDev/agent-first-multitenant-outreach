import { Router } from "express";
import { query } from "../db.js";
import { requireAuth, requireAdmin } from "../middleware/auth.js";

const router = Router();
router.use(requireAuth);
router.use(requireAdmin);

router.get("/admin/send-schedule", async (req, res) => {
  try {
    res.render("admin/send-schedule");
  } catch (err) {
    res.status(500).send({ messageKey: "error.load_page" });
  }
});

router.get("/api/admin/send-schedule", async (req, res) => {
  try {
    const result = await query("SELECT dow, hour, allowed FROM send_schedule ORDER BY dow, hour");
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put("/api/admin/send-schedule", async (req, res) => {
  const { allowed, blocked } = req.body;
  if (Array.isArray(allowed) && allowed.length > 200) {
    return res.status(400).json({ error: "Max 200 slot consentiti" });
  }
  if (Array.isArray(blocked) && blocked.length > 200) {
    return res.status(400).json({ error: "Max 200 slot consentiti" });
  }
  const validateSlot = (slot) => {
    if (typeof slot.dow !== 'number' || slot.dow < 0 || slot.dow > 6) return false;
    if (typeof slot.hour !== 'number' || slot.hour < 0 || slot.hour > 23) return false;
    return true;
  };
  if (Array.isArray(allowed) && !allowed.every(validateSlot)) {
    return res.status(400).json({ error: "Slot allowed non valido (dow 0-6, hour 0-23)" });
  }
  if (Array.isArray(blocked) && !blocked.every(validateSlot)) {
    return res.status(400).json({ error: "Slot blocked non valido (dow 0-6, hour 0-23)" });
  }
  let client;
  try {
    client = await (await import("../db.js")).getClient();
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
  try {
    await client.query("BEGIN");
    if (Array.isArray(allowed)) {
      for (const a of allowed) {
        await client.query(
          "INSERT INTO send_schedule (dow, hour, allowed, tenant_id) VALUES ($1,$2,true,$3) ON CONFLICT (dow, hour, tenant_id) DO UPDATE SET allowed = true",
          [a.dow, a.hour, req.user.tenant_id || null]
        );
      }
    }
    if (Array.isArray(blocked)) {
      for (const b of blocked) {
        await client.query(
          "INSERT INTO send_schedule (dow, hour, allowed, tenant_id) VALUES ($1,$2,false,$3) ON CONFLICT (dow, hour, tenant_id) DO UPDATE SET allowed = false",
          [b.dow, b.hour, req.user.tenant_id || null]
        );
      }
    }
    await client.query("COMMIT");
    const { clearScheduleCache } = await import("../services/send-schedule.js");
    clearScheduleCache();
    res.json({ success: true });
  } catch (err) {
    await client?.query("ROLLBACK").catch(rbErr => console.error("ROLLBACK fallito in send-schedule", rbErr));
    res.status(500).json({ error: err.message });
  } finally {
    client?.release();
  }
});

export default router;
