// Normalized data model. Every adapter (direct API or MCP snapshot) maps into these shapes.
// Product identity always comes from the CMDB; every other record is joined to a product by
// repo, Dynatrace entity, k8s namespace or cost tag.

export type Pillar =
  | 'coding'
  | 'design-patterns'
  | 'system-design'
  | 'architecture'
  | 'security'
  | 'tool-integration'

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info'

export interface Reference {
  title: string
  url: string
}

export interface Product {
  id: string // CMDB sys_id or business app id
  name: string
  owner: string
  team: string
  tier: 1 | 2 | 3 // business criticality from CMDB
  repos: string[] // "org/repo"
  services: string[] // Dynatrace service names or entity ids
  k8sNamespaces: string[]
  costTags: Record<string, string> // e.g. { product: "checkout" }
  downtimeCostPerMin?: number // optional, from CMDB or config; used for cost-of-failure
}

export interface Merge {
  repo: string
  prNumber: number
  title: string
  author: string
  sha: string
  firstCommitAt: string
  openedAt: string
  mergedAt: string
  additions: number
  deletions: number
  filesChanged: number
}

export type PipelineStage = 'build' | 'test' | 'scan' | 'deploy' | 'verify'
export type RunStatus = 'succeeded' | 'failed' | 'cancelled' | 'running'

export interface PipelineRun {
  id: string
  system: 'github-actions' | 'argocd' | 'jenkins' | 'azure-devops' | 'other'
  repo: string
  sha: string
  stage: PipelineStage
  environment?: 'dev' | 'staging' | 'prod'
  status: RunStatus
  startedAt: string
  finishedAt?: string
  url?: string
  failureText?: string // log tail or error message used by the classifier
}

export interface Deployment {
  id: string
  productId: string
  repo: string
  sha: string
  version: string
  environment: 'dev' | 'staging' | 'prod'
  status: 'succeeded' | 'failed' | 'rolled_back'
  startedAt: string
  finishedAt: string
  source: 'dynatrace-sdlc' | 'argocd' | 'github-actions' | 'other'
  changeRequest?: string
  failureText?: string
}

export interface ChangeRequest {
  number: string
  productId: string
  state: 'new' | 'assess' | 'authorize' | 'scheduled' | 'implement' | 'review' | 'closed' | 'canceled'
  risk: 'high' | 'moderate' | 'low'
  type: 'standard' | 'normal' | 'emergency'
  createdAt: string
  approvedAt?: string
  plannedStart: string
  plannedEnd: string
  closedAt?: string
  closeCode?: 'successful' | 'successful_with_issues' | 'unsuccessful'
  sha?: string
}

export interface Problem {
  id: string
  displayId: string
  title: string
  status: 'open' | 'closed'
  category: 'availability' | 'error' | 'slowdown' | 'resource' | 'custom'
  startedAt: string
  endedAt?: string
  productId: string
  affectedEntities: string[]
  rootCause?: string
  rootCauseText?: string
}

export interface RuntimeEvent {
  id: string
  productId: string
  kind: 'k8s' | 'cloud' | 'app'
  reason: string // CrashLoopBackOff, OOMKilled, ImagePullBackOff, ...
  message: string
  workload: string
  namespace?: string
  at: string
}

export interface ServiceMetrics {
  productId: string
  service: string
  windowDays: number
  requests: number
  failureRate: number // 0..1
  p95Ms: number
  dbCallsPerRequest: number
  repeatedQueryRatio: number // share of DB calls that are identical statements within a request window
  readWriteRatio: number // reads / writes
  topQuery?: string
}

export interface WorkloadUsage {
  productId: string
  namespace: string
  workload: string
  environment: 'dev' | 'staging' | 'prod'
  replicas: number
  cpuRequestCores: number
  cpuUsedP95Cores: number
  memRequestGiB: number
  memUsedP95GiB: number
}

export interface CostRecord {
  productId: string
  provider: 'aws' | 'azure' | 'gcp' | 'dynatrace' | 'other'
  service: string // EC2, EKS, RDS, S3, NAT Gateway, Log ingest...
  month: string // YYYY-MM
  amount: number // USD
  usageType?: string
  environment?: 'dev' | 'staging' | 'prod' | 'shared'
  commitmentCovered?: number // 0..1 share covered by Savings Plans / RIs
}

export interface RepoFile {
  path: string
  content: string
}

