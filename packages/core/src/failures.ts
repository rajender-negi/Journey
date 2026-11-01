// Phase 3: failure detection, deterministic classification and recommendations (MTTR + prevention).
// Rules are evaluated in order; first match wins. The AI layer only narrates and prioritizes these
// findings; it never invents a category.

import type { Dataset, Deployment, FailureFinding, Problem, Recommendation } from './types'
import { REF } from './refs'
import { HOUR, MIN, ts } from './util'

interface FailureRule extends Recommendation {
  category: string
  pattern: RegExp
  sources?: FailureFinding['source'][]
}

export const FAILURE_RULES: FailureRule[] = [
  {
    ruleId: 'FX-IMAGE-PULL', category: 'Image not pullable', pillar: 'tool-integration', severity: 'high',
    pattern: /ImagePullBackOff|ErrImagePull|manifest unknown|pull access denied/i,
    title: 'Image tag missing or registry auth failed',
    summary: 'The manifest references an image tag that does not exist in the registry, or the node cannot authenticate to it.',
    fixNow: ['Confirm the tag exists: aws ecr describe-images --image-ids imageTag=<tag>', 'Re-run the image publish job for this SHA, then resync the Argo CD app', 'If auth: check the node IAM role or imagePullSecrets on the service account'],
    prevent: ['Deploy by immutable digest (image@sha256) written by CI, never by mutable tag', 'Enable ECR tag immutability', 'Gate the Argo CD sync on the image-publish job succeeding for the same SHA'],
    references: [REF.k8sImages, REF.ecrTagImmutability],
  },
  {
    ruleId: 'FX-CONFIG-MISSING', category: 'Missing config or secret', pillar: 'architecture', severity: 'high',
    pattern: /missing required env|environment variable .* (not set|missing)|secret .* not found|configmap .* not found|CreateContainerConfigError/i,
    title: 'Required configuration missing at startup',
    summary: 'The container exits at boot because an environment variable, ConfigMap or Secret is absent in this environment.',
    fixNow: ['Compare env between the failing and last good ReplicaSet: kubectl diff / Argo CD app diff', 'Add the missing key to the environment overlay and resync'],
    prevent: ['Validate required config in CI with a schema check against each environment overlay', 'Source secrets through External Secrets Operator so every environment is declared in Git', 'Fail fast with a clear message listing all missing keys, not the first one'],
    references: [REF.k8sConfigMap, REF.externalSecrets, REF.k8sDebugPods],
  },
  {
    ruleId: 'FX-CRASHLOOP', category: 'Crash loop', pillar: 'coding', severity: 'high',
    pattern: /CrashLoopBackOff|Back-off restarting failed container/i,
    title: 'Container crashes repeatedly after start',
    summary: 'The process exits shortly after start. Root cause is in the last container log lines.',
    fixNow: ['kubectl logs <pod> --previous to read the crash', 'Roll back the Argo CD app to the last healthy revision if this is prod'],
    prevent: ['Run the container with production-like config in a CI smoke test before staging', 'Add a startupProbe so slow boots are not killed by liveness'],
    references: [REF.k8sDebugPods, REF.k8sProbes],
  },
  {
    ruleId: 'FX-OOM', category: 'Memory limit exceeded', pillar: 'system-design', severity: 'high',
    pattern: /OOMKilled|exit code 137|out of memory/i,
    title: 'Container exceeded its memory limit',
    summary: 'The kernel killed the container because working set exceeded the memory limit.',
    fixNow: ['Raise the memory limit to observed p95 working set plus 30% headroom and redeploy', 'Check Dynatrace memory trend for a leak introduced by this release'],
    prevent: ['Set requests from observed p95 usage and limits with headroom; review monthly from Dynatrace workload metrics', 'Add a load test step in staging that asserts peak memory below limit', 'For batch workers, bound concurrency so memory scales with a known factor'],
    references: [REF.k8sMemory, REF.k8sResources],
  },
  {
    ruleId: 'FX-READINESS', category: 'Readiness or rollout timeout', pillar: 'system-design', severity: 'high',
    pattern: /Readiness probe failed|progress deadline exceeded|Liveness probe failed/i,
    title: 'Pods never became ready during rollout',
    summary: 'New pods failed readiness, so the rollout stalled and was rolled back.',
    fixNow: ['Check the readiness endpoint response and dependencies it calls', 'Keep the previous ReplicaSet serving: confirm maxUnavailable is 0'],
    prevent: ['Readiness checks only local readiness, not downstream health', 'Add startupProbe for slow JVM or migration boots', 'Use Argo Rollouts canary with Dynatrace analysis so bad versions never take full traffic'],
    references: [REF.k8sProbes, REF.argoRolloutsAnalysis],
  },
  {
    ruleId: 'FX-DB-MIGRATION', category: 'Database migration failed', pillar: 'design-patterns', severity: 'critical',
    pattern: /migrat|relation .* already exists|SQLSTATE|duplicate column|PreSync hook/i,
    title: 'Schema migration failed during sync',
    summary: 'A PreSync migration hook failed, usually because the migration is not idempotent or ran twice.',
    fixNow: ['Inspect the hook Job logs, fix migration state (schema history table) manually if partially applied', 'Re-run sync only after the migration is idempotent'],
    prevent: ['Use expand and contract: additive migrations first, code switch second, destructive cleanup last', 'Make migrations idempotent (IF NOT EXISTS) and run them against a prod snapshot in staging', 'Order with Argo CD sync waves: migration hook before workload'],
    references: [REF.parallelChange, REF.doraDbChange, REF.argoHooks, REF.argoWaves],
  },
  {
    ruleId: 'FX-VULN-GATE', category: 'Security gate blocked', pillar: 'security', severity: 'high',
    pattern: /CVE-\d{4}-\d+|vulnerabilit|trivy|snyk|policy gate/i,
    title: 'Critical vulnerability blocked the pipeline',
    summary: 'A dependency or base image has a critical CVE with a fix available. The gate worked as designed.',
    fixNow: ['Bump the dependency to the fixed version named in the scan output', 'Rebuild and re-scan; do not waive a critical CVE with a fix available'],
    prevent: ['Enable Dependabot version updates so fixes land before release day', 'Scan on every PR, not only on main, so the block happens before merge', 'Pin and refresh base images weekly'],
    references: [REF.trivy, REF.ghDependabot],
  },
  {
    ruleId: 'FX-FLAKY-TEST', category: 'Flaky or timing-out test', pillar: 'coding', severity: 'medium',
    pattern: /Timeout - Async callback|flaky|passed on retry|timed out after|Test timeout/i,
    title: 'Test failure caused by timing, not by the change',
    summary: 'The test has a history of passing on retry. It blocks delivery without signalling a real defect.',
    fixNow: ['Re-run failed jobs only', 'Open a ticket against the owning team with the test name'],
    prevent: ['Quarantine tests that fail and pass on the same SHA; track a flake rate per suite', 'Replace real timers and network with fakes in unit tests', 'Make the required status check a stable suite, not the quarantined set'],
    references: [REF.doraTestAutomation, REF.ghRerun],
  },
  {
    ruleId: 'FX-COMPILE', category: 'Build or compile error', pillar: 'coding', severity: 'medium',
    pattern: /error TS\d+|compilation failed|cannot find symbol|undefined: |SyntaxError|exit code 2/i,
    title: 'Code merged to main does not compile',
    summary: 'A change reached main without passing the build. Branch protection is not enforcing the build check.',
    fixNow: ['Revert or forward-fix on main immediately; main must stay releasable'],
    prevent: ['Make build and type check required status checks on main', 'Run tsc --noEmit (or the language equivalent) in a pre-push hook', 'Keep changes small so review catches type breaks'],
    references: [REF.ghProtectedBranches, REF.doraTrunk, REF.doraSmallBatches],
  },
  {
    ruleId: 'FX-CHANGE-WAIT', category: 'Change approval delay', pillar: 'tool-integration', severity: 'medium',
    pattern: /awaiting approval|change request .* authorize/i, sources: ['change'],
    title: 'Release blocked waiting for change approval',
    summary: 'The change sat in Authorize for longer than the delivery itself took. Heavyweight approval is a lead time cost with no stability benefit per DORA research.',
    fixNow: ['Escalate to the change manager with the passing pipeline evidence attached'],
    prevent: ['Pre-approve low risk, repeatable deploys as standard changes', 'Auto-attach pipeline, test and Site Reliability Guardian evidence to the change from the pipeline', 'Use peer review plus automated gates as the approval record'],
    references: [REF.doraChangeApproval, REF.dtSrg],
  },
  {
    ruleId: 'FX-REGRESSION-SLOW', category: 'Latency regression after deploy', pillar: 'system-design', severity: 'high',
    pattern: /response time degradation|slowdown|p95 .* up|database calls per request up/i, sources: ['problem'],
    title: 'Release introduced a latency regression',
    summary: 'Dynatrace opened a slowdown problem within an hour of this deployment on the same service.',
    fixNow: ['Roll back to the previous version in Argo CD', 'Compare service flow and DB calls per request between versions in Dynatrace'],
    prevent: ['Add a Site Reliability Guardian check on p95 and DB calls per request as a post-deploy gate', 'Canary with automated analysis against Dynatrace metrics', 'Load test changed endpoints in staging with production traffic shape'],
    references: [REF.dtSrg, REF.argoRolloutsAnalysis, REF.doraMonitoring],
  },
  {
    ruleId: 'FX-REGRESSION-ERRORS', category: 'Error rate regression after deploy', pillar: 'coding', severity: 'critical',
    pattern: /failure rate increase|5xx|exception/i, sources: ['problem'],
    title: 'Release raised the error rate',
    summary: 'Dynatrace opened an error problem within an hour of this deployment on the same service.',
    fixNow: ['Roll back immediately; error regressions on tier 1 should not be forward-fixed under load', 'Pull the top exception and stack trace from the Dynatrace problem'],
    prevent: ['Contract tests for changed APIs', 'Feature flags so new code paths ship dark and roll out gradually', 'Guardian gate on failure rate before promoting beyond canary'],
    references: [REF.dtSrg, REF.doraContinuousDelivery, REF.argoRolloutsAnalysis],
  },
]

