// Agent tests. Pure logic and the full node sequence run everywhere; the LangGraph wiring test
// runs when @langchain/langgraph is installed (npm install) and is skipped otherwise.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { analyze, demoDataset } from '@pj/core'
import {
  buildContext, classify, defaultPlan, gather, hypothesize, initialState, isReadOnlyTool, loadMcpConfig, mayCall, parseJsonLoose, plan,
  recommend, resolveOp, routeAfterVerify, substituteEnv, toDqlResult, verify, verifyHypothesis, type AgentDeps, type AgentLlm, type AgentState, type ToolRunner,
} from '../src/index'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const a = analyze(demoDataset(Date.parse('2026-11-01T03:30:00Z')))
const regression = a.failures.find((f) => f.recommendation.ruleId === 'FX-REGRESSION-SLOW')!
const oom = a.failures.find((f) => f.recommendation.ruleId === 'FX-OOM')!
const compile = a.failures.find((f) => f.recommendation.ruleId === 'FX-COMPILE')!

// MCP stand-in that answers like the real servers (JSON text in a content block)
function fakeTools(fail: string[] = []): ToolRunner & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    async op(op, params) {
      calls.push(op)
      if (fail.includes(op)) return { ok: false, text: '', error: `${op} unavailable` }
      const body: Record<string, unknown> = {
        dql: { records: [{ 'service.name': 'catalog-api', p95: [210000, 220000, 760000, 790000], note: (params.query ?? '').slice(0, 40) }] },
        argo_app: { status: { sync: { status: 'Synced' }, health: { status: 'Degraded', message: 'OOMKilled' } } },
        pr_files: [{ filename: 'src/main/java/com/acme/catalog/ProductService.java', additions: 40, deletions: 3 }],
        job_log: 'error TS2322 at src/pricing/discount.ts(42,7)',
        k8s_events: [{ reason: 'OOMKilled', message: 'Container worker exceeded memory limit 512Mi' }],
      }
      return { ok: true, text: typeof body[op] === 'string' ? (body[op] as string) : JSON.stringify(body[op]), server: 'fake', tool: op, args: params }
    },
  }
}

const deps = (tools: ToolRunner, llm: AgentLlm | null = null, maxIterations = 2): AgentDeps => ({ analysis: () => a, tools, llm, maxIterations })

/** Executes the nodes in the same order and with the same routing as the LangGraph definition. */
async function runWorkflow(findingId: string, d: AgentDeps): Promise<AgentState> {
  let s = initialState(findingId)
  const apply = (p: Partial<AgentState>) => {
    s = { ...s, ...p, evidence: p.evidence ? s.evidence.concat(p.evidence) : s.evidence, log: p.log ? s.log.concat(p.log) : s.log }
  }
  apply(await classify(s, d))
  for (;;) {
    apply(await plan(s, d))
    apply(await gather(s, d))
    apply(await hypothesize(s, d))
    apply(await verify(s))
    if (routeAfterVerify(s, d.maxIterations) === 'recommend') break
  }
  apply(await recommend(s, d))
  return s
}

describe('policy', () => {
  it('treats query tools as read only and blocks writes', () => {
    for (const t of ['execute_dql', 'get_pull_request_files', 'list_applications', 'events_list', 'get_job_logs']) assert.ok(isReadOnlyTool(t), t)
    for (const t of ['create_issue', 'sync_application', 'delete_pod', 'update_record', 'merge_pull_request']) assert.ok(!isReadOnlyTool(t), t)
  })
  it('never writes to Dynatrace, even when allowlisted', () => {
    assert.equal(mayCall('dynatrace', 'send_event', ['dynatrace:send_event']).ok, false)
    assert.equal(mayCall('servicenow', 'add_work_note', ['servicenow:add_work_note']).ok, true)
    assert.equal(mayCall('servicenow', 'add_work_note').ok, false)
  })
  it('parses tool output into Grail result shape', () => {
    assert.deepEqual(parseJsonLoose('Found 1 record:\n[{"a":1}]'), [{ a: 1 }])
    assert.equal(toDqlResult('{"records":[{"x":1},{"x":2}]}', 'q').result.records.length, 2)
    assert.equal(toDqlResult('{"result":{"records":[{"x":1}]}}', 'q').result.records.length, 1)
  })
})

