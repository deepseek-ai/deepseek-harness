/**
 * The worker assembly requires a few image packages directly; no image file
 * references them, so the reachability sweep keeps them only as entry seeds.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { IMAGE_ENTRY_SEEDS } from '../src/rules.ts'

const workerHost = fileURLToPath(new URL('../../webworker-runtime/src/worker-host.ts', import.meta.url))

it('seeds every image package the worker host requires by literal name', () => {
  const requested = [...readFileSync(workerHost, 'utf8').matchAll(/\brequire\(\s*'([^']+)'\s*\)/g)].map(match => match[1])
  expect(requested.length).toBeGreaterThan(0)
  expect([...new Set(requested)].sort()).toEqual([...IMAGE_ENTRY_SEEDS].sort())
})
