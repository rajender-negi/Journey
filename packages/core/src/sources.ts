// Native source schemas and their mappers.
//
// Live adapters (apps/server/src/adapters) and Cursor MCP agents both produce a RawBundle in the
// exact shape each source returns. `mapRawBundle` is the single place raw -> normalized happens,
// so dummy data and live data exercise identical code.
//
// `emitRawBundle` exists only for dummy mode: it renders the seeded scenario dataset into the
// native payload shapes so the mappers are tested end to end.
//
// Field names marked CONFIG depend on your tenant (custom CMDB fields, OpenPipeline enrichment).
// Change them in FIELD_MAP only.

import type {
  ChangeRequest, CostRecord, Dataset, Deployment, DoraFromDynatrace, Merge, PipelineRun, Problem,
  Product, RepoSnapshot, RuntimeEvent, ServiceMetrics, WorkloadUsage,
} from './types'

// ---------------- field map (tenant specific) ----------------

export const FIELD_MAP = {
  cmdb: {
    repos: 'u_repositories', // CONFIG: comma separated org/repo
    services: 'u_dynatrace_services', // CONFIG
    namespaces: 'u_k8s_namespaces', // CONFIG
    costTag: 'u_cost_tag', // CONFIG: value of the "product" cost allocation tag
    downtimeCost: 'u_downtime_cost_per_min', // CONFIG, optional
  },
  sdlc: {
    product: 'app.product.id', // CONFIG: OpenPipeline enrichment carrying CMDB id
    changeRequest: 'snow.change_request', // CONFIG: added by the pipeline when it opens the CR
    rollback: 'deployment.rollback', // CONFIG
  },
  awsCostTagKey: 'product', // cost allocation tag key
  githubStage: {
    build: /build|compile/i,
    test: /test|unit|integration/i,
    scan: /scan|trivy|codeql|snyk|sast/i,
  } as Record<'build' | 'test' | 'scan', RegExp>,
}

// ---------------- raw types ----------------

// ServiceNow Table API, sysparm_display_value=false except reference display fields
export interface SnowRef { value: string; display_value?: string; link?: string }
export interface SnowBusinessApp {
  sys_id: string
  number: string
  name: string
  owned_by: SnowRef
  support_group: SnowRef
  business_criticality: '1 - most critical' | '2 - somewhat critical' | '3 - less critical' | '4 - not critical'
  [custom: string]: unknown
}
export interface SnowChange {
  sys_id: string
  number: string
  state: '-5' | '-4' | '-3' | '-2' | '-1' | '0' | '3' | '4'
  risk: '2' | '3' | '4' // high | moderate | low
  type: 'standard' | 'normal' | 'emergency'
  approval: 'not requested' | 'requested' | 'approved' | 'rejected'
  opened_at: string // "YYYY-MM-DD HH:mm:ss" UTC
  approval_set: string
  start_date: string
  end_date: string
  closed_at: string
  close_code: '' | 'successful' | 'successful_issues' | 'unsuccessful'
  cmdb_ci: SnowRef // business app sys_id
  correlation_id: string // commit sha written by the pipeline
}

// GitHub REST v2022-11-28
export interface GhPull {
  number: number
  title: string
  user: { login: string }
  created_at: string
  merged_at: string | null
  merge_commit_sha: string
  additions?: number // single-PR endpoint only
  deletions?: number
  changed_files?: number
  base: { repo: { full_name: string } }
}
export interface GhCommit { sha: string; commit: { author: { date: string } } }
export interface GhJob {
  id: number
  run_id: number
  run_url: string
  head_sha: string
  name: string
  status: 'queued' | 'in_progress' | 'completed'
  conclusion: 'success' | 'failure' | 'cancelled' | 'skipped' | 'timed_out' | null
  started_at: string
  completed_at: string | null
  html_url: string
}
export interface GhAnnotation { path: string; start_line: number; annotation_level: 'notice' | 'warning' | 'failure'; message: string }
export interface GhContent { type: 'file'; path: string; encoding: 'base64'; content: string }

// Dynatrace Grail query:execute / query:poll response
export interface DqlResult {
  state: 'SUCCEEDED' | 'RUNNING' | 'FAILED'
  result: { records: Record<string, unknown>[]; metadata?: { grail?: { query?: string } } }
}

// Argo CD /api/v1/applications
export interface ArgoApp {
  metadata: { name: string; namespace: string }
  spec: { destination: { namespace: string }; source: { repoURL: string; targetRevision: string } }
  status: {
    sync: { status: 'Synced' | 'OutOfSync' | 'Unknown'; revision: string }
    health: { status: 'Healthy' | 'Progressing' | 'Degraded' | 'Suspended' | 'Missing' | 'Unknown'; message?: string }
    operationState?: { phase: 'Running' | 'Succeeded' | 'Failed' | 'Error' | 'Terminating'; message: string; startedAt: string; finishedAt?: string }
  }
}

// Kubernetes core/v1 Event
export interface K8sEvent {
  metadata: { name: string; namespace: string; uid: string }
  involvedObject: { kind: string; name: string; namespace: string }
  reason: string
  message: string
  type: 'Normal' | 'Warning'
  lastTimestamp: string
}

// AWS Cost Explorer GetCostAndUsage, GroupBy [SERVICE|USAGE_TYPE, TAG:product], Filter TAG:environment
export interface CeResponse {
  ResultsByTime: {
    TimePeriod: { Start: string; End: string }
    Groups: { Keys: [string, string]; Metrics: { UnblendedCost: { Amount: string; Unit: 'USD' } } }[]
  }[]
}

// Azure Cost Management Query API
/** One row of the Cloud Billing export to BigQuery (standard usage cost table), as the BigQuery API returns it once flattened. */
export interface GcpBillingRow {
  service: { id: string; description: string }
  sku: { id: string; description: string }
  usage_start_time: string
  usage_end_time: string
  project: { id: string }
  labels: { key: string; value: string }[]
  cost: number
  currency: string
}

export interface AzureCostQuery {
  properties: { columns: { name: string; type: string }[]; rows: (string | number)[][] }
}

