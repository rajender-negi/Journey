// AI layer contract. Deterministic engines decide WHAT is wrong and WHICH rule applies;
// the LLM only explains, links evidence across sources and prioritises. Output must cite rule ids
// that exist in the evidence pack; anything else is rejected by validateAiOutput.

import type { Analysis } from './index'

export type AiMode = 'finding' | 'product' | 'portfolio'

export interface AiAction {
  priority: number
  action: string
  ruleId: string
  horizon: 'now' | 'this-sprint' | 'this-quarter'
  owner: string
}

export interface AiOutput {
  headline: string
  rootCause: string
  impact: string
  actions: AiAction[]
  evidenceUsed: string[]
}

export const AI_SYSTEM_PROMPT = `You are the analysis layer of a product delivery insights platform used by engineering leadership.
You receive an evidence pack produced by deterministic rules over Dynatrace, GitHub, Argo CD, ServiceNow, Kubernetes and cloud billing data.
Rules:
- Use only facts in the evidence pack. Do not invent services, numbers, versions or causes.
- Every action must cite a ruleId present in the evidence pack.
- Prefer actions that prevent recurrence and reduce MTTR. Reuse existing platform services before proposing new ones.
- Be direct. No hedging, no filler, no em dashes.
- Respond with JSON only, matching this TypeScript type:
{ "headline": string, "rootCause": string, "impact": string,
  "actions": { "priority": number, "action": string, "ruleId": string, "horizon": "now"|"this-sprint"|"this-quarter", "owner": string }[],
  "evidenceUsed": string[] }`

export function buildEvidencePack(a: Analysis, mode: AiMode, target: string): Record<string, unknown> {
  const productName = (id: string) => a.dataset.products.find((p) => p.id === id)?.name ?? id
  if (mode === 'finding') {
    const f = a.failures.find((x) => x.id === target)
    if (!f) throw new Error(`finding ${target} not found`)
    const product = a.dataset.products.find((p) => p.id === f.productId)
    const dep = f.linkedDeploymentId ? a.dataset.deployments.find((d) => d.id === f.linkedDeploymentId) : undefined
    const journey = dep ? a.journeys.find((j) => j.sha === dep.sha) : undefined
    return {
      mode, product: product && { id: product.id, name: product.name, tier: product.tier, owner: product.owner, team: product.team },
      finding: { id: f.id, at: f.at, source: f.source, category: f.category, evidence: f.evidence, ruleId: f.recommendation.ruleId, fixNow: f.recommendation.fixNow, prevent: f.recommendation.prevent },
      deployment: dep && { id: dep.id, version: dep.version, sha: dep.sha, env: dep.environment, status: dep.status, changeRequest: dep.changeRequest },
      journey: journey && { title: journey.title, author: journey.author, stages: journey.stages.map((s) => `${s.name}:${s.status}${s.durationMin != null ? `:${s.durationMin}m` : ''}`) },
      relatedCodeFindings: a.code.filter((c) => c.productId === f.productId && (c.severity === 'critical' || c.severity === 'high')).slice(0, 6).map((c) => ({ ruleId: c.ruleId, title: c.title, evidence: c.evidence, file: c.file })),
      dora: a.dora[f.productId],
    }
  }
  if (mode === 'product') {
    const p = a.dataset.products.find((x) => x.id === target)
    if (!p) throw new Error(`product ${target} not found`)
    const fails = a.failures.filter((f) => f.productId === target)
    const byRule = new Map<string, number>()
    for (const f of fails) byRule.set(f.recommendation.ruleId, (byRule.get(f.recommendation.ruleId) ?? 0) + 1)
    return {
      mode, product: { id: p.id, name: p.name, tier: p.tier, owner: p.owner, team: p.team },
      dora: a.dora[target],
      failureRules: [...byRule.entries()].map(([ruleId, count]) => ({ ruleId, count, title: fails.find((f) => f.recommendation.ruleId === ruleId)!.recommendation.title })),
      pendingRisk: a.risks.filter((r) => r.productId === target).map((r) => ({ sha: r.sha, score: r.score, gate: r.gate, factors: r.factors.map((f) => f.factor) })),
      codeFindings: a.code.filter((c) => c.productId === target).map((c) => ({ ruleId: c.ruleId, severity: c.severity, pillar: c.pillar, title: c.title, evidence: c.evidence })),
      scorecard: a.scorecards[target],
      cost: { currentMonth: a.cost[target]?.currentMonth, momChangePct: a.cost[target]?.momChangePct, savings: a.cost[target]?.insights.slice(0, 5).map((i) => ({ title: i.title, monthlySavingsUsd: i.monthlySavingsUsd })) },
    }
  }
  return {
    mode,
    products: a.dataset.products.map((p) => ({
      name: p.name, tier: p.tier, dora: a.dora[p.id], grade: a.scorecards[p.id]?.grade, monthlyCost: a.cost[p.id]?.currentMonth,
      savings: a.cost[p.id]?.savingsPotentialUsd, failureCost: a.cost[p.id]?.failureCostUsd,
      topRules: [...new Set(a.failures.filter((f) => f.productId === p.id).map((f) => f.recommendation.ruleId))].slice(0, 4),
    })),
    portfolioDora: a.dora.all,
    note: `Product names: ${a.dataset.products.map((p) => `${p.id}=${productName(p.id)}`).join(', ')}`,
  }
}

