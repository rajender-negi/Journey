// Seeded dummy dataset. Used by demo mode, tests, and as the fallback for any source
// whose live connection is not configured. Every scenario the engines handle appears here,
// so the full end-to-end journey can be shown without a single live connection.

import type {
  ChangeRequest, CostRecord, Dataset, Deployment, DoraFromDynatrace, Merge, PipelineRun,
  Problem, Product, RepoFile, RepoSnapshot, RuntimeEvent, ServiceMetrics, WorkloadUsage,
} from './types'
import { DAY, HOUR, MIN, iso, rng } from './util'

type Scenario =
  | 'ok' | 'build-fail' | 'test-fail' | 'scan-fail' | 'staging-imagepull' | 'staging-crashloop'
  | 'change-wait' | 'prod-hook' | 'prod-oom' | 'prod-readiness' | 'incident-slow' | 'incident-error'

interface Profile {
  product: Product
  merges: number
  weights: Partial<Record<Scenario, number>>
  approvalHours: [number, number]
  stdChangeShare: number
}

export const PRODUCTS: Product[] = [
  {
    id: 'BA0001', name: 'Checkout', owner: 'Ananya Rao', team: 'Commerce', tier: 1,
    repos: ['acme/checkout-api', 'acme/checkout-web'], services: ['checkout-api', 'checkout-web'],
    k8sNamespaces: ['checkout'], costTags: { product: 'checkout' }, downtimeCostPerMin: 1800,
  },
  {
    id: 'BA0002', name: 'Payments', owner: 'Vikram Sethi', team: 'Fintech Core', tier: 1,
    repos: ['acme/payments-service'], services: ['payments-service'],
    k8sNamespaces: ['payments'], costTags: { product: 'payments' }, downtimeCostPerMin: 2500,
  },
  {
    id: 'BA0003', name: 'Catalog', owner: 'Meera Iyer', team: 'Discovery', tier: 2,
    repos: ['acme/catalog-api'], services: ['catalog-api'],
    k8sNamespaces: ['catalog'], costTags: { product: 'catalog' }, downtimeCostPerMin: 600,
  },
  {
    id: 'BA0004', name: 'Identity', owner: 'Rohit Malhotra', team: 'Platform Security', tier: 1,
    repos: ['acme/identity-service'], services: ['identity-service'],
    k8sNamespaces: ['identity'], costTags: { product: 'identity' }, downtimeCostPerMin: 2000,
  },
  {
    id: 'BA0005', name: 'Notifications', owner: 'Sara Khan', team: 'Engagement', tier: 3,
    repos: ['acme/notifications-worker'], services: ['notifications-worker'],
    k8sNamespaces: ['notifications'], costTags: { product: 'notifications' }, downtimeCostPerMin: 120,
  },
]

const PROFILES: Profile[] = [
  {
    product: PRODUCTS[0], merges: 42, approvalHours: [1, 10], stdChangeShare: 0.6,
    weights: { ok: 30, 'build-fail': 2, 'test-fail': 3, 'staging-imagepull': 1, 'prod-hook': 2, 'incident-slow': 2, 'incident-error': 1, 'change-wait': 1 },
  },
  {
    product: PRODUCTS[1], merges: 24, approvalHours: [6, 40], stdChangeShare: 0.2,
    weights: { ok: 22, 'test-fail': 1, 'prod-readiness': 1, 'change-wait': 2 },
  },
  {
    product: PRODUCTS[2], merges: 36, approvalHours: [0.5, 6], stdChangeShare: 0.8,
    weights: { ok: 24, 'test-fail': 6, 'build-fail': 2, 'incident-slow': 3, 'prod-readiness': 1 },
  },
  {
    product: PRODUCTS[3], merges: 16, approvalHours: [4, 30], stdChangeShare: 0.3,
    weights: { ok: 10, 'scan-fail': 4, 'staging-crashloop': 1, 'change-wait': 1, 'incident-error': 1 },
  },
  {
    product: PRODUCTS[4], merges: 22, approvalHours: [0.2, 3], stdChangeShare: 0.9,
    weights: { ok: 12, 'prod-oom': 3, 'staging-crashloop': 3, 'staging-imagepull': 1, 'build-fail': 1 },
  },
]

