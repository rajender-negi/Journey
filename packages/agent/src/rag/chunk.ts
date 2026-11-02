// Chunking: what one vector stands for. Each kind of text is split the way its meaning is shaped
// (pattern: Uber's enhanced agentic RAG, where table-aware chunking was a large share of the gain).
//   records (incidents)      -> one chunk per record
//   runbooks, postmortems    -> by heading, long sections split by paragraph with overlap
//   logs                     -> only the windows around error lines

export type ChunkSource = 'incident' | 'runbook' | 'investigation' | 'log'

export interface Chunk {
  id: string
  docId: string
  source: ChunkSource
  title: string
  text: string
  meta: { productId?: string; service?: string; ruleId?: string; at?: string; ref?: string; resolution?: string }
}

/** Rough token count for English text (about 0.75 words per token). Good enough for sizing chunks. */
export const estimateTokens = (s: string) => Math.ceil((s.trim().split(/\s+/).filter(Boolean).length || 0) * 1.33)

/** One record, one chunk: a ticket is already one unit of meaning. */
export function chunkRecord(docId: string, source: ChunkSource, title: string, fields: Record<string, string | undefined>, meta: Chunk['meta']): Chunk {
  const text = Object.entries(fields).filter(([, v]) => v && v.trim()).map(([k, v]) => `${k}: ${v!.trim()}`).join('\n')
  return { id: `${docId}#0`, docId, source, title, text, meta }
}

/**
 * Split markdown by headings; a section longer than maxTokens is split by paragraph with overlap.
 * Each chunk keeps its heading path so it still makes sense on its own.
 */
export function chunkByHeading(docId: string, source: ChunkSource, title: string, markdown: string, meta: Chunk['meta'], opts: { maxTokens?: number; overlapTokens?: number } = {}): Chunk[] {
  const max = opts.maxTokens ?? 700, overlap = opts.overlapTokens ?? 80
  const sections: { heading: string; body: string[] }[] = [{ heading: title, body: [] }]
  for (const line of markdown.split('\n')) {
    const h = /^(#{1,3})\s+(.*)$/.exec(line)
    if (h) sections.push({ heading: `${title} > ${h[2].trim()}`, body: [] })
    else sections.at(-1)!.body.push(line)
  }
  const out: Chunk[] = []
  for (const s of sections) {
    const paras = s.body.join('\n').split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean)
    if (!paras.length) continue
    let cur: string[] = []
    const flush = () => {
      if (!cur.length) return
      out.push({ id: `${docId}#${out.length}`, docId, source, title: s.heading, text: `${s.heading}\n${cur.join('\n\n')}`, meta })
      // carry the tail forward as overlap so a step split across chunks is still findable
      const tail: string[] = []
      for (let i = cur.length - 1; i >= 0 && estimateTokens(tail.join(' ')) < overlap; i--) tail.unshift(cur[i])
      cur = estimateTokens(tail.join(' ')) < max / 2 ? tail : []
    }
    for (const p of paras) {
      if (cur.length && estimateTokens([...cur, p].join(' ')) > max) flush()
      cur.push(p)
    }
    if (cur.length) out.push({ id: `${docId}#${out.length}`, docId, source, title: s.heading, text: `${s.heading}\n${cur.join('\n\n')}`, meta })
  }
  return out
}

const ERROR_LINE = /\b(error|exception|fail(ed|ure)?|fatal|panic|killed|denied|timeout|timed out|crashloop|backoff|refused)\b/i

/** Keep only the lines around errors (±radius), merging windows that overlap. Logs are mostly noise. */
export function chunkLogWindows(docId: string, title: string, log: string, meta: Chunk['meta'], radius = 40): Chunk[] {
  const lines = log.split('\n')
  const hits = lines.map((l, i) => (ERROR_LINE.test(l) ? i : -1)).filter((i) => i >= 0)
  const windows: [number, number][] = []
  for (const i of hits) {
    const a = Math.max(0, i - radius), b = Math.min(lines.length - 1, i + radius)
    const last = windows.at(-1)
    if (last && a <= last[1] + 1) last[1] = Math.max(last[1], b)
    else windows.push([a, b])
  }
  return windows.map(([a, b], n) => ({ id: `${docId}#${n}`, docId, source: 'log' as const, title: `${title} lines ${a + 1}-${b + 1}`, text: lines.slice(a, b + 1).join('\n'), meta }))
}