const FALLBACK: FailureRule = {
  ruleId: 'FX-UNCLASSIFIED', category: 'Unclassified failure', pillar: 'tool-integration', severity: 'medium', pattern: /.*/,
  title: 'Failure not matched by any rule',
  summary: 'No deterministic rule matched. Route to the AI explainer with the raw evidence and add a rule once the cause is known.',
  fixNow: ['Open the run logs from the link and capture the first error line'],
  prevent: ['Add a rule to FAILURE_RULES for this signature so it is classified next time'],
  references: [REF.doraMonitoring],
}

export function classify(text: string, source: FailureFinding['source']): FailureRule {
  return FAILURE_RULES.find((r) => (!r.sources || r.sources.includes(source)) && r.pattern.test(text)) ?? FALLBACK
}

const toRec = (r: FailureRule): Recommendation => ({
  ruleId: r.ruleId, title: r.title, pillar: r.pillar, severity: r.severity, summary: r.summary, fixNow: r.fixNow, prevent: r.prevent, references: r.references,
})

/** Problem -> deployment correlation: latest prod deployment of the same product that finished up to 60 min before the problem. */
export function correlateProblems(ds: Dataset): Map<string, Deployment> {
  const out = new Map<string, Deployment>()
  const prod = ds.deployments.filter((d) => d.environment === 'prod')
  for (const p of ds.problems) {
    const start = ts(p.startedAt)
    const cand = prod
      .filter((d) => d.productId === p.productId && ts(d.finishedAt) <= start + 1 * MIN && start - ts(d.finishedAt) <= 60 * MIN)
      .sort((a, b) => ts(b.finishedAt) - ts(a.finishedAt))[0]
    if (cand) out.set(p.id, cand)
  }
  return out
}

