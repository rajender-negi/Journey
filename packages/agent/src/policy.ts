// Guardrails for MCP tool use. Pure functions, unit tested.
//  - read-only by default: tools whose names look like writes are refused unless explicitly allowed
//  - Dynatrace is never written to, whatever the allowlist says
//  - every argument and result is size-capped before it reaches the model

const WRITE_VERB = /(^|[_\-.])(create|update|delete|remove|write|send|post|patch|put|apply|sync|rollback|restart|scale|merge|close|approve|dismiss|run|trigger|execute_workflow|add|set|edit|push|comment)([_\-.]|$)/i

// Query tools that contain a verb from the list above but only read
const READ_EXCEPTIONS = /^(execute_dql|run_dql|dql|query|execute_query|get_.*|list_.*|search_.*|events_list|pods_list|pods_get|resources_get|resources_list)$/i

export function isReadOnlyTool(tool: string): boolean {
  if (READ_EXCEPTIONS.test(tool)) return true
  return !WRITE_VERB.test(tool)
}

export function mayCall(server: string, tool: string, writeAllowlist: string[] = []): { ok: boolean; reason?: string } {
  if (/dynatrace/i.test(server) && !isReadOnlyTool(tool)) return { ok: false, reason: 'Dynatrace is read only for this app' }
  if (isReadOnlyTool(tool)) return { ok: true }
  if (writeAllowlist.includes(`${server}:${tool}`)) return { ok: true }
  return { ok: false, reason: `${server}:${tool} looks like a write and is not in AGENT_WRITE_ALLOWLIST` }
}

export function cap(text: string, max = 6000): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n…[truncated ${text.length - max} chars]`
}

/** MCP tool results are content blocks; most servers return JSON or text in the first text block. */
export function mcpText(result: { content?: { type: string; text?: string }[]; structuredContent?: unknown }): string {
  if (result.structuredContent !== undefined) return JSON.stringify(result.structuredContent)
  return (result.content ?? []).filter((c) => c.type === 'text' && c.text).map((c) => c.text).join('\n')
}

/** Extract the first JSON value from a tool's text output (servers often prefix a sentence). */
export function parseJsonLoose(text: string): unknown {
  try { return JSON.parse(text) } catch { /* fall through */ }
  const starts = [text.indexOf('{'), text.indexOf('[')].filter((i) => i >= 0)
  if (!starts.length) return undefined
  const s = Math.min(...starts)
  const end = text[s] === '{' ? text.lastIndexOf('}') : text.lastIndexOf(']')
  if (end <= s) return undefined
  try { return JSON.parse(text.slice(s, end + 1)) } catch { return undefined }
}

/** Normalise any DQL tool output into Grail's {state, result:{records}} shape used by the core mappers. */
export function toDqlResult(text: string, query: string) {
  const v = parseJsonLoose(text) as unknown
  let records: Record<string, unknown>[] = []
  if (Array.isArray(v)) records = v as Record<string, unknown>[]
  else if (v && typeof v === 'object') {
    const o = v as { records?: unknown; result?: { records?: unknown } }
    if (Array.isArray(o.records)) records = o.records as Record<string, unknown>[]
    else if (o.result && Array.isArray(o.result.records)) records = o.result.records as Record<string, unknown>[]
  }
  return { state: 'SUCCEEDED' as const, result: { records, metadata: { grail: { query } } } }
}
