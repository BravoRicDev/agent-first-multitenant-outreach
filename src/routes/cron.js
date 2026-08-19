import { Router } from "express";
import { query, getClient } from "../db.js";
import config from "../config.js";
import { searchCompanies } from "../services/serper.js";
import { parseAddress } from "../services/address-parser.js";
import { fetchUrl } from "../services/scraper.js";
import { extractFromWebsite, HALLUCINATED_PATTERNS } from "../services/ai-extraction.js";
import { generateEmail, generateFollowUpEmail } from "../services/ai-copywriter.js";
import { validateEmail } from "../services/ai-validator.js";
import { checkBlacklist } from "../services/blacklist.js";
import { logger } from "../services/logger.js";
import { withLock, lastRunTimes } from "../services/locks.js";
import { sendCampaignEmail, sendFollowUpEmail } from "../services/email-sender.js";
import { checkMemory } from "../services/memory.js";
import { requireAuth, requireAdmin } from "../middleware/auth.js";
import { getSetting } from "../services/settings.js";
import { getNextSmtpAccount, resetDailyCounts } from "../services/smtp-router.js";
import { isWithinSendWindow, getDailyDispatchState, isDailyCapReached, resolveSendContext, enforceSchedulingConsent, SEND_CONTEXT } from "../services/send-schedule.js";
import { normalize } from "../services/phone-normalizer.js";
import { updateScores } from "../services/lead-scorer.js";
import { syncCompanyWithCms, addNote } from "../services/cms.js";

const router = Router();

router.use(requireAuth);
router.use(requireAdmin);

export async function processMunicipalities() {
  logger.info("Cron: processMunicipalities started");

  try {
    const result = await query(
      "SELECT id, denominazione_ita_altra FROM municipalities WHERE (eseguito = false OR eseguito IS NULL) AND denominazione_ita_altra IS NOT NULL AND denominazione_ita_altra != '' ORDER BY id LIMIT 10"
    );

    for (const comune of result.rows) {
      try {
        checkMemory();
        logger.info("Processing comune", { comune: comune.denominazione_ita_altra });

        const places = await searchCompanies(comune.denominazione_ita_altra);
        let insertedCount = 0;
        let skippedCount = 0;

        for (const place of places) {
          const parsed = parseAddress(place);
        const phoneNorm = normalize(place.phoneNumber);

        if (phoneNorm) {
          const dup = await query(
            "SELECT id FROM companies WHERE phone_normalized = $1 LIMIT 1",
            [phoneNorm]
          );
          if (dup.rows.length > 0) {
            logger.info("Saltato duplicato telefono", { phone: phoneNorm, existingId: dup.rows[0].id });
            skippedCount++;
            continue;
          }
        }

        if (parsed.email) {
          const emailDup = await query("SELECT id FROM companies WHERE email = $1 LIMIT 1", [parsed.email]);
          if (emailDup.rows.length > 0) {
            logger.info("Saltato duplicato email", { email: parsed.email, existingId: emailDup.rows[0].id });
            skippedCount++;
            continue;
          }
        }

            if (parsed.website && parsed.website.trim()) {
            await query(
              `INSERT INTO companies (position, title, address, latitude, longitude, rating, rating_count,
                category, phone_number, website, booking_links, cid, via, cap, comune, provincia, phone_normalized, created_at, updated_at)
              VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17, NOW(), NOW())
              ON CONFLICT (LOWER(website)) WHERE website IS NOT NULL AND website != '' DO UPDATE SET
                position = EXCLUDED.position, title = EXCLUDED.title,
                address = EXCLUDED.address, latitude = EXCLUDED.latitude,
                longitude = EXCLUDED.longitude, rating = EXCLUDED.rating,
                rating_count = EXCLUDED.rating_count, category = EXCLUDED.category,
                phone_number = EXCLUDED.phone_number, via = EXCLUDED.via,
                cap = EXCLUDED.cap, comune = EXCLUDED.comune, provincia = EXCLUDED.provincia,
                updated_at = NOW()`,
              [parsed.position, parsed.title, parsed.address, parsed.latitude, parsed.longitude,
               parsed.rating, parsed.ratingCount, parsed.category, parsed.phoneNumber,
               parsed.website, parsed.bookingLinks, parsed.cid, parsed.via, parsed.cap,
                parsed.comune, parsed.provincia, phoneNorm]
            );
            insertedCount++;
          } else {
            skippedCount++;
          }
        }

        if (insertedCount > 0) {
          await query("UPDATE municipalities SET eseguito = true, error_count = 0, error_note = NULL, ultima_lavorazione = $2, updated_at = NOW() WHERE id = $1",
            [comune.id, new Date().toISOString()]);
        } else if (places.length === 0) {
          await query("UPDATE municipalities SET error_count = COALESCE(error_count, 0) + 1, ultima_lavorazione = $2, updated_at = NOW() WHERE id = $1", [comune.id, new Date().toISOString()]);
          await query("UPDATE municipalities SET eseguito = true, error_note = 'Nessun azienda trovato' WHERE id = $1 AND COALESCE(error_count, 0) >= 3", [comune.id]);
        } else if (skippedCount === places.length) {
          await query("UPDATE municipalities SET eseguito = true, error_count = 0, error_note = NULL, ultima_lavorazione = $2, updated_at = NOW() WHERE id = $1", [comune.id, new Date().toISOString()]);
        }

        logger.info("Comune processato", { comune: comune.denominazione_ita_altra, placesFound: places.length, insertedCount });

        await new Promise(r => setTimeout(r, 10000));
      } catch (err) {
        logger.error("Errore processamento comune", { comune: comune.denominazione_ita_altra, error: err.message });
        await query(
          "UPDATE municipalities SET error_count = COALESCE(error_count, 0) + 1, error_note = $2, ultima_lavorazione = $3, updated_at = NOW() WHERE id = $1",
          [comune.id, err.message, new Date().toISOString()]
        );
        await query(
          "UPDATE municipalities SET eseguito = true WHERE id = $1 AND COALESCE(error_count, 0) >= 3",
          [comune.id]
        );
        const isRateLimit = err.message && (err.message.includes("429") || err.message.includes("rate limit"));
        await new Promise(r => setTimeout(r, isRateLimit ? 30000 : 10000));
        continue;
      }
      }
    const unscored = await query("SELECT id FROM companies WHERE lead_score IS NULL LIMIT 100");
    if (unscored.rows.length > 0) {
      await updateScores(unscored.rows.map(r => r.id));
    }
    } catch (err) {
    logger.error("Cron processMunicipalities error", { error: err.message });
  }
}

