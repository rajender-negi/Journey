# Product Journey

Live product performance for product teams and leadership: every change from merge to main through build, test, scan, staging, change approval, production and Dynatrace verification, with DORA, failure fixes, pre-deploy risk gates, codebase findings against official best practices, and a cost view.

Dynatrace is the hub. ServiceNow CMDB is the product identity. GitHub, Argo CD, Kubernetes, AWS and Azure fill in the rest. Nothing is written back to Dynatrace.

## Run it on a laptop

**Prerequisites:** Node.js 22 LTS (20+ works; CI uses 22) from nodejs.org, and Git. Check with `node -v` and `git --version`. Works on macOS, Windows and Linux.

**1. Get the code.** The repo is private, so sign in to GitHub first (`gh auth login`, GitHub Desktop, or a credential prompt on first clone).

```bash
git clone https://github.com/rajender-negi/Journey.git
cd Journey
```

**2. Install.** Pulls LangGraph, the LangChain model adapters, the MCP SDK, zod, TypeScript and tsx.

```bash
npm install
```

**3. Optional: verify.** Builds the UI, then runs 40 tests (engines, LangGraph agent with approval pause and resume, every API route).

```bash
npm test
```

**4. Start.** Builds the UI and starts the API and UI together.

```bash
npm start
```

Open http://localhost:8787. The console prints each source's tier; with no configuration all seven are `dummy`, the agent runs its rules path, and everything in the UI works, including **Investigate**.

**5. Connect real systems (any order, one at a time).**

```bash
cp .env.example .env                              # Windows: copy .env.example .env
cp mcp.servers.example.json mcp.servers.json      # Windows: copy mcp.servers.example.json mcp.servers.json
```

| To turn on | Set | Check |
|---|---|---|
| AI briefs and the model-driven agent | `AI_API_KEY` in `.env` (`AI_PROVIDER`, `AI_BASE_URL` for a gateway) | `GET /api/health` shows `ai.configured: true` |
| MCP tools for the agent | server URLs in `mcp.servers.json`; tokens in `.env`, referenced as `${env:VAR}` | `GET /api/agent/status` lists servers and tool counts |
| Collection through MCP | add the source under `"collect"` in `mcp.servers.json` | Sources view shows tier `mcp` |
| A source over its REST API | that source's block in `.env` (ServiceNow, GitHub, Dynatrace, Argo CD, Kubernetes, AWS, Azure) | Sources view shows tier `live`; compare `GET /api/raw/<source>` with `fixtures/raw/<source>.json` |

Restart `npm start` after changing `.env` or `mcp.servers.json`.

**6. Open it on your phone from the laptop (same Wi-Fi).** Find the laptop's IP (macOS: `ipconfig getifaddr en0`; Windows: `ipconfig`; Linux: `hostname -I`) and open `http://<laptop-ip>:8787` on the phone. Allow Node through the firewall if asked. There is no login yet, so do this only on a network you trust, or use Tailscale.

**Troubleshooting**

| Symptom | Fix |
|---|---|
| `EADDRINUSE :8787` | another process holds the port: set `PORT=8788` in `.env` |
| `npm install` 403 or ENOTFOUND | corporate proxy or registry policy: set `npm config set registry <your mirror>` or run in Codespaces |
| Agent status `langgraph: false` | `npm install` did not finish; rerun it |
| Agent step falls back to rules | model unreachable or slower than `AI_TIMEOUT_MS` (default 45000) |

**No laptop handy:** on GitHub, Code > Codespaces > Create codespace on main, then `npm start`; port 8787 opens in the browser (works from a phone).

## CI and Codespaces

`.github/workflows/ci.yml` runs on every pull request and push to `main`: install, typecheck, tests (the LangGraph wiring test runs here because CI installs the packages), build, and uploads the demo page as a build artifact. Actions are pinned to commit SHAs, the token is read-only, and `.github/dependabot.yml` keeps npm packages and actions current. `.devcontainer/` opens the repo in GitHub Codespaces with Node 22 and port 8787 forwarded, so you can run the app from a browser, including on a phone.

## One format, every device

The engines run once, on the server (or at build time for the demo). Their output is a compact **view model** (`packages/core/src/viewmodel.ts`) that every client renders with the same plain-JS UI (`apps/web/src/app.js`, ES2017, no framework, no external requests):

