// Phase 2: per-change journey from merge to verified in production.

import type { Dataset, Journey, JourneyStage, JourneyStageName, PipelineRun } from './types'
import { correlateProblems } from './failures'
import { hoursBetween, minutesBetween } from './util'

export const STAGE_LABEL: Record<JourneyStageName, string> = {
  merged: 'Merged', build: 'Build', test: 'Test', scan: 'Scan', staging: 'Staging', change: 'Change', prod: 'Prod', verified: 'Verified',
}
export const STAGE_ORDER: JourneyStageName[] = ['merged', 'build', 'test', 'scan', 'staging', 'change', 'prod', 'verified']

const runStage = (name: JourneyStageName, r?: PipelineRun): JourneyStage => {
  if (!r) return { name, status: 'pending' }
  return {
    name, status: r.status === 'succeeded' ? 'done' : r.status === 'failed' ? 'failed' : r.status === 'running' ? 'running' : 'skipped',
    at: r.finishedAt ?? r.startedAt, durationMin: r.finishedAt ? Math.round(minutesBetween(r.startedAt, r.finishedAt)) : undefined,
    detail: r.failureText, url: r.url,
  }
}

export function buildJourneys(ds: Dataset): Journey[] {
  const productOfRepo = new Map(ds.products.flatMap((p) => p.repos.map((r) => [r, p.id] as const)))
  const problemDep = correlateProblems(ds)
  const problemsByDep = new Map<string, typeof ds.problems>()
  for (const p of ds.problems) {
    const d = problemDep.get(p.id)
    if (d) problemsByDep.set(d.id, [...(problemsByDep.get(d.id) ?? []), p])
  }
  const key = (repo: string, sha: string) => `${repo}|${sha}`
  const runs = new Map<string, PipelineRun[]>()
  for (const r of ds.pipelineRuns) runs.set(key(r.repo, r.sha), [...(runs.get(key(r.repo, r.sha)) ?? []), r])
  const latest = (xs: PipelineRun[], pred: (r: PipelineRun) => boolean) => xs.filter(pred).sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0]

  return ds.merges.map((m): Journey => {
    const productId = productOfRepo.get(m.repo) ?? ''
    const rs = runs.get(key(m.repo, m.sha)) ?? []
    const stages: JourneyStage[] = [{ name: 'merged', status: 'done', at: m.mergedAt, detail: `PR #${m.prNumber} +${m.additions}/-${m.deletions}` }]
    stages.push(runStage('build', latest(rs, (r) => r.stage === 'build')))
    stages.push(runStage('test', latest(rs, (r) => r.stage === 'test')))
    stages.push(runStage('scan', latest(rs, (r) => r.stage === 'scan')))
    stages.push(runStage('staging', latest(rs, (r) => r.stage === 'deploy' && r.environment === 'staging')))

    const cr = ds.changeRequests.find((c) => c.sha === m.sha && c.productId === productId)
    if (!cr) stages.push({ name: 'change', status: 'pending' })
    else {
      const done = !!cr.approvedAt
      stages.push({
        name: 'change', status: done ? 'done' : cr.state === 'canceled' ? 'failed' : 'running', at: cr.approvedAt ?? cr.createdAt,
        durationMin: cr.approvedAt ? Math.round(minutesBetween(cr.createdAt, cr.approvedAt)) : undefined,
        detail: `${cr.number} · ${cr.type} · risk ${cr.risk} · ${cr.state}`,
      })
    }

    const prodDep = ds.deployments.filter((d) => d.sha === m.sha && d.repo === m.repo && d.environment === 'prod').sort((a, b) => a.startedAt.localeCompare(b.startedAt))[0]
    const prodRun = latest(rs, (r) => r.stage === 'deploy' && r.environment === 'prod')
    if (prodDep) {
      stages.push({
        name: 'prod', status: prodDep.status === 'succeeded' ? 'done' : 'failed', at: prodDep.finishedAt,
        durationMin: Math.round(minutesBetween(prodDep.startedAt, prodDep.finishedAt)),
        detail: prodDep.status === 'succeeded' ? `${prodDep.version} live` : `${prodDep.status.replace('_', ' ')}: ${prodDep.failureText ?? ''}`,
      })
    } else stages.push(runStage('prod', prodRun))

    const probs = prodDep ? problemsByDep.get(prodDep.id) ?? [] : []
    if (prodDep?.status === 'succeeded') {
      stages.push(probs.length
        ? { name: 'verified', status: 'failed', at: probs[0].startedAt, detail: `${probs[0].displayId}: ${probs[0].title}` }
        : { name: 'verified', status: 'done', at: prodDep.finishedAt, detail: 'No Dynatrace problem within 60 min' })
    } else stages.push({ name: 'verified', status: 'pending' })

    const failedAt = stages.find((s) => s.status === 'failed')
    const delivered = prodDep?.status === 'succeeded'
    return {
      productId, repo: m.repo, sha: m.sha, prNumber: m.prNumber, title: m.title, author: m.author, mergedAt: m.mergedAt, stages,
      leadTimeHours: delivered ? hoursBetween(m.firstCommitAt, prodDep!.finishedAt) : undefined,
      outcome: delivered ? (probs.length ? 'delivered-with-incident' : 'delivered') : failedAt ? 'failed' : 'in-flight',
      blockedAt: failedAt?.name ?? (delivered ? undefined : stages.find((s) => s.status === 'running' || s.status === 'pending')?.name),
    }
  }).sort((a, b) => b.mergedAt.localeCompare(a.mergedAt))
}

/** Stage funnel: how many changes reached and passed each stage. */
export function stageFunnel(journeys: Journey[]) {
  return STAGE_ORDER.map((name) => {
    const st = journeys.map((j) => j.stages.find((s) => s.name === name)!)
    const durations = st.filter((s) => s.durationMin != null).map((s) => s.durationMin!)
    return {
      name,
      reached: st.filter((s) => s.status !== 'pending').length,
      passed: st.filter((s) => s.status === 'done').length,
      failed: st.filter((s) => s.status === 'failed').length,
      running: st.filter((s) => s.status === 'running').length,
      medianMin: durations.length ? [...durations].sort((a, b) => a - b)[Math.floor(durations.length / 2)] : undefined,
    }
  })
}
