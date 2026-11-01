// Phase 5: cost optimisation view for leadership.
// Spend comes from AWS Cost Explorer, Azure Cost Management and Dynatrace billing, joined to
// products through the CMDB cost tag. Savings are estimates from published pricing ratios,
// stated as such; tune PRICING to your negotiated rates.

import type { CodeFinding, CostInsight, CostSummary, Dataset } from './types'
import { REF } from './refs'
import { changeCausedProblems } from './failures'
import { minutesBetween, round, sum } from './util'

export const PRICING = {
  vcpuMonthUsd: 30, // blended on-demand per vCPU-month for general purpose EC2 in ap-south-1
  memGiBMonthUsd: 4,
  savingsPlanDiscount: 0.27, // typical 1-year no-upfront Compute Savings Plan
  targetCommitmentCoverage: 0.7,
  gravitonSaving: 0.15,
  gp3Saving: 0.2,
  nonProdScheduleSaving: 0.64, // run 12h on weekdays instead of 24x7
  natEndpointSaving: 0.4,
  logRetentionSaving: 0.2,
  cacheDbDownsizeSaving: 0.3,
  runnerMinuteUsd: 0.008, // GitHub-hosted Linux 2-core
  slowdownDowntimeWeight: 0.25, // a slowdown is partial impact, not full outage
}

const isCompute = (s: string) => /Compute Cloud - Compute|EKS compute/i.test(s)
const isDatabase = (s: string) => /Relational Database|RDS|Aurora/i.test(s)

/** Short labels for leadership views; raw AWS SERVICE names are long. */
export function shortService(s: string): string {
  const m: [RegExp, string][] = [
    [/Elastic Compute Cloud - Compute/, 'EC2 compute (EKS nodes)'], [/^EC2 - Other$/, 'EBS and EC2 other'], [/Relational Database/, 'RDS'],
    [/Virtual Private Cloud/, 'VPC / NAT'], [/Simple Storage Service/, 'S3'], [/ElastiCache/, 'ElastiCache'], [/Simple Queue Service/, 'SQS'],
  ]
  return m.find(([re]) => re.test(s))?.[1] ?? s
}

