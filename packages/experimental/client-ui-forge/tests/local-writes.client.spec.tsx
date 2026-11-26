// @vitest-environment jsdom
/** The write hook of the changes view where no control reaches: a write asked for while the scope is read again. */
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { useLocalWrites, type LocalWritesDeps } from '../src/client/local-writes.ts'
import type { ForgeDiffFile, ForgeLocalWriteResult } from '../src/types.ts'

afterEach(cleanup)

const FILE: ForgeDiffFile = {
  path: 'src/app.ts', previousPath: null, status: 'modified', binary: false, oversized: false, untracked: false, submodule: false,
  layer: 'implementation', digest: 'digest', additions: 1, deletions: 0, hunks: [],
}

describe('useLocalWrites', () => {
  it('starts no write and asks for no restoration while the scope is read again', async () => {
    const localWrite = vi.fn(async (): Promise<RemoteResult<ForgeLocalWriteResult>> => ({ ok: true, value: { undo: null } }))
    const deps = (rereading: boolean): LocalWritesDeps => ({ localWrite, report: vi.fn(), reread: vi.fn(), rereading })
    const hook = renderHook((input: LocalWritesDeps) => useLocalWrites(input), { initialProps: deps(true) })
    expect(hook.result.current.writing).toBe(true)

    // The shown files can be ones the last write already changed, so the controls are disabled and a call is ignored.
    act(() => { hook.result.current.write('stage', [FILE]) })
    act(() => { hook.result.current.write('restore', [FILE]) })
    expect(localWrite).not.toHaveBeenCalled()
    expect(hook.result.current.restoring).toBeNull()

    hook.rerender(deps(false))
    expect(hook.result.current.writing).toBe(false)
    await act(async () => { hook.result.current.write('stage', [FILE]) })
    expect(localWrite).toHaveBeenCalledWith({ kind: 'stage', files: [{ path: 'src/app.ts', digest: 'digest' }] })
  })
})
