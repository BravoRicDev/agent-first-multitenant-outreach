import { query } from "../db.js";
import { logger } from "./logger.js";

async function loadLastUid(accountId) {
  try {
    const res = await query("SELECT last_uid FROM imap_state WHERE account_id = $1", [accountId]);
    return res.rows[0]?.last_uid || 0;
  } catch (err) {
    logger.error("Errore caricamento UID da DB", { accountId, error: err.message });
    return 0;
  }
}

async function saveLastUid(accountId, uid) {
  try {
    await query(
      "INSERT INTO imap_state (account_id, last_uid) VALUES ($1, $2) ON CONFLICT (account_id) DO UPDATE SET last_uid = $2, updated_at = NOW()",
      [accountId, uid]
    );
  } catch (err) {
    logger.error("Errore salvataggio UID su DB", { accountId, error: err.message });
  }
}

export async function checkReplies(smtpAccount) {
  if (!smtpAccount.imap_host || !smtpAccount.imap_user || !smtpAccount.imap_pass) {
    logger.warn("IMAP config mancante per account", { accountId: smtpAccount.id });
    return;
  }
  const { ImapFlow } = await import("imapflow");
  let retries = 3;
  let client;
  while (retries > 0) {
    try {
      const imapPort = smtpAccount.imap_port || 993;
      client = new ImapFlow({
        host: smtpAccount.imap_host,
        port: imapPort,
        secure: imapPort === 993,
        auth: { user: smtpAccount.imap_user, pass: smtpAccount.imap_pass },
        logger: false,
        connectionTimeout: 10000,
        socketTimeout: 15000,
      });
      await client.connect();
      break;
    } catch (err) {
      retries--;
      if (retries === 0) throw err;
      logger.warn("Connessione IMAP fallita, retry...", { accountId: smtpAccount.id, retriesLeft: retries, error: err.message });
      await new Promise(r => setTimeout(r, 5000));
    }
  }
  const lock = await client.getMailboxLock("INBOX");
  try {
    const sinceUid = await loadLastUid(smtpAccount.id);
    if (sinceUid === 0) {
      // Prima esecuzione: salva UID massimo senza processare messaggi storici
      const status = await client.status("INBOX", { uidNext: true });
      const initialUid = (status.uidNext || 1) - 1;
      if (initialUid > 0) await saveLastUid(smtpAccount.id, initialUid);
      logger.info("IMAP first run: seed UID salvato", { accountId: smtpAccount.id, uid: initialUid });
      return;
    }
    let maxUid = sinceUid;
    const fetchOpts = { uid: true, envelope: true, headers: ["in-reply-to", "references", "auto-submitted", "x-autoreply", "precedence"] };
    for await (const msg of client.fetch(`${sinceUid + 1}:*`, fetchOpts, { uid: true })) {
      if (msg.uid <= sinceUid) continue;
      maxUid = Math.max(maxUid, msg.uid);
      const fromEmail = msg.envelope.from?.[0]?.address?.toLowerCase();
      if (!fromEmail) continue;
      // Skip auto-replies (out-of-office, bounces, etc.)
      const hdr = (msg.headers || Buffer.alloc(0)).toString().toLowerCase();
      const isAuto = hdr.includes("auto-submitted: auto-replied") || hdr.includes("x-autoreply") || hdr.includes("precedence: auto_reply") || hdr.includes("precedence: bulk");
      const isReply = hdr.includes("in-reply-to:") || hdr.includes("references:");
      if (isAuto) continue;
      if (!isReply) continue;
      const d = await query(
        "SELECT id, email, nome_studio, nome_azienda, campaign_id, tenant_id FROM companies WHERE LOWER(email) = $1 AND has_replied = false LIMIT 1",
        [fromEmail]
      );
      if (d.rows.length === 0) continue;
      const company = d.rows[0];
      await query(
        "UPDATE companies SET has_replied = true, replied_at = NOW(), reply_subject = $1 WHERE id = $2 AND tenant_id =$3)",
        [msg.envelope.subject || '', company.id, company.tenant_id]
      );
      await query(
        "UPDATE email_sequences SET cancelled_at = NOW(), cancel_reason = 'replied' WHERE company_id = $1 AND sent_at IS NULL AND cancelled_at IS NULL",
        [company.id]
      );
      // CMS agent-first: al primo segno di interesse (has_replied) il lead entra nel CRM CMS
      // creando/aggiornando un'opportunità nella pipeline della campagna. Best-effort,
      // mai bloccante: se il CMS non è configurato o fallisce, si prosegue comunque.
      try {
        const { ensureOpportunityForReply } = await import("./cms.js");
        await ensureOpportunityForReply(company);
      } catch (_) {}
    }
    await saveLastUid(smtpAccount.id, maxUid);
  } finally {
    try { lock && lock.release(); } catch (_) {}
    try { await Promise.race([client.logout(), new Promise((_, r) => setTimeout(r, 5000))]); } catch (_) {}
  }
}