export async function generateEmailDrafts(companyIds = null) {
  logger.info("Cron: generateEmailDrafts started", { specificIds: !!companyIds });

  try {
    let sql, params;
    if (companyIds && Array.isArray(companyIds) && companyIds.length > 0) {
      const placeholders = companyIds.map((_, i) => `$${i + 1}`).join(", ");
      sql = `SELECT d.*,
         COALESCE(NULLIF(c.info_azienda, ''),   dir.info_azienda)          AS info_azienda,
         COALESCE(NULLIF(c.cta, ''),            dir.cta)                   AS cta,
         COALESCE(NULLIF(c.link_cta, ''),       dir.link_cta)              AS link_cta,
         COALESCE(NULLIF(c.email_spunti, ''),   dir.email_spunti)          AS email_spunti,
         COALESCE(NULLIF(c.email_template, ''), dir.email_template_bozza)  AS email_template_bozza,
         c.email_template                                        AS campaign_email_template,
         dir.correzione_prompt,
         c.prompt_copywriter,
         c.prompt_rewrite
      FROM companies d
      LEFT JOIN campaigns c   ON c.id  = d.campaign_id
      LEFT JOIN direzione dir ON dir.id = 1
      WHERE d.id IN (${placeholders})
        AND d.unsubscribed_at IS NULL
        AND ((d.bozza_creata = false OR d.bozza_creata IS NULL) OR d.bozza_rifai = true)
        AND (d.approvato = false OR d.approvato IS NULL)
        AND (d.inviato = false OR d.inviato IS NULL)
        AND (d.email IS NOT NULL AND d.email != '')
        AND (d.website IS NOT NULL AND d.website != '')`;
      params = companyIds;
    } else {
      sql = `SELECT d.*,
         COALESCE(NULLIF(c.info_azienda, ''),   dir.info_azienda)          AS info_azienda,
         COALESCE(NULLIF(c.cta, ''),            dir.cta)                   AS cta,
         COALESCE(NULLIF(c.link_cta, ''),       dir.link_cta)              AS link_cta,
         COALESCE(NULLIF(c.email_spunti, ''),   dir.email_spunti)          AS email_spunti,
         COALESCE(NULLIF(c.email_template, ''), dir.email_template_bozza)  AS email_template_bozza,
         c.email_template                                        AS campaign_email_template,
         dir.correzione_prompt,
         c.prompt_copywriter,
         c.prompt_rewrite
      FROM companies d
      LEFT JOIN campaigns c   ON c.id  = d.campaign_id
      LEFT JOIN direzione dir ON dir.id = 1
      WHERE d.unsubscribed_at IS NULL
        AND d.campaign_id IS NOT NULL
        AND c.is_active = true
        AND ((d.bozza_creata = false OR d.bozza_creata IS NULL) OR d.bozza_rifai = true)
        AND (d.approvato = false OR d.approvato IS NULL)
        AND (d.inviato = false OR d.inviato IS NULL)
        AND (d.email IS NOT NULL AND d.email != '')
        AND (d.website IS NOT NULL AND d.website != '')
        AND (d.bozza_failed_count IS NULL OR d.bozza_failed_count < 3)
      ORDER BY d.id
      LIMIT 20`;
      params = [];
    }
    const result = await query(sql, params);

    for (const company of result.rows) {
      try {
        checkMemory();
        if ((company.bozza_failed_count || 0) >= 3) {
          logger.warn("Azienda con troppi fallimenti di generazione, skip", { id: company.id });
          continue;
        }
        if (!company.info_azienda) {
          company.info_azienda = '';
          company.cta = '';
          company.link_cta = '';
          company.email_spunti = '';
          company.email_template_bozza = '';
        }
        // CMS: upsert contatto + sync consenso (best-effort, mai bloccante — il CMS è
        // nostro, nessun gate di ownership come in GHL).
        await syncCompanyWithCms(company);

        if (!company.nome_studio && !company.descrizione) {
          logger.info("Estrazione dati AI per azienda", { id: company.id });
          const extracted = await extractFromWebsite(company.website);
          if (extracted) {
            await query(
              `UPDATE companies SET
                email = CASE WHEN $1::text IS NOT NULL AND $1::text != '' THEN $1 ELSE email END,
                nome_studio = COALESCE($2, nome_studio),
                nome_azienda = COALESCE($3, nome_azienda), descrizione = COALESCE($4, descrizione),
                altre_pagine_rilevanti = COALESCE($5, altre_pagine_rilevanti), updated_at = NOW()
              WHERE id = $6`,
              [extracted.email_azienda, extracted.nome_studio_aziendale, extracted.nome_azienda,
               extracted.descrizione, extracted.altre_pagine_rilevanti, company.id]
            );
          }

          const fresh = await query("SELECT * FROM companies WHERE id = $1", [company.id]);
          if (fresh.rows.length === 0) continue;
          const campaignFields = {
            info_azienda: company.info_azienda,
            cta: company.cta,
            link_cta: company.link_cta,
            email_spunti: company.email_spunti,
            email_template_bozza: company.email_template_bozza,
            correzione_prompt: company.correzione_prompt,
          };
          Object.assign(company, fresh.rows[0], campaignFields);

          if (!company.email) {
            logger.warn("Azienda senza email dopo extraction, skip", { id: company.id });
            await new Promise(r => setTimeout(r, 10000));
            continue;
          }
        }

        // Salta aziende con dati studio allucinati o insufficienti (spreco token)
        const hasGoodStudio = company.nome_studio && company.nome_studio.trim().length >= 3
          && !HALLUCINATED_PATTERNS.some(p => p.test(company.nome_studio));
        const hasGoodDesc = company.descrizione && company.descrizione.trim().length >= 100;
        if (!hasGoodStudio || !hasGoodDesc) {
          logger.warn("Azienda con dati studio insufficienti, skip bozza", {
            id: company.id, nome_studio: company.nome_studio, desc_len: (company.descrizione || '').length
          });
          await query("UPDATE companies SET bozza_failed_count = COALESCE(bozza_failed_count, 0) + 1, updated_at = NOW() WHERE id = $1", [company.id]);
          await new Promise(r => setTimeout(r, 3000));
          continue;
        }

        const direzione = {
          info_azienda: company.info_azienda,
          cta: company.cta,
          link_cta: company.link_cta,
          email_spunti: company.email_spunti,
          // Se la campagna non ha un email_template suo, non passiamo il
          // fallback di direzione all'AI, altrimenti sovrascrive gli spunti
          email_template_bozza: company.campaign_email_template
            ? company.email_template_bozza
            : '',
        };

        if (!direzione.info_azienda || !direzione.info_azienda.trim()) {
          logger.warn("Info azienda mancante, salto generazione", { companyId: company.id });
          continue;
        }
        if (!direzione.cta || !direzione.cta.trim()) {
          logger.warn("CTA mancante, l'AI potrebbe generare email senza call-to-action", { companyId: company.id });
        }
        if (!direzione.link_cta || !direzione.link_cta.trim()) {
          logger.warn("Link CTA mancante, l'AI non potrà includere link nell'email", { companyId: company.id });
        }

        const email = await generateEmail(company, direzione, company.prompt_copywriter);
        if (!email) {
          await query("UPDATE companies SET bozza_failed_count = COALESCE(bozza_failed_count, 0) + 1, updated_at = NOW() WHERE id = $1", [company.id]);
          await new Promise(r => setTimeout(r, 5000));
          continue;
        }

        const blacklistOk = await checkBlacklist(email.oggetto + " " + email.contenuto);
        if (!blacklistOk) {
          await query("UPDATE companies SET bozza_failed_count = COALESCE(bozza_failed_count, 0) + 1, updated_at = NOW() WHERE id = $1", [company.id]);
          await new Promise(r => setTimeout(r, 5000));
          continue;
        }

        const isValid = await validateEmail(email.oggetto, email.contenuto);
        if (!isValid) {
          await query("UPDATE companies SET bozza_rifai = false, bozza_failed_count = COALESCE(bozza_failed_count, 0) + 1, updated_at = NOW() WHERE id = $1", [company.id]);
          await new Promise(r => setTimeout(r, 5000));
          continue;
        }

        await query(
          `UPDATE companies SET bozza_email_oggetto = $1, bozza_email = $2,
            bozza_creata = true, bozza_rifai = false, bozza_failed_count = 0, updated_at = NOW()
          WHERE id = $3`,
          [email.oggetto, email.contenuto, company.id]
        );

        logger.info("Email generata", { companyId: company.id });

        await new Promise(r => setTimeout(r, 10000));
      } catch (err) {
        logger.error("Errore generazione email per azienda", { id: company.id, error: err.message });
        await query("UPDATE companies SET bozza_failed_count = COALESCE(bozza_failed_count, 0) + 1, updated_at = NOW() WHERE id = $1", [company.id]).catch(e => logger.debug("Incremento fallimenti azienda fallito", { error: e.message }));
        await new Promise(r => setTimeout(r, ((company.bozza_failed_count || 0) + 1) >= 2 ? 5000 : 10000));
        continue;
      }
    }
    const scored = await query("SELECT id FROM companies WHERE lead_score IS NULL LIMIT 100");
    if (scored.rows.length > 0) {
      await updateScores(scored.rows.map(r => r.id));
    }
  } catch (err) {
    logger.error("Cron generateEmailDrafts error", { error: err.message });
  }
}

