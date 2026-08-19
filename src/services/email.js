import nodemailer from "nodemailer";
import config from "../config.js";
import { getSetting } from "../services/settings.js";
import { logger } from "./logger.js";

let transporter = null;
let lastConfig = null;

function getTransporter() {
  const host = getSetting("smtp_host") || config.smtpHost;
  const port = parseInt(getSetting("smtp_port") || config.smtpPort, 10);
  const user = getSetting("smtp_user") || config.smtpUser;
  const pass = getSetting("smtp_pass") || config.smtpPass;

  if (!host) {
    logger.warn("SMTP non configurato, email non funzioneranno");
    return null;
  }

  const currentConfig = `${host}:${port}:${user}:${pass}`;
  if (transporter && currentConfig === lastConfig) return transporter;

  // Chiudi il pool precedente prima di crearne uno nuovo
  if (transporter) {
    transporter.close();
  }
  transporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    requireTLS: port === 587,
    tls: { rejectUnauthorized: config.nodeEnv === 'production' },
    auth: {
      user,
      pass,
    },
  });
  lastConfig = currentConfig;
  return transporter;
}

export async function sendEmail({ to, subject, html, text }) {
  const t = getTransporter();
  if (!t) {
    throw new Error("SMTP non configurato");
  }
  try {
    const from = getSetting("email_from") || config.emailFrom;
    let timeout = false;
    const timeoutPromise = new Promise((_resolve, reject) =>
      setTimeout(() => { timeout = true; reject(new Error("SMTP send timeout")); }, 30000)
    );
    timeoutPromise.catch(() => {}); // evita unhandled rejection se sendMailPromise vince
    const sendMailPromise = t.sendMail({
      from,
      to,
      subject,
      html,
      text,
    });
    try {
      await Promise.race([sendMailPromise, timeoutPromise]);
    } catch (err) {
      if (timeout) {
        sendMailPromise.catch(e =>
          logger.error("SMTP send failed after timeout", { to, subject, error: e.message })
        );
      }
      throw err;
    }
    logger.info("Email inviata", { to, subject });
  } catch (err) {
    logger.error("Errore invio email", { to, subject, error: err.message });
    throw err;
  }
}
