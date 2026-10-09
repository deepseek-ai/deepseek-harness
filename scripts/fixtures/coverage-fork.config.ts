import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import { coverageForkPool } from '../coverage-fork-diagnostics.ts'

const cacheDir = process.env.DSH_TEST_FORK_CACHE
if (cacheDir === undefined || cacheDir === '') throw new Error('fork fixture requires its private cache directory')

export default defineConfig({
  cacheDir,
  test: {
    name: 'configured-fork',
    include: ['scripts/fixtures/coverage-fork.fixture.ts'],
    pool: process.env.DSH_TEST_FORK_POOL === 'stock' ? 'forks' : coverageForkPool,
    execArgv: ['--require', resolve(import.meta.dirname, 'coverage-fork-exit.cjs')],
    maxWorkers: 1,
    cache: false,
  },
})
