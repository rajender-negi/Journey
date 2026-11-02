// Vendor agents are the investigators; this app is the referee.
// Each vendor's own AI agent (Dynatrace Intelligence, Now Assist, AWS DevOps Agent, Azure SRE Agent,
// Gemini Cloud Assist, K8sGPT) is asked about the failure through its MCP server. Their answers are
// normalised into claims, and every claim must be backed by raw data from another tool before it is
// used: evidence beats opinion. What stays ours is small and deterministic:
//   - which agents to ask for this failure (by product, cloud and namespace)
//   - the cause category of each claim (so claims from different vendors can be compared)
//   - corroboration: which raw evidence supports the claim
//   - conflict resolution: when corroborated claims disagree, the better-supported one wins
//   - the design fix: the pattern that stops the cause from recurring, tied to the product's own code findings

import { PATTERNS, RULE_PATTERN, type Analysis, type Reference } from '@pj/core'
import type { Op } from './toolmap'
import type { Evidence, EvidenceKind, InvestigationContext, SourceName } from './types'

export type CauseCategory = 'deployment' | 'infrastructure-change' | 'capacity' | 'config' | 'dependency' | 'image' | 'code' | 'unknown'
export type Layer = 'runtime' | 'itsm' | 'cloud' | 'kubernetes'

export interface VendorAgent {
  id: string
  name: string
  layer: Layer
  source: SourceName
  op: Op
  /** what is documented about reaching it (MCP server and tools) */
  access: string
  docs: string
  /** documented: tool names come from vendor docs; to-confirm: tool names are our best guess, set them in toolMap */
  status: 'documented' | 'to-confirm'
  when: (ctx: InvestigationContext) => boolean
}

export const VENDOR_AGENTS: VendorAgent[] = [
  { id: 'dynatrace-intelligence', name: 'Dynatrace Intelligence', layer: 'runtime', source: 'dynatrace', op: 'vendor_dynatrace', access: 'Dynatrace MCP server', docs: 'https://www.dynatrace.com/news/press-release/dynatrace-introduces-domain-specific-agents/', status: 'to-confirm', when: (c) => !!c.problemDisplayId },
  { id: 'now-assist', name: 'ServiceNow Now Assist', layer: 'itsm', source: 'servicenow', op: 'vendor_servicenow', access: 'ServiceNow MCP Server Console (Now Assist skills)', docs: 'https://www.servicenow.com/docs/', status: 'to-confirm', when: () => true },
  { id: 'aws-devops-agent', name: 'AWS DevOps Agent', layer: 'cloud', source: 'aws', op: 'vendor_aws', access: 'AWS MCP Server, call_aws with devops-agent list-journal-records', docs: 'https://repost.aws/articles/ARYcX6Ay6PQWKfeXy4WQVCyg/querying-aws-devops-agent-investigations-from-kiro-cli-for-incident-response', status: 'documented', when: (c) => !!c.clouds?.includes('aws') },
  { id: 'azure-sre-agent', name: 'Azure SRE Agent', layer: 'cloud', source: 'azure', op: 'vendor_azure', access: 'Azure MCP Server, sreagent_threads_create', docs: 'https://learn.microsoft.com/en-us/azure/sre-agent/mcp-server', status: 'documented', when: (c) => !!c.clouds?.includes('azure') },
  { id: 'gemini-cloud-assist', name: 'Gemini Cloud Assist investigations', layer: 'cloud', source: 'gcp', op: 'vendor_gcp', access: 'Cloud Assist investigations (MCP server or API)', docs: 'https://docs.cloud.google.com/cloud-assist/investigations', status: 'to-confirm', when: (c) => !!c.clouds?.includes('gcp') },
  { id: 'k8sgpt', name: 'K8sGPT', layer: 'kubernetes', source: 'kubernetes', op: 'vendor_k8sgpt', access: 'k8sgpt MCP server (analyze)', docs: 'https://k8sgpt.ai/docs/reference/mcp', status: 'to-confirm', when: (c) => !!c.namespace },
]

export interface VendorClaim {
  agent: string
  name: string
  layer: Layer
  category: CauseCategory
  cause: string
  fix?: string
}

export interface VendorVerdict extends VendorClaim {
  evidenceId: string
  corroboratedBy: string[]
  status: 'corroborated' | 'unsupported' | 'overruled'
  note: string
}

// ---------- claim extraction: each vendor's native answer -> one claim ----------

const CATEGORY_RE: [CauseCategory, RegExp][] = [
  ['infrastructure-change', /\b(failover|ModifyDBInstance|instance class|downsiz|scaled down|infrastructure change|UpdateService|config\/write|terraform apply)\b/i],
  ['image', /\b(ErrImagePull|ImagePullBackOff|image not found|manifest unknown)\b/i],
  ['capacity', /\b(OOMKilled|out of memory|memory limit|cpu throttl|evict|insufficient (cpu|memory)|capacity)\b/i],
  ['config', /\b(CreateContainerConfigError|configmap|secret .*not found|missing (env|config)|environment variable)\b/i],
  ['deployment', /\b(deployment|release|rollout|new version|revision)\b/i],
  ['dependency', /\b(timeout|connection refused|upstream|downstream|dependency|connection pool)\b/i],
  ['code', /\b(NullPointerException|exception|stack trace|bug|regression in code|query per request|N\+1)\b/i],
]
export const categorize = (text: string): CauseCategory => CATEGORY_RE.find(([, re]) => re.test(text))?.[0] ?? 'unknown'

