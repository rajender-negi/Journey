// LLM client. Anthropic Messages API or any OpenAI-compatible gateway (Azure OpenAI, internal proxies).
// The model narrates deterministic findings; output is validated against the evidence pack and
// replaced with the deterministic brief if it fails.

import type { AiMode, AiOutput, Analysis } from '@pj/core'
import { AI_SYSTEM_PROMPT, buildEvidencePack, buildUserPrompt, deterministicBrief, validateAiOutput } from '@pj/core'
import { config } from './config'

export interface AiResult {
  output: AiOutput
  engine: 'llm' | 'deterministic'
  model?: string
  reason?: string
  latencyMs: number
}

async function callModel(system: string, user: string): Promise<string> {
  const c = config.ai
  if (c.provider === 'anthropic') {
    const res = await fetch(`${c.baseUrl ?? 'https://api.anthropic.com'}/v1/messages`, {
      method: 'POST',
      headers: { 'x-api-key': c.apiKey!, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: c.model, max_tokens: c.maxTokens, system, messages: [{ role: 'user', content: user }] }),
      signal: AbortSignal.timeout(60_000),
    })
    if (!res.ok) throw new Error(`Anthropic ${res.status}: ${(await res.text()).slice(0, 200)}`)
    const j = (await res.json()) as { content: { type: string; text?: string }[] }
    return j.content.filter((b) => b.type === 'text').map((b) => b.text).join('')
  }
  const res = await fetch(`${c.baseUrl!.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${c.apiKey}`, 'content-type': 'application/json', 'api-key': c.apiKey! },
    body: JSON.stringify({ model: c.model, max_tokens: c.maxTokens, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
    signal: AbortSignal.timeout(60_000),
  })
  if (!res.ok) throw new Error(`Model ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const j = (await res.json()) as { choices: { message: { content: string } }[] }
  return j.choices[0].message.content
}

export async function brief(a: Analysis, mode: AiMode, target: string): Promise<AiResult> {
  const t0 = Date.now()
  const pack = buildEvidencePack(a, mode, target)
  if (!config.ai.apiKey || (config.ai.provider === 'openai-compatible' && !config.ai.baseUrl)) {
    return { output: deterministicBrief(a, mode, target), engine: 'deterministic', reason: 'AI_API_KEY not set', latencyMs: Date.now() - t0 }
  }
  try {
    const text = await callModel(AI_SYSTEM_PROMPT, buildUserPrompt(pack))
    return { output: validateAiOutput(text, pack), engine: 'llm', model: config.ai.model, latencyMs: Date.now() - t0 }
  } catch (e) {
    return { output: deterministicBrief(a, mode, target), engine: 'deterministic', reason: (e as Error).message, latencyMs: Date.now() - t0 }
  }
}