const FAILURE_TEXT: Record<string, string> = {
  'build-fail': "src/pricing/discount.ts(42,7): error TS2322: Type 'string' is not assignable to type 'number'. Process completed with exit code 2.",
  'test-fail': 'FAIL src/cart/cart.service.spec.ts > applies promo > Error: Timeout - Async callback was not invoked within the 5000 ms timeout. Test passed on retry 2 of 3 in previous runs (flaky).',
  'scan-fail': 'Trivy scan: Total: 1 (CRITICAL: 1). CVE-2024-45337 golang.org/x/crypto v0.25.0 fixed in v0.31.0. Policy gate "no-critical-cves" failed.',
  'staging-imagepull': 'Failed to pull image "123456789012.dkr.ecr.ap-south-1.amazonaws.com/app:sha-9f2c1": manifest unknown. Pod status ImagePullBackOff. Argo CD health: Degraded.',
  'staging-crashloop': 'Back-off restarting failed container api in pod. CrashLoopBackOff. Last log: Error: missing required environment variable DATABASE_URL.',
  'prod-hook': 'one or more synchronization tasks completed unsuccessfully. PreSync hook job/db-migrate failed: ERROR: relation "order_items_v2" already exists (SQLSTATE 42P07).',
  'prod-oom': 'Container worker terminated. Reason: OOMKilled (exit code 137). Memory limit 512Mi. Rollout progress deadline exceeded, rolled back to previous ReplicaSet.',
  'prod-readiness': 'Readiness probe failed: HTTP probe failed with statuscode: 503. Deployment exceeded its progress deadline. Argo CD rolled back.',
}

// build failures read like the product's own toolchain
const BUILD_TEXT: Record<string, string> = {
  BA0001: FAILURE_TEXT['build-fail'],
  BA0002: './internal/charge/client.go:41:9: undefined: retryPolicy. go build failed with exit code 1.',
  BA0003: '[ERROR] COMPILATION ERROR : ProductService.java:[27,15] cannot find symbol: method getAttributes(). BUILD FAILURE',
  BA0004: 'SyntaxError: invalid syntax (app/tenants.py, line 12). py_compile failed with exit code 1.',
  BA0005: 'worker.js:18 SyntaxError: Unexpected token \'}\'. Process completed with exit code 1.',
}

const TITLES = [
  'Add promo stacking rules', 'Refactor price calculation', 'Bump dependencies', 'Fix null cart edge case',
  'Add idempotency key to POST', 'Paginate list endpoint', 'Add feature flag for new flow', 'Improve error mapping',
  'Upgrade base image', 'Add retry to downstream call', 'Tune connection pool', 'Add audit logging',
  'Migrate table to v2 schema', 'Split large handler', 'Add OpenTelemetry attributes', 'Cache config lookups',
]
const AUTHORS = ['akash.v', 'neha.p', 'arjun.k', 'divya.s', 'karan.m', 'pooja.r', 'rahul.t', 'isha.g']

function pickScenario(r: ReturnType<typeof rng>, w: Partial<Record<Scenario, number>>): Scenario {
  const entries = Object.entries(w) as [Scenario, number][]
  const total = entries.reduce((a, [, v]) => a + v, 0)
  let x = r.next() * total
  for (const [k, v] of entries) {
    if ((x -= v) <= 0) return k
  }
  return 'ok'
}

