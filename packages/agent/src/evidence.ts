// Turns a finding into an investigation context, chooses default evidence per failure rule,
// and fetches each evidence kind through MCP with parameters taken from the analysis.
// Queries are templates filled from known facts: the model never writes a free-form query.

import type { Analysis } from '@pj/core'
import type { Op } from './toolmap'
import type { Evidence, EvidenceKind, InvestigationContext, PlanItem, SourceName } from './types'
import { cap } from './policy'
import { sanitizeToolText } from './guard'
import { extractClaim, VENDOR_AGENTS } from './vendors'

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
    clouds: [...new Set(ds.costs.filter((c) => c.productId === f.productId && (c.provider === 'aws' || c.provider === 'azure' || c.provider === 'gcp')).map((c) => c.provider as 'aws' | 'azure' | 'gcp'))],
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
  'FX-REGRESSION-SLOW': ['dt_problem', 'dt_latency', 'dt_traces', 'dt_deployment_events', 'gh_pr_files', 'vendor_assessment', 'kb_similar'],
  'FX-REGRESSION-ERRORS': ['dt_problem', 'dt_error_rate', 'dt_logs', 'dt_traces', 'dt_deployment_events', 'gh_pr_files', 'vendor_assessment', 'kb_similar'],
  'FX-OOM': ['k8s_events', 'k8s_workload', 'argo_app', 'dt_deployment_events', 'vendor_assessment', 'kb_similar'],
  'FX-CRASHLOOP': ['k8s_events', 'k8s_workload', 'dt_logs', 'argo_app', 'gh_pr_files', 'vendor_assessment', 'kb_similar'],
  'FX-CONFIG-MISSING': ['k8s_events', 'dt_logs', 'argo_app', 'gh_pr_files', 'cloud_changes', 'vendor_assessment', 'kb_similar'],
  'FX-IMAGE-PULL': ['k8s_events', 'k8s_workload', 'argo_app', 'vendor_assessment', 'kb_similar'],
  'FX-READINESS': ['k8s_events', 'k8s_workload', 'dt_logs', 'argo_app', 'dt_error_rate', 'vendor_assessment', 'kb_similar'],
  'FX-DB-MIGRATION': ['argo_app', 'gh_pr_files', 'dt_logs', 'dt_deployment_events', 'vendor_assessment', 'kb_similar'],
  'FX-COMPILE': ['gh_job_log', 'gh_pr_files', 'kb_similar'],
  'FX-FLAKY-TEST': ['gh_job_log', 'kb_similar'],
  'FX-VULN-GATE': ['gh_job_log', 'gh_pr_files', 'security_findings', 'kb_similar'],
  'FX-CHANGE-WAIT': ['dt_deployment_events', 'kb_similar'],
  // a problem with no deployment behind it: the runtime record itself is the evidence
  'FX-NON-CHANGE': ['dt_problem', 'cloud_changes', 'dt_logs', 'dt_error_rate', 'dt_latency', 'k8s_events', 'vendor_assessment', 'kb_similar'],
}

