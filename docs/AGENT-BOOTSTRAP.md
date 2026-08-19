# AGENT-BOOTSTRAP — Guida AI per il servizio Outreach / AI Bootstrap Guide for Outreach Service

## Cos'è in 30 secondi / What it is in 30 seconds

**IT**: `outreach-service` è un servizio Node.js B2B specializzato in prospect outreach, consenso GDPR per-canale, email orchestration e integrazione con CMS multi-tenant. È **complementare** (non sostitutivo) a un CMS — il suo scopo è alimentare/aggiornare il CRM del CMS con contatti, consenso, opportunità e opt-out.

**EN**: `outreach-service` is a Node.js B2B service specialized in prospect outreach, per-channel GDPR consent, email orchestration, and multi-tenant CMS integration. It is **complementary** (not a replacement) to a CMS — its purpose is to feed/update the CMS CRM with contacts, consent, opportunities, and opt-out data.

---

## Architettura a colpo d'occhio / Architecture at a glance

```
┌──────────────────────────────────────────────┐
│  Outreach Service (Multi-Tenant Internal)    │
├──────────────────────────────────────────────┤
│ API Routes                                   │
│ ├─ /api/agent/* (MCP tools, agent API)      │
│ ├─ /api/admin/* (UI admin, tenant mgmt)     │
│ └─ /api/mcp (Streamable HTTP MCP server)    │
├──────────────────────────────────────────────┤
│ Services                                     │
│ ├─ Email Sender (SMTP, scheduling)           │
│ ├─ Consent Enforcer (per-channel GDPR)      │
│ ├─ CMS Bridge (bidirectional sync)          │
│ ├─ AI Copywriter (email draft generation)   │
│ ├─ Funnel Metrics & Alerts                  │
│ └─ Cron Jobs (email queue, follow-ups)      │
├──────────────────────────────────────────────┤
│ Database: PostgreSQL (multi-tenant enforced) │
│ ├─ tenants, companies, campaigns            │
│ ├─ email_queue, api_tokens, settings        │
│ └─ Scoped queries via scopeTenant()         │
└──────────────────────────────────────────────┘
       ↕ (API sync, webhooks)
┌──────────────────────────────────────────────┐
│  CMS Agent-First (Multi-Tenant)              │
│  /api/agent/sites/:siteId/*                 │
└──────────────────────────────────────────────┘
```

**Key technologies**:
- **Runtime**: Node.js 18+, Express.js, EJS templating
- **DB**: PostgreSQL 14+ (87 migrations, idempotent)
- **i18n**: Italian/English at runtime (locales/)
- **AI/External APIs**: OpenRouter (models), Groq, Serper, SMTP
- **Testing**: Vitest (112+ test cases)

---

## Prerequisiti / Prerequisites

1. **Node.js 18+** — verify: `node --version`
2. **PostgreSQL 14+** — local dev, Docker, or cloud (need connection string)
3. **npm 9+** — `npm --version`
4. **Git** — to clone the repository
5. **A CMS instance** — the outreach service is meant to be deployed alongside an agent-first multi-tenant CMS
6. **An agent token from the CMS** — get `agtok_...` via `/admin/api-tokens` on the CMS (not the outreach service)
7. **The CMS site ID** — e.g., `1`, `2`, etc.

---

## Setup / Primo avvio / Getting started

### Step 1: Clone and install

```bash
git clone <repo-url>
cd outreach-service
npm ci  # Clean install (prefer over npm install)
```

### Step 2: Environment setup

Copy the template and fill in your values:

```bash
cp .env.example .env
# Edit .env with your values (see "Configuration" section below)
```

### Step 3: Database migrations

```bash
npm run migrate  # Idempotent, safe to re-run
# Creates schema, tables, and all 87 migrations (if not already applied)
```

### Step 4: Start the service

```bash
# Development mode (with --watch)
npm run dev

# Or production mode
npm start

# Verify boot: GET http://localhost:3000/health
# Expected: 200 OK { "status": "ok" }
```

Check logs — no DB connection errors, no exceptions during boot.

---

## Configurazione `.env` / Configuration

Copy `.env.example` to `.env` and fill in the following. **Never commit `.env` with real values.**