export function buildFixtureDataset(now: number = Date.now(), seed = 42): Dataset {
  const r = rng(seed)
  const windowDays = 30
  const start = now - windowDays * DAY

  const merges: Merge[] = []
  const pipelineRuns: PipelineRun[] = []
  const deployments: Deployment[] = []
  const changeRequests: ChangeRequest[] = []
  const problems: Problem[] = []
  const runtimeEvents: RuntimeEvent[] = []
  let crSeq = 10450
  let pSeq = 3100
  let id = 0
  const nid = (p: string) => `${p}-${++id}`

  for (const prof of PROFILES) {
    const p = prof.product
    for (let i = 0; i < prof.merges; i++) {
      const repo = r.pick(p.repos)
      // spread merges over the window, skew toward working hours IST
      const day = start + Math.floor((i / prof.merges) * windowDays) * DAY
      const mergedAtT = day + r.int(4, 13) * HOUR + r.int(0, 59) * MIN
      if (mergedAtT > now - 20 * MIN) continue
      const sha = Math.floor(r.next() * 0xfffffff).toString(16).padStart(7, '0')
      const firstCommitT = mergedAtT - r.float(2, 60) * HOUR
      const openedT = mergedAtT - r.float(0.5, 20) * HOUR
      const add = r.int(5, 900)
      const merge: Merge = {
        repo, prNumber: 1000 + i + (p.id.charCodeAt(5) * 100), title: r.pick(TITLES), author: r.pick(AUTHORS), sha,
        firstCommitAt: iso(firstCommitT), openedAt: iso(Math.max(openedT, firstCommitT)), mergedAt: iso(mergedAtT),
        additions: add, deletions: Math.floor(add * r.float(0.1, 0.8)), filesChanged: r.int(1, 40),
      }
      merges.push(merge)

      // most recent merges are still moving through the pipeline
      const inFlight = mergedAtT > now - 3 * HOUR
      let scenario = pickScenario(r, prof.weights)
      if (inFlight) scenario = 'ok'

      let t = mergedAtT + MIN
      const run = (stage: PipelineRun['stage'], dur: [number, number], fail: boolean, env?: PipelineRun['environment'], system: PipelineRun['system'] = 'github-actions') => {
        const s = t
        const f = s + r.float(dur[0], dur[1]) * MIN
        const running = f > now
        pipelineRuns.push({
          id: nid('run'), system, repo, sha, stage, environment: env,
          status: running ? 'running' : fail ? 'failed' : 'succeeded',
          startedAt: iso(s), finishedAt: running ? undefined : iso(f),
          url: system === 'argocd' ? `https://argocd.acme.internal/applications/${p.k8sNamespaces[0]}-${env}` : `https://github.com/${repo}/actions/runs/${9000000 + id}`,
          failureText: fail ? (stage === 'build' ? BUILD_TEXT[p.id] : FAILURE_TEXT[scenario]) : undefined,
        })
        t = f + r.float(0.5, 3) * MIN
        return { running, end: f }
      }

      if (run('build', [3, 9], scenario === 'build-fail').running || scenario === 'build-fail') continue
      if (run('test', [6, 16], scenario === 'test-fail').running || scenario === 'test-fail') continue
      if (run('scan', [2, 4], scenario === 'scan-fail').running || scenario === 'scan-fail') continue

      // staging deploy via Argo CD
      const stagingFail = scenario === 'staging-imagepull' || scenario === 'staging-crashloop'
      const st = run('deploy', [3, 7], stagingFail, 'staging', 'argocd')
      const version = `v${r.int(1, 4)}.${r.int(0, 30)}.${r.int(0, 9)}`
      if (!st.running) {
        deployments.push({
          id: nid('dep'), productId: p.id, repo, sha, version, environment: 'staging',
          status: stagingFail ? 'failed' : 'succeeded', startedAt: iso(st.end - 5 * MIN), finishedAt: iso(st.end),
          source: 'argocd', failureText: stagingFail ? FAILURE_TEXT[scenario] : undefined,
        })
      }
      if (stagingFail) {
        runtimeEvents.push({
          id: nid('evt'), productId: p.id, kind: 'k8s',
          reason: scenario === 'staging-imagepull' ? 'ImagePullBackOff' : 'CrashLoopBackOff',
          message: FAILURE_TEXT[scenario], workload: `${p.services[0]}`, namespace: `${p.k8sNamespaces[0]}-staging`, at: iso(st.end),
        })
        continue
      }
      if (st.running) continue

      // change request (ServiceNow)
      const standard = r.chance(prof.stdChangeShare)
      const crCreated = t
      const approvalH = standard ? r.float(0, 0.2) : r.float(prof.approvalHours[0], prof.approvalHours[1])
      const waiting = scenario === 'change-wait'
      const approvedT = crCreated + approvalH * HOUR
      const plannedT = approvedT + (standard ? 5 * MIN : r.float(0.5, 6) * HOUR)
      const cr: ChangeRequest = {
        number: `CHG00${crSeq++}`, productId: p.id, sha,
        state: waiting ? 'authorize' : 'closed', risk: standard ? 'low' : r.pick(['moderate', 'high'] as const),
        type: standard ? 'standard' : 'normal', createdAt: iso(crCreated),
        approvedAt: waiting ? undefined : iso(approvedT), plannedStart: iso(plannedT), plannedEnd: iso(plannedT + 2 * HOUR),
      }
      changeRequests.push(cr)
      if (waiting || plannedT > now) {
        if (!waiting) cr.state = 'scheduled'
        continue
      }

      // prod deploy
      t = plannedT
      const prodFail = scenario === 'prod-hook' || scenario === 'prod-oom' || scenario === 'prod-readiness'
      const pr = run('deploy', [4, 9], prodFail, 'prod', 'argocd')
      if (pr.running) {
        cr.state = 'implement'
        continue
      }
      const dep: Deployment = {
        id: nid('dep'), productId: p.id, repo, sha, version, environment: 'prod',
        status: prodFail ? (scenario === 'prod-hook' ? 'failed' : 'rolled_back') : 'succeeded',
        startedAt: iso(pr.end - 6 * MIN), finishedAt: iso(pr.end), source: 'dynatrace-sdlc', changeRequest: cr.number,
        failureText: prodFail ? FAILURE_TEXT[scenario] : undefined,
      }
      deployments.push(dep)
      cr.closedAt = iso(pr.end + 15 * MIN)
      cr.closeCode = prodFail ? 'unsuccessful' : scenario.startsWith('incident') ? 'successful_with_issues' : 'successful'

      if (prodFail) {
        if (scenario !== 'prod-hook') {
          runtimeEvents.push({
            id: nid('evt'), productId: p.id, kind: 'k8s', reason: scenario === 'prod-oom' ? 'OOMKilled' : 'Unhealthy',
            message: FAILURE_TEXT[scenario], workload: p.services[0], namespace: p.k8sNamespaces[0], at: iso(pr.end),
          })
        }
        // recovery: hotfix redeploy of previous version
        const recoverMin = r.float(25, 180)
        deployments.push({
          id: nid('dep'), productId: p.id, repo, sha: `${sha}-rb`, version: `${version}-rollback`, environment: 'prod',
          status: 'succeeded', startedAt: iso(pr.end + (recoverMin - 6) * MIN), finishedAt: iso(pr.end + recoverMin * MIN),
          source: 'argocd', changeRequest: cr.number,
        })
        problems.push({
          id: nid('prb'), displayId: `P-${pSeq++}`, productId: p.id,
          title: scenario === 'prod-hook' ? 'Deployment failed: database migration' : scenario === 'prod-oom' ? 'Memory saturation, pod restarts' : 'Service unavailable during rollout',
          status: 'closed', category: scenario === 'prod-hook' ? 'error' : scenario === 'prod-oom' ? 'resource' : 'availability',
          startedAt: iso(pr.end), endedAt: iso(pr.end + recoverMin * MIN), affectedEntities: [p.services[0]],
          rootCause: dep.id, rootCauseText: `Deployment ${version} (${sha})`,
        })
        continue
      }

      if (scenario === 'incident-slow' || scenario === 'incident-error') {
        const startP = pr.end + r.float(5, 40) * MIN
        const durMin = r.float(20, 160)
        const open = startP + durMin * MIN > now
        problems.push({
          id: nid('prb'), displayId: `P-${pSeq++}`, productId: p.id,
          title: scenario === 'incident-slow' ? `Response time degradation on ${p.services[0]}` : `Failure rate increase on ${p.services[0]}`,
          status: open ? 'open' : 'closed', category: scenario === 'incident-slow' ? 'slowdown' : 'error',
          startedAt: iso(startP), endedAt: open ? undefined : iso(startP + durMin * MIN), affectedEntities: [p.services[0]],
          rootCause: dep.id,
          rootCauseText: scenario === 'incident-slow'
            ? `Deployment ${version}: p95 response time up 3.4x; database calls per request up from 6 to 19`
            : `Deployment ${version}: HTTP 5xx on POST /v1/orders, NullPointerException in OrderMapper`,
        })
      }
    }
  }

  // An unrelated infra problem so problem->deployment correlation is exercised both ways
  problems.push({
    id: nid('prb'), displayId: `P-${pSeq++}`, productId: 'BA0002', title: 'Connectivity issue to managed database',
    status: 'closed', category: 'availability', startedAt: iso(now - 9 * DAY), endedAt: iso(now - 9 * DAY + 38 * MIN),
    affectedEntities: ['payments-service'], rootCauseText: 'AWS RDS failover in ap-south-1a',
  })

  return {
    generatedAt: iso(now),
    windowDays,
    products: PRODUCTS,
    merges, pipelineRuns, deployments, changeRequests, problems, runtimeEvents,
    serviceMetrics: serviceMetrics(),
    workloadUsage: workloadUsage(),
    costs: costs(now, r),
    repos: repoSnapshots(),
    doraFromDynatrace: doraFromDynatrace(),
  }
}

