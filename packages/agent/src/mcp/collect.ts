// Collection tier "mcp": pull raw source payloads through the same MCP servers Cursor uses,
// and shape them exactly like the direct APIs return them so the core mappers are unchanged.
// Covers the sources whose MCP tools return machine-readable data: Dynatrace (DQL) and Argo CD.
// Others stay on direct API, snapshot or dummy tiers.

import { DQL, type RawBundle } from '@pj/core'
import type { McpHub } from './hub'
import { parseJsonLoose, toDqlResult } from '../policy'

export async function collectDynatraceViaMcp(hub: McpHub): Promise<RawBundle['dynatrace']> {
  const run = async (q: string) => {
    const r = await hub.op('dql', { query: q })
    if (!r.ok) throw new Error(`DQL via MCP failed: ${r.error}`)
    return toDqlResult(r.text, q)
  }
  const [problems, sdlcEvents, serviceMetrics, workloads, dora, billing] = await Promise.all([
    run(DQL.problems), run(DQL.sdlcEvents), run(DQL.serviceMetrics), run(DQL.workloads), run(DQL.dora), run(DQL.billing),
  ])
  return { problems, sdlcEvents, serviceMetrics, workloads, dora, billing }
}

export async function collectArgoViaMcp(hub: McpHub): Promise<RawBundle['argocd']> {
  const r = await hub.op('argo_apps', {})
  if (!r.ok) throw new Error(`Argo CD via MCP failed: ${r.error}`)
  const v = parseJsonLoose(r.text) as { items?: unknown[] } | unknown[] | undefined
  const items = Array.isArray(v) ? v : v?.items
  if (!Array.isArray(items)) throw new Error('Argo CD MCP returned no application list')
  return { applications: items as RawBundle['argocd']['applications'] }
}

export const MCP_COLLECTORS = {
  dynatrace: collectDynatraceViaMcp,
  argocd: collectArgoViaMcp,
} as const
