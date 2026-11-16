/** Cleanup preserves the primary failure and separately identifies a second failure. */
import { expect, it, vi } from 'vitest'
import { rethrowAfterCleanup } from '../src/cleanup-failure.ts'
import { SourceError } from '../src/source-error.ts'

it.each([false, true])('preserves the original failure after successful cleanup (async=%s)', async (asynchronous) => {
  const original = new SourceError('Primary failure', 'SOURCE_CLOSED')
  const cleanup = vi.fn(() => asynchronous ? Promise.resolve() : undefined)
  await expect(rethrowAfterCleanup(original, cleanup)).rejects.toBe(original)
  expect(cleanup).toHaveBeenCalledOnce()
})

it.each([false, true])('preserves both original failure objects when cleanup fails (async=%s)', async (asynchronous) => {
  const original = new SourceError('Domain close failed', 'SOURCE_CLOSED')
  const secondary = new Error('Remaining cleanup failed')
  const cleanup = vi.fn(() => {
    if (asynchronous) return Promise.reject(secondary)
    throw secondary
  })
  const failure = await rethrowAfterCleanup(original, cleanup).catch((error: unknown) => error)
  expect(failure).toBeInstanceOf(SourceError)
  expect(failure).toMatchObject({ code: 'SOURCE_DISPOSAL_FAILED' })
  if (!(failure instanceof SourceError) || !(failure.cause instanceof AggregateError)) {
    throw new Error('Cleanup did not retain both failures in an aggregate cause')
  }
  expect(failure.cause.errors).toHaveLength(2)
  expect(failure.cause.errors[0]).toBe(original)
  expect(failure.cause.errors[1]).toBe(secondary)
  expect(cleanup).toHaveBeenCalledOnce()
})
