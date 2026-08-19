import { Router } from "express";
import rateLimit from "express-rate-limit";
import { query } from "../db.js";
import { requireAuth, requireAdmin, clearUserCache } from "../middleware/auth.js";
import config from "../config.js";
import { logger } from "../services/logger.js";
import { validate } from "../middleware/validate.js";
import { createUserSchema, updateUserSchema } from "../validations/schemas.js";
import { cacheClear } from "../services/cache.js";

const diagnosticsLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { error: "Troppe richieste diagnostics" },
  standardHeaders: true,
  legacyHeaders: false,
});

const router = Router();

router.use(requireAuth);

router.get("/profile", requireAuth, async (req, res) => {
  try {
    res.render("profile");
  } catch (err) {
    logger.error("Profile error", { error: err.message });
    res.status(500).render("error", {messageKey: "error.load_profile" });
  }
});

router.use("/admin", requireAdmin);
router.use("/api/admin", requireAdmin);

router.get("/admin/users", async (req, res) => {
  try {
    const result = await query("SELECT id, name, surname, email, role, status, created_at FROM users ORDER BY created_at");
    res.render("admin/users", { users: result.rows });
  } catch (err) {
    logger.error("Users list error", { error: err.message });
    res.status(500).render("error", {messageKey: "error.load_users" });
  }
});

router.post("/api/users", requireAdmin, validate(createUserSchema), async (req, res) => {
  try {
    const { name, surname, email, role } = req.body;
    if (role === "superadmin" && req.user.role !== "superadmin") {
      return res.status(403).json({ error: "Solo un superadmin può creare utenti superadmin" });
    }
    const insertResult = await query(
      "INSERT INTO users (name, surname, email, role) VALUES ($1, $2, $3, $4) ON CONFLICT (email) DO NOTHING",
      [name, surname || "", email, role || "collaboratore"]
    );

    if (insertResult.rowCount === 0) {
      return res.status(409).json({ error: "Email già registrata" });
    }

    await query(
      `INSERT INTO audit_log (user_id, action, resource, details)
       VALUES ($1, 'create', 'users', $2)`,
      [req.user.sub, JSON.stringify({ name, email, role })]
    );

    res.json({ success: true });
  } catch (err) {
    logger.error("Create user error", { error: err.message });
    res.status(500).json({ error: "Errore creazione utente" });
  }
});

router.patch("/api/users/:id", requireAdmin, validate(updateUserSchema), async (req, res) => {
  try {
    const { role, status } = req.body;

    // Impedisci a un non-superadmin di modificare un superadmin
    if (req.user.role !== "superadmin") {
      const tgt = await query("SELECT role FROM users WHERE id = $1", [req.params.id]);
      if (tgt.rows.length > 0 && tgt.rows[0].role === "superadmin") {
        return res.status(403).json({ error: "Solo un superadmin può modificare un superadmin" });
      }
    }

    if (role === "superadmin" && req.user.role !== "superadmin") {
      return res.status(403).json({ error: "Solo un superadmin può assegnare il ruolo superadmin" });
    }

    if (status === 'disabled' && String(req.params.id) === String(req.user.sub)) {
      return res.status(400).json({ error: "Non puoi disabilitare il tuo account" });
    }

    const fields = [];
    const params = [];
    let idx = 1;

    if (role) { fields.push(`role = $${idx++}`); params.push(role); }
    if (status) { fields.push(`status = $${idx++}`); params.push(status); }

    if (fields.length === 0) return res.status(400).json({ error: "Nessun campo" });

    params.push(req.params.id);
    await query(`UPDATE users SET ${fields.join(", ")}, updated_at = NOW() WHERE id = $${idx}`, params);
    clearUserCache(parseInt(req.params.id, 10));

    res.json({ success: true });
  } catch (err) {
    logger.error("Update user error", { error: err.message });
    res.status(500).json({ error: "Errore aggiornamento" });
  }
});

