# AGENT.md — Servizio Outreach per agenti AI / Outreach service for AI agents

## ⚠️ PRIMA DI TUTTO: indipendente ma complementare al CMS
> **Letto questo prima**: `outreach-service` è un servizio **indipendente e autonomo** —
> si avvia, ha DB e runtime propri, e funziona anche senza il CMS collegato. Ma è
> **complementare per significato** a un CMS multi-tenant: fare outreach senza un CRM in cui tracciare i risultati
> **perde di significato**. Il valore del servizio è alimentare e aggiornare il CRM del CMS
> (contatti, consenso, opportunità, opt-out); per questo un'istanza andrebbe configurata con
> `CMS_BASE_URL`, `CMS_AGENT_TOKEN` e `CMS_SITE_ID`. Se mancano, il servizio **continua a
> funzionare tecnicamente** ma le sync verso il CMS sono **best-effort**: falliscono in
> silenzio (warning) e non bloccano le operazioni locali — però **il suo scopo principale non
> è raggiunto**. Agente: se stai lavorando al servizio, verifica SEMPRE che l'integrazione con
> il CMS sia presente e funzionante (vedi sezioni «Collegamento al CMS», «Modello tenant» e
> `DEPLOY-CHECKLIST.md`); non trattarlo come un sistema isolato dal CMS anche se tecnicamente
> potrebbe girare da solo.
>
> *(EN, to the point) `outreach-service` is an **independent, self-contained service** — it
> boots, owns its DB/runtime, and works even without the CMS wired up. But it is
> **complementary in purpose** to a multi-tenant CMS: doing outreach without a CRM to track results
> in loses its point. The service's value is feeding and updating the CMS CRM (contacts,
> consent, opportunities, opt-out), so an instance should be configured with `CMS_BASE_URL`,
> `CMS_AGENT_TOKEN` and `CMS_SITE_ID`. If missing, the service **keeps working technically**,
> but CMS syncs are **best-effort**: they fail silently (warning log) and never block local
> operations — though its main purpose is not achieved. Do not treat it as isolated from the
> CMS just because it can technically run alone.*

## Cos'è / What it is

`outreach-service` è il servizio outreach B2B **generico** (entità `companies`, in italiano
"aziende"). È **complementare** a un CMS multi-tenant: non duplica il CRM, si collega
via API (`src/services/cms.js`) usando un token agente CMS. Questo file descrive la superficie
**agent/MCP** che permette a un agente AI esterno di ingestare prospect, preparare bozze email,
leggerle e decidere quando/come inviarle — sempre rispettando consenso e limiti di invio.

`outreach-service` is the **generic** B2B outreach service (entity `companies`, "aziende" in
Italian). It is **complementary** to a multi-tenant CMS: it does not duplicate the
CRM, it connects via API (`src/services/cms.js`) using a CMS agent token. This file describes the
**agent/MCP** surface that lets an external AI agent ingest prospects, prepare email drafts, read
them, and decide when/how to send — always respecting consent and sending limits.

## Collegamento al CMS / CMS bridge

- `CMS_BASE_URL` — base URL del CMS multi-tenant (es. `https://cms.example.com`).
- `CMS_AGENT_TOKEN` — token statico `agtok_...` generato dal CMS (`/admin/api-tokens`), scoped
  all'utente/sito collegato. Nessun flusso OTP necessario per un servizio esterno.
- `CMS_SITE_ID` — id del sito CMS mono-tenant collegato a questa istanza.
- `CMS_PIPELINE_MAP` — mappa opzionale JSON `funnel -> pipeline_id` di fallback, usata solo se una
  campagna non ha un `cms_pipeline_id` esplicito.

Se il CMS non è configurato (variabili mancanti), tutte le sincronizzazioni verso il CMS sono
**best-effort**: falliscono in modo silenzioso (log warning), non bloccano mai l'operazione locale
richiesta dall'agente.

*(EN)* If the CMS is not configured, every CMS sync is best-effort: it fails silently (warning
log) and never blocks the local operation requested by the agent.

## Modello tenant / Tenancy model

