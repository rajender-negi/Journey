// Logical operations the app needs, mapped to MCP tools. MCP servers name their tools differently
// across versions, so each operation lists candidate tool names and the argument shape each expects.
// The first candidate the connected server actually exposes wins. Override per tenant in
// mcp.servers.json under "toolMap".

import type { SourceName } from './types'

export type Op = 'dql' | 'pr_files' | 'job_log' | 'argo_app' | 'argo_apps' | 'k8s_events' | 'kb_search'
  | 'k8s_workload' | 'aws_audit' | 'azure_audit' | 'gcp_audit' | 'security_alerts' | 'vendor_dynatrace' | 'vendor_servicenow' | 'vendor_aws' | 'vendor_azure' | 'vendor_gcp' | 'vendor_k8sgpt' | 'copilot_issue'

export interface ToolCandidate {
  tool: string
  args: (p: Record<string, string>) => Record<string, unknown>
}

export interface OpSpec {
  source: SourceName
  candidates: ToolCandidate[]
}

const ownerRepo = (p: Record<string, string>) => {
  const [owner, repo] = (p.repo ?? '').split('/')
  return { owner, repo }
}

export const DEFAULT_TOOL_MAP: Record<Op, OpSpec> = {
  dql: {
    source: 'dynatrace',
    candidates: [
      { tool: 'execute_dql', args: (p) => ({ dqlStatement: p.query }) },
      { tool: 'run_dql', args: (p) => ({ query: p.query }) },
      { tool: 'dql_query', args: (p) => ({ query: p.query }) },
    ],
  },
  pr_files: {
    source: 'github',
    candidates: [
      { tool: 'get_pull_request_files', args: (p) => ({ ...ownerRepo(p), pullNumber: Number(p.prNumber) }) },
      { tool: 'pull_request_read', args: (p) => ({ ...ownerRepo(p), pullNumber: Number(p.prNumber), method: 'get_files' }) },
    ],
  },
  job_log: {
    source: 'github',
    candidates: [
      { tool: 'get_job_logs', args: (p) => ({ ...ownerRepo(p), job_id: Number(p.jobId), return_content: true, tail_lines: 120 }) },
    ],
  },
  argo_app: {
    source: 'argocd',
    candidates: [
      { tool: 'get_application', args: (p) => ({ applicationName: p.app }) },
      { tool: 'get_app', args: (p) => ({ name: p.app }) },
    ],
  },
  argo_apps: {
    source: 'argocd',
    candidates: [{ tool: 'list_applications', args: () => ({}) }],
  },
  k8s_events: {
    source: 'kubernetes',
    candidates: [
      { tool: 'events_list', args: (p) => ({ namespace: p.namespace }) },
      { tool: 'list_events', args: (p) => ({ namespace: p.namespace }) },
    ],
  },
  // ---- tool names below are the candidates published by each MCP server; confirm with GET /api/mcp/tools
  //      and override per tenant in mcp.servers.json "toolMap" (first match wins) ----
  k8s_workload: {
    source: 'kubernetes',
    candidates: [
      { tool: 'pods_list_in_namespace', args: (p) => ({ namespace: p.namespace }) },
      { tool: 'pods_list', args: (p) => ({ namespace: p.namespace }) },
      { tool: 'list_k8s_resources', args: (p) => ({ kind: 'Pod', api_version: 'v1', namespace: p.namespace, cluster_name: p.cluster ?? '' }) },
    ],
  },
  aws_audit: {
    source: 'aws',
    candidates: [
      { tool: 'lookup_events', args: (p) => ({ start_time: p.from, end_time: p.to, max_results: 50 }) },
      { tool: 'call_aws', args: (p) => ({ cli_command: `aws cloudtrail lookup-events --start-time ${p.from} --end-time ${p.to} --max-results 50` }) },
    ],
  },
  azure_audit: {
    source: 'azure',
    candidates: [
      { tool: 'monitor_activitylog_list', args: (p) => ({ start_time: p.from, end_time: p.to }) },
      { tool: 'call_az', args: (p) => ({ command: `az monitor activity-log list --start-time ${p.from} --end-time ${p.to}` }) },
    ],
  },
  gcp_audit: {
    source: 'gcp',
    candidates: [
      { tool: 'list_log_entries', args: (p) => ({ filter: `logName:"cloudaudit.googleapis.com%2Factivity" AND timestamp>="${p.from}" AND timestamp<="${p.to}"` }) },
      { tool: 'query_logs', args: (p) => ({ query: `logName:"cloudaudit.googleapis.com%2Factivity" timestamp>="${p.from}"` }) },
    ],
  },
  security_alerts: {
    source: 'github',
    candidates: [
      { tool: 'list_code_scanning_alerts', args: (p) => ({ ...ownerRepo(p), state: 'open' }) },
      { tool: 'list_dependabot_alerts', args: (p) => ({ ...ownerRepo(p), state: 'open' }) },
    ],
  },
  vendor_dynatrace: {
    source: 'dynatrace',
    candidates: [
      { tool: 'chat_with_davis_copilot', args: (p) => ({ text: p.question }) },
      { tool: 'davis_copilot_chat', args: (p) => ({ message: p.question }) },
    ],
  },
  vendor_servicenow: {
    source: 'servicenow',
    candidates: [
      { tool: 'now_assist_similar_incidents', args: (p) => ({ query: p.question }) },
      { tool: 'incident_resolution_recommendation', args: (p) => ({ short_description: p.question }) },
    ],
  },
  // AWS DevOps Agent: read its investigation journal through the AWS MCP Server (call_aws runs the CLI command)
  vendor_aws: {
    source: 'aws',
    candidates: [
      { tool: 'call_aws', args: (p) => ({ cli_command: `aws devops-agent list-journal-records --agent-space-id ${p.agentSpace || '$AGENT_SPACE_ID'} --task-id ${p.taskId || '$TASK_ID'}` }) },
      { tool: 'aws___call_aws', args: (p) => ({ cli_command: `aws devops-agent list-journal-records --agent-space-id ${p.agentSpace || '$AGENT_SPACE_ID'} --task-id ${p.taskId || '$TASK_ID'}` }) },
    ],
  },
  // Azure SRE Agent: tools ship inside the Azure MCP Server with the sreagent_ prefix
  vendor_azure: {
    source: 'azure',
    candidates: [
      { tool: 'sreagent_threads_create', args: (p) => ({ agent: p.agent, message: p.question }) },
    ],
  },
  // Gemini Cloud Assist investigation: tool names to confirm for your setup
  vendor_gcp: {
    source: 'gcp',
    candidates: [
      { tool: 'create_investigation', args: (p) => ({ title: p.question.slice(0, 120), description: p.question }) },
      { tool: 'run_investigation', args: (p) => ({ issue: p.question }) },
    ],
  },
  // K8sGPT analyze (JSON results per object); tool names to confirm for your k8sgpt version
  vendor_k8sgpt: {
    source: 'kubernetes',
    candidates: [
      { tool: 'analyze', args: (p) => ({ namespace: p.namespace, explain: true }) },
      { tool: 'k8sgpt_analyze', args: (p) => ({ namespace: p.namespace, explain: true }) },
    ],
  },
  // write: only runs when allowlisted (AGENT_WRITE_ALLOWLIST=github:create_issue) and after a person approves
  copilot_issue: {
    source: 'github',
    candidates: [
      { tool: 'create_issue', args: (p) => ({ ...ownerRepo(p), title: p.title, body: p.body, assignees: ['Copilot'] }) },
    ],
  },
  // served by the app's own knowledge base (RAG), not an MCP server: see rag/index.ts withKnowledge
  kb_search: { source: 'servicenow', candidates: [] },
}