function serviceMetrics(): ServiceMetrics[] {
  return [
    { productId: 'BA0001', service: 'checkout-api', windowDays: 30, requests: 48_000_000, failureRate: 0.004, p95Ms: 420, dbCallsPerRequest: 6.1, repeatedQueryRatio: 0.22, readWriteRatio: 4 },
    { productId: 'BA0001', service: 'checkout-web', windowDays: 30, requests: 61_000_000, failureRate: 0.002, p95Ms: 310, dbCallsPerRequest: 0, repeatedQueryRatio: 0, readWriteRatio: 1 },
    { productId: 'BA0002', service: 'payments-service', windowDays: 30, requests: 19_000_000, failureRate: 0.0011, p95Ms: 260, dbCallsPerRequest: 3.2, repeatedQueryRatio: 0.08, readWriteRatio: 1.6 },
    { productId: 'BA0003', service: 'catalog-api', windowDays: 30, requests: 132_000_000, failureRate: 0.003, p95Ms: 880, dbCallsPerRequest: 14.2, repeatedQueryRatio: 0.63, readWriteRatio: 42, topQuery: 'SELECT * FROM product_attributes WHERE product_id = ?' },
    { productId: 'BA0004', service: 'identity-service', windowDays: 30, requests: 74_000_000, failureRate: 0.0019, p95Ms: 190, dbCallsPerRequest: 2.4, repeatedQueryRatio: 0.41, readWriteRatio: 18, topQuery: 'SELECT * FROM tenant_config WHERE tenant_id = ?' },
    { productId: 'BA0005', service: 'notifications-worker', windowDays: 30, requests: 9_000_000, failureRate: 0.012, p95Ms: 1400, dbCallsPerRequest: 1.1, repeatedQueryRatio: 0.05, readWriteRatio: 0.7 },
  ]
}

