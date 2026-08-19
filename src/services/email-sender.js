import crypto from "crypto";
import nodemailer from "nodemailer";
import config from "../config.js";
import { logger } from "./logger.js";
import { getSetting } from "./settings.js";
import { applyMergeTags } from "./merge-tags.js";
import { auditInvioRegola } from "./audit.js";
import { resolveTestRecipient } from "./test-mode.js";

function makeUnsubToken(id) {
  const sig = crypto.createHmac("sha256", config.jwtSecret).update(String(id)).digest("hex").slice(0, 16);
  return `${id}.${sig}`;
}

function getTrackingBase() {
  return getSetting("magic_link_base_url") || config.magicLinkBaseUrl;
}

/**
 * Contraffazione consenso (freddi vs consensati) applicata PRIMA di ogni invio.
 * - Se `consent_channels` è NULL/assente → comportamento IDENTICO a oggi (retro-compatibilità):
 *   - 'marketing'   → procedi
 *   - 'cold'        → bloccato in automatico; passa SOLO dal flusso one-to-one manuale
 * - Se `consent_channels` presente (per-canale):
 *   - `consent_channels.email === true` → ammesso (base: consent o legitimate_interest)
 *   - Altrimenti → bloccato (default rigido: canale non esplicitamente consentito = bloccato)
 * Registra audit 'invio_regola' con: motivo, canale (email), base giuridica, provenienza (cms/manual).
 */
export function enforceConsent(company, { consentContext = "automatic", campaignId = null } = {}) {
  const status = company?.consent_status || "cold";
  const consentChannels = company?.consent_channels;
  const consentBasis = company?.consent_basis || "legitimate_interest";
  let admitted, reason;

  if (consentChannels !== null && consentChannels !== undefined && typeof consentChannels === 'object') {
    const emailConsented = consentChannels.email === true;
    if (emailConsented) {
      admitted = true;
      reason = `consenso email per canale presente (base: ${consentBasis}) — invio ammesso`;
    } else {
      admitted = false;
      reason = `email non consentita nei canali (base: ${consentBasis}, default rigido) — invio bloccato`;
    }
  } else {
    if (status === "marketing") {
      admitted = true;
      reason = "consenso marketing presente — invio ammesso";
    } else if (consentContext === "manual") {
      admitted = true;
      reason = "cold in flusso one-to-one manuale — invio ammesso";
    } else {
      admitted = false;
      reason = "cold in contesto automatico (campagna/sequenza) — invio bloccato";
    }
  }

  auditInvioRegola({
    companyId: company?.id,
    queueId: company?.queue_id,
    campaignId,
    consentStatus: status,
    consentChannels,
    consentBasis,
    context: consentContext,
    admitted,
    reason,
  });

  if (admitted) {
    if (consentContext === "manual" && status === "cold") {
      logger.info("Invio consentito: cold in flusso one-to-one manuale", {
        companyId: company?.id, consent_status: status, consentContext,
      });
    } else if (consentChannels && consentChannels.email === true) {
      logger.info("Invio consentito: canale email consentito", {
        companyId: company?.id, consentBasis, consentChannels,
      });
    }
    return { ok: true, status, reason };
  }
  logger.warn("Invio bloccato: contatto cold in contesto automatico (campagna/sequenza)", {
    companyId: company?.id, consent_status: status, consentContext,
  });
  return { ok: false, status, reason };
}

