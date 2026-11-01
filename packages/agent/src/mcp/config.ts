// Loads MCP server definitions. Same shape as Cursor's .cursor/mcp.json so one file serves both:
// { "mcpServers": { "<name>": { "command", "args", "env" } | { "url", "headers" } },
//   "sources": { "dynatrace": "<name>" }, "collect": ["dynatrace", "argocd"] }
// ${env:VAR} placeholders are replaced from the process environment.

import { existsSync, readFileSync } from 'node:fs'
import type { SourceName } from '../types'

export interface McpServerConfig {
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
  disabled?: boolean
}

export interface McpConfig {
  mcpServers: Record<string, McpServerConfig>
  sources?: Partial<Record<SourceName, string>>
  collect?: SourceName[]
}

export function substituteEnv<T>(value: T, env: NodeJS.ProcessEnv = process.env): T {
  if (typeof value === 'string') return value.replace(/\$\{env:([A-Z0-9_]+)\}/gi, (_, k: string) => env[k] ?? '') as T
  if (Array.isArray(value)) return value.map((v) => substituteEnv(v, env)) as T
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substituteEnv(v, env)])) as T
  return value
}

export function loadMcpConfig(path: string | undefined, env: NodeJS.ProcessEnv = process.env): McpConfig | undefined {
  if (!path || !existsSync(path)) return undefined
  const raw = JSON.parse(readFileSync(path, 'utf8')) as McpConfig
  const cfg = substituteEnv(raw, env)
  cfg.mcpServers = Object.fromEntries(Object.entries(cfg.mcpServers ?? {}).filter(([, s]) => !s.disabled && (s.command || s.url)))
  return cfg
}
