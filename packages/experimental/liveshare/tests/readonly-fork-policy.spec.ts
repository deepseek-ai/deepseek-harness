/** Read-only fork authorization: binding, boundary, and the ceiling a child may never exceed. */

import { describe, expect, it } from 'vitest'
import {
  decideFork,
  modeAllowsSessionWrite,
  parseSessionMode,
  READ_ONLY_FORK_CEILING,
  WRITE_FORK_CEILING,
  type ForkRequest,
  type ForkShareState,
} from '../src/host/fork-policy.ts'

const request: ForkRequest = {
  shareId: 'share-1',
  sourceSessionId: 'session-1',
  requestKey: 'retry-key',
}

function share(overrides: Partial<ForkShareState> = {}): ForkShareState {
  return {
    shareId: 'share-1',
    sessionId: 'session-1',
    allowsFork: true,
    viewerAdmitted: true,
    stopped: false,
    ...overrides,
  }
}

describe('share mode parsing', () => {
  it('reads the two tiers and nothing else', () => {
    expect(parseSessionMode('view')).toBe('view')
    expect(parseSessionMode('write')).toBe('write')
    // Absent input states no tier; an older or unknown value states none either.
    expect(parseSessionMode(undefined)).toBeUndefined()
    expect(parseSessionMode(null)).toBeUndefined()
    expect(parseSessionMode('owner')).toBeUndefined()
    expect(parseSessionMode(3)).toBeUndefined()
  })

  it('includes writing the source session only in the write tier', () => {
    expect(modeAllowsSessionWrite('write')).toBe(true)
    expect(modeAllowsSessionWrite('view')).toBe(false)
  })
})

describe('read-only fork authorization', () => {
  it('refuses a fork for a share that is not registered at all', () => {
    expect(decideFork(undefined, request, 0)).toMatchObject({ ok: false, code: 'share-not-found' })
  })

  it('forks at the requested boundary, or from the start when none is named', () => {
    // A request that names no boundary forks the whole committed history from the start.
    expect(decideFork(share(), request, 0)).toEqual({
      ok: true,
      boundary: 0,
      ceiling: READ_ONLY_FORK_CEILING,
      requestKey: 'retry-key',
    })
    expect(decideFork(share(), { ...request, atSeq: 7 }, 0)).toMatchObject({
      ok: true,
      boundary: 7,
    })
    // The Host passes a boundary the share never recorded through; session/fork owns its validation.
    expect(decideFork(share(), { ...request, atSeq: 43 }, 0)).toMatchObject({
      ok: true,
      boundary: 43,
    })
  })

  it('never forks a share that only granted viewing', () => {
    expect(decideFork(share({ allowsFork: false }), request, 0)).toMatchObject({
      ok: false,
      code: 'fork-not-permitted',
    })
  })

  it('refuses a viewer the share does not admit, including a selected share that names nobody', () => {
    // An empty ACL alone must not read as organization-wide: this viewer was not admitted, so there is
    // nothing to fork whoever they are, including a viewer the Relay refused on tenant grounds.
    expect(decideFork(share({ viewerAdmitted: false }), request, 0)).toMatchObject({
      ok: false,
      code: 'viewer-not-authorized',
    })
  })

  it('refuses a caller that names another session', () => {
    // A viewer that can name a session id must not be able to fork one the share does not carry.
    expect(decideFork(share(), { ...request,  sourceSessionId: 'session-2' }, 0)).toMatchObject({
      ok: false,
      code: 'source-session-mismatch',
    })
  })

  it('refuses a stopped or expired share', () => {
    expect(decideFork(share({ stopped: true }), request, 0)).toMatchObject({
      ok: false,
      code: 'share-stopped',
    })
    expect(decideFork(share({ expiresAt: '2026-09-11T00:00:00.000Z' }), request, Date.parse('2026-09-11T00:00:01.000Z')))
      .toMatchObject({ ok: false, code: 'share-expired' })
  })

  it('admits a viewer the Relay admitted on an organization-wide share', () => {
    expect(decideFork(share({ viewerAdmitted: true }), request, 0)).toMatchObject({ ok: true })
  })

  it('admits the view surface and denies the capabilities that reach the owner', () => {
    const ceiling = READ_ONLY_FORK_CEILING
    expect(ceiling.readOnly).toBe(true)
    expect(ceiling.allowedTools).toEqual([
      'read', 'read_image', 'glob', 'grep', 'present', 'todo_write', 'skill', 'web_search', 'web_fetch',
    ])
    expect(WRITE_FORK_CEILING.allowedTools).toEqual([...ceiling.allowedTools, 'edit', 'write'])
    // A ceiling that can be edited is not a ceiling: these are refused at the seam, not configured.
    for (const denied of ['bash', 'pwsh', 'cua', 'plugin_manager', 'schedule_create', 'write', 'edit']) {
      expect(ceiling.deniedCapabilities).toContain(denied)
      expect(ceiling.allowedTools).not.toContain(denied)
    }
    // The write tier's own two names leave the deny list with the tier that admits them.
    expect(WRITE_FORK_CEILING.deniedCapabilities).not.toContain('write')
    expect(WRITE_FORK_CEILING.deniedCapabilities).not.toContain('edit')
    expect(WRITE_FORK_CEILING.deniedCapabilities).toContain('bash')
  })
})