export interface RepoSnapshot {
  repo: string
  productId: string
  ref: string
  files: RepoFile[]
}

export interface DoraFromDynatrace {
  productId: string
  deploymentFrequencyPerDay?: number
  leadTimeHours?: number
  changeFailureRate?: number
  mttrHours?: number
}

// Full normalized dataset the engines operate on.
export interface Dataset {
  generatedAt: string
  windowDays: number
  products: Product[]
  merges: Merge[]
  pipelineRuns: PipelineRun[]
  deployments: Deployment[]
  changeRequests: ChangeRequest[]
  problems: Problem[]
  runtimeEvents: RuntimeEvent[]
  serviceMetrics: ServiceMetrics[]
  workloadUsage: WorkloadUsage[]
  costs: CostRecord[]
  repos: RepoSnapshot[]
  doraFromDynatrace: DoraFromDynatrace[]
}

// ---------- Engine outputs ----------

export type JourneyStageName =
  | 'merged'
  | 'build'
  | 'test'
  | 'scan'
  | 'staging'
  | 'change'
  | 'prod'
  | 'verified'

export interface JourneyStage {
  name: JourneyStageName
  status: 'done' | 'failed' | 'running' | 'pending' | 'skipped'
  at?: string
  durationMin?: number
  detail?: string
  url?: string
}

export interface Journey {
  productId: string
  repo: string
  sha: string
  prNumber: number
  title: string
  author: string
  mergedAt: string
  stages: JourneyStage[]
  leadTimeHours?: number // merge -> prod success
  outcome: 'in-flight' | 'delivered' | 'failed' | 'delivered-with-incident'
  blockedAt?: JourneyStageName
}

export type DoraBand = 'elite' | 'high' | 'medium' | 'low'

export interface DoraMetrics {
  productId: string | 'all'
  deploymentFrequencyPerDay: number
  leadTimeHours: number
  changeFailureRate: number
  mttrHours: number
  bands: {
    deploymentFrequency: DoraBand
    leadTime: DoraBand
    changeFailureRate: DoraBand
    mttr: DoraBand
  }
  source: 'dynatrace' | 'computed' | 'reconciled'
  drift?: string[] // where computed and Dynatrace differ materially
  weekly: { week: string; deployments: number; failures: number }[]
}

export interface Recommendation {
  ruleId: string
  title: string
  pillar: Pillar
  severity: Severity
  summary: string
  fixNow: string[] // MTTR: what to do right now
  prevent: string[] // shift-left controls so it does not recur
  references: Reference[]
}

export interface FailureFinding {
  id: string
  productId: string
  at: string
  source: 'pipeline' | 'deployment' | 'runtime' | 'problem' | 'change'
  sourceId: string
  evidence: string
  category: string
  recommendation: Recommendation
  linkedDeploymentId?: string
}

export interface RiskFactor {
  factor: string
  weight: number
  detail: string
}

export interface DeploymentRisk {
  productId: string
  sha: string
  score: number // 0..100
  level: 'low' | 'medium' | 'high'
  factors: RiskFactor[]
  gate: 'proceed' | 'proceed-with-canary' | 'hold'
}

export interface CodeFinding {
  id: string
  ruleId: string
  productId: string
  repo: string
  file: string
  line?: number
  pillar: Pillar
  severity: Severity
  title: string
  evidence: string
  recommendation: string
  references: Reference[]
}

export interface CostInsight {
  id: string
  productId: string
  kind: 'rightsizing' | 'commitment' | 'anomaly' | 'idle' | 'architecture' | 'observability' | 'nonprod'
  title: string
  detail: string
  monthlySavingsUsd: number
  effort: 'low' | 'medium' | 'high'
  references: Reference[]
}

export interface CostSummary {
  productId: string | 'all'
  months: string[]
  monthlyTotals: number[]
  byService: { service: string; amount: number }[]
  currentMonth: number
  momChangePct: number
  costPer1kRequests?: number
  failureCostUsd: number // downtime minutes x tier rate + failed pipeline waste
  savingsPotentialUsd: number
  insights: CostInsight[]
}

export interface PillarScore {
  pillar: Pillar
  score: number // 0..100
  findings: number
  topIssue?: string
}

export interface Scorecard {
  productId: string
  overall: number
  grade: 'A' | 'B' | 'C' | 'D' | 'E'
  pillars: PillarScore[]
}
