import { Router } from "express";
import { query } from "../db.js";
import { requireAuth, requireAdmin } from "../middleware/auth.js";
import { authorize } from "../middleware/authorize.js";
import { logger } from "../services/logger.js";
import { validate } from "../middleware/validate.js";
import { companyUpdateSchema } from "../validations/schemas.js";
import { importCsvFromText } from "../services/csv-importer.js";
import { stringify } from "csv-stringify/sync";
import config from "../config.js";
import { getSetting } from "../services/settings.js";
import rateLimit from "express-rate-limit";

const router = Router();

router.use(requireAuth);

function buildFilterClauses(queryParams) {
  const { comune, approvato, inviato, bozza, search, provincia, bounced, campaign_id, not_in_campaign } = queryParams;
  const conditions = [];
  const params = [];
  let paramIdx = 1;

  if (comune) {
    conditions.push(`LOWER(d.comune) LIKE $${paramIdx++}`);
    params.push(`%${comune.toLowerCase()}%`);
  }
  if (provincia) {
    conditions.push(`d.provincia = $${paramIdx++}`);
    params.push(provincia);
  }
  if (approvato === "true") {
    conditions.push(`d.approvato = true`);
  } else if (approvato === "false") {
    conditions.push(`(d.approvato = false OR d.approvato IS NULL)`);
  }
  if (inviato === "true") {
    conditions.push(`d.inviato = true`);
  } else if (inviato === "false") {
    conditions.push(`(d.inviato = false OR d.inviato IS NULL)`);
  }
  if (bozza === "true") {
    conditions.push(`d.bozza_creata = true`);
  } else if (bozza === "false") {
    conditions.push(`(d.bozza_creata = false OR d.bozza_creata IS NULL)`);
  }
  if (search) {
    conditions.push(`(d.title ILIKE $${paramIdx} OR d.nome_studio ILIKE $${paramIdx} OR d.nome_azienda ILIKE $${paramIdx} OR d.email ILIKE $${paramIdx} OR d.comune ILIKE $${paramIdx})`);
    params.push(`%${search}%`);
    paramIdx++;
  }
  if (bounced === "true") {
    conditions.push(`d.email_bounced = true`);
  } else if (bounced === "false") {
    conditions.push(`(d.email_bounced = false OR d.email_bounced IS NULL)`);
  }
  if (campaign_id) {
    conditions.push(`d.campaign_id = $${paramIdx++}`);
    params.push(parseInt(campaign_id, 10));
  }
  if (not_in_campaign) {
    conditions.push(`(d.campaign_id IS NULL OR d.campaign_id != $${paramIdx++})`);
    params.push(parseInt(not_in_campaign, 10));
  }

  return { conditions, params, paramIdx };
}

