# MCP.md — Server MCP del servizio outreach / Outreach service MCP server

## ⚠️ Natura del servizio / Nature of the service
> Questo server MCP è la superficie agent di `outreach-service`: un servizio **indipendente
> e autonomo** (gira e risponde anche senza il CMS collegato), ma **complementare per
> significato** al CMS agent-first. Il servizio dietro questi tool si collega al CMS via API agent
> (`CMS_BASE_URL`, `CMS_AGENT_TOKEN`, `CMS_SITE_ID`) per sincronizzare contatti, consenso,
> opportunità e opt-out condivisi; senza quel collegamento l'outreach funziona ma **perde il suo
> scopo principale** (alimentare il CRM). I tool di bridge (`companies_cms_sync`, consenso,
> opt-out) esistono proprio per mantenere servizio e CMS coordinati: usali invece di tenere
> stato locale parallelo. Nota anche l'asimmetria di tenancy: questo servizio è **single-tenant
> per istanza** (un solo `CMS_SITE_ID`), il CMS è **multi-tenant** (un `site_id` per sito) — vedi
> `AGENT.md` (sezioni "PRIMA DI TUTTO" e "Modello tenant") e `DEPLOY-CHECKLIST.md`.
>
> *(EN) This MCP server is the agent surface of `outreach-service`: an **independent,
> self-contained service** (it runs and responds even without the CMS wired up), but
> **complementary in purpose** to the agent-first CMS. It wires to the CMS via its agent API to keep
> contacts, consent, opportunities and opt-out in sync; without that link the service still
> works but loses its main purpose (feeding the CRM). Use the bridge tools instead of parallel
> local state. Also note the tenancy asymmetry: this service is **single-tenant per instance**
> (one `CMS_SITE_ID`), the CMS is **multi-tenant** (one `site_id` per site).*

## Cos'è / What it is

Il servizio espone un server **MCP (Model Context Protocol) Streamable HTTP, stateless**
all'endpoint `/api/mcp` (`src/routes/mcp.js`). Ogni tool MCP è un proxy interno 1:1 verso il
relativo endpoint `/api/agent/...` (`src/services/mcp-tools.js`): stesso comportamento, stessa
autenticazione, stesse regole — nessuna logica duplicata.

*(EN)* The service exposes a **stateless Streamable HTTP MCP server** at `/api/mcp`. Every MCP
tool is a 1:1 internal proxy to the matching `/api/agent/...` endpoint: same behavior, same auth,
same rules — no duplicated logic.

## Come connettersi / How to connect

- **Endpoint**: `POST /api/mcp` (Streamable HTTP transport, `@modelcontextprotocol/sdk`).
- **Auth**: header `Authorization: Bearer agtok_...` — stesso api-token agente usato per
  `/api/agent/*` (vedi `AGENT.md` per come ottenerlo). Senza header valido, ogni chiamata tool
  ritorna un errore MCP (`isError: true`), non una connessione negata a livello di trasporto —
  il client MCP deve comunque includere sempre l'header.
- **Rate limit**: dedicato su `/api/mcp` (analogo a quello su `/api/agent`), con skip per traffico
  loopback interno (il proxy stesso chiama `127.0.0.1:<port>` per eseguire il tool).

Esempio client generico (pseudo-codice):

```
client = MCPClient(url="https://<host>/api/mcp", headers={"Authorization": "Bearer agtok_..."})
tools = client.list_tools()
result = client.call_tool("companies_ingest", {"email": "prospect@example.com", "title": "..."})
```

## Modello tenant / Tenancy model

- **Outreach = single-tenant per istanza**: questa istanza del server MCP è configurata con **un
  solo** `CMS_SITE_ID` e parla con **un solo** sito CMS. Non esiste un parametro `site_id` nei
  tool esposti qui: è implicito nella configurazione dell'istanza.
- **CMS = multi-tenant**: un unico deploy CMS serve più siti, ognuno con `site_id` proprio ed
  endpoint agent scoping per sito.
- Per lavorare su più siti CMS servono **più istanze** di questo server MCP (una per
  `CMS_SITE_ID`), ciascuna con il proprio api-token agente locale. Diventare multi-tenant è
  un'estensione futura possibile (il bridge `cms.js` già accetta `siteId` per funzione) ma non
  implementata: vedi `AGENT.md` → "Modello tenant".

*(EN)* This MCP server instance is single-tenant (one `CMS_SITE_ID`); the CMS is multi-tenant
(one `site_id` per site). Multiple CMS sites require multiple MCP server instances, one per
`CMS_SITE_ID`. See `AGENT.md` → "Tenancy model" for the full picture.

## Discovery: come sono generati i tool / How tools are generated