| Client | Gets the view model from | Size over the wire |
|---|---|---|
| Laptop or phone browser | `GET /api/vm`, gzipped, refreshed every 5 min | about 30 KB data + 14 KB UI |
| Published page in the Claude app (iPhone, Android, desktop) | embedded in the page | about 210 KB, one file |

`npm run build` writes both: `apps/web/dist/index.html` (served) and `apps/web/dist-demo/product-journey.html` (self-contained demo). AI briefs go to the server's LLM when served, and to Claude through the artifact runtime when opened in the Claude app; both fall back to the rules-only brief.

## Run it for real: MCP connections and the LangGraph agent

The app is an MCP client of your own MCP servers (the same ones Cursor uses), and runs a LangGraph agent that investigates failures through them.

1. `npm install` (adds LangGraph, LangChain model adapters, the MCP SDK and zod).
2. `cp mcp.servers.example.json mcp.servers.json` and fill in tenant URLs. Tokens come from `.env` via `${env:VAR}`.
3. In `.env`: `AI_API_KEY` (and `AI_PROVIDER`, `AI_BASE_URL` for a gateway). Without a key the agent runs its deterministic path.
4. `npm start`. The console prints each MCP server, its transport and tool count. `GET /api/agent/status` shows the same plus the audit trail of every MCP call.

**Collection through MCP.** Sources listed under `"collect"` in `mcp.servers.json` are pulled through MCP (tier `mcp` in the Sources view): Dynatrace runs the six DQL queries through `execute_dql`; Argo CD lists applications. Output is shaped into the same native payloads as the direct APIs, so the core mappers are unchanged. Other sources stay on direct API, Cursor snapshot or dummy tiers.

**The agent** (`packages/agent`), started from any failure in the Fixes or Journeys view (**Investigate**) or `POST /api/agent/investigate {findingId}`:

```
START > classify > plan > gather > hypothesize > verify --passed or exhausted--> recommend > approve (interrupt) > END
                    ^                               |
                    +-------- missing evidence -----+
```

| Node | What it does | Model? |
|---|---|---|
| classify | Builds context from the analysis: rule, product, service, namespace, commit, PR, deployment window, job id | no |
| plan | Picks evidence kinds from a fixed catalog; parameters always come from the analysis, never from the model | optional |
| gather | Fetches each kind through MCP: Dynatrace DQL (problem, error rate, p95 around the deploy, SDLC events), Argo CD app state, GitHub PR files and job logs, k8s events | no |
| hypothesize | Root cause chain, every step citing evidence ids | optional |
| verify | Deterministic: citations exist and returned data, runtime confirmation for deployment and problem failures, no figures absent from the evidence. Fails loop back to plan for missing evidence | no |
| recommend | Restore and prevention actions; any action citing a rule outside the evidence is dropped | optional |
| approve | `interrupt()`: the run pauses, checkpointed, until a person approves or rejects (`POST /api/agent/runs/<id>/resume`) | no |

Guardrails: MCP tools that look like writes are refused unless listed in `AGENT_WRITE_ALLOWLIST`; Dynatrace is never written to; every call is time-limited, size-capped and audited. Tool names differ across MCP server versions, so `packages/agent/src/toolmap.ts` lists candidates per operation and uses the first one the server exposes.

## Data tiers per source

Each of the seven sources resolves independently; the first available tier wins:

| Tier | When | How |
|---|---|---|
| live | credentials in `.env` | adapters in `apps/server/src/adapters` call the source API |
| live MCP | source listed under `"collect"` in `mcp.servers.json` | the app's own MCP client calls your MCP servers (Dynatrace DQL, Argo CD) |
| MCP snapshot | a Cursor agent pushed data | `POST /api/ingest/<source>` or a file in `data/inbox/<source>.json` |
| dummy | neither | seeded scenarios emitted in the source's native schema |

All three tiers produce the same native payloads (`fixtures/raw/*.json` is the contract) and go through the same mappers in `packages/core/src/sources.ts`. Moving a source from dummy to live changes configuration, not code. `GET /api/sources` shows the tier of each source; the Sources view shows a sample payload.