router.get("/companies", async (req, res) => {
  try {
    const { comune, provincia, regione, approvato, inviato, bozza, search, bounced } = req.query;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const offset = (page - 1) * limit;

    const filter = buildFilterClauses(req.query);
    const where = filter.conditions.length > 0 ? `WHERE ${filter.conditions.join(" AND ")}` : "";
    const params = filter.params;
    let paramIdx = filter.paramIdx;

    /* regione filter: separate from chips queries (they don't need municipalities JOIN) */
    const mainConditions = [...filter.conditions];
    const mainParams = [...filter.params];
    let mainParamIdx = filter.paramIdx;
    if (regione) {
      mainConditions.push(`m.denominazione_regione = $${mainParamIdx++}`);
      mainParams.push(regione);
    }
    const mainWhere = mainConditions.length > 0 ? `WHERE ${mainConditions.join(" AND ")}` : "";

    const sortBy = ["updated_at", "created_at", "title", "comune", "rating", "rating_count", "id"].includes(req.query.sort_by) ? req.query.sort_by : "updated_at";
    const numericCols = new Set(["rating", "rating_count"]);
    const sortCol = numericCols.has(sortBy)
      ? `NULLIF(regexp_replace(d.${sortBy}, '[^0-9.]', '', 'g'), '')::numeric`
      : `d.${sortBy}`;
    const sortOrder = req.query.sort_order === "asc" ? "ASC NULLS LAST" : "DESC NULLS LAST";

    const mJoin = "LEFT JOIN (SELECT DISTINCT sigla_provincia, denominazione_regione FROM municipalities) m ON d.provincia = m.sigla_provincia";

    const countResult = await query(`SELECT COUNT(*)::int FROM companies d LEFT JOIN campaigns c ON c.id = d.campaign_id ${mJoin} ${mainWhere}`, mainParams);
    const total = countResult.rows[0].count;

    const chipWhere = mainWhere ? mainWhere + " AND " : "WHERE ";
    const [noDraftCount, pendingApprovCount, approvedCount, sentCount, bouncedCount] = await Promise.all([
      query(`SELECT COUNT(*)::int FROM companies d LEFT JOIN campaigns c ON c.id = d.campaign_id ${mJoin} ${chipWhere}(d.bozza_creata = false OR d.bozza_creata IS NULL)`, mainParams),
      query(`SELECT COUNT(*)::int FROM companies d LEFT JOIN campaigns c ON c.id = d.campaign_id ${mJoin} ${chipWhere}d.bozza_creata = true AND d.approvato = false AND (d.inviato = false OR d.inviato IS NULL)`, mainParams),
      query(`SELECT COUNT(*)::int FROM companies d LEFT JOIN campaigns c ON c.id = d.campaign_id ${mJoin} ${chipWhere}d.approvato = true AND d.inviato = false`, mainParams),
      query(`SELECT COUNT(*)::int FROM companies d LEFT JOIN campaigns c ON c.id = d.campaign_id ${mJoin} ${chipWhere}d.inviato = true`, mainParams),
      query(`SELECT COUNT(*)::int FROM companies d LEFT JOIN campaigns c ON c.id = d.campaign_id ${mJoin} ${chipWhere}d.email_bounced = true`, mainParams),
    ]);

    const result = await query(
      `SELECT d.id, d.title, d.address, d.comune, d.provincia, d.rating, d.rating_count, d.phone_number,
              d.website, d.email, d.nome_studio, d.nome_azienda, d.approvato, d.inviato,
              d.bozza_creata, d.bozza_rifai, d.bozza_email_oggetto, d.bozza_failed_count, d.updated_at,
              d.lead_score, d.has_replied,
              c.name AS campaign_name,
              m.denominazione_regione AS regione
       FROM companies d
       LEFT JOIN campaigns c ON c.id = d.campaign_id
       LEFT JOIN (SELECT DISTINCT sigla_provincia, denominazione_regione FROM municipalities) m ON d.provincia = m.sigla_provincia
       ${mainWhere}
       ORDER BY ${sortCol} ${sortOrder}
       LIMIT $${mainParamIdx} OFFSET $${mainParamIdx + 1}`,
      [...mainParams, parseInt(limit, 10), offset]
    );

    const province = await query("SELECT provincia FROM companies WHERE provincia IS NOT NULL GROUP BY provincia ORDER BY provincia");
    const campaigns = await query("SELECT id, name FROM campaigns ORDER BY created_at DESC");
    const regioni = await query("SELECT DISTINCT denominazione_regione FROM municipalities WHERE denominazione_regione IS NOT NULL ORDER BY denominazione_regione");

    const currentQuery = Object.entries({ ...req.query }).filter(([_, v]) => v !== '' && v !== undefined).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');

    res.render("companies/list", {
      companies: result.rows,
      campaigns: campaigns.rows,
      province: province.rows,
      regioni: regioni.rows,
      filters: { comune, provincia, regione: regione || '', approvato, inviato, bozza, search, bounced, campaign_id: req.query.campaign_id || '', sort_by: req.query.sort_by || '', sort_order: req.query.sort_order || '' },
      pagination: { page: parseInt(page, 10), limit: parseInt(limit, 10), total, pages: Math.ceil(total / parseInt(limit, 10)) },
      currentQuery,
      noDraftCount: noDraftCount.rows[0].count,
      pendingApprovCount: pendingApprovCount.rows[0].count,
      approvedCount: approvedCount.rows[0].count,
      sentCount: sentCount.rows[0].count,
      bouncedCount: bouncedCount.rows[0].count,
    });
  } catch (err) {
    logger.error("Companies list error", { error: err.message });
    res.status(500).render("error", {messageKey: "error.load_companies" });
  }
});

