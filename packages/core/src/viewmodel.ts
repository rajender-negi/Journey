// The single data format every client renders: phone, tablet, laptop, published page.
// Compact on purpose (short keys, tuples, truncated evidence) so it stays small on mobile networks.
// The server serves it gzipped at /api/vm; the published page embeds the same object.

import type { Analysis } from './index'
import { STAGE_LABEL, stageFunnel } from './journey'
import { PILLARS } from './scorecard'
import { AI_SYSTEM_PROMPT } from './ai'
import { SELF_PATTERNS, type Advice } from './patterns'
import { INTEGRATIONS, integrationSamples } from './integrations'
import type { RawBundle } from './sources'

export interface IntegrationStatus { source: string; tier: string; ok: boolean; records: number; error?: string }

export const VIEW_MODEL_VERSION = 1

export function buildViewModel(a: Analysis, opts: { mode: 'live' | 'demo'; maxJourneys?: number; evidenceChars?: number; raw?: RawBundle; status?: IntegrationStatus[] } = { mode: 'live' }) {
  const evLen = opts.evidenceChars ?? 400
  const ds = a.dataset
  const r1 = (n: number) => Math.round(n * 10) / 10
  // references are shared across many findings: store each once, point at it by index
  const refTable: string[][] = []
  const refIdx = new Map<string, number>()
  const refs = (rs: { title: string; url: string }[]) => rs.map((x) => {
    if (!refIdx.has(x.url)) { refIdx.set(x.url, refTable.length); refTable.push([x.title, x.url]) }
    return refIdx.get(x.url)!
  })

  const scope = (pid: string) => {
    const inP = <T extends { productId: string }>(xs: T[]) => (pid === 'all' ? xs : xs.filter((x) => x.productId === pid))
    const d = a.dora[pid]
    const c = a.cost[pid]
    return {
      dora: { df: d.deploymentFrequencyPerDay, lt: d.leadTimeHours, cfr: d.changeFailureRate, mttr: d.mttrHours, b: d.bands, src: d.source, drift: d.drift ?? [], weekly: d.weekly.map((w) => [w.week.slice(5), w.deployments, w.failures]) },
      funnel: stageFunnel(inP(a.journeys)).map((f) => [STAGE_LABEL[f.name], f.passed, f.failed, f.running, f.medianMin ?? null]),
      open: inP(ds.problems).filter((p) => p.status === 'open').map((p) => [p.displayId, p.title, p.rootCauseText ?? '', p.startedAt, p.productId]),
      cost: {
        cur: c.currentMonth, mom: c.momChangePct, save: c.savingsPotentialUsd, fail: c.failureCostUsd, per1k: c.costPer1kRequests ?? null,
        months: c.months, totals: c.monthlyTotals, svc: c.byService.slice(0, 8).map((s) => [s.service, s.amount]),
        ins: c.insights.map((i) => [i.kind, i.title, i.detail, i.monthlySavingsUsd, i.effort, i.productId, refs(i.references)]),
      },
    }
  }

  // recommendations are shared per rule id; findings point at them
  const rules: Record<string, { t: string; s: string; p: string; sum: string; now: string[]; prev: string[]; refs: number[] }> = {}
  for (const f of a.failures) {
    const r = f.recommendation
    rules[r.ruleId] ??= { t: r.title, s: r.severity, p: r.pillar, sum: r.summary, now: r.fixNow, prev: r.prevent, refs: refs(r.references) }
  }
  const depSha = new Map(ds.deployments.map((d) => [d.id, d.sha]))
  const failedRunSha = new Map(ds.pipelineRuns.filter((r) => r.status === 'failed').map((r) => [`f-${r.id}`, r.sha]))
  const crSha = new Map(ds.changeRequests.map((c) => [`f-${c.number}`, c.sha]))
  const findingForSha = new Map<string, string>()
  for (const f of a.failures) {
    const sha = (f.linkedDeploymentId && depSha.get(f.linkedDeploymentId)) || failedRunSha.get(f.id) || crSha.get(f.id)
    if (sha && !findingForSha.has(sha)) findingForSha.set(sha, f.id)
  }
  const samples = opts.raw ? integrationSamples(opts.raw) : undefined
  const adv = (x: Advice) => ({
    id: x.pattern.id, n: x.pattern.name, p: x.pattern.pillar, principle: x.pattern.principle, problem: x.pattern.problem, solution: x.pattern.solution, tradeoffs: x.pattern.tradeoffs,
    refs: refs(x.pattern.references), score: x.priority, f: x.formula, ev: x.evidenceLevel, gate: x.securityGate, why: x.why, steps: x.steps,
    from: x.contributions.slice(0, 6).map((c) => [c.kind, c.ruleId, c.title, c.count]),
  })
  const journeyBySha = new Map(a.journeys.map((j) => [j.sha, j]))
  const journeys = opts.maxJourneys ? a.journeys.slice(0, opts.maxJourneys) : a.journeys
  // code rule text is identical across findings of the same rule: keep it once
  const codeRules: Record<string, { t: string; s: string; p: string; rec: string; refs: number[] }> = {}
  for (const c of a.code) codeRules[c.ruleId] ??= { t: c.title, s: c.severity, p: c.pillar, rec: c.recommendation, refs: refs(c.references) }

  return {
    v: VIEW_MODEL_VERSION,
    mode: opts.mode,
    at: ds.generatedAt,
    win: ds.windowDays,
    products: ds.products.map((p) => ({ id: p.id, n: p.name, o: p.owner, t: p.team, tier: p.tier, repos: p.repos })),
    scopes: Object.fromEntries(['all', ...ds.products.map((p) => p.id)].map((id) => [id, scope(id)])),
    journeys: journeys.map((j) => ({
      pid: j.productId, repo: j.repo.split('/')[1], pr: j.prNumber, t: j.title, au: j.author, m: j.mergedAt, o: j.outcome,
      b: j.blockedAt ? STAGE_LABEL[j.blockedAt] : null, lt: j.leadTimeHours == null ? null : r1(j.leadTimeHours), sha: j.sha.slice(0, 7),
      st: j.stages.map((s) => [s.status[0], s.at ?? null, s.durationMin ?? null, (s.detail ?? '').slice(0, 140)]),
      f: findingForSha.get(j.sha) ?? null,
    })),
    stageNames: Object.values(STAGE_LABEL),
    failures: a.failures.map((f) => ({ id: f.id, pid: f.productId, at: f.at, src: f.source, cat: f.category, ev: f.evidence.slice(0, evLen), rule: f.recommendation.ruleId })),
    rules,
    risks: a.risks.map((r) => {
      const j = journeyBySha.get(r.sha)
      return { pid: r.productId, sha: r.sha.slice(0, 7), t: j?.title ?? r.sha, s: r.score, l: r.level, g: r.gate, b: j?.blockedAt ? STAGE_LABEL[j.blockedAt] : '', f: r.factors.map((x) => [x.weight, x.factor, x.detail]) }
    }),
    code: a.code.map((c) => ({ pid: c.productId, repo: c.repo.split('/')[1], file: c.file, line: c.line ?? null, ev: c.evidence.slice(0, evLen), rule: c.ruleId })),
    codeRules,
    scores: Object.fromEntries(Object.entries(a.scorecards).map(([k, s]) => [k, { o: s.overall, g: s.grade, p: s.pillars.map((x) => [x.pillar, x.score, x.topIssue ?? '']) }])),
    pillars: PILLARS.map((p) => [p.id, p.label]),
    sys: AI_SYSTEM_PROMPT,
    refs: refTable,
    totalJourneys: a.journeys.length,
    advice: Object.fromEntries(Object.entries(a.advice).map(([pid, ad]) => [pid, { best: ad.best ? adv(ad.best) : null, next: ad.next.map(adv) }])),
    selfPatterns: SELF_PATTERNS.map((x) => ({ n: x.name, where: x.where, why: x.why, refs: refs(x.references) })),
    integrations: INTEGRATIONS.map((spec) => {
      const st = opts.status?.find((x) => x.source === spec.id)
      return { ...spec, tier: st?.tier ?? (opts.mode === 'demo' ? 'dummy' : 'unknown'), ok: st?.ok ?? true, records: st?.records ?? null, error: st?.error ?? null, sample: samples?.[spec.id] ?? '' }
    }),
  }
}

export type ViewModel = ReturnType<typeof buildViewModel>