| Variable | Required | Description | Example |
|----------|----------|-------------|---------|
| `PORT` | Yes | Express port | `3000` |
| `NODE_ENV` | Yes | Environment | `production` |
| `DATABASE_URL` | Yes | PostgreSQL connection string | `postgres://user:pass@db:5432/outreach` |
| `JWT_SECRET` | Yes | JWT signing key (64+ random hex bytes) | `(generate: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")` |
| `JWT_EXPIRES_IN` | No | JWT expiry | `24h` |
| **CMS Integration** | | | |
| `CMS_BASE_URL` | Yes | Base URL of the CMS instance | `https://cms.example.com` |
| `CMS_AGENT_TOKEN` | Yes | Static token `agtok_...` from CMS `/admin/api-tokens` | `agtok_abcd1234...` |
| `CMS_SITE_ID` | Yes | CMS site ID this instance connects to | `1` |
| `CMS_PIPELINE_MAP` | No | Fallback JSON `{funnel: pipeline_id}` if campaign has no `cms_pipeline_id` | `{}` |
| **Email (SMTP)** | | | |
| `SMTP_HOST` | Yes | SMTP server for transactional/outreach email | `smtp.example.com` |
| `SMTP_PORT` | Yes | SMTP port (usually 465 or 587) | `465` |
| `SMTP_USER` | Yes | SMTP username | — |
| `SMTP_PASS` | Yes | SMTP password | — |
| `EMAIL_FROM` | Yes | Default from address | `noreply@example.com` |
| `MAGIC_LINK_BASE_URL` | Yes | Base URL for magic links (login, invites) | `https://app.example.com` |
| **AI & External Services** | | | |
| `OPENROUTER_API_KEY` | Yes | OpenRouter API key for LLM models | `sk-or-v1-...` |
| `SERPER_API_KEY` | No | Serper API key for search/enrichment | — |
| `GROQ_API_KEY` | No | Groq API key (if used) | — |
| **Logging** | | | |
| `LOG_LEVEL` | No | Winston log level | `info` |

### How to generate JWT_SECRET

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Copy the output to `JWT_SECRET`.

### How to get CMS_AGENT_TOKEN

1. Go to the **CMS** (not this service) → `/admin/api-tokens`
2. Click **Create new token**
3. Select user/scope (agent-first CMS will ask which site/user this token is for)
4. Copy the `agtok_...` value
5. Paste into `.env` → `CMS_AGENT_TOKEN`

---

## Ottenere un api-token agente LOCALE / Getting a local agent token

The outreach service authenticates agents via a **local agent token** (prefix `agtok_`, different from the CMS token above). Here's how to create one:

### Via Admin UI

1. Boot the service (`npm run dev`)
2. Go to `http://localhost:3000/admin/api-tokens`
3. Log in (default admin user, or create one via DB seed)
4. Click **Create Token**
5. Select an existing user, give it a name (e.g., "Integration API"), set expiry
6. **Copy the token immediately** — it's shown once, never again
7. Use it as `Authorization: Bearer agtok_...` in agent requests

### Via Code (for scripting/testing)

```js
import { createApiToken } from "./src/services/api-tokens.js";

// tenantId REQUIRED — api_tokens.tenant_id è NOT NULL (multi-tenant enforced,
// migrazione 087). Passa l'id del tenant a cui legare il token.
const token = await createApiToken(userId, "My Agent", 365, 1);
console.log(token.token); // agtok_... — save this securely
```

---

## Collegare al CMS / Wiring to the CMS

The service syncs contact data, consent, opportunities, and opt-out status with the CMS. This is the **core integration** and must work for the service to fulfill its purpose.

### Prerequisite: Valid CMS_AGENT_TOKEN

Before testing, ensure:
1. You've obtained a valid `agtok_...` token from the CMS `/admin/api-tokens`
2. It's scoped to the correct user/site on the CMS
3. It's set in `.env` → `CMS_AGENT_TOKEN`

### Smoke test: Verify CMS connectivity

```bash
export CMS_BASE_URL="https://cms.example.com"
export CMS_AGENT_TOKEN="agtok_..."
export CMS_SITE_ID="1"

curl -s -H "Authorization: Bearer $CMS_AGENT_TOKEN" \
  "$CMS_BASE_URL/api/agent/sites/$CMS_SITE_ID/pipelines" \
  | jq .

# Expected: JSON with { "pipelines": [...] }
# 401/403 = token invalid or scope wrong
# 404 = CMS_SITE_ID not found
```

### Functional test: Ingest → Sync → Verify

1. **Ingest a company**:
   ```bash
   curl -X POST http://localhost:3000/api/agent/companies/ingest \
     -H "Authorization: Bearer <your-agent-token>" \
     -H "Content-Type: application/json" \
     -d '{
       "email": "prospect@example.com",
       "title": "Example Corp",
       "description": "Tech company",
       "website": "https://example.com"
     }'
   ```
   Response: `{ "id": 123, "email": "...", "cms_synced": false, ... }`

