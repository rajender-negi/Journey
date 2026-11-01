export class HttpError extends Error {
  constructor(public status: number, public url: string, body: string) {
    super(`HTTP ${status} ${url}: ${body.slice(0, 300)}`)
  }
}

export async function getJson<T>(url: string, headers: Record<string, string>, init: RequestInit = {}): Promise<T> {
  const res = await fetch(url, { ...init, headers: { Accept: 'application/json', ...headers, ...(init.headers as Record<string, string> | undefined) }, signal: AbortSignal.timeout(30_000) })
  const text = await res.text()
  if (!res.ok) throw new HttpError(res.status, url, text)
  return JSON.parse(text) as T
}

/** Runs async tasks with bounded concurrency to respect API rate limits. */
export async function pool<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let i = 0
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++
      out[idx] = await fn(items[idx])
    }
  }))
  return out
}
