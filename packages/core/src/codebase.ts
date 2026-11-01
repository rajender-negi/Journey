// Phase 4: codebase analysis against official best practices.
// Deterministic static rules over repo files (fetched via GitHub contents API or MCP),
// plus cross-signal rules that combine code with Dynatrace runtime metrics
// (e.g. recommend Redis only when the traffic shape proves a cache would pay off).

import type { CodeFinding, Dataset, Pillar, Reference, RepoSnapshot, Severity } from './types'
import { REF } from './refs'

interface Hit { line?: number; evidence: string }
interface FileRule {
  id: string
  pillar: Pillar
  severity: Severity
  title: string
  file: RegExp
  detect: (content: string) => Hit[]
  recommendation: string
  references: Reference[]
}

const lineOf = (content: string, idx: number) => content.slice(0, idx).split('\n').length
const firstLine = (content: string, re: RegExp): Hit[] => {
  const m = re.exec(content)
  return m ? [{ line: lineOf(content, m.index), evidence: m[0].trim().slice(0, 140) }] : []
}
const allLines = (content: string, re: RegExp): Hit[] => {
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`)
  return [...content.matchAll(g)].map((m) => ({ line: lineOf(content, m.index ?? 0), evidence: m[0].trim().slice(0, 140) }))
}
/** Never echo a secret back: keep the key prefix or the variable name, mask the value. */
export const maskSecret = (s: string) =>
  s.replace(/(AKIA[0-9A-Z]{4})[0-9A-Z]{12}/g, '$1************').replace(/(["'])[^"']{6,}\1/g, '$1********$1')

const isK8sDeployment = (c: string) => /kind:\s*(Deployment|StatefulSet)/.test(c)

export const FILE_RULES: FileRule[] = [
  // ---- containers ----
  {
    id: 'DOCKER-ROOT', pillar: 'security', severity: 'high', title: 'Container runs as root', file: /(^|\/)Dockerfile$/,
    detect: (c) => (/^\s*USER\s+/m.test(c) ? [] : [{ evidence: 'No USER instruction; process runs as UID 0' }]),
    recommendation: 'Add a non-root USER in the final stage (or use a distroless :nonroot base) and set runAsNonRoot in the pod securityContext.',
    references: [REF.dockerBest, REF.k8sPss],
  },
  {
    id: 'DOCKER-UNPINNED-BASE', pillar: 'tool-integration', severity: 'medium', title: 'Base image not pinned', file: /(^|\/)Dockerfile$/,
    detect: (c) => allLines(c, /^FROM\s+[^\s:@]+(:latest)?(\s|$)/m).filter((h) => !/@sha256/.test(h.evidence)),
    recommendation: 'Pin the base image to a version tag and digest; refresh it on a schedule (Dependabot docker ecosystem) instead of floating on latest.',
    references: [REF.dockerBest, REF.ghDependabot],
  },
  {
    id: 'DOCKER-CACHE-ORDER', pillar: 'tool-integration', severity: 'low', title: 'Dependency install after full COPY breaks layer cache', file: /(^|\/)Dockerfile$/,
    detect: (c) => {
      const copyAll = c.search(/^COPY\s+\.\s+\./m)
      const install = c.search(/^RUN\s+(npm (install|ci)|pip install|mvn|gradle|go mod download)/m)
      return copyAll >= 0 && install > copyAll ? [{ line: lineOf(c, copyAll), evidence: 'COPY . . precedes dependency install' }] : []
    },
    recommendation: 'Copy only the lockfile, install dependencies, then copy the source. Use npm ci, not npm install, for reproducible builds.',
    references: [REF.dockerBest],
  },
  // ---- kubernetes ----
  {
    id: 'K8S-NO-PROBES', pillar: 'system-design', severity: 'high', title: 'Missing readiness or liveness probe', file: /\.ya?ml$/,
    detect: (c) => {
      if (!isK8sDeployment(c)) return []
      const missing = ['readinessProbe', 'livenessProbe'].filter((p) => !c.includes(p))
      return missing.length ? [{ evidence: `Missing: ${missing.join(', ')}` }] : []
    },
    recommendation: 'Add readinessProbe (local readiness only), livenessProbe, and a startupProbe for slow boots. Without readiness, rollouts send traffic to pods that are not ready.',
    references: [REF.k8sProbes],
  },
  {
    id: 'K8S-NO-LIMITS', pillar: 'system-design', severity: 'medium', title: 'No resource requests or limits', file: /\.ya?ml$/,
    detect: (c) => (isK8sDeployment(c) && !/resources:/.test(c) ? [{ evidence: 'Container has no resources block' }] : []),
    recommendation: 'Set CPU and memory requests from observed p95 usage and a memory limit with headroom. This drives both scheduling stability and cost allocation.',
    references: [REF.k8sResources],
  },
  {
    id: 'K8S-SINGLE-REPLICA', pillar: 'architecture', severity: 'medium', title: 'Single replica, no redundancy', file: /\.ya?ml$/,
    detect: (c) => (isK8sDeployment(c) ? firstLine(c, /replicas:\s*1\s*$/m) : []),
    recommendation: 'Run at least 2 replicas spread across zones with a PodDisruptionBudget, or an HPA with minReplicas 2.',
    references: [REF.k8sPdb],
  },
  {
    id: 'K8S-MUTABLE-TAG', pillar: 'tool-integration', severity: 'high', title: 'Deploys a mutable image tag', file: /\.ya?ml$/,
    detect: (c) => allLines(c, /image:\s*\S+:latest\b/),
    recommendation: 'Reference images by digest written by CI. Mutable tags make rollbacks non-deterministic and cause ImagePullBackOff when tags move.',
    references: [REF.k8sImages, REF.ecrTagImmutability],
  },
  {
    id: 'K8S-NO-SECCTX', pillar: 'security', severity: 'medium', title: 'No securityContext with runAsNonRoot', file: /\.ya?ml$/,
    detect: (c) => (isK8sDeployment(c) && !/runAsNonRoot:\s*true/.test(c) ? [{ evidence: 'runAsNonRoot not set' }] : []),
    recommendation: 'Apply the Restricted Pod Security Standard: runAsNonRoot, drop all capabilities, readOnlyRootFilesystem where possible.',
    references: [REF.k8sPss],
  },
  // ---- CI ----
  {
    id: 'GHA-UNPINNED-ACTION', pillar: 'security', severity: 'medium', title: 'Third-party actions not pinned to a commit SHA', file: /\.github\/workflows\/.*\.ya?ml$/,
    detect: (c) => allLines(c, /uses:\s*[\w.-]+\/[\w.-]+@(?![0-9a-f]{40}\b)[\w.-]+/),
    recommendation: 'Pin every action to a full commit SHA with a version comment. Branch refs like @master can change under you.',
    references: [REF.ghHardening],
  },
  {
    id: 'GHA-NO-PERMISSIONS', pillar: 'security', severity: 'medium', title: 'Workflow token has default permissions', file: /\.github\/workflows\/.*\.ya?ml$/,
    detect: (c) => (/^permissions:/m.test(c) ? [] : [{ evidence: 'No top-level permissions block' }]),
    recommendation: 'Declare permissions: contents: read at the top and grant more per job only where needed.',
    references: [REF.ghHardening],
  },
  {
    id: 'GHA-NO-CONCURRENCY', pillar: 'tool-integration', severity: 'low', title: 'No concurrency control on CI', file: /\.github\/workflows\/.*\.ya?ml$/,
    detect: (c) => (/^concurrency:/m.test(c) ? [] : [{ evidence: 'Superseded runs keep consuming runner minutes' }]),
    recommendation: 'Add a concurrency group with cancel-in-progress for PR workflows to cut queue time and runner cost.',
    references: [REF.ghHardening],
  },
  // ---- code ----
  {
    id: 'CODE-SQL-CONCAT', pillar: 'security', severity: 'critical', title: 'SQL built by string concatenation', file: /\.(ts|js|py|java|go|cs)$/,
    detect: (c) => allLines(c, /(["'`])\s*(SELECT|INSERT|UPDATE|DELETE)\b(?:(?!\1).)*\1\s*\+\s*\w+/i),
    recommendation: 'Use parameterized queries or the ORM query builder. Never concatenate request values into SQL.',
    references: [REF.owaspSqli],
  },
  {
    id: 'CODE-HARDCODED-SECRET', pillar: 'security', severity: 'critical', title: 'Credential committed to source', file: /\.(ts|js|py|java|go|cs|ya?ml|json|env|tf)$/,
    detect: (c) => [...allLines(c, /AKIA[0-9A-Z]{16}/), ...allLines(c, /(password|secret|api_?key)\s*[:=]\s*["'][^"']{6,}["']/i)].map((h) => ({ ...h, evidence: maskSecret(h.evidence) })),
    recommendation: 'Rotate the credential now, remove it from history, and load it from a secrets manager through External Secrets. Use IRSA or workload identity instead of static keys.',
    references: [REF.owaspSecrets, REF.externalSecrets],
  },
  {
    id: 'CODE-JWT-ALG-NONE', pillar: 'security', severity: 'critical', title: 'JWT "none" algorithm accepted', file: /\.(ts|js|py|java|go|cs)$/,
    detect: (c) => (/jwt|JWT/.test(c) ? firstLine(c, /["']none["']/) : []),
    recommendation: 'Allow-list a single expected algorithm (RS256 or ES256) and reject unsigned tokens.',
    references: [REF.owaspJwt],
  },
  {
    id: 'CODE-HTTP-NO-TIMEOUT', pillar: 'system-design', severity: 'high', title: 'Outbound HTTP call without timeout', file: /\.(ts|js|py)$/,
    detect: (c) => [
      ...allLines(c, /axios\.(get|post|put|delete)\([^)]*\)/).filter((h) => !/timeout/.test(h.evidence)),
      ...allLines(c, /requests\.(get|post|put|delete)\([^)]*\)/).filter((h) => !/timeout\s*=/.test(h.evidence)),
      ...allLines(c, /\bfetch\([^)]*\)/).filter((h) => !/signal/.test(h.evidence)),
    ],
    recommendation: 'Set an explicit timeout on every outbound call (shorter than the caller timeout), retry only idempotent calls with backoff and jitter.',
    references: [REF.awsTimeouts, REF.retryPattern],
  },
  {
    id: 'CODE-N-PLUS-ONE', pillar: 'design-patterns', severity: 'high', title: 'Query executed inside a loop (N+1)', file: /\.(ts|js|py|java|go|cs)$/,
    detect: (c) => allLines(c, /(\.map\(|\.forEach\(|for\s*\()[^\n]*\n?[^\n]*\n?[^\n]*\b(find\w*|query|select\w*)\s*\(/),
    recommendation: 'Fetch related rows in one query (JOIN, IN clause, or JPA entity graph / batch fetch) instead of one query per item.',
    references: [REF.springJpaQueries],
  },
  // ---- IaC ----
  {
    id: 'TF-S3-PUBLIC-ACCESS', pillar: 'security', severity: 'high', title: 'S3 bucket without public access block', file: /\.tf$/,
    detect: (c) => (/resource\s+"aws_s3_bucket"/.test(c) && !/aws_s3_bucket_public_access_block/.test(c) ? firstLine(c, /resource\s+"aws_s3_bucket"\s+"[^"]+"/) : []),
    recommendation: 'Add aws_s3_bucket_public_access_block with all four settings true, and enforce account-level block public access.',
    references: [REF.s3BlockPublic],
  },
]

const RESILIENCE_LIBS = /opossum|cockatiel|resilience4j|gobreaker|failsafe|polly|tenacity|backoff|hystrix/i
const CACHE_LIBS = /redis|ioredis|lettuce|jedis|caffeine|memcached|cachetools|flask-caching|node-cache|ehcache/i
const DEP_FILES = /(^|\/)(package\.json|pom\.xml|build\.gradle|go\.mod|requirements\.txt|pyproject\.toml|.*\.csproj)$/

export function analyzeRepo(snap: RepoSnapshot): CodeFinding[] {
  const out: CodeFinding[] = []
  let n = 0
  const push = (rule: Pick<FileRule, 'id' | 'pillar' | 'severity' | 'title' | 'recommendation' | 'references'>, file: string, hit: Hit) =>
    out.push({
      id: `${snap.repo}:${rule.id}:${++n}`, ruleId: rule.id, productId: snap.productId, repo: snap.repo, file, line: hit.line,
      pillar: rule.pillar, severity: rule.severity, title: rule.title, evidence: hit.evidence, recommendation: rule.recommendation, references: rule.references,
    })

  for (const f of snap.files) {
    for (const rule of FILE_RULES) {
      if (!rule.file.test(f.path)) continue
      for (const hit of rule.detect(f.content)) push(rule, f.path, hit)
    }
  }

  // repo-level rules
  const paths = snap.files.map((f) => f.path)
  const deps = snap.files.filter((f) => DEP_FILES.test(f.path)).map((f) => f.content).join('\n')
  const code = snap.files.map((f) => f.content).join('\n')
  if (!paths.some((p) => /(^|\/)CODEOWNERS$/.test(p))) {
    push({ id: 'REPO-NO-CODEOWNERS', pillar: 'tool-integration', severity: 'low', title: 'No CODEOWNERS file', recommendation: 'Add CODEOWNERS so reviews route to the owning team automatically and ownership matches the CMDB.', references: [REF.ghCodeowners] }, 'CODEOWNERS', { evidence: 'File not found' })
  }
  if (!paths.some((p) => /\.github\/dependabot\.ya?ml$/.test(p))) {
    push({ id: 'REPO-NO-DEPENDABOT', pillar: 'security', severity: 'medium', title: 'No automated dependency updates', recommendation: 'Enable Dependabot version updates for each ecosystem (language, docker, github-actions) so CVE fixes arrive before they block a release.', references: [REF.ghDependabot] }, '.github/dependabot.yml', { evidence: 'File not found' })
  }
  const makesHttpCalls = /axios|node-fetch|\bfetch\(|requests\.|http\.Client|RestTemplate|WebClient|HttpClient/.test(code)
  if (makesHttpCalls && !RESILIENCE_LIBS.test(deps + code)) {
    push({ id: 'ARCH-NO-CIRCUIT-BREAKER', pillar: 'design-patterns', severity: 'medium', title: 'Remote calls without retry or circuit breaker', recommendation: 'Wrap downstream calls with a circuit breaker and bounded retries so one slow dependency cannot exhaust threads or connections.', references: [REF.circuitBreaker, REF.retryPattern] }, '(dependencies)', { evidence: 'HTTP client in use, no resilience library found' })
  }
  const tf = snap.files.filter((f) => f.path.endsWith('.tf'))
  if (tf.length && !tf.some((f) => /backend\s+"/.test(f.content))) {
    push({ id: 'TF-NO-REMOTE-STATE', pillar: 'tool-integration', severity: 'medium', title: 'Terraform without remote state backend', recommendation: 'Configure a remote backend with locking (S3 with native lockfile, or Terraform Cloud) so applies from CI and laptops do not diverge.', references: [REF.tfBackend] }, tf[0].path, { evidence: 'No backend block found' })
  }
  const deployments = snap.files.filter((f) => /\.ya?ml$/.test(f.path) && isK8sDeployment(f.content))
  if (deployments.length && !snap.files.some((f) => /kind:\s*PodDisruptionBudget/.test(f.content))) {
    const multi = deployments.some((f) => /replicas:\s*([2-9]|\d{2,})/.test(f.content))
    if (multi) push({ id: 'K8S-NO-PDB', pillar: 'architecture', severity: 'low', title: 'No PodDisruptionBudget', recommendation: 'Add a PDB so node drains and cluster upgrades keep enough replicas serving.', references: [REF.k8sPdb] }, deployments[0].path, { evidence: 'Deployment with replicas > 1 and no PDB' })
  }
  return out
}

/** Cross-signal rules: code facts + Dynatrace runtime facts + cost facts. */
export function crossSignalFindings(ds: Dataset): CodeFinding[] {
  const out: CodeFinding[] = []
  for (const m of ds.serviceMetrics) {
    const repos = ds.repos.filter((r) => r.productId === m.productId)
    if (!repos.length) continue
    const deps = repos.flatMap((r) => r.files.filter((f) => DEP_FILES.test(f.path)).map((f) => f.content)).join('\n')
    const hasCache = CACHE_LIBS.test(deps)
    const readHeavy = m.readWriteRatio >= 10 && m.repeatedQueryRatio >= 0.3 && m.dbCallsPerRequest >= 2
    if (readHeavy && !hasCache) {
      const existing = ds.costs.find((c) => c.productId === m.productId && /elasticache|redis/i.test(c.service))
      out.push({
        id: `${m.service}:ARCH-CACHE-ASIDE`, ruleId: 'ARCH-CACHE-ASIDE', productId: m.productId, repo: repos[0].repo, file: '(runtime + dependencies)',
        pillar: 'architecture', severity: 'high', title: 'Read-heavy repeated queries with no cache: add Redis cache-aside',
        evidence: `${m.service}: ${m.dbCallsPerRequest} DB calls/request, ${Math.round(m.repeatedQueryRatio * 100)}% repeated statements, read/write ${m.readWriteRatio}:1, p95 ${m.p95Ms} ms${m.topQuery ? `. Top: ${m.topQuery}` : ''}. No cache client in dependencies.`,
        recommendation: `Introduce cache-aside with Redis for the repeated reads (TTL plus invalidate on write). ${existing ? 'An ElastiCache cluster is already billed to this product: reuse it rather than provisioning a new one.' : 'Use a managed Redis (ElastiCache / Azure Cache for Redis).'} Expected effect: DB calls per request and p95 drop, and the database instance can be downsized. Validate with a Dynatrace before/after on DB calls per request.`,
        references: [REF.cacheAside, REF.redisCaching],
      })
    }
    if (m.dbCallsPerRequest >= 10) {
      out.push({
        id: `${m.service}:RUNTIME-CHATTY-DB`, ruleId: 'RUNTIME-CHATTY-DB', productId: m.productId, repo: repos[0].repo, file: '(runtime)',
        pillar: 'design-patterns', severity: 'high', title: 'Chatty database access confirmed in production',
        evidence: `${m.dbCallsPerRequest} DB calls per request measured by Dynatrace on ${m.service}`,
        recommendation: 'Batch or join the per-item queries; target under 5 DB calls per request for list endpoints.',
        references: [REF.springJpaQueries],
      })
    }
  }
  return out
}

export function analyzeCodebases(ds: Dataset): CodeFinding[] {
  return [...ds.repos.flatMap(analyzeRepo), ...crossSignalFindings(ds)]
}