> Il blueprint di evoluzione verso il multi-tenant (fasi ordinate, rischio/dipendenze per fase) è
> in `SPEC-MULTITENANT-FUNNEL.md` (cartella padre del progetto, requisiti 1-2).
>
> **Fase 1** (realizzata): colonna `tenant_id` (nullable) su tutte le tabelle core (`companies`,
> `campaigns`, `email_queue`, `followup_sequences`, `smtp_accounts`, `send_schedule`,
> `blacklist_patterns`), con indici composti + helper `scopeTenant` in `src/services/scope-tenant.js`.
> Semantica: un record appartiene a un tenant se `tenant_id == tenant` **oppure** `tenant_id IS NULL`
> (tenant 0, mono-tenant storico, per retro-compatibilità). Nessuna logica di scoping applicata
> ancora — predisposizione strutturale.
>
> **Fase 2A** (questa): binding ai-token → tenant, risoluzione automatica, scope applica su query
> agent read-only. Ogni token `agtok_...` (tabella `api_tokens`) è legato opzionalmente a un
> `tenant_id`. Quando `verifyApiToken` restituisce l'utente, include il `tenant_id` del token;
> le rotte agent read-only su tabelle core applica `scopeTenant(req.user.tenant_id)` automaticamente
> — un agente di tenant X non vede prospect di altri tenant. Questo giro **non** implementa il
> multi-tenant pieno — solo la predisposizione 2A e il binding per gli agenti.

- **Outreach = single-tenant per istanza.** Ogni istanza di `outreach-service` è configurata
  con **un solo** `CMS_SITE_ID` (`src/config.js` → `config.cmsSiteId`) e si collega a **un solo**
  sito del CMS.
- **CMS = multi-tenant.** Un unico deploy del CMS serve più siti, ognuno col proprio `site_id`; i suoi endpoint agent sono scoping
  per sito (`/api/agent/sites/:siteId/...`) — un token del sito A non vede il sito B.
- **Collegamento**: 1 istanza outreach ↔ 1 sito CMS, scelto via `CMS_SITE_ID`. Per gestire più
  siti servono **N istanze outreach** (una per sito) — oppure, in futuro, estendere il servizio
  per diventare multi-tenant (opzione da valutare, **non implementata ora**).
- Il bridge `src/services/cms.js` è già **tenant-neutral a livello di funzioni**:
  `upsertContact`, `ensureOpportunity`, `getContactConsent`, `setContactOptOut`, `addNote`,
  `getPipelines` accettano tutte `siteId` come parametro (con `config.cmsSiteId` solo come
  default). Il single-tenant di oggi deriva unicamente dalla configurazione, non da un limite
  del codice.

```
CMS (multi-tenant)                    Outreach (single-tenant per istanza)
site_id=1 (Sito A)       ◄──────────  istanza A  (CMS_SITE_ID=1)
site_id=2 (Sito B)       ◄──────────  istanza B  (CMS_SITE_ID=2)
site_id=3 (Sito C)       ◄──────────  istanza C  (CMS_SITE_ID=3)
```

*(EN)* Outreach is single-tenant per instance (one `CMS_SITE_ID` each); the CMS is multi-tenant
(one `site_id` per site, agent endpoints scoped per site). One outreach instance links to one
CMS site via `CMS_SITE_ID`; multiple sites need multiple instances (or, later, a multi-tenant outreach — not
implemented now). `cms.js` functions already take `siteId` as a parameter, so the bridge itself
is tenant-neutral — only the config makes an instance single-tenant.

## Come ottenere un api-token agente / How to get an agent api-token

Il servizio autentica l'agente con un **api-token locale** (prefisso `agtok_`, diverso dal token
CMS sopra), verificato da `src/middleware/agent-auth.js` via `src/services/api-tokens.js`
(tabella `api_tokens`, hash SHA-256, mai in chiaro dopo la creazione — stesso modello dei PAT
GitHub/Stripe).

### Via UI admin

Vai a `/admin/api-tokens` (richiede autenticazione admin). La form consente di:
- Selezionare un utente `users` esistente
- Dare un nome al token (es. "Integration API")
- Opzionalmente specificare un `tenant_id` (Fase 2A multi-tenant)
- Scegliere la scadenza (30 giorni, 90, 1 anno, mai)

Il token sarà mostrato in chiaro **una sola volta** dopo la creazione — salvalo subito in un luogo
sicuro (non duplicabile dopo).

### Via codice

Alternativamente, se stai in fase di setup o testing:

```js
import { createApiToken } from "./src/services/api-tokens.js";
const t = await createApiToken(userId, "nome-agente", 365); // giorni di validità, 0 = mai scade
// Fase 2A: passa tenantId per legare il token a un tenant
const t2 = await createApiToken(userId, "nome-agente", 365, tenantId); // tenantId opzionale
console.log(t.token); // agtok_... — mostrato UNA SOLA VOLTA, salvalo subito
```

Usalo come header `Authorization: Bearer agtok_...` su ogni chiamata `/api/agent/*` o `/api/mcp`.

