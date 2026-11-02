// Phase 1: signal capture. Builds one RawBundle from four tiers per source:
//   1. live API (credentials present)
//   2. live MCP: the app's own MCP client calls your MCP servers (mcp.servers.json, "collect": [...])
//   3. MCP snapshot pushed by a Cursor agent (data/inbox/<source>.json or POST /api/ingest/<source>)
//   4. dummy data in the same native schema
// then maps it with the same core mappers regardless of tier.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { RawBundle } from '@pj/core'
import { analyze, buildFixtureDataset, emitRawBundle, mapProducts, mapRawBundle } from '@pj/core'
import { SOURCES, config, isLive, type SourceName } from './config'
import { fetchServiceNow } from './adapters/servicenow'
import { fetchGitHub } from './adapters/github'
import { fetchDynatrace } from './adapters/dynatrace'
import { fetchArgo, fetchAws, fetchAzure, fetchGcp, fetchK8s } from './adapters/platform'
import { store } from './store'
import { MCP_COLLECTORS, serverForSource } from '@pj/agent'
import { INTEGRATIONS } from '@pj/core'
import { agent } from './agent'

export type Tier = 'live' | 'mcp' | 'mcp-snapshot' | 'dummy'
export interface SourceStatus { source: SourceName; tier: Tier; ok: boolean; at: string; error?: string; records: number }

const inbox = () => join(config.dataDir, 'inbox')

function readSnapshot<K extends SourceName>(s: K): RawBundle[K] | undefined {
  const f = join(inbox(), `${s}.json`)
  return existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as RawBundle[K]) : undefined
}

export function writeSnapshot(s: SourceName, payload: unknown) {
  mkdirSync(inbox(), { recursive: true })
  writeFileSync(join(inbox(), `${s}.json`), JSON.stringify(payload, null, 2))
}

const count = (x: unknown): number => {
  if (Array.isArray(x)) {
    // AWS: count cost line items, not environment calls
    if (x.length && (x[0] as { byService?: unknown }).byService) return x.reduce((a, e) => a + (e.byService.ResultsByTime as { Groups: unknown[] }[]).reduce((b, t) => b + t.Groups.length, 0), 0)
    return x.length
  }
  if (x && typeof x === 'object') {
    const o = x as Record<string, unknown>
    if (o.result && typeof o.result === 'object' && Array.isArray((o.result as { records?: unknown[] }).records)) return (o.result as { records: unknown[] }).records.length
    return Object.values(o).reduce<number>((a, v) => a + count(v), 0)
  }
  return 0
}

