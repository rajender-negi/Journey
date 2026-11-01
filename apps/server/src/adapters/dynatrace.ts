// Dynatrace Grail via the platform query API. Same DQL the Cursor agent runs through the Dynatrace MCP server.
import type { DqlResult, RawBundle } from '@pj/core'
import { DQL } from '@pj/core'
import { config } from '../config'
import { getJson } from './http'

async function runDql(query: string): Promise<DqlResult> {
  const H = { Authorization: `Bearer ${config.dynatrace.token}`, 'Content-Type': 'application/json' }
  const base = `${config.dynatrace.url!.replace(/\/$/, '')}/platform/storage/query/v1`
  let res = await getJson<DqlResult & { requestToken?: string }>(`${base}/query:execute`, H, {
    method: 'POST', body: JSON.stringify({ query, requestTimeoutMilliseconds: 30_000, maxResultRecords: 100_000 }),
  })
  for (let i = 0; res.state === 'RUNNING' && res.requestToken && i < 30; i++) {
    await new Promise((r) => setTimeout(r, 1000))
    res = await getJson(`${base}/query:poll?request-token=${encodeURIComponent(res.requestToken)}`, H)
  }
  if (res.state !== 'SUCCEEDED') throw new Error(`DQL did not succeed: ${res.state}`)
  return res
}

export async function fetchDynatrace(): Promise<RawBundle['dynatrace']> {
  const [problems, sdlcEvents, serviceMetrics, workloads, dora, billing] = await Promise.all([
    runDql(DQL.problems), runDql(DQL.sdlcEvents), runDql(DQL.serviceMetrics), runDql(DQL.workloads), runDql(DQL.dora), runDql(DQL.billing),
  ])
  return { problems, sdlcEvents, serviceMetrics, workloads, dora, billing }
}
