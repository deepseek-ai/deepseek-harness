import { rm } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import type { ResponsesFixture } from './responses-fixture.ts'

interface RealProductResources {
  contexts: { fiber: Pick<Context['fiber'], 'dispose'> }[]
  fixtures: Pick<ResponsesFixture, 'close'>[]
  roots: string[]
}

/**
 * Dispose Codex test contexts and HTTP fixtures before removing their files.
 * Captures all registries before awaiting, so later tests retain their resources.
 * Attempts every captured cleanup before reporting failures.
 * @param resources - mutable registries of resources owned by the test.
 */
export async function cleanupRealProduct(resources: RealProductResources): Promise<void> {
  const contexts = resources.contexts.splice(0)
  const fixtures = resources.fixtures.splice(0)
  const roots = resources.roots.splice(0)
  const failures: Error[] = []
  const contextOutcomes = await Promise.allSettled(contexts.map(async ctx => ctx.fiber.dispose()))
  for (const outcome of contextOutcomes) {
    if (outcome.status === 'rejected') {
      failures.push(new Error('Codex test context disposal failed', { cause: outcome.reason }))
    }
  }
  const fixtureOutcomes = await Promise.allSettled(fixtures.map(async fixture => fixture.close()))
  for (const outcome of fixtureOutcomes) {
    if (outcome.status === 'rejected') {
      failures.push(new Error('Codex test HTTP fixture closure failed', { cause: outcome.reason }))
    }
  }
  for (const root of roots) {
    try {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    } catch (cause) {
      failures.push(new Error(`Codex test temporary root removal failed: ${root}`, { cause }))
    }
  }
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) throw new AggregateError(failures, 'Codex test cleanup failed')
}
