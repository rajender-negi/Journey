// Phase 6: best-practice scorecard per product across six pillars, plus the guidance catalog.

import type { CodeFinding, FailureFinding, Pillar, PillarScore, Scorecard, Severity } from './types'
import { FILE_RULES } from './codebase'
import { FAILURE_RULES } from './failures'

export const PILLARS: { id: Pillar; label: string; question: string }[] = [
  { id: 'coding', label: 'Coding', question: 'Does code that reaches main compile, pass stable tests and fail loudly?' },
  { id: 'design-patterns', label: 'Design patterns', question: 'Are data access, migrations and remote calls built with proven patterns (expand/contract, batching, circuit breaker)?' },
  { id: 'system-design', label: 'System design', question: 'Are timeouts, probes, resources and capacity set from measured behaviour?' },
  { id: 'architecture', label: 'Architecture', question: 'Is the product redundant, cached where the traffic shape demands it, and reusing shared platform services?' },
  { id: 'security', label: 'Security', question: 'Least privilege, no secrets in code, pinned supply chain, patched dependencies?' },
  { id: 'tool-integration', label: 'Tool integration', question: 'Do GitHub, Argo CD, ServiceNow and Dynatrace hand off evidence automatically, with immutable artifacts?' },
]

const PENALTY: Record<Severity, number> = { critical: 25, high: 12, medium: 6, low: 2, info: 0 }
const WEIGHT: Record<Pillar, number> = { security: 1.5, architecture: 1.2, 'system-design': 1.2, 'design-patterns': 1, coding: 1, 'tool-integration': 0.8 }

export function scorecard(productId: string, code: CodeFinding[], failures: FailureFinding[]): Scorecard {
  const pillars: PillarScore[] = PILLARS.map(({ id }) => {
    const c = code.filter((f) => f.productId === productId && f.pillar === id)
    // each distinct failure rule counts once at half weight: repeated incidents are a DORA concern, not a code smell count
    const fRules = new Map<string, FailureFinding>()
    for (const f of failures.filter((x) => x.productId === productId && x.recommendation.pillar === id && x.recommendation.ruleId !== 'FX-NON-CHANGE')) fRules.set(f.recommendation.ruleId, f)
    const penalty = c.reduce((a, f) => a + PENALTY[f.severity], 0) + [...fRules.values()].reduce((a, f) => a + PENALTY[f.recommendation.severity] / 2, 0)
    const worst = [...c].sort((a, b) => PENALTY[b.severity] - PENALTY[a.severity])[0]
    return { pillar: id, score: Math.max(0, 100 - penalty), findings: c.length + fRules.size, topIssue: worst?.title ?? [...fRules.values()][0]?.recommendation.title }
  })
  const wsum = pillars.reduce((a, p) => a + WEIGHT[p.pillar], 0)
  const overall = Math.round(pillars.reduce((a, p) => a + p.score * WEIGHT[p.pillar], 0) / wsum)
  const grade = overall >= 85 ? 'A' : overall >= 70 ? 'B' : overall >= 55 ? 'C' : overall >= 40 ? 'D' : 'E'
  return { productId, overall, grade, pillars }
}

/** Every rule the app enforces, grouped by pillar, for the guidance page and the Cursor rules export. */
export function guidanceCatalog() {
  const items = [
    ...FILE_RULES.map((r) => ({ id: r.id, pillar: r.pillar, severity: r.severity, title: r.title, guidance: r.recommendation, references: r.references, kind: 'code' as const })),
    ...FAILURE_RULES.map((r) => ({ id: r.ruleId, pillar: r.pillar, severity: r.severity, title: r.title, guidance: r.prevent.join(' '), references: r.references, kind: 'delivery' as const })),
  ]
  return PILLARS.map((p) => ({ ...p, items: items.filter((i) => i.pillar === p.id) }))
}
