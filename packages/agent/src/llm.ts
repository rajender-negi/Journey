// LangChain chat models with structured output. Anthropic or any OpenAI-compatible endpoint
// (Azure OpenAI, internal gateways). Loaded lazily; returns null when no key is configured,
// and the agent then runs its deterministic path.

import type { AgentLlm, SchemaName } from './nodes'

export interface LlmConfig {
  provider: 'anthropic' | 'openai-compatible'
  apiKey?: string
  model: string
  baseUrl?: string
  maxTokens: number
}

export async function createAgentLlm(cfg: LlmConfig): Promise<AgentLlm | null> {
  if (!cfg.apiKey || (cfg.provider === 'openai-compatible' && !cfg.baseUrl)) return null
  const { z } = await import('zod')
  const schemas: Record<SchemaName, unknown> = {
    plan: z.object({ items: z.array(z.object({ kind: z.string().describe('one of the listed evidence kinds'), why: z.string() })).max(5) }),
    hypothesis: z.object({
      rootCause: z.string(),
      chain: z.array(z.object({ step: z.string(), evidenceIds: z.array(z.string()).describe('ids like E0, E1') })).min(1),
      confidence: z.enum(['high', 'medium', 'low']),
    }),
    recommendation: z.object({
      headline: z.string(),
      rootCause: z.string(),
      impact: z.string(),
      actions: z.array(z.object({ priority: z.number().int(), action: z.string(), ruleId: z.string(), horizon: z.enum(['now', 'this-sprint', 'this-quarter']), owner: z.string() })).min(1),
      evidenceUsed: z.array(z.string()),
    }),
  }
  let model: { withStructuredOutput: (s: unknown, o?: unknown) => { invoke: (m: unknown) => Promise<unknown> } }
  if (cfg.provider === 'anthropic') {
    const { ChatAnthropic } = await import('@langchain/anthropic')
    model = new ChatAnthropic({ model: cfg.model, apiKey: cfg.apiKey, maxTokens: cfg.maxTokens, ...(cfg.baseUrl ? { anthropicApiUrl: cfg.baseUrl } : {}) }) as unknown as typeof model
  } else {
    const { ChatOpenAI } = await import('@langchain/openai')
    model = new ChatOpenAI({ model: cfg.model, apiKey: cfg.apiKey, maxTokens: cfg.maxTokens, configuration: { baseURL: cfg.baseUrl } }) as unknown as typeof model
  }
  return {
    name: cfg.model,
    async structured<T>(schema: SchemaName, system: string, user: string): Promise<T> {
      const runnable = model.withStructuredOutput(schemas[schema], { name: schema })
      return (await runnable.invoke([['system', system], ['human', user]])) as T
    },
  }
}