export const KIND_SOURCE: Record<EvidenceKind, SourceName> = {
  kb_similar: 'servicenow',
  dt_logs: 'dynatrace', dt_traces: 'dynatrace', k8s_workload: 'kubernetes', cloud_changes: 'aws', security_findings: 'dynatrace', vendor_assessment: 'dynatrace',
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
  dt_logs: 'Dynatrace error and warning logs for the service, 1h before to 1h after',
  dt_traces: 'Dynatrace failed and slowest spans for the service, 1h before to 1h after',
  k8s_workload: 'Pod, container and node state in the namespace (restarts, termination reasons, memory vs limit)',
  cloud_changes: 'Cloud audit logs (CloudTrail, Azure Activity Log, Cloud Audit Logs): who changed what before the failure',
  security_findings: 'Open vulnerabilities for the service (runtime vulnerability analytics, code scanning, Dependabot)',
  vendor_assessment: "Vendor agents' own assessment (Dynatrace Intelligence, Now Assist, AWS DevOps Agent, Azure SRE Agent, Gemini Cloud Assist, K8sGPT): opinions, used only when raw data backs them",
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
    case 'dt_logs': case 'dt_traces': return !!((ctx.service || ctx.namespace) && ctx.deployFinishedAt)
    case 'k8s_workload': return !!ctx.namespace
    case 'cloud_changes': return !!(ctx.clouds?.length && (ctx.deployFinishedAt || ctx.at))
    case 'security_findings': return !!(ctx.service || ctx.repo)
    case 'vendor_assessment': return true
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
    case 'dt_logs':
      return `fetch logs, from: "${from}", to: "${to}"\n| filter service.name == "${q(ctx.service)}" or k8s.namespace.name == "${q(ctx.namespace)}"\n| filter loglevel == "ERROR" or loglevel == "WARN"\n| fields timestamp, loglevel, content, service.name, k8s.namespace.name, k8s.pod.name, k8s.container.name\n| sort timestamp desc | limit 50`
    case 'dt_traces':
      return `fetch spans, from: "${from}", to: "${to}"\n| filter service.name == "${q(ctx.service)}"\n| filter request.is_failed == true or duration > 1s\n| fields start_time, trace.id, span.name, duration, http.response.status_code, db.statement, service.name\n| sort duration desc | limit 30`
    case 'k8s_workload':
      return `timeseries { restarts = sum(dt.kubernetes.container.restarts), memory = max(dt.kubernetes.container.memory_working_set), limit = max(dt.kubernetes.container.limits_memory) }, by: { k8s.cluster.name, k8s.namespace.name, k8s.workload.name, k8s.pod.name, k8s.container.name, k8s.node.name }, from: "${from}", to: "${to}", filter: k8s.namespace.name == "${q(ctx.namespace)}"`
    case 'security_findings':
      return `fetch security.events, from: now()-30d\n| filter event.type == "VULNERABILITY_STATE_REPORT_EVENT" and vulnerability.resolution.status == "OPEN"\n| filter affected_entity.name == "${q(ctx.service)}"\n| fields vulnerability.display_id, vulnerability.title, vulnerability.risk.level, vulnerability.references.cve, component.name, component.version, affected_entity.name\n| limit 20`
    default:
      return undefined
  }
}

const safeJson = (t: string) => { try { return JSON.parse(t) } catch { return t } }

/** The search text for the knowledge base: what failed, how it showed, where. */
export const kbQuery = (ctx: InvestigationContext) => [ctx.category, ctx.ruleTitle, ctx.service, ctx.evidenceText].filter(Boolean).join('. ')