describe('MCP config and tool resolution', () => {
  it('loads Cursor-format config with env substitution and drops disabled servers', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-'))
    const p = join(dir, 'mcp.servers.json')
    writeFileSync(p, JSON.stringify({ mcpServers: { dynatrace: { command: 'npx', env: { DT_PLATFORM_TOKEN: '${env:DT_T}' } }, off: { command: 'x', disabled: true } }, collect: ['dynatrace'] }))
    const cfg = loadMcpConfig(p, { DT_T: 'secret' })!
    assert.deepEqual(Object.keys(cfg.mcpServers), ['dynatrace'])
    assert.equal(cfg.mcpServers.dynatrace.env!.DT_PLATFORM_TOKEN, 'secret')
    assert.equal(substituteEnv('${env:NOPE}', {}), '')
  })
  it('picks the tool the server actually exposes', () => {
    const avail = new Map([['dynatrace-mcp', new Set(['execute_dql', 'list_problems'])], ['gh', new Set(['get_pull_request_files'])]])
    const r = resolveOp('dql', { query: 'fetch logs' }, avail)
    assert.ok(!('error' in r) && r.tool === 'execute_dql' && (r.args as { dqlStatement: string }).dqlStatement === 'fetch logs')
    const pr = resolveOp('pr_files', { repo: 'acme/catalog-api', prNumber: '12' }, avail)
    assert.ok(!('error' in pr) && (pr.args as { owner: string; pullNumber: number }).owner === 'acme')
    assert.ok('error' in resolveOp('argo_app', { app: 'x' }, avail))
  })
})

describe('investigation context and plan', () => {
  it('builds context from the analysis', () => {
    const ctx = buildContext(a, regression.id)
    assert.equal(ctx.ruleId, 'FX-REGRESSION-SLOW')
    assert.ok(ctx.service && ctx.sha && ctx.deployFinishedAt && ctx.prNumber)
    assert.ok(defaultPlan(ctx).some((p) => p.kind === 'dt_latency'))
    const cctx = buildContext(a, compile.id)
    assert.ok(cctx.jobId && defaultPlan(cctx).some((p) => p.kind === 'gh_job_log'))
  })
})

describe('workflow (same routing as the graph)', () => {
  it('confirms a latency regression with runtime evidence', async () => {
    const s = await runWorkflow(regression.id, deps(fakeTools()))
    assert.ok(s.evidence.length >= 4)
    assert.equal(s.verification!.passed, true)
    assert.equal(s.recommendation!.engine, 'rules')
    assert.ok(s.recommendation!.actions.every((x) => x.ruleId === 'FX-REGRESSION-SLOW'))
  })
  it('stops retrying and recommends with low confidence when Dynatrace is unreachable', async () => {
    const t = fakeTools(['dql'])
    const s = await runWorkflow(regression.id, deps(t))
    assert.equal(s.verification!.passed, false)
    assert.ok(s.iterations <= 2)
    assert.ok(s.recommendation)
    assert.ok(s.log.some((l) => l.includes('dql unavailable')))
  })
  it('uses Kubernetes and Argo CD evidence for an OOM', async () => {
    const t = fakeTools()
    const s = await runWorkflow(oom.id, deps(t))
    assert.ok(t.calls.includes('k8s_events') && t.calls.includes('argo_app'))
    assert.equal(s.verification!.passed, true)
  })
  it('rejects an LLM hypothesis that cites missing evidence or invents figures', () => {
    const ctx = buildContext(a, regression.id)
    const ev = [{ id: 'E0', kind: 'analysis' as const, source: 'analysis' as const, ok: true, summary: 's', data: 'p95 210', at: '' }]
    const v = verifyHypothesis(ctx, { rootCause: 'p95 rose to 9999 ms', chain: [{ step: 'x', evidenceIds: ['E7'] }], confidence: 'high', engine: 'llm' }, ev, [])
    assert.equal(v.passed, false)
    assert.ok(v.checks.find((c) => c.name === 'citations exist' && !c.ok))
    assert.ok(v.checks.find((c) => c.name === 'figures grounded' && !c.ok))
  })
  it('fails verification when a step names one source but cites another', () => {
    const ctx = buildContext(a, compile.id)
    const ev = [
      { id: 'E0', kind: 'analysis' as const, source: 'analysis' as const, ok: true, summary: 's', data: 'd', at: '' },
      { id: 'E1', kind: 'gh_job_log' as const, source: 'github' as const, ok: true, summary: 's', data: 'error TS2322', at: '' },
    ]
    const bad = verifyHypothesis(ctx, { rootCause: 'OOM', chain: [{ step: 'Kubernetes events show the container OOMKilled', evidenceIds: ['E1'] }], confidence: 'high', engine: 'llm' }, ev, [])
    assert.equal(bad.passed, false)
    assert.ok(bad.checks.find((c) => c.name === 'citations match claims' && !c.ok))
    const good = verifyHypothesis(ctx, { rootCause: 'type error', chain: [{ step: 'The GitHub job log shows TS2322', evidenceIds: ['E1'] }], confidence: 'high', engine: 'llm' }, ev, [])
    assert.equal(good.passed, true)
  })
  it('drives the LLM path and drops actions citing unknown rules', async () => {
    const llm: AgentLlm = {
      name: 'fake-model',
      async structured<T>(schema: string): Promise<T> {
        if (schema === 'plan') return { items: [{ kind: 'dt_latency', why: 'check p95' }, { kind: 'made_up', why: 'x' }] } as T
        if (schema === 'hypothesis') return { rootCause: 'N+1 query added in ProductService', chain: [{ step: 'p95 jumped after deploy', evidenceIds: ['E1'] }, { step: 'PR changed ProductService', evidenceIds: ['E0'] }], confidence: 'high' } as T
        return { headline: 'Roll back and batch queries', rootCause: 'N+1', impact: 'tier 2 slowdown', evidenceUsed: ['E1'], actions: [{ priority: 1, action: 'Roll back', ruleId: 'FX-REGRESSION-SLOW', horizon: 'now', owner: 'on-call' }, { priority: 2, action: 'invented', ruleId: 'FX-FAKE', horizon: 'now', owner: 'x' }] } as T
      },
    }
    const s = await runWorkflow(regression.id, deps(fakeTools(), llm))
    // model picks add to the rule plan; the invented kind is dropped
    assert.ok(s.plan.some((p) => p.kind === 'dt_latency') && !s.plan.some((p) => p.kind === ('made_up' as never)))
    assert.ok(s.log.some((l) => l.includes('plan (rules + fake-model)')))
    assert.equal(s.hypothesis!.engine, 'llm')
    assert.equal(s.recommendation!.engine, 'llm')
    assert.deepEqual(s.recommendation!.actions.map((x) => x.ruleId), ['FX-REGRESSION-SLOW'])
  })
})