export interface RawBundle {
  servicenow: { businessApps: SnowBusinessApp[]; changes: SnowChange[] }
  github: { pulls: GhPull[]; prCommits: Record<string, GhCommit[]>; jobs: GhJob[]; annotations: Record<string, GhAnnotation[]>; contents: Record<string, GhContent[]> }
  dynatrace: { problems: DqlResult; sdlcEvents: DqlResult; serviceMetrics: DqlResult; workloads: DqlResult; dora: DqlResult; billing: DqlResult }
  argocd: { applications: ArgoApp[] }
  kubernetes: { events: K8sEvent[] }
  // GetCostAndUsage allows two GroupBy dimensions, so two calls per environment filter
  aws: { costExplorer: { environment: string; byService: CeResponse; byUsageType: CeResponse }[]; commitmentCoverage: Record<string, number> }
  azure: { costManagement: AzureCostQuery }
  /** Cloud Billing export (BigQuery). Optional so older snapshots still load. */
  gcp?: { billingExport: GcpBillingRow[] }
  meta: { generatedAt: string; windowDays: number }
}

// ---------------- helpers ----------------

const snowTime = (iso?: string) => (iso ? iso.replace('T', ' ').replace(/\.\d+Z$|Z$/, '') : '')
const fromSnow = (s: string) => (s ? `${s.replace(' ', 'T')}Z` : undefined)
const dtTime = (iso: string) => iso.replace(/\.(\d{3})Z$/, '.$1000000Z')
const fromDt = (s: unknown) => new Date(String(s)).toISOString()
const splitList = (v: unknown) => String(v ?? '').split(',').map((s) => s.trim()).filter(Boolean)
const b64 = (s: string) => (typeof btoa === 'function' ? btoa(unescape(encodeURIComponent(s))) : Buffer.from(s, 'utf8').toString('base64'))
const unb64 = (s: string) => (typeof atob === 'function' ? decodeURIComponent(escape(atob(s.replace(/\n/g, '')))) : Buffer.from(s, 'base64').toString('utf8'))
const dql = (query: string, records: Record<string, unknown>[]): DqlResult => ({ state: 'SUCCEEDED', result: { records, metadata: { grail: { query } } } })

const CHANGE_STATE: Record<SnowChange['state'], ChangeRequest['state']> = {
  '-5': 'new', '-4': 'assess', '-3': 'authorize', '-2': 'scheduled', '-1': 'implement', '0': 'review', '3': 'closed', '4': 'canceled',
}
const CHANGE_STATE_REV = Object.fromEntries(Object.entries(CHANGE_STATE).map(([k, v]) => [v, k])) as Record<ChangeRequest['state'], SnowChange['state']>
const RISK: Record<SnowChange['risk'], ChangeRequest['risk']> = { '2': 'high', '3': 'moderate', '4': 'low' }
const RISK_REV = { high: '2', moderate: '3', low: '4' } as const
const CRIT: Record<SnowBusinessApp['business_criticality'], Product['tier']> = {
  '1 - most critical': 1, '2 - somewhat critical': 2, '3 - less critical': 3, '4 - not critical': 3,
}
const CRIT_REV = { 1: '1 - most critical', 2: '2 - somewhat critical', 3: '3 - less critical' } as const
const PROBLEM_CAT: Record<string, Problem['category']> = {
  AVAILABILITY: 'availability', ERROR: 'error', SLOWDOWN: 'slowdown', RESOURCE_CONTENTION: 'resource', CUSTOM_ALERT: 'custom',
}
const PROBLEM_CAT_REV = Object.fromEntries(Object.entries(PROBLEM_CAT).map(([k, v]) => [v, k]))

const envOfNamespace = (ns: string): 'dev' | 'staging' | 'prod' => (/-staging$/.test(ns) ? 'staging' : /-dev$/.test(ns) ? 'dev' : 'prod')

// AWS SERVICE dimension values exactly as Cost Explorer returns them
export const AWS_SERVICE: Record<string, string> = {
  'EKS compute (EC2)': 'Amazon Elastic Compute Cloud - Compute',
  'RDS PostgreSQL': 'Amazon Relational Database Service',
  'RDS MySQL': 'Amazon Relational Database Service',
  'Aurora PostgreSQL': 'Amazon Relational Database Service',
  EBS: 'EC2 - Other',
  'NAT Gateway data processing': 'Amazon Virtual Private Cloud',
  S3: 'Amazon Simple Storage Service',
  'ElastiCache Redis': 'Amazon ElastiCache',
  'SQS and SNS': 'Amazon Simple Queue Service',
}
// USAGE_TYPE prefix -> SERVICE, used to attach a usage type to each service line
const USAGE_TO_SERVICE: [RegExp, string][] = [
  [/BoxUsage:/, 'Amazon Elastic Compute Cloud - Compute'],
  [/InstanceUsage:db\./, 'Amazon Relational Database Service'],
  [/EBS:VolumeUsage/, 'EC2 - Other'],
  [/NatGateway-Bytes/, 'Amazon Virtual Private Cloud'],
  [/TimedStorage/, 'Amazon Simple Storage Service'],
  [/NodeUsage:cache\./, 'Amazon ElastiCache'],
  [/Requests-Tier/, 'Amazon Simple Queue Service'],
]
const usageLabel = (u: string) => u.replace(/^[A-Z]{2,4}\d?-/, '').replace(/^(BoxUsage|InstanceUsage|NodeUsage):/, '').replace(/^EBS:VolumeUsage\./, '')
const usageTypeFor = (service: string, usage?: string) => {
  if (!usage) return undefined
  if (/EKS|EC2\)/.test(service)) return `APS3-BoxUsage:${usage}`
  if (/RDS|Aurora/.test(service)) return `APS3-InstanceUsage:${usage}`
  if (service === 'EBS') return `APS3-EBS:VolumeUsage.${usage}`
  if (/NAT/.test(service)) return 'APS3-NatGateway-Bytes'
  if (service === 'S3') return 'APS3-TimedStorage-ByteHrs'
  if (/ElastiCache/.test(service)) return `APS3-NodeUsage:${usage}`
  return undefined
}

