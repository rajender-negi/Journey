export * from './types'
export * from './util'
export * from './refs'
export * from './sources'
export * from './fixtures'
export * from './journey'
export * from './dora'
export * from './failures'
export * from './risk'
export * from './codebase'
export * from './cost'
export * from './scorecard'
export * from './ai'
export * from './patterns'
export * from './integrations'
export * from './signals'

import type { CodeFinding, CostSummary, Dataset, DeploymentRisk, DoraMetrics, FailureFinding, Journey, Scorecard } from './types'
import { buildJourneys } from './journey'
import { computeDora } from './dora'
import { detectFailures } from './failures'
import { scoreDeploymentRisk } from './risk'
import { analyzeCodebases } from './codebase'
import { costSummary } from './cost'
import { scorecard } from './scorecard'
import { buildFixtureDataset } from './fixtures'
import { emitRawBundle, mapRawBundle } from './sources'
import { advise, type ProductAdvice } from './patterns'

export interface Analysis {
  dataset: Dataset
  journeys: Journey[]
  dora: Record<string, DoraMetrics> // key 'all' + product ids
  failures: FailureFinding[]
  risks: DeploymentRisk[]
  code: CodeFinding[]
  cost: Record<string, CostSummary>
  scorecards: Record<string, Scorecard>
  advice: Record<string, ProductAdvice>
}

/** Keeps only records a CMDB product owns: with no product identity there is nothing to join (the map goes dead). */
export function scopeToProducts(ds: Dataset): Dataset {
  const ids = new Set(ds.products.map((p) => p.id))
  const repos = new Set(ds.products.flatMap((p) => p.repos))
  // records carry a productId, or (merges, pipeline runs) only a repo that a product lists
  const own = <T>(xs: T[]) => xs.filter((x) => { const r = x as { productId?: string; repo?: string }; return r.productId !== undefined ? ids.has(r.productId) : r.repo !== undefined ? repos.has(r.repo) : true })
  return {
    ...ds, merges: own(ds.merges), pipelineRuns: own(ds.pipelineRuns), deployments: own(ds.deployments), changeRequests: own(ds.changeRequests),
    problems: own(ds.problems), runtimeEvents: own(ds.runtimeEvents), serviceMetrics: own(ds.serviceMetrics), workloadUsage: own(ds.workloadUsage),
    costs: own(ds.costs), repos: own(ds.repos), doraFromDynatrace: own(ds.doraFromDynatrace),
  }
}

/** Runs all six phases over a normalized dataset. Pure and deterministic. */
export function analyze(input: Dataset): Analysis {
  const ds = scopeToProducts(input)
  const journeys = buildJourneys(ds)
  const failures = detectFailures(ds)
  const code = analyzeCodebases(ds)
  const risks = scoreDeploymentRisk(ds, journeys, code)
  const ids = ds.products.map((p) => p.id)
  const dora: Record<string, DoraMetrics> = { all: computeDora(ds, 'all') }
  const cost: Record<string, CostSummary> = { all: costSummary(ds, 'all', code) }
  const scorecards: Record<string, Scorecard> = {}
  for (const id of ids) {
    dora[id] = computeDora(ds, id)
    cost[id] = costSummary(ds, id, code)
    scorecards[id] = scorecard(id, code, failures)
  }
  const partial = { dataset: ds, journeys, dora, failures, risks, code, cost, scorecards, advice: {} as Record<string, ProductAdvice> }
  partial.advice = advise(partial)
  return partial
}

/** Dummy mode: seeded scenarios -> native source payloads -> the same mappers live data uses. */
export function demoDataset(now = Date.now(), seed = 42): Dataset {
  return mapRawBundle(emitRawBundle(buildFixtureDataset(now, seed)))
}
export * from './viewmodel'
