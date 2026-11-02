// Run manager used by the API: starts investigations, reads checkpointed state, resumes after approval.
// LangGraph is imported lazily so the server starts (and reports a clear error) before `npm install`.

import type { AgentDeps, AgentState } from './nodes'
import { newTraceId, traceSummary } from './trace'

export type RunStatus = 'running' | 'awaiting_approval' | 'approved' | 'rejected' | 'failed'
export interface RunInfo { id: string; findingId: string; traceId: string; status: RunStatus; startedAt: string; updatedAt: string; error?: string }
export interface RunView extends RunInfo { state: Partial<AgentState> | null; interrupt?: unknown; trace?: ReturnType<typeof traceSummary> }
export interface RunHooks { onDecision?: (view: RunView) => void | Promise<void> }

type Graph = {
  invoke: (input: unknown, cfg: { configurable: { thread_id: string } }) => Promise<unknown>
  getState: (cfg: { configurable: { thread_id: string } }) => Promise<{ values: Partial<AgentState>; next: string[]; tasks: { interrupts?: { value: unknown }[] }[] }>
}

export class AgentRuns {
  private runs = new Map<string, RunInfo>()
  private graph: Graph | null = null
  private CommandCtor: (new (a: { resume: unknown }) => unknown) | null = null
  loadError: string | null = null

  constructor(private deps: AgentDeps, private hooks: RunHooks = {}) {}

  async ready(): Promise<boolean> {
    if (this.graph) return true
    try {
      const m = await import('./graph')
      this.graph = m.buildInvestigationGraph(this.deps) as unknown as Graph
      this.CommandCtor = m.Command as unknown as new (a: { resume: unknown }) => unknown
      return true
    } catch (e) {
      this.loadError = `LangGraph not installed or failed to load (${(e as Error).message}). Run npm install.`
      return false
    }
  }

  list(): RunInfo[] {
    return [...this.runs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt))
  }

  /** Starts a run and waits until it pauses for approval (or fails). */
  async start(findingId: string): Promise<RunView> {
    if (!(await this.ready())) throw new Error(this.loadError!)
    const id = `inv-${findingId}-${Date.now().toString(36)}`
    const traceId = newTraceId()
    const info: RunInfo = { id, findingId, traceId, status: 'running', startedAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
    this.runs.set(id, info)
    const root = this.deps.tracer?.begin(traceId, 'invoke_agent product-journey-investigator', { 'gen_ai.operation.name': 'invoke_agent', 'gen_ai.agent.name': 'product-journey-investigator', 'app.finding_id': findingId, 'app.run_id': id })
    try {
      await this.graph!.invoke({ findingId, traceId }, { configurable: { thread_id: id } })
      if (root) await this.deps.tracer!.finish(root)
    } catch (e) {
      Object.assign(info, { status: 'failed', error: (e as Error).message, updatedAt: new Date().toISOString() })
      if (root) await this.deps.tracer!.finish(root, 'error', (e as Error).message)
    }
    return this.view(id)
  }

  async resume(id: string, decision: 'approve' | 'reject', by: string, note?: string): Promise<RunView> {
    const info = this.runs.get(id)
    if (!info) throw new Error(`run ${id} not found`)
    if (info.status !== 'awaiting_approval') throw new Error(`run ${id} is ${info.status}, not awaiting approval`)
    const root = this.deps.tracer?.begin(info.traceId, 'human_approval', { 'gen_ai.operation.name': 'invoke_agent', 'app.decision': decision, 'app.run_id': id })
    await this.graph!.invoke(new this.CommandCtor!({ resume: { decision, by, note } }), { configurable: { thread_id: id } })
    if (root) await this.deps.tracer!.finish(root)
    const v = await this.view(id)
    await Promise.resolve(this.hooks.onDecision?.(v)).catch(() => undefined)
    return v
  }

  async view(id: string): Promise<RunView> {
    const info = this.runs.get(id)
    if (!info) throw new Error(`run ${id} not found`)
    if (!this.graph) return { ...info, state: null }
    const snap = await this.graph.getState({ configurable: { thread_id: id } })
    const pending = snap.tasks.flatMap((t) => t.interrupts ?? [])
    if (info.status !== 'failed') {
      info.status = pending.length ? 'awaiting_approval' : snap.values.approval ? (snap.values.approval.decision === 'approve' ? 'approved' : 'rejected') : snap.next.length ? 'running' : info.status
      info.updatedAt = new Date().toISOString()
    }
    return { ...info, state: snap.values, interrupt: pending[0]?.value, trace: this.deps.tracer ? traceSummary(this.deps.tracer.spans(info.traceId)) : undefined }
  }
}
