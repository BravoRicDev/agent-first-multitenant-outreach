# Architecture Overview

## Project Structure

```
outreach-service/
├── src/
│   ├── index.js                  # Express app entry point, route registration
│   ├── config.js                 # Configuration loader (env vars, defaults)
│   ├── db.js                     # PostgreSQL connection pool and query helpers
│   ├── middleware/               # Express middleware
│   │   ├── auth.js              # JWT validation, user/admin role checks
│   │   ├── agent-auth.js        # MCP/agent token validation
│   │   ├── i18n.js              # Language negotiation (lang param, Accept-Language)
│   │   ├── scope-tenant.js       # Tenant isolation (extracts tenant_id from JWT)
│   │   ├── validate.js          # Zod schema validation for request bodies
│   │   └── request-id.js        # Unique request ID generation
│   ├── routes/                   # API endpoint handlers
│   │   ├── auth.js              # Login, logout, magic links, JWT issuance
│   │   ├── campaigns.js         # Campaign CRUD, scheduling, sending
│   │   ├── cron.js              # Scheduled tasks (send queue, follow-ups, sync)
│   │   ├── mcp.js               # Model Context Protocol tools interface
│   │   ├── webhooks.js          # CMS webhook receiver (campaign updates, engagement)
│   │   ├── tenants-admin.js     # Tenant management (admin only)
│   │   ├── settings.js          # Per-tenant configuration
│   │   └── [others]             # Campaign sequences, search, IMAP, users, etc.
│   ├── services/                 # Business logic and integrations
│   │   ├── email.js             # Core email queueing and sending
│   │   ├── email-sender.js      # SMTP routing and retry logic
│   │   ├── cms.js               # agent-first CMS integration (bidirectional)
│   │   ├── funnel-metrics.js    # Campaign engagement analytics
│   │   ├── ai-copywriter.js     # Email draft generation (OpenRouter)
│   │   ├── ai-extraction.js     # Content extraction from web (OpenRouter, Groq)
│   │   ├── ai-validator.js      # Email validation (grammar, compliance)
│   │   ├── lead-scorer.js       # Lead qualification scoring
│   │   ├── consent.js           # GDPR consent tracking per-channel
│   │   ├── magic-link.js        # Time-limited authentication links
│   │   ├── csv-importer.js      # Bulk lead import from CSV
│   │   ├── imap-checker.js      # Email inbox monitoring (replies)
│   │   ├── cache.js             # Redis-like in-memory cache
│   │   ├── audit.js             # Audit log persistence
│   │   ├── logger.js            # Winston logger config
│   │   ├── settings.js          # Per-tenant settings and branding
│   │   └── [others]             # Lock manager, browser pool, address parser, etc.
│   └── validations/              # Zod schemas for request validation
│       └── schemas.js            # Reusable validation schemas
├── db/
│   ├── migrate.js               # Migration runner (idempotent)
│   └── migrations/              # SQL migration files (*.sql)
│       ├── 001_initial_schema.sql
│       ├── 002_tenants.sql
│       ├── [...]
│       └── 087_email_tracking.sql
├── tests/                        # Vitest unit and integration tests
├── locales/                      # i18n JSON files
│   ├── it.json                  # Italian translations
│   └── en.json                  # English translations
├── public/                       # Static assets (CSS, JS, images)
├── views/                        # EJS templates
├── docs/                         # Public documentation
├── .env.example                 # Environment variable template
├── package.json                 # Node.js dependencies and scripts
└── README.md                    # Project overview and quick start
```

## Core Concepts

### Multi-Tenancy (Enforced)

Every request is scoped to a tenant:

1. **Tenant Identification**
   - User logs in via `/auth/login` with email + password
   - Server issues JWT with `tenant_id` claim
   - Subsequent requests include JWT in Authorization header

2. **Tenant Resolution**
   - Middleware `scope-tenant.js` extracts `tenant_id` from JWT
   - Every database query includes `WHERE tenant_id = $1` filter
   - Cross-tenant access is impossible by design

