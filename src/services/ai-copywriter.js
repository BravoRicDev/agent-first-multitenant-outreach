import config from "../config.js";
import { callOpenRouter } from "./openrouter.js";
import { logger } from "./logger.js";
import { getSetting } from "./settings.js";

export const COPYWRITER_PROMPT = `Sei un copywriter B2B esperto in outreach a freddo. Il tuo compito e' scrivere il contenuto di un'email commerciale rivolta al potenziale cliente (prospect) i cui dati ti verranno forniti in input sotto forma di JSON.

OBIETTIVO:
Generare il testo di un'email che catturi l'attenzione del prospect in modo professionale e sufficientemente generico per adattarsi alla sua realtà lavorativa, proponendo i nostri servizi in modo naturale e orientato ai benefici.

DATI DI INPUT:
- INFO_AZIENDA: descrizione dell'azienda mittente (chi siamo, cosa facciamo). Usala come contesto.
- EMAIL_SPUNTI: esempi di email che hanno funzionato. Questa è la FONTE PRINCIPALE da cui partire per tono, argomento e struttura dell'email.
- EMAIL_TEMPLATE_BOZZA: (opzionale) struttura suggerita per l'email. Se presente, usala come guida strutturale. Se ASSENTE, crea tu la struttura basandoti sugli spunti.
- CTA: la call to action da includere nell'email.
- LINK_CTA: il link della call to action. È l'UNICO link che puoi usare nell'email. Non inventare, modificare o creare URL diverse.
- nome_studio_aziendale, nome_azienda, descrizione, website: dati del destinatario. Usali per personalizzare.

IMPORTANTE: EMAIL_SPUNTI ha la priorità su EMAIL_TEMPLATE_BOZZA in caso di conflitto. Gli spunti rappresentano la campagna attuale e il suo messaggio. Il template è solo una struttura di supporto.

REGOLE DI SCRITTURA E FORMATTAZIONE:
1. Personalizzazione generica: Analizza il JSON in input. Usa i dati (es. nome_studio_aziendale) per contestualizzare il messaggio, ma mantieni il testo sufficientemente ampio e focalizzato sulle dinamiche del settore anziché su dettagli iper-specifici.
2. NESSUN RIFERIMENTO GEOGRAFICO: E' tassativamente vietato inserire nel corpo dell'email l'indirizzo, la città, la via, la provincia o la regione dello studio. Non menzionare in alcun modo la posizione fisica.
3. Stile: Mantieni il tono e il livello di formalità. Dai priorità al valore offerto allo studio.
4. Contenuto: Tratta parole generiche come "Azienda" come segnaposto, sostituendole con il nome o la categoria corretta ricavata dai dati.
5. Conclusione: Includi SEMPRE una Call to Action chiara con il link CTA fornito. La CTA e il LINK_CTA devono essere obbligatoriamente presenti nell'email.
6. Nessuna firma: NON firmare l'email e non inserire i saluti aziendali finali.
7. Solo testo piatto: Il contenuto dell'email deve essere ESCLUSIVAMENTE testo piatto (plain text). ASSOLUTAMENTE NESSUNA formattazione (niente markdown, niente asterischi per il grassetto, niente HTML).
8. Nessuna verbosità: L'output deve contenere solo il JSON richiesto.
9. Lunghezza: meno di 1000 parole totali.
10. LINK_CTA OBBLIGATORIO: La CTA con il LINK_CTA deve essere SEMPRE inclusa nell'email. È OBBLIGATORIO inserire il link esatto del campo LINK_CTA alla fine del contenuto. Non inventare, modificare, accorciare o creare URL diverse. Non generare link a pagine di opt-in, webinar, ebook o altre risorse che non corrispondano esattamente al LINK_CTA ricevuto.

FORMATO DI OUTPUT RIGIDO:
Il sistema richiede un output esclusivamente in formato JSON valido.
Genera la risposta utilizzando esattamente questa struttura:
{
  "oggetto": "Inserisci qui l'oggetto dell'email",
  "contenuto": "Inserisci qui il corpo dell'email in puro testo piatto senza firma"
}`;

