// npm run docs:signals  -> regenerates docs/INTEGRATIONS.md from the signal catalogue (packages/core/src/signals.ts)
import { writeFileSync } from 'node:fs'
import { SIGNALS } from '@pj/core'

const TOOL: Record<string, string> = { dynatrace: 'Dynatrace (hub)', kubernetes: 'Kubernetes (EKS, AKS, GKE, any cluster)', aws: 'AWS', azure: 'Azure', gcp: 'Google Cloud', github: 'GitHub', argocd: 'Argo CD', servicenow: 'ServiceNow', any: 'Any other tool' }
const STATUS: Record<string, string> = { built: 'Built', 'built-optional': 'Built, opt-in', pattern: 'Pattern + template', catalogued: 'Catalogued, not consumed yet' }
const lines = [
  '# Integrations: every signal, every tool, and how it is reached',
  '',
  'Generated from `packages/core/src/signals.ts` by `npm run docs:signals`. Paths are tried in order: **dynatrace** (one DQL query when Dynatrace already collects the signal), **mcp** (the tool\'s official MCP server), **rest** (its API), **custom** (wrap any other tool once as an MCP server with `templates/custom-mcp-server`).',
  '',
  '## What "built" means, and what is not verified',
  '',
  '- **Built and tested:** paths not marked "listed" are called by the app, and their signals have dummy data in the tool\'s real format that the agent or the engines consume. CI runs the agent over all 12 failure types with these signals.\n- **Listed:** a documented route the app does not call yet (useful to Cursor agents through the same MCP servers, or a later phase).',
  '- **Not verified against live systems:** no path has run against a real tenant yet. DQL field names depend on your Dynatrace configuration (OpenPipeline, Operator version). MCP tool names are the candidates each server publishes; confirm with `GET /api/mcp/tools` and override under `toolMap` in `mcp.servers.json` (the first match is used).',
  '- **Licences:** ServiceNow\'s MCP Server Console and Now Assist need a Now Assist licence; the Copilot hand-off needs a paid Copilot plan with the coding agent enabled and `AGENT_WRITE_ALLOWLIST=<github server>:create_issue`; Dynatrace Intelligence agents depend on your Dynatrace contract.',
  '',
]
for (const tool of [...new Set(SIGNALS.map((s) => s.tool))]) {
  lines.push(`## ${TOOL[tool] ?? tool}`, '', '| Signal | Fields | Paths, in order | Used by | Status |', '| --- | --- | --- | --- | --- |')
  for (const s of SIGNALS.filter((x) => x.tool === tool)) {
    const paths = s.paths.map((p, i) => `${i + 1}. **${p.via}** ${p.how}${'tools' in p ? ` (\`${p.tools.join('`, `')}\`)` : ''}${p.listed ? ' _(listed, not called by the app yet)_' : ''}`).join('<br>')
    lines.push(`| ${s.name}${s.kind !== 'signal' ? ` _(${s.kind})_` : ''} | ${s.fields} | ${paths} | ${s.usedBy.join('; ')} | ${STATUS[s.status]} |`)
  }
  lines.push('')
}
writeFileSync(new URL('../docs/INTEGRATIONS.md', import.meta.url), lines.join('\n'))
console.log(`docs/INTEGRATIONS.md: ${SIGNALS.length} signals across ${new Set(SIGNALS.map((s) => s.tool)).size} tools`)
