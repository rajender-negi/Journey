# System design and design patterns

Two halves: the patterns this codebase is built on, and the advisor that recommends patterns to each product. Both cite official or canonical sources only.

## Part 1: how this app is designed

| Pattern | Where in the code | Why it is used | Reference |
|---|---|---|---|
| Hexagonal architecture (ports and adapters) | `packages/core` is pure TypeScript with no I/O; `apps/server/src/adapters` and `packages/agent/src/mcp/hub.ts` are the adapters | Engines are tested without any live system; a source moves from dummy to REST to MCP without touching an engine | [Cockburn](https://alistair.cockburn.us/hexagonal-architecture/) |
| Anti-corruption layer | `core/sources.ts` mappers and `FIELD_MAP` | Vendor schemas (Grail records, Table API rows, Cost Explorer groups) and tenant custom fields stop at one boundary | [Azure Architecture Center](https://learn.microsoft.com/en-us/azure/architecture/patterns/anti-corruption-layer) |
| Pipes and filters | collect, map, analyze, view model | Each stage is a pure function over the previous output, independently testable | [Azure Architecture Center](https://learn.microsoft.com/en-us/azure/architecture/patterns/pipes-and-filters) |
| Gateway aggregation | collector joins seven sources on the CMDB | Clients make one call, never seven | [Azure Architecture Center](https://learn.microsoft.com/en-us/azure/architecture/patterns/gateway-aggregation) |
| Backends for frontends + CQRS read model | `core/viewmodel.ts`, `GET /api/vm` | One compact precomputed read model (about 30 KB gzipped) serves phone, laptop and the embedded demo; collection (write side) is separate from reads | [BFF](https://learn.microsoft.com/en-us/azure/architecture/patterns/backends-for-frontends), [CQRS](https://learn.microsoft.com/en-us/azure/architecture/patterns/cqrs) |
| Cache-aside | view model cached per collection | Repeated reads cost nothing until data changes | [Azure Architecture Center](https://learn.microsoft.com/en-us/azure/architecture/patterns/cache-aside) |
| Specification + chain of responsibility | `FAILURE_RULES`, `FILE_RULES`, first match wins | Rules are data: add a rule and its test without changing the engine | [Evans and Fowler](https://martinfowler.com/apsupp/spec.pdf) |
| Strategy with fallback | collection tiers: live API, live MCP, snapshot, dummy | Each source degrades independently; one outage never blanks the dashboard | [AWS Builders Library](https://aws.amazon.com/builders-library/timeouts-retries-and-backoff-with-jitter/) |
| Gatekeeper + least privilege | `agent/policy.ts`: read-only MCP, write allowlist, Dynatrace never writable | The agent cannot change a source system on its own | [Gatekeeper](https://learn.microsoft.com/en-us/azure/architecture/patterns/gatekeeper), [OWASP LLM Top 10](https://owasp.org/www-project-top-10-for-large-language-model-applications/) |
| Deterministic-first AI | rules classify; the LLM only picks evidence kinds, explains and ranks; outputs validated against evidence | No invented causes, queries or rule ids reach a user | [OWASP LLM Top 10](https://owasp.org/www-project-top-10-for-large-language-model-applications/) |
| State machine with human in the loop | `agent/graph.ts`: LangGraph StateGraph, checkpointer, `interrupt()` before approval | Runs are inspectable step by step and pause for a person | [LangGraph.js](https://github.com/langchain-ai/langgraphjs) |
| Open protocol for tools | McpHub over stdio, Streamable HTTP, SSE | The same MCP servers serve Cursor and the app | [MCP specification](https://modelcontextprotocol.io/specification) |
| Twelve-factor config | `.env`, `mcp.servers.json`, `apps/server/src/config.ts` | Same build in every environment; no secrets in code | [12factor.net](https://12factor.net/config) |

Quality attributes and the decisions behind them:

- **Reliability:** per-source timeouts and tier fallback; MCP calls time-limited and size-capped; agent loop capped by `AGENT_MAX_ITERATIONS`.
- **Security:** tokens stay on the server; read-only by default; write-looking tools refused; secrets masked in findings; no login yet, so deploy behind VPN or Tailscale until SSO is added.
- **Performance:** engines run once per collection, not per request; the UI is plain ES2017 with no framework and receives one gzipped JSON.
- **Testability:** pure core and pure agent nodes; native-schema fixtures exercise the same mappers live data uses.
- **Evolvability:** new source = adapter + mapper + fixture; new rule = rule entry + test; new MCP server version = tool-map candidate.

## Part 2: the design advisor (one best recommendation per product)

`packages/core/src/patterns.ts` maps every rule to one named pattern from official guidance, groups a product's evidence by pattern, and ranks:

```
Priority = Severity x Evidence x Reach x Criticality + Savings
  Severity     worst contributing rule: critical 5, high 3, medium 2, low 1
  Evidence     1.0 static finding, 1.5 confirmed by runtime telemetry, 2.0 caused production or delivery failures
  Reach        1 + log2(1 + occurrences)
  Criticality  CMDB tier 1: 1.5, tier 2: 1.2, tier 3: 1.0
  Savings      monthly saving unlocked / 2000, capped at 3
Gate: an open critical security exposure always ranks first.
```

Root-cause linkage: a latency regression whose Dynatrace evidence shows database calls per request rising credits the chatty-I/O fix when code and runtime already show N+1, so the advisor recommends the root fix, not only the delivery control that would have caught it.

| Pattern | Resolves rules | Reference |
|---|---|---|
| Cache-aside | ARCH-CACHE-ASIDE, database downsize saving | Azure Architecture Center; AWS Redis caching whitepaper |
| Avoid chatty I/O | CODE-N-PLUS-ONE, RUNTIME-CHATTY-DB, DB-driven regressions | Azure chatty I/O antipattern; Spring Data JPA |
| Timeouts, retry, circuit breaker | CODE-HTTP-NO-TIMEOUT, ARCH-NO-CIRCUIT-BREAKER | AWS Builders Library; Azure circuit breaker, retry |
| Health endpoint monitoring | K8S-NO-PROBES, FX-READINESS, FX-CRASHLOOP | Azure health endpoint monitoring; Kubernetes probes |
| Canary with automated analysis | FX-REGRESSION-SLOW, FX-REGRESSION-ERRORS | Argo Rollouts analysis; Dynatrace Site Reliability Guardian; DORA continuous delivery |
| Parallel change | FX-DB-MIGRATION | Fowler; DORA database change management; Argo CD sync waves |
| External configuration store | FX-CONFIG-MISSING | Azure external configuration store; 12factor config; External Secrets |
| Immutable artifacts | K8S-MUTABLE-TAG, FX-IMAGE-PULL, TF-NO-REMOTE-STATE | 12factor build, release, run; ECR tag immutability |
| Redundancy and disruption budgets | K8S-SINGLE-REPLICA, K8S-NO-PDB | AWS Well-Architected reliability; Kubernetes PDB |
| Least privilege | DOCKER-ROOT, K8S-NO-SECCTX, GHA-NO-PERMISSIONS, TF-S3-PUBLIC-ACCESS | Pod Security Standards; GitHub Actions hardening; S3 block public access |
| Parameterised input and secret hygiene | CODE-SQL-CONCAT, CODE-HARDCODED-SECRET, CODE-JWT-ALG-NONE | OWASP Top 10 and cheat sheets |
| Supply-chain integrity | GHA-UNPINNED-ACTION, DOCKER-UNPINNED-BASE, REPO-NO-DEPENDABOT, FX-VULN-GATE | SLSA; GitHub hardening; Dependabot |
| Size from measured usage | K8S-NO-LIMITS, FX-OOM, rightsizing | Kubernetes resource management; AWS cost pillar |
| Trunk-based development with required checks | FX-COMPILE, FX-FLAKY-TEST, REPO-NO-CODEOWNERS, GHA-NO-CONCURRENCY, DOCKER-CACHE-ORDER | DORA trunk-based development and test automation; GitHub protected branches |
| Streamlined change approval | FX-CHANGE-WAIT | DORA streamlining change approval; Dynatrace SRG |
| Cost-optimised capacity | commitment, non-prod, Graviton, gp3, NAT, log retention | AWS Well-Architected cost pillar; Savings Plans; Graviton |

On the demo data the advisor picks: Checkout and Identity, parameterised input and secret hygiene (security gate); Catalog, avoid chatty I/O (root cause of its latency regressions); Payments, streamlined change approval; Notifications, size from measured usage. Every pick shows its formula breakdown, the evidence it resolves, the steps and the references in the Advisor view.

## Part 3: integration contract

`packages/core/src/integrations.ts` declares, per tool, the fields the engines rely on, the views each feeds, how it connects (REST, MCP, CLI), the environment variables and the schema file in `fixtures/raw/`. The Integrations view renders this with a sample record from whatever tier is loaded, a connection test (`POST /api/integrations/<source>/test`) and a paste box that loads MCP output as a snapshot (`POST /api/ingest/<source>`, validated against the native schema).
