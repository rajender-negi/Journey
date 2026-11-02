// What the user switched on or off in the Integrations screen. Stored in data/integrations.json.
//   mode 'demo': tools that aren't connected run on dummy data in their native schema (the showcase)
//   mode 'live': only real connections; anything not connected is dead (empty) on the map and in every view
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { SOURCES, config, type SourceName } from './config'

export interface IntegrationSettings { mode: 'demo' | 'live'; sourcesOff: SourceName[]; mcpOff: string[]; ideDiscovery: boolean }

const file = () => join(config.dataDir, 'integrations.json')
const defaults = (): IntegrationSettings => ({ mode: config.mode === 'live' ? 'live' : 'demo', sourcesOff: [], mcpOff: [], ideDiscovery: process.env.PJ_MCP_DISCOVERY !== 'off' })

let cached: IntegrationSettings | null = null
export function getSettings(): IntegrationSettings {
  if (cached) return cached
  try { cached = existsSync(file()) ? { ...defaults(), ...(JSON.parse(readFileSync(file(), 'utf8')) as Partial<IntegrationSettings>) } : defaults() } catch { cached = defaults() }
  return cached
}

export function saveSettings(patch: Partial<IntegrationSettings>): IntegrationSettings {
  const cur = getSettings()
  const next: IntegrationSettings = {
    mode: patch.mode === 'live' || patch.mode === 'demo' ? patch.mode : cur.mode,
    sourcesOff: Array.isArray(patch.sourcesOff) ? patch.sourcesOff.filter((s): s is SourceName => (SOURCES as string[]).includes(s)) : cur.sourcesOff,
    mcpOff: Array.isArray(patch.mcpOff) ? patch.mcpOff.map(String).slice(0, 100) : cur.mcpOff,
    ideDiscovery: typeof patch.ideDiscovery === 'boolean' ? patch.ideDiscovery : cur.ideDiscovery,
  }
  mkdirSync(config.dataDir, { recursive: true })
  writeFileSync(file(), JSON.stringify(next, null, 2))
  cached = next
  return next
}