const str = (v: unknown) => (typeof v === 'string' ? v : v == null ? '' : JSON.stringify(v))

/** Pulls the cause and fix out of each vendor's own response format. */
export function extractClaim(agent: VendorAgent, raw: unknown): VendorClaim | null {
  const r = (raw ?? {}) as Record<string, any>
  let cause = '', fix: string | undefined
  switch (agent.id) {
    case 'dynatrace-intelligence': cause = str(r.answer ?? r.text ?? r.response); break
    case 'now-assist': {
      const top = (r.result?.similar_incidents ?? [])[0]
      cause = str(r.result?.recommendation?.probable_cause ?? top?.close_notes ?? r.answer)
      fix = r.result?.recommendation?.resolution ?? top?.close_notes
      break
    }
    case 'aws-devops-agent': {
      const recs: any[] = r.records ?? r.journalRecords ?? []
      cause = str(recs.find((x) => /root_cause/.test(x.recordType))?.content ?? '')
      fix = recs.find((x) => /mitigation/.test(x.recordType))?.content
      break
    }
    case 'azure-sre-agent': {
      const msgs: any[] = r.messages ?? []
      cause = str([...msgs].reverse().find((m) => m.role === 'assistant')?.content ?? '')
      break
    }
    case 'gemini-cloud-assist': {
      const hs: any[] = r.hypotheses ?? []
      const best = [...hs].sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))[0]
      cause = str(best ? `${best.title}. ${best.text ?? ''}` : r.observations?.[0]?.text ?? '')
      fix = best?.remediation
      break
    }
    case 'k8sgpt': {
      const res: any[] = r.results ?? []
      cause = res.map((x) => `${x.kind} ${x.name}: ${(x.error ?? []).map((e: any) => e.Text).join('; ')}`).join(' | ')
      fix = res.map((x) => x.details).filter(Boolean).join(' ') || undefined
      break
    }
  }
  cause = cause.trim()
  if (!cause) return null
  return { agent: agent.id, name: agent.name, layer: agent.layer, category: categorize(cause), cause: cause.slice(0, 400), fix: fix?.slice(0, 400) }
}

// ---------- corroboration: which raw evidence backs a claim ----------

const SUPPORT: Record<CauseCategory, { kinds: EvidenceKind[]; re: RegExp }> = {
  deployment: { kinds: ['dt_deployment_events', 'argo_app', 'gh_pr_files'], re: /deploy|revision|sync|version|SDLC|"number"/i },
  'infrastructure-change': { kinds: ['cloud_changes', 'dt_problem'], re: /Modify\w+|Update\w+|config\/write|Delete\w+|Reboot\w+|failover/ },
  capacity: { kinds: ['k8s_workload', 'k8s_events', 'dt_problem'], re: /OOMKilled|memory|cpu|throttl|Evict|Insufficient/i },
  config: { kinds: ['k8s_events', 'argo_app', 'dt_logs'], re: /CreateContainerConfigError|config|secret|not found/i },
  dependency: { kinds: ['dt_traces', 'dt_logs', 'dt_latency'], re: /timeout|connection|refused|upstream|database|db\./i },
  image: { kinds: ['k8s_events', 'k8s_workload'], re: /ErrImagePull|ImagePullBackOff|manifest/i },
  code: { kinds: ['gh_pr_files', 'dt_traces', 'dt_logs', 'gh_job_log', 'security_findings'], re: /Exception|error|\.(java|ts|js|py|go)\b|db\.|span/i },
  unknown: { kinds: [], re: /$^/ },
}
/** Raw evidence kinds that would back a claim of this category (asked for again when a claim is unsupported). */
export const supportKinds = (c: CauseCategory) => SUPPORT[c].kinds
const isRaw = (e: Evidence) => e.ok && e.source !== 'analysis' && !e.claim && e.kind !== 'kb_similar'

export function corroborate(claim: VendorClaim, ev: Evidence[]): string[] {
  const s = SUPPORT[claim.category]
  return ev.filter((e) => isRaw(e) && s.kinds.includes(e.kind as EvidenceKind) && s.re.test(e.data)).map((e) => e.id)
}

/** What each rule expects the cause to be: breaks ties between two corroborated claims. */
const RULE_CATEGORY: Record<string, CauseCategory> = {
  'FX-REGRESSION-SLOW': 'deployment', 'FX-REGRESSION-ERRORS': 'deployment', 'FX-DB-MIGRATION': 'deployment',
  'FX-OOM': 'capacity', 'FX-CRASHLOOP': 'config', 'FX-CONFIG-MISSING': 'config', 'FX-READINESS': 'dependency',
  'FX-IMAGE-PULL': 'image', 'FX-NON-CHANGE': 'infrastructure-change', 'FX-COMPILE': 'code', 'FX-FLAKY-TEST': 'code', 'FX-VULN-GATE': 'code',
}

