import config from "../config.js";
import { callOpenRouter, callGroq } from "./openrouter.js";
import { logger } from "./logger.js";
import { getSetting } from "./settings.js";

export const VALIDATOR_PROMPT = `Ruolo: Validatore Email B2B / Boolean
Compito: Valutare il testo di un'email commerciale B2B generata (OUTPUT_AI) e restituire esclusivamente true o false in minuscolo, senza virgolette né testo aggiuntivo.

OBIETTIVO
Stabilire se OUTPUT_AI e' un'email di cold outreach sensata, coerente e plausibilmente scritta da un essere umano. L'email deve proporre servizi a un'azienda/studio senza sembrare un'allucinazione, un errore di generazione o una bozza incompleta.

RESTITUZIONE
true => L'email e' coerente, verosimile e potenzialmente pronta per l'invio.
false => L'email e' chiaramente artificiale, contiene errori di generazione, segnaposto non compilati, testo pre-generazione o e' incomprensibile.

BOCCIATURA AUTOMATICA (false)
Restituisci false se l'email presenta ALMENO UNA di queste condizioni:
1. Segnaposto non compilati: Contiene parentesi quadre, graffe o tag non sostituiti (es. [Nome Azienda], [Inserisci Oggetto], {{azienda}}, [Il tuo nome]).
2. Riferimenti espliciti all'IA o convenevoli del bot: Frasi tipiche dei modelli (es. "Come modello linguistico", "Ecco un'opzione", "Certamente, ecco la bozza", "As an AI", "Spero che questa email vada bene").
3. Testo di prova o inutile: "Test", "Lorem ipsum", "Hello world", oppure e' troppo breve per essere un'email strutturata.
4. Fuori contesto: Non e' un'email commerciale B2B, e' composta da codice di programmazione, log tecnici, formattazione markdown (\`\`\`) o e' completamente fuori tema.
5. Errori linguistici gravi: Non e' in italiano (o ha un mix di lingue senza senso logico), contiene grammatica gravemente scorretta o frasi interrotte a metà.
6. Allucinazioni evidenti: Promette cose impossibili o inventa dati palesemente falsi non tipici di una presentazione aziendale.

TOLLERANZE (true)
Restituisci true se l'email:
1. Presenta piccole imperfezioni stilistiche o punteggiatura non perfetta, ma e' comprensibile e fluida.
2. Ha un tono leggermente freddo o standard, ma coerente con un approccio B2B.
3. E' un testo piatto, semplice, ma che svolge il suo ruolo di cold email.

OUTPUT
Devi restituire ESCLUSIVAMENTE una singola parola, senza spazi prima o dopo, senza punteggiatura:
true
oppure
false`;

function getValidatorPrompt() {
  return getSetting("prompt_validator") || VALIDATOR_PROMPT;
}

export async function validateEmail(oggetto, contenuto, maxRetries = 5) {
  const emailText = `OGGETTO: ${oggetto}\nCONTENUTO:\n${contenuto}`;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const result = await callOpenRouter(getSetting("openrouter_model_validator") || config.openrouterModelValidator, [
        { role: "system", content: getValidatorPrompt() },
        { role: "user", content: `OUTPUT_AI:\n${emailText}` },
      ], {
        temperature: 0.1,
        responseFormat: { type: "text" },
        timeout: 30000,
      });

      const cleaned = result.trim().toLowerCase();
      if (cleaned === "true") return true;
      if (cleaned === "false") return false;

      logger.warn("Validatore: output ambiguo, ritento", { attempt, result });
    } catch (err) {
      const isPermanent = err?.status && err.status >= 400 && err.status < 500 && ![408, 429].includes(err.status);

      if (isPermanent) {
        logger.error("Validatore: errore permanente di sistema", { status: err.status });
        throw err;
      }

      logger.error("Validatore primario fallito", { attempt, error: err.message });

      if (attempt < maxRetries) {
        await new Promise(r => setTimeout(r, 5000));
        continue;
      }

      try {
        const groqModel = getSetting("groq_model") || "llama-3.3-70b-versatile";
        const groqResult = await callGroq(groqModel, [
          { role: "system", content: getValidatorPrompt() },
          { role: "user", content: `OUTPUT_AI:\n${emailText}` },
        ], { responseFormat: { type: "text" } });
        const cleaned = groqResult.trim().toLowerCase();
        return cleaned === "true";
      } catch (groqErr) {
        logger.error("Validatore Groq fallito", { error: groqErr.message });
        return false;
      }
    }
  }

  // Fallback a Groq dopo tentativi esauriti (output ambiguo o errori)
  try {
    const groqModel = getSetting("groq_model") || "llama-3.3-70b-versatile";
    const groqResult = await callGroq(groqModel, [
      { role: "system", content: getValidatorPrompt() },
      { role: "user", content: `OUTPUT_AI:\n${emailText}` },
    ], { responseFormat: { type: "text" } });
    const cleaned = groqResult.trim().toLowerCase();
    return cleaned === "true";
  } catch (groqErr) {
    logger.error("Validatore Groq fallito (fallback finale)", { error: groqErr.message });
    return false;
  }
}