**Fase 2A — Scoping per tenant**: se il token è legato a un `tenant_id`, le query read-only su
tabelle core (`GET /api/agent/companies`, `GET /api/agent/campaigns`, etc.) applicheranno
automaticamente il filtro `(tenant_id IS NULL OR tenant_id = $1)` — l'agente vede solo i dati del
suo tenant. Un token senza `tenant_id` (NULL) può accedere a tutti i dati (tenant 0, mono-tenant
storico).

## Regole operative per l'agente / Operating rules for the agent

1. **MAI inviare a un contatto senza consenso adeguato.** Un contatto `cold` (nessun consenso
   marketing) può essere contattato **solo** tramite il flusso one-to-one manuale
   (`POST /api/agent/companies/:id/send`, `send_context='manual'`) — mai in campagne/sequenze
   automatiche. `enforceConsent` applica questa barriera come ultimo controllo prima di ogni invio.
2. **L'opt-out è condiviso col CMS e va sempre rispettato.** `unsubscribed_at` blocca ogni invio,
   anche manuale. Usa `POST /api/agent/companies/:id/optout` per registrarlo; viene specchiato
   sul CMS (blacklist condivisa) best-effort.
3. **Rispetta il daily cap e la fascia oraria di invio.** `GET /api/agent/send-schedule` mostra lo
   stato corrente; l'invio effettivo passa sempre dalla coda (`email_queue`) processata dal cron,
   che applica questi limiti in modo condiviso tra marketing e cold — il cold non può aggirare il
   cap. `POST /api/agent/companies/:id/send` restituisce queste informazioni nella risposta
   (`cap_raggiunto`, `in_finestra`) invece di fingerle inesistenti.
4. **Preferisci ricerca/liste mirate a loop su tutti i prospect.** Usa `q`, `campaign_id`, `consent`
   per restringere `GET /api/agent/companies` prima di iterare; non c'è bisogno di scaricare tutto
   il database per operare su pochi prospect.
5. **Non duplicare il CRM.** Consenso, note, opportunità vivono sul CMS: usa
   `POST /api/agent/companies/:id/cms-sync` invece di tenere uno stato parallelo.
6. **Ingest = iniezione di dati già scrappati, mai scraping dal servizio.** L'endpoint di ingest
   fa solo upsert; non chiama siti esterni.
7. **Registra sempre l'esito di una chiamata/booking.** Dopo un tentativo di setting telefonico
   usa `POST .../call-outcome`; dopo aver creato/tenuto una videocall usa `POST .../booking`.
   Serve a far avanzare `funnel_stage` e a collegare l'esito alla timeline del contatto CMS —
   vedi sezione "Funnel B2B" più sotto.
8. **Prima di una campagna vera, verifica `test_mode`.** `GET /api/agent/test-mode` mostra se è
   attivo e chi sono i destinatari di test. Se attivo, **ogni** invio (campagna/follow-up/manuale)
   viene deviato SOLO verso quei destinatari (mai verso il contatto reale) o bloccato se non ce
   n'è nessuno — vedi sezione "Modalità test" più sotto.

## Consenso granulare per-canale + base giuridica / Per-channel consent + legal basis

> **Fase 3 (ora applicata)**: evoluzione da `consent_status` (`cold`/`marketing`) a consenso
> granulare per **canale** (email, sms, phone, whatsapp) + **base giuridica** (consent /
> legitimate_interest) allineato ai `pref_*` del CMS multi-tenant.

### Comportamento e retro-compatibilità

- Se `consent_channels` è **NULL/assente** (storico): `enforceConsent` usa il comportamento
  **identico a oggi**:
  - `consent_status = "marketing"` → invio ammesso in automatico
  - `consent_status = "cold"` + `consentContext = "manual"` → invio ammesso (one-to-one)
  - `consent_status = "cold"` + `consentContext = "automatic"` → invio bloccato
- Se `consent_channels` è **presente** (per-canale):
  - `consent_channels.email === true` → invio ammesso (per il canale email, unico canale di uscita)
  - Altrimenti → invio bloccato (default rigido: canale non esplicitamente consentito = NO)
  - La base giuridica (`consent_basis = 'consent'` o `'legitimate_interest'`) viene registrata
    in audit per tracciabilità GDPR

### Popolo via CMS sync

Quando `syncCompanyWithCms` legge le preferenze dal CMS (campi di preferenza per canale e marketing), popola:

- `consent_channels = { email: pref_marketing && pref_email, sms: pref_sms, phone: pref_phone, whatsapp: pref_whatsapp }`
  - Nota: `email` richiede **sia** preferenza email **sia** preferenza marketing (guardia combinata)
- `consent_basis = 'consent'` se preferenza marketing è true, altrimenti `'legitimate_interest'`

Se il CMS non è configurato o il contatto non esiste, i campi restano NULL (nessuna
sovrascrittura — retro-compatibilità).

