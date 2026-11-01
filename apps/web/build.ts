// One UI, two packagings of the same files (src/app.js + src/app.css):
//   dist/index.html                  served by the API; loads the view model from /api/vm
//   dist-demo/product-journey.html   self-contained; the demo view model is embedded
// No framework and no external requests, so it runs on any phone or laptop browser.
//   npx tsx apps/web/build.ts
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { analyze, buildFixtureDataset, buildViewModel, emitRawBundle, mapRawBundle } from '@pj/core'

const here = new URL('.', import.meta.url).pathname
let css = readFileSync(`${here}src/app.css`, 'utf8')
let js = readFileSync(`${here}src/app.js`, 'utf8')
// minify when esbuild is installed (optional dev dependency); the plain files work either way
try {
  const { transform } = await import('esbuild')
  js = (await transform(js, { minify: true, target: 'es2017' })).code
  css = (await transform(css, { loader: 'css', minify: true, target: 'safari12' })).code
} catch { /* not installed: ship unminified */ }
js = js.replace(/<\/script/gi, '<\\/script')
const body = (data = '') => `<div id="app"><p class="boot">Loading…</p></div>
${data}<script>${js}</script>
`

mkdirSync(`${here}dist`, { recursive: true })
const served = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#ffffff"><meta name="apple-mobile-web-app-capable" content="yes">
<title>Product Journey</title><style>${css}</style></head>
<body>${body()}</body></html>
`
writeFileSync(`${here}dist/index.html`, served)

const raw = emitRawBundle(buildFixtureDataset(Date.now()))
const vm = JSON.stringify(buildViewModel(analyze(mapRawBundle(raw)), { mode: 'demo', maxJourneys: 40, evidenceChars: 180, raw })).replace(/</g, '\\u003c')
const demo = `<title>Product Journey</title>
<meta name="claude:viewport-fit-sides" content="cover">
<style>${css}</style>
${body(`<script>window.VM=${vm};</script>\n`)}`
mkdirSync(`${here}dist-demo`, { recursive: true })
writeFileSync(`${here}dist-demo/product-journey.html`, demo)

console.log(`dist/index.html ${(served.length / 1024).toFixed(0)} KB · dist-demo/product-journey.html ${(demo.length / 1024).toFixed(0)} KB`)
