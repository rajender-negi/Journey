// npm run eval : scores the agent on the golden set; exits 1 if any metric is under its threshold.
import { writeFileSync } from 'node:fs'
import { runEval } from './golden'

const r = await runEval()
const pct = (x: number) => `${(x * 100).toFixed(1)}%`
console.log(`Golden set: ${r.cases} investigations across ${r.rules} failure rules (${r.withPrecedent} with an earlier same-rule incident), ${r.adversarialCases} adversarial and ${r.injectionCases} injection cases\n`)
console.log('| Metric | Score | Pass bar | Result |\n| --- | --- | --- | --- |')
for (const k of Object.keys(r.metrics) as (keyof typeof r.metrics)[]) {
  console.log(`| ${k} | ${pct(r.metrics[k])} | ${pct(r.thresholds[k])} | ${r.metrics[k] >= r.thresholds[k] ? 'pass' : 'FAIL'} |`)
}
writeFileSync('eval-report.json', JSON.stringify(r, null, 2))
if (r.failed.length) {
  console.error(`\nFailed: ${r.failed.join(', ')}`)
  process.exit(1)
}
