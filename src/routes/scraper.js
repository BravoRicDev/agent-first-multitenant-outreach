import { Router } from "express";
import { URL } from "url";
import rateLimit from "express-rate-limit";
import { query } from "../db.js";
import { fetchUrl, isPrivateUrl } from "../services/scraper.js";
import { extractFromWebsite } from "../services/ai-extraction.js";
import { generateEmail, rewriteEmail } from "../services/ai-copywriter.js";
import { validateEmail } from "../services/ai-validator.js";
import { checkBlacklist } from "../services/blacklist.js";
import { requireAuth, requireAdmin } from "../middleware/auth.js";
import { logger } from "../services/logger.js";
import { checkMemory } from "../services/memory.js";
import { getSetting } from "../services/settings.js";
import { validate } from "../middleware/validate.js";
import { scraperUrlSchema, scraperExtractSchema } from "../validations/schemas.js";

const scraperUrlLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { error: "Troppe richieste allo scraper. Riprova tra 1 minuto." },
  standardHeaders: true,
  legacyHeaders: false,
});

const router = Router();

router.use(requireAuth);
router.use(requireAdmin);

router.post("/api/scraper/url", scraperUrlLimiter, validate(scraperUrlSchema), async (req, res) => {
  try {
    const { url } = req.body;

    if (isPrivateUrl(url)) {
      return res.status(403).json({ error: "URL non consentito (rete interna)" });
    }

    const result = await fetchUrl(url);
    res.json(result);
  } catch (err) {
    logger.error("Scraper URL error", { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

router.post("/api/scraper/extract", validate(scraperExtractSchema), async (req, res) => {
  try {
    checkMemory();
    const { website, companyId } = req.body;

    if (isPrivateUrl(website)) return res.status(403).json({ error: "URL non consentito (rete interna)" });
    const extracted = await extractFromWebsite(website);
    if (!extracted) return res.status(500).json({ error: "Estrazione fallita" });

    if (companyId) {
      await query(
        `UPDATE companies SET
          email = COALESCE(NULLIF($1, ''), email),
          nome_studio = COALESCE(NULLIF($2, ''), nome_studio),
          nome_azienda = COALESCE(NULLIF($3, ''), nome_azienda),
          descrizione = COALESCE(NULLIF($4, ''), descrizione),
          altre_pagine_rilevanti = COALESCE(NULLIF($5, ''), altre_pagine_rilevanti),
          updated_at = NOW()
        WHERE id = $6`,
        [extracted.email_azienda, extracted.nome_studio_aziendale, extracted.nome_azienda,
         extracted.descrizione, extracted.altre_pagine_rilevanti, companyId]
      );
      await query(
        `INSERT INTO audit_log (user_id, action, resource, resource_id, details)
         VALUES ($1, 'extract_from_website', 'companies', $2, $3)`,
        [req.user.sub, companyId, JSON.stringify({ website })]
      ).catch(() => {}); // non-bloccante
      const fresh = await query("SELECT id, email, nome_studio, nome_azienda, descrizione, altre_pagine_rilevanti FROM companies WHERE id = $1", [companyId]);
      return res.json(fresh.rows[0] || extracted);
    }

    res.json(extracted);
  } catch (err) {
    logger.error("Scraper extract error", { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

router.post("/api/scraper/generate-email", async (req, res) => {
  try {
    checkMemory();
    const companyId = parseInt(req.body.companyId, 10);
    if (isNaN(companyId)) return res.status(400).json({ error: "companyId non valido" });

    const companyResult = await query("SELECT * FROM companies WHERE id = $1", [companyId]);
    if (companyResult.rows.length === 0) return res.status(404).json({errorKey: "error.company_not_found" });

    const company = companyResult.rows[0];
    const dirResult = await query("SELECT * FROM direzione WHERE id = 1");
    const direzione = dirResult.rows[0] || {};
    if (!direzione.info_azienda || !direzione.info_azienda.trim()) {
      return res.status(400).json({ error: "Configurazione direzione assente. Compila Info Azienda in Direzione Copy prima di generare email." });
    }

    // CMS: sync contatto + consenso (best-effort, mai bloccante — nel CMS mono-tenant
    // i contatti sono sempre nostri, non esiste il gate 'pre_existing' di GHL)
    const { syncCompanyWithCms } = await import("../services/cms.js");
    try {
      await syncCompanyWithCms(company);
    } catch (err) {
      logger.warn("CMS sync fallito durante generazione bozza", { companyId: company.id, error: err.message });
    }

    const email = await generateEmail(company, direzione);
    if (!email) return res.status(500).json({ error: "Generazione email fallita" });

    const blacklistOk = await checkBlacklist(email.oggetto + " " + email.contenuto);
    if (!blacklistOk) {
      return res.status(422).json({ error: "Blacklist: email non valida", email });
    }

    let isValid = false;
    try {
      isValid = await validateEmail(email.oggetto, email.contenuto);
    } catch (err) {
      logger.warn("Validazione fallita, salvo comunque", { error: err.message });
      isValid = true;
    }

    if (!isValid) {
      return res.status(422).json({ error: "Validazione fallita", email });
    }

    await query(
      `UPDATE companies SET
        bozza_email_oggetto = $1, bozza_email = $2,
        bozza_creata = true, bozza_rifai = false, updated_at = NOW()
      WHERE id = $3`,
      [email.oggetto, email.contenuto, companyId]
    );

    await query(
      `INSERT INTO audit_log (user_id, action, resource, resource_id, details)
       VALUES ($1, 'generate_email', 'companies', $2, $3)`,
      [req.user.sub, companyId, JSON.stringify({ oggetto: email.oggetto })]
    );

    res.json({ success: true, oggetto: email.oggetto, contenuto: email.contenuto });
  } catch (err) {
    logger.error("Generate email error", { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

router.post("/api/scraper/rewrite-email", async (req, res) => {
  try {
    checkMemory();
    const companyId = parseInt(req.body.companyId, 10);
    if (isNaN(companyId)) return res.status(400).json({ error: "companyId non valido" });
    const { instructions } = req.body;
    if (!instructions) return res.status(400).json({ error: "instructions richiesto" });

    const companyResult = await query("SELECT * FROM companies WHERE id = $1", [companyId]);
    if (companyResult.rows.length === 0) return res.status(404).json({errorKey: "error.company_not_found" });

    const company = companyResult.rows[0];
    const dirResult = await query("SELECT * FROM direzione WHERE id = 1");
    const direzione = dirResult.rows[0] || {};

    const email = await rewriteEmail(
      company.bozza_email_oggetto || '',
      company.bozza_email || '',
      instructions,
      company,
      direzione
    );
    if (!email) return res.status(500).json({ error: "Riscrittura fallita" });

    const blacklistOk = await checkBlacklist(email.oggetto + " " + email.contenuto);
    if (!blacklistOk) {
      return res.status(422).json({ error: "Blacklist: email non valida", email });
    }

    let isValid = false;
    try {
      isValid = await validateEmail(email.oggetto, email.contenuto);
    } catch (err) {
      logger.warn("Validazione rewrite fallita, salvo comunque", { error: err.message });
      isValid = true;
    }
    if (!isValid) {
      return res.status(422).json({ error: "Validazione fallita", email });
    }

    await query(
      `UPDATE companies SET bozza_email_oggetto = $1, bozza_email = $2, bozza_creata = true, updated_at = NOW() WHERE id = $3`,
      [email.oggetto, email.contenuto, companyId]
    );

    await query(
      `INSERT INTO audit_log (user_id, action, resource, resource_id, details)
       VALUES ($1, 'rewrite_email', 'companies', $2, $3)`,
      [req.user.sub, companyId, JSON.stringify({ instructions })]
    );

    res.json({ success: true, oggetto: email.oggetto, contenuto: email.contenuto });
  } catch (err) {
    logger.error("Rewrite email error", { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

export default router;