// ================= MAPPERS: raw -> normalized =================

export function mapProducts(apps: SnowBusinessApp[]): Product[] {
  const f = FIELD_MAP.cmdb
  return apps.map((a) => ({
    id: a.number,
    name: a.name,
    owner: a.owned_by?.display_value ?? a.owned_by?.value ?? '',
    team: a.support_group?.display_value ?? '',
    tier: CRIT[a.business_criticality] ?? 3,
    repos: splitList(a[f.repos]),
    services: splitList(a[f.services]),
    k8sNamespaces: splitList(a[f.namespaces]),
    costTags: { [FIELD_MAP.awsCostTagKey]: String(a[f.costTag] ?? a.name.toLowerCase()) },
    downtimeCostPerMin: a[f.downtimeCost] ? Number(a[f.downtimeCost]) : undefined,
  }))
}

export function mapChanges(rows: SnowChange[], apps: SnowBusinessApp[]): ChangeRequest[] {
  const bySys = new Map(apps.map((a) => [a.sys_id, a.number]))
  return rows.map((c) => ({
    number: c.number,
    productId: bySys.get(c.cmdb_ci.value) ?? c.cmdb_ci.value,
    state: CHANGE_STATE[c.state],
    risk: RISK[c.risk],
    type: c.type,
    createdAt: fromSnow(c.opened_at)!,
    approvedAt: c.approval === 'approved' ? fromSnow(c.approval_set) : undefined,
    plannedStart: fromSnow(c.start_date)!,
    plannedEnd: fromSnow(c.end_date)!,
    closedAt: fromSnow(c.closed_at),
    closeCode: c.close_code === '' ? undefined : c.close_code === 'successful_issues' ? 'successful_with_issues' : c.close_code,
    sha: c.correlation_id || undefined,
  }))
}

export function mapMerges(pulls: GhPull[], prCommits: Record<string, GhCommit[]>): Merge[] {
  return pulls.filter((p) => p.merged_at).map((p) => {
    const repo = p.base.repo.full_name
    const commits = prCommits[`${repo}#${p.number}`] ?? []
    const first = commits.map((c) => c.commit.author.date).sort()[0] ?? p.created_at
    return {
      repo, prNumber: p.number, title: p.title, author: p.user.login, sha: p.merge_commit_sha,
      firstCommitAt: first, openedAt: p.created_at, mergedAt: p.merged_at!,
      additions: p.additions ?? 0, deletions: p.deletions ?? 0, filesChanged: p.changed_files ?? 0,
    }
  })
}

export function mapJobs(jobs: GhJob[], annotations: Record<string, GhAnnotation[]>): PipelineRun[] {
  const out: PipelineRun[] = []
  for (const j of jobs) {
    const stage = (Object.keys(FIELD_MAP.githubStage) as ('build' | 'test' | 'scan')[]).find((s) => FIELD_MAP.githubStage[s].test(j.name))
    if (!stage) continue
    const repo = j.run_url.match(/repos\/([^/]+\/[^/]+)\/actions/)?.[1] ?? ''
    const failed = j.conclusion === 'failure' || j.conclusion === 'timed_out'
    const notes = (annotations[String(j.id)] ?? []).filter((a) => a.annotation_level === 'failure').map((a) => a.message)
    out.push({
      id: `gh-${j.id}`, system: 'github-actions', repo, sha: j.head_sha, stage,
      status: j.status !== 'completed' ? 'running' : failed ? 'failed' : j.conclusion === 'cancelled' ? 'cancelled' : 'succeeded',
      startedAt: j.started_at, finishedAt: j.completed_at ?? undefined, url: j.html_url,
      failureText: failed ? notes.join('\n') || `${j.name} failed` : undefined,
    })
  }
  return out
}

