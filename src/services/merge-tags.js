export function applyMergeTags(text, company, campaign) {
  return text
    .replace(/\{\{nome_studio\}\}/gi, company.nome_studio || company.title || "")
    .replace(/\{\{nome_azienda\}\}/gi, company.nome_azienda || "")
    .replace(/\{\{comune\}\}/gi, company.comune || "")
    .replace(/\{\{provincia\}\}/gi, company.provincia || "")
    .replace(/\{\{email\}\}/gi, company.email || "")
    .replace(/\{\{cta_link\}\}/gi, (campaign && campaign.link_cta) || "");
}
