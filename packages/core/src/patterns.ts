// Design advisor. Every rule the engines enforce maps to one named pattern or principle from an
// official source. Per product, the advisor ranks those patterns with an explicit, auditable
// formula and returns ONE recommendation to do first, with the next two behind it.
//
//   Priority = Severity x Evidence x Reach x Criticality + Savings
//     Severity     worst contributing rule: critical 5, high 3, medium 2, low 1
//     Evidence     1.0 static finding · 1.5 confirmed by runtime telemetry · 2.0 caused production or delivery failures
//     Reach        1 + log2(1 + occurrences)   (failures and findings that the pattern resolves)
//     Criticality  CMDB tier 1: 1.5 · tier 2: 1.2 · tier 3: 1.0
//     Savings      monthly saving it unlocks / 2000, capped at 3
//   Gate: an open critical security exposure (committed secret, injectable SQL, unsigned tokens)
//   always ranks first, whatever its score. Exposure is the incident.

import type { Analysis, Pillar, Reference, Severity } from './index'
import { REF } from './refs'

export interface Pattern {
  id: string
  name: string
  pillar: Pillar
  principle: string
  problem: string
  solution: string
  tradeoffs: string
  references: Reference[]
}

export const PATTERNS: Record<string, Pattern> = {
  'cache-aside': {
    id: 'cache-aside', name: 'Cache-Aside', pillar: 'architecture',
    principle: 'Serve repeated reads from memory; keep the database for writes and misses.',
    problem: 'The same rows are read on most requests, so latency and database size scale with read traffic.',
    solution: 'Read from the cache first, load from the database on a miss and populate the cache with a TTL; invalidate on write.',
    tradeoffs: 'Stale reads up to the TTL; one more component to operate. Reuse an existing managed Redis where one exists.',
    references: [REF.cacheAside, REF.redisCaching],
  },
  'batch-reads': {
    id: 'batch-reads', name: 'Avoid chatty I/O (batch and eager loading)', pillar: 'design-patterns',
    principle: 'One round trip per request path, not one per item.',
    problem: 'Queries inside loops multiply database calls per request (N+1), inflating latency under load.',
    solution: 'Fetch related rows in one query: JOIN, IN clause, entity graph or batch fetch.',
    tradeoffs: 'Larger single queries; watch result size and index coverage.',
    references: [REF.chattyIo, REF.springJpaQueries],
  },
  resilience: {
    id: 'resilience', name: 'Timeouts, retry with backoff, circuit breaker', pillar: 'system-design',
    principle: 'Every remote call can be slow or fail; bound it and fail fast.',
    problem: 'Calls without timeouts hold threads and connections when a dependency slows, cascading the failure.',
    solution: 'Explicit timeouts below the caller budget, bounded retries with jitter for idempotent calls, a circuit breaker per dependency.',
    tradeoffs: 'Retries add load during incidents if unbounded; breakers need tuned thresholds.',
    references: [REF.awsTimeouts, REF.circuitBreaker, REF.retryPattern],
  },
  'health-probes': {
    id: 'health-probes', name: 'Health Endpoint Monitoring', pillar: 'system-design',
    principle: 'The platform must know when an instance can take traffic.',
    problem: 'Without readiness and liveness checks, rollouts route traffic to pods that are not ready or are stuck.',
    solution: 'Readiness checks local readiness only, liveness detects deadlock, startup probes cover slow boots.',
    tradeoffs: 'Probes that call dependencies cause cascading restarts; keep them local.',
    references: [REF.healthEndpoint, REF.k8sProbes],
  },
  'progressive-delivery': {
    id: 'progressive-delivery', name: 'Canary release with automated analysis', pillar: 'system-design',
    principle: 'Expose a change to a slice of traffic and let telemetry decide promotion.',
    problem: 'Regressions reach all users before anyone sees the latency or error change.',
    solution: 'Argo Rollouts canary steps gated by Dynatrace metrics; Site Reliability Guardian as the promotion check; automatic rollback.',
    tradeoffs: 'Slower full rollout; needs reliable SLO metrics per service.',
    references: [REF.argoRolloutsAnalysis, REF.dtSrg, REF.doraContinuousDelivery],
  },
  'expand-contract': {
    id: 'expand-contract', name: 'Parallel change (expand and contract)', pillar: 'design-patterns',
    principle: 'Never couple a schema change and a code change in one step.',
    problem: 'Migrations that rename or drop fail mid-deploy and block rollback.',
    solution: 'Expand (additive, idempotent migration), migrate code, contract later; order migrations before workloads with sync waves.',
    tradeoffs: 'Temporary duplicate columns or tables; needs a cleanup ticket.',
    references: [REF.parallelChange, REF.doraDbChange, REF.argoWaves],
  },
  'external-config': {
    id: 'external-config', name: 'External configuration store', pillar: 'architecture',
    principle: 'Config and secrets live outside the artifact and are declared per environment.',
    problem: 'Missing or hard-coded configuration breaks deploys and leaks credentials.',
    solution: 'Config in the environment, secrets from a secret manager via External Secrets, validated in CI per overlay.',
    tradeoffs: 'One more dependency at startup; cache values and fail fast with a clear message.',
    references: [REF.externalConfig, REF.twelveConfig, REF.externalSecrets],
  },
  'immutable-artifacts': {
    id: 'immutable-artifacts', name: 'Build once, deploy immutable artifacts', pillar: 'tool-integration',
    principle: 'The thing tested is exactly the thing deployed.',
    problem: 'Mutable tags and local state make deploys and rollbacks non-deterministic.',
    solution: 'CI writes image digests into manifests, tag immutability on the registry, remote locked state for infrastructure.',
    tradeoffs: 'Manifests change on every build; automate the bump.',
    references: [REF.twelveBuild, REF.ecrTagImmutability, REF.tfBackend],
  },
  redundancy: {
    id: 'redundancy', name: 'Redundancy and disruption budgets', pillar: 'architecture',
    principle: 'No single instance on a critical path.',
    problem: 'Single replicas and missing disruption budgets turn node drains and upgrades into outages.',
    solution: 'At least two replicas across zones, a PodDisruptionBudget, autoscaling with a floor of two.',
    tradeoffs: 'Higher baseline cost for low-traffic services.',
    references: [REF.awsReliability, REF.k8sPdb],
  },
  'least-privilege': {
    id: 'least-privilege', name: 'Least privilege', pillar: 'security',
    principle: 'Every process and token gets only what it needs.',
    problem: 'Root containers, broad CI tokens and public buckets widen the blast radius of any compromise.',
    solution: 'Non-root containers under the Restricted pod standard, read-only CI token by default, blocked public access on storage.',
    tradeoffs: 'Some images need rework to run non-root.',
    references: [REF.k8sPss, REF.ghHardening, REF.s3BlockPublic],
  },
  'secure-coding': {
    id: 'secure-coding', name: 'Parameterised input and secret hygiene', pillar: 'security',
    principle: 'Treat all input as data and keep credentials out of code.',
    problem: 'String-built SQL, committed keys and permissive token validation are directly exploitable.',
    solution: 'Parameterised queries, rotate and remove committed secrets, allow-list one JWT algorithm.',
    tradeoffs: 'None worth keeping the risk for.',
    references: [REF.owaspTop10, REF.owaspSqli, REF.owaspSecrets, REF.owaspJwt],
  },
  'supply-chain': {
    id: 'supply-chain', name: 'Software supply-chain integrity', pillar: 'security',
    principle: 'Pin what you build from and patch it continuously.',
    problem: 'Floating actions and base images change under you; known CVEs block releases late.',
    solution: 'Pin actions to commit SHAs and images to digests, Dependabot for every ecosystem, scan on every PR.',
    tradeoffs: 'More update PRs; batch them weekly.',
    references: [REF.slsa, REF.ghHardening, REF.ghDependabot],
  },
  'right-sizing': {
    id: 'right-sizing', name: 'Size resources from measured usage', pillar: 'system-design',
    principle: 'Requests and limits come from observed p95, reviewed regularly.',
    problem: 'Guessed resources either waste money or get containers OOMKilled.',
    solution: 'Set requests from Dynatrace p95 usage plus headroom, memory limits with margin, review monthly.',
    tradeoffs: 'Needs a feedback loop; spikes need autoscaling rather than permanent headroom.',
    references: [REF.k8sResources, REF.k8sMemory, REF.awsCostPillar],
  },
  'trunk-quality': {
    id: 'trunk-quality', name: 'Trunk-based development with required checks', pillar: 'coding',
    principle: 'Main is always releasable; small changes, fast reliable checks.',
    problem: 'Broken builds and flaky tests on main stall every team behind them.',
    solution: 'Required build and type checks, quarantine flaky tests, code owners, cancel superseded CI runs.',
    tradeoffs: 'Discipline on small batches; quarantine needs an owner.',
    references: [REF.doraTrunk, REF.doraTestAutomation, REF.ghProtectedBranches],
  },
  'change-automation': {
    id: 'change-automation', name: 'Streamlined change approval', pillar: 'tool-integration',
    principle: 'Automated evidence and peer review replace manual approval boards for routine changes.',
    problem: 'Changes wait longer for approval than they take to build and deploy.',
    solution: 'Standard changes for repeatable deploys; the pipeline attaches test and guardian evidence to the change automatically.',
    tradeoffs: 'Requires trust in pipeline evidence; keep manual review for high-risk changes.',
    references: [REF.doraChangeApproval, REF.dtSrg],
  },
  'infra-pipeline': {
    id: 'infra-pipeline', name: 'Infrastructure changes through the pipeline', pillar: 'tool-integration',
    principle: 'Production infrastructure changes the same way code does: reviewed, recorded, reversible.',
    problem: 'A console or CLI change to production infrastructure bypassed review and the change record, and nobody linked it to the failure.',
    solution: 'Infrastructure as code with remote locked state, plan reviewed in a pull request, apply from the pipeline with the change record attached; deny direct console writes in production.',
    tradeoffs: 'Slower emergency changes; keep a break-glass path that still records the change.',
    references: [REF.tfBackend, REF.doraChangeApproval, REF.awsReliability],
  },
  'cost-efficiency': {
    id: 'cost-efficiency', name: 'Cost-optimised capacity', pillar: 'architecture',
    principle: 'Pay for what runs and commit to what is steady.',
    problem: 'Always-on non-prod, uncommitted steady spend and older instance families inflate cost.',
    solution: 'Schedule non-prod, raise commitment coverage on steady spend, move to Graviton and gp3, route S3 through gateway endpoints.',
    tradeoffs: 'Commitments reduce flexibility; scheduling needs owner opt-out.',
    references: [REF.awsCostPillar, REF.awsSavingsPlans, REF.awsGraviton],
  },
}

