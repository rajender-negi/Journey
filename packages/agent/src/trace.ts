// Tracing for the agent with OpenTelemetry GenAI semantic-convention attribute names
// (gen_ai.operation.name, gen_ai.agent.name, gen_ai.request.model, gen_ai.tool.name), exported as
// OTLP/HTTP JSON to any OpenTelemetry backend: Dynatrace (/api/v2/otlp), Langfuse, a collector.
import type { AgentLlm } from './nodes'
import type { ToolRunner } from './evidence'

// No SDK dependency, so it also runs in the browser card. Pattern: Klarna traces every agent step to
// find where behaviour goes wrong.

export type AttrValue = string | number | boolean
export interface Span {
  traceId: string; spanId: string; parentSpanId?: string; name: string; kind: 'internal' | 'client'
  start: number; end?: number; attributes: Record<string, AttrValue>; status: 'unset' | 'ok' | 'error'; error?: string
}
export interface SpanExporter { export(spans: Span[]): Promise<void> }

const hex = (n: number) => Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join('')
export const newTraceId = () => hex(32)

export class Tracer {
  private traces = new Map<string, Span[]>()
  private roots = new Map<string, string>()
  private active = new Map<string, string>()
  private exported = new Set<string>()
  constructor(private exporter?: SpanExporter, private maxTraces = 200) {}

  spans(traceId: string): Span[] { return this.traces.get(traceId) ?? [] }

  private push(s: Span) {
    if (!this.traces.has(s.traceId)) {
      this.traces.set(s.traceId, [])
      if (this.traces.size > this.maxTraces) this.traces.delete(this.traces.keys().next().value!)
    }
    this.traces.get(s.traceId)!.push(s)
    return s
  }

  /** Opens the root span of an agent run. */
  begin(traceId: string, name: string, attributes: Record<string, AttrValue>): Span {
    const s = this.push({ traceId, spanId: hex(16), name, kind: 'internal', start: Date.now(), attributes, status: 'unset' })
    this.roots.set(traceId, s.spanId)
    return s
  }

  /** Closes a span and exports the trace's finished spans. */
  async finish(s: Span, status: 'ok' | 'error' = 'ok', error?: string) {
    s.end = Date.now(); s.status = status; if (error) s.error = error
    if (this.exporter && s.spanId === this.roots.get(s.traceId)) {
      const fresh = this.spans(s.traceId).filter((x) => x.end && !this.exported.has(x.spanId))
      fresh.forEach((x) => this.exported.add(x.spanId))
      await this.exporter.export(fresh).catch(() => undefined)
    }
  }

  /** A graph step: child of the root; model and tool calls inside it become its children. */
  async step<T>(traceId: string | undefined, name: string, fn: () => Promise<T>, attrs: Record<string, AttrValue> = {}): Promise<T> {
    if (!traceId) return fn()
    const s = this.push({ traceId, spanId: hex(16), parentSpanId: this.roots.get(traceId), name, kind: 'internal', start: Date.now(), attributes: { 'gen_ai.operation.name': 'invoke_agent', 'app.step': name, ...attrs }, status: 'unset' })
    this.active.set(traceId, s.spanId)
    try { const r = await fn(); s.end = Date.now(); s.status = 'ok'; return r } catch (e) { s.end = Date.now(); s.status = 'error'; s.error = (e as Error).message; throw e } finally { this.active.delete(traceId) }
  }

  /** A model or tool call made inside the current step. */
  async call<T>(traceId: string | undefined, name: string, attrs: Record<string, AttrValue>, fn: () => Promise<T>, after?: (r: T) => Record<string, AttrValue>): Promise<T> {
    if (!traceId) return fn()
    const s = this.push({ traceId, spanId: hex(16), parentSpanId: this.active.get(traceId) ?? this.roots.get(traceId), name, kind: 'client', start: Date.now(), attributes: attrs, status: 'unset' })
    try { const r = await fn(); Object.assign(s.attributes, after?.(r) ?? {}); s.end = Date.now(); s.status = 'ok'; return r } catch (e) { s.end = Date.now(); s.status = 'error'; s.error = (e as Error).message; throw e }
  }
}

