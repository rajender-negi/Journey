import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { gzipSync } from 'node:zlib'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { extname, join, normalize } from 'node:path'
import { buildViewModel, guidanceCatalog, stageFunnel, type AiMode } from '@pj/core'
import { SOURCES, config, type SourceName } from './config'
import { collect, testSource, writeSnapshot } from './collector'
import { store } from './store'
import { brief } from './ai'
import { agent, agentStatus, feedbackSummary, initAgent, knowledgeBase } from './agent'

const WEB_DIST = new URL('../../web/dist/', import.meta.url).pathname
const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' }

// minimal native-shape checks for snapshots pushed by MCP agents
const SHAPE: Record<SourceName, (x: Record<string, unknown>) => boolean> = {
  servicenow: (x) => Array.isArray(x.businessApps) && Array.isArray(x.changes),
  github: (x) => Array.isArray(x.pulls) && Array.isArray(x.jobs) && typeof x.contents === 'object',
  dynatrace: (x) => ['problems', 'sdlcEvents', 'serviceMetrics', 'workloads', 'dora', 'billing'].every((k) => Array.isArray((x[k] as { result?: { records?: unknown } })?.result?.records)),
  argocd: (x) => Array.isArray(x.applications),
  kubernetes: (x) => Array.isArray(x.events),
  aws: (x) => Array.isArray(x.costExplorer),
  azure: (x) => Array.isArray((x.costManagement as { properties?: { rows?: unknown } })?.properties?.rows),
}

// gzip anything over 1 KB when the client accepts it: the view model drops from ~170 KB to ~30 KB
let currentReq: IncomingMessage | undefined
const out = (res: ServerResponse, code: number, type: string, body: string | Buffer, extra: Record<string, string> = {}) => {
  const buf = typeof body === 'string' ? Buffer.from(body) : body
  const gz = buf.length > 1024 && /\bgzip\b/.test(String(currentReq?.headers['accept-encoding'] ?? ''))
  res.writeHead(code, { 'content-type': type, 'access-control-allow-origin': '*', vary: 'accept-encoding', ...(gz ? { 'content-encoding': 'gzip' } : {}), ...extra })
  res.end(gz ? gzipSync(buf) : buf)
}
const send = (res: ServerResponse, code: number, body: unknown) => out(res, code, 'application/json', JSON.stringify(body))
let vmCache: { at: string; json: string } | undefined

const readBody = (req: IncomingMessage) => new Promise<string>((ok, bad) => {
  let s = ''
  req.on('data', (c) => (s += c))
  req.on('end', () => ok(s))
  req.on('error', bad)
})

function scoped(product: string | null) {
  const { analysis: a, status, mixed } = store.get()
  const pid = product && product !== 'all' ? product : 'all'
  const inP = <T extends { productId: string }>(xs: T[]) => (pid === 'all' ? xs : xs.filter((x) => x.productId === pid))
  return { a, pid, inP, status, mixed }
}

