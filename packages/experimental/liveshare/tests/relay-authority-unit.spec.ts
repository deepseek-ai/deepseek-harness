/** The Relay's access statements: adoption, fencing, and what a narrowed snapshot ends. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ShareAccessStateFrame } from '@deepseek-ai/dsh-experimental-liveshare-protocol'
import { identityKeyOf } from '@deepseek-ai/dsh-experimental-liveshare-protocol'
import { createRelayAuthority, identityForGrantedSubject, requesterStillAdmitted } from '../src/host/relay-authority.ts'
import type { OwnerShare } from '../src/host/owner-types.ts'

const RELAY = 'https://relay.example.test/liveshare'
const VIEWER = { providerId: 'p', tenantId: 't', subjectId: 'alice' }
const OWNER = { providerId: 'owner-p', tenantId: 'owner-t', subjectId: 'owner', displayName: 'Owner' }

function storedShare(overrides: Partial<OwnerShare> = {}): OwnerShare {
  return {
    shareId: 'share-1', sessionId: 'session-1', sessionTitle: 'Session', accessMode: 'open',
    link: `${RELAY}/?shareId=share-1`, relay: RELAY, gatewayToken: 'gateway-token',
    allowedSubjectIds: [], revision: 1, createdAt: '2026-01-01T00:00:00.000Z',
    allowsFork: false, sessionMode: 'view', online: true, ...overrides,
  }
}

function frame(overrides: Partial<ShareAccessStateFrame> = {}): ShareAccessStateFrame {
  return {
    type: 'share-access-state', version: 1, accessMode: 'open', allowedSubjectIds: [],
    sessionMode: 'view', ...overrides,
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function harness(options: { readonly ownerIdentity?: typeof OWNER | undefined } = {}) {
  const ownerIdentity = 'ownerIdentity' in options ? options.ownerIdentity : OWNER
  const ownerShares = new Map<string, OwnerShare>()
  const state = { disposed: false }
  const viewerRead = {
    cancelPendingCalls: vi.fn(),
    recheckAdmission: vi.fn(),
    closeViewerStreams: vi.fn(),
    closeShare: vi.fn(),
  }
  const forks = { listForShare: vi.fn(() => []) }
  const accessChanged = vi.fn()
  const cancelShareTurn = vi.fn()
  const cancelChildTurns = vi.fn()
  const scheduleShareExpiry = vi.fn()
  const reconcileSourceAccess = vi.fn()
  const authority = createRelayAuthority({
    ownerShares,
    disposed: () => state.disposed,
    forks,
    ownerIdentity,
    allowedSubjectIds: ['deployment-subject'],
    viewerRead: () => viewerRead,
    accessChanged,
    cancelShareTurn,
    cancelChildTurns,
    scheduleShareExpiry,
    reconcileSourceAccess,
  } as never)
  return {
    authority, ownerShares, state, viewerRead, forks, accessChanged,
    cancelShareTurn, cancelChildTurns, scheduleShareExpiry, reconcileSourceAccess,
  }
}

describe('admission and granted subject identities', () => {
  it('reads an empty ACL as the open mode and a non-empty one as the exact subjects', () => {
    expect(requesterStillAdmitted({ accessMode: 'open', allowedSubjectIds: [] }, VIEWER)).toBe(true)
    expect(requesterStillAdmitted({ accessMode: 'selected', allowedSubjectIds: [] }, VIEWER)).toBe(false)
    expect(requesterStillAdmitted({ accessMode: 'selected', allowedSubjectIds: ['alice'] }, VIEWER)).toBe(true)
    expect(requesterStillAdmitted({ accessMode: 'selected', allowedSubjectIds: [identityKeyOf(VIEWER)] }, VIEWER)).toBe(true)
    expect(requesterStillAdmitted({ accessMode: 'selected', allowedSubjectIds: ['bob'] }, VIEWER)).toBe(false)
  })

  it('reads a canonical key and falls back to the owner identity for a bare subject', () => {
    expect(identityForGrantedSubject(identityKeyOf(VIEWER), undefined)).toEqual(VIEWER)
    expect(identityForGrantedSubject('bob', OWNER)).toEqual({ providerId: 'owner-p', tenantId: 'owner-t', subjectId: 'bob' })
    expect(identityForGrantedSubject('bob', undefined)).toBeUndefined()
  })
})

describe('relay access adoption', () => {
  it('does not adopt a frame after disposal', () => {
    const h = harness()
    h.state.disposed = true
    h.authority.applyRelayAccess('share-1', frame())
    expect(h.accessChanged).not.toHaveBeenCalled()
  })

  it('keeps the newest version and ignores equal or older frames', () => {
    const h = harness()
    h.ownerShares.set('share-1', storedShare())
    h.authority.applyRelayAccess('share-1', frame({ version: 3, sessionMode: 'write' }))
    h.authority.applyRelayAccess('share-1', frame({ version: 3, sessionMode: 'view' }))
    h.authority.applyRelayAccess('share-1', frame({ version: 2, sessionMode: 'view' }))
    expect(h.ownerShares.get('share-1')?.sessionMode).toBe('view')
    expect(h.ownerShares.get('share-1')?.revision).toBe(2)
  })

  it('holds a frame for a share this host no longer publishes', () => {
    const h = harness()
    h.authority.applyRelayAccess('share-1', frame({ version: 1, allowedSubjectIds: ['alice'] }))
    expect(h.authority.viewerAdmitted('share-1', VIEWER)).toBe(true)
    expect(h.ownerShares.size).toBe(0)
  })

  it('merges the stated tier, fork switch, ACL, and expiry into the stored record', () => {
    const h = harness()
    const key = identityKeyOf(VIEWER)
    h.ownerShares.set('share-1', storedShare({
      expiresAt: '2030-01-01T00:00:00Z', allowsFork: false, sessionMode: 'write',
      access: {
        mode: 'open', selected: [{ ...VIEWER, identityKey: key }],
        deploymentAllowedSubjectIds: [], shareAllowedSubjectIds: [], broadenedByDeploymentSubjects: false,
        identityKeyAcl: true,
      },
    }))
    h.authority.applyRelayAccess('share-1', frame({
      version: 2, sessionMode: 'view', allowedSubjectIds: [key, 'deployment-subject', 'bob'],
    }))
    const next = h.ownerShares.get('share-1')
    // The stored record keeps its own tier; the Relay's tier reaches drivability through its snapshot.
    expect(next).toMatchObject({ accessMode: 'open', sessionMode: 'write', allowsFork: false, revision: 2 })
    expect(next).not.toHaveProperty('expiresAt')
    expect(next?.allowedSubjectIds).toEqual([key, 'deployment-subject', 'bob'])
    expect(next?.access?.selected).toEqual([
      { ...VIEWER, identityKey: key },
      { providerId: 'owner-p', tenantId: 'owner-t', subjectId: 'bob', identityKey: 'owner-p:owner-t:bob' },
    ])
    expect(next?.access?.broadenedByDeploymentSubjects).toBe(true)
    expect(h.scheduleShareExpiry).toHaveBeenCalledWith(next)
  })

  it('omits an identity it cannot read from a bare subject when the host has no owner identity', () => {
    const h = harness({ ownerIdentity: undefined })
    h.ownerShares.set('share-1', storedShare())
    h.authority.applyRelayAccess('share-1', frame({ version: 2, allowedSubjectIds: ['bob'] }))
    expect(h.ownerShares.get('share-1')?.access?.selected).toEqual([])
  })

  it('takes the Relay fork switch and expiry when it states them', () => {
    const h = harness()
    h.ownerShares.set('share-1', storedShare())
    h.authority.applyRelayAccess('share-1', frame({ version: 2, allowsFork: true, expiresAt: '2030-01-01T00:00:00Z' }))
    expect(h.ownerShares.get('share-1')).toMatchObject({ allowsFork: true, expiresAt: '2030-01-01T00:00:00Z' })
  })

  it('ends work admitted against a narrower snapshot', () => {
    const h = harness()
    const admitted = { providerId: 'p', tenantId: 't', subjectId: 'alice' }
    const revoked = { providerId: 'p', tenantId: 't', subjectId: 'bob' }
    h.ownerShares.set('share-1', storedShare({ sessionMode: 'write', allowsFork: true, sessionId: 'session-1' }))
    h.authority.applyRelayAccess('share-1', frame({
      version: 1, sessionMode: 'write', allowsFork: true, allowedSubjectIds: ['alice', 'bob'],
    }))
    h.forks.listForShare.mockReturnValue([
      { childSessionId: 'child-admitted', creator: admitted },
      { childSessionId: 'child-revoked', creator: revoked },
    ] as never)

    h.authority.applyRelayAccess('share-1', frame({
      version: 2, sessionMode: 'view', allowsFork: false, allowedSubjectIds: ['alice'],
    }))
    expect(h.viewerRead.cancelPendingCalls).toHaveBeenCalledWith('share-1')
    expect(h.viewerRead.recheckAdmission).toHaveBeenCalledWith('share-1')
    expect(h.viewerRead.closeViewerStreams).toHaveBeenCalledWith('share-1', revoked)
    expect(h.cancelChildTurns).toHaveBeenCalledWith('share-1', revoked)
    // A narrower admission can have ended a viewer's grant, and the host attributes no turn to a
    // requester: it stops whatever the Session runs now.
    expect(h.cancelShareTurn).toHaveBeenCalledWith('share-1')
    // The Session's sandbox follows its shares, so the host reconciles it after the change.
    expect(h.reconcileSourceAccess).toHaveBeenCalledWith('session-1')
  })

  it('stops no running turn when the adopted snapshot only widens access', () => {
    const h = harness()
    h.ownerShares.set('share-1', storedShare())
    h.authority.applyRelayAccess('share-1', frame({ version: 1, allowedSubjectIds: ['alice'] }))
    h.authority.applyRelayAccess('share-1', frame({ version: 2, allowedSubjectIds: ['alice', 'bob'] }))
    // Adding a viewer ends nothing, and the tier did not change.
    expect(h.cancelShareTurn).not.toHaveBeenCalled()
    expect(h.reconcileSourceAccess).toHaveBeenCalledWith('session-1')
  })

  it('keeps a child whose creator is admitted while the fork switch stays on', () => {
    const h = harness()
    h.ownerShares.set('share-1', storedShare({ allowsFork: true }))
    h.authority.applyRelayAccess('share-1', frame({ version: 1, allowsFork: true, allowedSubjectIds: ['alice'] }))
    h.forks.listForShare.mockReturnValue([{ childSessionId: 'child', creator: VIEWER }] as never)
    h.authority.applyRelayAccess('share-1', frame({ version: 2, allowsFork: true, sessionMode: 'write', allowedSubjectIds: ['alice'] }))
    expect(h.cancelChildTurns).not.toHaveBeenCalled()
    expect(h.viewerRead.closeViewerStreams).not.toHaveBeenCalled()
  })

  it('re-checks when only the ACL changed, by length or by value', () => {
    const h = harness()
    h.ownerShares.set('share-1', storedShare())
    h.authority.applyRelayAccess('share-1', frame({ version: 1, allowsFork: false, allowedSubjectIds: ['alice'] }))
    h.authority.applyRelayAccess('share-1', frame({ version: 2, allowsFork: false, allowedSubjectIds: ['alice', 'bob'] }))
    h.authority.applyRelayAccess('share-1', frame({ version: 3, allowsFork: false, allowedSubjectIds: ['bob', 'carol'] }))
    expect(h.viewerRead.recheckAdmission).toHaveBeenCalledTimes(2)
  })

  it('does not re-check anything when the snapshot states the same access', () => {
    const h = harness()
    h.ownerShares.set('share-1', storedShare({ sessionMode: 'write' }))
    h.authority.applyRelayAccess('share-1', frame({ version: 1, sessionMode: 'write', allowsFork: false, allowedSubjectIds: ['alice'] }))
    h.authority.applyRelayAccess('share-1', frame({ version: 2, sessionMode: 'write', allowsFork: false, allowedSubjectIds: ['alice'] }))
    expect(h.viewerRead.recheckAdmission).not.toHaveBeenCalled()
  })
})

describe('relay authority reads', () => {
  const share = (): OwnerShare => storedShare()

  it('adopts the state one Relay answers with', async () => {
    const h = harness()
    const record = { ...share(), sessionMode: 'write' as const }
    h.ownerShares.set(record.shareId, record)
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({
      version: 4, accessMode: 'selected', allowedSubjectIds: ['alice'], sessionMode: 'write', allowsFork: true,
    })))
    await expect(h.authority.readRelayAuthority(record)).resolves.toMatchObject({ ok: true })
    expect(h.ownerShares.get(record.shareId)).toMatchObject({ accessMode: 'selected' })
    expect(h.authority.drivableModeOf(record.shareId)).toBe('write')
    // oxlint-disable-next-line typescript/no-base-to-string -- typed test doubles and mock calls.
    const url = String(vi.mocked(fetch).mock.calls[0]?.[0])
    expect(url).toContain('/__liveshare/requests?shareId=share-1')
  })

  it('adopts a state whose answer states no media type', async () => {
    const h = harness()
    const record = share()
    h.ownerShares.set(record.shareId, record)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new TextEncoder().encode(JSON.stringify({
      version: 1, accessMode: 'open', allowedSubjectIds: [], sessionMode: 'view',
    })))))
    await expect(h.authority.readRelayAuthority(record)).resolves.toMatchObject({ ok: true })
  })

  it('invalidates authority held for a share that is gone or already offline', () => {
    const h = harness()
    h.authority.invalidateRelayAccess('absent')
    expect(h.viewerRead.closeShare).toHaveBeenCalledWith('absent')
    expect(h.cancelShareTurn).not.toHaveBeenCalled()
    expect(h.cancelChildTurns).not.toHaveBeenCalled()
    h.ownerShares.set('share-1', storedShare({ online: false }))
    h.authority.invalidateRelayAccess('share-1')
    expect(h.cancelShareTurn).not.toHaveBeenCalled()
  })

  it('invalidates held authority for an answer whose JSON cannot be read', async () => {
    const h = harness()
    h.ownerShares.set('share-1', storedShare())
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not json', { status: 200 })))
    await expect(h.authority.readRelayAuthority(share())).resolves.toEqual({ ok: false })
    expect(h.viewerRead.closeShare).toHaveBeenCalledWith('share-1')
  })

  it('invalidates held authority for a refused or unreadable answer', async () => {
    for (const answer of [
      () => Promise.resolve(new Response('no', { status: 500 })),
      () => Promise.resolve(Response.json('not a record')),
      () => Promise.resolve(Response.json({ version: 1 })),
      () => Promise.reject(new Error('offline')),
    ]) {
      const h = harness()
      h.ownerShares.set('share-1', storedShare({ online: true }))
      vi.stubGlobal('fetch', vi.fn(answer))
      await expect(h.authority.readRelayAuthority(share())).resolves.toEqual({ ok: false })
      expect(h.viewerRead.closeShare).toHaveBeenCalledWith('share-1')
      expect(h.cancelShareTurn).toHaveBeenCalledWith('share-1')
    }
  })

  it('refuses a read that was cancelled before or during the request', async () => {
    const h = harness()
    const controller = new AbortController()
    controller.abort(new Error('cancelled'))
    await expect(h.authority.readRelayAuthority(share(), controller.signal)).rejects.toThrow('cancelled')

    const mid = new AbortController()
    vi.stubGlobal('fetch', vi.fn(async () => {
      mid.abort(new Error('left'))
      return Response.json({ version: 1, accessMode: 'open', allowedSubjectIds: [], sessionMode: 'view' })
    }))
    await expect(h.authority.readRelayAuthority(share(), mid.signal)).rejects.toThrow('left')
  })

  it('fences a read whose share was invalidated or replaced while it ran', async () => {
    const h = harness()
    h.ownerShares.set('share-1', storedShare())
    vi.stubGlobal('fetch', vi.fn(async () => {
      h.authority.invalidateRelayAccess('share-1')
      return Response.json({ version: 9, accessMode: 'open', allowedSubjectIds: [], sessionMode: 'view' })
    }))
    await expect(h.authority.readRelayAuthority(share())).resolves.toEqual({ ok: false })
    expect(h.ownerShares.get('share-1')?.revision).toBe(1)
    expect(h.viewerRead.closeShare).toHaveBeenCalledTimes(1)
  })

  it('fences a read whose share token or Relay changed while it ran', async () => {
    for (const change of [
      { gatewayToken: 'new-token' },
      { relay: 'https://other.example.test/liveshare' },
    ]) {
      const h = harness()
      h.ownerShares.set('share-1', storedShare())
      vi.stubGlobal('fetch', vi.fn(async () => {
        h.ownerShares.set('share-1', storedShare(change))
        return Response.json({ version: 9, accessMode: 'open', allowedSubjectIds: [], sessionMode: 'view' })
      }))
      await expect(h.authority.readRelayAuthority(share())).resolves.toEqual({ ok: false })
    }
  })

  it('fences a read that finishes after this host was disposed', async () => {
    const h = harness()
    h.ownerShares.set('share-1', storedShare())
    vi.stubGlobal('fetch', vi.fn(async () => {
      h.state.disposed = true
      return Response.json({ version: 9, accessMode: 'open', allowedSubjectIds: [], sessionMode: 'view' })
    }))
    await expect(h.authority.readRelayAuthority(share())).resolves.toEqual({ ok: false })
  })
})

describe('relay authority refresh and drivability', () => {
  it('refuses a refresh for a missing or disposed share', async () => {
    const h = harness()
    await expect(h.authority.refreshRelayAccess('absent')).rejects.toThrow('share-not-found')
    h.ownerShares.set('share-1', storedShare())
    h.state.disposed = true
    await expect(h.authority.refreshRelayAccess('share-1')).rejects.toThrow('share-not-found')
  })

  it('resolves a refresh whose read established authority', async () => {
    const h = harness()
    h.ownerShares.set('share-1', storedShare())
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({
      version: 1, accessMode: 'open', allowedSubjectIds: [], sessionMode: 'view',
    })))
    await expect(h.authority.refreshRelayAccess('share-1')).resolves.toBeUndefined()
  })

  it('refuses a refresh whose read could not establish authority', async () => {
    const h = harness()
    h.ownerShares.set('share-1', storedShare())
    vi.stubGlobal('fetch', vi.fn(async () => new Response('no', { status: 500 })))
    await expect(h.authority.refreshRelayAccess('share-1')).rejects.toThrow('Relay access state is unavailable')
  })

  it('reports admission only while this host holds unexpired authority for the viewer', () => {
    const h = harness()
    expect(h.authority.viewerAdmitted('share-1', VIEWER)).toBe(false)
    h.ownerShares.set('share-1', storedShare())
    h.authority.applyRelayAccess('share-1', frame({ allowedSubjectIds: ['alice'] }))
    expect(h.authority.viewerAdmitted('share-1', VIEWER)).toBe(true)
    expect(h.authority.viewerAdmitted('share-1', { ...VIEWER, subjectId: 'bob' })).toBe(false)
    h.authority.applyRelayAccess('share-1', frame({ version: 2, allowedSubjectIds: ['alice'], expiresAt: '2000-01-01T00:00:00Z' }))
    expect(h.authority.viewerAdmitted('share-1', VIEWER)).toBe(false)
    h.state.disposed = true
    expect(h.authority.viewerAdmitted('share-1', VIEWER)).toBe(false)
  })

  it('forgets held authority when the worker reconnects a share', () => {
    const h = harness()
    h.ownerShares.set('share-1', storedShare())
    h.authority.applyRelayAccess('share-1', frame({ allowedSubjectIds: ['alice'] }))
    h.authority.forgetRelayAccess('share-1')
    expect(h.authority.viewerAdmitted('share-1', VIEWER)).toBe(false)
    expect(h.accessChanged).toHaveBeenCalled()
  })

  it('reports the narrower of the stored and Relay tiers, and nothing without authority', () => {
    const h = harness()
    expect(h.authority.drivableModeOf('share-1')).toBeUndefined()
    h.ownerShares.set('share-1', storedShare({ sessionMode: 'write' }))
    expect(h.authority.drivableModeOf('share-1')).toBeUndefined()
    h.authority.applyRelayAccess('share-1', frame({ sessionMode: 'write' }))
    expect(h.authority.drivableModeOf('share-1')).toBe('write')
    h.authority.applyRelayAccess('share-1', frame({ version: 2, sessionMode: 'view' }))
    expect(h.authority.drivableModeOf('share-1')).toBe('view')

    h.ownerShares.set('share-1', storedShare({ sessionMode: 'view' }))
    h.authority.applyRelayAccess('share-1', frame({ version: 3, sessionMode: 'write' }))
    expect(h.authority.drivableModeOf('share-1')).toBe('view')

    h.ownerShares.set('share-1', storedShare({ expiresAt: '2000-01-01T00:00:00Z' }))
    expect(h.authority.drivableModeOf('share-1')).toBeUndefined()
    h.state.disposed = true
    expect(h.authority.drivableModeOf('share-1')).toBeUndefined()
  })
})