export async function cleanupErrors() {
  try {
    // Pulizia aziende "errore" (senza email/località, mai elaborati). Nessun residuo
    // GHL: con l'integrazione CMS le colonne ghl_* non vengono più usate.
    const result = await query(
      `DELETE FROM companies WHERE (comune IS NULL OR comune = '')
       AND created_at < NOW() - INTERVAL '7 days'
       AND (email IS NULL OR email = '')
       AND (bozza_creata = false OR bozza_creata IS NULL)
       AND inviato = false
       AND NOT EXISTS (SELECT 1 FROM email_queue WHERE company_id = companies.id AND status IN ('pending', 'sending'))
       RETURNING id`
    );
    if (result.rows.length > 0) {
      logger.info(`Pulizia errori: ${result.rows.length} aziende eliminati`);
    }
  } catch (err) {
    logger.error("Cleanup errors error", { error: err.message });
  }
}

// ── GENERAZIONE BOZZE FOLLOW-UP PER-AZIENDA ──
// Genera bozze personalizzate per ogni azienda in base ai template followup_sequences
// Salta aziende già inviati, disiscritti, o con bozze già generate e approvate
export async function generateFollowUpDrafts(companyIds = null, campaignId = null) {
  logger.info("Cron: generateFollowUpDrafts started", { specificIds: !!companyIds, campaignId });

  try {
    let conditions = [
      "d.unsubscribed_at IS NULL",
      "d.inviato = true",
      "d.email IS NOT NULL AND d.email != ''",
      "d.bozza_email IS NOT NULL",  // ha una bozza principale (da cui ricavare contesto)
      "fs.is_active = true",
      "fs.id IS NOT NULL",  // template esiste
    ];
    let params = [];
    let paramIdx = 1;

    if (companyIds && Array.isArray(companyIds) && companyIds.length > 0) {
      const placeholders = companyIds.map((_, i) => `$${paramIdx + i}`).join(", ");
      conditions.push(`d.id IN (${placeholders})`);
      params.push(...companyIds);
      paramIdx += companyIds.length;
    }
    if (campaignId) {
      conditions.push(`d.campaign_id = $${paramIdx++}`);
      params.push(campaignId);
    }

    // Trova aziende che hanno template followup attivi ma bozze non ancora generate (o da rigenerare)
    const sql = `
      SELECT d.id AS company_id, d.nome_studio, d.nome_azienda, d.descrizione, d.website,
             d.email, d.bozza_email, d.bozza_email_oggetto,
             d.campaign_id,
             fs.id AS template_id, fs.step_order, fs.delay_days,
             fs.subject AS template_subject, fs.body AS template_body,
             dfd.id AS draft_id, dfd.generato, dfd.approvato AS draft_approvato
      FROM companies d
      JOIN campaigns c ON c.id = d.campaign_id
      JOIN followup_sequences fs ON fs.campaign_id = d.campaign_id AND fs.is_active = true
      LEFT JOIN company_followup_drafts dfd ON dfd.company_id = d.id AND dfd.step_order = fs.step_order
      WHERE ${conditions.join(" AND ")}
        AND (dfd.id IS NULL OR (dfd.generato = false) OR (dfd.approvato = false AND dfd.generato = false))
      ORDER BY d.id, fs.step_order
      LIMIT 20
    `;
    const candidates = await query(sql, params);

    if (candidates.rows.length === 0) {
      logger.info("generateFollowUpDrafts: nessun candidato");
      return;
    }

    // Raggruppa per azienda per caricare la campagna una volta sola
    const companyMap = {};
    for (const row of candidates.rows) {
      if (!companyMap[row.company_id]) {
        companyMap[row.company_id] = {
          id: row.company_id,
          nome_studio: row.nome_studio,
          nome_azienda: row.nome_azienda,
          descrizione: row.descrizione,
          website: row.website,
          email: row.email,
          bozza_email: row.bozza_email,
          bozza_email_oggetto: row.bozza_email_oggetto,
          campaign_id: row.campaign_id,
          steps: [],
        };
      }
      companyMap[row.company_id].steps.push({
        template_id: row.template_id,
        step_order: row.step_order,
        delay_days: row.delay_days,
        template_subject: row.template_subject,
        template_body: row.template_body,
      });
    }

    for (const company of Object.values(companyMap)) {
      try {
        checkMemory();

        // Carica la campagna
        const campQ = await query(
          "SELECT c.*, COALESCE(NULLIF(c.info_azienda, ''), dir.info_azienda) AS info_azienda_final, COALESCE(NULLIF(c.cta, ''), dir.cta) AS cta_final, COALESCE(NULLIF(c.link_cta, ''), dir.link_cta) AS link_cta_final FROM campaigns c LEFT JOIN direzione dir ON dir.id = 1 WHERE c.id = $1",
          [company.campaign_id]
        );
        const campagna = campQ.rows[0] || {};

        for (const step of company.steps) {
          try {
            logger.info("Generazione bozza followup", { companyId: company.id, step: step.step_order });

            const template = {
              subject: step.template_subject,
              body: step.template_body,
              step_order: step.step_order,
            };

            const emailData = await generateFollowUpEmail(
              company,
              template,
              company.bozza_email_oggetto,
              company.bozza_email,
              campagna
            );

            if (!emailData) {
              logger.warn("Generazione bozza followup fallita", { companyId: company.id, step: step.step_order });
              await new Promise(r => setTimeout(r, 5000));
              continue;
            }

            // Salva o aggiorna la bozza followup
            await query(
              `INSERT INTO company_followup_drafts (company_id, campaign_id, step_order, subject, body, generato, updated_at)
               VALUES ($1, $2, $3, $4, $5, true, NOW())
               ON CONFLICT (company_id, step_order)
               DO UPDATE SET subject = EXCLUDED.subject, body = EXCLUDED.body,
                             generato = true, approvato = CASE WHEN company_followup_drafts.approvato THEN true ELSE false END,
                             updated_at = NOW()`,
              [company.id, company.campaign_id, step.step_order, emailData.oggetto, emailData.contenuto]
            );

            logger.info("Bozza followup generata", { companyId: company.id, step: step.step_order });
            await new Promise(r => setTimeout(r, 3000));
          } catch (err) {
            logger.error("Errore generazione singola bozza followup", { companyId: company.id, step: step.step_order, error: err.message });
            await new Promise(r => setTimeout(r, 5000));
          }
        }
      } catch (err) {
        logger.error("Errore generazione bozze followup per azienda", { companyId: company.id, error: err.message });
      }
    }

    logger.info("generateFollowUpDrafts completato");
  } catch (err) {
    logger.error("Cron generateFollowUpDrafts error", { error: err.message });
  }
}

