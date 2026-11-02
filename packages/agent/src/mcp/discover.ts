// Finds the MCP servers already configured in the user's IDEs and AI apps, so they are set up once.
// Read in order of precedence (a later file wins when two define the same server name):
//   user level:    Claude Desktop, Windsurf, Kiro, Cursor (~/.cursor/mcp.json), VS Code user mcp.json
//   project level: .vscode/mcp.json, .kiro/settings/mcp.json, .cursor/mcp.json
//   the app:       mcp.servers.json (or PJ_MCP_CONFIG), which also holds sources, collect and toolMap
// Formats: "mcpServers" (Cursor, Claude Desktop, Kiro, Windsurf) and "servers" with "type" (VS Code).
// ${env:VAR} and ${workspaceFolder} are resolved; servers using VS Code ${input:...} prompts are skipped
// (they need a person to type the value) and reported.

import { existsSync, readFileSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { join } from 'node:path'
import type { McpConfig, McpServerConfig } from './config'

export interface DiscoveredFile { path: string; app: string; scope: 'user' | 'project' | 'app'; servers: string[]; error?: string }
export interface Discovery {
  config: McpConfig
  origin: Record<string, { app: string; path: string }>
  files: DiscoveredFile[]
  skipped: { server: string; app: string; reason: string }[]
}

type RawServer = McpServerConfig & { type?: string; serverUrl?: string; httpUrl?: string }

/** Where each app keeps its MCP config on this OS. */
export function candidateFiles(root: string, home = homedir(), os = platform(), env: NodeJS.ProcessEnv = process.env): { path: string; app: string; scope: DiscoveredFile['scope'] }[] {
  const appData = env.APPDATA ?? join(home, 'AppData', 'Roaming')
  const userCfg = os === 'darwin' ? join(home, 'Library', 'Application Support') : os === 'win32' ? appData : join(home, '.config')
  return [
    { app: 'Claude Desktop', scope: 'user', path: join(userCfg, 'Claude', 'claude_desktop_config.json') },
    { app: 'Windsurf', scope: 'user', path: join(home, '.codeium', 'windsurf', 'mcp_config.json') },
    { app: 'Kiro', scope: 'user', path: join(home, '.kiro', 'settings', 'mcp.json') },
    { app: 'Cursor', scope: 'user', path: join(home, '.cursor', 'mcp.json') },
    { app: 'VS Code', scope: 'user', path: join(userCfg, 'Code', 'User', 'mcp.json') },
    { app: 'VS Code', scope: 'project', path: join(root, '.vscode', 'mcp.json') },
    { app: 'Kiro', scope: 'project', path: join(root, '.kiro', 'settings', 'mcp.json') },
    { app: 'Cursor', scope: 'project', path: join(root, '.cursor', 'mcp.json') },
  ]
}

const subst = (v: unknown, env: NodeJS.ProcessEnv, root: string): unknown => {
  if (typeof v === 'string') return v.replace(/\$\{env:([A-Za-z0-9_]+)\}/g, (_, k: string) => env[k] ?? '').replace(/\$\{workspaceFolder\}/g, root).replace(/\$\{userHome\}/g, homedir())
  if (Array.isArray(v)) return v.map((x) => subst(x, env, root))
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, subst(x, env, root)]))
  return v
}

/** One server entry in any of the supported formats -> the app's shape (stdio or remote). */
export function normalizeServer(s: RawServer): McpServerConfig | null {
  if (s.disabled) return null
  const url = s.url ?? s.serverUrl ?? s.httpUrl
  if (s.type === 'http' || s.type === 'sse' || s.type === 'streamable-http' || (!s.command && url)) return url ? { url, headers: s.headers } : null
  if (s.command) return { command: s.command, args: s.args ?? [], env: s.env }
  return null
}

export function discoverMcp(opts: { root: string; appConfigPath?: string; env?: NodeJS.ProcessEnv; home?: string; os?: NodeJS.Platform; extraPaths?: string[]; disabled?: string[]; ideDiscovery?: boolean }): Discovery {
  const env = opts.env ?? process.env
  const out: Discovery = { config: { mcpServers: {} }, origin: {}, files: [], skipped: [] }
  const files = [
    ...(opts.ideDiscovery === false ? [] : candidateFiles(opts.root, opts.home, opts.os, env)),
    ...(opts.extraPaths ?? []).map((path) => ({ path, app: 'extra', scope: 'project' as const })),
    ...(opts.appConfigPath ? [{ path: opts.appConfigPath, app: 'Product Journey', scope: 'app' as const }] : []),
  ]
  for (const f of files) {
    if (!existsSync(f.path)) continue
    const rec: DiscoveredFile = { ...f, servers: [] }
    out.files.push(rec)
    try {
      const raw = JSON.parse(readFileSync(f.path, 'utf8')) as { mcpServers?: Record<string, RawServer>; servers?: Record<string, RawServer> } & Partial<McpConfig>
      const entries = { ...(raw.servers ?? {}), ...(raw.mcpServers ?? {}) }
      for (const [name, entry] of Object.entries(entries)) {
        if (JSON.stringify(entry).includes('${input:')) { out.skipped.push({ server: name, app: f.app, reason: 'uses VS Code ${input:...} prompts; set the value with ${env:...} instead' }); continue }
        const norm = normalizeServer(subst(entry, env, opts.root) as RawServer)
        if (!norm) { if (!entry.disabled) out.skipped.push({ server: name, app: f.app, reason: 'no command or url' }); continue }
        out.config.mcpServers[name] = norm
        out.origin[name] = { app: f.app, path: f.path }
        rec.servers.push(name)
      }
      if (f.scope === 'app') {
        if (raw.sources) out.config.sources = raw.sources
        if (raw.collect) out.config.collect = raw.collect
        if ((raw as { toolMap?: unknown }).toolMap) (out.config as unknown as { toolMap: unknown }).toolMap = (raw as { toolMap?: unknown }).toolMap
      }
    } catch (e) {
      rec.error = (e as Error).message.slice(0, 200)
    }
  }
  for (const name of opts.disabled ?? []) { delete out.config.mcpServers[name] }
  return out
}