router.get("/companies/:id", async (req, res) => {
  try {
    const result = await query("SELECT * FROM companies WHERE id = $1", [req.params.id]);
    if (result.rows.length === 0) return res.status(404).render("error", {messageKey: "error.company_not_found" });

    const audits = await query(
      `SELECT al.*, u.name AS user_name FROM audit_log al
       LEFT JOIN users u ON u.id = al.user_id
       WHERE al.resource = 'companies' AND al.resource_id = $1
       ORDER BY al.created_at DESC LIMIT 5`,
      [req.params.id]
    );

    const allowedParams = ["page", "limit", "comune", "provincia", "approvato", "inviato", "bozza", "search", "sort_by", "sort_order"];
    const filteredQuery = Object.fromEntries(Object.entries(req.query).filter(([k]) => allowedParams.includes(k)));
    const returnQuery = Object.keys(filteredQuery).length > 0 ? `?${new URLSearchParams(filteredQuery).toString()}` : '';
    const versions = await query(
      "SELECT id, oggetto, source, created_at FROM company_email_versions WHERE company_id = $1 ORDER BY created_at DESC LIMIT 10",
      [req.params.id]
    );
    const sequences = await query(
      "SELECT id, step, scheduled_at, sent_at, cancelled_at, cancel_reason FROM email_sequences WHERE company_id = $1 ORDER BY step",
      [req.params.id]
    );
    const sentVia = await query(
      `SELECT sa.name AS smtp_account_name, sa.from_email AS smtp_from_email
       FROM email_queue eq LEFT JOIN smtp_accounts sa ON sa.id = eq.smtp_account_id
       WHERE eq.company_id = $1 AND eq.status = 'sent'
       ORDER BY eq.processed_at DESC LIMIT 1`,
      [req.params.id]
    );
    const campaigns = await query("SELECT id, name FROM campaigns ORDER BY created_at DESC");
    res.render("companies/detail", { company: result.rows[0], returnQuery, audits: audits.rows, versions: versions.rows, sequences: sequences.rows, sentVia: sentVia.rows[0] || null, campaigns: campaigns.rows });
  } catch (err) {
    logger.error("Company detail error", { error: err.message });
    res.status(500).render("error", {messageKey: "error.load_company" });
  }
});

