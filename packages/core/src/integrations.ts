// Integration contract: for each tool, what the app expects to receive, how it connects, which
// views it feeds, and a sample record in the tool's own schema (taken from whatever tier is loaded:
// live, MCP, Cursor snapshot or dummy). The Integrations screen renders this.

import type { RawBundle } from './sources'

export type IntegrationId = 'servicenow' | 'github' | 'dynatrace' | 'argocd' | 'kubernetes' | 'aws' | 'azure' | 'gcp'

export interface IntegrationSpec {
  id: IntegrationId
  name: string
  role: string
  provides: string[] // fields the engines rely on
  feeds: string[] // app views
  connect: { mode: 'REST' | 'MCP' | 'CLI'; how: string }[]
  env: string[]
  mcpTools?: string[]
  schemaFile: string
}

export const INTEGRATIONS: IntegrationSpec[] = [
  {
    id: 'servicenow', name: 'ServiceNow', role: 'Product identity (CMDB) and change requests',
    provides: ['cmdb_ci_business_app: number, name, owned_by, support_group, business_criticality', 'custom: u_repositories, u_dynatrace_services, u_k8s_namespaces, u_cost_tag', 'change_request: number, state, risk, type, approval, opened_at, start_date, closed_at, close_code, correlation_id (commit SHA)'],
    feeds: ['every view (product list and joins)', 'Journeys: change stage', 'Fixes: change approval wait'],
    connect: [{ mode: 'REST', how: 'Table API /api/now/table/cmdb_ci_business_app and /change_request, sysparm_display_value=all' }, { mode: 'MCP', how: 'Cursor ServiceNow MCP agent, POST /api/ingest/servicenow' }],
    env: ['SNOW_INSTANCE', 'SNOW_TOKEN or SNOW_USER + SNOW_PASSWORD', 'SNOW_PRODUCT_QUERY'],
    schemaFile: 'fixtures/raw/servicenow.json',
  },
  {
    id: 'github', name: 'GitHub', role: 'Merges, CI jobs and failure annotations, repository contents',
    provides: ['pulls: number, title, user.login, created_at, merged_at, merge_commit_sha, additions, deletions', 'jobs: name, status, conclusion, started_at, completed_at, head_sha', 'check-run annotations: failure messages', 'contents: Dockerfile, manifests, workflows, dependency files, source'],
    feeds: ['Journeys: merged, build, test, scan', 'Fixes: compile, flaky test, vulnerability gate', 'Codebase', 'Agent: PR files, job logs'],
    connect: [{ mode: 'REST', how: 'REST v2022-11-28: pulls, actions/runs/*/jobs, check-runs/*/annotations, git/trees, contents' }, { mode: 'MCP', how: 'github-mcp: get_pull_request_files, get_job_logs (agent evidence)' }],
    env: ['PJ_GITHUB_TOKEN', 'GITHUB_API'],
    mcpTools: ['get_pull_request_files', 'get_job_logs'],
    schemaFile: 'fixtures/raw/github.json',
  },
  {
    id: 'dynatrace', name: 'Dynatrace', role: 'Hub: problems, SDLC deployment events, service and workload metrics, DORA, billing',
    provides: ['dt.davis.problems: display_id, event.name, event.status, event.category, event.start, event.end, affected entity names', 'SDLC events: deployment.status, deployment.environment.name, vcs.ref.head.revision, service.version, app.product.id, snow.change_request', 'service metrics: request count, failure rate, p95, DB calls per request, repeated statement ratio', 'workloads: CPU and memory requests vs p95 usage', 'DORA values and billing by product'],
    feeds: ['Journeys: staging, prod, verified', 'Overview: DORA', 'Fixes: regressions', 'Codebase: runtime joins', 'Cost: rightsizing, log retention', 'Agent: problem, p95, error rate, deployment events'],
    connect: [{ mode: 'REST', how: 'Grail query API /platform/storage/query/v1/query:execute with the DQL in core/sources.ts' }, { mode: 'MCP', how: 'dynatrace-mcp execute_dql (collector "mcp" tier and agent evidence)' }],
    env: ['DT_ENV_URL', 'DT_PLATFORM_TOKEN'],
    mcpTools: ['execute_dql'],
    schemaFile: 'fixtures/raw/dynatrace.json',
  },
  {
    id: 'argocd', name: 'Argo CD', role: 'Deployment state per product and environment',
    provides: ['applications: metadata.name, spec.destination.namespace, status.sync.status, status.health.status, status.operationState.phase and message'],
    feeds: ['Fixes: degraded apps', 'Agent: application sync and health'],
    connect: [{ mode: 'REST', how: '/api/v1/applications' }, { mode: 'MCP', how: 'argocd-mcp list_applications, get_application' }],
    env: ['ARGOCD_URL', 'ARGOCD_TOKEN'],
    mcpTools: ['list_applications', 'get_application'],
    schemaFile: 'fixtures/raw/argocd.json',
  },
  {
    id: 'kubernetes', name: 'Kubernetes / EKS', role: 'Runtime warning events in product namespaces',
    provides: ['core/v1 Event: reason (CrashLoopBackOff, OOMKilled, ImagePullBackOff), message, involvedObject, lastTimestamp'],
    feeds: ['Fixes: crash loop, OOM, image pull', 'Agent: namespace events'],
    connect: [{ mode: 'REST', how: '/api/v1/events?fieldSelector=type=Warning' }, { mode: 'MCP', how: 'kubernetes-mcp events_list (read only)' }],
    env: ['K8S_API', 'K8S_TOKEN'],
    mcpTools: ['events_list'],
    schemaFile: 'fixtures/raw/kubernetes.json',
  },
  {
    id: 'aws', name: 'AWS', role: 'Cost by product, service, usage type and environment',
    provides: ['GetCostAndUsage grouped by SERVICE + TAG:product and USAGE_TYPE + TAG:product, filtered by environment tag', 'Savings Plans coverage by service'],
    feeds: ['Cost', 'Overview: spend per product'],
    connect: [{ mode: 'CLI', how: 'aws ce get-cost-and-usage, get-savings-plans-coverage (standard credential chain)' }],
    env: ['AWS_COST_ENABLED=true', 'AWS_PROFILE', 'AWS_ENV_TAG_KEY'],
    schemaFile: 'fixtures/raw/aws.json',
  },
  {
    id: 'azure', name: 'Azure', role: 'Cost by product tag',
    provides: ['Cost Management query: PreTaxCost, BillingMonth, ServiceName, TagValue'],
    feeds: ['Cost'],
    connect: [{ mode: 'REST', how: 'Microsoft.CostManagement/query api-version 2023-11-01' }],
    env: ['AZURE_TOKEN', 'AZURE_COST_SCOPE'],
    schemaFile: 'fixtures/raw/azure.json',
  },  {
    id: 'gcp', name: 'Google Cloud', role: 'Cost by product label (Cloud Billing export); GKE, logging and audit through MCP or Dynatrace',
    provides: ['billing export rows: service.description, sku.description, usage_start_time, project.id, labels[] (product, environment), cost, currency'],
    feeds: ['Cost: spend by product and service', 'Agent: GKE workload state and Cloud Audit Logs (via Dynatrace or the Google Cloud MCP servers)'],
    connect: [{ mode: 'REST', how: 'BigQuery jobs.query on the Cloud Billing export table' }, { mode: 'MCP', how: 'Google Cloud remote MCP servers: BigQuery, GKE, Cloud Logging, Cloud Monitoring, Cloud Trace; POST /api/ingest/gcp for snapshots' }],
    env: ['GCP_ACCESS_TOKEN', 'GCP_BILLING_PROJECT', 'GCP_BILLING_TABLE'],
    schemaFile: 'fixtures/raw/gcp.json',
  },

]

