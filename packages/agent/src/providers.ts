// Managed services as drop-in replacements for the built-in versions (server only; never bundled
// into the phone card). The built-in knowledge base, guard and tracer stay as the offline and demo
// fallback; in production these are chosen by configuration:
//   RAG_PROVIDER=azure-ai-search | bedrock-kb      -> managed retrieval instead of the local index
//   GUARDRAIL_PROVIDER=bedrock                     -> Amazon Bedrock Guardrails on tool output, in front of our own checks
// AWS SDK clients are imported only when selected, so nothing loads unless configured.

import type { ToolRunner } from './evidence'
import type { KnowledgeHit } from './rag/knowledge'

export interface KnowledgeProvider {
  name: string
  search(query: string, opts: { k?: number; productId?: string; before?: string; excludeDocIds?: string[] }): Promise<KnowledgeHit[]>
}

/**
 * Azure AI Search (hybrid: keyword + vector + optional semantic ranker, all server side).
 * Index fields expected: id, source (incident|runbook|investigation), title, content, product_id, at, resolution.
 */
export function azureAiSearchProvider(cfg: { endpoint: string; index: string; apiKey: string; semanticConfig?: string; apiVersion?: string }): KnowledgeProvider {
  return {
    name: `azure-ai-search:${cfg.index}`,
    async search(query, opts) {
      const filters = [
        opts.before ? `(source eq 'runbook' or at lt ${opts.before})` : '',
        ...(opts.excludeDocIds ?? []).map((id) => `id ne '${id.replace(/'/g, "''")}'`),
      ].filter(Boolean).join(' and ')
      const r = await fetch(`${cfg.endpoint.replace(/\/$/, '')}/indexes/${encodeURIComponent(cfg.index)}/docs/search?api-version=${cfg.apiVersion ?? '2024-07-01'}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'api-key': cfg.apiKey },
        body: JSON.stringify({
          search: query, top: opts.k ?? 5, ...(filters ? { filter: filters } : {}),
          ...(cfg.semanticConfig ? { queryType: 'semantic', semanticConfiguration: cfg.semanticConfig } : {}),
          ...(opts.productId ? { scoringParameters: [`product-${opts.productId}`] } : {}),
        }),
        signal: AbortSignal.timeout(15_000),
      })
      if (!r.ok) throw new Error(`Azure AI Search HTTP ${r.status}`)
      const j = (await r.json()) as { value: Record<string, unknown>[] }
      return j.value.map((d) => ({
        ref: String(d.id), source: (String(d.source ?? 'incident') as KnowledgeHit['source']), title: String(d.title ?? ''), productId: d.product_id as string | undefined,
        sameProduct: !!opts.productId && d.product_id === opts.productId, at: d.at as string | undefined,
        score: Number(d['@search.rerankerScore'] ?? d['@search.score'] ?? 0), via: cfg.semanticConfig ? 'azure hybrid + semantic' : 'azure search',
        snippet: String(d.content ?? '').slice(0, 280), resolution: d.resolution as string | undefined,
      }))
    },
  }
}

/** Amazon Bedrock Knowledge Bases Retrieve API (hybrid search), metadata keys: source, title, product_id, at, resolution. */
export function bedrockKnowledgeBaseProvider(cfg: { knowledgeBaseId: string; region: string }): KnowledgeProvider {
  let client: { send: (c: unknown) => Promise<unknown> } | null = null
  return {
    name: `bedrock-kb:${cfg.knowledgeBaseId}`,
    async search(query, opts) {
      const sdk = await import('@aws-sdk/client-bedrock-agent-runtime')
      client ??= new sdk.BedrockAgentRuntimeClient({ region: cfg.region }) as unknown as { send: (c: unknown) => Promise<unknown> }
      const out = (await client.send(new sdk.RetrieveCommand({
        knowledgeBaseId: cfg.knowledgeBaseId, retrievalQuery: { text: query },
        retrievalConfiguration: { vectorSearchConfiguration: { numberOfResults: (opts.k ?? 5) * 2, overrideSearchType: 'HYBRID' } },
      }))) as { retrievalResults?: { content?: { text?: string }; metadata?: Record<string, unknown>; score?: number; location?: { s3Location?: { uri?: string } } }[] }
      const exclude = new Set(opts.excludeDocIds ?? [])
      return (out.retrievalResults ?? [])
        .map((x) => ({ m: x.metadata ?? {}, x }))
        .filter(({ m }) => !exclude.has(String(m.id ?? '')) && (m.source === 'runbook' || !opts.before || !m.at || String(m.at) < opts.before))
        .slice(0, opts.k ?? 5)
        .map(({ m, x }) => ({
          ref: String(m.id ?? x.location?.s3Location?.uri ?? ''), source: (String(m.source ?? 'incident') as KnowledgeHit['source']), title: String(m.title ?? ''),
          productId: m.product_id as string | undefined, sameProduct: !!opts.productId && m.product_id === opts.productId, at: m.at as string | undefined,
          score: x.score ?? 0, via: 'bedrock hybrid', snippet: (x.content?.text ?? '').slice(0, 280), resolution: m.resolution as string | undefined,
        }))
    },
  }
}

/** Amazon Bedrock Guardrails on tool output (prompt attacks, PII), applied before our own pattern-based cleaning. */
export function withBedrockGuardrail(inner: ToolRunner, cfg: { guardrailId: string; version: string; region: string }): ToolRunner {
  let client: { send: (c: unknown) => Promise<unknown> } | null = null
  return {
    async op(op, params, meta) {
      const r = await inner.op(op, params, meta)
      if (!r.ok || !r.text) return r
      const sdk = await import('@aws-sdk/client-bedrock-runtime')
      client ??= new sdk.BedrockRuntimeClient({ region: cfg.region }) as unknown as { send: (c: unknown) => Promise<unknown> }
      const g = (await client.send(new sdk.ApplyGuardrailCommand({ guardrailIdentifier: cfg.guardrailId, guardrailVersion: cfg.version, source: 'INPUT', content: [{ text: { text: r.text.slice(0, 20_000) } }] }))) as { action?: string; outputs?: { text?: string }[] }
      if (g.action === 'GUARDRAIL_INTERVENED') return { ...r, text: g.outputs?.map((o) => o.text ?? '').join('\n') || '[blocked by Bedrock Guardrails]', tool: `${r.tool ?? op} + bedrock-guardrail` }
      return r
    },
  }
}