`src/services/mcp-tools.js` introspeziona il router reale `src/routes/agent.js` (`agentRouter.stack`),
iterando ogni rotta il cui path inizia con `/api/agent`. Per ogni endpoint:

- Se esiste una entry in `TOOL_META` (chiave `"METODO /path/:param"`), il tool usa nome, descrizione
  bilingue ({en, it}) e `inputSchema` (Zod) da lì.
- Se manca la entry, il tool esiste comunque con **schema generico** (parametri path convertiti in
  snake_case + campo libero `extra`) e descrizione fallback — mai un endpoint "invisibile" a MCP.

Questo significa che **ogni endpoint aggiunto a `agent.js` compare automaticamente come tool** al
prossimo riavvio, senza bisogno di aggiornare `mcp.js`. Aggiungere una entry `TOOL_META` è
raccomandato ma non obbligatorio.

## Conteggio e lista tool principali / Tool count and main tools

Al momento della stesura di questo documento: **25 tool**, tutti con `TOOL_META` dedicata
(nessuno schema generico). Elenco per area:

| Area | Tool name | Endpoint |
|---|---|---|
| Identità | `me` | `GET /api/agent/me` |
| Campagne | `campaigns_list`, `campaigns_get`, `campaigns_stato` | `GET /api/agent/campaigns[...]` |
| Programmazione | `send_schedule_get` | `GET /api/agent/send-schedule` |
| Prospect | `companies_list`, `companies_search`, `companies_ingest`, `companies_get`, `companies_update` | `/api/agent/companies[...]` |
| Bozza email | `companies_draft_generate`, `companies_draft_get` | `/api/agent/companies/:id/draft` |
| Invio | `companies_send` | `POST /api/agent/companies/:id/send` |
| Consenso | `companies_consent_get`, `companies_optout` | `/api/agent/companies/:id/consent`, `.../optout` |
| Bridge CMS | `companies_cms_sync` | `POST /api/agent/companies/:id/cms-sync` |
| **Funnel B2B** | `companies_call_outcome`, `companies_funnel_stage_set`, `companies_booking_set` | `.../call-outcome`, `.../funnel-stage`, `.../booking` |
| Coda | `email_queue_list` | `GET /api/agent/email-queue` |
| **Modalità test** | `test_mode_get`, `test_mode_set`, `test_mode_recipient_add`, `test_mode_recipient_remove` | `/api/agent/test-mode[...]` |
| **Metriche funnel** | `funnel_metrics` | `GET /api/agent/funnel-metrics` |

I quattro tool "Modalità test" implementano il requisito 7 (sicurezza invii): `test_mode_get` è
lettura libera, gli altri tre richiedono il permesso `settings`/update sull'utente a cui è legato
il token agente (RBAC speculare, stessa `roles_permissions` dell'admin UI — vedi `AGENT.md`
§Permessi agenti). `funnel_metrics` implementa il requisito 10 (metriche + alert): stessa funzione
di calcolo (`src/services/funnel-metrics.js`) usata anche dal cron `funnelAlerts`.

I tre tool "Funnel B2B" (introdotti per coprire i gap "setting telefonico" e
"booking videocall" del funnel B2B, vedi `GAP-ANALYSIS-FUNNEL.md` nella cartella
padre del progetto) fanno avanzare `companies.funnel_stage`
(`prospect→contacted→called→booked→demo→won/lost`) e, quando l'esito è positivo,
garantiscono (best-effort) un'opportunità sul CMS via `ensureOpportunityForStage`
— stessa risoluzione pipeline/stage-map di `companies_cms_sync`, ma con uno
`stageKey` dedicato (`interessato`, `booked`, `demo`) cercato nella
`cms_stage_map` della campagna.

Per verificare la lista aggiornata in ogni momento (senza dover leggere il codice):

```js
import { discoverTools } from "./src/services/mcp-tools.js";
console.log(discoverTools("it").map(t => `${t.method} ${t.path} -> ${t.name}`));
```

## Regole operative

Le stesse regole di `AGENT.md` si applicano identiche via MCP, perché ogni tool esegue
esattamente la stessa richiesta HTTP verso `/api/agent/...`:

- mai inviare senza consenso adeguato (cold → solo `companies_send`, mai in automatico);
- opt-out condiviso col CMS, sempre rispettato (`companies_optout`);
- daily cap e fascia oraria rispettati dalla coda/cron, riportati nella risposta di `companies_send`;
- preferisci `companies_list`/`companies_search` con filtri a loop massivi su tutti i tool;
- non duplicare il CRM: usa `companies_cms_sync` invece di stato locale parallelo;
- `companies_ingest` inietta dati già scrappati, non fa scraping.

Vedi `AGENT.md` per la tabella endpoint completa e il flusso ingest → draft → leggi → invia.