export async function processFollowUps() {
  logger.info("Cron: processFollowUps started");

  try {
    // (a) Promuovi gli invii principali pianificati (step = 0) nella coda email.
    // Sequenze/pianificazione automatica: SOLO contatti con consenso marketing (il cold
    // outreach è manuale one-to-one e non passa mai da qui — vedi campaigns.js schedule).
    await query(
      `INSERT INTO email_queue (company_id, campaign_id, status, consent_status, tenant_id)
       SELECT es.company_id, d.campaign_id, 'pending', d.consent_status, d.tenant_id
       FROM email_sequences es
       JOIN companies d ON d.id = es.company_id
       WHERE es.step = 0 AND es.scheduled_at <= NOW()
         AND es.sent_at IS NULL AND es.cancelled_at IS NULL
         AND d.approvato = true AND d.bozza_creata = true
         AND (d.inviato = false OR d.inviato IS NULL)
         AND d.unsubscribed_at IS NULL
         AND d.consent_status = 'marketing'
       ON CONFLICT (company_id) WHERE status IN ('pending','sending') DO NOTHING`
    );
    await query(
      `UPDATE email_sequences SET sent_at = NOW()
       WHERE step = 0 AND scheduled_at <= NOW() AND sent_at IS NULL AND cancelled_at IS NULL
         AND EXISTS (SELECT 1 FROM companies d WHERE d.id = email_sequences.company_id
           AND d.approvato = true AND d.bozza_creata = true
           AND (d.inviato = false OR d.inviato IS NULL)
           AND d.unsubscribed_at IS NULL
           AND d.consent_status = 'marketing')`
    );

    // (b) Follow-up reali (step >= 1) — usano bozze per-azienda da company_followup_drafts.
    // Anche qui: solo marketing, i cold non entrano mai in sequenze automatiche.
    const sequences = await query(
      `SELECT es.*, d.id AS company_id,
              d.campaign_id, d.email, d.nome_studio, d.nome_azienda, d.title, d.consent_status, d.tenant_id,
              dfd.subject, dfd.body, dfd.approvato AS draft_approvato, dfd.generato,
              fs.step_order, fs.is_active AS template_active
       FROM email_sequences es
       JOIN companies d ON d.id = es.company_id AND d.has_replied = false AND d.unsubscribed_at IS NULL
         AND d.consent_status = 'marketing'
       LEFT JOIN company_followup_drafts dfd ON dfd.company_id = es.company_id AND dfd.step_order = es.step
       LEFT JOIN followup_sequences fs ON fs.campaign_id = d.campaign_id AND fs.step_order = es.step
       WHERE es.step > 0
         AND es.scheduled_at <= NOW()
         AND es.sent_at IS NULL
         AND es.cancelled_at IS NULL
       ORDER BY es.scheduled_at
       LIMIT 10`
    );

    for (const row of sequences.rows) {
      try {
        checkMemory();

        // Salta se il template non è più attivo
        if (row.template_active === false) {
          logger.warn("Follow-up template disattivato, sequenza cancellata", { id: row.id, step: row.step });
          await query(
            "UPDATE email_sequences SET cancelled_at = NOW(), cancel_reason = 'template_inactive' WHERE id = $1",
            [row.id]
          );
          continue;
        }

        // Salta se il template è stato rimosso
        if (!row.step_order) {
          logger.warn("Follow-up template non esiste più, sequenza cancellata", { id: row.id, step: row.step });
          await query(
            "UPDATE email_sequences SET cancelled_at = NOW(), cancel_reason = 'template_deleted' WHERE id = $1",
            [row.id]
          );
          continue;
        }

        // Bozza non ancora generata → skip, tornerà al prossimo tick
        if (!row.generato || !row.subject || !row.body) {
          logger.info("Follow-up bozza non ancora generata, riprovo al prossimo tick", { companyId: row.company_id, step: row.step });
          continue;
        }

        // Bozza non approvata → skip, tornerà al prossimo tick
        if (!row.draft_approvato) {
          logger.info("Follow-up bozza non approvata, riprovo al prossimo tick", { companyId: row.company_id, step: row.step });
          continue;
        }

        // Check per-tenant: attivazione e quota giornaliera
        if (row.tenant_id) {
          try {
            const { isTenantActive, getTenantQuota } = await import("../services/tenants.js");
            const isActive = await isTenantActive(row.tenant_id);
            if (!isActive) {
              logger.warn("Follow-up: tenant disattivato", { companyId: row.company_id, tenantId: row.tenant_id });
              await query(
                "UPDATE email_sequences SET cancelled_at = NOW(), cancel_reason = 'tenant_inactive' WHERE id = $1",
                [row.id]
              );
              continue;
            }

            const quota = await getTenantQuota(row.tenant_id);
            if (quota && quota > 0) {
              const todayTenant = await query(
                "SELECT COUNT(*)::int AS c FROM companies WHERE tenant_id = $1 AND inviato_at >= ((NOW() AT TIME ZONE 'Europe/Rome')::date) AT TIME ZONE 'Europe/Rome'",
                [row.tenant_id]
              );
              if (todayTenant.rows[0].c >= quota) {
                logger.info("Follow-up: limite giornaliero quota tenant raggiunto", { tenantId: row.tenant_id, quota });
                continue;
              }
            }
          } catch (err) {
            logger.error("Follow-up: errore verifica per-tenant attivazione/quota", { companyId: row.company_id, tenantId: row.tenant_id, error: err.message });
            continue;
          }
        }

        const { getSmtpForCampaign } = await import("../services/smtp-router.js");
        const smtpAccount = await getSmtpForCampaign(row.campaign_id);
        if (!smtpAccount) {
          logger.warn("Follow-up: nessun account SMTP disponibile", { companyId: row.company_id });
          continue;
        }

        const company = {
          id: row.company_id,
          email: row.email,
          nome_studio: row.nome_studio,
          nome_azienda: row.nome_azienda,
          title: row.title,
          consent_status: row.consent_status,
          bozza_email: "",
          bozza_email_oggetto: "",
        };

        const campQ = await query("SELECT * FROM campaigns WHERE id = $1", [row.campaign_id]).catch(() => ({ rows: [null] }));
        const campaign = campQ.rows[0] || null;

        // Usa la bozza per-azienda invece del template condiviso
        const result = await sendFollowUpEmail(company, smtpAccount, { subject: row.subject, body: row.body, step_order: row.step }, campaign);
        if (result) {
          await query(
            "UPDATE email_sequences SET sent_at = NOW() WHERE id = $1",
            [row.id]
          );
          logger.info("Follow-up inviato (ad personam)", { companyId: row.company_id, step: row.step });
        } else {
          const seq = await query("SELECT COALESCE(retry_count, 0) AS retry_count FROM email_sequences WHERE id = $1", [row.id]);
          const retryCount = (seq.rows[0]?.retry_count || 0) + 1;
          if (retryCount >= 3) {
            await query(
              "UPDATE email_sequences SET cancelled_at = NOW(), cancel_reason = 'send_failed' WHERE id = $1 AND sent_at IS NULL AND cancelled_at IS NULL",
              [row.id]
            );
            logger.error("Follow-up invio fallito dopo 3 tentativi, sequenza cancellata", { companyId: row.company_id, step: row.step });
          } else {
            await query(
              "UPDATE email_sequences SET retry_count = $1, scheduled_at = NOW() + INTERVAL '1 hour' WHERE id = $2",
              [retryCount, row.id]
            );
            logger.warn("Follow-up invio fallito, riprogrammato tra 1 ora (tentativo " + retryCount + "/3)", { companyId: row.company_id, step: row.step });
          }
        }

        await new Promise(r => setTimeout(r, 3000));
      } catch (err) {
        logger.error("Follow-up processing error", { id: row.id, error: err.message });
        await new Promise(r => setTimeout(r, 5000));
      }
    }
  } catch (err) {
    logger.error("Cron processFollowUps error", { error: err.message });
  }
}

