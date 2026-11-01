// Logical operations the app needs, mapped to MCP tools. MCP servers name their tools differently
// across versions, so each operation lists candidate tool names and the argument shape each expects.
// The first candidate the connected server actually exposes wins. Override per tenant in
// mcp.servers.json under "toolMap".

import type { SourceName } from './types'

export type Op = 'dql' | 'pr_files' | 'job_log' | 'argo_app' | 'argo_apps' | 'k8s_events'

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
}

/** Which configured MCP server serves a source: by explicit "sources" map, else by server name. */
export function serverForSource(source: SourceName, servers: string[], explicit: Partial<Record<SourceName, string>> = {}): string | undefined {
  if (explicit[source] && servers.includes(explicit[source]!)) return explicit[source]
  const re: Record<SourceName, RegExp> = {
    dynatrace: /dynatrace|dt/i, github: /github|gh/i, argocd: /argo/i, kubernetes: /kube|k8s/i,
    servicenow: /servicenow|snow/i, aws: /aws|cost-explorer/i, azure: /azure/i,
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
  if (!c) return { error: `${server} exposes none of: ${spec.candidates.map((x) => x.tool).join(', ')}` }
  return { server, tool: c.tool, args: c.args(params) }
}
