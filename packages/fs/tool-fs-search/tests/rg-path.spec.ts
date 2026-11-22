/**
 * Failure-path tests for the lazy packaged-ripgrep resolution. The success
 * path (the real `@vscode/ripgrep` module) is exercised throughout
 * tools.spec.ts; here the module is mocked to throw at evaluation, proving a
 * missing or corrupt platform package (`--omit=optional`, partial install)
 * surfaces as a per-call `SEARCH_FAILED` — not a composition-load failure.
 */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ToolExecution, ToolExecutionToken } from '@deepseek-ai/dsh-tools'
import { resolveRgPath, runRipgrep } from '@deepseek-ai/dsh-tool-fs-search'

// Any access to the mocked module's surface throws — the shape a missing
// platform package produces at module evaluation.
vi.mock('@vscode/ripgrep', () => new Proxy({}, {
  get() {
    throw new Error('platform package @vscode/ripgrep-win32-x64 is not installed')
  },
}))

describe('lazy packaged-ripgrep resolution', () => {
  it('fails the first search call with SEARCH_FAILED instead of failing module load', async () => {
    // The resolution rejects before any spawn, so no subprocess service is needed.
    const controller = new AbortController()
    const callId = brandString<ToolCallId>('missing-platform-package')
    const exec: ToolExecution = {
      signal: controller.signal,
      name: 'glob',
      arguments: {},
      callId,
      rootCallId: callId,
      token: Symbol('missing-platform-package') as ToolExecutionToken,
    }

    await expect(runRipgrep(new Context(), exec, 'glob', ['--files'], 1_000_000, 3_000, 64 * 1024))
      .rejects.toMatchObject({ name: 'SearchError', code: 'SEARCH_FAILED' })
  })

  it('keeps failing every subsequent call (the resolution is memoized)', async () => {
    await expect(resolveRgPath()).rejects.toThrow(/platform package/)
    await expect(resolveRgPath()).rejects.toThrow(/platform package/)
  })
})
