// The same investigation graph, running in a browser page (the published card in the Claude app).
// Same pure nodes as the server (nodes.ts). Differences, all at the edges:
//   - LangGraph's web entry point (no Node async_hooks), so approval uses interruptBefore + updateState
//     instead of interrupt(); the run still pauses, checkpointed, until a person decides.
//   - Evidence comes from a snapshot ToolRunner that answers the same operations (dql, argo_app,
//     pr_files, job_log, k8s_events) from native-schema records: Grail DQL results, Argo CD
//     Applications, core/v1 Events, GitHub REST. In the card that is the demo bundle; a page could
//     equally feed it MCP output pasted from Cursor.
//   - The model is Claude in the Claude app (artifact `sample` capability) wrapped as a LangChain
//     chat model (web-llm.ts), with the same zod schemas as the server: no API key in the page.
// Built with esbuild into apps/web/dist-demo/agent.js and exposed as window.PJAgent.

import { Annotation, END, MemorySaver, START, StateGraph } from '@langchain/langgraph/web'
import { analyze, buildFixtureDataset, buildViewModel, emitRawBundle, mapRawBundle, withSourcesOff, type Analysis, type SourceKey } from '@pj/core'
import { classify, gather, hypothesize, plan, recommend, routeAfterVerify, verify, type AgentDeps, type AgentState } from './nodes'
import type { Approval, Evidence, Hypothesis, InvestigationContext, PlanItem, Recommendation, Verification } from './types'
import { snapshotTools } from './web-tools'
import { buildKnowledgeBase, withKnowledge, type KnowledgeBase } from './rag'
import { newTraceId, Tracer, tracedLlm, tracedTools, traceSummary } from './trace'
import { copilotIssue } from './evidence'
import { langchainClaudeLlm, type SampleText } from './web-llm'

// ---------- the graph (web entry point) ----------

const last = <T>() => Annotation<T>({ reducer: (_a: T, b: T) => b, default: () => null as T })
type Decision = { decision: 'approve' | 'reject'; by: string; note?: string }

const WebState = Annotation.Root({
  findingId: Annotation<string>(),
  traceId: Annotation<string>({ reducer: (_a: string, b: string) => b, default: () => '' }),
  context: last<InvestigationContext | null>(),
  plan: Annotation<PlanItem[]>({ reducer: (_a: PlanItem[], b: PlanItem[]) => b, default: () => [] }),
  evidence: Annotation<Evidence[]>({ reducer: (a: Evidence[], b: Evidence[]) => a.concat(b), default: () => [] }),
  hypothesis: last<Hypothesis | null>(),
  verification: last<Verification | null>(),
  recommendation: last<Recommendation | null>(),
  iterations: Annotation<number>({ reducer: (_a: number, b: number) => b, default: () => 0 }),
  decision: last<Decision | null>(),
  approval: last<Approval | null>(),
  log: Annotation<string[]>({ reducer: (a: string[], b: string[]) => a.concat(b), default: () => [] }),
})
type WS = typeof WebState.State

export function buildWebGraph(deps: AgentDeps) {
  const S = (s: WS) => s as unknown as AgentState
  const T = <R>(name: string, fn: (s: WS) => Promise<R>) => (s: WS) => (deps.tracer ? deps.tracer.step(s.traceId || undefined, name, () => fn(s)) : fn(s))
  const approve = async (s: WS) => {
    const d = s.decision ?? { decision: 'reject' as const, by: 'unknown' }
    const approval: Approval = { decision: d.decision === 'approve' ? 'approve' : 'reject', by: d.by, note: d.note, at: new Date().toISOString() }
    return { approval, log: [`${approval.at.slice(11, 19)} ${approval.decision === 'approve' ? 'approved' : 'rejected'} by ${approval.by}${approval.note ? `: ${approval.note}` : ''}`] }
  }
  return new StateGraph(WebState)
    .addNode('classify', T('classify', (s: WS) => classify(S(s), deps)))
    .addNode('plan_evidence', T('plan_evidence', (s: WS) => plan(S(s), deps)))
    .addNode('gather', T('gather', (s: WS) => gather(S(s), deps)))
    .addNode('hypothesize', T('hypothesize', (s: WS) => hypothesize(S(s), deps)))
    .addNode('verify', T('verify', (s: WS) => verify(S(s))))
    .addNode('recommend', T('recommend', (s: WS) => recommend(S(s), deps)))
    .addNode('approve', T('approve', approve))
    .addEdge(START, 'classify')
    .addEdge('classify', 'plan_evidence')
    .addEdge('plan_evidence', 'gather')
    .addEdge('gather', 'hypothesize')
    .addEdge('hypothesize', 'verify')
    .addConditionalEdges('verify', (s: WS) => (routeAfterVerify(S(s), deps.maxIterations) === 'plan' ? 'plan_evidence' : 'recommend'), ['plan_evidence', 'recommend'])
    .addEdge('recommend', 'approve')
    .addEdge('approve', END)
    .compile({ checkpointer: new MemorySaver(), interruptBefore: ['approve'] })
}

// ---------- run manager exposed to the page ----------