async function logFailedEmail(queueId, companyId, provincia, error) {
  try {
    await query(
      `INSERT INTO email_queue_failed (queue_id, company_id, provincia, error)
       VALUES ($1, $2, $3, $4)`,
      [queueId, companyId, provincia, error]
    );
  } catch (err) {
    logger.error("Failed to log dead-letter", { queueId, error: err.message });
  }
}

export async function retryFailedEmails() {
  logger.info("Cron: retryFailedEmails started");
  let client;
  try {
    client = await getClient();
    await client.query("BEGIN");
    const failed = await client.query(
      `SELECT eqf.*, eq.send_context, d.tenant_id
       FROM email_queue_failed eqf
       LEFT JOIN email_queue eq ON eq.id = eqf.queue_id
       JOIN companies d ON d.id = eqf.company_id
       WHERE eqf.retry_count < 3
         AND (eqf.last_retry_at IS NULL OR eqf.last_retry_at < NOW() - INTERVAL '1 hour')
       LIMIT 5
       FOR UPDATE OF eqf SKIP LOCKED`
    );

    for (const item of failed.rows) {
      checkMemory();
      // Blocca anche la riga azienda per evitare race condition
      const companyCheck = await client.query("SELECT inviato FROM companies WHERE id = $1 FOR UPDATE", [item.company_id]);
      if (companyCheck.rows.length > 0 && companyCheck.rows[0].inviato) {
        await client.query("DELETE FROM email_queue_failed WHERE id = $1", [item.id]);
        logger.info("Retry skipped: company already sent", { failedId: item.id, companyId: item.company_id });
        continue;
      }
      const insertResult = await client.query(
        `INSERT INTO email_queue (company_id, provincia, status, send_context, tenant_id) VALUES ($1, $2, 'pending', COALESCE($3, 'automatic'), $4)
         ON CONFLICT (company_id) WHERE status IN ('pending', 'sending') DO NOTHING`,
        [item.company_id, item.provincia, item.send_context, item.tenant_id]
      );
      if (insertResult.rowCount > 0) {
        await client.query(
          `UPDATE email_queue_failed SET retry_count = retry_count + 1, last_retry_at = NOW() WHERE id = $1`,
          [item.id]
        );
        logger.info("Re-queued failed email", { failedId: item.id, companyId: item.company_id });
      } else {
        await client.query(
          `UPDATE email_queue_failed SET retry_count = retry_count + 1, last_retry_at = NOW() WHERE id = $1`,
          [item.id]
        );
        logger.warn("Retry skipped: already in queue, incremented retry_count", { failedId: item.id, companyId: item.company_id });
      }
    }
    await client.query("COMMIT");
  } catch (err) {
    if (client) { try { await client.query("ROLLBACK"); } catch (_) { logger.debug("ROLLBACK fallito in retryFailedEmails"); } }
    logger.error("Cron retryFailedEmails error", { error: err.message });
  } finally {
    if (client) { try { client.release(); } catch (_) {} }
  }
}