export async function generateEmail(company, direzione, campaignPrompt) {
  logger.info("AI Copywriter generazione email", { companyId: company.id, nome: company.nome_studio });

  const userMessage = JSON.stringify({
    nome_studio_aziendale: company.nome_studio,
    nome_azienda: company.nome_azienda || company.nome_studio || '',
    descrizione: company.descrizione,
    website: company.website,
    INFO_AZIENDA: direzione.info_azienda,
    CTA: direzione.cta,
    LINK_CTA: direzione.link_cta,
    EMAIL_SPUNTI: direzione.email_spunti,
    EMAIL_TEMPLATE_BOZZA: (direzione.email_template_bozza || '')
      .replace(/\{\{nome_studio\}\}/gi, company.nome_studio || '')
      .replace(/\{\{nome_azienda\}\}/gi, company.nome_azienda || '')
      .replace(/\{\{comune\}\}/gi, company.comune || '')
      .replace(/\{\{provincia\}\}/gi, company.provincia || ''),
  });

  const messages = [
    { role: "system", content: getCopywriterPrompt(campaignPrompt) },
    { role: "user", content: userMessage },
  ];

  let content;
  try {
    content = await callOpenRouter(getSetting("openrouter_model_copywriter") || config.openrouterModelCopywriter, messages, {
      topP: 0.5,
      temperature: 0.8,
    });
  } catch (err) {
    logger.error("OpenRouter copywriter fallito", { error: err.message });
    return null;
  }

  if (!content || !content.trim()) {
    logger.error("AI copywriter: output vuoto", { content });
    return null;
  }
  try {
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No JSON found in response");
    const parsed = JSON.parse(jsonMatch[0]);
    const oggetto = (parsed.oggetto || "").trim();
    let contenuto = (parsed.contenuto || "").trim();
    if (!oggetto && !contenuto) {
      logger.error("AI copywriter: output vuoto", { content });
      return null;
    }
    return { oggetto, contenuto };
  } catch {
    logger.error("Parse copywriter output fallito", { content });
    return null;
  }
}

export const REWRITE_PROMPT = `Sei un copywriter B2B esperto. Il tuo compito è RISCIVERE un'email esistente seguendo le istruzioni fornite.

REGOLE:
1. Mantieni il tono professionale e la struttura generale.
2. Non inserire riferimenti geografici.
3. Nessuna firma aziendale.
4. Solo testo piatto (plain text), niente markdown o HTML.
5. La lunghezza deve rimanere sotto le 1000 parole.
6. L'email DEVE includere la Call to Action aziendale fornita.

FORMATO DI OUTPUT RIGIDO (solo JSON valido):
{
  "oggetto": "Nuovo oggetto",
  "contenuto": "Nuovo contenuto in puro testo piatto"
}`;

function getCopywriterPrompt(campaignPrompt) {
  return campaignPrompt || getSetting("prompt_copywriter") || COPYWRITER_PROMPT;
}
function getRewritePrompt(campaignRewritePrompt) {
  return campaignRewritePrompt || getSetting("prompt_rewrite") || REWRITE_PROMPT;
}

export async function rewriteEmail(currentOggetto, currentBody, instructions, company, direzione, campaignRewritePrompt) {
  logger.info("AI Copywriter riscrittura email", { companyId: company.id });

  const userMessage = JSON.stringify({
    email_attuale_oggetto: currentOggetto,
    email_attuale_corpo: currentBody,
    istruzioni_riscrittura: instructions,
    nome_studio_aziendale: company.nome_studio,
    nome_azienda: company.nome_azienda || company.nome_studio || '',
    descrizione: company.descrizione,
    INFO_AZIENDA: direzione.info_azienda,
    CTA: direzione.cta,
    LINK_CTA: direzione.link_cta,
  });

  const messages = [
    { role: "system", content: getRewritePrompt(campaignRewritePrompt) },
    { role: "user", content: userMessage },
  ];

  let content;
  try {
    content = await callOpenRouter(getSetting("openrouter_model_copywriter") || config.openrouterModelCopywriter, messages, {
      topP: 0.5,
      temperature: 0.7,
    });
  } catch (err) {
    logger.error("OpenRouter rewrite fallito", { error: err.message });
    return null;
  }

  if (!content || !content.trim()) {
    logger.error("AI rewrite: output vuoto");
    return null;
  }
  try {
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No JSON found in response");
    const parsed = JSON.parse(jsonMatch[0]);
    return {
      oggetto: parsed.oggetto || currentOggetto,
      contenuto: parsed.contenuto || currentBody,
    };
  } catch {
    logger.error("Parse rewrite output fallito", { content });
    return null;
  }
}

