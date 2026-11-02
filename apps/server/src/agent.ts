// Agent runtime: the app's MCP client hub, the LLM, and the LangGraph run manager.
// Every piece degrades cleanly: a source with no MCP server -> the agent reads the loaded
// native-schema data for it (live API, snapshot or dummy tier) through the same operations;
// no AI key -> deterministic nodes; LangGraph not installed -> clear 503 on agent routes.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  AgentRuns, McpHub, Tracer, buildKnowledgeBase, createAgentLlm, hashingEmbedder, loadMcpConfig, openAiCompatibleEmbedder, otlpHttpExporter,
  parseOtlpHeaders, snapshotTools, tracedLlm, tracedTools, withKnowledge, withSnapshot, type KnowledgeBase, type RunView, type ServerStatus,
} from '@pj/agent'
import { config } from './config'
import { store } from './store'

export const agent: {
  hub: McpHub | null
  servers: ServerStatus[]
  runs: AgentRuns | null
  llm: string | null
  notes: string[]
  tracer: Tracer | null
  embedder: string
} = { hub: null, servers: [], runs: null, llm: null, notes: [], tracer: null, embedder: '' }

export async function initAgent(): Promise<void> {
  const cfg = loadMcpConfig(config.mcpConfigPath)
  if (cfg && Object.keys(cfg.mcpServers).length) {
    const hub = new McpHub(cfg, config.agent.writeAllowlist)
    try {
      agent.servers = await hub.connect()
      agent.hub = hub
    } catch (e) {
      agent.notes.push((e as Error).message)
    }
  } else {
    agent.notes.push(`No MCP config at ${config.mcpConfigPath}; the agent reads the loaded source data (dummy until sources are configured) through the same operations.`)
  }
  const llm = await createAgentLlm(config.ai).catch((e: Error) => {
    agent.notes.push(`LLM not loaded: ${e.message}`)
    return null
  })
  agent.llm = llm?.name ?? null
  if (!llm) agent.notes.push('No AI_API_KEY: agent runs its deterministic path.')
  // tracing: OpenTelemetry GenAI attribute names, exported over OTLP when an endpoint is set (e.g. Dynatrace)
  const tracer = new Tracer(config.otel.endpoint ? otlpHttpExporter(config.otel.endpoint, parseOtlpHeaders(config.otel.headers), config.otel.serviceName) : undefined)
  agent.tracer = tracer
  agent.notes.push(config.otel.endpoint ? `Traces exported over OTLP to ${new URL(config.otel.endpoint).host}.` : 'Traces kept in memory (set OTEL_EXPORTER_OTLP_ENDPOINT to export).')
  // RAG: rebuilt whenever the data is re-collected
  const embedder = config.rag.embeddingsBaseUrl && config.rag.embeddingsApiKey
    ? openAiCompatibleEmbedder({ baseUrl: config.rag.embeddingsBaseUrl, apiKey: config.rag.embeddingsApiKey, model: config.rag.embeddingsModel, dims: config.rag.embeddingsDims })
    : hashingEmbedder()
  agent.embedder = embedder.name
  const tools = tracedTools(withKnowledge(withSnapshot(agent.hub, () => snapshotTools(store.get().raw)), knowledgeBase), tracer)
  agent.runs = new AgentRuns(
    { analysis: () => store.get().analysis, tools, llm: llm ? tracedLlm(llm, tracer, config.ai.provider) : null, maxIterations: config.agent.maxIterations, tracer },
    { onDecision: recordDecision },
  )
  kbEmbedder = embedder
}

// ---------- knowledge base (RAG) ----------
let kbEmbedder = hashingEmbedder()
let kbFor = ''
let kbPromise: Promise<KnowledgeBase | null> | null = null
const approved: Parameters<KnowledgeBase['remember']>[0][] = []
export function knowledgeBase(): Promise<KnowledgeBase | null> {
  const a = store.get().analysis
  if (kbFor !== a.dataset.generatedAt || !kbPromise) {
    kbFor = a.dataset.generatedAt
    kbPromise = buildKnowledgeBase(a, kbEmbedder)
      .then(async (kb) => { for (const inv of approved) await kb.remember(inv); return kb })
      .catch((e: Error) => { agent.notes.push(`Knowledge base not built: ${e.message}`); return null })
  }
  return kbPromise
}

// ---------- feedback loop: every decision recorded; approvals become precedent ----------
const feedbackFile = () => join(config.dataDir, 'agent-feedback.jsonl')
interface FeedbackRow { at: string; runId: string; findingId: string; productId: string; ruleId: string; decision: string; by: string; note?: string; verified: boolean; engine: string }
async function recordDecision(v: RunView) {
  const s = v.state
  if (!s?.approval || !s.context) return
  const row: FeedbackRow = { at: s.approval.at, runId: v.id, findingId: v.findingId, productId: s.context.productId, ruleId: s.context.ruleId, decision: s.approval.decision, by: s.approval.by, note: s.approval.note, verified: !!s.verification?.passed, engine: s.recommendation?.engine ?? 'rules' }
  mkdirSync(config.dataDir, { recursive: true })
  appendFileSync(feedbackFile(), JSON.stringify(row) + '\n')
  if (row.decision === 'approve' && s.recommendation) {
    const inv = { runId: v.id, findingId: v.findingId, productId: s.context.productId, service: s.context.service, ruleId: s.context.ruleId, at: s.context.at, headline: s.recommendation.headline, rootCause: s.recommendation.rootCause, actions: s.recommendation.actions.map((a) => a.action), decision: 'approve' as const, by: row.by }
    approved.push(inv)
    const kb = await knowledgeBase()
    await kb?.remember(inv)
  }
}

export function feedbackSummary() {
  const rows: FeedbackRow[] = existsSync(feedbackFile()) ? readFileSync(feedbackFile(), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []
  const byRule: Record<string, { approved: number; rejected: number }> = {}
  for (const r of rows) {
    byRule[r.ruleId] ??= { approved: 0, rejected: 0 }
    byRule[r.ruleId][r.decision === 'approve' ? 'approved' : 'rejected']++
  }
  const approvedN = rows.filter((r) => r.decision === 'approve').length
  return { total: rows.length, approved: approvedN, rejected: rows.length - approvedN, approvalRate: rows.length ? Math.round((approvedN / rows.length) * 1000) / 10 : null, byEngine: { llm: rows.filter((r) => r.engine === 'llm').length, rules: rows.filter((r) => r.engine === 'rules').length }, byRule, recent: rows.slice(-20).reverse() }
}

export async function agentStatus() {
  const graphReady = agent.runs ? await agent.runs.ready() : false
  return {
    langgraph: graphReady, langgraphError: graphReady ? undefined : agent.runs?.loadError ?? undefined,
    llm: agent.llm, mcp: agent.servers, tools: agent.hub?.tools() ?? {}, collectViaMcp: agent.hub?.collectSources ?? [],
    notes: agent.notes, audit: agent.hub?.audit.slice(-50) ?? [],
    rag: await knowledgeBase().then((kb) => (kb ? { docs: kb.docs, chunks: kb.size, embedder: kb.embedder.name } : null)),
    tracing: config.otel.endpoint ? 'otlp' : 'memory',
  }
}
