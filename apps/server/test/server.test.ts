// End-to-end: boots the API in dummy mode, exercises every endpoint, pushes an MCP snapshot
// through /api/ingest, and proves the LLM path against a local OpenAI-compatible mock.
import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildFixtureDataset, emitRawBundle } from '@pj/core'

const PORT = 18787
const MOCK = 18788
const base = `http://127.0.0.1:${PORT}`
let api: ChildProcess
let mock: Server
let lastPrompt = ''
const dataDir = mkdtempSync(join(tmpdir(), 'pj-'))

const j = async (path: string, init?: RequestInit) => {
  const r = await fetch(base + path, init)
  return { status: r.status, body: await r.json() }
}

before(async () => {
  // OpenAI-compatible mock that answers with a valid brief citing a rule from the prompt
  mock = createServer((req, res) => {
    let s = ''
    req.on('data', (c) => (s += c))
    req.on('end', () => {
      lastPrompt = s
      const rule = s.match(/FX-[A-Z-]+/)?.[0] ?? 'FX-COMPILE'
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ headline: 'Mock model headline', rootCause: 'rc', impact: 'im', evidenceUsed: ['x'], actions: [{ priority: 1, action: 'do it', ruleId: rule, horizon: 'now', owner: 'team' }, { priority: 2, action: 'invented', ruleId: 'FX-INVENTED', horizon: 'now', owner: 'x' }] }) } }] }))
    })
  }).listen(MOCK)

  api = spawn(process.execPath, ['--import', 'tsx', 'apps/server/src/index.ts'], {
    env: { ...process.env, PORT: String(PORT), PJ_DATA_DIR: dataDir, AI_PROVIDER: 'openai-compatible', AI_BASE_URL: `http://127.0.0.1:${MOCK}`, AI_API_KEY: 'test', AI_MODEL: 'mock', AI_TIMEOUT_MS: '5000' },
    stdio: 'pipe',
  })
  for (let i = 0; i < 100; i++) {
    try {
      const h = await j('/api/health')
      if (h.body.ready) return
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error('server did not start')
})

after(() => {
  api.kill()
  mock.close()
})

describe('API', () => {
  it('reports every source on the dummy tier when nothing is configured', async () => {
    const { body } = await j('/api/sources')
    assert.equal(body.status.length, 7)
    assert.ok(body.status.every((s: { tier: string }) => s.tier === 'dummy'))
  })
  it('serves all six phases', async () => {
    assert.equal((await j('/api/products')).body.length, 5)
    const ov = (await j('/api/overview?product=BA0001')).body
    assert.equal(ov.funnel.length, 8)
    assert.ok((await j('/api/journeys?product=BA0003')).body.length > 0)
    assert.ok((await j('/api/failures')).body.length > 0)
    assert.ok((await j('/api/code?product=BA0003')).body.some((c: { ruleId: string }) => c.ruleId === 'ARCH-CACHE-ASIDE'))
    assert.ok((await j('/api/cost')).body.savingsPotentialUsd > 0)
    assert.equal((await j('/api/guidance')).body.length, 6)
  })
  it('serves the view model gzipped and the UI shell', async () => {
    const r = await fetch(base + '/api/vm', { headers: { 'accept-encoding': 'gzip' } })
    assert.equal(r.headers.get('content-encoding'), 'gzip')
    const vm = await r.json()
    assert.equal(vm.v, 1)
    assert.equal(vm.mode, 'live')
    assert.equal(vm.products.length, 5)
    assert.ok(vm.journeys.length > 0 && vm.scopes.all.dora)
    const html = await (await fetch(base + '/')).text()
    assert.ok(html.includes('id="app"') && !html.includes('window.VM='))
  })
  it('exposes raw native payloads', async () => {
    const dt = (await j('/api/raw/dynatrace')).body
    assert.equal(dt.problems.state, 'SUCCEEDED')
  })
  it('rejects a snapshot that is not in the native schema', async () => {
    const r = await j('/api/ingest/dynatrace', { method: 'POST', body: JSON.stringify({ problems: [] }) })
    assert.equal(r.status, 422)
  })
  it('accepts an MCP snapshot and switches that source to the snapshot tier', async () => {
    const raw = emitRawBundle(buildFixtureDataset(Date.now(), 7))
    const r = await j('/api/ingest/argocd', { method: 'POST', body: JSON.stringify(raw.argocd) })
    assert.equal(r.status, 202)
    const tiers = Object.fromEntries((await j('/api/sources')).body.status.map((s: { source: string; tier: string }) => [s.source, s.tier]))
    assert.equal(tiers.argocd, 'mcp-snapshot')
    assert.ok(readFileSync(join(dataDir, 'inbox', 'argocd.json'), 'utf8').includes('applications'))
  })
  it('runs the LLM path and drops actions citing rules not in evidence', async () => {
    const failures = (await j('/api/failures')).body
    const r = await j('/api/ai/brief', { method: 'POST', body: JSON.stringify({ mode: 'finding', target: failures[0].id }) })
    assert.equal(r.body.engine, 'llm')
    assert.equal(r.body.output.headline, 'Mock model headline')
    assert.equal(r.body.output.actions.length, 1)
    assert.ok(lastPrompt.includes('Evidence pack'))
  })
  it('reports agent status and runs an investigation when LangGraph is installed', { timeout: 120000 }, async () => {
    const st = (await j('/api/agent/status')).body
    assert.equal(typeof st.langgraph, 'boolean')
    assert.ok(Array.isArray(st.notes))
    const failures = (await j('/api/failures')).body as { id: string; recommendation: { ruleId: string } }[]
    const target = failures.find((f) => f.recommendation.ruleId === 'FX-REGRESSION-SLOW') ?? failures[0]
    const r = await j('/api/agent/investigate', { method: 'POST', body: JSON.stringify({ findingId: target.id }) })
    if (!st.langgraph) {
      assert.equal(r.status, 503)
      assert.match(r.body.error, /npm install/)
      return
    }
    assert.equal(r.body.status, 'awaiting_approval')
    assert.ok(r.body.state.evidence.length >= 1 && r.body.state.recommendation)
    const done = await j(`/api/agent/runs/${r.body.id}/resume`, { method: 'POST', body: JSON.stringify({ decision: 'approve', by: 'test' }) })
    assert.equal(done.body.status, 'approved')
  })
  it('portfolio brief works', async () => {
    const r = await j('/api/ai/brief', { method: 'POST', body: JSON.stringify({ mode: 'portfolio', target: 'all' }) })
    assert.ok(r.body.output.headline)
  })
})
