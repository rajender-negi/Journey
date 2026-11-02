// The LangGraph investigation agent.
//
//   START -> classify -> plan_evidence -> gather -> hypothesize -> verify --(passed or exhausted)--> recommend -> approve -> END
//                          ^                                  |
//                          +------(missing evidence)----------+
//
// State is checkpointed per thread, so a run survives the human approval pause and can be
// inspected step by step. `approve` uses interrupt(): the run stops until a person resumes it.

import { Annotation, Command, END, MemorySaver, START, StateGraph, interrupt } from '@langchain/langgraph'
import { classify, gather, hypothesize, plan, recommend, routeAfterVerify, verify, type AgentDeps, type AgentState } from './nodes'
import type { Approval, Evidence, Hypothesis, InvestigationContext, PlanItem, Recommendation, Verification } from './types'

const last = <T>() => Annotation<T>({ reducer: (_a: T, b: T) => b, default: () => null as T })

export const InvestigationState = Annotation.Root({
  findingId: Annotation<string>(),
  traceId: Annotation<string>({ reducer: (_a: string, b: string) => b, default: () => '' }),
  context: last<InvestigationContext | null>(),
  plan: Annotation<PlanItem[]>({ reducer: (_a: PlanItem[], b: PlanItem[]) => b, default: () => [] }),
  evidence: Annotation<Evidence[]>({ reducer: (a: Evidence[], b: Evidence[]) => a.concat(b), default: () => [] }),
  hypothesis: last<Hypothesis | null>(),
  verification: last<Verification | null>(),
  recommendation: last<Recommendation | null>(),
  iterations: Annotation<number>({ reducer: (_a: number, b: number) => b, default: () => 0 }),
  approval: last<Approval | null>(),
  log: Annotation<string[]>({ reducer: (a: string[], b: string[]) => a.concat(b), default: () => [] }),
})

type GS = typeof InvestigationState.State

export function buildInvestigationGraph(deps: AgentDeps) {
  const S = (s: GS) => s as unknown as AgentState
  // each step is a span in the run's trace (no-op without a tracer)
  const T = <R>(name: string, fn: (s: GS) => Promise<R>) => (s: GS) => (deps.tracer ? deps.tracer.step(s.traceId || undefined, name, () => fn(s)) : fn(s))
  const approve = async (s: GS) => {
    const r = s.recommendation!
    // pauses the run; resumed with Command({ resume: { decision, by, note } })
    const answer = interrupt({
      question: 'Approve this investigation and its recommended actions?',
      findingId: s.findingId,
      headline: r.headline,
      confidence: s.hypothesis?.confidence,
      verified: s.verification?.passed,
      actions: r.actions,
    }) as { decision: 'approve' | 'reject'; by?: string; note?: string }
    const approval: Approval = { decision: answer.decision === 'approve' ? 'approve' : 'reject', by: answer.by ?? 'unknown', note: answer.note, at: new Date().toISOString() }
    return { approval, log: [`${approval.at.slice(11, 19)} ${approval.decision === 'approve' ? 'approved' : 'rejected'} by ${approval.by}${approval.note ? `: ${approval.note}` : ''}`] }
  }

  return new StateGraph(InvestigationState)
    .addNode('classify', T('classify', (s: GS) => classify(S(s), deps)))
    // node id differs from the 'plan' state channel: LangGraph forbids a node and a channel sharing a name
    .addNode('plan_evidence', T('plan_evidence', (s: GS) => plan(S(s), deps)))
    .addNode('gather', T('gather', (s: GS) => gather(S(s), deps)))
    .addNode('hypothesize', T('hypothesize', (s: GS) => hypothesize(S(s), deps)))
    .addNode('verify', T('verify', (s: GS) => verify(S(s))))
    .addNode('recommend', T('recommend', (s: GS) => recommend(S(s), deps)))
    .addNode('approve', T('approve', approve))
    .addEdge(START, 'classify')
    .addEdge('classify', 'plan_evidence')
    .addEdge('plan_evidence', 'gather')
    .addEdge('gather', 'hypothesize')
    .addEdge('hypothesize', 'verify')
    .addConditionalEdges('verify', (s: GS) => (routeAfterVerify(S(s), deps.maxIterations) === 'plan' ? 'plan_evidence' : 'recommend'), ['plan_evidence', 'recommend'])
    .addEdge('recommend', 'approve')
    .addEdge('approve', END)
    .compile({ checkpointer: new MemorySaver() })
}

export type InvestigationGraph = ReturnType<typeof buildInvestigationGraph>
export { Command }
