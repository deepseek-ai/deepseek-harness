/**
 * Unit coverage for the seam's out-of-process provider vocabulary: cwd
 * resolution against the real filesystem, and the settlement/handle helpers
 * under their never-reject and idempotence contracts.
 */

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  assertPositiveFinite,
  assertUsableCwd,
  NO_START_CAPABILITIES,
  settleRunResult,
  subprocessRunHandle,
} from '../src/index.ts'

describe('NO_START_CAPABILITIES', () => {
  it('advertises nothing and is frozen (shared by every out-of-process backend)', () => {
    expect(NO_START_CAPABILITIES).toEqual({
      agentOptions: false,
      outputSchema: false,
      depthLimit: false,
      toolFilter: false,
      persona: false,
    })
    expect(Object.isFrozen(NO_START_CAPABILITIES)).toBe(true)
  })
})

describe('assertPositiveFinite', () => {
  it('accepts positive finite bounds and rejects zero, negatives, and NaN', () => {
    expect(() => { assertPositiveFinite('p', 'graceMs', 1) }).not.toThrow()
    expect(() => { assertPositiveFinite('p', 'graceMs', 0) }).toThrow('p: graceMs must be a positive finite number')
    expect(() => { assertPositiveFinite('p', 'graceMs', -5) }).toThrow('positive finite')
    expect(() => { assertPositiveFinite('p', 'graceMs', Number.NaN) }).toThrow('positive finite')
    expect(() => { assertPositiveFinite('p', 'graceMs', Number.POSITIVE_INFINITY) }).toThrow('positive finite')
  })
})

describe('child cwd resolution', () => {
  it('accepts an absolute enterable directory and rejects relative or missing paths', () => {
    expect(assertUsableCwd('p', 'config cwd', tmpdir())).toBe(tmpdir())
    expect(() => assertUsableCwd('p', 'config cwd', 'relative/path')).toThrow('must be an absolute path')
    expect(() => assertUsableCwd('p', 'config cwd', join(tmpdir(), 'dsh-no-such-dir-xyz'))).toThrow('not an accessible directory')
  })

  it('rejects an existing path that is a file, not a directory', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'oop-file-'))
    const file = join(tmp, 'plain.txt')
    try {
      writeFileSync(file, 'not a dir\n')
      expect(() => assertUsableCwd('p', 'config cwd', file)).toThrow('not an accessible directory')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  // Windows ACLs do not expose the POSIX directory search-bit state this fixture creates.
  it.skipIf(process.platform === 'win32')('rejects a directory without search permission', () => {
    // statSync().isDirectory() is true for a mode-600 directory, but a
    // subprocess cwd needs SEARCH permission — spawn would fail EACCES.
    const tmp = mkdtempSync(join(tmpdir(), 'oop-noexec-'))
    chmodSync(tmp, 0o600)
    try {
      expect(() => assertUsableCwd('p', 'config cwd', tmp)).toThrow('not an accessible directory')
    } finally {
      chmodSync(tmp, 0o700)
      rmSync(tmp, { recursive: true, force: true })
    }
  })




})

describe('settleRunResult', () => {
  const wiring = () => {
    const controller = new AbortController()
    const onAbort = vi.fn()
    controller.signal.addEventListener('abort', onAbort)
    return { controller, onAbort }
  }

  it('passes a successful attempt through and removes the abort listener', async () => {
    const { controller, onAbort } = wiring()
    const result = await settleRunResult({
      attempt: async () => ({ output: [{ type: 'text', text: 'done' }], stopReason: 'completed' }),
      collectOutput: () => [],
      cancelled: () => false,
      signal: controller.signal,
      onAbort,
    })
    expect(result.stopReason).toBe('completed')
    controller.abort()
    // The listener was removed at settlement, so the abort never reaches it.
    expect(onAbort).not.toHaveBeenCalled()
  })

  it('reads an in-flight rejection as aborted when cancellation already settled', async () => {
    const { controller, onAbort } = wiring()
    const result = await settleRunResult({
      attempt: async () => { throw new Error('pipe torn mid-cancel') },
      collectOutput: () => [{ type: 'text', text: 'partial' }],
      cancelled: () => true,
      signal: controller.signal,
      onAbort,
    })
    expect(result).toEqual({ output: [{ type: 'text', text: 'partial' }], stopReason: 'aborted' })
  })

  it('flattens a failure through a contained onError sink', async () => {
    const { controller, onAbort } = wiring()
    const seen: string[] = []
    const result = await settleRunResult({
      attempt: async () => { throw new Error('transport died') },
      collectOutput: () => [],
      cancelled: () => false,
      onError: (error, stopReason) => {
        seen.push(`${stopReason}:${error.message}`)
        throw new Error('sink failure must be contained')
      },
      signal: controller.signal,
      onAbort,
    })
    expect(result.stopReason).toBe('error')
    expect(seen).toEqual(['error:transport died'])
  })

  it('flattens a failure without a sink', async () => {
    const { controller, onAbort } = wiring()
    const result = await settleRunResult({
      attempt: async () => { throw new Error('no sink configured') },
      collectOutput: () => [],
      cancelled: () => false,
      signal: controller.signal,
      onAbort,
    })
    expect(result.stopReason).toBe('error')
  })
})

describe('subprocessRunHandle', () => {
  it('publishes an idempotent dispose that cancels locally and awaits teardown', async () => {
    const controller = new AbortController()
    const onAbort = vi.fn()
    controller.signal.addEventListener('abort', onAbort)
    const requestCancel = vi.fn()
    const teardown = vi.fn(() => Promise.resolve())
    const run = subprocessRunHandle({
      id: SessionId('run-1'),
      result: Promise.resolve({ output: [], stopReason: 'completed' }),
      signal: controller.signal,
      onAbort,
      requestCancel,
      teardown,
    })
    expect(String(run.id)).toBe('run-1')
    const disposal = run.dispose()
    expect(run.dispose()).toBe(disposal)
    await disposal
    expect(requestCancel).toHaveBeenCalledTimes(1)
    expect(teardown).toHaveBeenCalledTimes(1)
    controller.abort()
    // dispose removed the abort listener before cancelling.
    expect(onAbort).not.toHaveBeenCalled()
  })
})
