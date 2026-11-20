/**
 * CLI entry that merges downloaded coverage shard outputs into one thresholded
 * report. The single argument names a directory outside `coverage/` whose
 * subdirectories each hold one shard's `coverage/shard/` output.
 */
import { resolve } from 'node:path'
import { COVERAGE_EXEMPT_ENV } from './coverage-exempt.ts'
import { forwardedCoverageArgs, mergeCoverageShards } from './coverage-partitions.ts'

const [inputDirectory, ...extra] = forwardedCoverageArgs(process.argv.slice(2))
if (inputDirectory === undefined || extra.length > 0) {
  throw new Error('usage: pnpm run test:coverage:merge-shards <shard-output-directory>')
}
const pnpmEntrypoint = process.env.npm_execpath
if (pnpmEntrypoint === undefined || pnpmEntrypoint === '') {
  throw new Error('coverage shard merge must be invoked through a pnpm package script.')
}
// The shards ran with the exempt heavy suites excluded; the inventory
// listing and the merged report read the same configuration.
process.env[COVERAGE_EXEMPT_ENV] = '1'

process.exitCode = await mergeCoverageShards({
  root: resolve(import.meta.dirname, '..'),
  pnpmEntrypoint,
  inputDirectory: resolve(inputDirectory),
})
