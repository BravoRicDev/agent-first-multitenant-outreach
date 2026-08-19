# DEPLOY-CHECKLIST — outreach-service

> **NATURA DEL SERVIZIO (prima di ogni azione)**: questo servizio è **indipendente e autonomo**
> (deploy, DB e runtime propri: parte e risponde anche senza il CMS collegato), ma è
> **complementare per significato** a un CMS multi-tenant: la sua ragione d'essere è alimentare il CRM
> del CMS (contatti, consenso, opportunità, opt-out), e fare outreach senza quel collegamento
> perde di significato. Per questo, **in produzione va sempre configurato e collegato al CMS**
> via API agent (`CMS_BASE_URL` + `CMS_AGENT_TOKEN` + `CMS_SITE_ID`) — è il motivo d'essere del
> servizio, non un'opzione accessoria. Senza questi tre valori il servizio parte e resta
> operativo, ma degrada a best-effort e non alimenta il CRM del CMS. Se stai deployando,
> assicurati di configurare e testare l'integrazione CMS (sezione 4, e sezione «Modello
> tenant» per la scelta di `CMS_SITE_ID`) — non fermarti al solo boot dell'app.

Checklist di deploy e di verifica dell'integrazione con l'API agent del CMS.
**Nessun segreto è scritto in questo file**: tutti i valori sensibili vanno
compilati a mano nell'ambiente reale (vedi sezione «Valori .env da compilare»).

---

## 1. Contesto

Servizio **mono-tenant**: un'istanza = un sito CMS. La vecchia integrazione
GHL è stata rimossa; l'integrazione con il CMS passa esclusivamente dall'**API
agent** del CMS (`/api/agent/*`), autenticata con un token statico `agtok_...`.

Flusso consenso (freddi vs consensati):
- `consent_status = 'marketing'` → campagne/sequenze automatiche.
- `consent_status = 'cold'` → solo flusso one-to-one esplicito (B2B + UNSUB + daily cap).
- Opt-out condiviso: `unsubscribe` aggiorna sia la blacklist locale sia il CMS
  (`setContactOptOut`), così il contatto non viene più reinserito da nessuna parte.

### 1.1 Modello tenant / Tenancy model

- **Outreach = single-tenant per istanza**: un deploy = un `CMS_SITE_ID` (sezione 2), collegato
  a un solo sito del CMS.
- **CMS = multi-tenant**: un unico deploy CMS serve più siti (`site_id` proprio ciascuno,
  endpoint agent scoping per sito).
- **Per N siti CMS → N deploy/istanze outreach** (una per `CMS_SITE_ID`), ognuna con il proprio
  `.env`, DB e (se serve) proprio SMTP. Non esiste oggi un modo di far gestire più siti a una
  sola istanza: sarebbe un'estensione futura del servizio (fuori scopo di questo deploy).
- Il bridge `src/services/cms.js` è già pronto per il multi-tenant a livello di funzioni
  (accettano `siteId`); il single-tenant è solo una scelta di configurazione (`CMS_SITE_ID`).

```
site_id=1 (Sito A)       ← deploy outreach A (CMS_SITE_ID=1, DB "outreach_a")
site_id=2 (Sito B)       ← deploy outreach B (CMS_SITE_ID=2, DB "outreach_b")
site_id=3 (Sito C)       ← deploy outreach C (CMS_SITE_ID=3, DB "outreach_c")
```

---

## 2. Valori `.env` da compilare (nessun segreto reale qui)

Compilare nell'ambiente di deploy (non versionare mai il file `.env`):

