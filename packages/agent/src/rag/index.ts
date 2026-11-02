// The agent's RAG layer: chunking, embeddings, hybrid search, vector store, long-term memory.
export * from './chunk'
export * from './search'
export * from './knowledge'

import type { ToolRunner } from '../evidence'
import type { KnowledgeBase } from './knowledge'

/** Serves the kb_search operation from the app's own knowledge base; everything else passes through. */
export function withKnowledge(inner: ToolRunner, kb: () => Promise<KnowledgeBase | null>): ToolRunner {
  return {
    async op(op, params, meta) {
      if (op !== 'kb_search') return inner.op(op, params, meta)
      const base = await kb()
      if (!base) return { ok: false, text: '', error: 'knowledge base not built' }
      const hits = await base.search(params.query ?? '', { k: 5, productId: params.productId, before: params.before, excludeDocIds: params.exclude ? [params.exclude] : [] })
      return { ok: true, text: hits.length ? JSON.stringify({ matches: hits }, null, 1) : '', server: 'knowledge-base', tool: `hybrid_search (${base.embedder.name})`, args: { query: (params.query ?? '').slice(0, 200), productId: params.productId, before: params.before } }
    },
  }
}
