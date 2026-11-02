// The structured outputs the agent asks a model for, as zod schemas. One definition, two users:
// the server's LangChain chat models (withStructuredOutput) and the card's LangChain chain over
// Claude in the Claude app (JsonOutputParser + zod). Loaded lazily by the server so it boots
// before npm install.
import { z } from 'zod'
import type { SchemaName } from './nodes'

export const AGENT_SCHEMAS = {
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
  judge: z.object({ grounded: z.boolean(), score: z.number().min(0).max(5), reason: z.string() }),
} satisfies Record<SchemaName, z.ZodTypeAny>

/** Compact shape description for models without native structured output. */
export const SCHEMA_SHAPES: Record<SchemaName, string> = {
  plan: '{"items":[{"kind":"<one of the listed kinds>","why":"<short reason>"}]} (at most 5 items)',
  hypothesis: '{"rootCause":"<one paragraph>","chain":[{"step":"<what happened>","evidenceIds":["E0"]}],"confidence":"high|medium|low"}',
  judge: '{"grounded":true|false,"score":<0-5>,"reason":"<one sentence>"}',
  recommendation: '{"headline":"<one line>","rootCause":"<short>","impact":"<short>","actions":[{"priority":1,"action":"<imperative>","ruleId":"<allowed rule id>","horizon":"now|this-sprint|this-quarter","owner":"<team>"}],"evidenceUsed":["E0"]}',
}