| Variabile            | Descrizione                                                                 | Esempio (placeholder)          |
|----------------------|-----------------------------------------------------------------------------|--------------------------------|
| `PORT`               | Porta HTTP del servizio                                                     | `3098`                         |
| `NODE_ENV`           | `production` in deploy                                                      | `production`                   |
| `DATABASE_URL`       | `postgres://UTENTE:***@HOST:PORT/DB` (mono-tenant)                     | `postgres://outreach:***@db:5432/outreach` |
| `DB_PASSWORD`        | Password DB (per init script)                                               | `changeme`                     |
| `JWT_SECRET`         | Generare casuale (64 byte hex), NON committare                               | `genera_un_secret_casuale_con_64_byte_hex` |
| `JWT_EXPIRES_IN`     | Scadenza JWT                                                               | `24h`                          |
| `CMS_BASE_URL`       | Base URL del CMS multi-tenant                                                            | `https://cms.example.com`       |
| `CMS_AGENT_TOKEN`    | Token statico `agtok_...` generato da `/admin/api-tokens` sul CMS (scoped all'utente/sito collegato) | `agtok_...` |
| `CMS_SITE_ID`        | ID del sito CMS da collegare                                                | `1`                            |
| `CMS_PIPELINE_MAP`   | `{}` o JSON `{ funnel: pipeline_id }` di fallback (se la campagna non ha `cms_pipeline_id`) | `{}`  |
| `SMTP_HOST/PORT/USER/PASS` | SMTP per invio transazionale/outreach                              | `smtp.example.com` / `465` / `...` / `...` |
| `EMAIL_FROM`         | Mittente email                                                            | `noreply@example.com`          |
| `OUTREACH_SMTP_*`    | SMTP di invio outreach (se separato)                                        | vedi `.env.example`            |
| `MAGIC_LINK_BASE_URL`| URL pubblico per i magic link (login)                                       | `https://app.example.com`      |
| `OPENROUTER_API_KEY` | Chiave OpenRouter per estrazione/copywriter/validator                       | `sk-or-v1-...`                 |
| `SERPER_API_KEY`     | Chiave Serper per arricchimento/scraping                                    | `...`                          |
| `GROQ_API_KEY`       | Chiave Groq (se usata)                                                      | `...`                          |

> Come generare `CMS_AGENT_TOKEN`: dal CMS, menu **API Tokens** (`/admin/api-tokens`)
> → **Create new token** → copiare il valore `agtok_...`. Nessun flusso OTP serve
> per un servizio esterno: il token è statico e scoped all'utente/sito da collegare.

---

## 3. Comandi di avvio

```bash
# 1) installare le dipendenze
npm ci

# 2) applicare le migrazioni DB (crea/aggiorna schema + migrations)
npm run migrate

# 3) avviare il servizio
node src/index.js
# oppure in produzione / docker: (vedi Dockerfile + docker-compose.yml)
```

Health check rapido: l'app fa boot e risponde; verifica nei log che non compaiano
errori di connessione al DB né eccezioni all'avvio.

---

## 4. Piano di verifica integrazione API CMS

L'integrazione usa l'endpoint `/api/agent/*` del CMS autenticato via header
`Authorization: Bearer <CMS_AGENT_TOKEN>` (vedi [sezione 2](#2-valori-env-da-compilare-nessun-segreto-reale-qui)).

### 4.1 Verifica manuale endpoint pipeline (smoke test)

```bash
export CMS_BASE_URL="https://cms.example.com"
export CMS_AGENT_TOKEN="agtok_..."   # compilare in deploy
export CMS_SITE_ID=1

curl -sS -H "Authorization: Bearer $CMS_AGENT_TOKEN" \
  "$CMS_BASE_URL/api/agent/sites/$CMS_SITE_ID/pipelines"
```

Risultato atteso: JSON con l'elenco delle pipeline del sito (array `pipelines`).
Un errore `401/403` = token non valido o scope errato; `404` = `CMS_SITE_ID` errato.

> ⚠️ Negli automatismi (CI, cron) non esportare mai il token in chiaro nei log:
> usare `printenv`/secret manager e redigere l'output di `curl` se necessario.

### 4.2 Verifiche funzionali end-to-end (da eseguire in un ambiente di test)

1. **Sync consenso**: lanciare una sincronizzazione contatto → verificare che
   `companies.consent_status` venga aggiornato a `marketing` (se CMS conferma
   `pref_marketing && pref_email`) oppure `cold`.
2. **Opportunità al primo interesse**: provocare una `has_replied=true` su un
   azienda con pipeline mappata → verificare che venga creata un'opportunità
   tramite `ensureOpportunity` (endpoint `/api/agent/sites/:id/opportunities`).
3. **Opt-out condiviso**: simulare un unsubscribe → verificare che il contatto
   sia in blacklist locale **e** segnato `setContactOptOut` sul CMS.
4. **Invii**: confermare che le campagne marketing inviino solo a `marketing`
   e che i `cold` passino solo dal flusso one-to-one (voci di log `invio_regola`).

### 4.3 Verifica interna (basata su test)

```bash
npm test          # tutti i test vitest (esistenti + regole consenso §8)
npm run migrate   # migrazioni DB idempotenti (skip se già eseguite)
```

---

## 5. Checklist finale prima del go-live

- [ ] `.env` compilato con valori reali, `.env` **non** versionato, `.env.example` aggiornato
- [ ] `CMS_AGENT_TOKEN` generato sul CMS e scoped al sito corretto
- [ ] `npm run migrate` completato senza errori
- [ ] `npm test` verde
- [ ] Boot dell'app privo di errori
- [ ] Smoke test `/api/agent/sites/:id/pipelines` risponde 200 con le pipeline
- [ ] Nessun segreto/token/password reale nei file versionati