// ── FOLLOW-UP COPYWRITER ──

export const FOLLOWUP_COPYWRITER_PROMPT = `Sei un copywriter B2B esperto in sequenze di follow-up email per outreach a freddo.

Il tuo compito e' scrivere il contenuto di un'email di FOLLOW-UP che prosegua la conversazione iniziata con la prima email già inviata al potenziale cliente.

OBIETTIVO:
Scrivere un follow-up che NON ripeta i contenuti della prima email ma che:
- Dimostri che abbiamo già contattato lo studio (senza dirlo esplicitamente)
- Offra un nuovo spunto di valore o una prospettiva diversa
- Mantenga un tono professionale ma leggermente più diretto dell'email iniziale
- Includa la Call to Action aziendale (se prevista)
- Dia un senso di progressione naturale nella conversazione

DATI DI INPUT:
- seguente_template: il template/direzione per QUESTO specifico step di follow-up (cosa dire in questo step)
- email_precedente: l'email principale che è già stata inviata (per NON ripeterla)
- INFO_AZIENDA: descrizione dell'azienda mittente
- CTA / LINK_CTA: la call to action
- nome_studio_aziendale, nome_azienda, descrizione, website: dati del destinatario

REGOLE:
1. NON ripetere le stesse frasi o concetti dell'email_precedente
2. Personalizzazione generica: usa i dati del destinatario per contestualizzare
3. NESSUN RIFERIMENTO GEOGRAFICO
4. Conclusione: includi SEMPRE la CTA e il LINK_CTA se forniti
5. Nessuna firma aziendale
6. Solo testo piatto (plain text), niente markdown o HTML
7. Meno di 800 parole
8. LINK_CTA OBBLIGATORIO se fornito — non inventare URL
9. Il tono deve essere un follow-up, non una ri-email: presupponi che la prima sia stata ricevuta

FORMATO DI OUTPUT RIGIDO:
{
  "oggetto": "Oggetto del follow-up",
  "contenuto": "Corpo del follow-up in puro testo piatto"
}`;

export async function generateFollowUpEmail(company, template, emailPrecedenteOggetto, emailPrecedenteCorpo, campagna) {
  logger.info("AI Copywriter generazione followup", { companyId: company.id, step: template.step_order });

  const userMessage = JSON.stringify({
    nome_studio_aziendale: company.nome_studio || '',
    nome_azienda: (company.nome_azienda || company.nome_studio || ''),
    descrizione: company.descrizione || '',
    website: company.website || '',
    INFO_AZIENDA: campagna?.info_azienda || '',
    CTA: campagna?.cta || '',
    LINK_CTA: campagna?.link_cta || '',
    seguente_template: {
      subject: template.subject || '',
      body: template.body || '',
    },
    email_precedente: {
      oggetto: emailPrecedenteOggetto || '',
      corpo: emailPrecedenteCorpo || '',
    },
  });

  const followupPrompt = campagna?.followup_prompt || FOLLOWUP_COPYWRITER_PROMPT;
  const messages = [
    { role: "system", content: followupPrompt },
    { role: "user", content: userMessage },
  ];

  let content;
  try {
    content = await callOpenRouter(getSetting("openrouter_model_copywriter") || config.openrouterModelCopywriter, messages, {
      topP: 0.5,
      temperature: 0.8,
    });
  } catch (err) {
    logger.error("OpenRouter followup fallito", { error: err.message, companyId: company.id });
    return null;
  }

  if (!content || !content.trim()) {
    logger.error("AI followup: output vuoto", { companyId: company.id });
    return null;
  }
  try {
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No JSON found in response");
    const parsed = JSON.parse(jsonMatch[0]);
    const oggetto = (parsed.oggetto || "").trim();
    let contenuto = (parsed.contenuto || "").trim();
    if (!oggetto && !contenuto) {
      logger.error("AI followup: output vuoto", { companyId: company.id });
      return null;
    }
    return { oggetto, contenuto };
  } catch {
    logger.error("Parse followup output fallito", { companyId: company.id, content });
    return null;
  }
}