3. **Tenant Data**
   - **tenants** table: List of all organizations
   - **users** table: User accounts, linked to tenants
   - **campaigns**, **contacts**, **metrics**, etc.: All include `tenant_id` FK

4. **Tenant Configuration**
   - **quota**: Max emails per day (enforced per tenant)
   - **test_mode**: Boolean flag; if true, emails are logged but not sent
   - **branding**: Customizable app name, footer, support links (overrides defaults)

**Example**: User "alice@acme.com" logs in → JWT contains `tenant_id: "acme"` → Only sees ACME's campaigns, contacts, and metrics. Cannot access "beta-corp" data even with a token.

### i18n (Internationalization)

Language selection via:
- Query parameter: `?lang=en`
- HTTP header: `Accept-Language: it`
- Default: Italian (via `DEFAULT_LANG` env var)

**Translation Files**:
- `locales/it.json`: Italian key-value map
- `locales/en.json`: English key-value map

**Usage in Templates**:
```ejs
<!-- Before (hardcoded) -->
<h1>Errore di caricamento</h1>

<!-- After (i18n) -->
<h1><%= i18n.error.load %></h1>
```

**Usage in Routes**:
```javascript
// req.i18n is populated by i18n middleware
res.render('error', { message: req.i18n.error.generic });
```

Adding a new language:
1. Create `locales/fr.json` (copy from it.json)
2. Translate all keys
3. Register language in `middleware/i18n.js`
4. Access with `?lang=fr`

### Email & Funnel Flow

```
1. Campaign Creation
   └─ User defines list of contacts, email template, schedule

2. Consent Check
   └─ Query consent table: is contact opted-in for this channel?
   └─ If not, skip email (log as "consent rejected")

3. Email Queueing
   └─ service/email.js: Validate email, apply rate limits, add to queue
   └─ Check tenant quota (emails today vs. active_quota)

4. SMTP Routing
   └─ service/email-sender.js: Dequeue, select SMTP route, send
   └─ Log delivery status (sent, bounced, failed)
   └─ Retry failed emails (exponential backoff, max 3 attempts)

5. Funnel Tracking
   └─ Webhook receiver (routes/webhooks.js) processes CMS engagement events
   └─ Events: open, click, reply, conversion
   └─ service/funnel-metrics.js: Aggregate and store metrics

6. Analytics Dashboard
   └─ Endpoint `GET /api/campaigns/{id}/funnel` returns:
      - Total sent, opened, clicked, replied
      - Funnel conversion rates
      - Per-contact journey (if tracked)
```

**Key Files**:
- `services/email.js` — Email queueing and validation
- `services/email-sender.js` — SMTP routing and retry
- `services/funnel-metrics.js` — Analytics aggregation
- `services/consent.js` — GDPR consent enforcement
- `routes/webhooks.js` — CMS webhook handler

### CMS Integration

Bi-directional sync with the agent-first CMS (or compatible headless CMS):

**Outbound** (Outreach → CMS):
- Push engagement metrics (opens, clicks, replies) back to CMS
- Update contact status in CMS (e.g., "engaged", "unsubscribed")
- CMS polls or receives webhooks from outreach service

**Inbound** (CMS → Outreach):
- CMS sends webhook when campaign is created/updated
- Outreach service receives in `routes/webhooks.js`
- Parse campaign data, create/update local record
- Sync contacts from CMS contact lists

**Configuration**:
```
CMS_BASE_URL=https://cms.example.com
CMS_AGENT_TOKEN=agtok_xxxxx  # Service-scoped token
CMS_SITE_ID=1                 # CMS site ID
```

**Key Files**:
- `services/cms.js` — CMS API client and bidirectional sync
- `routes/webhooks.js` — Webhook receiver

### AI Tools (Agent/MCP Surface)

Model Context Protocol (MCP) tools allow AI agents to orchestrate complex workflows:

**Available Tools** (examples):
- `extract_leads` — Parse web pages, extract lead emails
- `score_leads` — Rate leads by ICP fit (via AI model)
- `draft_email` — Generate personalized email copy (via OpenRouter)
- `validate_email` — Check grammar and compliance (via AI)
- `sync_to_cms` — Push results back to CMS
- `list_campaigns` — Query campaigns within tenant scope

