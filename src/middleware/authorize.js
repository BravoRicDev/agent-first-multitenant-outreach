import { query } from "../db.js";

export function authorize(resource, action) {
  return async (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: "Autenticazione richiesta" });
    }
    if (req.user.role === "superadmin") {
      return next();
    }
    try {
      const result = await query(
        `SELECT can_create, can_read, can_update, can_delete
         FROM roles_permissions WHERE role = $1 AND resource = $2`,
        [req.user.role, resource]
      );
      if (result.rows.length === 0) {
        return res.status(403).json({ error: "Permesso negato" });
      }
      const perm = result.rows[0];
      const actionMap = { create: "can_create", read: "can_read", update: "can_update", delete: "can_delete" };
      if (!perm[actionMap[action]]) {
        return res.status(403).json({ error: "Permesso negato" });
      }
      next();
    } catch (err) {
      return res.status(500).json({ error: "Errore verifica permessi" });
    }
  };
}