const usd = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`

export function costInsights(ds: Dataset, codeFindings: CodeFinding[] = []): CostInsight[] {
  const out: CostInsight[] = []
  const months = [...new Set(ds.costs.map((c) => c.month))].sort()
  const cur = months.at(-1)
  const prev = months.at(-2)
  const curRows = ds.costs.filter((c) => c.month === cur)
  let n = 0
  const push = (x: Omit<CostInsight, 'id'>) => out.push({ ...x, id: `ci-${++n}`, monthlySavingsUsd: Math.round(x.monthlySavingsUsd) })

  // rightsizing from Dynatrace p95 usage vs requests
  for (const w of ds.workloadUsage) {
    const cpuUtil = w.cpuUsedP95Cores / w.cpuRequestCores
    const memUtil = w.memUsedP95GiB / w.memRequestGiB
    if (cpuUtil < 0.4 && w.environment === 'prod') {
      const newCpu = Math.max(0.25, round(w.cpuUsedP95Cores * 1.3, 2))
      const save = (w.cpuRequestCores - newCpu) * w.replicas * PRICING.vcpuMonthUsd
      push({
        productId: w.productId, kind: 'rightsizing', title: `Rightsize ${w.workload} CPU requests`,
        detail: `p95 CPU ${w.cpuUsedP95Cores} of ${w.cpuRequestCores} cores requested (${Math.round(cpuUtil * 100)}%) across ${w.replicas} replicas. Set request to ${newCpu} cores (p95 + 30%).`,
        monthlySavingsUsd: save, effort: 'low', references: [REF.k8sResources, REF.awsCostPillar],
      })
    }
    if (memUtil > 0.9) {
      push({
        productId: w.productId, kind: 'rightsizing', title: `${w.workload} memory is under-provisioned`,
        detail: `p95 working set ${round(w.memUsedP95GiB, 2)} GiB of ${round(w.memRequestGiB, 2)} GiB (${Math.round(memUtil * 100)}%). This is a reliability risk (OOMKilled), not a saving: raise the limit.`,
        monthlySavingsUsd: 0, effort: 'low', references: [REF.k8sMemory],
      })
    }
  }

  for (const c of curRows) {
    // non-prod running 24x7
    if ((c.environment === 'dev' || c.environment === 'staging') && isCompute(c.service)) {
      push({
        productId: c.productId, kind: 'nonprod', title: `Schedule ${c.environment} compute off-hours`,
        detail: `${c.environment} compute costs ${usd(c.amount)}/month running 24x7. Scale node groups to zero nights and weekends.`,
        monthlySavingsUsd: c.amount * PRICING.nonProdScheduleSaving, effort: 'low', references: [REF.awsScheduler, REF.karpenter],
      })
    }
    // commitment coverage
    if (c.environment === 'prod' && c.provider === 'aws' && (isCompute(c.service) || isDatabase(c.service) || /ElastiCache/i.test(c.service)) && (c.commitmentCovered ?? 0) < PRICING.targetCommitmentCoverage - 0.1) {
      const gap = PRICING.targetCommitmentCoverage - (c.commitmentCovered ?? 0)
      push({
        productId: c.productId, kind: 'commitment', title: `Raise commitment coverage on ${shortService(c.service)}`,
        detail: `${Math.round((c.commitmentCovered ?? 0) * 100)}% covered by Savings Plans or RIs on steady prod spend of ${usd(c.amount)}/month. Target ${Math.round(PRICING.targetCommitmentCoverage * 100)}%.`,
        monthlySavingsUsd: c.amount * gap * PRICING.savingsPlanDiscount, effort: 'low', references: [REF.awsSavingsPlans],
      })
    }
    // x86 -> Graviton
    if (c.environment === 'prod' && /^(m5|c5|r5)\./.test(c.usageType ?? '') && isCompute(c.service)) {
      push({
        productId: c.productId, kind: 'architecture', title: 'Move prod node group to Graviton',
        detail: `${c.usageType} (x86) at ${usd(c.amount)}/month. Containerised workloads on multi-arch images can move to m7g/c7g node groups.`,
        monthlySavingsUsd: c.amount * PRICING.gravitonSaving, effort: 'medium', references: [REF.awsGraviton],
      })
    }
    if (c.usageType === 'gp2') {
      push({
        productId: c.productId, kind: 'idle', title: 'Migrate EBS gp2 volumes to gp3',
        detail: `${usd(c.amount)}/month on gp2. gp3 is cheaper per GiB with baseline IOPS included; migration is online.`,
        monthlySavingsUsd: c.amount * PRICING.gp3Saving, effort: 'low', references: [REF.awsEbsTypes],
      })
    }
    if (/NatGateway|NAT Gateway/i.test(`${c.service} ${c.usageType ?? ''}`) && c.amount > 1000) {
      push({
        productId: c.productId, kind: 'architecture', title: 'Route S3 traffic through a gateway VPC endpoint',
        detail: `NAT data processing at ${usd(c.amount)}/month. S3 and DynamoDB gateway endpoints are free and remove that traffic from NAT.`,
        monthlySavingsUsd: c.amount * PRICING.natEndpointSaving, effort: 'low', references: [REF.awsGatewayEndpoints],
      })
    }
    if (c.provider === 'dynatrace' && /log/i.test(c.service)) {
      const p = ds.costs.find((x) => x.productId === c.productId && x.service === c.service && x.month === months[0])
      const growth = p ? (c.amount / p.amount) ** (1 / Math.max(1, months.length - 1)) - 1 : 0
      if (growth > 0.04) {
        push({
          productId: c.productId, kind: 'observability', title: 'Tier log retention and drop noise in OpenPipeline',
          detail: `Log ingest and retention ${usd(c.amount)}/month, growing ${Math.round(growth * 100)}% per month. Route debug logs to a short-retention bucket and drop health-check noise at ingest.`,
          monthlySavingsUsd: c.amount * PRICING.logRetentionSaving, effort: 'medium', references: [REF.dtOpenPipeline],
        })
      }
    }
    // month-on-month anomaly per line
    const before = ds.costs.find((x) => x.month === prev && x.productId === c.productId && x.service === c.service && x.environment === c.environment && x.usageType === c.usageType)
    if (before && c.amount > before.amount * 1.25 && c.amount - before.amount > 500) {
      push({
        productId: c.productId, kind: 'anomaly', title: `${shortService(c.service)} up ${Math.round((c.amount / before.amount - 1) * 100)}% month on month`,
        detail: `${usd(before.amount)} to ${usd(c.amount)}. Investigate the driver before it becomes the baseline.`,
        monthlySavingsUsd: 0, effort: 'low', references: [REF.awsCostPillar],
      })
    }
  }

  // phase 4 -> phase 5 link: a cache recommendation lets the database shrink
  for (const f of codeFindings.filter((x) => x.ruleId === 'ARCH-CACHE-ASIDE')) {
    const db = curRows.filter((c) => c.productId === f.productId && isDatabase(c.service) && c.environment === 'prod')
    const amount = sum(db.map((d) => d.amount))
    if (amount > 0) {
      push({
        productId: f.productId, kind: 'architecture', title: 'Downsize database after adding cache-aside',
        detail: `Database spend ${usd(amount)}/month serving repeated reads. Once Redis absorbs them, the instance can drop one size class. Depends on the cache-aside code finding.`,
        monthlySavingsUsd: amount * PRICING.cacheDbDownsizeSaving, effort: 'high', references: [REF.cacheAside, REF.redisCaching],
      })
    }
  }
  return out.sort((a, b) => b.monthlySavingsUsd - a.monthlySavingsUsd)
}

export function costSummary(ds: Dataset, productId: string | 'all' = 'all', codeFindings: CodeFinding[] = []): CostSummary {
  const inScope = (pid: string) => productId === 'all' || pid === productId
  const rows = ds.costs.filter((c) => inScope(c.productId))
  const months = [...new Set(ds.costs.map((c) => c.month))].sort()
  const monthlyTotals = months.map((m) => Math.round(sum(rows.filter((r) => r.month === m).map((r) => r.amount))))
  const cur = months.at(-1)!
  const byServiceMap = new Map<string, number>()
  for (const r of rows.filter((x) => x.month === cur)) {
    const k = `${shortService(r.service)}${r.environment && r.environment !== 'prod' && r.environment !== 'shared' ? ` (${r.environment})` : ''}`
    byServiceMap.set(k, (byServiceMap.get(k) ?? 0) + r.amount)
  }
  const currentMonth = monthlyTotals.at(-1) ?? 0
  const prevMonth = monthlyTotals.at(-2) ?? currentMonth
  const requests = sum(ds.serviceMetrics.filter((m) => inScope(m.productId)).map((m) => m.requests * (30 / m.windowDays)))

  // cost of change failures: weighted downtime x tier rate + wasted CI minutes
  const tierRate = new Map(ds.products.map((p) => [p.id, p.downtimeCostPerMin ?? 0]))
  const downtime = sum(changeCausedProblems(ds).filter((p) => inScope(p.productId) && p.endedAt).map((p) =>
    minutesBetween(p.startedAt, p.endedAt!) * (p.category === 'slowdown' ? PRICING.slowdownDowntimeWeight : 1) * (tierRate.get(p.productId) ?? 0)))
  const productOfRepo = new Map(ds.products.flatMap((p) => p.repos.map((r) => [r, p.id] as const)))
  const wastedCi = sum(ds.pipelineRuns.filter((r) => r.status === 'failed' && r.system === 'github-actions' && inScope(productOfRepo.get(r.repo) ?? '') && r.finishedAt)
    .map((r) => minutesBetween(r.startedAt, r.finishedAt!) * PRICING.runnerMinuteUsd))

  const insights = costInsights(ds, codeFindings).filter((i) => inScope(i.productId))
  return {
    productId, months, monthlyTotals,
    byService: [...byServiceMap.entries()].map(([service, amount]) => ({ service, amount: Math.round(amount) })).sort((a, b) => b.amount - a.amount),
    currentMonth,
    momChangePct: prevMonth ? round(((currentMonth - prevMonth) / prevMonth) * 100, 1) : 0,
    costPer1kRequests: requests ? round(currentMonth / (requests / 1000), 4) : undefined,
    failureCostUsd: Math.round(downtime + wastedCi),
    savingsPotentialUsd: Math.round(sum(insights.map((i) => i.monthlySavingsUsd))),
    insights,
  }
}
