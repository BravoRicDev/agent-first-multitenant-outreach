🇬🇧 [English](README.md) · 🇮🇹 Italiano

# Outreach Service

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Tests](https://img.shields.io/badge/Tests-112%20passing-brightgreen)]()
[![Node.js](https://img.shields.io/badge/Node.js-18+-green)]()

Una **piattaforma B2B outreach multi-tenant** complementare a un CMS headless, pensata per campagne email enterprise, lead scoring e analisi del funnel di engagement.

## Funzionalità

- **Architettura multi-tenant**: isolamento tra tenant imposto, quota e test mode per-tenant, partizionamento rigoroso dei dati
- **Gestione consenso GDPR**: tracciamento del consenso per canale, log di audit, invio email guidato dal consenso
- **Analisi funnel**: metriche campaign in tempo reale (aperture, click, risposte), analisi del flusso del funnel
- **Orchestrazione email**: multi-canale (SMTP) con regole di routing, invii programmati, policy di retry, auth magic-link
- **Strumenti AI**: lead scoring, copywriting email, estrazione contenuti via OpenRouter, Groq
- **Integrazione CMS**: sincronizzazione bidirezionale con il CMS agent-first (o CMS headless compatibile), aggiornamenti guidati da webhook
- **Superficie Agente/MCP**: tool Model Context Protocol per workflow di agenti AI, registro tool estensibile
- **Internazionalizzazione**: supporto i18n completo (italiano/inglese), cambio lingua a runtime
- **Scheduling & Automazione**: campagne basate su cron, sequenze email, operazioni bulk, elaborazione task asincrone

## Stack

- **Runtime**: Node.js 18+
- **Framework**: Express.js, templating EJS
- **Database**: PostgreSQL (migrazioni idempotenti)
- **Testing**: Vitest (112+ test che coprono i servizi core)
- **API esterne**: OpenRouter (modelli AI), Serper (search), Groq, SMTP
- **Sicurezza**: Helmet, bcryptjs, JWT, rate limiting

## Architettura

```
┌─────────────────────────────────────────────────────────┐
│  Outreach Service (Multi-Tenant)                        │
├─────────────────────────────────────────────────────────┤
│ API Routes                                              │
│ ├─ Auth (JWT, magic links, session)                   │
│ ├─ Campaigns & Sequences (create, schedule, send)     │
│ ├─ CMS Integration (webhooks, bidirectional sync)     │
│ ├─ Agent/MCP (extensible tool interface)             │
│ └─ Admin (tenant, quota, test mode, settings)         │
├─────────────────────────────────────────────────────────┤
│ Services                                                │
│ ├─ Email (SMTP routing, scheduling, retries)          │
│ ├─ Funnel & Analytics (metrics aggregation)           │
│ ├─ Lead Scorer & AI (OpenRouter, Groq)               │
│ ├─ CMS Sync (agent-first, webhooks, bidirectional)       │
│ └─ Cron Jobs (campaigns, cleanup, notifications)      │
├─────────────────────────────────────────────────────────┤
│ Data Layer                                              │
│ ├─ PostgreSQL (89 migrations, all idempotent)        │
│ └─ Tenant-scoped queries (tenant_id filtering)        │
└─────────────────────────────────────────────────────────┘
```

**Flusso principale**:
1. **Creazione campaign**: definisci le liste di outreach, i template email, le sequenze
2. **Applicazione consenso**: verifica il consenso GDPR per contatto, per canale
3. **Consegna email**: instrada verso SMTP, programma gli invii, raccogli le metriche
4. **Tracciamento funnel**: monitora aperture, click, risposte, conversioni
5. **Sincronizzazione CMS**: rispedisci i dati di engagement al CMS, ricevi aggiornamenti via webhook
6. **Tool agente**: estendi con workflow guidati da AI (lead scoring, copywriting, estrazione)

Vedi [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) per il dettaglio dei componenti.

## Per iniziare

### Prerequisiti

- **Node.js** 18+ (verifica: `node --version`)
- **PostgreSQL** 12+ (sviluppo locale o Docker)
- **npm** 9+

### Installazione

```bash
# Clona il repository
git clone <repo-url>
cd outreach-service

# Installa le dipendenze
npm install

# Copia il template delle variabili d'ambiente
cp .env.example .env

# Modifica .env con la tua configurazione (vedi sezione Configurazione sotto)
```

### Setup del database

```bash
# Esegui le migrazioni (idempotenti, sicure da rieseguire)
npm run migrate

# Verifica: controlla nello schema PostgreSQL tabelle e strutture
```

### Esecuzione locale

```bash
# Modalità sviluppo (auto-reload con --watch)
npm run dev

# Modalità produzione
npm start

# Verifica: testa gli endpoint
curl http://localhost:3000/health
# Atteso: 200 OK
```

### Test

```bash
# Esegui tutti i test (112 casi)
npm test

# Modalità watch (riesegui a ogni modifica del file)
npm run test:watch
```

## Configurazione

### Variabili d'ambiente

Copia `.env.example` in `.env` e configura quanto segue (non committare mai `.env` con valori reali):

| Variabile | Obbligatoria | Descrizione | Esempio |
|-----------|--------------|-------------|---------|
| `PORT` | Sì | Porta del server Express | `3000` |
| `NODE_ENV` | Sì | Ambiente (development, production) | `production` |
| `DATABASE_URL` | Sì | Connection string PostgreSQL | `postgres://user:***@host:5432/db` |
| `JWT_SECRET` | Sì | Chiave di firma JWT (64+ byte casuali, hex) | `(generata)` |
| `JWT_EXPIRES_IN` | No | Scadenza token JWT | `24h` |
| `OPENROUTER_API_KEY` | Sì | Chiave API OpenRouter per i modelli AI | `sk-or-v1-...` |
| `SMTP_HOST` | Sì | Server SMTP (invio email) | `smtp.example.com` |
| `SMTP_PORT` | Sì | Porta SMTP (di solito 465 o 587) | `465` |
| `SMTP_USER` | Sì | Username SMTP | — |
| `SMTP_PASS` | Sì | Password SMTP | — |
| `EMAIL_FROM` | Sì | Indirizzo mittente di default (notifiche) | `noreply@example.com` |
| `MAGIC_LINK_BASE_URL` | Sì | URL base per la generazione dei magic link | `https://example.com` |
| `CMS_BASE_URL` | Sì | URL dell'istanza CMS agent-first | `https://cms.example.com` |
| `CMS_AGENT_TOKEN` | Sì | Token API CMS (scoped al servizio) | `agtok_...` |
| `CMS_SITE_ID` | Sì | ID sito CMS | `1` |
| `LOG_LEVEL` | No | Livello di log Winston | `info` |

### Branding

Le variabili seguenti consentono il branding per-tenant (sovrascrivibili dal pannello admin):

```
OUTR_APP_NAME=Outreach Service
OUTR_DEFAULT_FROM_NAME=Outreach Service
OUTR_SUPPORT_EMAIL=support@example.com
OUTR_SUPPORT_URL=https://support.example.com
OUTR_FOOTER_COMPANY=Your Company
OUTR_FOOTER_VAT=IT12345678
```

Questi sono i default; i singoli tenant possono personalizzare via `/admin/settings`.

## Multi-tenancy

Questo servizio è **multi-tenant imposto** — ogni richiesta è scoped a un tenant:

- **Identificazione tenant**: via token agente (`api_tokens.tenant_id`), risolto da `verifyApiToken`
- **Catalogo tenant**: memorizzato nella tabella `tenants`; accessibile via `/admin/tenants` (solo admin)
- **Gestione quota**: ogni tenant ha `daily_email_quota` (max email al giorno) e flag `test_mode`
- **Partizionamento dati**: tutte le tabelle core includono `tenant_id NOT NULL`; query filtrate via `scopeTenant`
- **Applicazione**: `scopeTenant(tenantId)` lancia errore se null; il middleware rifiuta accessi cross-tenant

Esempio: una richiesta con un token agente legato a `tenant_id=1` può accedere solo alle campaign, contatti e metriche di quel tenant.

Vedi [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) → sezione "Multi-Tenancy" per i dettagli implementativi.

## Internazionalizzazione (i18n)

La UI e le email supportano **italiano (it)** e **inglese (en)** a runtime:

- **Locale**: file JSON nella directory `locales/` (`it.json`, `en.json`)
- **Selezione**: via query param `?lang=en` o preferenza del browser (header Accept-Language)
- **Default**: italiano (configurabile via env var `DEFAULT_LANG`)
- **Language Switcher**: la UI include il toggle nell'header

### Aggiungere una nuova lingua

1. Crea `locales/fr.json` (copia da `locales/it.json` come template)
2. Traduci tutte le coppie chiave-valore
3. Aggiorna il middleware in `src/middleware/i18n.js` per registrare `fr`
4. Testa con `?lang=fr`

Le traduzioni coprono:
- Etichette UI, bottoni, messaggi
- Messaggi di errore
- Template email
- Pannello admin

## Superficie Agente & MCP

Questo servizio espone un'interfaccia **Model Context Protocol (MCP)** per workflow di agenti AI:

- **Endpoint**: `POST /api/mcp` (richiede `Authorization: Bearer ***`
- **Tool**: set estensibile di tool per ingestione lead, copywriting email, query CMS
- **Esempio**: un agente può chiamare `companies_ingest`, `companies_draft_generate`, `companies_send` e `companies_cms_sync` come operazioni atomiche

Vedi [`AGENT.md`](AGENT.md), [`MCP.md`](MCP.md) e la guida bootstrap per agenti
[`docs/AGENT-BOOTSTRAP.md`](docs/AGENT-BOOTSTRAP.md) per documentazione dei tool, setup ed
esempi (setup, collegamento al CMS, flusso di lavoro tipico, risoluzione problemi).

## Contribuire

Questo è un progetto open source. I contributi sono benvenuti:

1. **Fork** del repository
2. **Branch**: crea un branch di feature (`git checkout -b feature/my-feature`)
3. **Commit**: segui i conventional commits (`feat:`, `fix:`, `docs:`, ecc.)
4. **Test**: assicurati che `npm test` passi localmente
5. **Push** e apri una **Pull Request**

Per modifiche importanti, apri prima un issue per discutere l'approccio.

### Code Style

- **Formattazione**: ESLint/Prettier (esegui `npm run lint:fix` se configurato)
- **Test**: ogni modifica ai servizi core dovrebbe includere test unit o di integrazione
- **Commit**: Conventional Commits (`feat(i18n): ...`, `fix(smtp): ...`, ecc.)

## Licenza

Questo progetto è concesso in licenza [MIT](LICENSE) — vedi il file `LICENSE` per i dettagli.

## Supporto

- **Issues**: segnala bug o richiedi feature via GitHub Issues
- **Documentazione**: vedi la directory `docs/` per architettura, riferimenti API e guide
- **Email**: per domande, contatta i maintainers (dettagli in `CONTRIBUTING.md` se presente)

---

**Costruito con ❤️ per l'automazione outreach moderna e tenant-aware.**
