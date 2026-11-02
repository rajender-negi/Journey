// Turns a finding into an investigation context, chooses default evidence per failure rule,
// and fetches each evidence kind through MCP with parameters taken from the analysis.
// Queries are templates filled from known facts: the model never writes a free-form query.

import type { Analysis } from '@pj/core'
import type { Op } from './toolmap'
import type { Evidence, EvidenceKind, InvestigationContext, PlanItem, SourceName } from './types'
import { cap } from './policy'
import { sanitizeToolText } from './guard'

export interface ToolRunner {
  op(op: Op, params: Record<string, string>, meta?: { traceId?: string }): Promise<{ ok: boolean; text: string; error?: string; server?: string; tool?: string; args?: Record<string, unknown> }>
}

export function buildContext(a: Analysis, findingId: string): InvestigationContext {
  const f = a.failures.find((x) => x.id === findingId)
  if (!f) throw new Error(`finding ${findingId} not found`)
  const ds = a.dataset
  const product = ds.products.find((p) => p.id === f.productId)
  const dep = f.linkedDeploymentId ? ds.deployments.find((d) => d.id === f.linkedDeploymentId) : f.source === 'deployment' ? ds.deployments.find((d) => d.id === f.sourceId) : undefined
  const run = f.source === 'pipeline' ? ds.pipelineRuns.find((r) => r.id === f.sourceId) : undefined
  const problem = f.source === 'problem' ? ds.problems.find((p) => p.id === f.sourceId) : undefined
  const cr = f.source === 'change' ? ds.changeRequests.find((c) => c.number === f.sourceId) : undefined
  const sha = dep?.sha ?? run?.sha ?? cr?.sha
  const repo = dep?.repo ?? run?.repo ?? product?.repos[0]
  const merge = sha ? ds.merges.find((m) => m.sha === sha && (!repo || m.repo === repo)) : undefined
  const journey = sha ? a.journeys.find((j) => j.sha === sha) : undefined
  const env = dep?.environment ?? run?.environment
  const nsBase = product?.k8sNamespaces[0]
  const namespace = nsBase ? (env && env !== 'prod' ? `${nsBase}-${env}` : nsBase) : undefined
  const r = f.recommendation
  return {
    findingId, productId: f.productId, productName: product?.name ?? f.productId, tier: product?.tier ?? 3,
    ruleId: r.ruleId, ruleTitle: r.title, ruleSummary: r.summary, category: f.category, source: f.source, evidenceText: f.evidence, at: f.at,
    fixNow: r.fixNow, prevent: r.prevent,
    service: problem?.affectedEntities[0] ?? product?.services[0], namespace, environment: env, repo, sha, prNumber: merge?.prNumber,
    deployId: dep?.id, deployVersion: dep?.version, deployFinishedAt: dep?.finishedAt ?? run?.finishedAt ?? problem?.startedAt,
    argoApp: nsBase && env ? `${nsBase}-${env}` : undefined,
    jobId: run?.id.startsWith('gh-') ? run.id.slice(3) : undefined,
    problemId: problem?.id, problemDisplayId: problem?.displayId,
    journeyStages: journey?.stages.map((s) => `${s.name}:${s.status}${s.durationMin != null ? `:${s.durationMin}m` : ''}`),
  }
}

/** Evidence that already exists in the analysis; always available, needs no MCP. */
export function analysisEvidence(ctx: InvestigationContext): Evidence {
  return {
    id: 'E0', kind: 'analysis', source: 'analysis', ok: true, at: new Date().toISOString(),
    summary: `Rule ${ctx.ruleId} classified this as "${ctx.category}" from ${ctx.source} evidence.`,
    data: cap(JSON.stringify({ evidence: ctx.evidenceText, deployment: ctx.deployVersion ? { version: ctx.deployVersion, sha: ctx.sha, env: ctx.environment, finishedAt: ctx.deployFinishedAt } : null, journey: ctx.journeyStages }), 2000),
  }
}

