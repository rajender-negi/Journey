// Shared agent types. Pure data, serializable, so LangGraph can checkpoint every step.

import type { AiOutput } from '@pj/core'

export type SourceName = 'dynatrace' | 'github' | 'argocd' | 'kubernetes' | 'servicenow' | 'aws' | 'azure'

/** Evidence the agent may request. The LLM chooses kinds; parameters are always filled from the analysis, never by the model. */
export type EvidenceKind =
  | 'dt_problem'
  | 'dt_error_rate'
  | 'dt_latency'
  | 'dt_deployment_events'
  | 'argo_app'
  | 'gh_pr_files'
  | 'gh_job_log'
  | 'k8s_events'

export interface InvestigationContext {
  findingId: string
  productId: string
  productName: string
  tier: number
  ruleId: string
  ruleTitle: string
  ruleSummary: string
  category: string
  source: string
  evidenceText: string
  at: string
  fixNow: string[]
  prevent: string[]
  service?: string
  namespace?: string
  environment?: 'dev' | 'staging' | 'prod'
  repo?: string
  sha?: string
  prNumber?: number
  deployId?: string
  deployVersion?: string
  deployFinishedAt?: string
  argoApp?: string
  jobId?: string
  problemId?: string
  problemDisplayId?: string
  journeyStages?: string[]
}

export interface PlanItem {
  kind: EvidenceKind
  why: string
}

export interface Evidence {
  id: string
  kind: EvidenceKind | 'analysis'
  source: SourceName | 'analysis'
  server?: string
  tool?: string
  args?: Record<string, unknown>
  ok: boolean
  summary: string
  data: string
  at: string
}

export interface Hypothesis {
  rootCause: string
  chain: { step: string; evidenceIds: string[] }[]
  confidence: 'high' | 'medium' | 'low'
  engine: 'llm' | 'rules'
}

export interface Verification {
  passed: boolean
  checks: { name: string; ok: boolean; detail: string }[]
  missing: EvidenceKind[]
}

export interface Approval {
  decision: 'approve' | 'reject'
  by: string
  note?: string
  at: string
}

export interface Recommendation extends AiOutput {
  engine: 'llm' | 'rules'
}
