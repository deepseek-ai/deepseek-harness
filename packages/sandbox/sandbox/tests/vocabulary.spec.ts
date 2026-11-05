/**
 * Vocabulary-contract tests for the sandbox seam: the fail-closed error's
 * structured identity is what tool results and consumers key on, so its
 * shape is pinned here, next to the vocabulary that owns it. Provider
 * behavior is each implementation's suite (`dsh-sandbox-local`); consumer
 * behavior is each consumer's (`dsh-bash-sandbox`).
 */

import { describe, expect, it } from 'vitest'
import { SANDBOX_UNAVAILABLE, SandboxUnavailableError } from '@deepseek-ai/dsh-sandbox'

describe('SandboxUnavailableError', () => {
  it('carries the structured { name, code } identity consumers key on', () => {
    const error = new SandboxUnavailableError('read-only')
    expect(error.name).toBe('SandboxUnavailableError')
    expect(error.code).toBe(SANDBOX_UNAVAILABLE)
    expect(error).toBeInstanceOf(Error)
  })

  it('names the refused mode and the operator escape hatches in its message', () => {
    const error = new SandboxUnavailableError('workspace-write')
    expect(error.message).toContain('"workspace-write"')
    expect(error.message).toContain('danger-full-access')
    expect(error.message).not.toContain('Runner failure')
  })

  it('carries the runner detail when the failure is discovered at execution time', () => {
    // The late twin of the confine-time throw: an unprobed sole candidate
    // that fails closed at exec surfaces the SAME error, with the runner's
    // own first stderr line as the cause.
    const error = new SandboxUnavailableError('read-only', 'landlock-run: landlock is not enforced by this kernel')
    expect(error.code).toBe(SANDBOX_UNAVAILABLE)
    expect(error.message).toContain('Runner failure: landlock-run: landlock is not enforced by this kernel')
  })
})