export async function processEmailQueue(delayOverride) {
  logger.info("Cron: processEmailQueue started");

  try {
    const window = await isWithinSendWindow();
    if (!window.allowed) {
      logger.info("Invio sospeso: fuori finestra", { reason: window.reason });
      return;
    }

    // Budget giornaliero CONVISO (condiviso): marketing e cold one-to-one consumano lo
    // stesso contatore, così il cold non può aggirare il limite 'max_emails_per_day'.
    const dispatch = await getDailyDispatchState();
    if (isDailyCapReached(dispatch)) {
      logger.info("Limite giornaliero raggiunto, processEmailQueue skip", { sent: dispatch.sentToday, max: dispatch.maxDaily });
      return;
    }

    await query(
      `UPDATE email_queue SET status = 'pending', error = 'recovered after timeout'
       WHERE status = 'sending' AND processed_at < NOW() - INTERVAL '30 minutes'`
    );

    const bounceRateMax = parseFloat(getSetting("guardrail_bounce_rate_max") || "5");
    if (bounceRateMax < 100) {
      const bounceRate = await query(
        `SELECT CASE WHEN COUNT(*) > 0
           THEN ROUND(COUNT(*) FILTER (WHERE email_bounced)::numeric / COUNT(*) * 100, 1)
           ELSE 0 END AS rate
         FROM companies WHERE inviato = true AND inviato_at > NOW() - INTERVAL '30 days'`
      );
      if (bounceRate.rows[0].rate > bounceRateMax) {
        logger.warn("Guardrail: bounce rate superato", { rate: bounceRate.rows[0].rate, max: bounceRateMax });
        return;
      }
    }

    const batchSize = parseInt(getSetting("queue_batch_size") || process.env.QUEUE_BATCH_SIZE || "5", 10);

    let queueItems;
    let queueIds;
    const client = await getClient();
    let released = false;
    try {
      await client.query("BEGIN");
      queueItems = await client.query(
        `SELECT eq.id AS queue_id, d.id, d.email, d.nome_studio, d.nome_azienda,
       d.bozza_email, d.bozza_email_oggetto, d.approvato, d.bozza_creata,
        d.inviato, d.provincia, d.campaign_id, d.consent_status,
        eq.send_context
         FROM email_queue eq
         JOIN companies d ON d.id = eq.company_id
         WHERE eq.status = 'pending'
         AND d.unsubscribed_at IS NULL
         ORDER BY eq.created_at
         LIMIT $1
         FOR UPDATE OF eq SKIP LOCKED`,
        [batchSize]
      );
      if (queueItems.rows.length === 0) {
        await client.query("ROLLBACK");
        client.release();
        released = true;
        return;
      }
      queueIds = queueItems.rows.map(r => r.queue_id);
      await client.query(
        `UPDATE email_queue SET status = 'sending', processed_at = NOW() WHERE id = ANY($1)`,
        [queueIds]
      );
      await client.query("COMMIT");
      client.release();
      released = true;
    } catch (err) {
      if (!released) {
        try { await client.query("ROLLBACK"); } catch (_) { logger.debug("ROLLBACK fallito in sendFollowUpEmail"); }
        client.release();
        released = true;
      }
      throw err;
    }



    let sent = 0;
    let failed = 0;

    for (const company of queueItems.rows) {
      try {
        checkMemory();

        if (!company.bozza_creata || !company.approvato || company.inviato || !company.email || company.unsubscribed_at) {
          const errMsg = !company.email ? "Email mancante" : company.unsubscribed_at ? "Disiscritto" : "Non pronto";
          await logFailedEmail(company.queue_id, company.id, company.provincia, errMsg);
          await query(
            "UPDATE email_queue SET status = 'failed', error = $2 WHERE id = $1",
            [company.queue_id, errMsg]
          );
          failed++;
          continue;
        }

        // Re-check company state fresco (dati JOIN possono essere stale dopo il commit)
        const freshCheck = await query(
          "SELECT id, approvato, bozza_creata, inviato, email, unsubscribed_at, consent_status FROM companies WHERE id = $1",
          [company.id]
        );
        if (!freshCheck.rows[0] || !freshCheck.rows[0].bozza_creata || !freshCheck.rows[0].approvato || freshCheck.rows[0].inviato || !freshCheck.rows[0].email || freshCheck.rows[0].unsubscribed_at) {
          const errMsg = !freshCheck.rows[0]?.email ? "Email mancante" : freshCheck.rows[0]?.unsubscribed_at ? "Disiscritto" : "Stato cambiato";
          await logFailedEmail(company.queue_id, company.id, company.provincia, errMsg);
          await query(
            "UPDATE email_queue SET status = 'failed', error = $2 WHERE id = $1",
            [company.queue_id, errMsg]
          );
          failed++;
          continue;
        }

        // Usa il consenso fresco (post-commit) per la barriera finale in email-sender.
        if (freshCheck.rows[0]?.consent_status) company.consent_status = freshCheck.rows[0].consent_status;

        // ── Gate di schedulazione freddi-vs-consensati (send-schedule) ──
        // Determina il contesto di invio dall'elemento in coda (default 'automatic').
        // In folle/schedulazione automatica passano SOLO i 'marketing'; un contatto
        // cold viene ammesso esclusivamente dal flusso one-to-one manuale (send_context='manual').
        const schedCtx = resolveSendContext({
          send_context: company.send_context,
          consent_status: company.consent_status,
          campaign_id: company.campaign_id,
        });
        const schedGate = enforceSchedulingConsent({
          consent_status: company.consent_status,
          context: schedCtx.context,
        });
        if (!schedGate.ok) {
          logger.warn("Scheduling consenso: invio bloccato (cold fuori dal flusso automatico)", {
            companyId: company.id, status: schedGate.status, context: schedGate.context,
          });
          await logFailedEmail(company.queue_id, company.id, company.provincia, schedGate.reason);
          await query(
            "UPDATE email_queue SET status = 'failed', error = $2 WHERE id = $1",
            [company.queue_id, schedGate.reason]
          );
          failed++;
          continue;
        }

        // Check per-campaign daily limit
        if (company.campaign_id) {
          try {
            const campLimit = await query(
              "SELECT daily_email_limit FROM campaigns WHERE id = $1", [company.campaign_id]
            );
            const limit = campLimit.rows[0]?.daily_email_limit;
            if (limit && limit > 0) {
              const todayCamp = await query(
                "SELECT COUNT(*)::int AS c FROM companies WHERE campaign_id = $1 AND inviato_at >= ((NOW() AT TIME ZONE 'Europe/Rome')::date) AT TIME ZONE 'Europe/Rome'",
                [company.campaign_id]
              );
              if (todayCamp.rows[0].c >= limit) {
                logger.info("Limite giornaliero campagna raggiunto", { campaign_id: company.campaign_id, limit });
                await query(
                  "UPDATE email_queue SET status = 'pending', error = 'limite giornaliero campagna' WHERE id = $1",
                  [company.queue_id]
                );
                continue;
              }
            }
          } catch (_) { logger.debug("Errore secondario queue processing", { companyId: company.id }); }
        }

        // Check per-tenant: attivazione e quota giornaliera
        if (company.tenant_id) {
          try {
            const { isTenantActive, getTenantQuota } = await import("../services/tenants.js");
            const isActive = await isTenantActive(company.tenant_id);
            if (!isActive) {
              logger.warn("Tenant disattivato: invio bloccato", { companyId: company.id, tenantId: company.tenant_id });
              await query(
                "UPDATE email_queue SET status = 'pending', error = 'tenant disattivato' WHERE id = $1",
                [company.queue_id]
              );
              continue;
            }

            const quota = await getTenantQuota(company.tenant_id);
            if (quota && quota > 0) {
              const todayTenant = await query(
                "SELECT COUNT(*)::int AS c FROM companies WHERE tenant_id = $1 AND inviato_at >= ((NOW() AT TIME ZONE 'Europe/Rome')::date) AT TIME ZONE 'Europe/Rome'",
                [company.tenant_id]
              );
              if (todayTenant.rows[0].c >= quota) {
                logger.info("Limite giornaliero quota tenant raggiunto", { tenantId: company.tenant_id, quota });
                await query(
                  "UPDATE email_queue SET status = 'pending', error = 'limite giornaliero quota tenant' WHERE id = $1",
                  [company.queue_id]
                );
                continue;
              }
            }
          } catch (err) {
            logger.error("Errore verifica per-tenant attivazione/quota", { companyId: company.id, tenantId: company.tenant_id, error: err.message });
            await query("UPDATE email_queue SET status = 'pending', error = $2 WHERE id = $1", [company.queue_id, "Errore verifica tenant: " + err.message]);
            continue;
          }
        }

        let smtpAccount = null;
        try {
          const { getSmtpForCampaign } = await import("../services/smtp-router.js");
          smtpAccount = await getSmtpForCampaign(company.campaign_id);
          if (!smtpAccount) {
            // Nessun account SMTP disponibile — rimetti in coda
            await query(
              "UPDATE email_queue SET status = 'pending', error = 'nessun account SMTP disponibile' WHERE id = $1",
              [company.queue_id]
            );
            logger.info("Nessun account SMTP disponibile, rimandato in coda", { queue_id: company.queue_id });
            continue;
          }
        } catch (err) {
          logger.error("SMTP account selection error", { error: err.message, queue_id: company.queue_id });
          await query("UPDATE email_queue SET status = 'pending', error = $2 WHERE id = $1", [company.queue_id, "Errore selezione SMTP: " + err.message]);
          continue;
        }

        // CMS agent-first: integrazione best-effort, nessun blocco qui. Le note di
        // invio/engagement vengono scritte dopo il commit della transazione.

        // Carica la vera campagna: serve a sendCampaignEmail per use_html,
        // html_wrapper, footer, reply-to, firma SMTP della campagna e {{cta_link}}.
        let campaign = null;
        if (company.campaign_id) {
          const cRes = await query("SELECT * FROM campaigns WHERE id = $1", [company.campaign_id]);
          campaign = cRes.rows[0] || null;
        }
        const { getClient } = await import("../db.js");
        const txClient = await getClient();
        try {
          await txClient.query("BEGIN");
          const trackingId = await sendCampaignEmail(company, smtpAccount, campaign, txClient.query.bind(txClient), { consentContext: schedCtx.context });
          if (!trackingId) {
            await txClient.query("ROLLBACK");
            try { txClient.release(); } catch (_) {}
            const errMsg = "Send failed";
            if (smtpAccount?.id) await query("UPDATE smtp_accounts SET sent_today = GREATEST(sent_today - 1, 0) WHERE id = $1", [smtpAccount.id]);
            await logFailedEmail(company.queue_id, company.id, company.provincia, errMsg);
            await query(
              "UPDATE email_queue SET status = 'failed', error = $2 WHERE id = $1",
              [company.queue_id, errMsg]
            );
            failed++;
            continue;
          }

          sent++;
          await txClient.query(
            "UPDATE email_queue SET status = 'sent', processed_at = NOW(), smtp_account_id = $2 WHERE id = $1",
            [company.queue_id, smtpAccount?.id || null]
          );
          await txClient.query(
            `UPDATE companies SET inviato = true, inviato_at = NOW(), tracking_id = $2, updated_at = NOW()
             WHERE id = $1`,
            [company.id, trackingId]
          );
          await txClient.query(
            "INSERT INTO email_tracking (id, company_id, smtp_account_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
            [trackingId, company.id, smtpAccount?.id || null]
          );
          const sequences = await txClient.query(
            "SELECT step_order, delay_days FROM followup_sequences WHERE campaign_id = $1 AND is_active = true ORDER BY step_order",
            [company.campaign_id]
          );
          if (sequences.rows.length > 0) {
            for (const s of sequences.rows) {
              const delayDays = parseInt(s.delay_days, 10);
              if (isNaN(delayDays) || delayDays < 0) continue;
              await txClient.query(
                "INSERT INTO email_sequences (company_id, step, scheduled_at) VALUES ($1, $2, (NOW() AT TIME ZONE 'Europe/Rome')::timestamp AT TIME ZONE 'Europe/Rome' + ($3 || ' days')::INTERVAL)",
                [company.id, s.step_order, String(delayDays)]
              );
            }
          }
          await txClient.query("COMMIT");
          try { txClient.release(); } catch (_) {}

          // Trigger generazione bozze followup per-azienda dopo invio principale
          if (company.campaign_id && sequences.rows.length > 0) {
            const { generateFollowUpDrafts } = await import("./cron.js");
            generateFollowUpDrafts([company.id], company.campaign_id).catch(e =>
              logger.warn("Generazione followup post-invio fallita", { companyId: company.id, error: e.message })
            );
          }
        } catch (txErr) {
          await txClient.query("ROLLBACK").catch((rollbackErr) => {
            logger.error("Transaction ROLLBACK failed", { error: rollbackErr.message });
          });
          txClient.release();
          throw txErr;
        }

        // CMS: nota di invio + aggiornamento opportunità se stage "email inviata"
        try {
          await addNote(config.cmsSiteId, company.email,
            `📧 Email inviata: ${company.bozza_email_oggetto || ''}\n\n${(company.bozza_email || '').substring(0, 500)}`);
        } catch (_) { logger.debug("Errore CMS addNote (email inviata)", { companyId: company.id }); }

        const delay = parseInt(getSetting("queue_delay_seconds") || delayOverride || "3", 10);
        await new Promise(r => setTimeout(r, delay * 1000));
      } catch (err) {
        logger.error("Queue processing item error", { id: company.queue_id, error: err.message });
        await logFailedEmail(company.queue_id, company.id, company.provincia, err.message);
        await query(
          "UPDATE email_queue SET status = 'failed', error = $2, processed_at = NOW() WHERE id = $1",
          [company.queue_id, err.message]
        );
        failed++;
        await new Promise(r => setTimeout(r, 3000));
      }
    }

    logger.info("Cron: processEmailQueue completed", { sent, failed });
  } catch (err) {
    logger.error("Cron processEmailQueue error", { error: err.message });
  }
}

