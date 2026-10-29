/** What one share grants this viewer page. */

import { afterEach, describe, expect, it } from 'vitest'
import {
  publishViewerCapabilities, readViewerCapabilities, viewerCapabilities,
} from '../src/client/viewer-capabilities.ts'

afterEach(() => {
  publishViewerCapabilities(undefined)
})

describe('viewer capabilities', () => {
  it('reads the tier the share is in, and never assumes more than it was told', () => {
    expect(readViewerCapabilities({ capabilities: { sessionMode: 'view' } })).toEqual({ mode: 'view' })
    // The withdrawn `fork-readonly` tier granted forking and no writing, so a page reading it holds the
    // view tier; the fork switch travels separately.
    expect(readViewerCapabilities({ capabilities: { sessionMode: 'fork-readonly' } })).toEqual({ mode: 'view' })
    expect(readViewerCapabilities({ capabilities: { sessionMode: 'write' } })).toEqual({ mode: 'write' })
    expect(readViewerCapabilities({
      capabilities: { sessionMode: 'write', sessionModeReason: 'share-stopped' },
    })).toEqual({ mode: 'write', reason: 'share-stopped' })
  })

  it('holds the narrowest mode when the answer grants nothing, names nothing, or names too much', () => {
    expect(readViewerCapabilities({ capabilities: { readOnly: true } })).toEqual({ mode: 'view' })
    expect(readViewerCapabilities({ capabilities: { sessionMode: 'owner' } })).toEqual({ mode: 'view' })
    expect(readViewerCapabilities({ capabilities: { sessionMode: 3 } })).toEqual({ mode: 'view' })
    // A tier this build cannot read still carries the Host's reason for it.
    expect(readViewerCapabilities({ capabilities: { sessionMode: 'future-tier', sessionModeReason: 'share-stopped' } }))
      .toEqual({ mode: 'view', reason: 'share-stopped' })
  })

  it('cannot confirm the share when the answer never arrived or carried nothing it could read', () => {
    // An answer that never arrived is not a share that said it was read-only: the page holds the
    // narrowest mode and says it could not confirm the share, rather than stating an access it was
    // never told it still has.
    expect(readViewerCapabilities(undefined)).toEqual({ mode: 'view', unconfirmed: true })
    expect(readViewerCapabilities({ capabilities: 'write' })).toEqual({ mode: 'view', unconfirmed: true })
    expect(readViewerCapabilities(null)).toEqual({ mode: 'view', unconfirmed: true })
  })

  it('reads a share that carried only the older branching grant as the view tier and no more', () => {
    // A share older than tiers granted branching at most, and branching is a switch rather than a tier:
    // reading it as `write` would hand this page the owner's Session, which nothing in that share ever
    // allowed.
    expect(readViewerCapabilities({ capabilities: { fork: { allowed: true } } })).toEqual({ mode: 'view' })
    expect(readViewerCapabilities({ capabilities: { fork: { allowed: false, reason: 'fork-not-permitted' } } }))
      .toEqual({ mode: 'view', reason: 'fork-not-permitted' })
    // The other direction: an answer naming a tier this build does not know is a Host this build is
    // too old for, so the older grant beside it is not a licence to guess — the page holds `view`.
    expect(readViewerCapabilities({
      capabilities: { sessionMode: 'owner', fork: { allowed: true } },
    })).toEqual({ mode: 'view' })
  })

  it('keeps the page overall grant-free when the answer never arrived', () => {
    publishViewerCapabilities(undefined)
    expect(viewerCapabilities.getSnapshot().mode).toBe('view')
    // Nothing was granted, and the page also records that it could not confirm the share at all.
    expect(viewerCapabilities.getSnapshot().unconfirmed).toBe(true)
  })
})