export const RULE_PATTERN: Record<string, string> = {
  'ARCH-CACHE-ASIDE': 'cache-aside',
  'CODE-N-PLUS-ONE': 'batch-reads', 'RUNTIME-CHATTY-DB': 'batch-reads',
  'CODE-HTTP-NO-TIMEOUT': 'resilience', 'ARCH-NO-CIRCUIT-BREAKER': 'resilience',
  'K8S-NO-PROBES': 'health-probes', 'FX-READINESS': 'health-probes', 'FX-CRASHLOOP': 'health-probes',
  'FX-REGRESSION-SLOW': 'progressive-delivery', 'FX-REGRESSION-ERRORS': 'progressive-delivery',
  'FX-DB-MIGRATION': 'expand-contract',
  'FX-CONFIG-MISSING': 'external-config', 'CODE-HARDCODED-SECRET': 'secure-coding',
  'K8S-MUTABLE-TAG': 'immutable-artifacts', 'FX-IMAGE-PULL': 'immutable-artifacts', 'TF-NO-REMOTE-STATE': 'immutable-artifacts',
  'K8S-SINGLE-REPLICA': 'redundancy', 'K8S-NO-PDB': 'redundancy',
  'DOCKER-ROOT': 'least-privilege', 'K8S-NO-SECCTX': 'least-privilege', 'GHA-NO-PERMISSIONS': 'least-privilege', 'TF-S3-PUBLIC-ACCESS': 'least-privilege',
  'CODE-SQL-CONCAT': 'secure-coding', 'CODE-JWT-ALG-NONE': 'secure-coding',
  'GHA-UNPINNED-ACTION': 'supply-chain', 'DOCKER-UNPINNED-BASE': 'supply-chain', 'REPO-NO-DEPENDABOT': 'supply-chain', 'FX-VULN-GATE': 'supply-chain',
  'K8S-NO-LIMITS': 'right-sizing', 'FX-OOM': 'right-sizing',
  'FX-COMPILE': 'trunk-quality', 'FX-FLAKY-TEST': 'trunk-quality', 'REPO-NO-CODEOWNERS': 'trunk-quality', 'GHA-NO-CONCURRENCY': 'trunk-quality', 'DOCKER-CACHE-ORDER': 'trunk-quality',
  'FX-CHANGE-WAIT': 'change-automation',
}

