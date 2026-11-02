// The agent's knowledge base: past incidents, runbooks and approved investigations, chunked,
// embedded and searched with keyword + vector search. Pattern: Uber Genie (RAG for on-call
// engineers, answers cite their source) plus long-term memory from approved outcomes.
//
// Sources are ServiceNow-shaped records (incident and kb_knowledge tables). Until ServiceNow is
// connected they are generated from the analysis' own past failures: the same native-schema
// approach as every other dummy source.

import type { Analysis } from '@pj/core'
import { chunkByHeading, chunkRecord, type Chunk } from './chunk'
import { Bm25, hashingEmbedder, InMemoryVectorStore, rrf, type Embedder, type VectorStore } from './search'

/** ServiceNow incident table fields the knowledge base reads. */
export interface SnowIncident {
  sys_id: string; number: string; short_description: string; description: string; category: string
  cmdb_ci: string; u_business_application: string; opened_at: string; resolved_at: string
  close_code: string; close_notes: string; u_rule_id: string
}
/** ServiceNow kb_knowledge fields the knowledge base reads (text is the article body). */
export interface SnowKbArticle { sys_id: string; number: string; short_description: string; text: string; kb_category: string; u_rule_id: string }

export interface KnowledgeHit { ref: string; source: Chunk['source']; title: string; productId?: string; sameProduct: boolean; at?: string; score: number; via: string; snippet: string; resolution?: string }

const pad = (n: number, w: number) => String(n).padStart(w, '0')

/** Dummy ServiceNow records in native shape, from the analysis' failures and rule catalogue. */
export function knowledgeFixtures(a: Analysis): { incidents: SnowIncident[]; articles: SnowKbArticle[] } {
  const products = new Map(a.dataset.products.map((p) => [p.id, p]))
  const incidents = a.failures.map((f, i) => {
    const p = products.get(f.productId)
    const r = f.recommendation
    const resolved = new Date(Date.parse(f.at) + (45 + (i % 7) * 20) * 60_000).toISOString()
    return {
      sys_id: `inc-${f.id}`, number: `INC${pad(1_041_000 + i, 7)}`,
      short_description: `${f.category} on ${p?.name ?? f.productId}`,
      description: f.evidence, category: f.category, cmdb_ci: p?.services[0] ?? '', u_business_application: f.productId,
      opened_at: f.at, resolved_at: resolved, close_code: 'Solved (Permanently)',
      close_notes: `Restored: ${r.fixNow[0] ?? 'see runbook'}. Follow-up: ${r.prevent[0] ?? 'none recorded'}.`,
      u_rule_id: r.ruleId,
    }
  })
  const seen = new Set<string>()
  const articles: SnowKbArticle[] = []
  for (const f of a.failures) {
    const r = f.recommendation
    if (seen.has(r.ruleId)) continue
    seen.add(r.ruleId)
    articles.push({
      sys_id: `kb-${r.ruleId}`, number: `KB${pad(10_100 + articles.length, 7)}`, short_description: `Runbook: ${r.title}`, kb_category: 'Runbook', u_rule_id: r.ruleId,
      text: [`# ${r.title}`, '', r.summary, '', '## Symptoms', '', f.category, '', '## Restore service', '', ...r.fixNow.map((x) => `- ${x}`), '', '## Prevent recurrence', '', ...r.prevent.map((x) => `- ${x}`), '', '## References', '', ...r.references.map((x) => `- ${x.title}`)].join('\n'),
    })
  }
  return { incidents, articles }
}

export interface ApprovedInvestigation { runId: string; findingId: string; productId: string; service?: string; ruleId: string; at: string; headline: string; rootCause: string; actions: string[]; decision: 'approve' | 'reject'; by: string }

export class KnowledgeBase {
  private bm25 = new Bm25()
  private chunks: Chunk[] = []
  constructor(readonly embedder: Embedder = hashingEmbedder(), private store: VectorStore = new InMemoryVectorStore()) {}

  get size() { return this.chunks.length }
  get docs() { return new Set(this.chunks.map((c) => c.docId)).size }

  async add(chunks: Chunk[]) {
    if (!chunks.length) return
    const vectors = await this.embedder.embed(chunks.map((c) => `${c.title}\n${c.text}`))
    await this.store.upsert(chunks.map((chunk, i) => ({ chunk, vector: vectors[i] })))
    this.bm25.add(chunks)
    this.chunks.push(...chunks)
  }

