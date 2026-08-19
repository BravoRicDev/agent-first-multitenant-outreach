🇬🇧 English · 🇮🇹 [Italiano](README.it.md)

# Outreach Service

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Tests](https://img.shields.io/badge/Tests-112%20passing-brightgreen)]()
[![Node.js](https://img.shields.io/badge/Node.js-18+-green)]()

A **multi-tenant B2B outreach platform** complementary to a headless CMS, built for enterprise email campaigns, lead scoring, and engagement funnel analytics.

## Features

- **Multi-Tenant Architecture**: Enforced tenant isolation, per-tenant quota and test modes, strict data partitioning
- **GDPR Consent Management**: Per-channel consent tracking, audit logs, consent-driven email delivery
- **Funnel Analytics**: Real-time campaign metrics (opens, clicks, replies), funnel flow analysis
- **Email Orchestration**: Multi-channel (SMTP) with routing rules, scheduled sends, retry policies, magic-link auth
- **AI-Powered Tools**: Lead scoring, email copywriting, content extraction via OpenRouter, Groq
- **CMS Integration**: Bi-directional sync with the agent-first CMS (or compatible headless CMS), webhook-driven updates
- **Agent/MCP Surface**: Model Context Protocol tools for AI agent workflows, extensible tool registry
- **Internationalization**: Full i18n support (Italian/English), runtime language switching
- **Scheduling & Automation**: Cron-based campaigns, email sequences, bulk operations, async task processing

## Stack

- **Runtime**: Node.js 18+
- **Framework**: Express.js, EJS templating
- **Database**: PostgreSQL (migrations, idempotent)
- **Testing**: Vitest (112+ tests covering core services)
- **External APIs**: OpenRouter (AI models), Serper (search), Groq, SMTP
- **Security**: Helmet, bcryptjs, JWT, rate limiting

## Architecture

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
│ ├─ CMS Sync (agent-first, webhooks, bidirectional)        │
│ └─ Cron Jobs (campaigns, cleanup, notifications)      │
├─────────────────────────────────────────────────────────┤
│ Data Layer                                              │
│ ├─ PostgreSQL (89 migrations, all idempotent)        │
│ └─ Tenant-scoped queries (tenant_id filtering)        │
└─────────────────────────────────────────────────────────┘
```

**Core Flow**:
1. **Campaign Creation**: Define outreach lists, email templates, sequences
2. **Consent Enforcement**: Check GDPR consent per contact, per channel
3. **Email Delivery**: Route to SMTP, schedule sends, collect metrics
4. **Funnel Tracking**: Monitor opens, clicks, replies, conversions
5. **CMS Sync**: Push engagement data back to CMS, receive updates via webhooks
6. **Agent Tools**: Extend with AI-driven workflows (lead scoring, copywriting, extraction)

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for detailed component breakdown.

## Getting Started

### Prerequisites

- **Node.js** 18+ (verify: `node --version`)
- **PostgreSQL** 12+ (local dev or Docker)
- **npm** 9+

### Installation

```bash
# Clone the repository
git clone <repo-url>
cd outreach-service

# Install dependencies
npm install

# Copy environment template
cp .env.example .env

# Edit .env with your configuration (see Configuration section below)
```

### Database Setup

```bash
# Run migrations (idempotent, safe to re-run)
npm run migrate

# Verify: check PostgreSQL for schema and tables
```

### Running Locally

```bash
# Development mode (auto-reload with --watch)
npm run dev

# Production mode
npm start

# Verify: test endpoints
curl http://localhost:3000/health
# Expected: 200 OK
```

### Testing

```bash
# Run all tests (112 test cases)
npm test

# Run in watch mode (re-run on file change)
npm run test:watch
```

## Configuration

### Environment Variables

Copy `.env.example` to `.env` and configure the following (never commit `.env` with real values):

| Variable | Required | Description | Example |
|----------|----------|-------------|---------|
| `PORT` | Yes | Express server port | `3000` |
| `NODE_ENV` | Yes | Environment (development, production) | `production` |
| `DATABASE_URL` | Yes | PostgreSQL connection string | `postgres://user:pass@host:5432/db` |
| `JWT_SECRET` | Yes | JWT signing key (64+ random bytes, hex) | `(generated)` |
| `JWT_EXPIRES_IN` | No | JWT token expiry | `24h` |
| `OPENROUTER_API_KEY` | Yes | OpenRouter API key for AI models | `sk-or-v1-...` |
| `SMTP_HOST` | Yes | SMTP server (mail delivery) | `smtp.example.com` |
| `SMTP_PORT` | Yes | SMTP port (usually 465 or 587) | `465` |
| `SMTP_USER` | Yes | SMTP username | — |
| `SMTP_PASS` | Yes | SMTP password | — |
| `EMAIL_FROM` | Yes | Default from address (notifications) | `noreply@example.com` |
| `MAGIC_LINK_BASE_URL` | Yes | Base URL for magic link generation | `https://example.com` |
| `CMS_BASE_URL` | Yes | agent-first CMS instance URL | `https://cms.example.com` |
| `CMS_AGENT_TOKEN` | Yes | CMS API token (scoped to service) | `agtok_...` |
| `CMS_SITE_ID` | Yes | CMS site ID | `1` |
| `LOG_LEVEL` | No | Winston log level | `info` |

### Branding

The following variables allow per-tenant branding (overridable via admin panel):

```
OUTR_APP_NAME=Outreach Service
OUTR_DEFAULT_FROM_NAME=Outreach Service
OUTR_SUPPORT_EMAIL=support@example.com
OUTR_SUPPORT_URL=https://support.example.com
OUTR_FOOTER_COMPANY=Your Company
OUTR_FOOTER_VAT=IT12345678
```

These are defaults; individual tenants can customize via `/admin/settings`.

## Multi-Tenancy

This service is **enforced multi-tenant** — every request is scoped to a tenant:

- **Tenant Identification**: Via JWT claim `tenant_id`, extracted from token header
- **Tenant Catalog**: Stored in `tenants` table; accessed via `/admin/tenants` (admin-only)
- **Quota Management**: Each tenant has `active_quota` (max concurrent emails per day) and `test_mode` flag
- **Data Partitioning**: All tables include `tenant_id` foreign key; queries filter by tenant
- **Enforcement**: Middleware `scope-tenant.js` rejects cross-tenant access

Example: A request with JWT containing `{ tenant_id: "acme" }` can only access ACME's campaigns, contacts, and metrics.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) → "Multi-Tenancy" section for implementation details.

## Internationalization (i18n)

The UI and emails support **Italian (it) and English (en)** at runtime:

- **Locales**: JSON files in `locales/` directory (`it.json`, `en.json`)
- **Selection**: Via query param `?lang=en` or browser language preference (Accept-Language header)
- **Default**: Italian (configurable via `DEFAULT_LANG` env var)
- **Language Switcher**: UI includes toggle in header

### Adding a New Language

1. Create `locales/fr.json` (copy from `locales/it.json` as template)
2. Translate all key-value pairs
3. Update middleware in `src/middleware/i18n.js` to register `fr`
4. Test with `?lang=fr`

Translations cover:
- UI labels, buttons, messages
- Error messages
- Email templates
- Admin panel

## Agent & MCP Surface

This service exposes a **Model Context Protocol (MCP)** interface for AI agent workflows:

- **Endpoint**: `POST /api/mcp` (requires `Authorization: Bearer <JWT>`)
- **Tools**: Extensible set of tools for lead scoring, email copywriting, content extraction, CMS queries
- **Example**: An agent can call `extract_leads`, `score_leads`, `draft_email`, and `sync_to_cms` as atomic operations

See [`AGENT.md`](AGENT.md) and [`MCP.md`](MCP.md) for tool documentation and examples.

## Contributing

This is an open-source project. Contributions are welcome:

1. **Fork** the repository
2. **Branch**: Create a feature branch (`git checkout -b feature/my-feature`)
3. **Commit**: Follow conventional commits (`feat:`, `fix:`, `docs:`, etc.)
4. **Test**: Ensure `npm test` passes locally
5. **Push** and open a **Pull Request**

For large changes, please open an issue first to discuss the approach.

### Code Style

- **Format**: ESLint/Prettier (run `npm run lint:fix` if configured)
- **Testing**: All changes to core services should include unit or integration tests
- **Commits**: Conventional Commits (`feat(i18n): ...`, `fix(smtp): ...`, etc.)

## License

This project is licensed under the [MIT License](LICENSE) — see `LICENSE` file for details.

## Support

- **Issues**: Report bugs or request features via GitHub Issues
- **Documentation**: See `docs/` directory for architecture, API references, and guides
- **Email**: For inquiries, contact the maintainers (details in `CONTRIBUTING.md` if provided)

---

**Built with ❤️ for modern, tenant-aware outreach automation.**