const RULE_PLANS: Record<string, EvidenceKind[]> = {
  'FX-REGRESSION-SLOW': ['dt_problem', 'dt_latency', 'dt_deployment_events', 'gh_pr_files', 'kb_similar'],
  'FX-REGRESSION-ERRORS': ['dt_problem', 'dt_error_rate', 'dt_deployment_events', 'gh_pr_files', 'kb_similar'],
  'FX-OOM': ['k8s_events', 'argo_app', 'dt_deployment_events', 'kb_similar'],
  'FX-CRASHLOOP': ['k8s_events', 'argo_app', 'gh_pr_files', 'kb_similar'],
  'FX-CONFIG-MISSING': ['k8s_events', 'argo_app', 'gh_pr_files', 'kb_similar'],
  'FX-IMAGE-PULL': ['k8s_events', 'argo_app', 'kb_similar'],
  'FX-READINESS': ['k8s_events', 'argo_app', 'dt_error_rate', 'kb_similar'],
  'FX-DB-MIGRATION': ['argo_app', 'gh_pr_files', 'dt_deployment_events', 'kb_similar'],
  'FX-COMPILE': ['gh_job_log', 'gh_pr_files', 'kb_similar'],
  'FX-FLAKY-TEST': ['gh_job_log', 'kb_similar'],
  'FX-VULN-GATE': ['gh_job_log', 'gh_pr_files', 'kb_similar'],
  'FX-CHANGE-WAIT': ['dt_deployment_events', 'kb_similar'],
  // a problem with no deployment behind it: the runtime record itself is the evidence
  'FX-NON-CHANGE': ['dt_problem', 'dt_error_rate', 'dt_latency', 'k8s_events', 'kb_similar'],
}

export const KIND_SOURCE: Record<EvidenceKind, SourceName> = {
  kb_similar: 'servicenow',
  dt_problem: 'dynatrace', dt_error_rate: 'dynatrace', dt_latency: 'dynatrace', dt_deployment_events: 'dynatrace',
  argo_app: 'argocd', gh_pr_files: 'github', gh_job_log: 'github', k8s_events: 'kubernetes',
}

export const KIND_DESCRIPTION: Record<EvidenceKind, string> = {
  dt_problem: 'Dynatrace problem record (root cause entity, timeline)',
  dt_error_rate: 'Dynatrace request and failure counts for the service, 1h before to 1h after the deployment',
  dt_latency: 'Dynatrace p95 response time for the service, 1h before to 1h after the deployment',
  dt_deployment_events: 'Dynatrace SDLC deployment events for this commit',
  argo_app: 'Argo CD application sync and health state',
  gh_pr_files: 'Files changed in the pull request for this commit',
  gh_job_log: 'Tail of the failed GitHub Actions job log',
  k8s_events: 'Kubernetes warning events in the product namespace',
  kb_similar: 'Similar past incidents, runbooks and approved investigations (hybrid keyword + vector search)',
}

/** Kinds that can actually be fetched for this context (parameters exist). */
export function feasible(kind: EvidenceKind, ctx: InvestigationContext): boolean {
  switch (kind) {
    case 'dt_problem': return !!(ctx.problemId || ctx.problemDisplayId)
    case 'dt_error_rate': case 'dt_latency': return !!(ctx.service && ctx.deployFinishedAt)
    case 'dt_deployment_events': return !!ctx.sha
    case 'argo_app': return !!ctx.argoApp
    case 'gh_pr_files': return !!(ctx.repo && ctx.prNumber)
    case 'gh_job_log': return !!(ctx.repo && ctx.jobId)
    case 'k8s_events': return !!ctx.namespace
    case 'kb_similar': return true
  }
}

export function defaultPlan(ctx: InvestigationContext): PlanItem[] {
  return (RULE_PLANS[ctx.ruleId] ?? ['dt_deployment_events', 'gh_pr_files', 'kb_similar']).filter((k) => feasible(k, ctx)).map((kind) => ({ kind, why: `default evidence for ${ctx.ruleId}` }))
}