export async function collect(): Promise<SourceStatus[]> {
  const dummy = emitRawBundle(buildFixtureDataset(Date.now()))
  const status: SourceStatus[] = []
  const raw = { meta: { generatedAt: new Date().toISOString(), windowDays: config.windowDays } } as RawBundle

  const resolve = async <K extends SourceName>(s: K, live: () => Promise<RawBundle[K]>) => {
    const at = new Date().toISOString()
    if (isLive(s)) {
      try {
        const v = await live()
        raw[s] = v as RawBundle[K]
        status.push({ source: s, tier: 'live', ok: true, at, records: count(v) })
        return
      } catch (e) {
        status.push({ source: s, tier: 'live', ok: false, at, error: (e as Error).message, records: 0 })
      }
    }
    const viaMcp = (MCP_COLLECTORS as Record<string, (h: NonNullable<typeof agent.hub>) => Promise<unknown>>)[s]
    if (config.mode !== 'demo' && agent.hub && viaMcp && agent.hub.collectSources.includes(s)) {
      try {
        const v = (await viaMcp(agent.hub)) as RawBundle[K]
        raw[s] = v
        const prev = status.find((x) => x.source === s)
        if (prev) Object.assign(prev, { tier: 'mcp', ok: true, records: count(v), error: undefined })
        else status.push({ source: s, tier: 'mcp', ok: true, at, records: count(v) })
        return
      } catch (e) {
        const prev = status.find((x) => x.source === s)
        const error = (prev?.error ? `${prev.error}; ` : '') + `MCP: ${(e as Error).message}`
        if (prev) Object.assign(prev, { ok: false, error })
        else status.push({ source: s, tier: 'mcp', ok: false, at, error, records: 0 })
      }
    }
    const snap = config.mode === 'demo' ? undefined : readSnapshot(s)
    if (snap) {
      raw[s] = snap as RawBundle[K]
      const prev = status.find((x) => x.source === s)
      if (prev) Object.assign(prev, { tier: 'mcp-snapshot', ok: true, records: count(snap) })
      else status.push({ source: s, tier: 'mcp-snapshot', ok: true, at, records: count(snap) })
      return
    }
    raw[s] = dummy[s] as RawBundle[K]
    const prev = status.find((x) => x.source === s)
    if (prev) Object.assign(prev, { tier: 'dummy', records: count(dummy[s]) })
    else status.push({ source: s, tier: 'dummy', ok: true, at, records: count(dummy[s]) })
  }

  // CMDB first: every other adapter is scoped by the products it defines
  await resolve('servicenow', () => fetchServiceNow(config.windowDays))
  const products = mapProducts(raw.servicenow.businessApps)
  await Promise.all([
    resolve('github', () => fetchGitHub(products.flatMap((p) => p.repos), config.windowDays)),
    resolve('dynatrace', () => fetchDynatrace()),
    resolve('argocd', () => fetchArgo()),
    resolve('kubernetes', () => fetchK8s(products.flatMap((p) => p.k8sNamespaces))),
    resolve('aws', () => fetchAws()),
    resolve('azure', () => fetchAzure()),
    resolve('gcp', () => fetchGcp()),
  ])

  // a dummy source joined to live products would produce nonsense joins; say so in status
  const tiers = new Set(status.map((s) => s.tier))
  const mixed = tiers.has('dummy') && (tiers.has('live') || tiers.has('mcp-snapshot'))

  const ds = mapRawBundle(raw)
  store.set({ analysis: analyze(ds), raw, status: SOURCES.map((s) => status.find((x) => x.source === s)!), mixed })
  mkdirSync(config.dataDir, { recursive: true })
  writeFileSync(join(config.dataDir, 'latest-raw.json'), JSON.stringify(raw))
  return status
}


/** Connection test for the Integrations screen: tries the direct API and the MCP route without changing loaded data. */
export async function testSource(s: SourceName) {
  const spec = INTEGRATIONS.find((i) => i.id === s)!
  const out: { source: SourceName; rest?: { ok: boolean; records?: number; error?: string }; mcp?: { server?: string; ok: boolean; toolsFound?: string[]; toolsMissing?: string[]; records?: number; error?: string }; hint?: string } = { source: s }
  const products = store.ready() ? store.get().analysis.dataset.products : []
  const live: Record<SourceName, () => Promise<unknown>> = {
    servicenow: () => fetchServiceNow(config.windowDays),
    github: () => fetchGitHub(products.flatMap((p) => p.repos).slice(0, 1), 3),
    dynatrace: () => fetchDynatrace(),
    argocd: () => fetchArgo(),
    kubernetes: () => fetchK8s(products.flatMap((p) => p.k8sNamespaces)),
    aws: () => fetchAws(),
    azure: () => fetchAzure(),
    gcp: () => fetchGcp(),
  }
  if (isLive(s)) {
    try { out.rest = { ok: true, records: count(await live[s]()) } } catch (e) { out.rest = { ok: false, error: (e as Error).message.slice(0, 300) } }
  }
  if (agent.hub) {
    const tools = agent.hub.tools()
    const server = serverForSource(s, Object.keys(tools), agent.hub.sources)
    if (server) {
      const have = new Set(tools[server])
      const expected = spec.mcpTools ?? []
      out.mcp = { server, ok: expected.every((t) => have.has(t)), toolsFound: expected.filter((t) => have.has(t)), toolsMissing: expected.filter((t) => !have.has(t)) }
      const viaMcp = (MCP_COLLECTORS as Record<string, (h: NonNullable<typeof agent.hub>) => Promise<unknown>>)[s]
      if (viaMcp) {
        try { out.mcp.records = count(await viaMcp(agent.hub)) } catch (e) { out.mcp.ok = false; out.mcp.error = (e as Error).message.slice(0, 300) }
      }
    }
  }
  if (!out.rest && !out.mcp) out.hint = `Not configured. Set ${spec.env.join(', ')} in .env${spec.mcpTools ? `, or add an MCP server for ${spec.name} to mcp.servers.json` : ''}, or push a snapshot to POST /api/ingest/${s}.`
  return out
}