export async function sendCampaignEmail(company, smtpAccount, campaign, txQuery, options = {}) {
  try {
    // Consenso: verifica PRIMA di ogni invio (barriera finale di sicurezza).
    const consentContext = options.consentContext || "automatic";
    const consent = enforceConsent(company, { consentContext, campaignId: campaign?.id });
    if (!consent.ok) return null;

    if (!company.email) throw new Error("Email azienda mancante");
    if (!smtpAccount) throw new Error("Account SMTP non fornito");

    // Modalità test (requisito 7): barriera finale, sempre valutata PRIMA di
    // costruire/inviare il messaggio. In test_mode l'invio o è deviato verso un
    // destinatario di test, o è bloccato — mai verso il destinatario reale.
    // Test_mode è attivo se globale OR per-tenant.
    const testRecipient = await resolveTestRecipient(company.email, company.tenant_id);
    if (testRecipient.blocked) {
      logger.warn("Invio bloccato: test_mode attivo senza destinatari di test configurati", { companyId: company.id, tenantId: company.tenant_id });
      return null;
    }

    const trackingId = crypto.randomUUID();

    let body = company.bozza_email || "";
    let subject = company.bozza_email_oggetto || "";
    const useHtml = campaign?.use_html === true;
    const htmlWrapper = campaign?.html_wrapper || getSetting("default_html_wrapper") || DEFAULT_HTML_WRAPPER;
    const footerText = campaign?.footer_text || getSetting("default_footer_text");
    const footerHtml = campaign?.footer_html || getSetting("default_footer_html");

    const campData = campaign || {};
    body = applyMergeTags(body, company, campData);
    subject = applyMergeTags(subject, company, campData);
    if (testRecipient.diverted) subject = `[TEST] ${subject}`;

    let smtpSignature = null;
    if (campaign?.smtp_account_id) {
      const { query } = await import("../db.js");
      const sa = await query("SELECT firma_testo, firma_html FROM smtp_accounts WHERE id = $1", [campaign.smtp_account_id]);
      if (sa.rows[0]) smtpSignature = sa.rows[0];
    }
    if (!smtpSignature) {
      const globalFirma = getSetting("default_firma_testo");
      if (globalFirma) smtpSignature = { firma_testo: globalFirma, firma_html: getSetting("default_firma_html") };
    }
    if (smtpSignature?.firma_testo) body += "\n\n" + smtpSignature.firma_testo;

    const unsubUrl = `${getTrackingBase()}/unsubscribe/${makeUnsubToken(company.id)}`;

    const openPixel = `${getTrackingBase()}/track/open/${trackingId}`;

    let html = null;
    let text = body;

    function rewriteLinks(htmlContent) {
      return htmlContent.replace(
        /<a\s+([^>]*?)href\s*=\s*["']([^"']+)["']/gi,
        (match, attrs, url) => {
          if (url.includes("/unsubscribe/") || url.includes("/track/")) return match;
          const encodedUrl = encodeURIComponent(url);
          return `<a ${attrs}href="${getTrackingBase()}/track/click/${trackingId}?url=${encodedUrl}"`;
        }
      );
    }

    if (useHtml) {
      const bodyHtml = body.replace(/\n/g, "<br>");
      html = (htmlWrapper || DEFAULT_HTML_WRAPPER).replace("{{BODY}}", bodyHtml);
      if (footerHtml) html = html.replace("</body>", footerHtml + "</body>");
      if (smtpSignature?.firma_html) html = html.replace("</body>", smtpSignature.firma_html + "</body>");
      html = html.replaceAll("{{UNSUB_URL}}", unsubUrl);
      html = html.replace("</body>", `<img src="${openPixel}" width="1" height="1" alt="" style="display:none;"></body>`);
      html = rewriteLinks(html);
    } else {
      if (footerText) text += "\n\n" + footerText.replace("{{UNSUB_URL}}", unsubUrl);
      text = text.replaceAll("{{UNSUB_URL}}", unsubUrl);
      html = text.replace(/\n/g, "<br>") +
        `<br><br><img src="${openPixel}" width="1" height="1" alt="" style="display:none;">`;
    }

    const transporter = nodemailer.createTransport({
      host: smtpAccount.smtp_host,
      port: parseInt(smtpAccount.smtp_port, 10) || 465,
      secure: parseInt(smtpAccount.smtp_port, 10) === 465,
      requireTLS: parseInt(smtpAccount.smtp_port, 10) === 587,
      auth: {
        user: smtpAccount.smtp_user,
        pass: smtpAccount.smtp_pass,
      },
      tls: { rejectUnauthorized: config.nodeEnv === 'production' },
    });

    const fromName = campaign?.from_name_override || smtpAccount.from_name || config.brand.defaultFromName;
    const fromEmail = campaign?.from_email_override || smtpAccount.from_email || smtpAccount.smtp_user;
    const replyTo = campaign?.reply_to_email;

    const mailOptions = {
      from: `${fromName} <${fromEmail}>`,
      to: testRecipient.to,
      subject,
      text,
      html,
      headers: {},
    };
    if (replyTo) mailOptions.headers["Reply-To"] = replyTo;
    if (testRecipient.diverted) mailOptions.headers["X-Test-Original-To"] = company.email;

    await transporter.sendMail(mailOptions);
    logger.info("Email campaign inviata", { companyId: company.id, trackingId, subject, testMode: testRecipient.diverted });
    transporter.close();

    // Salva l'esatto contenuto inviato (usa txQuery se disponibile per atomicità)
    const db = txQuery || (await import("../db.js")).query;
    await db(
      "UPDATE companies SET sent_email_subject = $1, sent_email_body = $2 WHERE id = $3 AND tenant_id =$4)",
      [subject, text || body, company.id, company.tenant_id]
    ).catch(err => logger.warn("Salvataggio sent_email fallito", { companyId: company.id, error: err.message }));

    // "Fotografia" del consenso al momento dell'invio: sovrascrive email_queue.consent_status
    // in modo da registrare lo stato esatto (cold/marketing) che ha permesso/ammesso l'invio.
    if (company.queue_id) {
      await db(
        "UPDATE email_queue SET consent_status = $2 WHERE id = $1 AND status IN ('sent','sending') AND tenant_id =$3)",
        [company.queue_id, company.consent_status || "cold", company.tenant_id]
      ).catch(err => logger.warn("Aggiornamento consent_status su email_queue fallito", { queueId: company.queue_id, error: err.message }));
    }

    // Salva copia nella cartella INBOX.Sent via IMAP (sempre fuori transazione)
    if (smtpAccount?.imap_host && smtpAccount?.imap_user && smtpAccount?.imap_pass) {
      saveToImapSent(smtpAccount, fromName, fromEmail, testRecipient.to, subject, text, html)
        .catch(err => logger.warn("Salvataggio IMAP.Sent fallito", { companyId: company.id, error: err.message }));
    }

    return trackingId;
  } catch (err) {
    logger.error("sendCampaignEmail fallito", { companyId: company.id, error: err.message });
    return null;
  }
}