export async function processCmsSync() {
  logger.info("Cron: processCmsSync started");
  try {
    const companies = await query(
      `SELECT * FROM companies WHERE (cms_synced_at IS NULL)
       AND email IS NOT NULL AND email != ''
       ORDER BY (campaign_id IS NOT NULL) DESC, id
       LIMIT 50`
    );
    if (companies.rows.length === 0) {
      logger.info("Cron: processCmsSync — nessun azienda da sincronizzare col CMS");
      return;
    }
    let synced = 0;
    for (const d of companies.rows) {
      try {
        checkMemory();
        const consentStatus = await syncCompanyWithCms(d);
        if (consentStatus) synced++;
      } catch (err) { logger.warn("Errore CMS sync per azienda", { id: d.id, error: err.message }); }
    }
    logger.info("Cron: processCmsSync completed", { synced });
  } catch (err) {
    logger.error("Cron processCmsSync error", { error: err.message });
  }
}

router.post("/api/cron/process-municipalities", requireAuth, requireAdmin, async (req, res) => {
  try {
    const ok = await withLock("municipality", async () => {
      await processMunicipalities();
      await query(
        `INSERT INTO audit_log (user_id, action, resource, details)
         VALUES ($1, 'cron_process_municipalities', 'cron', '{}')`,
        [req.user.sub]
      );
    }, 600);
    if (!ok) return res.status(409).json({ error: "Processamento già in esecuzione" });
    res.json({ success: true });
  } catch (err) {
    logger.error("Cron route error", { route: "process-municipalities", error: err.message });
    res.status(500).json({ error: err.message });
  }
});

