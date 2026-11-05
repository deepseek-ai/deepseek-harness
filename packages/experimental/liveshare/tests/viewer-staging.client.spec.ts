/** Fail-safe staging cleanup: never remove an unset, parent, or out-of-parent path. */

import { existsSync } from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { allocateViewerStaging, disposeViewerStaging } from './viewer-staging.client.ts'

describe('viewer staging cleanup', () => {
  it('allocates a parent that did not exist and a unique child under it', () => {
    const root = mkdtempSync(join(tmpdir(), 'viewer-staging-root-'))
    try {
      const parent = join(root, 'not-yet', 'lib')
      const dir = allocateViewerStaging(parent, 'viewer-bundle-')
      expect(dir.startsWith(parent)).toBe(true)
      expect(existsSync(dir)).toBe(true)
      disposeViewerStaging(dir, parent)
      expect(existsSync(dir)).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('never removes an unset path, the parent, dot, or an out-of-parent path', () => {
    const remove = vi.fn()
    const parent = '/staging/parent'

    expect(disposeViewerStaging(undefined, parent, remove)).toBe(false)
    expect(disposeViewerStaging('', parent, remove)).toBe(false)
    expect(disposeViewerStaging('.', parent, remove)).toBe(false)
    expect(disposeViewerStaging(parent, parent, remove)).toBe(false)
    expect(disposeViewerStaging('/staging/parent-ish/evil', parent, remove)).toBe(false)
    expect(remove).not.toHaveBeenCalled()
  })

  it('removes a valid child exactly once', () => {
    const remove = vi.fn()
    const parent = '/staging/parent'

    const child = '/staging/parent/viewer-bundle-x'
    expect(disposeViewerStaging(child, parent, remove)).toBe(true)
    expect(remove).toHaveBeenCalledTimes(1)
    // The disposer hands the remover the resolved target: on Windows the POSIX literals above name
    // the same directory with a drive and backslashes, so the expectation resolves them too.
    expect(remove).toHaveBeenCalledWith(resolve(child))
  })
})