export async function sendFollowUpEmail(company, smtpAccount, options, campaign) {
  try {
    // Consenso: verifica PRIMA di ogni invio (follow-up = contesto automatico sequenza).
    const consent = enforceConsent(company, { consentContext: "automatic", campaignId: campaign?.id });
    if (!consent.ok) return null;

    if (!options?.subject || !options?.body) {
      logger.warn("Follow-up template mancante", { companyId: company.id });
      return null;
    }

    // Modalità test (requisito 7): stessa barriera finale di sendCampaignEmail.
    const testRecipient = await resolveTestRecipient(company.email, company.tenant_id);
    if (testRecipient.blocked) {
      logger.warn("Follow-up bloccato: test_mode attivo senza destinatari di test configurati", { companyId: company.id, tenantId: company.tenant_id });
      return null;
    }

    const trackingId = crypto.randomUUID();

    let body = options.body;
    let subject = options.subject;

    let smtpSignature = null;
    if (campaign?.smtp_account_id) {
      const { query } = await import("../db.js");
      const sa = await query("SELECT firma_testo, firma_html FROM smtp_accounts WHERE id = $1", [campaign.smtp_account_id]);
      if (sa.rows[0]) smtpSignature = sa.rows[0];
    }
    if (!smtpSignature) {
      const globalFirma = getSetting("default_firma_testo");
      if (globalFirma) smtpSignature = { firma_testo: globalFirma, firma_html: null };
    }

    const campData = campaign || {};
    body = applyMergeTags(body, company, campData);
    subject = applyMergeTags(subject, company, campData);
    if (testRecipient.diverted) subject = `[TEST] ${subject}`;
    if (smtpSignature?.firma_testo) body += "\n\n" + smtpSignature.firma_testo;

    const unsubUrl = `${getTrackingBase()}/unsubscribe/${makeUnsubToken(company.id)}`;
    const footerText = getSetting("default_footer_text");
    if (footerText) body += "\n\n" + footerText.replace("{{UNSUB_URL}}", unsubUrl);
    else body += `\n\nPer non ricevere più email: ${unsubUrl}`;
    body = body.replaceAll("{{UNSUB_URL}}", unsubUrl);

    const openPixel = `${getTrackingBase()}/track/open/${trackingId}`;
    const html = body.replace(/\n/g, "<br>") +
      `<br><br><img src="${openPixel}" width="1" height="1" alt="" style="display:none;">`;

    const transporter = nodemailer.createTransport({
      host: smtpAccount.smtp_host,
      port: parseInt(smtpAccount.smtp_port, 10) || 465,
      secure: parseInt(smtpAccount.smtp_port, 10) === 465,
      auth: { user: smtpAccount.smtp_user, pass: smtpAccount.smtp_pass },
      tls: { rejectUnauthorized: config.nodeEnv === 'production' },
    });

    const fromName = smtpAccount.from_name || config.brand.defaultFromName;
    const fromEmail = smtpAccount.from_email || smtpAccount.smtp_user;

    const followUpMailOptions = {
      from: `${fromName} <${fromEmail}>`,
      to: testRecipient.to,
      subject,
      text: body,
      html,
    };
    if (testRecipient.diverted) followUpMailOptions.headers = { "X-Test-Original-To": company.email };

    await transporter.sendMail(followUpMailOptions);
    logger.info("Follow-up inviato", { companyId: company.id, trackingId, testMode: testRecipient.diverted });
    transporter.close();

    // Salva l'esatto contenuto inviato (con merge tag risolti e firma) in company_followup_drafts
    const { query } = await import("../db.js");
    if (options.step_order !== undefined) {
      await query(
        `UPDATE company_followup_drafts SET sent_subject = $1, sent_body = $2, sent_at = NOW(), updated_at = NOW()
         WHERE company_id = $3 AND step_order = $4`,
        [subject, body, company.id, options.step_order]
      ).catch(err => logger.warn("Salvataggio sent followup in company_followup_drafts fallito", { companyId: company.id, step: options.step_order, error: err.message }));
    }

    // Salva contenuto inviato nel DB (tabella companies)
    await query(
      "UPDATE companies SET sent_email_subject = $1, sent_email_body = $2 WHERE id = $3 AND tenant_id =$4)",
      [subject, body, company.id, company.tenant_id]
    ).catch(err => logger.warn("Salvataggio sent_email followup fallito", { companyId: company.id, error: err.message }));

    // Salva copia in IMAP.Sent
    if (smtpAccount?.imap_host && smtpAccount?.imap_user && smtpAccount?.imap_pass) {
      saveToImapSent(smtpAccount, fromName, fromEmail, testRecipient.to, subject, body, html)
        .catch(err => logger.warn("Salvataggio IMAP.Sent followup fallito", { companyId: company.id, error: err.message }));
    }

    return trackingId;
  } catch (err) {
    logger.error("sendFollowUpEmail fallito", { companyId: company.id, error: err.message });
    return null;
  }
}

