import { Router } from "express";
import { query } from "../db.js";
import { logger } from "../services/logger.js";
import { authorize } from "../middleware/authorize.js";

const router = Router();

// Cartelle IMAP supportate
const IMAP_FOLDERS = ["INBOX", "INBOX.Sent"];

// GET /admin/imap/:accountId — Pagina visualizzazione posta
router.get("/admin/imap/:accountId(\\d+)", authorize('admin', 'read'), async (req, res) => {
  try {
    const accountId = parseInt(req.params.accountId, 10);
    const folder = req.query.folder || "INBOX";
    if (!IMAP_FOLDERS.includes(folder)) {
      return res.status(400).send("Cartella IMAP non valida");
    }
    const acc = await query("SELECT * FROM smtp_accounts WHERE id = $1", [accountId]);
    if (acc.rows.length === 0) return res.status(404).send("Account non trovato");
    const account = acc.rows[0];
    if (!account.imap_host || !account.imap_user || !account.imap_pass) {
      return res.render("admin/imap", { account, messages: [], folder, error: "IMAP non configurato per questo account" });
    }

    const { ImapFlow } = await import("imapflow");
    const imapPort = account.imap_port || 993;
    const client = new ImapFlow({
      host: account.imap_host,
      port: imapPort,
      secure: imapPort === 993,
      auth: { user: account.imap_user, pass: account.imap_pass },
      logger: false,
      connectionTimeout: 10000,
      socketTimeout: 20000,
    });

    await client.connect();
    const lock = await client.getMailboxLock(folder);
    let messages = [];
    try {
      // Recupera ultimi 40 messaggi (dal più recente)
      for await (const msg of client.fetch("1:*", {
        uid: true,
        envelope: true,
        flags: true,
        internalDate: true,
        source: true,
        bodyStructure: true,
      }, { uid: true })) {
        const from = msg.envelope.from?.[0];
        const to = msg.envelope.to?.[0];
        const date = msg.envelope.date || msg.internalDate;
        messages.push({
          uid: msg.uid,
          subject: msg.envelope.subject || "(nessun oggetto)",
          fromName: from?.name || "",
          fromEmail: from?.address || "",
          toName: to?.name || "",
          toEmail: to?.address || "",
          date: date ? date.toISOString() : null,
          seen: msg.flags?.has("\\Seen") || false,
          flagged: msg.flags?.has("\\Flagged") || false,
          snippets: [],
        });

        if (messages.length >= 40) break;
      }

      // Inverti per ordine cronologico (più recenti prima)
      messages.reverse();
    } finally {
      lock.release();
      await Promise.race([client.logout(), new Promise((_, r) => setTimeout(r, 5000))]);
    }

    res.render("admin/imap", { account, messages, folder, error: null });
  } catch (err) {
    logger.error("IMAP view error", { error: err.message });
    res.render("admin/imap", { account: { id: 0, name: "Errore" }, messages: [], folder: "INBOX", error: "Errore di connessione: " + err.message });
  }
});

// GET /admin/imap/:accountId/raw/:uid — Legge il body completo di un messaggio
router.get("/admin/imap/:accountId(\\d+)/raw/:uid(\\d+)", authorize('admin', 'read'), async (req, res) => {
  try {
    const accountId = parseInt(req.params.accountId, 10);
    const uid = parseInt(req.params.uid, 10);
    const folder = req.query.folder || "INBOX";
    if (!IMAP_FOLDERS.includes(folder)) {
      return res.status(400).json({ error: "Cartella IMAP non valida" });
    }
    const acc = await query("SELECT * FROM smtp_accounts WHERE id = $1", [accountId]);
    if (acc.rows.length === 0) return res.status(404).json({ error: "Account non trovato" });
    const account = acc.rows[0];
    if (!account.imap_host) return res.status(400).json({ error: "IMAP non configurato" });

    const { ImapFlow } = await import("imapflow");
    const imapPort = account.imap_port || 993;
    const client = new ImapFlow({
      host: account.imap_host,
      port: imapPort,
      secure: imapPort === 993,
      auth: { user: account.imap_user, pass: account.imap_pass },
      logger: false,
      connectionTimeout: 10000,
      socketTimeout: 20000,
    });

    await client.connect();
    const lock = await client.getMailboxLock(folder);
    let bodyText = "";
    let htmlText = "";
    let subject = "";
    let fromName = "";
    let fromEmail = "";
    let date = null;
    try {
      for await (const msg of client.fetch(`${uid}`, {
        uid: true,
        envelope: true,
        source: true,
        bodyStructure: true,
        headers: true,
      }, { uid: true })) {
        if (!msg) break;
        subject = msg.envelope?.subject || "";
        fromName = msg.envelope?.from?.[0]?.name || "";
        fromEmail = msg.envelope?.from?.[0]?.address || "";
        date = msg.internalDate?.toISOString() || null;

        // Cerca il azienda mittente per mostrare anche l'email originale inviata
        let originalCompany = null;
        if (fromEmail) {
          const companyRow = await query(
            `SELECT nome_azienda, nome_studio, bozza_email_oggetto, bozza_email, inviato_at
             FROM companies WHERE LOWER(email) = LOWER($1) AND inviato = true
             LIMIT 1`,
            [fromEmail]
          ).catch(() => ({ rows: [] }));
          if (companyRow.rows[0]) {
            originalCompany = {
              name: companyRow.rows[0].nome_azienda || companyRow.rows[0].nome_studio || null,
              subject: companyRow.rows[0].bozza_email_oggetto || null,
              body: companyRow.rows[0].bozza_email || null,
              sentAt: companyRow.rows[0].inviato_at || null,
            };
          }
        }

        // Estrai body text dal source
        const source = msg.source;
        if (source) {
          const raw = source.toString();
          // Prova a estrarre testo semplice e html
          const textMatch = raw.match(/Content-Type:\s*text\/plain[^]*?(?=\n--|\nContent-|$)/is);
          const htmlMatch = raw.match(/Content-Type:\s*text\/html[^]*?(?=\n--|\nContent-|$)/is);
          if (textMatch) {
            bodyText = textMatch[0].replace(/^.*?\n\n/, '').replace(/\r\n/g, '\n').trim();
          }
          if (htmlMatch) {
            htmlText = htmlMatch[0].replace(/^.*?\n\n/, '').replace(/\r\n/g, '\n').trim();
          }
          // Fallback: tutto il source
          if (!bodyText && !htmlText) {
            bodyText = raw.substring(0, 5000);
          }
        }
      }
    } finally {
      lock.release();
      await Promise.race([client.logout(), new Promise((_, r) => setTimeout(r, 5000))]);
    }

    res.json({ uid, subject, fromName, fromEmail, date, bodyText, htmlText, originalCompany });
  } catch (err) {
    logger.error("IMAP raw error", { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

export default router;