function workloadUsage(): WorkloadUsage[] {
  const w = (productId: string, namespace: string, workload: string, environment: WorkloadUsage['environment'], replicas: number, cpuReq: number, cpuP95: number, memReq: number, memP95: number): WorkloadUsage =>
    ({ productId, namespace, workload, environment, replicas, cpuRequestCores: cpuReq, cpuUsedP95Cores: cpuP95, memRequestGiB: memReq, memUsedP95GiB: memP95 })
  return [
    w('BA0001', 'checkout', 'checkout-api', 'prod', 12, 2, 0.55, 4, 2.1),
    w('BA0001', 'checkout', 'checkout-web', 'prod', 8, 1, 0.4, 2, 0.9),
    w('BA0001', 'checkout-staging', 'checkout-api', 'staging', 6, 2, 0.08, 4, 1.2),
    w('BA0002', 'payments', 'payments-service', 'prod', 6, 1, 0.62, 2, 1.5),
    w('BA0002', 'payments-staging', 'payments-service', 'staging', 2, 1, 0.05, 2, 0.7),
    w('BA0003', 'catalog', 'catalog-api', 'prod', 16, 2, 1.7, 4, 3.4),
    w('BA0003', 'catalog-dev', 'catalog-api', 'dev', 8, 2, 0.04, 4, 0.8),
    w('BA0004', 'identity', 'identity-service', 'prod', 8, 1, 0.3, 2, 0.8),
    w('BA0005', 'notifications', 'notifications-worker', 'prod', 4, 4, 0.6, 0.5, 0.49),
  ]
}