router.post("/admin/process-municipalities", requireAuth, requireAdmin, async (req, res) => {
  try {
    const ok = await withLock("municipality", async () => {
      await processMunicipalities();
      await query(
        `INSERT INTO audit_log (user_id, action, resource, details)
         VALUES ($1, 'cron_process_municipalities', 'cron', '{}')`,
        [req.user.sub]
      );
    }, 600);
    if (!ok) return res.redirect("/dashboard?error=lock_busy");
    res.redirect("/dashboard");
  } catch (err) {
    logger.error("Cron route error", { route: "admin-process-municipalities", error: err.message });
    res.redirect("/dashboard?error=internal");
  }
});

router.post("/api/cron/generate-emails", requireAuth, requireAdmin, async (req, res) => {
  try {
    const ok = await withLock("emailDraft", async () => {
      await generateEmailDrafts();
      await query(
        `INSERT INTO audit_log (user_id, action, resource, details)
         VALUES ($1, 'cron_generate_emails', 'cron', '{}')`,
        [req.user.sub]
      );
    }, 600);
    if (!ok) return res.status(409).json({ error: "Generazione email già in esecuzione" });
    res.json({ success: true });
  } catch (err) {
    logger.error("Cron route error", { route: "generate-emails", error: err.message });
    res.status(500).json({ error: err.message });
  }
});

router.post("/admin/generate-emails", requireAuth, requireAdmin, async (req, res) => {
  try {
    const ok = await withLock("emailDraft", async () => {
      await generateEmailDrafts();
      await query(
        `INSERT INTO audit_log (user_id, action, resource, details)
         VALUES ($1, 'cron_generate_emails', 'cron', '{}')`,
        [req.user.sub]
      );
    }, 600);
    if (!ok) return res.redirect("/dashboard?error=lock_busy");
    res.redirect("/dashboard");
  } catch (err) {
    logger.error("Cron route error", { route: "admin-generate-emails", error: err.message });
    res.redirect("/dashboard?error=internal");
  }
});

router.get("/api/admin/cron-status", requireAuth, requireAdmin, async (req, res) => {
  try {
    const [activeLocks, lastRunsDb] = await Promise.all([
      query("SELECT name FROM app_locks WHERE locked_at > NOW() - INTERVAL '10 minutes' ORDER BY name"),
      query("SELECT name, last_run_at FROM cron_status ORDER BY name"),
    ]);
    const lastRuns = {};
    lastRunsDb.rows.forEach(r => { lastRuns[r.name] = r.last_run_at; });
    Object.entries(Object.fromEntries(lastRunTimes)).forEach(([k, v]) => { lastRuns[k] = v; });
    res.json({
      active: activeLocks.rows.map(r => r.name),
      lastRuns,
    });
  } catch (err) {
    console.error("Cron status error", err);
    res.status(500).json({errorKey: "error.load_status" });
  }
});

router.post("/api/cron/cleanup", requireAuth, requireAdmin, async (req, res) => {
  try {
    const ok = await withLock("cleanup", async () => {
      await cleanupErrors();
      await query(
        `INSERT INTO audit_log (user_id, action, resource, details)
         VALUES ($1, 'cron_cleanup', 'cron', '{}')`,
        [req.user.sub]
      );
    }, 300);
    if (!ok) return res.status(409).json({ error: "Pulizia già in esecuzione" });
    res.json({ success: true });
  } catch (err) {
    logger.error("Cron route error", { route: "cleanup", error: err.message });
    res.status(500).json({ error: err.message });
  }
});

router.get("/admin/queue", async (req, res) => {
  try {
    res.render("admin/queue");
  } catch (err) {
    res.status(500).render("error", {messageKey: "error.load_queue" });
  }
});

router.get("/api/admin/queue", requireAuth, requireAdmin, async (req, res) => {
  try {
    const tab = req.query.tab || 'pending';
    let items;
    if (tab === 'failed') {
      const result = await query(
        `SELECT eqf.*, d.title, d.nome_studio, d.nome_azienda
         FROM email_queue_failed eqf LEFT JOIN companies d ON d.id = eqf.company_id
         ORDER BY eqf.last_retry_at DESC NULLS LAST LIMIT 100`
      );
      items = result.rows;
    } else {
      const statusFilter = tab === 'all' ? ['pending', 'sending', 'sent'] : [tab];
      const result = await query(
        `SELECT eq.*, d.title, d.nome_studio, d.nome_azienda
         FROM email_queue eq LEFT JOIN companies d ON d.id = eq.company_id
         WHERE eq.status = ANY($1)
         ORDER BY eq.created_at DESC LIMIT 100`,
        [statusFilter]
      );
      items = result.rows;
    }
    res.json({ items });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete("/api/admin/queue/:id", requireAuth, requireAdmin, async (req, res) => {
  try {
    const result = await query("DELETE FROM email_queue WHERE id = $1", [req.params.id]);
    if (result.rowCount === 0) {
      await query("DELETE FROM email_queue_failed WHERE id = $1", [req.params.id]);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/api/cron/retry-failed", requireAuth, requireAdmin, async (req, res) => {
  try {
    const ok = await withLock("retryFailed", retryFailedEmails, 120);
    res.json({ success: ok, message: ok ? "Riprocessate" : "Già in esecuzione" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── CMS: Retry automatico note/engagement falliti ──
export async function processCmsEngagementSync() {
  logger.info("Cron: processCmsEngagementSync started");
  try {
    const candidates = await query(
      `SELECT d.id, d.email, d.nome_studio, d.inviato, d.inviato_at, d.email_opened_at, d.email_clicked_at
       FROM companies d
       WHERE d.email IS NOT NULL AND d.email != ''
         AND (d.inviato = true OR d.email_opened_at IS NOT NULL OR d.email_clicked_at IS NOT NULL)
         AND d.cms_synced_at IS NOT NULL
       ORDER BY d.id
       LIMIT 30`
    );
    if (candidates.rows.length === 0) {
      logger.info("Cron: processCmsEngagementSync — nessun candidato");
      return;
    }
    let synced = 0, errors = 0;
    for (const d of candidates.rows) {
      try {
        const stato = [];
        if (d.inviato) stato.push("inviata");
        if (d.email_opened_at) stato.push("aperta");
        if (d.email_clicked_at) stato.push("cliccata");
        await addNote(config.cmsSiteId, d.email,
          `✉️ Stato email: ${stato.join(", ") || "inviata"} (esito tracciato dal servizio outreach)`);
        synced++;
      } catch (e) {
        errors++;
        logger.error("Cron: processCmsEngagementSync error", { companyId: d.id, error: e.message });
      }
    }
    logger.info("Cron: processCmsEngagementSync completato", { synced, errors });
  } catch (e) {
    logger.error("Cron: processCmsEngagementSync fallito", { error: e.message });
  }
}

export default router;
