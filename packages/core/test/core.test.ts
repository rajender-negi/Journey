import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  analyzeRepo, analyze, buildFixtureDataset, classify, deterministicBrief, emitRawBundle, mapRawBundle, validateAiOutput, buildEvidencePack,
} from '../src/index'

const NOW = Date.parse('2026-11-01T03:30:00Z')
const truth = buildFixtureDataset(NOW, 42)
const raw = emitRawBundle(truth)
const ds = mapRawBundle(raw)
const a = analyze(ds)

describe('source schemas round trip', () => {
  it('raw payloads use native source shapes', () => {
    assert.equal(raw.dynatrace.problems.state, 'SUCCEEDED')
    assert.ok('event.status' in raw.dynatrace.problems.result.records[0])
    assert.match(raw.servicenow.changes[0].opened_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
    assert.match(raw.github.jobs[0].run_url, /^https:\/\/api\.github\.com\/repos\//)
    assert.equal(raw.aws.costExplorer[0].byService.ResultsByTime[0].Groups[0].Metrics.UnblendedCost.Unit, 'USD')
    assert.equal(raw.github.contents['acme/catalog-api'][0].encoding, 'base64')
  })
  it('mappers recover the normalized dataset', () => {
    assert.deepEqual(ds.products.map((p) => p.id), truth.products.map((p) => p.id))
    assert.deepEqual(ds.products[0].repos, truth.products[0].repos)
    assert.equal(ds.merges.length, truth.merges.length)
    assert.equal(ds.deployments.length, truth.deployments.length)
    assert.equal(ds.changeRequests.length, truth.changeRequests.length)
    assert.equal(ds.problems.length, truth.problems.length)
    assert.equal(ds.problems.every((p) => p.productId), true)
    assert.equal(ds.costs.length, truth.costs.length)
    assert.equal(ds.repos[2].files[0].content, truth.repos[2].files[0].content)
    const sum = (xs: { amount: number }[]) => Math.round(xs.reduce((s, x) => s + x.amount, 0))
    assert.equal(sum(ds.costs), sum(truth.costs))
    assert.ok(Math.abs(ds.workloadUsage[0].cpuRequestCores - truth.workloadUsage[0].cpuRequestCores) < 0.01)
    assert.ok(Math.abs(ds.serviceMetrics[3].p95Ms - truth.serviceMetrics[3].p95Ms) < 0.01)
  })
})

describe('phase 2: journeys and DORA', () => {
  it('builds a journey per merge with all eight stages', () => {
    assert.equal(a.journeys.length, ds.merges.length)
    assert.equal(a.journeys.every((j) => j.stages.length === 8), true)
  })
  it('covers every outcome', () => {
    const outcomes = new Set(a.journeys.map((j) => j.outcome))
    for (const o of ['delivered', 'failed', 'delivered-with-incident', 'in-flight']) assert.equal(outcomes.has(o as never), true)
  })
  it('computes DORA with bands', () => {
    const d = a.dora.all
    assert.ok(d.deploymentFrequencyPerDay > 0)
    assert.ok(d.changeFailureRate > 0)
    assert.ok(d.changeFailureRate < 1)
    assert.ok(['elite', 'high', 'medium', 'low'].includes(d.bands.leadTime))
  })
  it('prefers Dynatrace DORA and flags drift', () => {
    assert.ok(['dynatrace', 'reconciled'].includes(a.dora.BA0001.source))
    assert.equal(a.dora.BA0005.source, 'computed')
  })
})

describe('phase 3: failures, recommendations, risk', () => {
  it('classifies known signatures', () => {
    assert.equal(classify('Pod status ImagePullBackOff', 'deployment').ruleId, 'FX-IMAGE-PULL')
    assert.equal(classify('Reason: OOMKilled (exit code 137)', 'deployment').ruleId, 'FX-OOM')
    assert.equal(classify('PreSync hook job/db-migrate failed: relation "x" already exists', 'deployment').ruleId, 'FX-DB-MIGRATION')
    assert.equal(classify('Error: missing required environment variable DATABASE_URL. CrashLoopBackOff', 'deployment').ruleId, 'FX-CONFIG-MISSING')
  })
  it('every failure carries a recommendation with official references', () => {
    assert.ok(a.failures.length > 10)
    for (const f of a.failures) {
      assert.ok(f.recommendation.fixNow.length > 0)
      assert.equal(f.recommendation.references.every((r) => r.url.startsWith('https://')), true)
    }
    assert.equal(a.failures.filter((f) => f.recommendation.ruleId === 'FX-UNCLASSIFIED').length, 0)
  })
  it('links Dynatrace regressions to the deployment that caused them', () => {
    const reg = a.failures.filter((f) => f.recommendation.ruleId.startsWith('FX-REGRESSION'))
    assert.ok(reg.length > 0)
    assert.equal(reg.every((f) => f.linkedDeploymentId), true)
  })
  it('scores in-flight changes', () => {
    for (const r of a.risks) assert.ok(r.score >= 0)
  })
})

describe('phase 4: codebase analysis', () => {
  it('recommends Redis cache-aside only where runtime proves it', () => {
    const cache = a.code.filter((c) => c.ruleId === 'ARCH-CACHE-ASIDE').map((c) => c.productId).sort()
    assert.ok(cache.includes('BA0003'))
    assert.ok(!cache.includes('BA0002')) // payments already has go-redis
    assert.ok(!cache.includes('BA0005')) // write-heavy
  })
  it('detects security issues', () => {
    const ids = new Set(a.code.map((c) => c.ruleId))
    for (const id of ['CODE-SQL-CONCAT', 'CODE-HARDCODED-SECRET', 'CODE-JWT-ALG-NONE', 'DOCKER-ROOT', 'GHA-UNPINNED-ACTION', 'TF-S3-PUBLIC-ACCESS', 'CODE-N-PLUS-ONE']) assert.equal(ids.has(id), true)
    const secret = a.code.find((c) => c.ruleId === 'CODE-HARDCODED-SECRET')!
    assert.ok(!secret.evidence.includes('dummy-not-a-real-secret'))
    // AWS key ids are detected and masked; built at runtime so the repo holds no key-shaped literal
    const key = 'AK' + 'IA' + 'IOSFODNN7' + 'EXAMPLE'
    const hit = analyzeRepo({ repo: 'acme/x', productId: 'BA0004', ref: 'main', files: [{ path: 'app/k.py', content: `KEY = "${key}"` }] }).find((c) => c.ruleId === 'CODE-HARDCODED-SECRET')!
    assert.ok(hit && !hit.evidence.includes(key.slice(8)))
  })
  it('payments (the well-built repo) scores best', () => {
    const best = Object.values(a.scorecards).sort((x, y) => y.overall - x.overall)[0]
    assert.equal(best.productId, 'BA0002')
  })
})

describe('phase 5: cost', () => {
  it('produces savings and failure cost', () => {
    assert.ok(a.cost.all.savingsPotentialUsd > 0)
    assert.ok(a.cost.all.failureCostUsd > 0)
    assert.equal(a.cost.BA0003.insights.some((i) => i.kind === 'anomaly'), true)
    assert.equal(a.cost.BA0003.insights.some((i) => i.title.startsWith('Downsize database')), true)
  })
})

describe('AI layer contract', () => {
  it('deterministic brief cites only known rules and passes validation', () => {
    for (const [mode, target] of [['product', 'BA0001'], ['portfolio', 'all'], ['finding', a.failures[0].id]] as const) {
      const pack = buildEvidencePack(a, mode, target)
      const out = deterministicBrief(a, mode, target)
      assert.doesNotThrow(() => validateAiOutput(JSON.stringify(out), pack))
    }
  })
  it('rejects model output citing invented rules', () => {
    const pack = buildEvidencePack(a, 'product', 'BA0003')
    const bad = JSON.stringify({ headline: 'x', rootCause: 'y', impact: 'z', evidenceUsed: [], actions: [{ priority: 1, action: 'a', ruleId: 'FX-MADE-UP', horizon: 'now', owner: 'o' }] })
    assert.throws(() => validateAiOutput(bad, pack))
  })
})

describe('design advisor', () => {
  it('returns one best pattern per product with an auditable formula and official references', () => {
    for (const p of ds.products) {
      const b = a.advice[p.id].best!
      assert.ok(b && b.priority > 0 && b.pattern.references.every((r) => r.url.startsWith('https://')))
      assert.ok(b.formula.severity > 0 && b.formula.evidence >= 1 && b.formula.reach >= 1)
    }
  })
  it('puts an open critical security exposure first', () => {
    assert.equal(a.advice.BA0004.best!.pattern.id, 'secure-coding')
    assert.equal(a.advice.BA0004.best!.securityGate, true)
  })
  it('credits the root fix for DB-driven latency regressions', () => {
    assert.equal(a.advice.BA0003.best!.pattern.id, 'batch-reads')
    assert.equal(a.advice.BA0003.best!.evidenceLevel, 'caused-failures')
  })
})


describe('switching sources off (the connection map goes dead)', () => {
  it('any source can be off; with ServiceNow off nothing is joined to a product', async () => {
    const { SOURCE_KEYS, withSourcesOff, buildViewModel } = await import('../src/index')
    const raw = emitRawBundle(buildFixtureDataset(Date.parse('2026-11-01T03:30:00Z')))
    for (const s of SOURCE_KEYS) {
      const a = analyze(mapRawBundle(withSourcesOff(raw, [s])))
      assert.doesNotThrow(() => JSON.stringify(buildViewModel(a, { mode: 'demo', raw: withSourcesOff(raw, [s]) })), s)
    }
    const noCmdb = analyze(mapRawBundle(withSourcesOff(raw, ['servicenow'])))
    assert.equal(noCmdb.dataset.products.length, 0)
    assert.equal(noCmdb.journeys.length, 0)
    assert.equal(noCmdb.failures.length, 0)
    const noGithub = analyze(mapRawBundle(withSourcesOff(raw, ['github'])))
    assert.equal(noGithub.journeys.length, 0, 'no merges, no journeys')
    assert.ok(noGithub.cost.all.currentMonth > 0, 'cost still works')
    const noCloud = analyze(mapRawBundle(withSourcesOff(raw, ['aws', 'azure', 'gcp'])))
    assert.ok(noCloud.journeys.length > 0 && noCloud.dataset.costs.every((c) => c.provider === 'dynatrace'))
  })
})