Tenant-specific names (custom CMDB fields, OpenPipeline enrichment attributes, the cost tag key) live in one place: `FIELD_MAP` in `sources.ts`.

## The six phases

| Phase | Engine | Output |
|---|---|---|
| 1 Signal capture | `apps/server/src/collector.ts`, `adapters/*`, `core/sources.ts` | one normalized dataset from 7 sources |
| 2 Journey and DORA | `core/journey.ts`, `core/dora.ts` | 8-stage journey per change, stage funnel, DORA with bands, Dynatrace reconciliation and drift |
| 3 Failures and prevention | `core/failures.ts`, `core/risk.ts` | classified failures with restore and prevention steps, problem-to-deployment correlation, risk score and gate for changes not yet in prod |
| 4 Codebase analysis | `core/codebase.ts` | file rules (containers, k8s, CI, code, IaC) and cross-signal rules that join code with Dynatrace runtime metrics (e.g. Redis cache-aside only when the read pattern proves it) |
| 5 Cost | `core/cost.ts` | spend by product and service, savings actions, anomalies, cost of failed changes, cost per 1k requests |
| 6 Best practices | `core/scorecard.ts` | scorecard across coding, design patterns, system design, architecture, security, tool integration; the rule catalog |

AI layer (`core/ai.ts`, `apps/server/src/ai.ts`): the rules decide what is wrong; the model explains, links evidence across sources and ranks actions. Every action must cite a rule id present in the evidence, or it is dropped. Without a key, or if validation fails, the rules-only brief is returned. Supports Anthropic and any OpenAI-compatible gateway.

Details: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/DESIGN.md](docs/DESIGN.md) (patterns used and the design advisor), [docs/PHASES.md](docs/PHASES.md).

## API

| Route | |
|---|---|
| `GET /api/vm` | the view model every client renders (gzipped) |
| `GET /api/sources` | tier and record count per source |
| `GET /api/overview?product=` | DORA, funnel, cost summary, open problems |
| `GET /api/journeys?product=` | journeys |
| `GET /api/dora?product=` | DORA |
| `GET /api/failures?product=` | failure findings with recommendations |
| `GET /api/risks?product=` | pre-deploy risk for in-flight changes |
| `GET /api/code?product=` | codebase findings |
| `GET /api/cost?product=` | cost summary and actions |
| `GET /api/scorecards`, `GET /api/guidance` | phase 6 |
| `GET /api/raw/<source>` | the raw native payload currently loaded |
| `POST /api/ingest/<source>` | MCP snapshot push (validated against the native shape) |
| `POST /api/collect` | re-collect now |
| `POST /api/ai/brief` | `{mode: finding|product|portfolio, target}` |

## Cursor

Copy `cursor-kit/.cursor` into the repo root. `mcp.json` lists the MCP servers (all read-only; replace placeholders with the servers approved in your MCP registry). `rules/product-journey.mdc` holds the agent rules. `cursor-kit/agents/` has the collector prompts and the investigation, codebase review and leadership brief prompts.

## What was verified and what was not

- Verified in CI (GitHub Actions, real packages installed): 40 tests pass, including the LangGraph graph pausing for approval and resuming, and the API agent route. Locally: core tests (schema round trip, all phases, AI contract) and end-to-end API tests (dummy tier, every route, gzipped view model, snapshot ingest with schema rejection, LLM path against a local OpenAI-compatible mock with invented rule ids dropped). UI checked in Chromium at iPhone 13 size with 4x CPU throttle and at laptop size, light and dark. Not checked on a physical iPhone.
- Agent: 11 tests of the agent logic (policy, MCP config and tool resolution, evidence planning, the full node sequence with the same routing as the graph, LLM path with invented rules dropped) and an API test. The LangGraph wiring test (pause for approval, resume) runs after `npm install`; it was skipped here because this sandbox has no npm registry access, so LangGraph, the LangChain adapters and the MCP SDK were not installed or executed here.
- Not verified against live systems: the adapters' calls to ServiceNow, GitHub, Dynatrace, Argo CD, Kubernetes, AWS and Azure. Field names follow each API's documented schema; DQL field names depend on your OpenPipeline configuration. Run one source live at a time and compare `GET /api/raw/<source>` with `fixtures/raw/<source>.json`.
