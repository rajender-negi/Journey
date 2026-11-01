// Browser-side edges of the agent, free of LangGraph so they are unit tested anywhere:
//   snapshotTools  answers the agent's MCP operations from native-schema records
//   withSnapshot   MCP first, snapshot for any source with no MCP server configured (server side)

import type { RawBundle } from '@pj/core'
import type { ToolRunner } from './evidence'
import type { Op } from './toolmap'
import { DEFAULT_TOOL_MAP } from './toolmap'

// ---------- snapshot tools: same operations as MCP, answered from native-schema records ----------

const SNAPSHOT = 'snapshot'
type Rec = Record<string, unknown>
const str = (v: unknown) => (v == null ? '' : String(v))

export function snapshotTools(raw: RawBundle): ToolRunner {
  const dt = raw.dynatrace
  const recs = (r: { result: { records: Rec[] } }) => r.result.records
  const toolFor = (op: Op) => DEFAULT_TOOL_MAP[op].candidates[0]
  const reply = (op: Op, params: Record<string, string>, data: unknown) => {
    const c = toolFor(op)
    const text = Array.isArray(data) && data.length === 0 ? '' : JSON.stringify(data, null, 1)
    return { ok: true, text, server: SNAPSHOT, tool: c.tool, args: c.args(params) }
  }
  return {
    async op(op, params) {
      switch (op) {
        case 'dql': {
          const q = params.query ?? ''
          const quoted = [...q.matchAll(/"([^"]*)"/g)].map((m) => m[1]).filter(Boolean)
          if (q.includes('dt.davis.problems')) {
            const rows = recs(dt.problems as never).filter((r) => quoted.includes(str(r['event.id'])) || quoted.includes(str(r['display_id'])))
            return reply(op, params, { records: rows })
          }
          if (q.includes('SDLC_EVENT')) {
            const rows = recs(dt.sdlcEvents as never).filter((r) => quoted.includes(str(r['vcs.ref.head.revision'])))
            return reply(op, params, { records: rows.slice(0, 20) })
          }
          if (q.startsWith('timeseries')) {
            // the snapshot holds per-service aggregates, not 5-minute series: return the service's record
            const svc = quoted[quoted.length - 1]
            const rows = recs(dt.serviceMetrics as never).filter((r) => str(r['service.name']) === svc)
            return reply(op, params, { records: rows, note: 'snapshot: 30-day service aggregates' })
          }
          return { ok: false, text: '', error: 'query not in snapshot' }
        }
        case 'argo_app': {
          const app = raw.argocd.applications.find((a) => a.metadata.name === params.app)
          return app ? reply(op, params, app) : { ok: false, text: '', error: `application ${params.app} not found` }
        }
        case 'k8s_events':
          return reply(op, params, raw.kubernetes.events.filter((e) => e.metadata.namespace === params.namespace || e.involvedObject.namespace === params.namespace))
        case 'pr_files': {
          const key = `${params.repo}#${params.prNumber}`
          const pr = raw.github.pulls.find((p) => String(p.number) === params.prNumber)
          const commits = raw.github.prCommits[key] ?? []
          return pr ? reply(op, params, { pull: pr, commits }) : { ok: false, text: '', error: `PR ${key} not found` }
        }
        case 'job_log': {
          const job = raw.github.jobs.find((j) => String(j.id) === params.jobId)
          const ann = raw.github.annotations[params.jobId] ?? []
          return job ? reply(op, params, { job, annotations: ann }) : { ok: false, text: '', error: `job ${params.jobId} not found` }
        }
        default:
          return { ok: false, text: '', error: `${op} not in snapshot` }
      }
    },
  }
}

/**
 * MCP where a server is configured for the source; the loaded native-schema data otherwise.
 * Real MCP failures (timeouts, refusals) are returned as failures, never papered over.
 */
export function withSnapshot(primary: ToolRunner | null, snapshot: () => ToolRunner): ToolRunner {
  return {
    async op(op, params) {
      if (primary) {
        const r = await primary.op(op, params)
        if (r.ok || !/^no MCP server configured/.test(r.error ?? '')) return r
      }
      return snapshot().op(op, params)
    },
  }
}