// ── Salva copia nella cartella IMAP.Sent ──
async function saveToImapSent(smtpAccount, fromName, fromEmail, toEmail, subject, textBody, htmlBody) {
  const { ImapFlow } = await import("imapflow");
  const imapPort = smtpAccount.imap_port || 993;
  const client = new ImapFlow({
    host: smtpAccount.imap_host,
    port: imapPort,
    secure: imapPort === 993,
    auth: { user: smtpAccount.imap_user, pass: smtpAccount.imap_pass },
    logger: false,
    connectionTimeout: 10000,
    socketTimeout: 15000,
  });
  try {
    await client.connect();

    // Costruisce il raw MIME message
    const boundary = "outlook-boundary-" + Date.now().toString(16);
    const date = new Date().toUTCString();
    let raw = `From: ${fromName} <${fromEmail}>\r\n`;
    raw += `To: ${toEmail}\r\n`;
    raw += `Subject: ${subject}\r\n`;
    raw += `Date: ${date}\r\n`;
    raw += `MIME-Version: 1.0\r\n`;
    raw += `Content-Type: multipart/alternative; boundary="${boundary}"\r\n`;
    raw += `\r\n`;
    raw += `--${boundary}\r\n`;
    raw += `Content-Type: text/plain; charset=utf-8\r\n`;
    raw += `Content-Transfer-Encoding: quoted-printable\r\n`;
    raw += `\r\n${textBody || ""}\r\n`;
    if (htmlBody) {
      raw += `--${boundary}\r\n`;
      raw += `Content-Type: text/html; charset=utf-8\r\n`;
      raw += `Content-Transfer-Encoding: quoted-printable\r\n`;
      raw += `\r\n${htmlBody}\r\n`;
    }
    raw += `--${boundary}--\r\n`;

    await client.append("INBOX.Sent", raw, ["\\Seen"], new Date());
    logger.info("Copia salvata in IMAP.Sent", { to: toEmail, subject });
  } catch (err) {
    logger.warn("saveToImapSent fallito", { error: err.message, to: toEmail });
  } finally {
    try { await client.logout(); } catch (_) {}
  }
}

const DEFAULT_HTML_WRAPPER = `<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<style>body{font-family:Arial,sans-serif;font-size:14px;line-height:1.6;color:#222;max-width:600px;margin:0 auto;padding:20px;}</style>
</head><body>
<div style="padding:20px;">{{BODY}}</div>
<hr style="border:none;border-top:1px solid #eee;margin:24px 0;">
<p style="font-size:12px;color:#999;">Hai ricevuto questa email perché il tuo studio è tra i migliori della zona.
<a href="{{UNSUB_URL}}" style="color:#999;">Cancellati</a></p>
</body></html>`;
