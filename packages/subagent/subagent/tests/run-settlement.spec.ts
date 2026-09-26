import { describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  settleRun,
  settleRunResult,
} from '../src/index.ts'

const MAX_SUBAGENT_DIAGNOSTIC_BYTES = 4_096

describe('outcome mapping helpers', () => {
  it.each([
    ['completed', { status: 'completed', result: 'partial' }],
    ['aborted', { status: 'killed' }],
    ['error', { status: 'failed', detail: 'error' }],
    ['max-tokens', { status: 'failed', detail: 'max-tokens' }],
    ['refusal', { status: 'failed', detail: 'refusal' }],
    ['paused', { status: 'failed', detail: 'paused' }],
  ] as const)('settleRun maps the %s stop reason onto its Task outcome', async (stopReason, expected) => {
    const output = [{ type: 'text' as const, text: 'partial' }]
    await expect(settleRun({
      id: SessionId('child'),
      localAgent: undefined,
      result: Promise.resolve({ output, stopReason: stopReason as never }),
      dispose: () => Promise.resolve(),
    })).resolves.toEqual(expected)
  })

  it('settleRun disposes the run before reporting, on both result paths', async () => {
    const order: string[] = []
    const completed = await settleRun({
      id: SessionId('child-1'),
      localAgent: undefined,
      result: Promise.resolve({ output: [{ type: 'text' as const, text: 'ok' }], stopReason: 'completed' as const }),
      dispose() { order.push('dispose'); return Promise.resolve() },
    })
    order.push('reported')
    expect(completed).toEqual({ status: 'completed', result: 'ok' })
    expect(order).toEqual(['dispose', 'reported'])

    // An infrastructure rejection still disposes and reports failed.
    let disposed = false
    const failed = await settleRun({
      id: SessionId('child-2'),
      localAgent: undefined,
      result: Promise.reject(new Error('transport gone')),
      dispose() { disposed = true; return Promise.resolve() },
    })
    expect(failed).toEqual({ status: 'failed', detail: 'Error: transport gone' })
    expect(disposed).toBe(true)

    const disposeFailed = await settleRun({
      id: SessionId('child-4'),
      localAgent: undefined,
      result: Promise.resolve({ output: [], stopReason: 'completed' }),
      dispose: () => Promise.reject(new Error('reap failed')),
    })
    expect(disposeFailed).toEqual({ status: 'failed', detail: 'dispose failed: Error: reap failed' })

    const bothFailed = await settleRun({
      id: SessionId('child-5'),
      localAgent: undefined,
      result: Promise.reject(new Error('result failed')),
      dispose: () => Promise.reject(new Error('reap failed')),
    })
    expect(bothFailed).toEqual({
      status: 'failed',
      detail: 'Error: result failed; dispose failed: Error: reap failed',
    })
  })

  it('keeps provider diagnostics separate in failed background outcomes', async () => {
    await expect(settleRun({
      id: SessionId('child-diagnostic'),
      localAgent: undefined,
      result: Promise.resolve({
        output: [{ type: 'text', text: 'partial assistant text' }],
        diagnostic: 'Claude Code denied a tool request',
        stopReason: 'error',
      }),
      dispose: () => Promise.resolve(),
    })).resolves.toEqual({
      status: 'failed',
      detail: 'error; diagnostic: Claude Code denied a tool request',
    })
  })

  it('treats a diagnostic-bearing remote abort as failed without changing local cancellation', async () => {
    await expect(settleRun({
      id: SessionId('child-remote-abort'),
      localAgent: undefined,
      result: Promise.resolve({
        output: [],
        diagnostic: 'ACP permission was denied',
        stopReason: 'aborted',
      }),
      dispose: () => Promise.resolve(),
    })).resolves.toEqual({
      status: 'failed',
      detail: 'aborted; diagnostic: ACP permission was denied',
    })
  })

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