const COST_PATTERN: Record<string, string> = {
  rightsizing: 'right-sizing', commitment: 'cost-efficiency', nonprod: 'cost-efficiency', idle: 'cost-efficiency',
  architecture: 'cost-efficiency', observability: 'cost-efficiency', anomaly: 'cost-efficiency',
}

const SEV: Record<Severity, number> = { critical: 5, high: 3, medium: 2, low: 1, info: 0 }
const TIER: Record<number, number> = { 1: 1.5, 2: 1.2, 3: 1 }
const r1 = (n: number) => Math.round(n * 10) / 10

export interface Contribution { ruleId: string; title: string; kind: 'failure' | 'code' | 'cost'; count: number; severity: Severity; savingsUsd?: number }
export interface Advice {
  pattern: Pattern
  priority: number
  formula: { severity: number; evidence: number; reach: number; criticality: number; savings: number }
  evidenceLevel: 'static' | 'runtime-confirmed' | 'caused-failures'
  securityGate: boolean
  contributions: Contribution[]
  steps: string[]
  why: string
}
export interface ProductAdvice { productId: string; best: Advice | null; next: Advice[] }

export function adviseProduct(a: Analysis, productId: string): ProductAdvice {
  const product = a.dataset.products.find((p) => p.id === productId)!
  const groups = new Map<string, { contributions: Contribution[]; steps: string[]; failures: number; runtime: boolean; savings: number }>()
  const add = (patternId: string, c: Contribution, steps: string[], failure: boolean, runtime: boolean) => {
    const g = groups.get(patternId) ?? { contributions: [], steps: [], failures: 0, runtime: false, savings: 0 }
    const existing = g.contributions.find((x) => x.ruleId === c.ruleId && x.kind === c.kind)
    if (existing) { existing.count += c.count; existing.savingsUsd = (existing.savingsUsd ?? 0) + (c.savingsUsd ?? 0) } else g.contributions.push(c)
    for (const s of steps) if (!g.steps.includes(s)) g.steps.push(s)
    if (failure) g.failures += c.count
    g.runtime ||= runtime
    g.savings += c.savingsUsd ?? 0
    groups.set(patternId, g)
  }

  for (const f of a.failures.filter((x) => x.productId === productId)) {
    const pid = RULE_PATTERN[f.recommendation.ruleId]
    if (!pid) continue
    add(pid, { ruleId: f.recommendation.ruleId, title: f.recommendation.title, kind: 'failure', count: 1, severity: f.recommendation.severity }, f.recommendation.prevent.slice(0, 2), true, f.source !== 'pipeline' && f.source !== 'change')
  }
  for (const c of a.code.filter((x) => x.productId === productId)) {
    const pid = RULE_PATTERN[c.ruleId]
    if (!pid) continue
    add(pid, { ruleId: c.ruleId, title: c.title, kind: 'code', count: 1, severity: c.severity }, [c.recommendation], false, c.ruleId.startsWith('ARCH-CACHE') || c.ruleId.startsWith('RUNTIME-'))
  }
  // Root-cause linkage: a latency regression whose evidence shows database calls per request rising
  // is caused by chatty data access when the code and runtime already show it. Credit the root fix,
  // not only the delivery control that would have caught it.
  if (groups.has('batch-reads')) {
    for (const f of a.failures.filter((x) => x.productId === productId && x.recommendation.ruleId === 'FX-REGRESSION-SLOW' && /database calls|db calls/i.test(x.evidence))) {
      add('batch-reads', { ruleId: 'FX-REGRESSION-SLOW', title: `${f.recommendation.title} (root cause: DB calls per request)`, kind: 'failure', count: 1, severity: f.recommendation.severity }, [], true, true)
    }
  }
  for (const i of a.cost[productId]?.insights ?? []) {
    const pid = i.title.startsWith('Downsize database') ? 'cache-aside' : COST_PATTERN[i.kind]
    if (!pid || i.monthlySavingsUsd <= 0) continue
    add(pid, { ruleId: `COST-${i.kind.toUpperCase()}`, title: i.title, kind: 'cost', count: 1, severity: 'medium', savingsUsd: i.monthlySavingsUsd }, [i.detail], false, true)
  }

  const advices: Advice[] = [...groups.entries()].map(([pid, g]) => {
    const severity = Math.max(...g.contributions.map((c) => SEV[c.severity]))
    const evidence = g.failures > 0 ? 2 : g.runtime ? 1.5 : 1
    const occurrences = g.contributions.reduce((s, c) => s + c.count, 0)
    const reach = 1 + Math.log2(1 + occurrences)
    const criticality = TIER[product.tier] ?? 1
    const savings = Math.min(3, g.savings / 2000)
    const priority = severity * evidence * reach * criticality + savings
    const evidenceLevel: Advice['evidenceLevel'] = g.failures > 0 ? 'caused-failures' : g.runtime ? 'runtime-confirmed' : 'static'
    const p = PATTERNS[pid]
    const securityGate = p.pillar === 'security' && g.contributions.some((c) => c.kind === 'code' && c.severity === 'critical')
    const why = `${securityGate ? 'Security gate: open critical exposure ranks first. ' : ''}${p.name}: ${evidenceLevel === 'caused-failures' ? `${g.failures} delivery or production failure${g.failures > 1 ? 's' : ''} in the window trace to it` : evidenceLevel === 'runtime-confirmed' ? 'confirmed by runtime telemetry' : 'found in code and configuration'}, worst severity ${Object.entries(SEV).find(([, v]) => v === severity)?.[0]}, ${occurrences} occurrence${occurrences > 1 ? 's' : ''}${g.savings > 0 ? `, unlocks $${Math.round(g.savings).toLocaleString('en-US')}/month` : ''}, tier ${product.tier} product.`
    return { pattern: p, priority: r1(priority), formula: { severity, evidence, reach: r1(reach), criticality, savings: r1(savings) }, evidenceLevel, securityGate, contributions: g.contributions.sort((x, y) => SEV[y.severity] - SEV[x.severity] || y.count - x.count), steps: g.steps.slice(0, 5), why }
  }).sort((x, y) => Number(y.securityGate) - Number(x.securityGate) || y.priority - x.priority)

  return { productId, best: advices[0] ?? null, next: advices.slice(1, 3) }
}