export async function fetchEvidence(kind: EvidenceKind, ctx: InvestigationContext, tools: ToolRunner, id: string, traceId?: string): Promise<Evidence> {
  const base = { id, kind, source: kind === 'cloud_changes' ? (ctx.clouds?.[0] ?? 'aws') : KIND_SOURCE[kind], at: new Date().toISOString() }
  const t0 = Date.now()
  const meta = { traceId }
  const t = ctx.deployFinishedAt ? Date.parse(ctx.deployFinishedAt) : Date.parse(ctx.at)
  const window = { from: new Date(t - 3_600_000).toISOString(), to: new Date(t + 3_600_000).toISOString() }
  const dql = dqlFor(kind, ctx)
  type R = Awaited<ReturnType<ToolRunner['op']>>
  /** first path that returns data wins (Dynatrace first, then the tool's own MCP server) */
  const firstOk = async (attempts: [Op, Record<string, string>][]): Promise<R> => {
    let last: R = { ok: false, text: '', error: 'no path configured' }
    for (const [op, params] of attempts) {
      const res = await tools.op(op, params, meta)
      if (res.ok && (res.text ?? '').trim()) return res
      last = res.ok ? { ...res, ok: false, error: `${op}: empty result` } : res
    }
    return last
  }
  /** several sources answer together (one audit log per cloud, one assessment per vendor agent) */
  const merged = async (attempts: [string, Op, Record<string, string>][]): Promise<R> => {
    const got = await Promise.all(attempts.map(async ([label, op, params]) => [label, await tools.op(op, params, meta)] as const))
    const ok = got.filter(([, res]) => res.ok && (res.text ?? '').trim())
    if (!ok.length) return { ok: false, text: '', error: got.map(([l, res]) => `${l}: ${res.error ?? 'empty'}`).join('; ') }
    return { ok: true, text: JSON.stringify(Object.fromEntries(ok.map(([l, res]) => [l, safeJson(res.text)])), null, 1), server: [...new Set(ok.map(([, res]) => res.server))].join('+'), tool: [...new Set(ok.map(([, res]) => res.tool))].join('+') }
  }
  let r: R
  if (kind === 'k8s_workload') r = await firstOk([['dql', { query: dql! }], ['k8s_workload', { namespace: ctx.namespace! }]])
  else if (kind === 'security_findings') r = await firstOk([['dql', { query: dql! }], ...(ctx.repo ? [['security_alerts', { repo: ctx.repo }] as [Op, Record<string, string>]] : [])])
  else if (kind === 'cloud_changes') r = await merged((ctx.clouds ?? []).map((c) => [c, `${c}_audit` as Op, { ...window, productId: ctx.productId, service: ctx.service ?? '' }]))
  else if (dql) r = await tools.op('dql', { query: dql }, meta)
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

/** Asks each vendor agent that applies to this failure, in parallel. One evidence item per agent that answered. */
export async function fetchVendorEvidence(ctx: InvestigationContext, tools: ToolRunner, traceId?: string): Promise<Evidence[]> {
  const question = `${ctx.category} on ${ctx.productName} (${ctx.service ?? ctx.namespace ?? ''}) at ${ctx.at}: ${ctx.evidenceText.slice(0, 300)}. What is the root cause and the fix?`
  const params = { question, problemId: ctx.problemDisplayId ?? '', namespace: ctx.namespace ?? '', productId: ctx.productId, service: ctx.service ?? '', at: ctx.at, agent: ctx.productId.toLowerCase() }
  const agents = VENDOR_AGENTS.filter((a) => a.when(ctx))
  return Promise.all(agents.map(async (agent): Promise<Evidence> => {
    const t0 = Date.now()
    const r = await tools.op(agent.op, params, { traceId })
    const clean = sanitizeToolText(r.ok ? (r.text ?? '') : '')
    const claim = r.ok ? extractClaim(agent, safeJson(clean.text)) : null
    return {
      id: '', kind: 'vendor_assessment', source: agent.source, server: r.server, tool: r.tool, args: r.args, at: new Date().toISOString(), ms: Date.now() - t0,
      ok: !!claim, data: cap(clean.text, 4000), ...(claim ? { claim } : {}),
      ...(clean.removed ? { flags: [`injection_removed:${clean.removed}`] } : {}),
      summary: claim ? `${agent.name} says: ${claim.cause.slice(0, 160)}` : `${agent.name}: ${r.ok ? 'no root cause in the answer' : `not available: ${r.error}`}`,
    }
  }))
}

/** The GitHub issue handed to the Copilot coding agent after a person approves (title and body only; Copilot writes the PR). */
export function copilotIssue(ctx: InvestigationContext, rec: { headline: string; rootCause: string; actions: { action: string; ruleId: string; horizon: string }[]; designFix?: { name: string; solution: string; codeFindings: { ruleId: string; title: string; file?: string }[] } | null }, runId: string) {
  const fix = rec.designFix
  return {
    repo: ctx.repo ?? '',
    title: `[Product Journey] ${rec.headline}`.slice(0, 120),
    body: [`Approved investigation ${runId} for ${ctx.productName} (${ctx.ruleId}).`, '', `Root cause: ${rec.rootCause}`, '', 'Do in code (the fix-now steps that are operations stay with on-call):',
      ...rec.actions.filter((a) => a.horizon !== 'now').map((a) => `- [ ] ${a.action} (${a.ruleId})`),
      ...(fix ? ['', `Design fix: ${fix.name}. ${fix.solution}`, ...fix.codeFindings.map((c) => `- [ ] ${c.title}${c.file ? ` in ${c.file}` : ''} (${c.ruleId})`)] : []), '', 'Open a draft pull request; a person reviews before merge.'].join('\n'),
  }
}