/** Which configured MCP server serves a source: by explicit "sources" map, else by server name. */
export function serverForSource(source: SourceName, servers: string[], explicit: Partial<Record<SourceName, string>> = {}): string | undefined {
  if (explicit[source] && servers.includes(explicit[source]!)) return explicit[source]
  const re: Record<SourceName, RegExp> = {
    dynatrace: /dynatrace|dt/i, github: /github|gh/i, argocd: /argo/i, kubernetes: /kube|k8s/i,
    servicenow: /servicenow|snow/i, aws: /aws|cost-explorer|cloudtrail|cloudwatch|eks/i, azure: /azure|aks/i, gcp: /gcp|google|gke|bigquery|cloud-logging/i,
  }
  return servers.find((s) => re[source].test(s))
}

/** Resolve an operation to a concrete server + tool + args given what each server exposes. */
export function resolveOp(
  op: Op,
  params: Record<string, string>,
  available: Map<string, Set<string>>,
  explicitSources: Partial<Record<SourceName, string>> = {},
  map: Record<Op, OpSpec> = DEFAULT_TOOL_MAP,
): { server: string; tool: string; args: Record<string, unknown> } | { error: string } {
  const spec = map[op]
  const server = serverForSource(spec.source, [...available.keys()], explicitSources)
  if (!server) return { error: `no MCP server configured for ${spec.source}` }
  const tools = available.get(server)!
  const c = spec.candidates.find((x) => tools.has(x.tool))
  if (c) return { server, tool: c.tool, args: c.args(params) }
  // vendor agents often live on a second server for the same source (AWS MCP Server next to the CloudTrail one,
  // Azure MCP Server next to AKS): any configured server that exposes a candidate tool answers
  for (const [other, ts] of available) {
    const alt = spec.candidates.find((x) => ts.has(x.tool))
    if (alt) return { server: other, tool: alt.tool, args: alt.args(params) }
  }
  return { error: `${server} exposes none of: ${spec.candidates.map((x) => x.tool).join(', ')}` }
}
