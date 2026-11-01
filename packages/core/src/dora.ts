// Phase 2: DORA metrics. Dynatrace is the source of truth when it reports a value;
// the computed value is kept as a cross-check and differences above 25% are flagged as drift.

import type { Dataset, DoraBand, DoraMetrics } from './types'
import { changeCausedProblems } from './failures'
import { hoursBetween, median, round, weekKey } from './util'

// Thresholds from the DORA State of DevOps performance clusters. Override per org if needed.
export const DORA_THRESHOLDS = {
  deploymentFrequencyPerDay: { elite: 1, high: 1 / 7, medium: 1 / 30 }, // higher is better
  leadTimeHours: { elite: 24, high: 24 * 7, medium: 24 * 30 }, // lower is better
  changeFailureRate: { elite: 0.05, high: 0.1, medium: 0.15 },
  mttrHours: { elite: 1, high: 24, medium: 24 * 7 },
}

const higher = (v: number, t: { elite: number; high: number; medium: number }): DoraBand => (v >= t.elite ? 'elite' : v >= t.high ? 'high' : v >= t.medium ? 'medium' : 'low')
const lower = (v: number, t: { elite: number; high: number; medium: number }): DoraBand => (v <= t.elite ? 'elite' : v <= t.high ? 'high' : v <= t.medium ? 'medium' : 'low')

export function computeDora(ds: Dataset, productId: string | 'all' = 'all'): DoraMetrics {
  const inScope = (pid: string) => productId === 'all' || pid === productId
  const mergeShas = new Set(ds.merges.map((m) => `${m.repo}|${m.sha}`))
  const prod = ds.deployments.filter((d) => d.environment === 'prod' && inScope(d.productId))
  // remediation redeploys (rollbacks, hotfix of an old build) have no merge of their own
  const changeDeploys = prod.filter((d) => mergeShas.has(`${d.repo}|${d.sha}`))
  const succeeded = changeDeploys.filter((d) => d.status === 'succeeded')
  const caused = changeCausedProblems(ds).filter((p) => inScope(p.productId))
  const causedDeployIds = new Set<string>()
  const prodById = new Map(prod.map((d) => [d.id, d]))
  for (const p of caused) {
    const d = ds.deployments.find((x) => x.environment === 'prod' && x.productId === p.productId && x.finishedAt <= p.startedAt && hoursBetween(x.finishedAt, p.startedAt) <= 1)
    if (d && prodById.has(d.id)) causedDeployIds.add(d.id)
  }
  const failedChanges = changeDeploys.filter((d) => d.status !== 'succeeded' || causedDeployIds.has(d.id))

  const leadTimes = ds.merges.flatMap((m) => {
    const d = succeeded.find((x) => x.sha === m.sha && x.repo === m.repo)
    return d ? [hoursBetween(m.firstCommitAt, d.finishedAt)] : []
  })
  const restore = caused.filter((p) => p.endedAt).map((p) => hoursBetween(p.startedAt, p.endedAt!))

  const computed = {
    deploymentFrequencyPerDay: succeeded.length / ds.windowDays,
    leadTimeHours: median(leadTimes),
    changeFailureRate: changeDeploys.length ? failedChanges.length / changeDeploys.length : 0,
    mttrHours: median(restore),
  }

  let source: DoraMetrics['source'] = 'computed'
  const drift: string[] = []
  const final = { ...computed }
  const dt = productId === 'all' ? undefined : ds.doraFromDynatrace.find((d) => d.productId === productId)
  if (dt) {
    source = 'reconciled'
    for (const k of Object.keys(computed) as (keyof typeof computed)[]) {
      const v = dt[k]
      if (v == null) continue
      const c = computed[k]
      const base = Math.max(Math.abs(v), 1e-9)
      if (Math.abs(c - v) / base > 0.25) drift.push(`${k}: Dynatrace ${round(v, 2)} vs computed ${round(c, 2)}`)
      final[k] = v
    }
    if (!drift.length) source = 'dynatrace'
  }

  const weeks = new Map<string, { deployments: number; failures: number }>()
  for (const d of changeDeploys) {
    const w = weekKey(d.finishedAt)
    const e = weeks.get(w) ?? { deployments: 0, failures: 0 }
    e.deployments++
    if (failedChanges.includes(d)) e.failures++
    weeks.set(w, e)
  }

  const T = DORA_THRESHOLDS
  return {
    productId,
    deploymentFrequencyPerDay: round(final.deploymentFrequencyPerDay, 2),
    leadTimeHours: round(final.leadTimeHours, 1),
    changeFailureRate: round(final.changeFailureRate, 3),
    mttrHours: round(final.mttrHours, 2),
    bands: {
      deploymentFrequency: higher(final.deploymentFrequencyPerDay, T.deploymentFrequencyPerDay),
      leadTime: lower(final.leadTimeHours, T.leadTimeHours),
      changeFailureRate: lower(final.changeFailureRate, T.changeFailureRate),
      mttr: final.mttrHours === 0 ? 'elite' : lower(final.mttrHours, T.mttrHours),
    },
    source,
    drift: drift.length ? drift : undefined,
    weekly: [...weeks.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([week, v]) => ({ week, ...v })),
  }
}
