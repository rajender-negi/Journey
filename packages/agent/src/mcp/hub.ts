// MCP client hub: one connection per configured server (stdio or Streamable HTTP, SSE fallback),
// tool discovery, read-only enforcement, timeouts and an audit trail of every call.
// The MCP SDK is loaded lazily so the rest of the app runs before `npm install` adds it.

import type { McpConfig, McpServerConfig } from './config'
import { cap, mayCall, mcpText } from '../policy'
import { resolveOp, type Op } from '../toolmap'
import type { SourceName } from '../types'

interface Conn {
  client: { callTool: (p: { name: string; arguments: Record<string, unknown> }, s?: unknown, o?: { timeout?: number }) => Promise<unknown>; close: () => Promise<void> }
  tools: Set<string>
}

export interface ServerStatus { name: string; ok: boolean; tools: number; error?: string; transport: 'stdio' | 'http' | 'sse' }
export interface AuditEntry { at: string; server: string; tool: string; args: Record<string, unknown>; ok: boolean; ms: number; error?: string }
export interface CallResult { ok: boolean; text: string; error?: string; server?: string; tool?: string; args?: Record<string, unknown> }

export class McpHub {
  private conns = new Map<string, Conn>()
  status: ServerStatus[] = []
  audit: AuditEntry[] = []
  constructor(private cfg: McpConfig, private writeAllowlist: string[] = [], private timeoutMs = 45_000) {}

  get sources(): Partial<Record<SourceName, string>> { return this.cfg.sources ?? {} }
  get collectSources(): SourceName[] { return this.cfg.collect ?? [] }

  async connect(): Promise<ServerStatus[]> {
    const sdk = await loadSdk()
    this.status = await Promise.all(Object.entries(this.cfg.mcpServers).map(([name, s]) => this.connectOne(sdk, name, s)))
    return this.status
  }

  private async connectOne(sdk: Sdk, name: string, s: McpServerConfig): Promise<ServerStatus> {
    const transport: ServerStatus['transport'] = s.url ? 'http' : 'stdio'
    try {
      const client = new sdk.Client({ name: 'product-journey', version: '1.0.0' })
      if (s.url) {
        try {
          await client.connect(new sdk.StreamableHTTPClientTransport(new URL(s.url), { requestInit: { headers: s.headers ?? {} } }))
        } catch {
          const legacy = new sdk.Client({ name: 'product-journey', version: '1.0.0' })
          await legacy.connect(new sdk.SSEClientTransport(new URL(s.url), { requestInit: { headers: s.headers ?? {} } }))
          return this.register(name, legacy, 'sse')
        }
      } else {
        const env = Object.fromEntries(Object.entries({ ...process.env, ...(s.env ?? {}) }).filter(([, v]) => typeof v === 'string')) as Record<string, string>
        await client.connect(new sdk.StdioClientTransport({ command: s.command!, args: s.args ?? [], env, stderr: 'ignore' }))
      }
      return this.register(name, client, transport)
    } catch (e) {
      return { name, ok: false, tools: 0, error: (e as Error).message.slice(0, 200), transport }
    }
  }

  private async register(name: string, client: SdkClient, transport: ServerStatus['transport']): Promise<ServerStatus> {
    const { tools } = await client.listTools()
    this.conns.set(name, { client: client as unknown as Conn['client'], tools: new Set(tools.map((t) => t.name)) })
    return { name, ok: true, tools: tools.length, transport }
  }

  available(): Map<string, Set<string>> {
    return new Map([...this.conns.entries()].map(([k, v]) => [k, v.tools]))
  }

  tools(): Record<string, string[]> {
    return Object.fromEntries([...this.conns.entries()].map(([k, v]) => [k, [...v.tools].sort()]))
  }

  async call(server: string, tool: string, args: Record<string, unknown>): Promise<CallResult> {
    const conn = this.conns.get(server)
    if (!conn) return { ok: false, text: '', error: `MCP server ${server} is not connected`, server, tool, args }
    const allowed = mayCall(server, tool, this.writeAllowlist)
    if (!allowed.ok) return { ok: false, text: '', error: allowed.reason, server, tool, args }
    const t0 = Date.now()
    try {
      const res = (await conn.client.callTool({ name: tool, arguments: args }, undefined, { timeout: this.timeoutMs })) as { isError?: boolean; content?: { type: string; text?: string }[]; structuredContent?: unknown }
      const text = mcpText(res)
      const ok = !res.isError
      this.log({ at: new Date().toISOString(), server, tool, args, ok, ms: Date.now() - t0, error: ok ? undefined : cap(text, 300) })
      return { ok, text: cap(text, 200_000), error: ok ? undefined : cap(text, 500), server, tool, args }
    } catch (e) {
      const error = (e as Error).message
      this.log({ at: new Date().toISOString(), server, tool, args, ok: false, ms: Date.now() - t0, error })
      return { ok: false, text: '', error, server, tool, args }
    }
  }

  /** Call a logical operation; the tool map picks the server and tool this tenant exposes. */
  async op(op: Op, params: Record<string, string>): Promise<CallResult> {
    const r = resolveOp(op, params, this.available(), this.sources)
    if ('error' in r) return { ok: false, text: '', error: r.error }
    return this.call(r.server, r.tool, r.args)
  }

  private log(e: AuditEntry) {
    this.audit.push(e)
    if (this.audit.length > 500) this.audit.splice(0, this.audit.length - 500)
  }

  async close() {
    await Promise.all([...this.conns.values()].map((c) => c.client.close().catch(() => undefined)))
    this.conns.clear()
  }
}

// ---- lazy SDK loading ----
type SdkClient = { connect: (t: unknown) => Promise<void>; listTools: () => Promise<{ tools: { name: string }[] }>; callTool: unknown; close: () => Promise<void> }
interface Sdk {
  Client: new (info: { name: string; version: string }) => SdkClient
  StdioClientTransport: new (p: { command: string; args: string[]; env: Record<string, string>; stderr?: string }) => unknown
  StreamableHTTPClientTransport: new (u: URL, o?: { requestInit?: RequestInit }) => unknown
  SSEClientTransport: new (u: URL, o?: { requestInit?: RequestInit }) => unknown
}

async function loadSdk(): Promise<Sdk> {
  try {
    const [c, stdio, http, sse] = await Promise.all([
      import('@modelcontextprotocol/sdk/client/index.js'),
      import('@modelcontextprotocol/sdk/client/stdio.js'),
      import('@modelcontextprotocol/sdk/client/streamableHttp.js'),
      import('@modelcontextprotocol/sdk/client/sse.js'),
    ])
    return { Client: c.Client, StdioClientTransport: stdio.StdioClientTransport, StreamableHTTPClientTransport: http.StreamableHTTPClientTransport, SSEClientTransport: sse.SSEClientTransport } as unknown as Sdk
  } catch (e) {
    throw new Error(`MCP SDK not installed (${(e as Error).message}). Run npm install.`)
  }
}
