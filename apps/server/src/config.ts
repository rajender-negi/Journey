// All configuration comes from environment variables (see .env.example).
// A source is "live" only when its credentials are present; otherwise it falls back to an
// MCP snapshot file in data/inbox, then to dummy data. Status is reported per source.

export type SourceName = 'servicenow' | 'github' | 'dynatrace' | 'argocd' | 'kubernetes' | 'aws' | 'azure' | 'gcp'
export const SOURCES: SourceName[] = ['servicenow', 'github', 'dynatrace', 'argocd', 'kubernetes', 'aws', 'azure', 'gcp']

import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'

const ROOT = new URL('../../../', import.meta.url).pathname

// Load <repo>/.env once. Real environment variables win over the file.
const envFile = resolve(ROOT, '.env')
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/)
    if (!m || line.trim().startsWith('#')) continue
    const v = m[2].replace(/^(['"])(.*)\1$/, '$2')
    if (process.env[m[1]] === undefined) process.env[m[1]] = v
  }
}

const env = (k: string) => process.env[k]?.trim() || undefined
export const fromRoot = (p: string) => (isAbsolute(p) ? p : resolve(ROOT, p))

export const config = {
  port: Number(env('PORT') ?? 8787),
  // demo forces dummy data for every source; live means unconnected sources are empty (dead); auto follows the Integrations setting
  mode: (env('PJ_MODE') ?? 'auto') as 'auto' | 'demo' | 'live',
  windowDays: Number(env('PJ_WINDOW_DAYS') ?? 30),
  collectEveryMin: Number(env('PJ_COLLECT_EVERY_MIN') ?? 15),
  dataDir: fromRoot(env('PJ_DATA_DIR') ?? 'data'),

  servicenow: { instance: env('SNOW_INSTANCE'), user: env('SNOW_USER'), password: env('SNOW_PASSWORD'), token: env('SNOW_TOKEN'), productQuery: env('SNOW_PRODUCT_QUERY') ?? 'operational_status=1' },
  github: { token: env('PJ_GITHUB_TOKEN'), api: env('GITHUB_API') ?? 'https://api.github.com', maxFilesPerRepo: Number(env('GITHUB_MAX_FILES') ?? 150) },
  dynatrace: { url: env('DT_ENV_URL'), token: env('DT_PLATFORM_TOKEN') },
  argocd: { url: env('ARGOCD_URL'), token: env('ARGOCD_TOKEN') },
  kubernetes: { api: env('K8S_API'), token: env('K8S_TOKEN') },
  aws: { enabled: env('AWS_COST_ENABLED') === 'true', profile: env('AWS_PROFILE'), envTagKey: env('AWS_ENV_TAG_KEY') ?? 'environment' },
  azure: { token: env('AZURE_TOKEN'), scope: env('AZURE_COST_SCOPE') },
  // Cloud Billing export in BigQuery: project to run the query in and the export table (project.dataset.gcp_billing_export_v1_XXXX)
  gcp: { token: env('GCP_ACCESS_TOKEN'), project: env('GCP_BILLING_PROJECT'), table: env('GCP_BILLING_TABLE') },

  // MCP client: same format as Cursor's .cursor/mcp.json (see mcp.servers.example.json)
  mcpConfigPath: fromRoot(env('PJ_MCP_CONFIG') ?? 'mcp.servers.json'),
  agent: {
    maxIterations: Number(env('AGENT_MAX_ITERATIONS') ?? 2),
    // 'copilot': after approval, open a GitHub issue assigned to the Copilot coding agent (needs AGENT_WRITE_ALLOWLIST=<github server>:create_issue)
    delegateFixes: env('AGENT_DELEGATE_FIXES') ?? '',
    // explicit server:tool pairs the agent may call that look like writes; Dynatrace is never writable
    writeAllowlist: (env('AGENT_WRITE_ALLOWLIST') ?? '').split(',').map((x) => x.trim()).filter(Boolean),
  },

  rag: {
    // local (built-in hybrid index) | azure-ai-search | bedrock-kb
    provider: env('RAG_PROVIDER') ?? 'local',
    azureSearchEndpoint: env('AZURE_SEARCH_ENDPOINT'), azureSearchIndex: env('AZURE_SEARCH_INDEX'), azureSearchKey: env('AZURE_SEARCH_API_KEY'), azureSearchSemanticConfig: env('AZURE_SEARCH_SEMANTIC_CONFIG'),
    bedrockKnowledgeBaseId: env('BEDROCK_KB_ID'), awsRegion: env('AWS_REGION') ?? 'us-east-1',
    guardrailProvider: env('GUARDRAIL_PROVIDER') ?? '', bedrockGuardrailId: env('BEDROCK_GUARDRAIL_ID'), bedrockGuardrailVersion: env('BEDROCK_GUARDRAIL_VERSION') ?? 'DRAFT',
    // any OpenAI-compatible /embeddings endpoint; without it a local hashing embedder is used
    embeddingsBaseUrl: env('EMBEDDINGS_BASE_URL'),
    embeddingsApiKey: env('EMBEDDINGS_API_KEY'),
    embeddingsModel: env('EMBEDDINGS_MODEL') ?? 'text-embedding-3-small',
    embeddingsDims: Number(env('EMBEDDINGS_DIMS') ?? 1536),
  },
  otel: {
    // OTLP/HTTP base, e.g. https://<env>.live.dynatrace.com/api/v2/otlp ; headers "Authorization=Api-Token dt0c01..."
    endpoint: env('OTEL_EXPORTER_OTLP_ENDPOINT'),
    headers: env('OTEL_EXPORTER_OTLP_HEADERS') ?? '',
    serviceName: env('OTEL_SERVICE_NAME') ?? 'product-journey-agent',
  },
  ai: {
    provider: (env('AI_PROVIDER') ?? 'anthropic') as 'anthropic' | 'openai-compatible',
    apiKey: env('AI_API_KEY'),
    model: env('AI_MODEL') ?? 'claude-sonnet-5-5',
    baseUrl: env('AI_BASE_URL'),
    maxTokens: Number(env('AI_MAX_TOKENS') ?? 1500),
    timeoutMs: Number(env('AI_TIMEOUT_MS') ?? 45000),
  },
}

export function isLive(s: SourceName): boolean {
  if (config.mode === 'demo') return false
  switch (s) {
    case 'servicenow': return !!config.servicenow.instance && !!(config.servicenow.token || config.servicenow.user)
    case 'github': return !!config.github.token
    case 'dynatrace': return !!config.dynatrace.url && !!config.dynatrace.token
    case 'argocd': return !!config.argocd.url && !!config.argocd.token
    case 'kubernetes': return !!config.kubernetes.api && !!config.kubernetes.token
    case 'aws': return config.aws.enabled
    case 'azure': return !!config.azure.token && !!config.azure.scope
    case 'gcp': return !!config.gcp.token && !!config.gcp.project && !!config.gcp.table
  }
}
