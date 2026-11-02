// Template: put any in-house or unsupported tool behind MCP once, and Cursor, Claude and Product
// Journey can all use it. Replace BASE_URL and the two tools with your tool's API; return the tool's
// own JSON (native schema), unchanged.
//   run:      npx tsx templates/custom-mcp-server/server.ts
//   register: add to mcp.servers.json  { "inhouse-deploys": { "command": "npx", "args": ["tsx", "templates/custom-mcp-server/server.ts"], "env": { "INHOUSE_URL": "${env:INHOUSE_URL}", "INHOUSE_TOKEN": "${env:INHOUSE_TOKEN}" } } }
//   map:      in mcp.servers.json "toolMap", point an operation (for example k8s_workload or a new one) at these tool names
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const BASE_URL = process.env.INHOUSE_URL ?? 'https://deploy-tool.internal.example'
const headers = { Authorization: `Bearer ${process.env.INHOUSE_TOKEN ?? ''}`, Accept: 'application/json' }

const server = new McpServer({ name: 'inhouse-deploys', version: '1.0.0' })

// read-only tools only: names start with list_ / get_, so the app's policy treats them as reads
server.registerTool(
  'list_deployments',
  { description: 'Deployments of a service since a time, in the deploy tool\'s own JSON.', inputSchema: { service: z.string(), since: z.string().optional() } },
  async ({ service, since }) => {
    const r = await fetch(`${BASE_URL}/api/deployments?service=${encodeURIComponent(service)}${since ? `&since=${encodeURIComponent(since)}` : ''}`, { headers, signal: AbortSignal.timeout(15_000) })
    if (!r.ok) return { isError: true, content: [{ type: 'text' as const, text: `deploy tool HTTP ${r.status}` }] }
    return { content: [{ type: 'text' as const, text: JSON.stringify(await r.json()) }] }
  },
)

server.registerTool(
  'get_deployment',
  { description: 'One deployment by id, with its steps and logs.', inputSchema: { id: z.string() } },
  async ({ id }) => {
    const r = await fetch(`${BASE_URL}/api/deployments/${encodeURIComponent(id)}`, { headers, signal: AbortSignal.timeout(15_000) })
    if (!r.ok) return { isError: true, content: [{ type: 'text' as const, text: `deploy tool HTTP ${r.status}` }] }
    return { content: [{ type: 'text' as const, text: JSON.stringify(await r.json()) }] }
  },
)

await server.connect(new StdioServerTransport())
