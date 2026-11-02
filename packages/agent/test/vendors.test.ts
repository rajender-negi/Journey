// Vendor agents as investigators, this app as referee: claims from each vendor's own format,
// corroboration against raw data, conflict resolution, and the design fix.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { analyze, buildFixtureDataset, emitRawBundle, mapRawBundle } from '@pj/core'
import { buildContext, categorize, designFix, extractClaim, fetchVendorEvidence, judgeClaims, snapshotTools, VENDOR_AGENTS, type Evidence } from '../src/index'

const raw = emitRawBundle(buildFixtureDataset(Date.parse('2026-11-01T03:30:00Z')))
const a = analyze(mapRawBundle(raw))
const agent = (id: string) => VENDOR_AGENTS.find((v) => v.id === id)!
const first = (rule: string) => a.failures.find((f) => f.recommendation.ruleId === rule)!

describe('vendor agents', () => {
  it('reads a claim from each vendor format', () => {
    assert.equal(extractClaim(agent('aws-devops-agent'), { records: [{ recordType: 'root_cause_analysis_md', content: 'ModifyDBInstance changed the instance class' }] })?.category, 'infrastructure-change')
    assert.equal(extractClaim(agent('azure-sre-agent'), { messages: [{ role: 'user', content: 'why' }, { role: 'assistant', content: 'Container was OOMKilled at the memory limit' }] })?.category, 'capacity')
    assert.equal(extractClaim(agent('gemini-cloud-assist'), { hypotheses: [{ title: 'low', text: 'timeout to upstream', confidence: 0.2 }, { title: 'ErrImagePull', text: 'manifest unknown', confidence: 0.9 }] })?.category, 'image')
    assert.equal(extractClaim(agent('k8sgpt'), { results: [{ kind: 'Pod', name: 'ns/p', error: [{ Text: 'CreateContainerConfigError: configmap app-config not found' }] }] })?.category, 'config')
    assert.equal(extractClaim(agent('k8sgpt'), { status: 'OK', results: [] }), null)
    assert.equal(categorize('nothing useful'), 'unknown')
  })

  it('asks only the agents that apply, and every answer is judged against raw data', async () => {
    const f = first('FX-NON-CHANGE')
    const ctx = buildContext(a, f.id)
    const ev = await fetchVendorEvidence(ctx, snapshotTools(raw, a))
    assert.ok(ev.some((e) => e.claim?.agent === 'dynatrace-intelligence'))
    assert.ok(!ev.some((e) => e.claim?.agent === 'gemini-cloud-assist') || ctx.clouds?.includes('gcp'))
    // no raw data yet: nothing is corroborated, so nothing wins
    const ids = ev.map((e, i) => ({ ...e, id: `E${i + 1}` }))
    assert.equal(judgeClaims(ctx, ids).winner, null)
  })

  it('the better-backed claim wins a conflict; the other is overruled', () => {
    const ctx = buildContext(a, first('FX-NON-CHANGE').id)
    const ev: Evidence[] = [
      { id: 'E1', kind: 'vendor_assessment', source: 'aws', ok: true, summary: '', at: '', data: '', claim: { agent: 'aws-devops-agent', name: 'AWS DevOps Agent', layer: 'cloud', category: 'infrastructure-change', cause: 'ModifyDBInstance failover dropped connections' } },
      { id: 'E2', kind: 'vendor_assessment', source: 'servicenow', ok: true, summary: '', at: '', data: '', claim: { agent: 'now-assist', name: 'ServiceNow Now Assist', layer: 'itsm', category: 'deployment', cause: 'similar to a bad release' } },
      { id: 'E3', kind: 'cloud_changes', source: 'aws', ok: true, summary: '', at: '', data: '{"EventName":"ModifyDBInstance"}' },
      { id: 'E4', kind: 'dt_problem', source: 'dynatrace', ok: true, summary: '', at: '', data: 'AWS RDS failover' },
      { id: 'E5', kind: 'argo_app', source: 'argocd', ok: true, summary: '', at: '', data: '{"sync":{"revision":"abc"}}' },
    ]
    const { verdicts, winner } = judgeClaims(ctx, ev)
    assert.equal(winner?.agent, 'aws-devops-agent')
    assert.equal(verdicts.find((v) => v.agent === 'now-assist')?.status, 'overruled')
    // the cause names a code-level fix (survive failover) and the category adds the infrastructure one
    const fix = designFix(a, ctx, winner)
    assert.equal(fix?.patternId, 'resilience')
    assert.equal(fix?.also?.patternId, 'infra-pipeline')
  })

  it('the design fix links the product\'s own code findings', () => {
    const code = a.code.find((c) => c.ruleId === 'CODE-N-PLUS-ONE')
    if (!code) return
    const f = a.failures.find((x) => x.productId === code.productId) ?? first('FX-REGRESSION-SLOW')
    const ctx = buildContext(a, f.id)
    const fix = designFix(a, ctx, { agent: 'dynatrace-intelligence', name: 'Dynatrace Intelligence', layer: 'runtime', category: 'deployment', cause: 'database calls per request up from 6 to 19', evidenceId: 'E1', corroboratedBy: ['E2'], status: 'corroborated', note: '' })
    assert.equal(fix?.patternId, 'batch-reads')
    assert.ok(fix!.codeFindings.some((c) => c.ruleId === 'CODE-N-PLUS-ONE'))
  })
})