router.delete("/api/users/:id", requireAdmin, async (req, res) => {
  try {
    const target = await query("SELECT id, email, role FROM users WHERE id = $1", [req.params.id]);
    if (target.rows.length === 0) return res.status(404).json({ error: "Utente non trovato" });
    const t = target.rows[0];

    // Impedisci a un non-superadmin di eliminare un superadmin
    if (t.role === "superadmin" && req.user.role !== "superadmin") {
      return res.status(403).json({ error: "Solo un superadmin può eliminare un superadmin" });
    }
    const protectedEmail = process.env.PROTECTED_USER_EMAIL || '';
    if (t.email === protectedEmail) {
      return res.status(403).json({ error: "Questo utente non può essere eliminato" });
    }
    await query("DELETE FROM users WHERE id = $1", [req.params.id]);
    await query(
      `INSERT INTO audit_log (user_id, action, resource, resource_id, details)
       VALUES ($1, 'delete', 'users', $2, $3)`,
      [req.user.sub, req.params.id, JSON.stringify({ email: t.email, role: t.role })]
    );
    res.json({ success: true });
  } catch (err) {
    logger.error("Delete user error", { error: err.message });
    res.status(500).json({ error: "Errore eliminazione utente" });
  }
});

router.get("/admin/audit", async (req, res) => {
  try {
    const { action, resource, resource_id, user_id, days, page = 1 } = req.query;
    const conditions = [];
    const params = [];
    let idx = 1;

    if (action) {
      conditions.push(`al.action = $${idx++}`);
      params.push(action);
    }
    if (resource) {
      conditions.push(`al.resource = $${idx++}`);
      params.push(resource);
    }
    if (resource_id) {
      conditions.push(`al.resource_id = $${idx++}`);
      params.push(resource_id);
    }
    if (user_id) {
      conditions.push(`al.user_id = $${idx++}`);
      params.push(parseInt(user_id, 10));
    }
    if (days) {
      conditions.push(`al.created_at > NOW() - INTERVAL '1 day' * $${idx++}`);
      params.push(parseInt(days, 10));
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const offset = (parseInt(page, 10) - 1) * 100;

    const countResult = await query(`SELECT COUNT(*)::int FROM audit_log al ${where}`, params);
    const total = countResult.rows[0].count;

    const result = await query(
      `SELECT al.*, u.name AS user_name, u.email AS user_email
       FROM audit_log al
       LEFT JOIN users u ON u.id = al.user_id
       ${where}
       ORDER BY al.created_at DESC LIMIT 100 OFFSET $${idx}`,
      [...params, offset]
    );

    const actions = await query("SELECT DISTINCT action FROM audit_log ORDER BY action");
    const users = await query("SELECT id, name, email FROM users WHERE status = 'active' ORDER BY name");

    res.render("admin/audit", {
      logs: result.rows,
      actions: actions.rows,
      users: users.rows,
      filters: { action, resource, resource_id, user_id, days: days || "" },
      pagination: { page: parseInt(page, 10), total, pages: Math.ceil(total / 100) },
    });
  } catch (err) {
    logger.error("Audit log error", { error: err.message });
    res.status(500).render("error", {messageKey: "error.load_audit" });
  }
});

router.get("/api/profile/sessions", requireAuth, async (req, res) => {
  try {
    const result = await query(`
      SELECT created_at, ip_address, details
      FROM audit_log WHERE user_id = $1 AND action = 'login'
      ORDER BY created_at DESC LIMIT 10
    `, [req.user.sub]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/api/admin/cache-clear", requireAuth, requireAdmin, async (req, res) => {
  try {
    await cacheClear("scrape:");
    logger.info("Cache scraper svuotata", { userId: req.user.sub });
    await query(
      `INSERT INTO audit_log (user_id, action, resource, details)
       VALUES ($1, 'cache_clear', 'settings', $2)`,
      [req.user.sub, JSON.stringify({ prefix: 'scrape:' })]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/admin/errors", requireAdmin, async (req, res) => {
  try {
    const result = await query(`
      SELECT action, resource, COUNT(*)::int AS cnt, MAX(created_at) AS last_occurrence
      FROM audit_log WHERE action LIKE 'error%'
      GROUP BY action, resource ORDER BY cnt DESC LIMIT 50
    `);
    res.render("admin/errors", { errors: result.rows });
  } catch (err) {
    res.status(500).render("error", {messageKey: "error.load_error_digest" });
  }
});

router.get("/api/admin/ai-stats", requireAdmin, async (req, res) => {
  try {
    const result = await query(`
      SELECT
        COUNT(*) FILTER (WHERE action = 'generate_email')::int AS email_generate,
        COUNT(*) FILTER (WHERE action = 'rewrite_email')::int AS email_rewrite,
        COUNT(*) FILTER (WHERE action = 'extract_from_website')::int AS extraction,
        COUNT(*) FILTER (WHERE action LIKE 'error%' AND created_at > NOW() - INTERVAL '1 day')::int AS today_total
      FROM audit_log
    `);
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/api/admin/diagnostics", requireAuth, requireAdmin, diagnosticsLimiter, async (req, res) => {
  try {
    const [
      queuePending, sequencesPending, lastErrors
    ] = await Promise.all([
      query("SELECT COUNT(*)::int FROM email_queue WHERE status = 'pending'"),
      query("SELECT COUNT(*)::int FROM email_sequences WHERE sent_at IS NULL AND cancelled_at IS NULL AND scheduled_at <= NOW()"),
      query(`SELECT created_at, action, resource_id FROM audit_log ORDER BY created_at DESC LIMIT 5`),
    ]);

    res.json({
      queue_pending: queuePending.rows[0].count,
      sequences_pending: sequencesPending.rows[0].count,
      recent_audit: lastErrors.rows,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/admin/status", requireAdmin, async (req, res) => {
  try {
    res.render("admin/status");
  } catch (err) {
    res.status(500).render("error", {messageKey: "error.load_status" });
  }
});

router.get("/admin/permissions", requireAdmin, async (req, res) => {
  try {
    res.render("admin/permissions");
  } catch (err) {
    res.status(500).send({ messageKey: "error.load_page" });
  }
});

router.get("/api/admin/permissions", requireAdmin, async (req, res) => {
  try {
    const result = await query("SELECT * FROM roles_permissions ORDER BY role, resource");
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/api/admin/permissions", requireAdmin, async (req, res) => {
  try {
    const { role, resource, can_read, can_update, can_create, can_delete } = req.body;
    await query(`
      INSERT INTO roles_permissions (role, resource, can_read, can_update, can_create, can_delete)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (role, resource) DO UPDATE SET can_read = COALESCE($3, roles_permissions.can_read), can_update = COALESCE($4, roles_permissions.can_update), can_create = COALESCE($5, roles_permissions.can_create), can_delete = COALESCE($6, roles_permissions.can_delete)
    `, [role, resource, can_read ?? false, can_update ?? false, can_create ?? false, can_delete ?? false]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/api/admin/audit/export", async (req, res) => {
  try {
    const { action, resource, resource_id, user_id, days } = req.query;
    const conditions = [];
    const params = [];
    let idx = 1;

    if (action) { conditions.push(`al.action = $${idx++}`); params.push(action); }
    if (resource) { conditions.push(`al.resource = $${idx++}`); params.push(resource); }
    if (resource_id) { conditions.push(`al.resource_id::text = $${idx++}`); params.push(resource_id); }
    if (user_id) { conditions.push(`al.user_id = $${idx++}`); params.push(parseInt(user_id, 10)); }
    if (days) { conditions.push(`al.created_at > NOW() - INTERVAL '1 day' * $${idx++}`); params.push(parseInt(days, 10)); }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const result = await query(
      `SELECT al.created_at, u.name AS user_name, u.email AS user_email,
              al.action, al.resource, al.resource_id, al.details, al.ip_address
       FROM audit_log al
       LEFT JOIN users u ON u.id = al.user_id
       ${where}
       ORDER BY al.created_at DESC LIMIT 10000`,
      params
    );

    const header = "Data,Utente,Email,Azione,Risorsa,ID Risorsa,Dettagli,IP\n";
    const csv = header + result.rows.map(r => {
      const details = r.details ? String(r.details).replace(/"/g, '""') : '';
      return [
        r.created_at ? new Date(r.created_at).toISOString() : '',
        r.user_name || '', r.user_email || '', r.action, r.resource,
        r.resource_id || '', details, r.ip_address || ''
      ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(',');
    }).join("\n");

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", "attachment; filename=\"audit-log.csv\"");
    res.send(csv);
  } catch (err) {
    logger.error("Audit export error", { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

export default router;