describe('LangGraph wiring (needs npm install)', async () => {
  const lg = await import('@langchain/langgraph').catch(() => null)
  it('pauses for approval and resumes to approved', { skip: !lg && 'install dependencies to run' }, async () => {
    const { AgentRuns } = await import('../src/runs')
    const runs = new AgentRuns(deps(fakeTools()))
    const v = await runs.start(regression.id)
    assert.equal(v.status, 'awaiting_approval')
    assert.ok(v.state!.recommendation)
    const done = await runs.resume(v.id, 'approve', 'rajender', 'ok to roll back')
    assert.equal(done.status, 'approved')
    assert.equal(done.state!.approval!.by, 'rajender')
  })
})

describe('in-browser agent edges (published card)', () => {
  it('answers every failure type from native-schema snapshots and verifies each', async () => {
    const { buildFixtureDataset, emitRawBundle, mapRawBundle } = await import('@pj/core')
    const { snapshotTools } = await import('../src/web-tools')
    const raw = emitRawBundle(buildFixtureDataset(Date.parse('2026-11-01T03:30:00Z')))
    const an = analyze(mapRawBundle(raw))
    const firstPerRule = new Map<string, string>()
    for (const f of an.failures) if (!firstPerRule.has(f.recommendation.ruleId)) firstPerRule.set(f.recommendation.ruleId, f.id)
    assert.ok(firstPerRule.size >= 10)
    for (const [rule, fid] of firstPerRule) {
      const s = await runWorkflow(fid, { analysis: () => an, tools: snapshotTools(raw, an), llm: null, maxIterations: 2 })
      assert.ok(s.evidence.filter((e) => e.ok).length >= 2, `${rule}: runtime evidence returned`)
      assert.ok(s.evidence.filter((e) => e.server).every((e) => e.server === 'snapshot'), `${rule}: labelled as snapshot`)
      assert.equal(s.verification!.passed, true, `${rule}: ${s.verification!.checks.filter((c) => !c.ok).map((c) => c.name)}`)
    }
  })
  it('uses MCP where configured and the loaded data only for sources without a server', async () => {
    const { withSnapshot } = await import('../src/web-tools')
    const snap: ToolRunner = { async op() { return { ok: true, text: '{"records":[1]}', server: 'snapshot', tool: 'x' } } }
    const noServer: ToolRunner = { async op() { return { ok: false, text: '', error: 'no MCP server configured for dynatrace' } } }
    const timedOut: ToolRunner = { async op() { return { ok: false, text: '', error: 'dynatrace-mcp:execute_dql timed out' } } }
    assert.equal((await withSnapshot(noServer, () => snap).op('dql', {})).server, 'snapshot')
    assert.equal((await withSnapshot(null, () => snap).op('dql', {})).server, 'snapshot')
    const real = await withSnapshot(timedOut, () => snap).op('dql', {})
    assert.equal(real.ok, false, 'a real MCP failure is reported, not replaced with snapshot data')
  })
})

