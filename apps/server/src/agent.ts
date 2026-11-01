// Agent runtime: the app's MCP client hub, the LLM, and the LangGraph run manager.
// Every piece degrades cleanly: a source with no MCP server -> the agent reads the loaded
// native-schema data for it (live API, snapshot or dummy tier) through the same operations;
// no AI key -> deterministic nodes; LangGraph not installed -> clear 503 on agent routes.
import { AgentRuns, McpHub, createAgentLlm, loadMcpConfig, snapshotTools, withSnapshot, type ServerStatus } from '@pj/agent'
import { config } from './config'
import { store } from './store'

export const agent: {
  hub: McpHub | null
  servers: ServerStatus[]
  runs: AgentRuns | null
  llm: string | null
  notes: string[]
} = { hub: null, servers: [], runs: null, llm: null, notes: [] }

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
  agent.runs = new AgentRuns({ analysis: () => store.get().analysis, tools: withSnapshot(agent.hub, () => snapshotTools(store.get().raw)), llm, maxIterations: config.agent.maxIterations })
}

export async function agentStatus() {
  const graphReady = agent.runs ? await agent.runs.ready() : false
  return {
    langgraph: graphReady, langgraphError: graphReady ? undefined : agent.runs?.loadError ?? undefined,
    llm: agent.llm, mcp: agent.servers, tools: agent.hub?.tools() ?? {}, collectViaMcp: agent.hub?.collectSources ?? [],
    notes: agent.notes, audit: agent.hub?.audit.slice(-50) ?? [],
  }
}