  async addSnow(incidents: SnowIncident[], articles: SnowKbArticle[]) {
    await this.add([
      ...incidents.map((x) => chunkRecord(x.sys_id, 'incident', `${x.number} ${x.short_description}`,
        { description: x.description, category: x.category, service: x.cmdb_ci, resolution: x.close_notes },
        { productId: x.u_business_application, service: x.cmdb_ci, ruleId: x.u_rule_id, at: x.resolved_at, ref: x.number, resolution: x.close_notes })),
      ...articles.flatMap((x) => chunkByHeading(x.sys_id, 'runbook', `${x.number} ${x.short_description}`, x.text, { ruleId: x.u_rule_id, ref: x.number })),
    ])
  }

  /** Long-term memory: only approved outcomes become precedent. */
  async remember(inv: ApprovedInvestigation) {
    if (inv.decision !== 'approve') return
    await this.add([chunkRecord(`inv-${inv.runId}`, 'investigation', `Approved investigation: ${inv.headline}`,
      { root_cause: inv.rootCause, actions: inv.actions.join('; '), approved_by: inv.by },
      { productId: inv.productId, service: inv.service, ruleId: inv.ruleId, at: inv.at, ref: inv.runId, resolution: inv.actions[0] })])
  }

  /**
   * Hybrid search: BM25 and vector top 30 each, merged by reciprocal rank fusion. Metadata filters run
   * before ranking: runbooks always; incidents and investigations only if resolved before `before`, never
   * the finding being investigated. Same product ranks higher than other products.
   */
  async search(query: string, opts: { k?: number; productId?: string; before?: string; excludeDocIds?: string[] } = {}): Promise<KnowledgeHit[]> {
    const k = opts.k ?? 5
    const exclude = new Set(opts.excludeDocIds ?? [])
    const filter = (c: Chunk) => !exclude.has(c.docId) && (c.source === 'runbook' || !opts.before || (!!c.meta.at && c.meta.at < opts.before))
    const [qv] = await this.embedder.embed([query])
    const lexical = this.bm25.search(query, 30, filter)
    const vector = await this.store.search(qv, 30, filter)
    const fused = rrf([lexical, vector]).map((x) => ({ ...x, score: x.score * (opts.productId && x.chunk.meta.productId === opts.productId ? 1.5 : 1) }))
      .sort((a, b) => b.score - a.score)
    // diversify: near-identical incidents must not crowd out the procedure, so the best runbook
    // always takes the second slot (or the first, if it ranks first anyway)
    const firstRunbook = fused.findIndex((x) => x.chunk.source === 'runbook')
    if (firstRunbook > 1) fused.splice(1, 0, fused.splice(firstRunbook, 1)[0])
    // a human-approved investigation is the strongest precedent: the best matching one goes first
    const firstApproved = fused.findIndex((x) => x.chunk.source === 'investigation')
    if (firstApproved > 0) fused.unshift(fused.splice(firstApproved, 1)[0])
    const out: KnowledgeHit[] = []
    const docs = new Set<string>()
    for (const x of fused) {
      if (docs.has(x.chunk.docId)) continue // one hit per document
      docs.add(x.chunk.docId)
      out.push({
        ref: x.chunk.meta.ref ?? x.chunk.docId, source: x.chunk.source, title: x.chunk.title, productId: x.chunk.meta.productId,
        sameProduct: !!opts.productId && x.chunk.meta.productId === opts.productId, at: x.chunk.meta.at, score: Math.round(x.score * 1e4) / 1e4,
        via: [x.ranks[0] > 0 ? `keyword #${x.ranks[0]}` : '', x.ranks[1] > 0 ? `vector #${x.ranks[1]}` : ''].filter(Boolean).join(', '),
        snippet: x.chunk.text.slice(0, 280), resolution: x.chunk.meta.resolution,
      })
      if (out.length >= k) break
    }
    return out
  }

  /** Rule id behind a hit (for evaluation only; never shown to the model). */
  ruleOf(ref: string) { return this.chunks.find((c) => (c.meta.ref ?? c.docId) === ref)?.meta.ruleId }
}

/** Builds the knowledge base for an analysis from its ServiceNow-shaped records. */
export async function buildKnowledgeBase(a: Analysis, embedder?: Embedder, store?: VectorStore): Promise<KnowledgeBase> {
  const kb = new KnowledgeBase(embedder, store)
  const { incidents, articles } = knowledgeFixtures(a)
  await kb.addSnow(incidents, articles)
  return kb
}
