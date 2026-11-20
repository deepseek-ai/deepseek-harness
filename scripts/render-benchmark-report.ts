/**
 * Render one scaled benchmark report from the report directories of benchmark phases that ran on separate
 * runners. Usage: `node scripts/render-benchmark-report.ts <output-directory> <phase-directory>...`.
 * Runs under plain Node type stripping, so the CI report job needs no dependency install.
 */
import { resolve } from 'node:path'
import { renderMergedReport } from '../benchmarks/support/scaling-report.ts'

const [output, ...inputs] = process.argv.slice(2)
if (output === undefined || inputs.length === 0) {
  throw new Error('usage: node scripts/render-benchmark-report.ts <output-directory> <phase-directory>...')
}
for (const warning of renderMergedReport(resolve(output), inputs.map(input => resolve(input)))) console.warn(warning)
console.log(`benchmark report: ${resolve(output, 'report.html')}`)
