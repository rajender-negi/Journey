// Retrieval: keyword (BM25) + vector search, merged with reciprocal rank fusion, filtered by
// metadata before ranking. Pattern: Spotify kept keyword search beside vector search because
// vectors miss exact terms (error codes, service names); Uber's enhanced RAG runs BM25 and
// vector search together.

import type { Chunk } from './chunk'

// ---------- tokenising ----------
const STOP = new Set('a an and are as at be by for from has have in is it its of on or that the this to was were with not no'.split(' '))
export function tokens(s: string): string[] {
  return s.toLowerCase().replace(/[^a-z0-9.\-_]+/g, ' ').split(/\s+/)
    .map((t) => t.replace(/^[.\-_]+|[.\-_]+$/g, ''))
    .filter((t) => t.length > 1 && !STOP.has(t))
    .map((t) => (t.length > 4 ? t.replace(/(ing|ed|es|s)$/, '') : t))
}

// ---------- embeddings ----------
export interface Embedder {
  name: string
  dims: number
  embed(texts: string[]): Promise<number[][]>
}

const fnv = (s: string, seed: number) => {
  let h = 0x811c9dc5 ^ seed
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) }
  return h >>> 0
}
const normalize = (v: number[]) => { const n = Math.hypot(...v) || 1; return v.map((x) => x / n) }

/**
 * Local feature-hashing embedder: words and word pairs hashed into a fixed-size vector.
 * Runs anywhere with no model or key (tests, the phone card, offline demos). It captures shared
 * wording, not deeper meaning: set EMBEDDINGS_* to use a real embedding model in production.
 */
export function hashingEmbedder(dims = 512): Embedder {
  return {
    name: `hashing-${dims}`,
    dims,
    async embed(texts) {
      return texts.map((t) => {
        const v = new Array<number>(dims).fill(0)
        const ts = tokens(t)
        const feats = [...ts, ...ts.slice(1).map((x, i) => `${ts[i]}_${x}`)]
        const tf = new Map<string, number>()
        for (const f of feats) tf.set(f, (tf.get(f) ?? 0) + 1)
        for (const [f, c] of tf) {
          const h = fnv(f, 7)
          v[h % dims] += (fnv(f, 13) & 1 ? 1 : -1) * (1 + Math.log(c))
        }
        return normalize(v)
      })
    },
  }
}

/** Any OpenAI-compatible /embeddings endpoint (OpenAI, Azure OpenAI via a gateway, Voyage, local servers). */
export function openAiCompatibleEmbedder(cfg: { baseUrl: string; apiKey: string; model: string; dims: number; timeoutMs?: number }): Embedder {
  return {
    name: cfg.model,
    dims: cfg.dims,
    async embed(texts) {
      const out: number[][] = []
      for (let i = 0; i < texts.length; i += 64) {
        const r = await fetch(`${cfg.baseUrl.replace(/\/$/, '')}/embeddings`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` },
          body: JSON.stringify({ model: cfg.model, input: texts.slice(i, i + 64) }),
          signal: AbortSignal.timeout(cfg.timeoutMs ?? 30_000),
        })
        if (!r.ok) throw new Error(`embeddings HTTP ${r.status}`)
        const j = (await r.json()) as { data: { embedding: number[]; index: number }[] }
        out.push(...j.data.sort((a, b) => a.index - b.index).map((d) => normalize(d.embedding)))
      }
      return out
    },
  }
}

export const cosine = (a: number[], b: number[]) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s }

// ---------- vector store ----------
export interface VectorStore {
  upsert(items: { chunk: Chunk; vector: number[] }[]): Promise<void>
  search(vector: number[], k: number, filter: (c: Chunk) => boolean): Promise<{ chunk: Chunk; score: number }[]>
}

/** Exact cosine search in memory. Fine to tens of thousands of chunks; pgvector for more. */
export class InMemoryVectorStore implements VectorStore {
  private items = new Map<string, { chunk: Chunk; vector: number[] }>()
  async upsert(items: { chunk: Chunk; vector: number[] }[]) { for (const it of items) this.items.set(it.chunk.id, it) }
  async search(vector: number[], k: number, filter: (c: Chunk) => boolean) {
    return [...this.items.values()].filter((it) => filter(it.chunk)).map((it) => ({ chunk: it.chunk, score: cosine(vector, it.vector) }))
      .sort((a, b) => b.score - a.score).slice(0, k)
  }
}

/** pgvector schema for production: one Postgres for vectors, metadata, agent checkpoints and memory. */
export const PGVECTOR_DDL = (dims: number) => `CREATE EXTENSION IF NOT EXISTS vector;
CREATE TABLE IF NOT EXISTS kb_chunks (
  id text PRIMARY KEY, doc_id text NOT NULL, source text NOT NULL, title text NOT NULL, body text NOT NULL,
  product_id text, service text, rule_id text, at timestamptz, embedding vector(${dims}) NOT NULL,
  body_tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', title || ' ' || body)) STORED
);
CREATE INDEX IF NOT EXISTS kb_chunks_hnsw ON kb_chunks USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS kb_chunks_tsv ON kb_chunks USING gin (body_tsv);
CREATE INDEX IF NOT EXISTS kb_chunks_product ON kb_chunks (product_id, at);`

// ---------- BM25 ----------
export class Bm25 {
  private docs: { chunk: Chunk; tf: Map<string, number>; len: number }[] = []
  private df = new Map<string, number>()
  private avg = 0
  constructor(private k1 = 1.2, private b = 0.75) {}
  add(chunks: Chunk[]) {
    for (const c of chunks) {
      const ts = tokens(`${c.title} ${c.text}`)
      const tf = new Map<string, number>()
      for (const t of ts) tf.set(t, (tf.get(t) ?? 0) + 1)
      for (const t of tf.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1)
      this.docs.push({ chunk: c, tf, len: ts.length })
    }
    this.avg = this.docs.reduce((s, d) => s + d.len, 0) / (this.docs.length || 1)
  }
  search(query: string, k: number, filter: (c: Chunk) => boolean): { chunk: Chunk; score: number }[] {
    const q = [...new Set(tokens(query))], n = this.docs.length
    return this.docs.filter((d) => filter(d.chunk)).map((d) => {
      let s = 0
      for (const t of q) {
        const f = d.tf.get(t)
        if (!f) continue
        const df = this.df.get(t)!
        const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5))
        s += idf * (f * (this.k1 + 1)) / (f + this.k1 * (1 - this.b + this.b * d.len / (this.avg || 1)))
      }
      return { chunk: d.chunk, score: s }
    }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score).slice(0, k)
  }
}

/** Reciprocal rank fusion: merges ranked lists without needing comparable scores. */
export function rrf(lists: { chunk: Chunk }[][], k = 60): { chunk: Chunk; score: number; ranks: number[] }[] {
  const acc = new Map<string, { chunk: Chunk; score: number; ranks: number[] }>()
  lists.forEach((list, li) => list.forEach((x, rank) => {
    const e = acc.get(x.chunk.id) ?? { chunk: x.chunk, score: 0, ranks: lists.map(() => -1) }
    e.score += 1 / (k + rank + 1)
    e.ranks[li] = rank + 1
    acc.set(x.chunk.id, e)
  }))
  return [...acc.values()].sort((a, b) => b.score - a.score)
}
