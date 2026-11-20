/** CLI entry for partitioned Vitest coverage, optionally limited to one `DSH_COVERAGE_SHARD` file shard. */
import { resolve } from 'node:path'
import {
  COVERAGE_PARTITIONS_ENV,
  COVERAGE_SHARD_ENV,
  CoveragePartitionCoordinator,
  forwardedCoverageArgs,
  parseCoveragePartitionCount,
  parseCoverageShard,
} from './coverage-partitions.ts'

const partitions = parseCoveragePartitionCount(process.env[COVERAGE_PARTITIONS_ENV])
if (partitions === undefined) {
  throw new Error(`${COVERAGE_PARTITIONS_ENV} is required by partitioned coverage.`)
}
const pnpmEntrypoint = process.env.npm_execpath
if (pnpmEntrypoint === undefined || pnpmEntrypoint === '') {
  throw new Error('partitioned coverage must be invoked through a pnpm package script.')
}

const shard = parseCoverageShard(process.env[COVERAGE_SHARD_ENV])
const coordinator = new CoveragePartitionCoordinator({
  root: resolve(import.meta.dirname, '..'),
  partitions,
  pnpmEntrypoint,
  vitestArgs: forwardedCoverageArgs(process.argv.slice(2)),
  ...shard === undefined ? {} : { shard },
})
process.exitCode = await coordinator.run()
