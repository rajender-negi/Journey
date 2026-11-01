// Writes the dummy dataset in each source's native schema to fixtures/raw/<source>.json.
// Compare these files with what your MCP servers return; they are the contract for /api/ingest.
import { mkdirSync, writeFileSync } from 'node:fs'
import { buildFixtureDataset, emitRawBundle } from '@pj/core'

const out = new URL('../../../fixtures/raw/', import.meta.url).pathname
mkdirSync(out, { recursive: true })
const raw = emitRawBundle(buildFixtureDataset(Date.parse('2026-11-01T03:30:00Z')))
for (const [source, payload] of Object.entries(raw)) {
  if (source === 'meta') continue
  writeFileSync(`${out}${source}.json`, JSON.stringify(payload, null, 2))
  console.log(`fixtures/raw/${source}.json`)
}