export interface WebRunView {
  id: string; findingId: string; status: 'running' | 'awaiting_approval' | 'approved' | 'rejected' | 'failed'
  startedAt: string; updatedAt: string; error?: string; state: Partial<AgentState> | null
  traceId: string; trace?: ReturnType<typeof traceSummary>
  /** what happened to the code fix after approval (dry run in the card) */
  handoff?: string
}

export function createWebAgent(opts: { now: number; sample?: SampleText | null; maxIterations?: number; off?: SourceKey[] }) {
  const raw = withSourcesOff(emitRawBundle(buildFixtureDataset(opts.now)), opts.off ?? [])
  const analysis: Analysis = analyze(mapRawBundle(raw))
  const tracer = new Tracer()
  // RAG: past incidents, runbooks and approved investigations, built in the page (local embedder)
  let kb: KnowledgeBase | null = null
  const kbReady = buildKnowledgeBase(analysis).then((k) => (kb = k))
  const tools = tracedTools(withKnowledge(snapshotTools(raw, analysis), () => kbReady.then(() => kb)), tracer)
  const llm = opts.sample ? tracedLlm(langchainClaudeLlm(opts.sample), tracer, 'anthropic') : null
  const deps: AgentDeps = { analysis: () => analysis, tools, llm, maxIterations: opts.maxIterations ?? 2, tracer }
  const graph = buildWebGraph(deps)
  const runs = new Map<string, WebRunView>()
  const cfg = (id: string) => ({ configurable: { thread_id: id } })

  async function view(id: string): Promise<WebRunView> {
    const info = runs.get(id)!
    const snap = await graph.getState(cfg(id))
    const v = snap.values as WS
    if (info.status !== 'failed') {
      info.status = snap.next.includes('approve') ? 'awaiting_approval' : v.approval ? (v.approval.decision === 'approve' ? 'approved' : 'rejected') : snap.next.length ? 'running' : info.status
    }
    info.updatedAt = new Date().toISOString()
    return { ...info, state: v as unknown as Partial<AgentState>, trace: traceSummary(tracer.spans(info.traceId)) }
  }

  return {
    model: deps.llm?.name ?? null,
    knowledge: () => kbReady.then(() => ({ docs: kb?.docs ?? 0, chunks: kb?.size ?? 0, embedder: kb?.embedder.name ?? '' })),
    findings: analysis.failures.map((f) => f.id),
    /** Runs until the graph pauses before approval. onStep gets each node name as it finishes. */
    async start(findingId: string, onStep?: (node: string, log: string[]) => void): Promise<WebRunView> {
      const id = `inv-${findingId}-${Date.now().toString(36)}`
      const traceId = newTraceId()
      runs.set(id, { id, findingId, traceId, status: 'running', startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), state: null })
      const root = tracer.begin(traceId, 'invoke_agent product-journey-investigator', { 'gen_ai.operation.name': 'invoke_agent', 'gen_ai.agent.name': 'product-journey-investigator', 'app.finding_id': findingId })
      try {
        const stream = await graph.stream({ findingId, traceId }, { ...cfg(id), streamMode: 'updates' })
        for await (const chunk of stream as AsyncIterable<Record<string, { log?: string[] }>>) {
          for (const [node, upd] of Object.entries(chunk)) onStep?.(node, upd?.log ?? [])
        }
      } catch (e) {
        Object.assign(runs.get(id)!, { status: 'failed', error: (e as Error).message })
      }
      await tracer.finish(root)
      return view(id)
    },
    async resume(id: string, decision: 'approve' | 'reject', by = 'you', note?: string): Promise<WebRunView> {
      const info = runs.get(id)
      if (!info) throw new Error(`run ${id} not found`)
      const findingId = info.findingId
      const root = tracer.begin(info.traceId, 'human_approval', { 'gen_ai.operation.name': 'invoke_agent', 'app.decision': decision })
      await graph.updateState(cfg(id), { decision: { decision, by, note } })
      await graph.invoke(null, cfg(id))
      await tracer.finish(root)
      // long-term memory: approved investigations become precedent for the next search
      const v = (await graph.getState(cfg(id))).values as WS
      if (decision === 'approve' && v.recommendation && v.context?.repo) {
        const r = await tools.op('copilot_issue', copilotIssue(v.context, v.recommendation, id))
        info.handoff = r.ok ? `Code fix handed to GitHub Copilot coding agent: ${r.tool}` : `Copilot hand-off failed: ${r.error}`
      }
      if (decision === 'approve' && v.recommendation && v.context && kb) {
        await kb.remember({ runId: id, findingId, productId: v.context.productId, service: v.context.service, ruleId: v.context.ruleId, at: v.context.at, headline: v.recommendation.headline, rootCause: v.recommendation.rootCause, actions: v.recommendation.actions.map((a: { action: string }) => a.action), decision, by })
      }
      return view(id)
    },
  }
}

declare const window: Record<string, unknown> | undefined
/** The card's view model with some sources switched off: the same build the page ships with, recomputed in the page. */
export function rebuildViewModel(opts: { now: number; off: SourceKey[] }) {
  const raw = withSourcesOff(emitRawBundle(buildFixtureDataset(opts.now)), opts.off)
  return buildViewModel(analyze(mapRawBundle(raw)), { mode: 'demo', maxJourneys: 40, evidenceChars: 180, raw })
}

if (typeof window !== 'undefined') window.PJAgent = { create: createWebAgent, rebuild: rebuildViewModel }