2. **Trigger CMS sync**:
   ```bash
   curl -X POST http://localhost:3000/api/agent/companies/123/cms-sync \
     -H "Authorization: Bearer <your-agent-token>"
   ```
   Response: `{ "synced": true, "contact_id": "cms_xyz", ... }` (if CMS is reachable) or `{ "synced": false, "reason": "..." }` (best-effort failure)

3. **Verify on CMS**: Log into the CMS and check that the contact appears in contacts (with email, title, etc.)

### Common issues & fixes

| Issue | Root Cause | Fix |
|-------|-----------|-----|
| **401/403 on /api/agent/sites/**... | Token invalid or scope wrong | Regenerate token on CMS `/admin/api-tokens`, ensure correct site_id |
| **404 on /api/agent/sites/**... | CMS_SITE_ID doesn't exist | Verify CMS_SITE_ID matches an actual site in the CMS |
| **Connection refused** | CMS not reachable | Check CMS_BASE_URL, ensure CMS is running, check firewall |
| **Sync shows `best-effort: warning` in logs** | CMS is up but sync failed | Check logs for details; sync failure doesn't block local operations |

---

## Flusso di lavoro tipico per un agente / Typical agent workflow

```
Ingest prospects → Generate draft → Review/Approve → Send email → Register outcome → Sync to CMS
```

### 1. Ingest

```bash
curl -X POST http://localhost:3000/api/agent/companies/ingest \
  -H "Authorization: Bearer agtok_..." \
  -H "Content-Type: application/json" \
  -d '{
    "email": "john@corp.com",
    "title": "John Doe",
    "company_name": "Corp Inc",
    "description": "VP of Sales, interested in outreach"
  }'
```

**Response**: Created/updated company (upsert by email).

### 2. Generate draft email

```bash
curl -X POST http://localhost:3000/api/agent/companies/:id/draft \
  -H "Authorization: Bearer agtok_..."
```

**Note**: Draft generation requires the company to have `website`, `title`, `description` already set (not blank). The service uses AI copywriting (OpenRouter) to generate personalized email.

### 3. Review draft

```bash
curl http://localhost:3000/api/agent/companies/:id/draft \
  -H "Authorization: Bearer agtok_..."
```

**Response**: `{ "subject": "...", "body": "..." }`

### 4. Approve (via UI or direct DB)

Draft approval is done via the admin UI (`/admin`). Alternatively, update the DB directly (not via API):

```sql
UPDATE companies SET approvato = true WHERE id = :id;
```

### 5. Send email

```bash
curl -X POST http://localhost:3000/api/agent/companies/:id/send \
  -H "Authorization: Bearer agtok_..." \
  -H "Content-Type: application/json" \
  -d '{"send_context": "manual"}'
```

**Response**: `{ "esito": "scheduled", "in_queue": true, ... }`

The actual send is **async** — the cron job `processEmailQueue` sends it (default every 1 min). Check email_queue to see status:

```bash
curl http://localhost:3000/api/agent/email-queue \
  -H "Authorization: Bearer agtok_..."
```

### 6. Register outcome

After a call, register the outcome:

```bash
curl -X POST http://localhost:3000/api/agent/companies/:id/call-outcome \
  -H "Authorization: Bearer agtok_..." \
  -H "Content-Type: application/json" \
  -d '{"status": "interested", "notes": "Wants a demo"}'
```

### 7. Sync to CMS

```bash
curl -X POST http://localhost:3000/api/agent/companies/:id/cms-sync \
  -H "Authorization: Bearer agtok_..."
```

This pushes the company, consent, notes, and (if `has_replied=true`) an opportunity to the CMS.

---

## Mappa tool MCP ↔ endpoint / MCP tools map

All 25+ tools are accessible via:
- **REST API** (`POST /api/agent/...`)
- **MCP Server** (`POST /api/mcp`, Streamable HTTP, same schema)

Both require `Authorization: Bearer agtok_...`.

| Area | Tool Name | Endpoint | Purpose |
|------|-----------|----------|---------|
| **Identity** | `me` | `GET /api/agent/me` | Current agent identity |
| **Campaigns** | `campaigns_list` | `GET /api/agent/campaigns` | List campaigns |
| | `campaigns_get` | `GET /api/agent/campaigns/:id` | Campaign detail |
| | `campaigns_stato` | `GET /api/agent/campaigns/:id/stato` | Campaign operational state |
| **Scheduling** | `send_schedule_get` | `GET /api/agent/send-schedule` | Send windows + daily cap |
| **Prospect** | `companies_list` | `GET /api/agent/companies` | List prospects (filters: campaign_id, consent, q, limit) |
| | `companies_search` | `GET /api/agent/companies/search?q=...` | Full-text search |
| | `companies_ingest` | `POST /api/agent/companies/ingest` | Create/update prospect (upsert by email) |
| | `companies_get` | `GET /api/agent/companies/:id` | Prospect detail |
| | `companies_update` | `PUT /api/agent/companies/:id` | Update prospect (anagrafica, consent, tags) |
| **Draft** | `companies_draft_generate` | `POST /api/agent/companies/:id/draft` | Generate email draft (AI) |
| | `companies_draft_get` | `GET /api/agent/companies/:id/draft` | Read email draft |
| **Send** | `companies_send` | `POST /api/agent/companies/:id/send` | Send one-to-one email (manual context) |
| **Consent** | `companies_consent_get` | `GET /api/agent/companies/:id/consent` | Consent status (from CMS or local) |
| | `companies_optout` | `POST /api/agent/companies/:id/optout` | Opt-out total (local + CMS best-effort) |
| **CMS Bridge** | `companies_cms_sync` | `POST /api/agent/companies/:id/cms-sync` | Sync contact/opportunity/opt-out to CMS |
| **Funnel** | `companies_call_outcome` | `POST /api/agent/companies/:id/call-outcome` | Register phone call outcome |
| | `companies_funnel_stage_set` | `PUT /api/agent/companies/:id/funnel-stage` | Set funnel stage explicitly |
| | `companies_booking_set` | `POST /api/agent/companies/:id/booking` | Register booking/demo |
| **Email Queue** | `email_queue_list` | `GET /api/agent/email-queue` | Recent email queue (status, events) |
| **Test Mode** | `test_mode_get` | `GET /api/agent/test-mode` | Test mode status + recipients |
| | `test_mode_set` | `PUT /api/agent/test-mode` | Enable/disable test mode (RBAC: settings/update) |
| | `test_mode_recipient_add` | `POST /api/agent/test-mode/recipients` | Add test recipient (RBAC: settings/update) |
| | `test_mode_recipient_remove` | `DELETE /api/agent/test-mode/recipients/:id` | Remove test recipient (RBAC: settings/update) |
| **Metrics** | `funnel_metrics` | `GET /api/agent/funnel-metrics` | Funnel metrics (counts, rates, stuck prospects) |

**Rate limit**: 120 req/min per token.

---

## 8 Regole operative fondamentali / Golden rules

1. **Never send without consent** — `cold` contacts can only be contacted via one-to-one manual flow (`companies_send` with `send_context='manual'`), never in automated campaigns/sequences. Use `companies_consent_get` to check.

2. **Respect opt-out** — `unsubscribed_at` blocks all sends (even manual). Use `companies_optout` to register unsubscribe; it syncs to CMS best-effort (shared blacklist).

3. **Honor daily cap & send window** — `GET /api/agent/send-schedule` shows current state. The cron job enforces this on all sends equally (cold + marketing). `POST .../send` returns `cap_raggiunto` and `in_finestra` instead of ignoring them.

4. **Prefer targeted search over bulk loops** — Use `companies_list` with filters (`q`, `campaign_id`, `consent`) rather than downloading all prospects.

5. **Don't duplicate the CRM** — Consent, notes, opportunities live on the CMS. Use `companies_cms_sync` instead of parallel local state.

6. **Ingest = data already scraped, never scrape from the service** — `companies_ingest` only does upsert; it doesn't call external websites.

7. **Always register outcomes** — After a call, use `call-outcome`. After a demo/booking, use `booking`. This moves `funnel_stage` forward and links the outcome to the CMS contact timeline via `addNote`.

8. **Verify test_mode before campaigns** — `GET /api/agent/test-mode` shows if active and who receives test emails. If active, **all** sends (campaign, follow-up, manual) are diverted to test recipients or blocked if none configured — never to the real contact.

---

## Test / Verifica / Testing

### Run local test suite

```bash
npm test  # 112 test cases, Vitest
# Covers: consent enforcement, email scheduling, CMS sync, funnel logic, etc.
```

### End-to-end integration test (manual)

1. **Boot the service**: `npm run dev`
2. **Ingest a prospect**: `POST /api/agent/companies/ingest` (as above)
3. **Generate draft**: `POST /api/agent/companies/:id/draft`
4. **Verify consent**: `GET /api/agent/companies/:id/consent`
5. **Send email**: `POST /api/agent/companies/:id/send`
6. **Check queue**: `GET /api/agent/email-queue`
7. **Sync to CMS**: `POST /api/agent/companies/:id/cms-sync`
8. **Verify on CMS**: Log into CMS, check that contact + opportunity appear

### Test mode (safe testing)

```bash
# Enable test mode
curl -X PUT http://localhost:3000/api/agent/test-mode \
  -H "Authorization: Bearer agtok_..." \
  -H "Content-Type: application/json" \
  -d '{"enabled": true}'

# Add a test recipient
curl -X POST http://localhost:3000/api/agent/test-mode/recipients \
  -H "Authorization: Bearer agtok_..." \
  -H "Content-Type: application/json" \
  -d '{"email": "test@example.com"}'

# Now send email — it will go to test@example.com, not the real prospect
curl -X POST http://localhost:3000/api/agent/companies/123/send \
  -H "Authorization: Bearer agtok_..."
```

The email arrives at `test@example.com` with subject `[TEST]` and header `X-Test-Original-To: prospect@real.com`.

---

## Risoluzione problemi / Troubleshooting

### Service won't boot

**Symptom**: `npm run dev` shows DB connection error.

**Solution**:
- Verify `DATABASE_URL` is correct: `postgres://user:pass@host:port/db`
- Check PostgreSQL is running: `psql -U user -h host -d db -c "SELECT 1;"`
- Run migrations: `npm run migrate`

### Health check fails (503)

```bash
curl http://localhost:3000/health
```

**Symptom**: Returns 503 instead of 200.

**Solution**:
- DB is not reachable
- Check `DATABASE_URL` and PostgreSQL
- Check logs for `error connecting to database`

### CMS sync fails (warning log, no error)

**Symptom**: `POST /api/agent/companies/:id/cms-sync` succeeds locally but logs `best-effort: warning`.

**Solution**:
- Check `CMS_BASE_URL` is correct
- Verify `CMS_AGENT_TOKEN` is valid (re-generate on CMS if needed)
- Verify `CMS_SITE_ID` exists on the CMS
- Check CMS is reachable: `curl -H "Authorization: Bearer $CMS_AGENT_TOKEN" "$CMS_BASE_URL/api/agent/sites/$CMS_SITE_ID/pipelines"`

### Agent token returns 401 on /api/agent/* routes

**Symptom**: `curl -H "Authorization: Bearer agtok_..." http://localhost:3000/api/agent/me` returns 401.

**Solution**:
- Token is invalid or not found in DB
- Regenerate via `/admin/api-tokens` UI
- Ensure token exists in `api_tokens` table: `SELECT * FROM api_tokens WHERE token = 'agtok_...';`

### Draft generation fails (AI error)

**Symptom**: `POST /api/agent/companies/:id/draft` returns error.

**Solution**:
- Ensure company has `website`, `title`, `description` (not null/empty)
- Check `OPENROUTER_API_KEY` is valid: `curl https://api.openrouter.ai/api/v1/models -H "Authorization: Bearer $OPENROUTER_API_KEY"`
- Check logs for OpenRouter error details

### Email not sent (stays in email_queue as "pending")

**Symptom**: `GET /api/agent/email-queue` shows email with status `pending` for hours.

**Solution**:
- Cron job `processEmailQueue` runs every 1 minute; check logs for cron errors
- Check consent: `GET /api/agent/companies/:id/consent` — might be blocked by consent
- Check daily cap: `GET /api/agent/send-schedule` — might be at cap
- Check test_mode: `GET /api/agent/test-mode` — if active but no test recipients, email is blocked
- Check SMTP: ensure `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS` are correct

### Migrations fail (23502 NOT NULL violation)

**Symptom**: `npm run migrate` fails with "column 'tenant_id' of relation 'companies' violates not-null constraint".

**Solution**:
- Migration 087 backfills `tenant_id=1` for existing rows (not null anymore)
- If the backfill didn't run, run it manually:
  ```sql
  UPDATE companies SET tenant_id = 1 WHERE tenant_id IS NULL;
  UPDATE campaigns SET tenant_id = 1 WHERE tenant_id IS NULL;
  -- Repeat for all 9 core tables (see migration 087)
  ```
- Then re-run migrations: `npm run migrate`

---

## Risorse aggiuntive / Additional resources

- **AGENT.md** — Full API documentation, agent rules, MCP tools
- **MCP.md** — MCP server details, tool discovery, connection examples
- **docs/ARCHITECTURE.md** — System design, multi-tenancy, data flow
- **DEPLOY-CHECKLIST.md** — Production deployment checklist
- **README.md / README.it.md** — Project overview, features, stack

---

**Buona fortuna! / Good luck!** 🚀

Built for agent-first AI workflows. Keep the CMS in sync — that's where the value is.

---

**IT / EN Toggle**: This guide uses parallel sections for Italian (IT) and English (EN). Read the section that matches your language preference.