export function advise(a: Analysis): Record<string, ProductAdvice> {
  return Object.fromEntries(a.dataset.products.map((p) => [p.id, adviseProduct(a, p.id)]))
}

/** Patterns this codebase itself is built on; shown in the app and in docs/DESIGN.md. */
export const SELF_PATTERNS: { name: string; where: string; why: string; references: Reference[] }[] = [
  { name: 'Hexagonal architecture (ports and adapters)', where: 'packages/core is pure; apps/server/adapters and the MCP hub are adapters', why: 'Engines are tested without any live system; a source can be swapped without touching them.', references: [REF.hexagonal] },
  { name: 'Anti-corruption layer', where: 'core/sources.ts mappers + FIELD_MAP', why: 'Vendor schemas and tenant custom fields stop at one boundary; the domain model never sees them.', references: [REF.antiCorruption] },
  { name: 'Pipes and filters', where: 'collect, map, analyze, view model', why: 'Each stage is independently testable and replaceable.', references: [REF.pipesFilters] },
  { name: 'Gateway aggregation', where: 'collector joins seven sources on the CMDB', why: 'Clients make one call instead of seven.', references: [REF.gatewayAggregation] },
  { name: 'Backends for frontends + CQRS read model', where: 'core/viewmodel.ts served at /api/vm', why: 'One compact, precomputed read model per client; writes (collection) and reads are separate.', references: [REF.bff, REF.cqrs] },
  { name: 'Cache-aside', where: 'view model cached per collection in the API', why: 'Repeated reads cost nothing until data changes.', references: [REF.cacheAside] },
  { name: 'Specification and chain of responsibility', where: 'FAILURE_RULES and FILE_RULES evaluated in order', why: 'Rules are data: add one without changing the engine.', references: [REF.specification] },
  { name: 'Gatekeeper and least privilege', where: 'agent/policy.ts, read-only MCP, Dynatrace never writable', why: 'The agent cannot change source systems without an explicit allowlist.', references: [REF.gatekeeper, REF.owaspLlm] },
  { name: 'Human in the loop (state machine with interrupt)', where: 'agent/graph.ts approve node', why: 'No recommendation is final without a person; runs are checkpointed and resumable.', references: [REF.langgraph] },
  { name: 'Twelve-factor config', where: '.env, mcp.servers.json, apps/server/config.ts', why: 'Same build runs in every environment; secrets never in code.', references: [REF.twelveConfig] },
  { name: 'Timeouts and graceful degradation', where: 'adapters/http.ts, McpHub timeouts, tier fallback to snapshot or dummy', why: 'One slow source never blocks the rest.', references: [REF.awsTimeouts] },
  { name: 'Open standard for tool access', where: 'McpHub over stdio and Streamable HTTP', why: 'Same MCP servers serve Cursor and the app; no vendor-specific SDK per tool.', references: [REF.mcpSpec] },
]