**Access**: POST `/api/mcp` with agent JWT token

**Example Workflow**:
1. Agent calls `extract_leads` (via scraper) → list of emails
2. Agent calls `score_leads` (via AI model) → ranked leads
3. Agent calls `draft_email` for top 10 leads → personalized drafts
4. Agent calls `sync_to_cms` → push to CMS contact list

See [`AGENT.md`](../AGENT.md) and [`MCP.md`](../MCP.md) for detailed tool documentation.

## Data Layer

### PostgreSQL Schema

**Key Tables**:

| Table | Purpose | Tenant Scoped |
|-------|---------|---------------|
| `tenants` | Organizations/workspaces | No (system-wide) |
| `users` | User accounts | Yes (FK: tenant_id) |
| `campaigns` | Outreach campaigns | Yes |
| `campaign_sequences` | Email sequence definitions | Yes |
| `contacts` | Lead/contact records | Yes |
| `contact_consents` | GDPR consent per contact/channel | Yes |
| `emails` | Sent email log | Yes |
| `email_events` | Tracking events (open, click, reply) | Yes |
| `funnel_metrics` | Aggregated campaign metrics | Yes |
| `audit_logs` | Action audit trail | Yes |
| `api_tokens` | Service API tokens | Yes |

**Migrations**:
- Located in `db/migrations/`
- Named by sequence: `001_*.sql`, `002_*.sql`, etc.
- **Idempotent**: Safe to re-run; migrations check "table exists" before creating
- Run with `npm run migrate` (loads migration runner from `db/migrate.js`)

### Query Patterns

All queries must filter by `tenant_id`:

```javascript
// ✅ Correct
const result = await query(
  'SELECT * FROM campaigns WHERE tenant_id = $1 AND id = $2',
  [tenantId, campaignId]
);

// ❌ Wrong (would expose cross-tenant data in production)
const result = await query(
  'SELECT * FROM campaigns WHERE id = $1',
  [campaignId]
);
```

Tenant ID is extracted from JWT in middleware and passed to route handlers as `req.tenantId`.

## Middleware Stack

**Request Flow**:
```
1. requestId           → Assign unique request ID
2. helmet              → Security headers
3. express.json        → Parse JSON body
4. cookieParser        → Parse cookies
5. envCheck            → Verify critical env vars
6. auth                → Validate JWT (if required by route)
7. scopeTenant         → Extract tenant_id from JWT
8. i18n                → Negotiate language, load translations
9. validate            → Validate request body against Zod schema
10. Route Handler      → Process request (campaigns, emails, etc.)
```

**Key Middleware**:

- **auth.js**: `requireAuth` (check JWT), `requireAdmin` (check admin role)
- **scope-tenant.js**: Extract `tenant_id` from JWT, attach to `req.tenantId`
- **i18n.js**: Load language, attach translations to `req.i18n`
- **validate.js**: Validate request body with Zod schemas
- **agent-auth.js**: Special auth for MCP/agent tokens

## Error Handling

**Validation Errors** (Zod):
```javascript
if (!schema.safeParse(req.body).success) {
  res.status(400).json({ error: 'Invalid input', details: [...] });
}
```

**Auth Errors**:
```javascript
// 401 Unauthorized (no token or expired)
// 403 Forbidden (insufficient permissions)
```

**Tenant Scope Errors**:
```javascript
// 403 if tenant_id is missing or invalid
```

**Application Errors**:
```javascript
// 500 Internal Server Error (with request ID logged)
// Use winston logger: logger.error('message', { requestId, tenantId, ... })
```

All errors are logged with request context (ID, tenant, user) for debugging.

## Testing

**Test Suite**: Vitest (112+ tests)

**Coverage**:
- Core services (tenants, consent, funnel metrics, email queueing)
- Middleware (auth, i18n, tenant scope)
- API routes (campaigns, settings, admin endpoints)

**Run Tests**:
```bash
npm test              # Run once
npm run test:watch   # Run in watch mode
```