/** OTLP/HTTP JSON exporter. endpoint = base URL (…/v1/traces is appended); headers e.g. Authorization=Api-Token … */
export function otlpHttpExporter(endpoint: string, headers: Record<string, string> = {}, serviceName = 'product-journey-agent'): SpanExporter {
  const attr = (k: string, v: AttrValue) => ({ key: k, value: typeof v === 'boolean' ? { boolValue: v } : typeof v === 'number' ? (Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v }) : { stringValue: v } })
  return {
    async export(spans) {
      if (!spans.length) return
      const body = {
        resourceSpans: [{
          resource: { attributes: [attr('service.name', serviceName)] },
          scopeSpans: [{
            scope: { name: 'product-journey/agent' },
            spans: spans.map((s) => ({
              traceId: s.traceId, spanId: s.spanId, ...(s.parentSpanId ? { parentSpanId: s.parentSpanId } : {}), name: s.name,
              kind: s.kind === 'client' ? 3 : 1, startTimeUnixNano: String(s.start * 1e6), endTimeUnixNano: String((s.end ?? s.start) * 1e6),
              attributes: Object.entries(s.attributes).map(([k, v]) => attr(k, v)),
              status: { code: s.status === 'error' ? 2 : s.status === 'ok' ? 1 : 0, ...(s.error ? { message: s.error } : {}) },
            })),
          }],
        }],
      }
      await fetch(`${endpoint.replace(/\/$/, '')}/v1/traces`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) })
    },
  }
}

/** Parses OTEL_EXPORTER_OTLP_HEADERS ("k1=v1,k2=v2"). */
export const parseOtlpHeaders = (s = '') => Object.fromEntries(s.split(',').map((p) => p.trim()).filter(Boolean).map((p) => { const i = p.indexOf('='); return [p.slice(0, i).trim(), decodeURIComponent(p.slice(i + 1).trim())] }))

/** Rough token estimate (chars / 4), recorded as app.* so it is never mistaken for billed usage. */
export const estTokens = (s: string) => Math.ceil(s.length / 4)

/** Model calls as `chat` spans: model, schema, estimated tokens. */
export function tracedLlm(llm: AgentLlm, tracer: Tracer, provider: string): AgentLlm {
  return {
    name: llm.name,
    structured: <T>(schema: Parameters<AgentLlm['structured']>[0], system: string, user: string, meta?: { traceId?: string }) =>
      tracer.call(meta?.traceId, `chat ${llm.name}`, { 'gen_ai.operation.name': 'chat', 'gen_ai.provider.name': provider, 'gen_ai.request.model': llm.name, 'app.schema': schema, 'app.estimated_input_tokens': estTokens(system + user) },
        () => llm.structured<T>(schema, system, user, meta), (r) => ({ 'app.estimated_output_tokens': estTokens(JSON.stringify(r)) })),
  }
}

/** Tool calls (MCP, snapshot, knowledge base) as `execute_tool` spans. */
export function tracedTools(tools: ToolRunner, tracer: Tracer): ToolRunner {
  return {
    op: (op, params, meta) => tracer.call(meta?.traceId, `execute_tool ${op}`, { 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': op },
      () => tools.op(op, params, meta), (r) => ({ 'app.tool.ok': r.ok, 'app.tool.server': r.server ?? '', 'app.tool.name': r.tool ?? '' })),
  }
}

/** Compact view of a trace for the UI and API. */
export const traceSummary = (spans: Span[]) => spans.map((s) => ({ name: s.name, parent: s.parentSpanId ?? null, id: s.spanId, ms: s.end ? s.end - s.start : null, status: s.status, attrs: s.attributes, error: s.error }))
