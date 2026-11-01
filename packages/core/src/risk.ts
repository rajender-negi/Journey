// Phase 3 (prevention): pre-deployment risk score for changes not yet in production.
// Transparent additive model: every point traces to a named factor so the gate is explainable.

import type { CodeFinding, Dataset, DeploymentRisk, Journey, RiskFactor } from './types'
import { computeDora } from './dora'
import { DAY, ts } from './util'

export function scoreDeploymentRisk(ds: Dataset, journeys: Journey[], codeFindings: CodeFinding[] = []): DeploymentRisk[] {
  const now = ts(ds.generatedAt)
  const pending = journeys.filter((j) => j.outcome === 'in-flight')
  const doraCache = new Map<string, ReturnType<typeof computeDora>>()
  const dora = (pid: string) => doraCache.get(pid) ?? doraCache.set(pid, computeDora(ds, pid)).get(pid)!

  return pending.map((j) => {
    const f: RiskFactor[] = []
    const add = (factor: string, weight: number, detail: string) => f.push({ factor, weight, detail })
    const m = ds.merges.find((x) => x.sha === j.sha && x.repo === j.repo)!
    const product = ds.products.find((p) => p.id === j.productId)!
    const size = m.additions + m.deletions
    if (size > 800) add('Large change', 25, `${size} lines changed`)
    else if (size > 400) add('Medium-large change', 12, `${size} lines changed`)
    if (m.filesChanged > 20) add('Wide change', 8, `${m.filesChanged} files touched`)
    if (/migrat|schema/i.test(m.title)) add('Schema change', 15, 'Title indicates a database migration')
    if (product.tier === 1) add('Tier 1 product', 10, 'Business critical per CMDB')

    const d = dora(j.productId)
    if (d.changeFailureRate > 0.15) add('High recent change failure rate', 15, `${Math.round(d.changeFailureRate * 100)}% over ${ds.windowDays} days`)
    if (ds.problems.some((p) => p.productId === j.productId && p.status === 'open')) add('Open problem on product', 20, 'Deploying into an active Dynatrace problem')

    const flaky = ds.pipelineRuns.filter((r) => r.repo === j.repo && r.stage === 'test' && r.status === 'failed' && now - ts(r.startedAt) < 7 * DAY).length
    if (flaky >= 2) add('Unstable test suite', 8, `${flaky} test failures on this repo in 7 days`)

    const cr = ds.changeRequests.find((c) => c.sha === j.sha)
    if (cr?.risk === 'high') add('Change marked high risk', 10, cr.number)
    if (cr) {
      const day = new Date(ts(cr.plannedStart) + 5.5 * 3_600_000).getUTCDay() // IST
      if (day === 5 || day === 6 || day === 0) add('Weekend window', 6, 'Planned start Friday to Sunday IST')
    }

    const deployGaps = codeFindings.filter((c) => c.productId === j.productId && ['K8S-NO-PROBES', 'K8S-NO-LIMITS', 'K8S-SINGLE-REPLICA'].includes(c.ruleId))
    if (deployGaps.length) add('Unsafe rollout config', 10, deployGaps.map((g) => g.title).join('; '))

    const score = Math.min(100, f.reduce((a, x) => a + x.weight, 0))
    const level = score >= 60 ? 'high' : score >= 35 ? 'medium' : 'low'
    return {
      productId: j.productId, sha: j.sha, score, level, factors: f.sort((a, b) => b.weight - a.weight),
      gate: level === 'high' ? 'hold' : level === 'medium' ? 'proceed-with-canary' : 'proceed',
    }
  })
}