export function buildUserPrompt(pack: Record<string, unknown>): string {
  const ask = pack.mode === 'finding'
    ? 'Explain this failure: probable root cause chain across the sources, business impact, and the ordered actions to restore now and prevent recurrence.'
    : pack.mode === 'product'
      ? 'Brief the product owner: the one-line state of delivery health, the root pattern behind failures, and the top 5 actions ranked by MTTR and failure-rate impact.'
      : 'Brief engineering leadership on the portfolio: which product needs intervention first and why, and the top 5 cross-product actions ranked by risk reduction and savings.'
  return `${ask}\n\nEvidence pack:\n${JSON.stringify(pack)}`
}

export function validateAiOutput(raw: string, pack: Record<string, unknown>): AiOutput {
  const json = raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)
  const out = JSON.parse(json) as AiOutput
  const known = new Set(JSON.stringify(pack).match(/\b(FX|K8S|GHA|CODE|DOCKER|TF|REPO|ARCH|RUNTIME)-[A-Z0-9-]+\b/g) ?? [])
  out.actions = (out.actions ?? []).filter((x) => known.has(x.ruleId)).sort((a, b) => a.priority - b.priority)
  if (!out.headline || !out.actions.length) throw new Error('AI output failed validation')
  return out
}

/** Deterministic fallback used when no model is configured or the model output fails validation. */
export function deterministicBrief(a: Analysis, mode: AiMode, target: string): AiOutput {
  const pack = buildEvidencePack(a, mode, target)
  if (mode === 'finding') {
    const f = a.failures.find((x) => x.id === target)!
    return {
      headline: `${f.category}: ${f.recommendation.title}`,
      rootCause: f.recommendation.summary,
      impact: `${f.source} failure on ${a.dataset.products.find((p) => p.id === f.productId)?.name}.`,
      actions: [
        ...f.recommendation.fixNow.map((x, i) => ({ priority: i + 1, action: x, ruleId: f.recommendation.ruleId, horizon: 'now' as const, owner: 'on-call' })),
        ...f.recommendation.prevent.map((x, i) => ({ priority: f.recommendation.fixNow.length + i + 1, action: x, ruleId: f.recommendation.ruleId, horizon: 'this-sprint' as const, owner: 'product team' })),
      ],
      evidenceUsed: [f.id],
    }
  }
  const scope = mode === 'product' ? a.failures.filter((x) => x.productId === target) : a.failures
  const counts = new Map<string, { n: number; rec: (typeof scope)[number]['recommendation'] }>()
  for (const f of scope.filter((x) => x.recommendation.ruleId !== 'FX-NON-CHANGE')) {
    const e = counts.get(f.recommendation.ruleId) ?? { n: 0, rec: f.recommendation }
    e.n++
    counts.set(f.recommendation.ruleId, e)
  }
  const top = [...counts.values()].sort((x, y) => y.n - x.n).slice(0, 5)
  const d = mode === 'product' ? a.dora[target] : a.dora.all
  return {
    headline: `CFR ${Math.round(d.changeFailureRate * 100)}% (${d.bands.changeFailureRate}), lead time ${d.leadTimeHours}h (${d.bands.leadTime}), MTTR ${d.mttrHours}h (${d.bands.mttr})`,
    rootCause: top.length ? `Most frequent failure pattern: ${top[0].rec.title} (${top[0].n} occurrences).` : 'No change-caused failures in the window.',
    impact: mode === 'product' ? `Failure cost this window: $${a.cost[target]?.failureCostUsd.toLocaleString('en-US')}.` : `Portfolio failure cost: $${a.cost.all.failureCostUsd.toLocaleString('en-US')}.`,
    actions: top.map((t, i) => ({ priority: i + 1, action: t.rec.prevent[0], ruleId: t.rec.ruleId, horizon: i === 0 ? 'now' : 'this-sprint', owner: 'product team' })),
    evidenceUsed: Object.keys(pack),
  }
}