const iso = (t: number) => new Date(t).toISOString()

export function dqlFor(kind: EvidenceKind, ctx: InvestigationContext): string | undefined {
  const t = ctx.deployFinishedAt ? Date.parse(ctx.deployFinishedAt) : Date.now()
  const from = iso(t - 3_600_000), to = iso(t + 3_600_000)
  const q = (s?: string) => (s ?? '').replace(/"/g, '\\"')
  switch (kind) {
    case 'dt_problem':
      return `fetch dt.davis.problems, from: now()-35d\n| filter event.id == "${q(ctx.problemId)}" or display_id == "${q(ctx.problemDisplayId)}"\n| fields display_id, event.name, event.status, event.category, event.start, event.end, root_cause_entity_name, event.description, affected_entity_ids\n| limit 5`
    case 'dt_error_rate':
      return `timeseries { req = sum(dt.service.request.count), fail = sum(dt.service.request.failure_count) }, by: { dt.entity.service }, from: "${from}", to: "${to}", interval: 5m\n| fieldsAdd service.name = entityName(dt.entity.service)\n| filter service.name == "${q(ctx.service)}"`
    case 'dt_latency':
      return `timeseries p95 = percentile(dt.service.request.response_time, 95), by: { dt.entity.service }, from: "${from}", to: "${to}", interval: 5m\n| fieldsAdd service.name = entityName(dt.entity.service)\n| filter service.name == "${q(ctx.service)}"`
    case 'dt_deployment_events':
      return `fetch events, from: now()-35d\n| filter event.kind == "SDLC_EVENT" and vcs.ref.head.revision == "${q(ctx.sha?.replace(/-rb$/, ''))}"\n| fields timestamp, event.status, deployment.environment.name, deployment.status, service.version, event.description\n| sort timestamp asc | limit 20`
    default:
      return undefined
  }
}

/** The search text for the knowledge base: what failed, how it showed, where. */
export const kbQuery = (ctx: InvestigationContext) => [ctx.category, ctx.ruleTitle, ctx.service, ctx.evidenceText].filter(Boolean).join('. ')

export async function fetchEvidence(kind: EvidenceKind, ctx: InvestigationContext, tools: ToolRunner, id: string, traceId?: string): Promise<Evidence> {
  const base = { id, kind, source: KIND_SOURCE[kind], at: new Date().toISOString() }
  const t0 = Date.now()
  const meta = { traceId }
  const dql = dqlFor(kind, ctx)
  let r
  if (dql) r = await tools.op('dql', { query: dql }, meta)
  else if (kind === 'kb_similar') r = await tools.op('kb_search', { query: kbQuery(ctx), productId: ctx.productId, before: ctx.at, exclude: `inc-${ctx.findingId}` }, meta)
  else if (kind === 'argo_app') r = await tools.op('argo_app', { app: ctx.argoApp! }, meta)
  else if (kind === 'gh_pr_files') r = await tools.op('pr_files', { repo: ctx.repo!, prNumber: String(ctx.prNumber) }, meta)
  else if (kind === 'gh_job_log') r = await tools.op('job_log', { repo: ctx.repo!, jobId: ctx.jobId! }, meta)
  else r = await tools.op('k8s_events', { namespace: ctx.namespace! }, meta)
  // tool output is data: strip lines that read like instructions to the model
  const clean = sanitizeToolText(r.ok ? (r.text ?? '') : '')
  const data = cap(clean.text, 4000)
  return {
    ...base, server: r.server, tool: r.tool, args: r.args, ok: r.ok && data.trim().length > 0, ms: Date.now() - t0,
    ...(clean.removed ? { flags: [`injection_removed:${clean.removed}`] } : {}),
    summary: r.ok ? `${KIND_DESCRIPTION[kind]}: ${data.trim() ? `${Math.min(data.length, 4000)} chars returned` : 'empty result'}${clean.removed ? ` (${clean.removed} instruction-like lines removed)` : ''}` : `Not available: ${r.error}`,
    data,
  }
}
