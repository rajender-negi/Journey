# Phases: scope, rules and exit criteria

## Phase 1: signal capture
- Seven sources, three tiers each (live, MCP snapshot, dummy), all in native schema.
- Exit: `GET /api/sources` shows every source; for each live source, `GET /api/raw/<source>` matches the field names in `fixtures/raw/<source>.json`.
- Rollout order: ServiceNow (identity) first, then Dynatrace, GitHub, Argo CD, Kubernetes, cost.

## Phase 2: journey and DORA
- Stages: merged, build, test, scan, staging, change, prod, verified (no Dynatrace problem within 60 min).
- Outcomes: delivered, delivered with incident, failed, in flight.
- DORA bands from the DORA State of DevOps clusters; thresholds in `DORA_THRESHOLDS`.
- Exit: Dynatrace DORA and computed DORA agree within 25% for each product, or the drift is explained (missing SDLC events, unmapped repo).

## Phase 3: failures and prevention
- 12 failure rules: image pull, missing config, crash loop, OOM, readiness, DB migration, vulnerability gate, flaky test, compile, change approval wait, latency regression, error regression. Each has restore steps, prevention controls and official references.
- Risk score for changes not yet in prod: change size, schema change, tier, recent CFR, open problem, unstable tests, CR risk, weekend window, unsafe rollout config. Gate: proceed, canary, hold.
- Exit: zero unclassified failures over 30 days on real data; every new signature becomes a rule with a test.

## Phase 4: codebase analysis
- File rules: containers (root user, unpinned base, cache order), k8s (probes, limits, single replica, mutable tag, securityContext, PDB), CI (unpinned actions, token permissions, concurrency), code (SQL concatenation, committed secrets, JWT none, HTTP without timeout, N+1), IaC (S3 public access, remote state), repo (CODEOWNERS, Dependabot, circuit breaker).
- Cross-signal rules: Redis cache-aside when Dynatrace shows read/write >= 10, repeated statements >= 30% and >= 2 DB calls per request, and no cache client exists; chatty DB access at >= 10 calls per request.
- Exit: false positive rate under 10% on a reviewed sample per product.

## Phase 5: cost for leadership
- Spend by product, service and environment; month on month; cost per 1k requests; cost of failed changes.
- Actions: rightsizing from Dynatrace p95 vs requests, non-prod scheduling, commitment coverage, Graviton, gp3, NAT gateway endpoints, log retention tiers in OpenPipeline, database downsizing after cache-aside (links phase 4 to phase 5).
- Exit: finance agrees the product attribution covers at least 90% of tagged spend.

## Phase 6: best practices
- Scorecard per product across six pillars, weighted toward security, architecture and system design.
- Guidance catalog is generated from the rules themselves, so the page and the enforcement never drift apart.
- Exit: each product team owns its top issue per pillar with a target grade.

## Agentic investigation (spans phases 1 and 3)
- LangGraph agent in `packages/agent`: classify, plan, gather through MCP, hypothesize, verify (loop for missing evidence), recommend, approve via interrupt.
- MCP client hub shared with the collector, read only by default, audited.
- Exit: on 20 real failures, the agent's verified root cause matches the on-call team's postmortem in at least 16, and no run issues a write without approval.