const cap = (v: unknown, max = 900) => {
  const s = JSON.stringify(v ?? null, null, 2)
  return s.length > max ? `${s.slice(0, max)}\n…` : s
}

/** One representative record per integration, in the tool's native shape. */
export function integrationSamples(raw: RawBundle): Record<IntegrationId, string> {
  const first = <T>(xs: T[] | undefined, pred?: (x: T) => boolean) => (xs ?? []).find(pred ?? (() => true))
  const dqlRec = (r?: { result?: { records?: Record<string, unknown>[] } }, pred?: (x: Record<string, unknown>) => boolean) => first(r?.result?.records, pred)
  const gh = raw.github
  const svc = raw.aws?.costExplorer?.[0]?.byService?.ResultsByTime?.[0]
  return {
    servicenow: cap({ businessApp: first(raw.servicenow?.businessApps), changeRequest: first(raw.servicenow?.changes) }),
    github: cap({ pull: first(gh?.pulls), failedJob: first(gh?.jobs, (j) => j.conclusion === 'failure') ?? first(gh?.jobs) }),
    dynatrace: cap({ problem: dqlRec(raw.dynatrace?.problems), deploymentEvent: dqlRec(raw.dynatrace?.sdlcEvents, (r) => r['event.status'] === 'finished') }),
    argocd: cap(first(raw.argocd?.applications)),
    kubernetes: cap(first(raw.kubernetes?.events)),
    aws: cap(svc ? { environment: raw.aws.costExplorer[0].environment, TimePeriod: svc.TimePeriod, Groups: svc.Groups.slice(0, 2) } : null),
    azure: cap(raw.azure?.costManagement ? { columns: raw.azure.costManagement.properties.columns, rows: raw.azure.costManagement.properties.rows.slice(0, 2) } : null),
    gcp: cap(raw.gcp?.billingExport?.slice(0, 2) ?? null),
  }
}
