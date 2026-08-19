import { query } from "../db.js";
import { logger } from "./logger.js";

function calculateScore(company) {
  let score = 0;
  if (company.email) score += 15;
  if (company.nome_studio || company.nome_azienda) score += 10;
  if (company.descrizione && company.descrizione.length > 100) score += 10;
  if (company.website) score += 5;
  if (company.rating) {
    const r = parseFloat(company.rating);
    if (r >= 4.5) score += 10;
    else if (r >= 3.5) score += 5;
    if (company.rating_count && parseInt(company.rating_count, 10) > 10) score += 5;
  }
  if (company.phone_number) score += 5;
  if (company.bozza_email) score += 10;
  if (company.approvato) score += 5;
  if (company.inviato) score += 5;
  if (company.email_opened_at) score += 10;
  if (company.email_clicked_at) score += 10;
  return score;
}

export async function updateScores(ids) {
  // Cron di sistema globale: calcola lead_score per una lista di ID.
  // Scoping NON applicato: i dati sono già filtrati dal caller (cron) per tenant specifico se necessario.
  // Gli ID passati sono presumibilmente predelettuti dal contesto della campagna/tenant del cron.
  try {
    const companies = await query("SELECT * FROM companies WHERE id = ANY($1::int[])", [ids]);
    const cases = companies.rows.filter(d => d.id != null && Number.isInteger(Number(d.id))).map(d => {
      const score = Math.max(0, Math.floor(Number(calculateScore(d)) || 0));
      return `WHEN ${d.id} THEN ${score}`;
    });
    if (cases.length > 0) {
      await query(`UPDATE companies SET lead_score = CASE id ${cases.join(' ')} ELSE lead_score END WHERE id = ANY($1::int[])`, [ids]);
    }
  } catch (err) {
    logger.error("updateScores error", { error: err.message });
  }
}