describe('Claude via LangChain in the card (needs npm install)', async () => {
  const lc = await import('@langchain/core/language_models/chat_models').catch(() => null)
  it('parses Claude replies through LangChain and the shared zod schema', { skip: !lc && 'install dependencies to run' }, async () => {
    const { langchainClaudeLlm } = await import('../src/web-llm')
    const tiers: string[] = []
    const llm = langchainClaudeLlm(async (_p: string, o?: Record<string, unknown>) => {
      tiers.push(String(o?.modelTier))
      return { text: 'Here you go:\n```json\n{"items":[{"kind":"dt_latency","why":"p95"}]}\n```' }
    })
    assert.equal(llm.name, 'Claude via LangChain')
    assert.deepEqual(await llm.structured('plan', 'sys', 'user'), { items: [{ kind: 'dt_latency', why: 'p95' }] })
    assert.equal(tiers[0], 'quick')
    const denied = langchainClaudeLlm(() => Promise.reject({ code: 'not_granted', message: 'declined' }))
    await assert.rejects(denied.structured('hypothesis', 's', 'u'), /not_granted/)
    const wrong = langchainClaudeLlm(async () => ({ text: '{"chain":"not a list"}' }))
    await assert.rejects(wrong.structured('hypothesis', 's', 'u'), /schema/)
    const s = await runWorkflow(regression.id, deps(fakeTools(), denied))
    assert.equal(s.hypothesis!.engine, 'rules')
    assert.ok(s.log.some((l) => l.includes('not_granted')))
  })
})

describe('LangGraph web graph (needs npm install)', async () => {
  const lg = await import('@langchain/langgraph/web').catch(() => null)
  it('pauses before approval in the browser build and resumes', { skip: !lg && 'install dependencies to run' }, async () => {
    const { createWebAgent } = await import('../src/web')
    const agent = createWebAgent({ now: Date.parse('2026-11-01T03:30:00Z') })
    const fid = agent.findings[0]
    const steps: string[] = []
    const v = await agent.start(fid, (n) => steps.push(n))
    assert.equal(v.status, 'awaiting_approval', v.error ?? '')
    assert.ok(steps.includes('verify') && steps.includes('recommend') && !steps.includes('approve'))
    const done = await agent.resume(v.id, 'approve', 'rajender')
    assert.equal(done.status, 'approved')
    assert.equal(done.state!.approval!.by, 'rajender')
    assert.ok(done.trace!.some((t) => t.name === 'execute_tool kb_search'), 'tool calls are traced')
  })
  it('closes the loop: an approved investigation is found as precedent by the next similar one', { skip: !lg && 'install dependencies to run' }, async () => {
    const { createWebAgent } = await import('../src/web')
    const agent = createWebAgent({ now: Date.parse('2026-11-01T03:30:00Z') })
    const an = analyze(demoDataset(Date.parse('2026-11-01T03:30:00Z')))
    const compiles = an.failures.filter((f) => f.recommendation.ruleId === 'FX-COMPILE').sort((x, y) => x.at.localeCompare(y.at))
    assert.ok(compiles.length >= 2)
    const first = await agent.start(compiles[0].id)
    await agent.resume(first.id, 'approve', 'lead')
    const second = await agent.start(compiles.at(-1)!.id)
    const kbEv = second.state!.evidence!.find((e) => e.kind === 'kb_similar')!
    assert.ok(kbEv.ok)
    const matches = JSON.parse(kbEv.data).matches as { source: string; ref: string }[]
    assert.ok(matches.some((m) => m.source === 'investigation' && m.ref === first.id), JSON.stringify(matches.map((m) => m.source + ':' + m.ref)))
  })
})
