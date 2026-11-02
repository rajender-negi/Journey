// Argo CD, Kubernetes, AWS Cost Explorer and Azure Cost Management.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { ArgoApp, AzureCostQuery, CeResponse, GcpBillingRow, K8sEvent, RawBundle } from '@pj/core'
import { FIELD_MAP } from '@pj/core'
import { config } from '../config'
import { getJson } from './http'

const run = promisify(execFile)

export async function fetchArgo(): Promise<RawBundle['argocd']> {
  const res = await getJson<{ items: ArgoApp[] }>(`${config.argocd.url!.replace(/\/$/, '')}/api/v1/applications`, { Authorization: `Bearer ${config.argocd.token}` })
  return { applications: res.items ?? [] }
}

export async function fetchK8s(namespaces: string[]): Promise<RawBundle['kubernetes']> {
  const H = { Authorization: `Bearer ${config.kubernetes.token}` }
  const all = await getJson<{ items: K8sEvent[] }>(`${config.kubernetes.api!.replace(/\/$/, '')}/api/v1/events?fieldSelector=type%3DWarning&limit=2000`, H)
  const ok = (ns: string) => namespaces.some((n) => ns === n || ns.startsWith(`${n}-`))
  return { events: all.items.filter((e) => ok(e.metadata.namespace)) }
}

function monthsBack(n: number) {
  const d = new Date()
  const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - (n - 1), 1)).toISOString().slice(0, 10)
  const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString().slice(0, 10)
  return { start, end }
}

// Uses the AWS CLI so standard credential chains (SSO, IRSA, profiles) work without bundling an SDK.
async function ce(args: string[]): Promise<CeResponse> {
  const { stdout } = await run('aws', ['ce', ...args, '--output', 'json', ...(config.aws.profile ? ['--profile', config.aws.profile] : [])], { maxBuffer: 64 * 1024 * 1024 })
  return JSON.parse(stdout) as CeResponse
}

export async function fetchAws(): Promise<RawBundle['aws']> {
  const { start, end } = monthsBack(6)
  const envs = ['prod', 'staging', 'dev']
  const base = ['get-cost-and-usage', '--time-period', `Start=${start},End=${end}`, '--granularity', 'MONTHLY', '--metrics', 'UnblendedCost']
  const costExplorer = await Promise.all(envs.map(async (environment) => {
    const filter = JSON.stringify({ Tags: { Key: config.aws.envTagKey, Values: [environment] } })
    const [byService, byUsageType] = await Promise.all([
      ce([...base, '--group-by', 'Type=DIMENSION,Key=SERVICE', `Type=TAG,Key=${FIELD_MAP.awsCostTagKey}`, '--filter', filter]),
      ce([...base, '--group-by', 'Type=DIMENSION,Key=USAGE_TYPE', `Type=TAG,Key=${FIELD_MAP.awsCostTagKey}`, '--filter', filter]),
    ])
    return { environment, byService, byUsageType }
  }))
  // Savings Plans coverage is reported per service, not per tag: applied to every product using that service.
  const { start: cs } = monthsBack(1)
  const { stdout } = await run('aws', ['ce', 'get-savings-plans-coverage', '--time-period', `Start=${cs},End=${end}`, '--group-by', 'Type=DIMENSION,Key=SERVICE', '--output', 'json'])
  const cov = JSON.parse(stdout) as { SavingsPlansCoverages: { Attributes: Record<string, string>; Coverage: { CoveragePercentage: string } }[] }
  const bySvc = new Map(cov.SavingsPlansCoverages.map((c) => [c.Attributes.SERVICE ?? c.Attributes.service, Number(c.Coverage.CoveragePercentage) / 100]))
  const commitmentCoverage: Record<string, number> = {}
  for (const e of costExplorer) {
    for (const t of e.byService.ResultsByTime) {
      for (const g of t.Groups) commitmentCoverage[`*|${g.Keys[0]}|${e.environment}`] = bySvc.get(g.Keys[0]) ?? 0
    }
  }
  return { costExplorer, commitmentCoverage }
}

export async function fetchAzure(): Promise<RawBundle['azure']> {
  const { start, end } = monthsBack(6)
  const url = `https://management.azure.com/${config.azure.scope!.replace(/^\//, '')}/providers/Microsoft.CostManagement/query?api-version=2023-11-01`
  const body = {
    type: 'ActualCost', timeframe: 'Custom', timePeriod: { from: `${start}T00:00:00Z`, to: `${end}T00:00:00Z` },
    dataset: {
      granularity: 'Monthly',
      aggregation: { totalCost: { name: 'PreTaxCost', function: 'Sum' } },
      grouping: [{ type: 'Dimension', name: 'ServiceName' }, { type: 'TagKey', name: FIELD_MAP.awsCostTagKey }],
    },
  }
  const costManagement = await getJson<AzureCostQuery>(url, { Authorization: `Bearer ${config.azure.token}`, 'Content-Type': 'application/json' }, { method: 'POST', body: JSON.stringify(body) })
  return { costManagement }
}

/**
 * Google Cloud cost from the Cloud Billing export to BigQuery (the documented way to get cost by label).
 * Token: an OAuth access token with bigquery.jobs.create on the project and read on the export dataset
 * (for example from a service account via workload identity, or `gcloud auth print-access-token`).
 */
export async function fetchGcp(): Promise<NonNullable<RawBundle['gcp']>> {
  const { start } = monthsBack(6)
  const table = config.gcp.table!.replace(/[^\w.-]/g, '')
  const query = `SELECT service, sku, FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%SZ', usage_start_time) AS usage_start_time, FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%SZ', usage_end_time) AS usage_end_time, project, labels, cost, currency
FROM \`${table}\` WHERE usage_start_time >= TIMESTAMP('${start}') AND EXISTS (SELECT 1 FROM UNNEST(labels) l WHERE l.key = '${FIELD_MAP.awsCostTagKey}')`
  const res = await getJson<{ schema: { fields: { name: string }[] }; rows?: { f: { v: unknown }[] }[] }>(
    `https://bigquery.googleapis.com/bigquery/v2/projects/${encodeURIComponent(config.gcp.project!)}/queries`,
    { Authorization: `Bearer ${config.gcp.token}`, 'Content-Type': 'application/json' },
    { method: 'POST', body: JSON.stringify({ query, useLegacySql: false, timeoutMs: 30000, maxResults: 50000 }) },
  )
  // BigQuery REST returns rows as {f:[{v}]}, records as nested {f:[{v}]}, repeated as [{v}]
  const names = res.schema.fields.map((f) => f.name)
  const v = (x: unknown): unknown => (x && typeof x === 'object' && 'v' in (x as object) ? v((x as { v: unknown }).v) : x)
  const rec = (x: unknown) => (x as { f: { v: unknown }[] }).f.map((c) => v(c.v))
  const billingExport: GcpBillingRow[] = (res.rows ?? []).map((r) => {
    const o = Object.fromEntries(r.f.map((c, i) => [names[i], c.v]))
    const [sid, sdesc] = rec(o.service) as string[]
    const [kid, kdesc] = rec(o.sku) as string[]
    const [pid] = rec(o.project) as string[]
    const labels = ((o.labels as { v: unknown }[]) ?? []).map((l) => { const [key, value] = rec(v(l)) as string[]; return { key, value } })
    return { service: { id: sid, description: sdesc }, sku: { id: kid, description: kdesc }, usage_start_time: String(o.usage_start_time), usage_end_time: String(o.usage_end_time), project: { id: pid }, labels, cost: Number(o.cost), currency: String(o.currency) }
  })
  return { billingExport }
}