function costs(now: number, r: ReturnType<typeof rng>): CostRecord[] {
  const out: CostRecord[] = []
  const d = new Date(now)
  const months: string[] = []
  for (let i = 5; i >= 0; i--) {
    const m = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i, 1))
    months.push(`${m.getUTCFullYear()}-${String(m.getUTCMonth() + 1).padStart(2, '0')}`)
  }
  type Line = [productId: string, provider: CostRecord['provider'], service: string, base: number, growth: number, env: CostRecord['environment'], coverage: number, usageType?: string, spikeLast?: number]
  const lines: Line[] = [
    ['BA0001', 'aws', 'EKS compute (EC2)', 21000, 0.03, 'prod', 0.35, 'm5.2xlarge'],
    ['BA0001', 'aws', 'EKS compute (EC2)', 6200, 0.0, 'staging', 0, 'm5.2xlarge'],
    ['BA0001', 'aws', 'RDS PostgreSQL', 8800, 0.02, 'prod', 0.5, 'db.r5.2xlarge'],
    ['BA0001', 'aws', 'EBS', 2100, 0.04, 'prod', 0, 'gp2'],
    ['BA0001', 'dynatrace', 'Log ingest and retention', 3200, 0.06, 'shared', 0],
    ['BA0002', 'aws', 'EKS compute (EC2)', 9400, 0.01, 'prod', 0.72, 'm6g.xlarge'],
    ['BA0002', 'aws', 'Aurora PostgreSQL', 7200, 0.01, 'prod', 0.7, 'db.r6g.xlarge'],
    ['BA0002', 'azure', 'Key Vault and HSM', 1300, 0, 'prod', 0],
    ['BA0002', 'dynatrace', 'Log ingest and retention', 900, 0.01, 'shared', 0],
    ['BA0003', 'aws', 'EKS compute (EC2)', 26000, 0.06, 'prod', 0.2, 'm5.2xlarge'],
    ['BA0003', 'aws', 'EKS compute (EC2)', 9800, 0.02, 'dev', 0, 'm5.2xlarge'],
    ['BA0003', 'aws', 'RDS MySQL', 14500, 0.07, 'prod', 0.25, 'db.r5.4xlarge'],
    ['BA0003', 'aws', 'NAT Gateway data processing', 3100, 0.04, 'prod', 0, 'NatGateway-Bytes', 1.55],
    ['BA0003', 'aws', 'S3', 1900, 0.03, 'prod', 0, 'Standard'],
    ['BA0003', 'dynatrace', 'Log ingest and retention', 4100, 0.08, 'shared', 0],
    ['BA0004', 'aws', 'EKS compute (EC2)', 8300, 0.01, 'prod', 0.4, 'm5.xlarge'],
    ['BA0004', 'azure', 'Entra ID P2 and App Service', 4600, 0.0, 'prod', 0],
    ['BA0004', 'aws', 'ElastiCache Redis', 1500, 0, 'prod', 0.5, 'cache.r6g.large'],
    ['BA0005', 'aws', 'EKS compute (EC2)', 5200, 0.0, 'prod', 0, 'c5.2xlarge'],
    ['BA0005', 'aws', 'SQS and SNS', 900, 0.05, 'prod', 0],
    ['BA0005', 'aws', 'EBS', 700, 0, 'prod', 0, 'gp2'],
  ]
  for (const [productId, provider, service, base, growth, environment, coverage, usageType, spikeLast] of lines) {
    months.forEach((month, i) => {
      let amount = base * (1 + growth) ** i * r.float(0.97, 1.03)
      if (spikeLast && i === months.length - 1) amount *= spikeLast
      out.push({ productId, provider, service, month, amount: Math.round(amount), usageType, environment, commitmentCovered: coverage })
    })
  }
  return out
}

function doraFromDynatrace(): DoraFromDynatrace[] {
  // Dynatrace already computes DORA from SDLC events; the app reads it and reconciles.
  return [
    { productId: 'BA0001', deploymentFrequencyPerDay: 1.1, leadTimeHours: 14, changeFailureRate: 0.17, mttrHours: 1.3 },
    { productId: 'BA0002', deploymentFrequencyPerDay: 0.7, leadTimeHours: 52, changeFailureRate: 0.05, mttrHours: 1.1 },
    { productId: 'BA0003', deploymentFrequencyPerDay: 0.85, leadTimeHours: 20, changeFailureRate: 0.14, mttrHours: 1.6 },
  ]
}

// ---------- repo snapshots with deliberate best-practice gaps ----------