export function detectFailures(ds: Dataset): FailureFinding[] {
  const out: FailureFinding[] = []
  const productOfRepo = new Map(ds.products.flatMap((p) => p.repos.map((r) => [r, p.id] as const)))
  const deploySeen = new Set<string>()

  for (const d of ds.deployments.filter((x) => x.status !== 'succeeded')) {
    const text = d.failureText ?? `Deployment ${d.status}`
    const rule = classify(text, 'deployment')
    deploySeen.add(`${d.repo}|${d.sha}|${d.environment}`)
    out.push({ id: `f-${d.id}`, productId: d.productId, at: d.finishedAt, source: 'deployment', sourceId: d.id, evidence: text, category: rule.category, recommendation: toRec(rule), linkedDeploymentId: d.id })
  }
  for (const r of ds.pipelineRuns.filter((x) => x.status === 'failed')) {
    if (r.stage === 'deploy' && deploySeen.has(`${r.repo}|${r.sha}|${r.environment}`)) continue
    const text = r.failureText ?? `${r.stage} failed`
    const rule = classify(text, 'pipeline')
    out.push({ id: `f-${r.id}`, productId: productOfRepo.get(r.repo) ?? '', at: r.finishedAt ?? r.startedAt, source: 'pipeline', sourceId: r.id, evidence: text, category: rule.category, recommendation: toRec(rule) })
  }

  const corr = correlateProblems(ds)
  for (const p of ds.problems) {
    const dep = corr.get(p.id)
    // problems on failed deployments are already covered by the deployment finding
    if (dep && dep.status !== 'succeeded') continue
    const text = `${p.title}. ${p.rootCauseText ?? ''}`
    const rule = dep ? classify(text, 'problem') : FALLBACK
    out.push({
      id: `f-${p.id}`, productId: p.productId, at: p.startedAt, source: 'problem', sourceId: p.id, evidence: text,
      category: dep ? rule.category : 'Problem not linked to a change', recommendation: dep ? toRec(rule) : toRec({ ...FALLBACK, ruleId: 'FX-NON-CHANGE', title: 'Problem not caused by a deployment', summary: 'No deployment finished within 60 minutes before this problem. Treat as an operational incident, not a change failure; it is excluded from change failure rate.' }),
      linkedDeploymentId: dep?.id,
    })
  }

  const now = ts(ds.generatedAt)
  for (const c of ds.changeRequests.filter((x) => x.state === 'authorize')) {
    const waitedH = (now - ts(c.createdAt)) / HOUR
    if (waitedH < 8) continue
    const text = `Change request ${c.number} awaiting approval for ${Math.round(waitedH)}h in authorize state (risk ${c.risk}, ${c.type})`
    const rule = classify(text, 'change')
    out.push({ id: `f-${c.number}`, productId: c.productId, at: c.createdAt, source: 'change', sourceId: c.number, evidence: text, category: rule.category, recommendation: toRec(rule) })
  }

  return out.sort((a, b) => b.at.localeCompare(a.at))
}

/** Problems that were caused by changes (used for CFR and MTTR). */
export function changeCausedProblems(ds: Dataset): Problem[] {
  const corr = correlateProblems(ds)
  return ds.problems.filter((p) => corr.has(p.id))
}