### Audit

La funzione `auditInvioRegola` registra ora:
- `consentChannels` (oggetto JSONB)
- `consentBasis` (stringa: 'consent' | 'legitimate_interest')
- `admitted` e `reason` (come prima, ora con dettagli su canale e base giuridica)

### Esempio

```
// Storico (consent_channels NULL): comportamento identico a oggi
Company { id: 100, consent_status: "marketing", consent_channels: null }
→ enforceConsent(...) → { ok: true, reason: "consenso marketing presente" }

// Per-canale (consent_channels presente)
Company {
  id: 101,
  consent_channels: { email: true, sms: false, phone: true, whatsapp: false },
  consent_basis: "consent"
}
→ enforceConsent(...) → { ok: true, reason: "consenso email per canale presente (base: consent)" }

// Per-canale, email bloccata (default rigido)
Company {
  id: 102,
  consent_channels: { email: false, sms: true, phone: false },
  consent_basis: "legitimate_interest"
}
→ enforceConsent(...) → { ok: false, reason: "email non consentita nei canali (default rigido)" }
```

## Modalità test (sicurezza invii) / Test mode (send safety)

> Requisito 7 dello scenario d'uso — vedi `SPEC-MULTITENANT-FUNNEL.md` (cartella padre) per la
> formalizzazione completa.

Quando `test_mode` è **attivo** (`settings.test_mode = 'true'`), la barriera in
`src/services/test-mode.js` viene valutata da `src/services/email-sender.js` **prima di ogni
`transporter.sendMail`**, per qualunque invio (campagna, follow-up automatico, one-to-one
manuale): non esiste un percorso di invio che la aggiri.

- Se ci sono destinatari di test configurati (`test_recipients`), l'email viene **deviata** verso
  il primo destinatario di test, con oggetto prefissato `[TEST]` e header
  `X-Test-Original-To: <email reale>` — utile per audit, ma il destinatario reale **non
  riceve mai nulla**.
- Se **non** c'è nessun destinatario di test configurato, l'invio viene **bloccato** (nessun
  `transporter.sendMail` viene chiamato, la funzione restituisce `null` come in ogni altro invio
  fallito) — mai una via di mezzo.
- I guardiani rigidi esistenti (daily cap, fascia oraria, `enforceConsent`) restano attivi e
  vengono valutati **prima** del gate test_mode: `test_mode` è un livello di sicurezza aggiuntivo,
  non un sostituto.

Endpoint (RBAC speculare, vedi sezione dedicata più sotto):

| Metodo | Path | Permesso |
|---|---|---|
| GET | `/api/agent/test-mode` | Lettura, qualunque agente autenticato |
| PUT | `/api/agent/test-mode` (`{enabled: bool}`) | `settings`/update |
| POST | `/api/agent/test-mode/recipients` (`{email, note?}`) | `settings`/update |
| DELETE | `/api/agent/test-mode/recipients/:id` | `settings`/update |

*(EN)* When `test_mode` is on, every send (campaign, automatic follow-up, manual one-to-one) is
diverted to a configured test recipient (subject prefixed `[TEST]`, real address kept only in an
`X-Test-Original-To` header) — or blocked entirely if no test recipient is configured. Hard
guardrails (daily cap, send window, `enforceConsent`) still apply first; test_mode is an
additional layer, not a replacement.

## Permessi agenti = speculari all'utente (RBAC) / Agent permissions mirror the user

> Requisito 9 — nessun ruolo nuovo introdotto: l'agente eredita ruolo e permessi dell'utente a cui
> il suo api-token è legato (stesso modello, non uno parallelo).

- `api_tokens.user_id` lega ogni token `agtok_...` a un `users.id` esistente (vedi
  `db/075_api_tokens.sql`, `src/services/api-tokens.js`): `verifyApiToken` restituisce `role`
  dell'utente proprietario, non un ruolo "agente" a parte. **Non c'è alcuna distinzione tra "un
  utente che chiama l'API" e "un agente che chiama l'API"**: stesso `req.user`, stessa identità.