/** All vendor answers in this run, judged against the raw evidence. The best-supported corroborated claim wins. */
export function judgeClaims(ctx: InvestigationContext, ev: Evidence[]): { verdicts: VendorVerdict[]; winner: VendorVerdict | null } {
  const verdicts: VendorVerdict[] = ev.filter((e) => e.ok && e.claim).map((e) => {
    const by = corroborate(e.claim!, ev)
    return { ...e.claim!, evidenceId: e.id, corroboratedBy: by, status: by.length ? 'corroborated' : 'unsupported', note: by.length ? `backed by ${by.join(', ')}` : `no ${e.claim!.category} signal in the raw data` }
  })
  const backed = verdicts.filter((v) => v.status === 'corroborated' && v.category !== 'unknown')
  const expected = RULE_CATEGORY[ctx.ruleId]
  const score = (v: VendorVerdict) => v.corroboratedBy.length * 10 + (v.category === expected ? 5 : 0) + backed.filter((o) => o.category === v.category).length + (v.layer === 'itsm' ? 0 : 0.5)
  const winner = [...backed].sort((a, b) => score(b) - score(a))[0] ?? null
  if (winner) for (const v of backed) if (v.category !== winner.category) Object.assign(v, { status: 'overruled', note: `${v.note}; ${winner.name} (${winner.category}) has stronger support` })
  return { verdicts, winner }
}

// ---------- design fix: stop the cause from recurring ----------

const CATEGORY_PATTERN: Record<CauseCategory, string | undefined> = {
  deployment: 'progressive-delivery', 'infrastructure-change': 'infra-pipeline', capacity: 'right-sizing', config: 'external-config',
  dependency: 'resilience', image: 'immutable-artifacts', code: 'trunk-quality', unknown: undefined,
}

/** Code and design patterns named by the cause itself: the structural fix behind the operational one. */
const TEXT_PATTERN: [RegExp, string][] = [
  [/health endpoint waits on|readiness probe/i, 'health-probes'],
  [/N\+1|calls per request|chatty/i, 'batch-reads'],
  [/schema migration/i, 'expand-contract'],
  [/failover|dropped connections|timed? ?out|connection refused|upstream/i, 'resilience'],
  [/environment variable is missing|configmap|secret was not found/i, 'external-config'],
  [/memory limit|OOMKilled/i, 'right-sizing'],
  [/ErrImagePull|manifest unknown/i, 'immutable-artifacts'],
]

export interface DesignFix {
  patternId: string
  name: string
  problem: string
  solution: string
  tradeoffs: string
  references: Reference[]
  /** the product's own code findings that this pattern also resolves */
  codeFindings: { ruleId: string; title: string; file?: string }[]
  why: string
  /** the second pattern when the cause and the rule point to different ones (e.g. code resilience + infrastructure pipeline) */
  also?: { patternId: string; name: string }
}

export function designFix(a: Analysis, ctx: InvestigationContext, winner: VendorVerdict | null): DesignFix | null {
  // 1. what the corroborated cause itself names (code or design), 2. the cause category, 3. the rule's own pattern
  const fromText = winner ? TEXT_PATTERN.find(([re]) => re.test(winner.cause))?.[1] : undefined
  const fromCategory = winner && winner.category !== RULE_CATEGORY[ctx.ruleId] ? CATEGORY_PATTERN[winner.category] : undefined
  const ruleP = RULE_PATTERN[ctx.ruleId]
  const order = [fromText, fromCategory, ruleP, winner ? CATEGORY_PATTERN[winner.category] : undefined].filter((x): x is string => !!x && !!PATTERNS[x])
  const p = order[0] ? PATTERNS[order[0]] : undefined
  if (!p) return null
  const second = order.find((x) => x !== p.id)
  const code = a.code.filter((c) => c.productId === ctx.productId && RULE_PATTERN[c.ruleId] === p.id)
  const n = winner?.corroboratedBy.length ?? 0
  return {
    patternId: p.id, name: p.name, problem: p.problem, solution: p.solution, tradeoffs: p.tradeoffs, references: p.references,
    codeFindings: code.slice(0, 5).map((c) => ({ ruleId: c.ruleId, title: c.title, file: c.file })),
    why: `${winner ? `Cause from ${winner.name} (${winner.category}), backed by ${n} raw signal${n === 1 ? '' : 's'}` : `Rule ${ctx.ruleId}`}. ${code.length ? `${code.length} code finding${code.length > 1 ? 's' : ''} in ${ctx.productName} ${code.length > 1 ? 'show' : 'shows'} the same gap.` : 'No matching code finding yet: the fix is in design and pipeline.'}`,
    ...(second ? { also: { patternId: second, name: PATTERNS[second].name } } : {}),
  }
}
