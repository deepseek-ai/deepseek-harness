/** Detached launch settlement with controlled process events and watch time. */
import { ChildProcess, spawn } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { launchDetachedApp } from '../src/resolver.ts'

vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  spawn: vi.fn(),
}))

afterEach(() => {
  vi.restoreAllMocks()
  vi.mocked(spawn).mockReset()
  vi.useRealTimers()
})

describe('launchDetachedApp watch window', () => {
  it.each(['exit 0', 'exit 3', 'error'] as const)('ignores late %s after unref without killing the child', async (event) => {
    vi.useFakeTimers()
    const child = new ChildProcess()
    const unref = vi.spyOn(child, 'unref')
    const kill = vi.spyOn(child, 'kill')
    vi.mocked(spawn).mockReturnValueOnce(child)
    try {
      const launched = launchDetachedApp('fixture-app', [], { watchMs: 100 })
      const fulfilled = vi.fn()
      const rejected = vi.fn()
      const observed = launched.then(fulfilled, rejected)

      await vi.advanceTimersByTimeAsync(99)
      expect(fulfilled).not.toHaveBeenCalled()
      expect(unref).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      await expect(launched).resolves.toBeUndefined()
      await observed
      expect(fulfilled).toHaveBeenCalledExactlyOnceWith(undefined)
      expect(unref).toHaveBeenCalledTimes(1)
      expect(kill).not.toHaveBeenCalled()

      // emit() invokes the resolver's registered callback before returning.
      const handled = event === 'error'
        ? child.emit('error', new Error('late launcher error'))
        : child.emit('exit', event === 'exit 0' ? 0 : 3, null)
      expect(handled).toBe(true)
      expect(unref).toHaveBeenCalledTimes(1)
      expect(kill).not.toHaveBeenCalled()
      expect(rejected).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      child.removeAllListeners()
      vi.restoreAllMocks()
      vi.mocked(spawn).mockReset()
      vi.useRealTimers()
    }
  })
})
