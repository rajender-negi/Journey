// Claude in the Claude app, as a LangChain chat model. The published card has no API key: the
// artifact runtime's `sample` capability calls Claude on the viewer's own account. Wrapping it as a
// LangChain BaseChatModel keeps the card on the same LangChain path as the server: messages in,
// AIMessage out, a JsonOutputParser, then the shared zod schema.

import { BaseChatModel, type BaseChatModelParams } from '@langchain/core/language_models/chat_models'
import { AIMessage, HumanMessage, SystemMessage, type BaseMessage } from '@langchain/core/messages'
import { JsonOutputParser } from '@langchain/core/output_parsers'
import type { ChatResult } from '@langchain/core/outputs'
import type { AgentLlm, SchemaName } from './nodes'
import { AGENT_SCHEMAS, SCHEMA_SHAPES } from './schemas'

/** The `sample` function the Claude app hands the page (claude.use("sample")). */
export interface SampleText {
  (input: string, opts?: Record<string, unknown>): Promise<{ text: string }>
}

export class ChatClaudeApp extends BaseChatModel {
  constructor(private sample: SampleText, private modelTier: 'quick' | 'default' | 'complex' = 'default', params: BaseChatModelParams = {}) {
    super(params)
  }
  _llmType(): string {
    return 'claude-app-sample'
  }
  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    // sample has no system role: instructions go first in one user turn
    const prompt = messages.map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n\n')
    let text: string
    try {
      text = (await this.sample(prompt, { modelTier: this.modelTier })).text
    } catch (e) {
      const err = e as { code?: string; message?: string }
      throw new Error(`Claude ${err.code ?? 'error'}: ${err.message ?? ''}`.trim())
    }
    return { generations: [{ text, message: new AIMessage(text) }] }
  }
}

/** AgentLlm over LangChain: chat model -> JsonOutputParser -> zod. */
export function langchainClaudeLlm(sample: SampleText): AgentLlm {
  const quick = new ChatClaudeApp(sample, 'quick')
  const standard = new ChatClaudeApp(sample, 'default')
  return {
    name: 'Claude via LangChain',
    async structured<T>(schema: SchemaName, system: string, user: string): Promise<T> {
      const chain = (schema === 'plan' ? quick : standard).pipe(new JsonOutputParser())
      const raw = await chain.invoke([
        new SystemMessage(system),
        new HumanMessage(`${user}\n\nReply with only one JSON object of this shape, no other text:\n${SCHEMA_SHAPES[schema]}`),
      ])
      const parsed = AGENT_SCHEMAS[schema].safeParse(raw)
      if (!parsed.success) throw new Error(`Claude reply did not match the ${schema} schema: ${parsed.error.issues[0]?.message ?? ''}`)
      return parsed.data as T
    },
  }
}
