export const HOUR = 3_600_000
export const MIN = 60_000
export const DAY = 24 * HOUR

export const iso = (t: number) => new Date(t).toISOString()
export const ts = (s: string) => new Date(s).getTime()
export const hoursBetween = (a: string, b: string) => (ts(b) - ts(a)) / HOUR
export const minutesBetween = (a: string, b: string) => (ts(b) - ts(a)) / MIN

export function median(xs: number[]): number {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

export function sum(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0)
}

export const round = (n: number, d = 1) => Math.round(n * 10 ** d) / 10 ** d

// ISO week key, e.g. 2026-W43
export function weekKey(s: string): string {
  const d = new Date(s)
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
  const day = t.getUTCDay() || 7
  t.setUTCDate(t.getUTCDate() + 4 - day)
  const y = t.getUTCFullYear()
  const w = Math.ceil(((t.getTime() - Date.UTC(y, 0, 1)) / DAY + 1) / 7)
  return `${y}-W${String(w).padStart(2, '0')}`
}

export function groupBy<T, K extends string>(xs: T[], key: (x: T) => K): Record<K, T[]> {
  const out = {} as Record<K, T[]>
  for (const x of xs) (out[key(x)] ||= []).push(x)
  return out
}

// Deterministic PRNG so fixtures and tests are reproducible.
export function rng(seed: number) {
  let a = seed >>> 0
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  return {
    next,
    int: (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1)),
    float: (lo: number, hi: number) => lo + next() * (hi - lo),
    pick: <T>(xs: readonly T[]) => xs[Math.floor(next() * xs.length)],
    chance: (p: number) => next() < p,
  }
}
