import type { Analysis, RawBundle } from '@pj/core'
import type { SourceStatus } from './collector'

export interface Snapshot {
  analysis: Analysis
  raw: RawBundle
  status: SourceStatus[]
  mixed: boolean
}

let current: Snapshot | undefined

export const store = {
  set(s: Snapshot) {
    current = s
  },
  get(): Snapshot {
    if (!current) throw new Error('No data collected yet')
    return current
  },
  ready: () => !!current,
}