async function route(req: IncomingMessage, res: ServerResponse) {
  currentReq = req
  const url = new URL(req.url ?? '/', 'http://x')
  const p = url.pathname
  const product = url.searchParams.get('product')

  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST', 'access-control-allow-headers': 'content-type' })
    return res.end()
  }
  if (p === '/api/health') return send(res, 200, { ok: true, ready: store.ready(), ai: { configured: !!config.ai.apiKey, provider: config.ai.provider, model: config.ai.model } })
  if (!p.startsWith('/api/')) return serveStatic(p, res)
  if (!store.ready()) return send(res, 503, { error: 'collecting' })

  if (p === '/api/sources') {
    const { status, mixed } = store.get()
    return send(res, 200, { status, mixed, warning: mixed ? 'Some sources are dummy while others are live or snapshot: cross-source joins will be partial.' : undefined })
  }
  if (p === '/api/vm') {
    // the single format every client renders; rebuilt only when a new collection lands
    const { analysis, raw, status } = store.get()
    if (vmCache?.at !== analysis.dataset.generatedAt) vmCache = { at: analysis.dataset.generatedAt, json: JSON.stringify({ ...buildViewModel(analysis, { mode: 'live', raw, status }), agent: { enabled: !!agent.runs, llm: agent.llm, mcpServers: agent.servers.filter((x) => x.ok).map((x) => x.name) } }) }
    return out(res, 200, 'application/json', vmCache.json, { 'cache-control': 'no-cache' })
  }
  if (p === '/api/analysis') return send(res, 200, store.get().analysis)
  if (p === '/api/products') return send(res, 200, store.get().analysis.dataset.products)
  if (p === '/api/guidance') return send(res, 200, guidanceCatalog())

  const { a, pid, inP } = scoped(product)
  if (p === '/api/overview') {
    const journeys = inP(a.journeys)
    return send(res, 200, {
      product: pid, dora: a.dora[pid], funnel: stageFunnel(journeys), cost: a.cost[pid],
      openProblems: inP(a.dataset.problems).filter((x) => x.status === 'open'),
      failuresByCategory: Object.entries(inP(a.failures).reduce<Record<string, number>>((m, f) => ((m[f.category] = (m[f.category] ?? 0) + 1), m), {})),
      scorecards: pid === 'all' ? Object.values(a.scorecards) : [a.scorecards[pid]],
    })
  }
  if (p === '/api/journeys') return send(res, 200, inP(a.journeys))
  if (p === '/api/dora') return send(res, 200, a.dora[pid])
  if (p === '/api/failures') return send(res, 200, inP(a.failures))
  if (p === '/api/risks') return send(res, 200, inP(a.risks))
  if (p === '/api/code') return send(res, 200, inP(a.code))
  if (p === '/api/cost') return send(res, 200, a.cost[pid])
  if (p === '/api/scorecards') return send(res, 200, pid === 'all' ? a.scorecards : { [pid]: a.scorecards[pid] })

  const raw = p.match(/^\/api\/raw\/(\w+)$/)
  if (raw && req.method === 'GET') {
    const s = raw[1] as SourceName
    if (!SOURCES.includes(s)) return send(res, 404, { error: 'unknown source' })
    return send(res, 200, store.get().raw[s])
  }
  const ingest = p.match(/^\/api\/ingest\/(\w+)$/)
  if (ingest && req.method === 'POST') {
    const s = ingest[1] as SourceName
    if (!SOURCES.includes(s)) return send(res, 404, { error: 'unknown source' })
    const body = JSON.parse(await readBody(req)) as Record<string, unknown>
    if (!SHAPE[s](body)) return send(res, 422, { error: `payload does not match the native ${s} schema; see fixtures/raw/${s}.json` })
    writeSnapshot(s, body)
    return send(res, 202, { accepted: true, status: await collect() })
  }
  const itest = p.match(/^\/api\/integrations\/(\w+)\/test$/)
  if (itest && req.method === 'POST') {
    const s = itest[1] as SourceName
    if (!SOURCES.includes(s)) return send(res, 404, { error: 'unknown source' })
    return send(res, 200, await testSource(s))
  }
  if (p === '/api/collect' && req.method === 'POST') return send(res, 200, await collect())
  if (p === '/api/ai/brief' && req.method === 'POST') {
    const { mode, target } = JSON.parse(await readBody(req)) as { mode: AiMode; target: string }
    try {
      return send(res, 200, await brief(a, mode, target))
    } catch (e) {
      return send(res, 400, { error: (e as Error).message })
    }
  }
  // ---- agentic investigation (LangGraph + MCP) ----
  if (p === '/api/agent/status') return send(res, 200, await agentStatus())
  if (p === '/api/mcp/tools') return send(res, 200, agent.hub?.tools() ?? {})
  // feedback loop: approve and reject decisions, approval rate overall and per rule
  if (p === '/api/agent/feedback') return send(res, 200, feedbackSummary())
  // RAG: search the knowledge base directly (the agent uses the same search as evidence kb_similar)
  if (p === '/api/kb/search') {
    const kb = await knowledgeBase()
    if (!kb) return send(res, 503, { error: 'knowledge base not built' })
    const q = url.searchParams.get('q') ?? ''
    return send(res, 200, { embedder: kb.embedder.name, docs: kb.docs, chunks: kb.size, hits: await kb.search(q, { k: Number(url.searchParams.get('k') ?? 5), productId: url.searchParams.get('product') ?? undefined }) })
  }
  if (p.startsWith('/api/agent/')) {
    if (!agent.runs || !(await agent.runs.ready())) return send(res, 503, { error: agent.runs?.loadError ?? 'agent not initialised' })
    if (p === '/api/agent/investigate' && req.method === 'POST') {
      const { findingId } = JSON.parse(await readBody(req)) as { findingId: string }
      if (!a.failures.some((f) => f.id === findingId)) return send(res, 404, { error: `finding ${findingId} not found` })
      return send(res, 200, await agent.runs.start(findingId))
    }
    if (p === '/api/agent/runs') return send(res, 200, agent.runs.list())
    const run = p.match(/^\/api\/agent\/runs\/([\w.-]+)(\/resume)?$/)
    if (run && !run[2] && req.method === 'GET') return send(res, 200, await agent.runs.view(run[1]))
    if (run && run[2] && req.method === 'POST') {
      const { decision, by, note } = JSON.parse(await readBody(req)) as { decision: 'approve' | 'reject'; by?: string; note?: string }
      try {
        return send(res, 200, await agent.runs.resume(run[1], decision === 'approve' ? 'approve' : 'reject', by || 'unknown', note))
      } catch (e) {
        return send(res, 409, { error: (e as Error).message })
      }
    }
  }
  return send(res, 404, { error: 'not found' })
}

function serveStatic(p: string, res: ServerResponse) {
  const file = normalize(join(WEB_DIST, p === '/' ? 'index.html' : p))
  const target = file.startsWith(WEB_DIST) && existsSync(file) && statSync(file).isFile() ? file : join(WEB_DIST, 'index.html')
  if (!existsSync(target)) {
    return out(res, 200, 'text/plain', 'API running. Build the web app with: npm run build')
  }
  out(res, 200, TYPES[extname(target)] ?? 'application/octet-stream', readFileSync(target))
}

createServer((req, res) => {
  route(req, res).catch((e) => send(res, 500, { error: (e as Error).message }))
}).listen(config.port, async () => {
  console.log(`product-journey api on http://localhost:${config.port}`)
  await initAgent()
  for (const n of agent.notes) console.log(`agent: ${n}`)
  if (agent.servers.length) console.table(agent.servers)
  const status = await collect()
  console.table(status.map(({ source, tier, ok, records, error }) => ({ source, tier, ok, records, error: error?.slice(0, 60) })))
  setInterval(() => collect().catch((e) => console.error('collect failed', e)), config.collectEveryMin * 60_000)
})
