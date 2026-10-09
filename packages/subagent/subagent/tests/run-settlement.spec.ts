import { describe, expect, it } from 'vitest'
import {
  settleRunResult,
} from '../src/index.ts'

const MAX_SUBAGENT_DIAGNOSTIC_BYTES = 4_096

describe('outcome mapping helpers', () => {
  it('bounds multibyte diagnostics and marks truncation', async () => {
    const exact = 'x'.repeat(MAX_SUBAGENT_DIAGNOSTIC_BYTES)
    const oversized = '权限'.repeat(MAX_SUBAGENT_DIAGNOSTIC_BYTES)
    const controller = new AbortController()
    const exactResult = await settleRunResult({
      attempt: async () => { throw new Error('provider failed') },
      collectOutput: () => [],
      collectDiagnostic: () => exact,
      cancelled: () => false,
      signal: controller.signal,
      onAbort: () => {},
    })
    expect(exactResult.diagnostic).toBe(exact)

    const result = await settleRunResult({
      attempt: async () => { throw new Error('provider failed') },
      collectOutput: () => [],
      collectDiagnostic: () => oversized,
      cancelled: () => false,
      signal: controller.signal,
      onAbort: () => {},
    })
    const limited = result.diagnostic ?? ''
    expect(Buffer.byteLength(limited, 'utf8'))
      .toBeLessThanOrEqual(MAX_SUBAGENT_DIAGNOSTIC_BYTES)
    expect(limited.endsWith('[diagnostic truncated]')).toBe(true)
    expect(limited).not.toContain('\uFFFD')
    expect(result.stopReason).toBe('error')
    expect(result.diagnostic).toBe(limited)
  })

  it('applies the same diagnostic rules to provider-returned results', async () => {
    const controller = new AbortController()
    const oversized = '权限'.repeat(MAX_SUBAGENT_DIAGNOSTIC_BYTES)
    const failed = await settleRunResult({
      attempt: () => Promise.resolve({
        output: [],
        diagnostic: oversized,
        stopReason: 'error',
      }),
      collectOutput: () => [],
      cancelled: () => false,
      signal: controller.signal,
      onAbort: () => {},
    })
    expect(Buffer.byteLength(failed.diagnostic ?? '', 'utf8'))
      .toBeLessThanOrEqual(MAX_SUBAGENT_DIAGNOSTIC_BYTES)
    expect(failed.diagnostic).toMatch(/\[diagnostic truncated\]$/)

    const plainFailure = await settleRunResult({
      attempt: () => Promise.resolve({ output: [], stopReason: 'error' }),
      collectOutput: () => [],
      cancelled: () => false,
      signal: controller.signal,
      onAbort: () => {},
    })
    expect(plainFailure).toEqual({ output: [], stopReason: 'error' })

    const cancelledAfterAttempt = await settleRunResult({
      attempt: () => Promise.resolve({ output: [], stopReason: 'completed' }),
      collectOutput: () => [{ type: 'text', text: 'partial' }],
      cancelled: () => true,
      signal: controller.signal,
      onAbort: () => {},
    })
    expect(cancelledAfterAttempt).toEqual({
      output: [{ type: 'text', text: 'partial' }],
      stopReason: 'aborted',
    })
  })
})