export function mapSdlcEvents(res: DqlResult, products: Product[]): { deployments: Deployment[]; runs: PipelineRun[] } {
  const f = FIELD_MAP.sdlc
  const byRepo = new Map(products.flatMap((p) => p.repos.map((r) => [r, p.id] as const)))
  const deployments: Deployment[] = []
  const runs: PipelineRun[] = []
  const finished = new Set<string>()
  const recs = res.result.records.filter((r) => r['event.kind'] === 'SDLC_EVENT' && r['event.category'] === 'deployment')
  for (const r of recs) if (r['event.status'] === 'finished') finished.add(String(r['cicd.pipeline.run.id']))
  for (const r of recs) {
    const repo = String(r['vcs.repository.url.full'] ?? '').replace(/^https:\/\/github\.com\//, '')
    const productId = String(r[f.product] ?? byRepo.get(repo) ?? '')
    const env = String(r['deployment.environment.name']) as Deployment['environment']
    const sha = String(r['vcs.ref.head.revision'])
    const runId = String(r['cicd.pipeline.run.id'])
    const url = r['cicd.pipeline.run.url.full'] as string | undefined
    if (r['event.status'] === 'started') {
      if (!finished.has(runId)) {
        runs.push({ id: runId, system: 'argocd', repo, sha, stage: 'deploy', environment: env, status: 'running', startedAt: fromDt(r['event.start']), url })
      }
      continue
    }
    const raw = String(r['deployment.status'])
    const status: Deployment['status'] = raw === 'succeeded' ? 'succeeded' : r[f.rollback] === true ? 'rolled_back' : 'failed'
    const dep: Deployment = {
      id: String(r['event.id']), productId, repo, sha, version: String(r['service.version'] ?? ''), environment: env, status,
      startedAt: fromDt(r['event.start']), finishedAt: fromDt(r['event.end']),
      source: String(r['event.provider']) === 'argocd' && env !== 'prod' ? 'argocd' : 'dynatrace-sdlc',
      changeRequest: (r[f.changeRequest] as string) || undefined,
      failureText: (r['event.description'] as string) || undefined,
    }
    deployments.push(dep)
    runs.push({
      id: runId, system: 'argocd', repo, sha, stage: 'deploy', environment: env,
      status: status === 'succeeded' ? 'succeeded' : 'failed', startedAt: dep.startedAt, finishedAt: dep.finishedAt, url, failureText: dep.failureText,
    })
  }
  return { deployments, runs }
}

export function mapProblems(res: DqlResult, products: Product[]): Problem[] {
  const bySvc = new Map(products.flatMap((p) => p.services.map((s) => [s, p.id] as const)))
  return res.result.records.map((r) => {
    const names = (r['affected_entity_names'] as string[]) ?? []
    return {
      id: String(r['event.id']),
      displayId: String(r['display_id']),
      title: String(r['event.name']),
      status: r['event.status'] === 'ACTIVE' ? 'open' : 'closed',
      category: PROBLEM_CAT[String(r['event.category'])] ?? 'custom',
      startedAt: fromDt(r['event.start']),
      endedAt: r['event.end'] ? fromDt(r['event.end']) : undefined,
      productId: names.map((n) => bySvc.get(n)).find(Boolean) ?? '',
      affectedEntities: names,
      rootCauseText: (r['event.description'] as string) || (r['root_cause_entity_name'] as string) || undefined,
    }
  })
}

export function mapServiceMetrics(res: DqlResult, products: Product[]): ServiceMetrics[] {
  const bySvc = new Map(products.flatMap((p) => p.services.map((s) => [s, p.id] as const)))
  return res.result.records.map((r) => ({
    productId: bySvc.get(String(r['service.name'])) ?? '',
    service: String(r['service.name']),
    windowDays: Number(r['window_days'] ?? 30),
    requests: Number(r['request_count']),
    failureRate: Number(r['failure_rate']),
    p95Ms: Number(r['response_time_p95']) / 1000, // Dynatrace reports microseconds
    dbCallsPerRequest: Number(r['db_calls_per_request']),
    repeatedQueryRatio: Number(r['repeated_query_ratio']),
    readWriteRatio: Number(r['read_write_ratio']),
    topQuery: (r['top_db_statement'] as string) || undefined,
  }))
}

export function mapWorkloads(res: DqlResult, products: Product[]): WorkloadUsage[] {
  const byNs = (ns: string) => products.find((p) => p.k8sNamespaces.some((n) => ns === n || ns.startsWith(`${n}-`)))?.id ?? ''
  return res.result.records.map((r) => {
    const ns = String(r['k8s.namespace.name'])
    return {
      productId: byNs(ns), namespace: ns, workload: String(r['k8s.workload.name']), environment: envOfNamespace(ns),
      replicas: Number(r['replicas']),
      cpuRequestCores: Number(r['cpu_requests_millicores']) / 1000, cpuUsedP95Cores: Number(r['cpu_usage_p95_millicores']) / 1000,
      memRequestGiB: Number(r['memory_requests_bytes']) / 2 ** 30, memUsedP95GiB: Number(r['memory_working_set_p95_bytes']) / 2 ** 30,
    }
  })
}

export function mapDora(res: DqlResult, products: Product[]): DoraFromDynatrace[] {
  return res.result.records.map((r) => ({
    productId: String(r[FIELD_MAP.sdlc.product] ?? products.find((p) => p.name === r['product.name'])?.id ?? ''),
    deploymentFrequencyPerDay: r['deployment_frequency_per_day'] as number | undefined,
    leadTimeHours: r['lead_time_hours'] as number | undefined,
    changeFailureRate: r['change_failure_rate'] as number | undefined,
    mttrHours: r['mttr_hours'] as number | undefined,
  }))
}

export function mapK8sEvents(events: K8sEvent[], products: Product[]): RuntimeEvent[] {
  const byNs = (ns: string) => products.find((p) => p.k8sNamespaces.some((n) => ns === n || ns.startsWith(`${n}-`)))?.id ?? ''
  return events.filter((e) => e.type === 'Warning').map((e) => ({
    id: e.metadata.uid, productId: byNs(e.metadata.namespace), kind: 'k8s', reason: e.reason, message: e.message,
    workload: e.involvedObject.name, namespace: e.metadata.namespace, at: e.lastTimestamp,
  }))
}

export function mapAwsCosts(rows: RawBundle['aws'], products: Product[]): CostRecord[] {
  const key = FIELD_MAP.awsCostTagKey
  const byTag = new Map(products.map((p) => [p.costTags[key], p.id]))
  const out: CostRecord[] = []
  for (const { environment, byService, byUsageType } of rows.costExplorer) {
    // usage types per product+month+service, from the second (USAGE_TYPE + TAG) query
    const usage = new Map<string, string>()
    for (const t of byUsageType.ResultsByTime) {
      for (const g of t.Groups) {
        const svc = USAGE_TO_SERVICE.find(([re]) => re.test(g.Keys[0]))?.[1]
        if (svc) usage.set(`${t.TimePeriod.Start}|${g.Keys[1]}|${svc}`, usageLabel(g.Keys[0]))
      }
    }
    for (const t of byService.ResultsByTime) {
      for (const g of t.Groups) {
        const [service, tag] = g.Keys
        const productId = byTag.get(tag.replace(`${key}$`, ''))
        if (!productId) continue
        out.push({
          productId, provider: 'aws', service, month: t.TimePeriod.Start.slice(0, 7),
          amount: Number(g.Metrics.UnblendedCost.Amount), usageType: usage.get(`${t.TimePeriod.Start}|${tag}|${service}`),
          environment: environment as CostRecord['environment'],
          commitmentCovered: rows.commitmentCoverage[`${productId}|${service}|${environment}`] ?? rows.commitmentCoverage[`*|${service}|${environment}`] ?? 0,
        })
      }
    }
  }
  return out
}

export function mapAzureCosts(q: AzureCostQuery, products: Product[]): CostRecord[] {
  const cols = q.properties.columns.map((c) => c.name)
  const i = (n: string) => cols.indexOf(n)
  const byTag = new Map(products.map((p) => [p.costTags[FIELD_MAP.awsCostTagKey], p.id]))
  return q.properties.rows.flatMap((row) => {
    const productId = byTag.get(String(row[i('TagValue')]))
    if (!productId) return []
    const bm = String(row[i('BillingMonth')])
    return [{
      productId, provider: 'azure' as const, service: String(row[i('ServiceName')]), month: bm.slice(0, 7),
      amount: Number(row[i('PreTaxCost')]), environment: String(row[i('Environment')] ?? 'prod') as CostRecord['environment'],
    }]
  })
}

export function mapGcpCosts(rows: GcpBillingRow[], products: Product[]): CostRecord[] {
  const byTag = new Map(products.map((p) => [p.costTags[FIELD_MAP.awsCostTagKey], p.id]))
  const acc = new Map<string, CostRecord>()
  for (const r of rows) {
    const label = (k: string) => r.labels.find((l) => l.key === k)?.value
    const productId = byTag.get(label(FIELD_MAP.awsCostTagKey) ?? '')
    if (!productId) continue
    const month = r.usage_start_time.slice(0, 7)
    const environment = (label('environment') ?? 'prod') as CostRecord['environment']
    const key = `${productId}|${r.service.description}|${month}|${environment}`
    const cur = acc.get(key) ?? { productId, provider: 'gcp' as const, service: r.service.description, month, amount: 0, environment }
    cur.amount += Number(r.cost)
    acc.set(key, cur)
  }
  return [...acc.values()].map((c) => ({ ...c, amount: Math.round(c.amount * 100) / 100 }))
}

export function mapDynatraceBilling(res: DqlResult, products: Product[]): CostRecord[] {
  return res.result.records.map((r) => ({
    productId: String(r[FIELD_MAP.sdlc.product] ?? products.find((p) => p.name === r['product.name'])?.id ?? ''),
    provider: 'dynatrace', service: String(r['capability']), month: String(r['month']), amount: Number(r['cost_usd']), environment: 'shared',
  }))
}

export function mapContents(contents: Record<string, GhContent[]>, products: Product[]): RepoSnapshot[] {
  return Object.entries(contents).map(([repo, files]) => ({
    repo, ref: 'main', productId: products.find((p) => p.repos.includes(repo))?.id ?? '',
    files: files.map((f) => ({ path: f.path, content: unb64(f.content) })),
  }))
}

export function mapArgoApps(apps: ArgoApp[], products: Product[], now: string): RuntimeEvent[] {
  const byNs = (ns: string) => products.find((p) => p.k8sNamespaces.some((n) => ns === n || ns.startsWith(`${n}-`)))?.id ?? ''
  return apps
    .filter((a) => a.status.health.status === 'Degraded' || a.status.health.status === 'Missing')
    .map((a) => ({
      id: `argo-${a.metadata.name}`, productId: byNs(a.spec.destination.namespace), kind: 'k8s' as const,
      reason: `ArgoCD${a.status.health.status}`, message: a.status.operationState?.message ?? a.status.health.message ?? '',
      workload: a.metadata.name, namespace: a.spec.destination.namespace, at: a.status.operationState?.finishedAt ?? now,
    }))
}

/** The single raw -> normalized entry point used by live mode, MCP snapshot mode and dummy mode. */
export function mapRawBundle(raw: RawBundle): Dataset {
  const products = mapProducts(raw.servicenow.businessApps)
  const sdlc = mapSdlcEvents(raw.dynatrace.sdlcEvents, products)
  const argoEvents = mapArgoApps(raw.argocd.applications, products, raw.meta.generatedAt)
  const k8sEvents = mapK8sEvents(raw.kubernetes.events, products)
  return {
    generatedAt: raw.meta.generatedAt,
    windowDays: raw.meta.windowDays,
    products,
    merges: mapMerges(raw.github.pulls, raw.github.prCommits),
    pipelineRuns: [...mapJobs(raw.github.jobs, raw.github.annotations), ...sdlc.runs],
    deployments: sdlc.deployments,
    changeRequests: mapChanges(raw.servicenow.changes, raw.servicenow.businessApps),
    problems: mapProblems(raw.dynatrace.problems, products),
    runtimeEvents: [...k8sEvents, ...argoEvents.filter((a) => !k8sEvents.some((k) => k.productId === a.productId && k.at === a.at))],
    serviceMetrics: mapServiceMetrics(raw.dynatrace.serviceMetrics, products),
    workloadUsage: mapWorkloads(raw.dynatrace.workloads, products),
    costs: [...mapAwsCosts(raw.aws, products), ...mapAzureCosts(raw.azure.costManagement, products), ...mapGcpCosts(raw.gcp?.billingExport ?? [], products), ...mapDynatraceBilling(raw.dynatrace.billing, products)],
    repos: mapContents(raw.github.contents, products),
    doraFromDynatrace: mapDora(raw.dynatrace.dora, products),
  }
}

// ================= EMITTERS: normalized -> raw (dummy mode only) =================

export const DQL = {
  problems: `fetch dt.davis.problems, from: now()-30d
| filter not(dt.davis.is_duplicate)
| expand affected_entity_id = affected_entity_ids
| fieldsAdd affected_entity_name = entityName(affected_entity_id)
| summarize { affected_entity_ids = collectArray(affected_entity_id), affected_entity_names = collectArray(affected_entity_name) },
    by: { event.id, display_id, event.name, event.status, event.category, event.start, event.end, event.description, root_cause_entity_id, root_cause_entity_name }`,
  sdlcEvents: `fetch events, from: now()-30d
| filter event.kind == "SDLC_EVENT" and event.category == "deployment"
| fields event.id, event.kind, event.category, event.provider, event.status, event.start, event.end, event.description,
         cicd.pipeline.run.id, cicd.pipeline.run.url.full, vcs.repository.url.full, vcs.ref.head.revision,
         deployment.environment.name, deployment.status, deployment.rollback, service.version, app.product.id, snow.change_request`,
  serviceMetrics: `timeseries { req = sum(dt.service.request.count), fail = sum(dt.service.request.failure_count), p95 = percentile(dt.service.request.response_time, 95) },
  by: { dt.entity.service }, from: now()-30d
| fieldsAdd service.name = entityName(dt.entity.service), request_count = arraySum(req), failure_rate = arraySum(fail) / arraySum(req), response_time_p95 = arrayAvg(p95)
| join [ fetch spans, from: now()-7d | filter isNotNull(db.statement)
        | summarize db_calls = count(), distinct_statements = countDistinct(db.statement), reads = countIf(startsWith(lower(db.statement), "select")), by: { service.name, trace.id }
        | summarize db_calls_per_request = avg(db_calls), repeated_query_ratio = 1 - avg(toDouble(distinct_statements) / db_calls), read_write_ratio = sum(reads) / (sum(db_calls) - sum(reads) + 1), by: { service.name } ],
  on: { service.name }, fields: { db_calls_per_request, repeated_query_ratio, read_write_ratio }`,
  workloads: `timeseries { cpu_use = percentile(dt.kubernetes.container.cpu_usage, 95), cpu_req = avg(dt.kubernetes.container.requests_cpu),
  mem_use = percentile(dt.kubernetes.container.memory_working_set, 95), mem_req = avg(dt.kubernetes.container.requests_memory), pods = avg(dt.kubernetes.pods) },
  by: { k8s.namespace.name, k8s.workload.name }, from: now()-14d
| fieldsAdd cpu_usage_p95_millicores = arrayMax(cpu_use), cpu_requests_millicores = arrayAvg(cpu_req), memory_working_set_p95_bytes = arrayMax(mem_use), memory_requests_bytes = arrayAvg(mem_req), replicas = round(arrayAvg(pods))`,
  dora: `// Reads the DORA values your Dynatrace SDLC/DORA app already computes. Adjust to your DORA query or dashboard tile.
fetch events, from: now()-30d | filter event.kind == "SDLC_EVENT" and event.category == "deployment" and deployment.environment.name == "prod"
| summarize deployments = count(), failed = countIf(deployment.status != "succeeded"), by: { app.product.id }
| fieldsAdd deployment_frequency_per_day = deployments / 30.0, change_failure_rate = toDouble(failed) / deployments`,
  billing: `fetch dt.system.events, from: now()-180d
| filter event.kind == "BILLING_USAGE_EVENT"
| summarize cost_usd = sum(billed_cost), by: { app.product.id, capability = event.type, month = formatTimestamp(timestamp, format: "yyyy-MM") }`,
}

export function emitRawBundle(ds: Dataset): RawBundle {
  const sysId = (p: Product) => `sys_${p.id.toLowerCase()}`
  const f = FIELD_MAP.cmdb
  const businessApps: SnowBusinessApp[] = ds.products.map((p) => ({
    sys_id: sysId(p), number: p.id, name: p.name,
    owned_by: { value: `usr_${p.owner.split(' ')[0].toLowerCase()}`, display_value: p.owner },
    support_group: { value: `grp_${p.team.replace(/\s/g, '').toLowerCase()}`, display_value: p.team },
    business_criticality: CRIT_REV[p.tier],
    [f.repos]: p.repos.join(','), [f.services]: p.services.join(','), [f.namespaces]: p.k8sNamespaces.join(','),
    [f.costTag]: p.costTags[FIELD_MAP.awsCostTagKey], [f.downtimeCost]: p.downtimeCostPerMin ? String(p.downtimeCostPerMin) : '',
  }))
  const prodById = new Map(ds.products.map((p) => [p.id, p]))
  const changes: SnowChange[] = ds.changeRequests.map((c) => ({
    sys_id: `chg_${c.number}`, number: c.number, state: CHANGE_STATE_REV[c.state], risk: RISK_REV[c.risk], type: c.type,
    approval: c.approvedAt ? 'approved' : c.state === 'authorize' ? 'requested' : 'not requested',
    opened_at: snowTime(c.createdAt), approval_set: snowTime(c.approvedAt), start_date: snowTime(c.plannedStart), end_date: snowTime(c.plannedEnd),
    closed_at: snowTime(c.closedAt), close_code: c.closeCode === 'successful_with_issues' ? 'successful_issues' : c.closeCode ?? '',
    cmdb_ci: { value: sysId(prodById.get(c.productId)!), display_value: prodById.get(c.productId)!.name }, correlation_id: c.sha ?? '',
  }))

  const pulls: GhPull[] = ds.merges.map((m) => ({
    number: m.prNumber, title: m.title, user: { login: m.author }, created_at: m.openedAt, merged_at: m.mergedAt, merge_commit_sha: m.sha,
    additions: m.additions, deletions: m.deletions, changed_files: m.filesChanged, base: { repo: { full_name: m.repo } },
  }))
  const prCommits: Record<string, GhCommit[]> = Object.fromEntries(ds.merges.map((m) => [`${m.repo}#${m.prNumber}`, [{ sha: `${m.sha}c1`, commit: { author: { date: m.firstCommitAt } } }]]))
  const jobs: GhJob[] = []
  const annotations: Record<string, GhAnnotation[]> = {}
  let jid = 31_000_000_000
  for (const r of ds.pipelineRuns.filter((x) => x.system === 'github-actions')) {
    const id = ++jid
    const runId = 11_000_000_000 + (id % 1_000_000)
    jobs.push({
      id, run_id: runId, run_url: `https://api.github.com/repos/${r.repo}/actions/runs/${runId}`, head_sha: r.sha,
      name: r.stage === 'scan' ? 'scan (trivy)' : r.stage, status: r.status === 'running' ? 'in_progress' : 'completed',
      conclusion: r.status === 'running' ? null : r.status === 'failed' ? 'failure' : r.status === 'cancelled' ? 'cancelled' : 'success',
      started_at: r.startedAt, completed_at: r.finishedAt ?? null, html_url: `https://github.com/${r.repo}/actions/runs/${runId}/job/${id}`,
    })
    if (r.failureText) annotations[String(id)] = [{ path: '.github', start_line: 1, annotation_level: 'failure', message: r.failureText }]
  }
  const contents: Record<string, GhContent[]> = Object.fromEntries(ds.repos.map((s) => [s.repo, s.files.map((x): GhContent => ({ type: 'file', path: x.path, encoding: 'base64', content: b64(x.content) }))]))

  // SDLC events: one finished event per deployment, plus started events for deploys still running
  const sdlc: Record<string, unknown>[] = []
  for (const d of ds.deployments) {
    const runId = `argo-${d.id}`
    const base = {
      'event.kind': 'SDLC_EVENT', 'event.category': 'deployment', 'event.provider': 'argocd',
      'cicd.pipeline.run.id': runId, 'cicd.pipeline.run.url.full': `https://argocd.acme.internal/applications/${prodById.get(d.productId)!.k8sNamespaces[0]}-${d.environment}`,
      'vcs.repository.url.full': `https://github.com/${d.repo}`, 'vcs.ref.head.revision': d.sha,
      'deployment.environment.name': d.environment, 'service.version': d.version, [FIELD_MAP.sdlc.product]: d.productId,
    }
    sdlc.push({ ...base, 'event.id': `${d.id}-s`, 'event.status': 'started', 'event.start': dtTime(d.startedAt) })
    sdlc.push({
      ...base, 'event.id': d.id, 'event.status': 'finished', 'event.start': dtTime(d.startedAt), 'event.end': dtTime(d.finishedAt),
      'deployment.status': d.status === 'succeeded' ? 'succeeded' : 'failed', [FIELD_MAP.sdlc.rollback]: d.status === 'rolled_back',
      [FIELD_MAP.sdlc.changeRequest]: d.changeRequest ?? null, 'event.description': d.failureText ?? null,
    })
  }
  for (const r of ds.pipelineRuns.filter((x) => x.system === 'argocd' && x.status === 'running')) {
    const p = ds.products.find((pp) => pp.repos.includes(r.repo))!
    sdlc.push({
      'event.kind': 'SDLC_EVENT', 'event.category': 'deployment', 'event.provider': 'argocd', 'event.id': `${r.id}-s`, 'event.status': 'started',
      'event.start': dtTime(r.startedAt), 'cicd.pipeline.run.id': r.id, 'vcs.repository.url.full': `https://github.com/${r.repo}`,
      'vcs.ref.head.revision': r.sha, 'deployment.environment.name': r.environment, [FIELD_MAP.sdlc.product]: p.id,
    })
  }

  const problems = ds.problems.map((p) => ({
    'event.id': p.id, display_id: p.displayId, 'event.name': p.title, 'event.status': p.status === 'open' ? 'ACTIVE' : 'CLOSED',
    'event.category': PROBLEM_CAT_REV[p.category], 'event.start': dtTime(p.startedAt), 'event.end': p.endedAt ? dtTime(p.endedAt) : null,
    'event.description': p.rootCauseText ?? null, affected_entity_ids: p.affectedEntities.map((n) => `SERVICE-${hash(n)}`),
    affected_entity_names: p.affectedEntities, root_cause_entity_id: null, root_cause_entity_name: null,
  }))

  const svc = ds.serviceMetrics.map((m) => ({
    'dt.entity.service': `SERVICE-${hash(m.service)}`, 'service.name': m.service, window_days: m.windowDays, request_count: m.requests,
    failure_rate: m.failureRate, response_time_p95: m.p95Ms * 1000, db_calls_per_request: m.dbCallsPerRequest,
    repeated_query_ratio: m.repeatedQueryRatio, read_write_ratio: m.readWriteRatio, top_db_statement: m.topQuery ?? null,
  }))
  const wl = ds.workloadUsage.map((w) => ({
    'k8s.namespace.name': w.namespace, 'k8s.workload.name': w.workload, replicas: w.replicas,
    cpu_requests_millicores: w.cpuRequestCores * 1000, cpu_usage_p95_millicores: w.cpuUsedP95Cores * 1000,
    memory_requests_bytes: w.memRequestGiB * 2 ** 30, memory_working_set_p95_bytes: w.memUsedP95GiB * 2 ** 30,
  }))
  const dora = ds.doraFromDynatrace.map((d) => ({
    [FIELD_MAP.sdlc.product]: d.productId, deployment_frequency_per_day: d.deploymentFrequencyPerDay, lead_time_hours: d.leadTimeHours,
    change_failure_rate: d.changeFailureRate, mttr_hours: d.mttrHours,
  }))
  const billing = ds.costs.filter((c) => c.provider === 'dynatrace').map((c) => ({ [FIELD_MAP.sdlc.product]: c.productId, capability: c.service, month: c.month, cost_usd: c.amount }))

  // AWS Cost Explorer: per environment filter, one call grouped by SERVICE and one by USAGE_TYPE
  const awsRows = ds.costs.filter((c) => c.provider === 'aws')
  const envs = [...new Set(awsRows.map((c) => c.environment ?? 'prod'))]
  const commitmentCoverage: Record<string, number> = {}
  const period = (m: string) => {
    const [y, mo] = m.split('-').map(Number)
    return { Start: `${m}-01`, End: new Date(Date.UTC(y, mo, 1)).toISOString().slice(0, 10) }
  }
  const tagKey = (pid: string) => `${FIELD_MAP.awsCostTagKey}$${prodById.get(pid)!.costTags[FIELD_MAP.awsCostTagKey]}`
  const metric = (n: number) => ({ UnblendedCost: { Amount: n.toFixed(2), Unit: 'USD' as const } })
  const costExplorer = envs.map((environment) => {
    const rows = awsRows.filter((c) => (c.environment ?? 'prod') === environment)
    const months = [...new Set(rows.map((c) => c.month))].sort()
    return {
      environment,
      byService: {
        ResultsByTime: months.map((m) => ({
          TimePeriod: period(m),
          Groups: rows.filter((c) => c.month === m).map((c) => {
            const svc = AWS_SERVICE[c.service] ?? c.service
            commitmentCoverage[`${c.productId}|${svc}|${environment}`] = c.commitmentCovered ?? 0
            return { Keys: [svc, tagKey(c.productId)] as [string, string], Metrics: metric(c.amount) }
          }),
        })),
      },
      byUsageType: {
        ResultsByTime: months.map((m) => ({
          TimePeriod: period(m),
          Groups: rows.filter((c) => c.month === m && usageTypeFor(c.service, c.usageType)).map((c) => ({
            Keys: [usageTypeFor(c.service, c.usageType)!, tagKey(c.productId)] as [string, string], Metrics: metric(c.amount),
          })),
        })),
      },
    }
  })
  const azureRows = ds.costs.filter((c) => c.provider === 'azure')
  const costManagement: AzureCostQuery = {
    properties: {
      columns: [
        { name: 'PreTaxCost', type: 'Number' }, { name: 'BillingMonth', type: 'Datetime' }, { name: 'ServiceName', type: 'String' },
        { name: 'TagValue', type: 'String' }, { name: 'Environment', type: 'String' }, { name: 'Currency', type: 'String' },
      ],
      rows: azureRows.map((c) => [c.amount, `${c.month}-01T00:00:00`, c.service, prodById.get(c.productId)!.costTags[FIELD_MAP.awsCostTagKey], c.environment ?? 'prod', 'USD']),
    },
  }

  const billingExport: GcpBillingRow[] = ds.costs.filter((c) => c.provider === 'gcp').map((c) => {
    const [y, m] = c.month.split('-').map(Number)
    const end = new Date(Date.UTC(y, m, 1)).toISOString()
    return {
      service: { id: c.service === 'Cloud Run' ? '152E-C115-5142' : '58CD-E7C3-72CA', description: c.service },
      sku: { id: `${c.service.replace(/\W/g, '').toUpperCase()}-USAGE`, description: `${c.service} usage` },
      usage_start_time: `${c.month}-01T00:00:00Z`, usage_end_time: end,
      project: { id: `${prodById.get(c.productId)!.costTags[FIELD_MAP.awsCostTagKey]}-prod` },
      labels: [{ key: FIELD_MAP.awsCostTagKey, value: prodById.get(c.productId)!.costTags[FIELD_MAP.awsCostTagKey] }, { key: 'environment', value: c.environment ?? 'prod' }],
      cost: c.amount, currency: 'USD',
    }
  })

  const events: K8sEvent[] = ds.runtimeEvents.map((e) => ({
    metadata: { name: `${e.workload}.${hash(e.id)}`, namespace: e.namespace ?? '', uid: e.id },
    involvedObject: { kind: 'Pod', name: `${e.workload}-${hash(e.id).slice(0, 5)}`, namespace: e.namespace ?? '' },
    reason: e.reason, message: e.message, type: 'Warning', lastTimestamp: e.at,
  }))
  // Live Argo CD state per product/env from the latest deployment
  const applications: ArgoApp[] = []
  for (const p of ds.products) {
    for (const env of ['staging', 'prod'] as const) {
      const last = ds.deployments.filter((d) => d.productId === p.id && d.environment === env).sort((a, b) => a.finishedAt.localeCompare(b.finishedAt)).at(-1)
      if (!last) continue
      const ns = env === 'prod' ? p.k8sNamespaces[0] : `${p.k8sNamespaces[0]}-${env}`
      applications.push({
        metadata: { name: `${p.k8sNamespaces[0]}-${env}`, namespace: 'argocd' },
        spec: { destination: { namespace: ns }, source: { repoURL: `https://github.com/${last.repo}.git`, targetRevision: 'HEAD' } },
        status: {
          sync: { status: 'Synced', revision: last.sha },
          health: { status: 'Healthy' },
          operationState: { phase: 'Succeeded', message: 'successfully synced (all tasks run)', startedAt: last.startedAt, finishedAt: last.finishedAt },
        },
      })
    }
  }

  return {
    servicenow: { businessApps, changes },
    github: { pulls, prCommits, jobs, annotations, contents },
    dynatrace: {
      problems: dql(DQL.problems, problems), sdlcEvents: dql(DQL.sdlcEvents, sdlc), serviceMetrics: dql(DQL.serviceMetrics, svc),
      workloads: dql(DQL.workloads, wl), dora: dql(DQL.dora, dora), billing: dql(DQL.billing, billing),
    },
    argocd: { applications },
    kubernetes: { events },
    aws: { costExplorer, commitmentCoverage },
    azure: { costManagement },
    gcp: { billingExport },
    meta: { generatedAt: ds.generatedAt, windowDays: ds.windowDays },
  }
}

function hash(s: string): string {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return (h >>> 0).toString(16).toUpperCase().padStart(8, '0')
}

export type SourceKey = Exclude<keyof RawBundle, 'meta'>
export const SOURCE_KEYS: SourceKey[] = ['servicenow', 'github', 'dynatrace', 'argocd', 'kubernetes', 'aws', 'azure', 'gcp']

/** The native payload a switched-off (or unconnected) source contributes: the right shape, no records. */
export function emptySource<K extends SourceKey>(s: K): NonNullable<RawBundle[K]> {
  const dq = (q: string): DqlResult => ({ state: 'SUCCEEDED', result: { records: [], metadata: { grail: { query: q } } } } as unknown as DqlResult)
  const empty: { [P in SourceKey]: NonNullable<RawBundle[P]> } = {
    servicenow: { businessApps: [], changes: [] },
    github: { pulls: [], prCommits: {}, jobs: [], annotations: {}, contents: {} },
    dynatrace: { problems: dq(DQL.problems), sdlcEvents: dq(DQL.sdlcEvents), serviceMetrics: dq(DQL.serviceMetrics), workloads: dq(DQL.workloads), dora: dq(DQL.dora), billing: dq(DQL.billing) },
    argocd: { applications: [] },
    kubernetes: { events: [] },
    aws: { costExplorer: [], commitmentCoverage: {} },
    azure: { costManagement: { properties: { columns: [], rows: [] } } as unknown as AzureCostQuery },
    gcp: { billingExport: [] },
  }
  return empty[s] as NonNullable<RawBundle[K]>
}

/** A bundle with the given sources switched off. */
export function withSourcesOff(raw: RawBundle, off: SourceKey[]): RawBundle {
  const out = { ...raw } as RawBundle
  for (const s of off) (out as unknown as Record<string, unknown>)[s] = emptySource(s)
  return out
}