**Test Structure**:
```
tests/
├── services/
│   ├── consent.test.mjs
│   ├── email.test.mjs
│   └── funnel-metrics.test.mjs
├── middleware/
│   └── scope-tenant.test.mjs
└── routes/
    └── campaigns.test.mjs
```

**Patterns**:
- Unit tests for services (mock DB with vitest mocks)
- Integration tests for routes (use test database if needed)
- Mock external APIs (OpenRouter, CMS, SMTP)

## Deployment

### Environment Setup

1. **Copy `.env.example` to `.env`**
   ```bash
   cp .env.example .env
   ```

2. **Configure variables** (see `README.md` → Configuration)
   - Database URL (must be accessible)
   - JWT secret (generate: `openssl rand -hex 32`)
   - Email/SMTP credentials
   - API keys (OpenRouter, Serper, etc.)
   - CMS URL and token

3. **Run migrations**
   ```bash
   npm run migrate
   ```

4. **Start service**
   ```bash
   npm start
   ```
   - Listens on `PORT` (default 3000)
   - Health check: `GET /health` → 200 OK

### Docker

Dockerfile is provided for containerized deployment:

```bash
docker build -t outreach-service:latest .
docker run -p 3000:3000 --env-file .env outreach-service:latest
```

See `docker-compose.yml` for full stack (service + PostgreSQL + Redis).

## Security

**Key Protections**:

1. **Tenant Isolation**
   - Every query filters by `tenant_id` (enforced in middleware)
   - JWTs contain tenant claim; must match request scope

2. **Authentication**
   - JWT-based (issued on login with magic link or password)
   - Tokens expire after `JWT_EXPIRES_IN` (default 24h)

3. **Authorization**
   - Role-based access control (admin vs. user)
   - Endpoints check `req.user.role`

4. **Consent Enforcement**
   - GDPR consent required before sending email
   - Consent table logs opt-in/opt-out events

5. **Rate Limiting**
   - Global API rate limiter (200 req/15min)
   - Stricter MCP rate limiter (120 req/min)
   - Heavy operations rate limiter (5 req/min)

6. **Input Validation**
   - All request bodies validated with Zod schemas
   - Prevents injection attacks

7. **Secrets**
   - JWT_SECRET, API keys, DB passwords → environment variables only
   - Never hardcoded; `.env` excluded from git

## Performance Notes

- **Caching**: `services/cache.js` provides in-memory cache (used for config, locales)
- **Connection Pool**: PostgreSQL pool configured in `src/db.js` (min 2, max 10 connections)
- **Async Processing**: Email sending is async; cron jobs handle background tasks
- **Indexes**: DB migrations include indexes on frequently queried columns (tenant_id, created_at)

## Extending the Service

### Adding a New Route

1. Create `src/routes/my-feature.js`:
   ```javascript
   import express from 'express';
   import { requireAuth } from '../middleware/auth.js';

   const router = express.Router();

   router.get('/my-feature', requireAuth, (req, res) => {
     const { tenantId, i18n } = req;
     res.json({ message: i18n.feature.success });
   });

   export default router;
   ```

2. Register in `src/index.js`:
   ```javascript
   import myFeatureRoutes from './routes/my-feature.js';
   // ...
   app.use('/api', myFeatureRoutes);
   ```

3. Add tests in `tests/routes/my-feature.test.mjs`

### Adding a New Service

1. Create `src/services/my-service.js`:
   ```javascript
   export async function doSomething(tenantId, data) {
     // business logic, filtered by tenantId
   }
   ```

2. Import and use in routes or other services

3. Add unit tests in `tests/services/my-service.test.mjs`

### Adding a New i18n Locale

1. Copy `locales/it.json` to `locales/xx.json` (where `xx` is language code)
2. Translate all keys
3. Register in `src/middleware/i18n.js`
4. Test with `?lang=xx`

### Adding a New Database Table

1. Create `db/migrations/NNN_my_table.sql` (increment NNN)
2. Ensure migration is **idempotent** (checks existence)
3. Run `npm run migrate` to apply
4. Use in queries via `src/db.js` connection pool

---

**For more details, see README.md, AGENT.md, and MCP.md.**