- `src/middleware/authorize.js` (`roles_permissions`, tabella condivisa con l'admin UI) funziona
  automaticamente anche su `req.user` popolato da `requireAgent` — non serve nessuna logica RBAC
  separata per gli agenti. Le rotte `PUT /api/agent/test-mode` e
  `POST/DELETE /api/agent/test-mode/recipients` usano `authorize('settings', 'update')`: un agente
  legato a un utente `collaboratore` (permesso `settings.can_update = false` di default, vedi
  `db/023_roles_permissions_default.sql`) riceve `403`, un agente legato ad `admin`/`superadmin`
  può scrivere — esattamente come accadrebbe per l'utente umano sull'admin UI.
- **Verificato ma NON rinforzato in questo giro** (rischio di rompere integrazioni agent
  esistenti senza un ciclo di test dedicato): le rotte di scrittura più vecchie di questo router
  (`companies_send`, `companies_optout`, `companies/:id` PUT, `call-outcome`, `booking`,
  `funnel-stage`, `ingest`) **non** hanno ancora un `authorize(...)` esplicito — qualunque token
  valido, indipendentemente dal ruolo dell'utente proprietario, può eseguirle. Segnalato anche in
  `GAP-REFINEMENT-*.md` (cartella padre) come raccomandazione per la prossima fase (aggiungere
  `authorize('companies', ...)` route per route, con test di non-regressione dedicati — nota anche
  che `roles_permissions` non ha ancora righe per `resource='companies'`, quindi vanno aggiunte
  insieme, altrimenti ogni non-superadmin verrebbe bloccato ovunque).

## Confine di responsabilità outreach / CMS (Req 6)

> L'outreach fa **solo** i passi di contatto (prospect, invio email, esiti, follow-up); delega al
> CMS tutto il resto (contatti, opportunità, pipeline, booking reale). Verificato in questo giro:
> nessuna rotta di questo servizio crea una pipeline, un'opportunità primaria o uno scheduling
> proprio — vedi `src/services/cms.js` (`upsertContact`, `ensureOpportunity*`, `addNote`,
> `setContactOptOut`) usato ovunque serva CRM reale. `companies.funnel_stage` / `call_status` /
> `booking_status` sono stato **sintetico locale** (mai lo stato di sistema): esistono solo per
> sapere "a che punto è" un prospect senza interrogare il CMS ad ogni richiesta, e per innescare
> `ensureOpportunityForStage` — non duplicano la pipeline CMS. Vedi `SPEC-MULTITENANT-FUNNEL.md`
> §Principi architetturali per il dettaglio completo.

## Flusso tipico / Typical flow

```
ingest → (draft) → leggi bozza → approva su CMS/UI se serve → send → verifica email-queue/consent
```

1. `POST /api/agent/companies/ingest` — crea o aggiorna il prospect (upsert per email, poi website).
2. `POST /api/agent/companies/:id/draft` — genera la bozza email (richiede `website` + dati
   sufficienti già ingestati: `title`/`descrizione` con contenuto reale, non scraping automatico).
3. `GET /api/agent/companies/:id/draft` — legge oggetto + corpo della bozza generata.
4. Il campo `approvato` va impostato a `true` (via UI/admin — l'agente non approva bozze da solo
   in questa fase) prima che l'invio sia ammesso.
5. `POST /api/agent/companies/:id/send` — invio one-to-one manuale: verifica bozza approvata,
   opt-out, consenso; accoda in `email_queue` (`send_context='manual'`). L'invio reale è
   **asincrono** (lo esegue il cron `processEmailQueue`), la risposta è sempre `esito: "scheduled"`
   quando ammesso, mai `"inviato"` sincrono.
6. `GET /api/agent/email-queue` — verifica lo stato di consegna.
7. `POST /api/agent/companies/:id/cms-sync` — sincronizza contatto/opportunità sul CMS.

## Tabella endpoint agent / Agent endpoint table

Tutti gli endpoint richiedono `Authorization: Bearer agtok_...` (token agente locale) e sono
soggetti a rate limit dedicato (120 req/min). Path completi, montati su `/api/agent`.

| Metodo | Path | Descrizione |
|---|---|---|
| GET | `/api/agent/me` | Identità dell'account agente autenticato |
| GET | `/api/agent/campaigns` | Elenco campagne con metriche aggregate (solo lettura) |
| GET | `/api/agent/campaigns/:id` | Dettaglio configurazione campagna (solo lettura) |
| GET | `/api/agent/campaigns/:id/stato` | Stato operativo campagna: bozze/approvate/inviate/daily cap |
| GET | `/api/agent/send-schedule` | Fasce orarie ammesse + daily cap + finestra corrente |
| GET | `/api/agent/companies` | Lista aziende (filtri: `campaign_id`, `consent`, `q`, `inviato`, `limit`) |
| GET | `/api/agent/companies/search?q=` | Ricerca full-text su title/email/comune/website |
| POST | `/api/agent/companies/ingest` | Upsert prospect (dati già scrappati) + sync CMS best-effort |
| GET | `/api/agent/companies/:id` | Dettaglio completo azienda (incl. bozza corrente) |
| PUT | `/api/agent/companies/:id` | Aggiorna campi (anagrafica, consent_status, notes, tags→CMS) |
| POST | `/api/agent/companies/:id/draft` | Genera/rigenera la bozza email (riusa pipeline ai-copywriter) |
| GET | `/api/agent/companies/:id/draft` | Legge la bozza corrente (404 se assente) |
| POST | `/api/agent/companies/:id/send` | Invio one-to-one manuale (unico percorso che ammette `cold`) |
| GET | `/api/agent/companies/:id/consent` | Stato consenso (CMS se configurato, altrimenti locale) |
| POST | `/api/agent/companies/:id/optout` | Opt-out totale locale + specchiato sul CMS (blacklist condivisa) |
| POST | `/api/agent/companies/:id/cms-sync` | Sync contatto CMS + opportunità se `has_replied` |
| POST | `/api/agent/companies/:id/call-outcome` | Registra l'esito di una chiamata di setting telefonico |
| PUT | `/api/agent/companies/:id/funnel-stage` | Imposta esplicitamente lo stage del funnel outreach |
| POST | `/api/agent/companies/:id/booking` | Registra prenotazione/esito di una videocall (booking) |
| GET | `/api/agent/email-queue` | Coda email recenti (email, status, evento), filtro `status` |
| GET | `/api/agent/test-mode` | Stato `test_mode` + destinatari di test |
| PUT | `/api/agent/test-mode` | Attiva/disattiva `test_mode` (permesso `settings`/update) |
| POST | `/api/agent/test-mode/recipients` | Aggiunge/aggiorna un destinatario di test (permesso `settings`/update) |
| DELETE | `/api/agent/test-mode/recipients/:id` | Rimuove un destinatario di test (permesso `settings`/update) |
| GET | `/api/agent/funnel-metrics` | Metriche funnel: conteggi/conversion rate per stadio, email, chiamate, booking, bloccati (filtro `campaign_id`, `stuck_days`) |

Nessun endpoint fa invio SMTP sincrono o scraping: riusano i servizi esistenti
(`src/services/email-sender.js`, `src/services/cms.js`, `src/routes/cron.js`,
`src/services/ai-copywriter.js`, `src/services/send-schedule.js`).

## Funnel B2B lato outreach / B2B funnel on the outreach side

> Vedi anche `GAP-ANALYSIS-FUNNEL.md` (cartella padre del progetto) per l'analisi completa
> del funnel `ricerca prospect → cold email → setting telefonico → booking → videocall →
> demo → vendite` sui due sistemi (CMS + outreach) e le raccomandazioni per il CMS.

`companies.funnel_stage` traccia sinteticamente a che punto è un prospect, lato outreach:

```
prospect → contacted → called → booked → demo → won / lost
```

- `prospect`: appena ingestito, nessun contatto ancora.
- `contacted`: email cold inviata (`POST .../send` avanza automaticamente lo stage se era `prospect`).
- `called`: almeno una chiamata di setting registrata (`POST .../call-outcome`, avanza
  automaticamente se l'esito non è `non_interessato`; con `non_interessato` lo stage passa a `lost`).
- `booked`/`demo`: videocall prenotata/effettuata (`POST .../booking`, avanza automaticamente
  in base a `status`).
- `won`/`lost`: esito finale — impostato manualmente con `PUT .../funnel-stage` quando l'agente
  o l'operatore lo conosce dal CMS (la vendita vera resta sul CMS: pipeline/opportunities/quotes).

Regole:
1. **Mai retrocedere uno stage già più avanti.** Ogni avanzamento automatico confronta la
   posizione nell'array `FUNNEL_STAGES` e aggiorna solo se lo stage nuovo è successivo a
   quello corrente (eccetto `won`/`lost`, terminali, impostabili solo esplicitamente).
2. **Ogni esito chiamata/booking aggiunge una nota sul contatto CMS** (best-effort, via
   `addNote`) — collega l'esito "telefono/booking" alla timeline del contatto CMS, gap
   segnalato nel report (il CMS non aveva questo collegamento nativo tra `call-recordings` e
   `contact_notes`/`opportunities`).
3. **Interesse telefonico o booking positivo → opportunità CMS best-effort**
   (`ensureOpportunityForStage`, stesso meccanismo di `companies_cms_sync` ma con uno
   `stageKey` dedicato — `interessato`/`booked`/`demo` — cercato nella `cms_stage_map` della
   campagna). Se il CMS non è configurato o la campagna non ha pipeline, l'operazione locale
   non viene mai bloccata.
4. **`call-outcome`/`booking`/`funnel-stage` non duplicano lo scheduling del CMS.** Il modulo
   `calls`/booking pubblico del CMS resta l'unico posto dove si *crea* una prenotazione reale;
   `POST .../booking` qui registra solo lo stato sintetico e un eventuale `link` verso l'evento
   reale (CMS o calendario esterno).

Vedi anche `MCP.md` per l'accesso via server MCP (`/api/mcp`) — stessi endpoint, esposti come tool.

## Metriche funnel + alert automatizzati (Req 10)

**Fase 4 (per-tenant):** `GET /api/agent/funnel-metrics` è scoped al tenant dell'agente
(isolamento dati corretto); il cron di alert resta system-wide.

`GET /api/agent/funnel-metrics` (`src/services/funnel-metrics.js`, condiviso col cron alert)
restituisce, per campagna o globale:

- **Conteggi per stadio** e **conteggi cumulativi raggiunti** (`reached_cumulative`: quanti
  prospect hanno raggiunto almeno lo stadio X, dato che `funnel_stage` non retrocede mai).
- **Conversion rate tra stadi consecutivi** (`prospect_to_contacted_rate`, ...,
  `demo_to_won_rate`), calcolati sui conteggi cumulativi.
- **Metriche email**: inviate/aperte/cliccate/bounced/risposte + `open_rate`/`click_rate`/
  `reply_rate`/`bounce_rate` (null, non 0, se non è stato inviato nulla — evita falsi allarmi).
- **Esiti chiamata/booking**: breakdown per `call_status`/`booking_status`.
- **Prospect bloccati** (`stuck`): conteggio + campione (max 50) di prospect in uno stadio non
  terminale (`funnel_stage NOT IN ('won','lost')`) senza aggiornamenti da più di `stuck_days`
  giorni (default 14) — proxy su `updated_at`, non esiste ancora una cronologia per-stadio (gap
  segnalato in `GAP-REFINEMENT-*.md`, cartella padre).

**Alert automatizzato** (`src/services/funnel-alerts.js`, cron ogni ora, `HH:20`, guardia
`funnel_alert_enabled`): confronta `open_rate`/`reply_rate` con le soglie in `settings`
(`funnel_alert_open_rate_min`, `funnel_alert_reply_rate_min`, default 15%/2%) e il conteggio
`stuck` con `funnel_alert_stuck_days` (default 14). Se una soglia è superata, produce:
- un log strutturato `winston` livello `warn` con chiave `funnel_alert` (niente Telegram, rimosso
  da questo servizio — vedi commit `4fdf869`);
- una riga in `audit_log` (`action='funnel_alert', resource='funnel'`, `details` JSONB con gli
  alert), consultabile da un agente via query diretta o strumenti admin esistenti.

Nessun nuovo endpoint dedicato agli alert: il canale di lettura è il log strutturato +
`audit_log`, coerente con l'assenza di notifiche push nel servizio dopo la rimozione di Telegram.

## Consenso granulare per canale (Req 4 — implementazione attiva)

`companies.consent_channels` (JSONB) e `companies.consent_basis` (VARCHAR) sono **già implementati e utilizzati** dal servizio:

- **Lettura**: `enforceConsent` in `src/services/email-sender.js` legge `consent_channels` per applicare il controllo per-canale (`email: true → ammesso`, altrimenti bloccato per quel canale). Se `consent_channels` è NULL/assente, ricade nel comportamento legacy di retro-compatibilità usando solo `consent_status`.

- **Scrittura**: `syncCompanyWithCms` in `src/services/cms.js` scrive `consent_channels` (forma `{"email":true,"sms":false,"phone":true,"whatsapp":false}`, derivata dalle preferenze CMS multi-tenant) e `consent_basis` (`'consent'` per consenso esplicito, `'legitimate_interest'` per interesse legittimo, tipico del cold B2B one-to-one), sincronizzando i dati dal CMS verso il DB del servizio.

La migrazione `db/083_consent_channels_prep.sql` aggiunge le colonne JSONB/VARCHAR, già utilizzate dalla logica applicativa. Questo consente isolamento per-canale e tracciamento della base legale, coerente con il piano di conformità multi-tenant (vedi `SPEC-MULTITENANT-FUNNEL.md` §Requisito 4).

## Gestione tenant — Pannello admin (Fase 5)

**Fase 5**: pannello di gestione tenant nella UI admin (`/admin/tenants`), con catalogo persistente
e controlli per attiva/disattiva, quota email giornaliera per-tenant, test_mode per-tenant.

### Tabella catalogo `tenants` (migrazione 086)

- `id` — PK, identificatore tenant > 0; tenant 0 (NULL) mono-tenant storico **non è catalogato**.
- `name` — nome leggibile (es. "Azienda A").
- `site_id` — collegamento opzionale a istanza CMS (1:1).
- `is_active` — flag disabilitazione; se FALSE, il tenant è sospeso (uso futuro per blocchi rapidi).
- `daily_email_quota` — quota email/giorno per tenant; NULL = illimitato.
- `test_mode` — se TRUE, email del tenant non sono inviate (test mode per-tenant).
- `created_at`, `updated_at` — timestamp.

La migrazione è idempotente e effettua un seed dai `tenant_id` già presenti in `companies` e
`api_tokens`, così il pannello mostra subito i tenant esistenti.

### Pannello `/admin/tenants`

Rotte protette da `requireAdmin`:
- `GET /admin/tenants` — render view con elenco tenant, form creazione.
- `POST /api/admin/tenants` — crea tenant (validazione input).
- `POST /api/admin/tenants/:id/toggle` — attiva/disattiva `is_active`.
- `POST /api/admin/tenants/:id/quota` — aggiorna `daily_email_quota`.
- `POST /api/admin/tenants/:id/test-mode` — aggiorna `test_mode`.

View `views/admin/tenants.ejs` in stile CMS (tabella, form, badge stato), con link `🏢 Tenant`
nella sidebar admin dopo `🔑 API Tokens`.

### Servizio helper `src/services/tenants.js`

Funzioni pure per query e logica tenant:
- `getTenantById(tenantId)` — recupera riga `tenants`.
- `listTenants()` — elenco completo.
- `createTenant(name, siteId, dailyEmailQuota, testMode)` — crea tenant.
- `toggleTenantActive(tenantId, isActive)` — attiva/disattiva.
- `updateTenantQuota(tenantId, dailyEmailQuota)` — aggiorna quota.
- `updateTenantTestMode(tenantId, testMode)` — aggiorna test_mode.
- `isTenantActive(tenantId)`, `getTenantQuota(tenantId)`, `isTenantTestMode(tenantId)` —
  helper di consultazione (return true/null se tenant non è in catalogo, per retro-compatibilità).

### Integrazione quota/test_mode per-tenant (best-effort)

Le colonne `daily_email_quota` e `test_mode` della tabella `tenants` sono state aggiunte come
catalogo persistente, con helper di consultazione pronti in `src/services/tenants.js`.

### Integrazione operativa: attivazione, quota, test_mode per-tenant

Il cablaggio è ora **operativo** su tutti i percorsi di invio (campagne via cron, follow-up, invii
manuali one-to-one):

1. **test_mode per-tenant** (`src/services/test-mode.js`, `resolveTestRecipient`):
   - Consulta `isTenantTestMode(tenant_id)` in aggiunta al global `test_mode`.
   - Se il tenant ha `test_mode=true`, l'invio è deviato verso un destinatario di test (stesso
     flusso del global test_mode) oppure bloccato se nessun destinatario è configurato.
   - Applicato a: `sendCampaignEmail`, `sendFollowUpEmail`, invii manuali via `email_queue`.

2. **Attivazione tenant** (`is_active`, `src/routes/cron.js`):
   - Consulta `isTenantActive(tenant_id)` nel loop di `processEmailQueue` e `processFollowUps`.
   - Se `is_active=false`, l'invio è rimandato in `pending` con motivo "tenant disattivato".
   - Applicato a: campagne, follow-up automatici, invii manuali, retry.

3. **Quota email giornaliera per-tenant** (`daily_email_quota`, `src/routes/cron.js`):
   - Consulta `getTenantQuota(tenant_id)` nel loop di `processEmailQueue` e `processFollowUps`.
   - Se quota > 0 e raggiunta (conteggio invii di oggi per quel tenant, timezone Europe/Rome),
     l'invio è rimandato in `pending` con motivo "limite giornaliero quota tenant".
   - Applicato a: campagne, follow-up automatici, invii manuali, retry.

**Comportamento default per tenant non catalogato**:
- `is_active`: ritorna `true` (invio permesso — best-effort, non bloccare un tenant non configurato).
- `test_mode`: ritorna `false` (nessuna deviazione).
- `daily_email_quota`: ritorna `null` (illimitato).

Questo garantisce retro-compatibilità: un tenant non nel catalogo non viene mai bloccato per
attivazione/quota, preservando il comportamento storico di tenant 0 (NULL).

### Retro-compatibilità

- Il tenant 0 (NULL) storico **non è catalogato**; il comportamento esistente è invariato.
- Se un record ha `tenant_id` non catalogato in `tenants`, è trattato come tenant storico (quota
  illimitata, test_mode off, sempre attivo).
- Tutte le nuove tabelle/query sono idempotenti; il cablaggio è fail-closed (errore di query →
  comportamento conservativo, nessun blocco inaspettato).