function repoSnapshots(): RepoSnapshot[] {
  const snap = (repo: string, productId: string, files: Record<string, string>): RepoSnapshot => ({
    repo, productId, ref: 'main', files: Object.entries(files).map(([path, content]): RepoFile => ({ path, content })),
  })

  const weakWorkflow = `name: ci
on: [push, pull_request]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm ci
      - run: npm test
      - uses: aquasecurity/trivy-action@master
`
  const strongWorkflow = `name: ci
on:
  pull_request:
  push:
    branches: [main]
permissions:
  contents: read
concurrency:
  group: ci-\${{ github.ref }}
  cancel-in-progress: true
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2
      - uses: actions/setup-go@3041bf56c941b39c61721a86cd11f3bb1338122a # v5.2.0
        with:
          go-version-file: go.mod
          cache: true
      - run: go test ./...
`
  return [
    snap('acme/checkout-api', 'BA0001', {
      'Dockerfile': `FROM node:latest
WORKDIR /app
COPY . .
RUN npm install
EXPOSE 8080
CMD ["node", "dist/server.js"]
`,
      'package.json': JSON.stringify({ name: 'checkout-api', dependencies: { express: '^4.19.2', axios: '^1.7.2', pg: '^8.11.0', winston: '^3.13.0' } }, null, 2),
      '.github/workflows/ci.yml': weakWorkflow,
      'k8s/deployment.yaml': `apiVersion: apps/v1
kind: Deployment
metadata:
  name: checkout-api
spec:
  replicas: 3
  template:
    spec:
      containers:
        - name: api
          image: 123456789012.dkr.ecr.ap-south-1.amazonaws.com/checkout-api:latest
          ports:
            - containerPort: 8080
          resources:
            requests: { cpu: "2", memory: 4Gi }
            limits: { cpu: "2", memory: 4Gi }
          readinessProbe:
            httpGet: { path: /health, port: 8080 }
`,
      'src/clients/inventory.ts': `import axios from 'axios'

export async function reserve(sku: string, qty: number) {
  // no timeout, no retry: a slow inventory service stalls checkout threads
  const res = await axios.post('http://inventory.internal/reserve', { sku, qty })
  return res.data
}
`,
      'src/repo/orders.ts': `import { pool } from '../db'

export async function findOrdersByCustomer(customerId: string, status: string) {
  const sql = "SELECT * FROM orders WHERE customer_id = '" + customerId + "' AND status = '" + status + "'"
  return (await pool.query(sql)).rows
}
`,
      'migrations/0042_order_items_v2.sql': `CREATE TABLE order_items_v2 (id BIGSERIAL PRIMARY KEY, order_id BIGINT NOT NULL, sku TEXT NOT NULL);
`,
    }),
    snap('acme/payments-service', 'BA0002', {
      'Dockerfile': `FROM golang:1.23-bookworm AS build
WORKDIR /src
COPY . .
RUN CGO_ENABLED=0 go build -o /out/payments ./cmd/payments

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/payments /payments
USER nonroot:nonroot
ENTRYPOINT ["/payments"]
`,
      'go.mod': `module github.com/acme/payments-service

go 1.23

require (
\tgithub.com/redis/go-redis/v9 v9.6.1
\tgithub.com/sony/gobreaker v1.0.0
\tgo.opentelemetry.io/otel v1.31.0
)
`,
      '.github/workflows/ci.yml': strongWorkflow,
      '.github/dependabot.yml': 'version: 2\nupdates:\n  - package-ecosystem: gomod\n    directory: /\n    schedule: { interval: weekly }\n',
      'CODEOWNERS': '* @acme/fintech-core\n',
      'k8s/deployment.yaml': `apiVersion: apps/v1
kind: Deployment
metadata:
  name: payments-service
spec:
  replicas: 6
  strategy:
    rollingUpdate: { maxUnavailable: 0, maxSurge: 25% }
  template:
    spec:
      securityContext: { runAsNonRoot: true }
      containers:
        - name: payments
          image: 123456789012.dkr.ecr.ap-south-1.amazonaws.com/payments-service@sha256:4b1e0f0c
          resources:
            requests: { cpu: "1", memory: 2Gi }
            limits: { memory: 2Gi }
          readinessProbe:
            httpGet: { path: /ready, port: 8080 }
          livenessProbe:
            httpGet: { path: /live, port: 8080 }
          startupProbe:
            httpGet: { path: /live, port: 8080 }
            failureThreshold: 30
---
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: payments-service
spec:
  minAvailable: 4
`,
      'internal/charge/client.go': `package charge

import (
\t"net/http"
\t"time"
)

var httpClient = &http.Client{Timeout: 3 * time.Second}
`,
    }),
    snap('acme/catalog-api', 'BA0003', {
      'Dockerfile': `FROM eclipse-temurin:21-jre
COPY target/catalog-api.jar /app.jar
USER 10001
ENTRYPOINT ["java", "-jar", "/app.jar"]
`,
      'pom.xml': `<project>
  <artifactId>catalog-api</artifactId>
  <dependencies>
    <dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-web</artifactId></dependency>
    <dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-data-jpa</artifactId></dependency>
    <dependency><groupId>com.mysql</groupId><artifactId>mysql-connector-j</artifactId></dependency>
  </dependencies>
</project>
`,
      '.github/workflows/ci.yml': weakWorkflow,
      'k8s/deployment.yaml': `apiVersion: apps/v1
kind: Deployment
metadata:
  name: catalog-api
spec:
  replicas: 16
  template:
    spec:
      containers:
        - name: api
          image: 123456789012.dkr.ecr.ap-south-1.amazonaws.com/catalog-api:2.14.0
          readinessProbe:
            httpGet: { path: /actuator/health/readiness, port: 8080 }
          livenessProbe:
            httpGet: { path: /actuator/health/liveness, port: 8080 }
`,
      'src/main/java/com/acme/catalog/ProductService.java': `package com.acme.catalog;

import java.util.List;

public class ProductService {
  private final ProductRepository products;
  private final AttributeRepository attributes;

  public ProductService(ProductRepository products, AttributeRepository attributes) {
    this.products = products;
    this.attributes = attributes;
  }

  public List<ProductView> listCategory(String categoryId) {
    List<Product> page = products.findByCategory(categoryId);
    return page.stream().map(p -> {
      // one query per product: N+1, and the same attributes are re-read on every request
      List<Attribute> attrs = attributes.findByProductId(p.getId());
      return ProductView.of(p, attrs);
    }).toList();
  }
}
`,
      'terraform/s3.tf': `resource "aws_s3_bucket" "catalog_images" {
  bucket = "acme-catalog-images"
}
`,
    }),
    snap('acme/identity-service', 'BA0004', {
      'Dockerfile': `FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install -r requirements.txt
COPY . .
CMD ["gunicorn", "app:app", "-b", "0.0.0.0:8000"]
`,
      'requirements.txt': 'flask==3.0.3\ngunicorn==22.0.0\nrequests==2.32.3\nPyJWT==2.8.0\n',
      '.github/workflows/ci.yml': weakWorkflow,
      'k8s/deployment.yaml': `apiVersion: apps/v1
kind: Deployment
metadata:
  name: identity-service
spec:
  replicas: 8
  template:
    spec:
      containers:
        - name: identity
          image: 123456789012.dkr.ecr.ap-south-1.amazonaws.com/identity-service:3.2.1
          resources:
            requests: { cpu: "1", memory: 2Gi }
            limits: { memory: 2Gi }
          readinessProbe:
            httpGet: { path: /healthz, port: 8000 }
          livenessProbe:
            httpGet: { path: /healthz, port: 8000 }
`,
      'app/config.py': `DB_PASSWORD = "dummy-not-a-real-secret"
JWT_ALGORITHMS = ["HS256", "none"]
`,
      'app/tenants.py': `import requests

def tenant_config(tenant_id):
    # called on every token validation; no cache
    return requests.get(f"http://config.internal/tenants/{tenant_id}").json()
`,
    }),
    snap('acme/notifications-worker', 'BA0005', {
      'Dockerfile': `FROM node:latest
COPY . .
RUN npm install
CMD ["node", "worker.js"]
`,
      'package.json': JSON.stringify({ name: 'notifications-worker', dependencies: { '@aws-sdk/client-sqs': '^3.600.0', 'node-fetch': '^3.3.2' } }, null, 2),
      '.github/workflows/ci.yml': weakWorkflow,
      'k8s/deployment.yaml': `apiVersion: apps/v1
kind: Deployment
metadata:
  name: notifications-worker
spec:
  replicas: 1
  template:
    spec:
      containers:
        - name: worker
          image: 123456789012.dkr.ecr.ap-south-1.amazonaws.com/notifications-worker:latest
          resources:
            requests: { cpu: "4", memory: 512Mi }
            limits: { cpu: "4", memory: 512Mi }
`,
      'worker.js': `import fetch from 'node-fetch'

export async function send(msg) {
  const res = await fetch(process.env.PROVIDER_URL, { method: 'POST', body: JSON.stringify(msg) })
  if (!res.ok) throw new Error('provider failed')
}
`,
      'terraform/main.tf': `provider "aws" {
  region = "ap-south-1"
}

resource "aws_sqs_queue" "notifications" {
  name = "notifications"
}
`,
    }),
  ]
}