router.patch("/api/companies/:id/approve", requireAuth, requireAdmin, async (req, res) => {
  try {
    const { approvato } = req.body;
    if (typeof approvato !== 'boolean') {
      return res.status(400).json({ error: "approvato deve essere un booleano" });
    }
    const company = await query("SELECT id, approvato, bozza_creata FROM companies WHERE id = $1", [req.params.id]);
    if (company.rows.length === 0) return res.status(404).json({ error: "Non trovato" });
    if (approvato === true && !company.rows[0]?.bozza_creata) {
      return res.status(400).json({ error: "Nessuna bozza da approvare. Genera prima una bozza email." });
    }
    await query("UPDATE companies SET approvato = $1, updated_at = NOW() WHERE id = $2", [approvato, req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch("/api/companies/:id", authorize('companies', 'update'), validate(companyUpdateSchema), async (req, res) => {
  try {
    const { inviato, bozza_rifai, bozza_email, bozza_email_oggetto, email } = req.body;
    const fields = [];
    const params = [];
    let idx = 1;

    const { getClient } = await import("../db.js");
    const client = await getClient();
    let updatedCompany = null;
    try {
      await client.query("BEGIN");

      const current = await client.query("SELECT inviato FROM companies WHERE id = $1 FOR UPDATE", [req.params.id]);
      const isInviato = current.rows.length > 0 && current.rows[0].inviato === true;

      if (inviato !== undefined) {
        if (isInviato && inviato === false) {
          await client.query("ROLLBACK").catch(() => {});
          client.release();
          return res.status(400).json({ error: "Non puoi annullare un invio già effettuato" });
        }
      }

      if (isInviato && (bozza_email !== undefined || bozza_email_oggetto !== undefined)) {
        await client.query("ROLLBACK").catch(() => {});
        client.release();
        return res.status(400).json({ error: "Non puoi modificare la bozza di un'email già inviata" });
      }

      if (inviato !== undefined) { fields.push(`inviato = $${idx++}`); params.push(inviato); }
      if (bozza_rifai !== undefined) {
        if (bozza_rifai) {
          const cur = await client.query("SELECT bozza_email, bozza_email_oggetto FROM companies WHERE id = $1", [req.params.id]);
          if (cur.rows[0]?.bozza_email) {
            const cnt = await client.query("SELECT COUNT(*)::int FROM company_email_versions WHERE company_id = $1", [req.params.id]);
            if (cnt.rows[0].count >= 10) {
              await client.query("DELETE FROM company_email_versions WHERE id = (SELECT id FROM company_email_versions WHERE company_id = $1 ORDER BY created_at ASC LIMIT 1)", [req.params.id]);
            }
            await client.query(
              `INSERT INTO company_email_versions (company_id, oggetto, contenuto, source, created_by)
               VALUES ($1, $2, $3, 'manual', $4)`,
              [req.params.id, cur.rows[0].bozza_email_oggetto, cur.rows[0].bozza_email, req.user.sub]
            );
          }
          fields.push(`bozza_creata = false`);
          fields.push(`approvato = false`);
        }
        fields.push(`bozza_rifai = $${idx++}`);
        params.push(bozza_rifai);
      }
      if (bozza_email !== undefined || bozza_email_oggetto !== undefined) {
        const cur = await client.query("SELECT bozza_email, bozza_email_oggetto FROM companies WHERE id = $1", [req.params.id]);
        if (cur.rows[0]?.bozza_email) {
          const cnt = await client.query("SELECT COUNT(*)::int FROM company_email_versions WHERE company_id = $1", [req.params.id]);
          if (cnt.rows[0].count >= 10) {
            await client.query("DELETE FROM company_email_versions WHERE id = (SELECT id FROM company_email_versions WHERE company_id = $1 ORDER BY created_at ASC LIMIT 1)", [req.params.id]);
          }
          await client.query(
            `INSERT INTO company_email_versions (company_id, oggetto, contenuto, source, created_by)
             VALUES ($1, $2, $3, 'manual', $4)`,
            [req.params.id, cur.rows[0].bozza_email_oggetto, cur.rows[0].bozza_email, req.user.sub]
          );
        }
        if (bozza_email !== undefined) { fields.push(`bozza_email = $${idx++}`); params.push(bozza_email); fields.push(`bozza_creata = true`); }
        if (bozza_email_oggetto !== undefined) { fields.push(`bozza_email_oggetto = $${idx++}`); params.push(bozza_email_oggetto); }
      }
      if (email !== undefined) { 
        fields.push(`email = $${idx++}`); params.push(email); 
        fields.push(`email_bounced = false`);
      }

      if (fields.length === 0) {
        await client.query("ROLLBACK").catch(() => {});
        client.release();
        return res.status(400).json({ error: "Nessun campo da aggiornare" });
      }

      fields.push(`updated_at = NOW()`);
      params.push(req.params.id);

      await client.query(
        `UPDATE companies SET ${fields.join(", ")} WHERE id = $${idx}`,
        params
      );

      // Leggi il azienda aggiornato per upsertSubscriber fuori transazione
      const updated = await client.query("SELECT * FROM companies WHERE id = $1", [req.params.id]);
      updatedCompany = updated.rows[0];

      await client.query("COMMIT");
      client.release();
    } catch (txErr) {
      await client.query("ROLLBACK").catch(() => {});
      client.release();
      throw txErr;
    }

    const auditDetails = {};
    for (const [k, v] of Object.entries(req.body)) {
      auditDetails[k] = typeof v === 'string' && v.length > 200 ? v.slice(0, 200) + '...' : v;
    }
    await query(
      `INSERT INTO audit_log (user_id, action, resource, resource_id, details)
       VALUES ($1, 'update', 'companies', $2, $3)`,
      [req.user.sub, req.params.id, JSON.stringify(auditDetails)]
    );

    res.json({ success: true });
  } catch (err) {
    logger.error("Company update error", { error: err.message });
    res.status(500).json({ error: "Errore aggiornamento" });
  }
});

router.post("/api/companies/:id/send", requireAuth, requireAdmin, async (req, res) => {
  try {
    // Opt-out totale: un contatto disiscritto (blacklist condivisa con CMS) non può
    // MAI essere inviato, nemmeno nel flusso one-to-one manuale.
    const check = await query("SELECT unsubscribed_at FROM companies WHERE id = $1", [req.params.id]);
    if (check.rows[0]?.unsubscribed_at) {
      return res.status(400).json({ error: "Contatto disiscritto (opt-out): invio non consentito" });
    }
    const result = await query(
      `SELECT * FROM companies WHERE id = $1 AND tenant_id = $2 AND bozza_creata = true
       AND approvato = true AND (inviato = false OR inviato IS NULL)
       AND unsubscribed_at IS NULL`,
      [req.params.id, req.user.tenant_id]
    );
    if (result.rows.length === 0) {
      return res.status(400).json({ error: "Nessuna bozza approvata da inviare" });
    }

    const company = result.rows[0];
    // Invio manuale one-to-one: contrassegna il contesto come 'manual' in coda, così
    // il cron (processEmailQueue) lo riconosce e ammette anche il cold (mai programmato
    // in automatico). I cold non entrano nelle folle automatiche (send_context='automatic').
    await query(
      "INSERT INTO email_queue (company_id, provincia, status, send_context, tenant_id) VALUES ($1, $2, 'pending', 'manual', $3) ON CONFLICT (company_id) WHERE status IN ('pending', 'sending') DO NOTHING",
      [company.id, company.provincia, req.user.tenant_id]
    );

    await query(
      `INSERT INTO audit_log (user_id, action, resource, resource_id, details)
       VALUES ($1, 'queue', 'companies', $2, $3)`,
      [req.user.sub, company.id, JSON.stringify({ method: 'email_queue' })]
    );

    res.json({ success: true, queued: true });
  } catch (err) {
    logger.error("Send email error", { error: err.message });
    res.status(500).json({ error: "Errore accodamento email" });
  }
});

router.post("/api/companies/import-csv", requireAdmin, async (req, res) => {
  try {
    const { csv, columnMapping } = req.body;
    if (!csv) return res.status(400).json({ error: "CSV richiesto" });
    if (!columnMapping || typeof columnMapping !== 'object') {
      return res.status(400).json({ error: "columnMapping richiesto" });
    }
    const MAX_CSV_SIZE = 10 * 1024 * 1024;
    if (csv.length > MAX_CSV_SIZE) {
      return res.status(413).json({ error: "CSV troppo grande (max 10 MB)" });
    }

    const result = await importCsvFromText(csv, columnMapping, req.user.sub, req.body.campaign_id ? parseInt(req.body.campaign_id, 10) : null, req.user.tenant_id || null);
    res.json(result);
  } catch (err) {
    logger.error("CSV import error", { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

router.post("/api/companies/bulk-approve", requireAuth, requireAdmin, async (req, res) => {
  try {
    const { ids, approvato } = req.body;
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > 1000) {
      return res.status(400).json({ error: "IDs non validi o troppi (max 1000)" });
    }
    if (!ids.every(id => Number.isInteger(id) && id > 0)) {
      return res.status(400).json({ error: "IDs devono essere interi positivi" });
    }
    const val = approvato !== undefined ? approvato : true;

    const result = await query(
      `UPDATE companies SET approvato = $1, updated_at = NOW()
       WHERE id = ANY($2::int[]) AND bozza_creata = true AND (inviato = false OR inviato IS NULL)
       RETURNING id`,
      [val, ids]
    );

    await query(
      `INSERT INTO audit_log (user_id, action, resource, details)
       VALUES ($1, 'bulk_approve', 'companies', $2)`,
      [req.user.sub, JSON.stringify({ count: result.rowCount, ids })]
    );

    res.json({ success: true, updated: result.rowCount });
  } catch (err) {
    logger.error("Bulk approve error", { error: err.message });
    res.status(500).json({ error: "Errore approvazione bulk" });
  }
});

router.get("/api/companies/bulk-preview", requireAdmin, async (req, res) => {
  try {
    const ids = req.query.ids ? req.query.ids.split(',').map(Number).filter(Boolean) : [];
    if (ids.length === 0) return res.json([]);
    if (ids.length > 1000) return res.status(400).json({ error: "IDs non validi o troppi (max 1000)" });
    if (!ids.every(id => Number.isInteger(id) && id > 0)) {
      return res.status(400).json({ error: "IDs devono essere interi positivi" });
    }

    const result = await query(
      `SELECT id, title, nome_studio, nome_azienda, bozza_email_oggetto,
              LEFT(bozza_email, 200) AS bozza_email_preview, bozza_creata, approvato
       FROM companies WHERE id = ANY($1::int[])`,
      [ids]
    );
    res.json(result.rows);
  } catch (err) {
    logger.error("Bulk preview error", { error: err.message });
    res.status(500).json({ error: "Errore caricamento preview" });
  }
});

router.get("/api/companies/kanban", requireAuth, async (req, res) => {
  try {
    const [noDraft, pendingApproval, approved, sent] = await Promise.all([
      query("SELECT id, nome_studio, comune, email FROM companies WHERE (bozza_creata = false OR bozza_creata IS NULL) ORDER BY comune LIMIT 100"),
      query("SELECT id, nome_studio, comune, bozza_email_oggetto FROM companies WHERE bozza_creata = true AND approvato = false AND (inviato = false OR inviato IS NULL) ORDER BY comune LIMIT 100"),
      query("SELECT id, nome_studio, comune, bozza_email_oggetto FROM companies WHERE approvato = true AND inviato = false ORDER BY comune LIMIT 100"),
      query("SELECT id, nome_studio, comune FROM companies WHERE inviato = true ORDER BY inviato_at DESC LIMIT 100"),
    ]);
    res.json({
      noDraft: noDraft.rows,
      pendingApproval: pendingApproval.rows,
      approved: approved.rows,
      sent: sent.rows,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const exportLimiter = rateLimit({
  windowMs: 60 * 1000, max: 3,
  message: { error: "Troppe richieste di export. Riprova tra 1 minuto." },
  standardHeaders: true, legacyHeaders: false,
});

router.get("/api/companies/export", requireAdmin, exportLimiter, async (req, res) => {
  try {
    const filter = buildFilterClauses(req.query);
    if (req.query.ids) {
      const ids = req.query.ids.split(',').map(Number).filter(Boolean);
      if (ids.length > 0) {
        filter.conditions.push(`d.id = ANY($${filter.paramIdx}::int[])`);
        filter.params.push(ids);
        filter.paramIdx++;
      }
    }
    const where = filter.conditions.length > 0 ? `WHERE ${filter.conditions.join(" AND ")}` : "";
    const MAX_EXPORT_ROWS = 10000;

    const result = await query(
      `SELECT d.id, d.title, d.nome_studio, d.nome_azienda, d.email, d.website, d.phone_number,
              d.address, d.comune, d.provincia, d.via, d.cap, d.rating, d.rating_count,
              d.approvato, d.inviato, d.bozza_creata, d.bozza_email_oggetto,
              d.inviato_at, d.email_opened_at, d.email_clicked_at,
              d.lead_score, d.has_replied
        FROM companies d LEFT JOIN campaigns c ON c.id = d.campaign_id
        ${where}
       ORDER BY d.updated_at DESC
       LIMIT $${filter.paramIdx}`,
      [...filter.params, MAX_EXPORT_ROWS]
    );

    const csv = stringify(result.rows, { header: true, delimiter: ',' });
    if (result.rows.length >= MAX_EXPORT_ROWS) {
      res.setHeader("X-Export-Truncated", "true");
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename=aziende.csv');
    res.send(csv);
  } catch (err) {
    logger.error("Export CSV error", { error: err.message });
    res.status(500).json({ error: "Errore esportazione" });
  }
});

router.get("/api/companies/:id/preview", async (req, res) => {
  try {
    const result = await query(
      "SELECT id, bozza_email_oggetto, bozza_email FROM companies WHERE id = $1",
      [req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: "Non trovato" });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete("/api/companies/:id", authorize('companies', 'delete'), async (req, res) => {
  try {
    await query("DELETE FROM companies WHERE id = $1", [req.params.id]);

    await query(
      `INSERT INTO audit_log (user_id, action, resource, resource_id)
       VALUES ($1, 'delete', 'companies', $2)`,
      [req.user.sub, req.params.id]
    );

    res.json({ success: true });
  } catch (err) {
    logger.error("Company delete error", { error: err.message });
    res.status(500).json({ error: "Errore eliminazione" });
  }
});

router.get("/api/companies/:id/versions", async (req, res) => {
  try {
    const result = await query(
      "SELECT id, oggetto, source, created_at FROM company_email_versions WHERE company_id = $1 ORDER BY created_at DESC LIMIT 10",
      [req.params.id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: "Errore caricamento versioni" });
  }
});

router.post("/api/companies/:id/restore-version/:versionId", requireAdmin, async (req, res) => {
  try {
    const version = await query(
      "SELECT * FROM company_email_versions WHERE id = $1 AND company_id = $2",
      [req.params.versionId, req.params.id]
    );
    if (version.rows.length === 0) return res.status(404).json({ error: "Versione non trovata" });

    const current = await query("SELECT bozza_email, bozza_email_oggetto FROM companies WHERE id = $1", [req.params.id]);
    if (current.rows[0]?.bozza_email) {
      await query(
        "INSERT INTO company_email_versions (company_id, oggetto, contenuto, source, created_by) VALUES ($1,$2,$3,'auto',$4)",
        [req.params.id, current.rows[0].bozza_email_oggetto, current.rows[0].bozza_email, req.user.sub]
      );
    }

    await query(
      "UPDATE companies SET bozza_email_oggetto = $1, bozza_email = $2, updated_at = NOW() WHERE id = $3",
      [version.rows[0].oggetto, version.rows[0].contenuto, req.params.id]
    );

    await query(
      `INSERT INTO audit_log (user_id, action, resource, resource_id, details)
       VALUES ($1, 'restore_version', 'companies', $2, $3)`,
      [req.user.sub, req.params.id, JSON.stringify({ versionId: req.params.versionId })]
    );

    res.json({ success: true, oggetto: version.rows[0].oggetto, contenuto: version.rows[0].contenuto });
  } catch (err) {
    res.status(500).json({ error: "Errore ripristino versione" });
  }
});

router.post("/api/companies/:id/cms-sync", requireAdmin, async (req, res) => {
  try {
    const result = await query("SELECT * FROM companies WHERE id = $1", [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({errorKey: "error.company_not_found" });
    const company = result.rows[0];
    const { syncCompanyWithCms } = await import("../services/cms.js");
    const consentStatus = await syncCompanyWithCms(company);
    const updated = await query(
      "SELECT consent_status, consent_source, cms_synced_at FROM companies WHERE id = $1",
      [req.params.id]
    );
    res.json({ success: true, consent_status: updated.rows[0]?.consent_status || consentStatus || 'cold' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch("/api/companies/:id/campaign", requireAuth, requireAdmin, async (req, res) => {
  try {
    const { campaign_id } = req.body;
    await query("UPDATE companies SET campaign_id = $1, updated_at = NOW() WHERE id = $2",
      [campaign_id ? parseInt(campaign_id, 10) : null, req.params.id]);
    await query(
      `INSERT INTO audit_log (user_id, action, resource, resource_id, details)
       VALUES ($1, 'assign_campaign', 'companies', $2, $3)`,
      [req.user.sub, req.params.id, JSON.stringify({ campaign_id })]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/api/companies/:id/final-preview", requireAdmin, async (req, res) => {
  try {
    const d = await query(`SELECT d.*, c.use_html, c.html_wrapper, c.footer_text, c.footer_html, c.smtp_account_id, sa.from_name, sa.from_email, sa.firma_testo, sa.firma_html FROM companies d LEFT JOIN campaigns c ON c.id = d.campaign_id LEFT JOIN smtp_accounts sa ON sa.id = c.smtp_account_id WHERE d.id = $1`, [req.params.id]);
    const company = d.rows[0];
    if (!company) return res.status(404).json({ error: "Non trovato" });
    let body = company.bozza_email || "";
    if (company.firma_testo && !company.use_html) body += "\n\n" + company.firma_testo;
    let html = null;
    if (company.use_html) {
      const wrapper = company.html_wrapper || "<div>{{BODY}}</div>";
      html = wrapper.replace("{{BODY}}", body.replace(/\n/g, "<br>"));
      if (company.firma_html) html = html.replace("</body>", company.firma_html + "</body>");
    }
    res.json({
      from: `${company.from_name || config.brand.defaultFromName} <${company.from_email || "—"}>`,
      subject: company.bozza_email_oggetto || "—",
      text: company.use_html ? null : body,
      html: html || `<pre style="font-family:Arial;font-size:14px;line-height:1.6;white-space:pre-wrap;">${body}</pre>`
    });
  } catch (err) {
    logger.error("Final preview error", { error: err.message });
    res.status(500).json({ error: "Errore caricamento preview" });
  }
});

router.post("/api/companies/bulk-campaign", requireAuth, requireAdmin, async (req, res) => {
  try {
    const { ids, campaign_id } = req.body;
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > 1000) {
      return res.status(400).json({ error: "IDs non validi o troppi (max 1000)" });
    }
    if (!ids.every(id => Number.isInteger(id) && id > 0)) {
      return res.status(400).json({ error: "IDs devono essere interi positivi" });
    }
    const result = await query(
      "UPDATE companies SET campaign_id = $1, updated_at = NOW() WHERE id = ANY($2::int[])",
      [campaign_id ? parseInt(campaign_id, 10) : null, ids]
    );
    await query(
      `INSERT INTO audit_log (user_id, action, resource, details)
       VALUES ($1, 'bulk_campaign', 'companies', $2)`,
      [req.user.sub, JSON.stringify({ count: result.rowCount, campaign_id, ids })]);
    res.json({ success: true, updated: result.rowCount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/companies/:id/sent-email — Recupera l'esatto contenuto inviato
router.get("/api/companies/:id/sent-email", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: "ID non valido" });
    const result = await query(
      "SELECT id, nome_azienda, email, sent_email_subject, sent_email_body, inviato_at FROM companies WHERE id = $1 AND inviato = true AND sent_email_body IS NOT NULL",
      [id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: "Nessuna email inviata trovata per questo azienda" });
    res.json({ company: result.rows[0] });
  } catch (err) {
    logger.error("sent-email error", { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// POST /api/companies/:id/reset-failed — Resetta bozza_failed_count (sblocca azienda bloccato da AI outage)
router.post("/api/companies/:id/reset-failed", requireAuth, requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: "ID non valido" });
    await query(
      "UPDATE companies SET bozza_failed_count = 0, bozza_rifai = true, updated_at = NOW() WHERE id = $1",
      [id]
    );
    await query(
      `INSERT INTO audit_log (user_id, action, resource, resource_id, details)
       VALUES ($1, 'reset_failed_count', 'companies', $2, $3)`,
      [req.user.sub, id, JSON.stringify({ action: 'reset_bozza_failed_count' })]
    );
    res.json({ success: true, message: "Contatore reset, bozza rimarcata per rigenerazione" });
  } catch (err) {
    logger.error("Reset failed count error", { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

export default router;
