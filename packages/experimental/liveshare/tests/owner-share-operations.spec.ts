/**
 * Owner share operations against their dependency seams.
 *
 * The host integration specs drive the same operations through the assembled plugin; this suite
 * pins the operation order and refusal paths that only a failing dependency reaches.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OwnerShare } from '../src/host/owner-types.ts'
import type { OwnerShareOperations } from '../src/host/share-operations.ts'
import { createOwnerShareOperations } from '../src/host/owner-share-operations.ts'

const RELAY = 'https://relay.example.test/liveshare'

function storedShare(overrides: Partial<OwnerShare> = {}): OwnerShare {
  return {
    shareId: 'share-1',
    sessionId: 'session-1',
    sessionTitle: 'Session',
    accessMode: 'open',
    link: `${RELAY}/?shareId=share-1`,
    relay: RELAY,
    gatewayToken: 'gateway-token',
    allowedSubjectIds: [],
    revision: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    allowsFork: false,
    sessionMode: 'view',
    online: true,
    ...overrides,
  }
}

interface Harness {
  readonly operations: OwnerShareOperations
  readonly ownerShares: Map<string, OwnerShare>
  readonly pendingRemovals: Map<string, { relay: string; shareId: string; gatewayToken: string }>
  readonly tunnel: {
    credentialForRelay: ReturnType<typeof vi.fn>
    ownerIdentityStatus: ReturnType<typeof vi.fn>
    waitForShare: ReturnType<typeof vi.fn>
    send: ReturnType<typeof vi.fn>
    shareSpec: ReturnType<typeof vi.fn>
    clearShareExpiry: ReturnType<typeof vi.fn>
    scheduleShareExpiry: ReturnType<typeof vi.fn>
    reconcileShareTitles: ReturnType<typeof vi.fn>
    flushPendingRemovals: ReturnType<typeof vi.fn>
    deleteRelayRow: ReturnType<typeof vi.fn>
    armPendingRemovalRetry: ReturnType<typeof vi.fn>
    factsFor: ReturnType<typeof vi.fn>
    probeRelayCredentialSupport: ReturnType<typeof vi.fn>
    probeRelayConnectivity: ReturnType<typeof vi.fn>
    probeRelayPublish: ReturnType<typeof vi.fn>
  }
  readonly relay: { readRelayAuthority: ReturnType<typeof vi.fn> }
  readonly viewerRead: { closeShare: ReturnType<typeof vi.fn>; cancelPendingCalls: ReturnType<typeof vi.fn> }
  readonly forks: { revokeShare: ReturnType<typeof vi.fn> }
  readonly viewerDeclarations: { declaredCapabilities: ReturnType<typeof vi.fn> }
  readonly persistOwnerState: ReturnType<typeof vi.fn>
  readonly applySourceAccess: ReturnType<typeof vi.fn>
  readonly accessChanged: ReturnType<typeof vi.fn>
  readonly cancelShareTurn: ReturnType<typeof vi.fn>
  readonly cancelChildTurns: ReturnType<typeof vi.fn>
  readonly reconcileSourceAccess: ReturnType<typeof vi.fn>
  readonly selectRelayAddress: ReturnType<typeof vi.fn>
  readonly bumpRelayRevision: ReturnType<typeof vi.fn>
  readonly sourceConfined: ReturnType<typeof vi.fn>
  readonly storedCredential: ReturnType<typeof vi.fn>
  readonly effectiveRelay: ReturnType<typeof vi.fn>
}

function harness(): Harness {
  const ownerShares = new Map<string, OwnerShare>()
  const pendingRemovals = new Map<string, { relay: string; shareId: string; gatewayToken: string }>()
  let effective: string | undefined = RELAY
  const tunnel = {
    credentialForRelay: vi.fn(() => 'relay-credential'),
    ownerIdentityStatus: vi.fn((relay: string) => ({ state: 'missing', relay })),
    waitForShare: vi.fn(async () => ({ ok: true })),
    send: vi.fn(),
    shareSpec: vi.fn((share: unknown) => share),
    clearShareExpiry: vi.fn(),
    scheduleShareExpiry: vi.fn(),
    reconcileShareTitles: vi.fn(async () => {}),
    flushPendingRemovals: vi.fn(async () => {}),
    deleteRelayRow: vi.fn(async () => true),
    armPendingRemovalRetry: vi.fn(),
    factsFor: vi.fn(() => ({})),
    probeRelayCredentialSupport: vi.fn(async () => {}),
    probeRelayConnectivity: vi.fn(async () => ({ ok: true, httpReachable: true, blocking: false })),
    probeRelayPublish: vi.fn(async () => ({ ok: true, blocking: false })),
  }
  const relay = { readRelayAuthority: vi.fn(async () => ({ ok: true })) }
  const viewerRead = { closeShare: vi.fn(), cancelPendingCalls: vi.fn() }
  const forks = { revokeShare: vi.fn(async () => {}) }
  const viewerDeclarations = { declaredCapabilities: vi.fn(() => []) }
  const persistOwnerState = vi.fn(async () => {})
  const applySourceAccess = vi.fn(async () => {})
  const accessChanged = vi.fn()
  const cancelShareTurn = vi.fn()
  const cancelChildTurns = vi.fn()
  const reconcileSourceAccess = vi.fn()
  const selectRelayAddress = vi.fn((override: string | undefined) => { effective = override })
  const bumpRelayRevision = vi.fn()
  const sourceConfined = vi.fn(() => true)
  const storedCredential = vi.fn(() => undefined)
  const effectiveRelay = vi.fn(() => effective)
  const operations = createOwnerShareOperations({
    ownerShares,
    pendingRemovals,
    allowedSubjectIds: [],
    forks,
    viewerRead,
    viewerDeclarations,
    relay,
    tunnel,
    effectiveRelay,
    relayState: () => effective === undefined ? {} : { override: effective, effective },
    selectRelayAddress,
    bumpRelayRevision,
    storedCredential,
    persistOwnerState,
    applySourceAccess,
    sourceConfined,
    accessChanged,
    cancelShareTurn,
    cancelChildTurns,
    reconcileSourceAccess,
  } as never)
  return {
    operations, ownerShares, pendingRemovals, tunnel, relay, viewerRead, forks, viewerDeclarations,
    persistOwnerState, applySourceAccess, accessChanged, cancelShareTurn, cancelChildTurns, reconcileSourceAccess,
    selectRelayAddress, bumpRelayRevision, sourceConfined, storedCredential, effectiveRelay,
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('creating a share', () => {
  it('registers, stores, persists, and exposes one share', async () => {
    const h = harness()
    h.ownerShares.set('kept', storedShare({ shareId: 'kept' }))
    const now = Date.now()
    const created = await h.operations.create({
      sessionId: 'session-1', sessionTitle: 'My Session', accessMode: 'selected', ttlMinutes: 10,
      allowedSubjectIds: ['alice'], sessionMode: 'write', allowsFork: true,
    })

    expect(created).toMatchObject({ sessionId: 'session-1', sessionMode: 'write' })
    expect(created.link).toMatch(/^https:\/\/relay\.example\.test\/liveshare\/\?shareId=/u)
    const stored = h.ownerShares.get(created.shareId)
    expect(stored).toMatchObject({
      sessionId: 'session-1', sessionTitle: 'My Session', accessMode: 'selected', relay: RELAY,
      allowedSubjectIds: ['alice'], sessionMode: 'write', allowsFork: true, online: true, revision: 1,
    })
    expect(Date.parse(stored?.expiresAt ?? '')).toBeGreaterThanOrEqual(now + 10 * 60_000)
    // oxlint-disable-next-line typescript/no-unsafe-assignment -- typed test doubles and mock calls.
    expect(h.tunnel.send).toHaveBeenCalledWith({ type: 'add-share', share: expect.objectContaining({ shareId: created.shareId }) })
    expect(h.tunnel.waitForShare).toHaveBeenCalledWith(created.shareId, 15_000)
    expect(h.persistOwnerState).toHaveBeenCalledTimes(1)
    expect(h.tunnel.scheduleShareExpiry).toHaveBeenCalledWith(stored)
    expect(h.applySourceAccess).toHaveBeenCalledWith(stored, undefined, 'publish')
    expect(h.ownerShares.has('kept')).toBe(true)
  })

  it('falls back to the session id and open/view defaults', async () => {
    const h = harness()
    const created = await h.operations.create({ sessionId: 'session-2', sessionTitle: '' })
    const stored = h.ownerShares.get(created.shareId)
    expect(stored).toMatchObject({ sessionTitle: 'session-2', accessMode: 'open', sessionMode: 'view', allowsFork: false })
    expect(stored).not.toHaveProperty('expiresAt')
    expect(stored?.access?.broadenedByDeploymentSubjects).toBe(false)
  })

  it('refuses a share with no Session id', async () => {
    const h = harness()
    await expect(h.operations.create({ sessionId: '' }))
      .rejects.toMatchObject({ code: 'liveshareShares/missing-session-id' })
    expect(h.tunnel.send).not.toHaveBeenCalled()
  })

  it('refuses a Relay that cannot bind owner identity', async () => {
    const h = harness()
    h.tunnel.credentialForRelay.mockReturnValue(undefined)
    h.tunnel.ownerIdentityStatus.mockReturnValue({ state: 'relay-unsupported', relay: RELAY })
    await expect(h.operations.create({ sessionId: 'session-1' }))
      .rejects.toMatchObject({ code: 'liveshareShares/relay-upgrade-required' })
  })

  it('asks for owner login before it asks the Relay to register', async () => {
    const h = harness()
    h.tunnel.credentialForRelay.mockReturnValue(undefined)
    h.tunnel.ownerIdentityStatus.mockReturnValue({ state: 'missing', relay: RELAY })
    await expect(h.operations.create({ sessionId: 'session-1' }))
      .rejects.toMatchObject({ code: 'liveshareShares/owner-login-required' })
    expect(h.tunnel.send).not.toHaveBeenCalled()
  })

  it('refuses lifetimes outside the owner-controlled range', async () => {
    const h = harness()
    for (const ttlMinutes of [0, -1, 1.5, 7 * 24 * 60 + 1]) {
      await expect(h.operations.create({ sessionId: 'session-1', ttlMinutes }))
        .rejects.toMatchObject({ code: 'liveshareShares/invalid-ttl' })
    }
    expect(h.tunnel.send).not.toHaveBeenCalled()
  })

  it('removes the worker registration when the Relay never settles it', async () => {
    const h = harness()
    h.tunnel.waitForShare.mockResolvedValue({ ok: false, error: 'relay down' })
    await expect(h.operations.create({ sessionId: 'session-1' }))
      .rejects.toMatchObject({ code: 'liveshareShares/relay-unavailable', details: { relay: RELAY, reason: 'relay down' } })
    expect(h.tunnel.send).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'remove-share' }))
    expect(h.ownerShares.size).toBe(0)
  })

  it('reports an unexplained settlement failure without a reason field', async () => {
    const h = harness()
    h.tunnel.waitForShare.mockResolvedValue({ ok: false })
    await expect(h.operations.create({ sessionId: 'session-1' }))
      .rejects.toMatchObject({ code: 'liveshareShares/relay-unavailable', details: { relay: RELAY } })
  })

  it('rolls the registration back when the owner state cannot be written', async () => {
    const h = harness()
    h.persistOwnerState.mockRejectedValue(new Error('disk full'))
    await expect(h.operations.create({ sessionId: 'session-1' }))
      .rejects.toMatchObject({ code: 'liveshareShares/owner-state-unavailable' })
    expect(h.ownerShares.size).toBe(0)
    expect(h.tunnel.clearShareExpiry).toHaveBeenCalled()
    expect(h.tunnel.send).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'remove-share' }))
    expect(h.applySourceAccess).not.toHaveBeenCalled()
  })
})

describe('listing shares', () => {
  it('reconciles, flushes, reads each authority, and reports stored fields', async () => {
    const h = harness()
    const share = storedShare({
      access: {
        mode: 'approval', selected: [], deploymentAllowedSubjectIds: ['dep'], shareAllowedSubjectIds: ['dep'],
        broadenedByDeploymentSubjects: true, identityKeyAcl: true,
      },
      expiresAt: '2030-01-01T00:00:00Z',
      viewerCapabilities: [{ plugin: 'files', readable: ['files/read'], writable: [] }],
    })
    h.ownerShares.set(share.shareId, share)
    const listed = await h.operations.list()
    expect(h.tunnel.reconcileShareTitles).toHaveBeenCalledTimes(1)
    expect(h.tunnel.flushPendingRemovals).toHaveBeenCalledTimes(1)
    expect(h.relay.readRelayAuthority).toHaveBeenCalledWith(share)
    expect(listed.shares).toEqual([expect.objectContaining({
      shareId: 'share-1', expiresAt: '2030-01-01T00:00:00Z',
      viewerCapabilities: [{ plugin: 'files', readable: ['files/read'], writable: [] }],
      // oxlint-disable-next-line typescript/no-unsafe-assignment -- typed test doubles and mock calls.
      access: expect.objectContaining({ mode: 'selected' }),
    })])
    expect(h.persistOwnerState).not.toHaveBeenCalled()
  })

  it('omits optional fields a share does not carry', async () => {
    const h = harness()
    h.ownerShares.set('bare', storedShare({ shareId: 'bare' }))
    const listed = await h.operations.list()
    expect(listed.shares[0]).not.toHaveProperty('expiresAt')
    expect(listed.shares[0]).not.toHaveProperty('access')
    expect(listed.shares[0]?.viewerCapabilities).toEqual([])
  })

  it('drops a share whose record disappeared while its authority was read', async () => {
    const h = harness()
    h.ownerShares.set('gone', storedShare({ shareId: 'gone' }))
    // oxlint-disable-next-line typescript/no-misused-promises -- typed test doubles and mock calls.
    h.relay.readRelayAuthority.mockImplementation(async () => {
      h.ownerShares.delete('gone')
      return { ok: true }
    })
    await expect(h.operations.list()).resolves.toEqual({ shares: [] })
  })

  it('persists the records Relay authority changed and reports a failed write', async () => {
    const h = harness()
    h.ownerShares.set('share-1', storedShare())
    // oxlint-disable-next-line typescript/no-misused-promises -- typed test doubles and mock calls.
    h.relay.readRelayAuthority.mockImplementation(async () => {
      h.ownerShares.set('share-1', storedShare({ sessionTitle: 'Renamed' }))
      return { ok: true }
    })
    await expect(h.operations.list()).resolves.toMatchObject({ shares: [{ sessionTitle: 'Renamed' }] })
    expect(h.persistOwnerState).toHaveBeenCalledTimes(1)

    h.persistOwnerState.mockRejectedValue(new Error('disk full'))
    await expect(h.operations.list()).rejects.toMatchObject({ code: 'liveshareShares/owner-state-unavailable' })
  })
})

describe('stopping a share', () => {
  it('revokes every local owner of the share before deleting its Relay row', async () => {
    const h = harness()
    const share = storedShare()
    h.ownerShares.set(share.shareId, share)
    await expect(h.operations.stop({ shareId: share.shareId })).resolves.toEqual({ ok: true })
    expect(h.tunnel.send).toHaveBeenCalledWith({ type: 'remove-share', shareId: share.shareId })
    expect(h.viewerRead.closeShare).toHaveBeenCalledWith(share.shareId)
    expect(h.cancelShareTurn).toHaveBeenCalledWith(share.shareId)
    expect(h.cancelChildTurns).toHaveBeenCalledWith(share.shareId)
    // A Session no share names any more loses its sandbox.
    expect(h.reconcileSourceAccess).toHaveBeenCalledWith(share.sessionId)
    expect(h.forks.revokeShare).toHaveBeenCalledWith(share.shareId, expect.any(String))
    expect(h.ownerShares.has(share.shareId)).toBe(false)
    expect(h.accessChanged).toHaveBeenCalled()
    expect(h.tunnel.clearShareExpiry).toHaveBeenCalledWith(share.shareId)
    expect(h.tunnel.deleteRelayRow).toHaveBeenCalledWith(RELAY, share.shareId, 'gateway-token')
  })

  it('refuses an unknown share', async () => {
    const h = harness()
    await expect(h.operations.stop({ shareId: 'absent' }))
      .rejects.toMatchObject({ code: 'liveshareShares/share-not-found', details: { shareId: 'absent' } })
  })

  it('keeps a pending removal when the Relay row cannot be deleted', async () => {
    const h = harness()
    h.ownerShares.set('share-1', storedShare())
    h.tunnel.deleteRelayRow.mockResolvedValue(false)
    await expect(h.operations.stop({ shareId: 'share-1' })).resolves.toEqual({ ok: true, relay: 'unreachable' })
    expect(h.pendingRemovals.get('share-1')).toEqual({ relay: RELAY, shareId: 'share-1', gatewayToken: 'gateway-token' })
    expect(h.persistOwnerState).toHaveBeenCalledTimes(2)
    expect(h.tunnel.armPendingRemovalRetry).toHaveBeenCalledTimes(1)
  })

  it('reports a failed write before and after the Relay row decision', async () => {
    const h = harness()
    h.ownerShares.set('share-1', storedShare())
    h.persistOwnerState.mockRejectedValue(new Error('disk full'))
    await expect(h.operations.stop({ shareId: 'share-1' }))
      .rejects.toMatchObject({ code: 'liveshareShares/owner-state-unavailable' })
    expect(h.tunnel.deleteRelayRow).not.toHaveBeenCalled()

    h.ownerShares.set('share-2', storedShare({ shareId: 'share-2' }))
    h.persistOwnerState.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('disk full'))
    h.tunnel.deleteRelayRow.mockResolvedValue(false)
    await expect(h.operations.stop({ shareId: 'share-2' }))
      .rejects.toMatchObject({ code: 'liveshareShares/owner-state-unavailable' })
    expect(h.tunnel.armPendingRemovalRetry).not.toHaveBeenCalled()
  })
})

describe('updating share permissions', () => {
  it('re-registers a changed tier and re-installs the access layer', async () => {
    const h = harness()
    h.ownerShares.set('share-1', storedShare({ sessionMode: 'write' }))
    await expect(h.operations.updatePermissions({ shareId: 'share-1', sessionMode: 'view', allowsFork: true }))
      .resolves.toMatchObject({ shareId: 'share-1', sessionMode: 'view', allowsFork: true })
    expect(h.ownerShares.get('share-1')).toMatchObject({ sessionMode: 'view', allowsFork: true, revision: 2 })
    expect(h.viewerRead.cancelPendingCalls).toHaveBeenCalledWith('share-1')
    expect(h.persistOwnerState).toHaveBeenCalledTimes(1)
    // oxlint-disable-next-line typescript/no-unsafe-member-access, typescript/no-unsafe-return -- typed test doubles and mock calls.
    expect(h.tunnel.send.mock.calls.map(call => call[0].type)).toEqual(['remove-share', 'add-share'])
    expect(h.applySourceAccess).toHaveBeenCalledWith(expect.objectContaining({ sessionMode: 'view' }), undefined, 'mode')
  })

  it('keeps the stored value for a switch the request omits', async () => {
    const h = harness()
    h.ownerShares.set('share-1', storedShare({ sessionMode: 'write', allowsFork: true }))
    await expect(h.operations.updatePermissions({ shareId: 'share-1', allowsFork: false }))
      .resolves.toMatchObject({ shareId: 'share-1', sessionMode: 'write', allowsFork: false })
    expect(h.forks.revokeShare).toHaveBeenCalledWith('share-1', expect.any(String))
  })

  it('reinstalls a missing layer when the requested permissions are already stored', async () => {
    const h = harness()
    h.ownerShares.set('share-1', storedShare())
    h.sourceConfined.mockReturnValue(false)
    await expect(h.operations.updatePermissions({ shareId: 'share-1', sessionMode: 'view' }))
      .resolves.toEqual({ shareId: 'share-1', sessionMode: 'view', allowsFork: false })
    expect(h.applySourceAccess).toHaveBeenCalledWith(expect.objectContaining({ shareId: 'share-1' }), undefined, 'mode')
    expect(h.persistOwnerState).not.toHaveBeenCalled()
    expect(h.tunnel.send).not.toHaveBeenCalled()

    h.sourceConfined.mockReturnValue(true)
    await h.operations.updatePermissions({ shareId: 'share-1', sessionMode: 'view' })
    expect(h.applySourceAccess).toHaveBeenCalledTimes(1)
  })

  it('updates the lifetime without changing the stored link scope', async () => {
    const h = harness()
    h.ownerShares.set('share-1', storedShare())
    await expect(h.operations.updatePermissions({ shareId: 'share-1', ttlMinutes: 10 }))
      .resolves.toMatchObject({ shareId: 'share-1', sessionMode: 'view', allowsFork: false })
    const stored = h.ownerShares.get('share-1')
    expect(stored?.expiresAt).toBeDefined()
    expect(stored?.accessMode).toBe('open')
    expect(h.tunnel.scheduleShareExpiry).toHaveBeenCalled()
    // oxlint-disable-next-line typescript/no-unsafe-member-access, typescript/no-unsafe-return -- typed test doubles and mock calls.
    expect(h.tunnel.send.mock.calls.map(call => call[0].type)).toEqual(['remove-share', 'add-share'])
  })

  it('returns the current deadline when the request repeats stored state', async () => {
    const h = harness()
    h.ownerShares.set('share-1', storedShare({ expiresAt: '2026-10-30T00:00:00.000Z' }))
    h.sourceConfined.mockReturnValue(true)
    await expect(h.operations.updatePermissions({ shareId: 'share-1', sessionMode: 'view' }))
      .resolves.toMatchObject({ expiresAt: '2026-10-30T00:00:00.000Z' })
  })

  it('clears the stored lifetime', async () => {
    const h = harness()
    h.ownerShares.set('share-1', storedShare({ expiresAt: '2026-10-30T00:00:00.000Z' }))
    await expect(h.operations.updatePermissions({ shareId: 'share-1', ttlMinutes: null }))
      .resolves.toMatchObject({ shareId: 'share-1', sessionMode: 'view', allowsFork: false })
    expect(h.ownerShares.get('share-1')?.expiresAt).toBeUndefined()
  })

  it('refuses an invalid lifetime', async () => {
    const h = harness()
    h.ownerShares.set('share-1', storedShare())
    for (const ttlMinutes of [0, -1, 1.5, 7 * 24 * 60 + 1]) {
      await expect(h.operations.updatePermissions({ shareId: 'share-1', ttlMinutes }))
        .rejects.toMatchObject({ code: 'liveshareShares/invalid-ttl' })
    }
  })

  it('refuses malformed, incomplete, and unknown updates', async () => {
    const h = harness()
    await expect(h.operations.updatePermissions({ shareId: '' }))
      .rejects.toMatchObject({ code: 'liveshareShares/missing-share-id' })
    await expect(h.operations.updatePermissions({ shareId: 'share-1' }))
      .rejects.toMatchObject({ code: 'liveshareShares/missing-permission' })
    await expect(h.operations.updatePermissions({ shareId: 'absent', sessionMode: 'view' }))
      .rejects.toMatchObject({ code: 'liveshareShares/share-not-found' })
  })

  it('restores the previous record when the write fails', async () => {
    const h = harness()
    const share = storedShare()
    h.ownerShares.set(share.shareId, share)
    h.persistOwnerState.mockRejectedValue(new Error('disk full'))
    await expect(h.operations.updatePermissions({ shareId: share.shareId, sessionMode: 'write' }))
      .rejects.toMatchObject({ code: 'liveshareShares/owner-state-unavailable' })
    expect(h.ownerShares.get(share.shareId)).toBe(share)
    expect(h.tunnel.send).not.toHaveBeenCalled()
  })
})

describe('setting share capabilities', () => {
  const offers = [{ plugin: 'files', readable: ['files/read', 'files/list'], writable: ['files/write'] }]

  it('stores the selection plugins offer and reports it', async () => {
    const h = harness()
    h.ownerShares.set('share-1', storedShare())
    h.viewerDeclarations.declaredCapabilities.mockReturnValue(offers)
    await expect(h.operations.setCapabilities({
      shareId: 'share-1', capabilities: [{ plugin: 'files', readable: ['files/read'], writable: [] }],
    })).resolves.toEqual({ shareId: 'share-1', viewerCapabilities: [{ plugin: 'files', readable: ['files/read'], writable: [] }] })
    expect(h.ownerShares.get('share-1')).toMatchObject({
      revision: 2, viewerCapabilities: [{ plugin: 'files', readable: ['files/read'], writable: [] }],
    })
    expect(h.accessChanged).toHaveBeenCalled()
  })

  it('clears an omitted selection from the record', async () => {
    const h = harness()
    h.ownerShares.set('share-1', storedShare({ viewerCapabilities: offers as never }))
    h.viewerDeclarations.declaredCapabilities.mockReturnValue(offers)
    await expect(h.operations.setCapabilities({ shareId: 'share-1', capabilities: [] }))
      .resolves.toEqual({ shareId: 'share-1', viewerCapabilities: [] })
    expect(h.ownerShares.get('share-1')).not.toHaveProperty('viewerCapabilities')
  })

  it('refuses malformed, unknown, and unoffered selections', async () => {
    const h = harness()
    h.ownerShares.set('share-1', storedShare())
    h.viewerDeclarations.declaredCapabilities.mockReturnValue(offers)
    await expect(h.operations.setCapabilities({ shareId: '', capabilities: [] }))
      .rejects.toMatchObject({ code: 'liveshareShares/missing-share-id' })
    await expect(h.operations.setCapabilities({ shareId: 'absent', capabilities: [] }))
      .rejects.toMatchObject({ code: 'liveshareShares/share-not-found' })
    await expect(h.operations.setCapabilities({ shareId: 'share-1', capabilities: 'files' as never }))
      .rejects.toMatchObject({ code: 'liveshareShares/invalid-capabilities' })
    await expect(h.operations.setCapabilities({
      shareId: 'share-1', capabilities: [{ plugin: 'ghost', readable: [], writable: [] }],
    })).rejects.toMatchObject({ code: 'liveshareShares/unknown-plugin', details: { plugin: 'ghost' } })
    await expect(h.operations.setCapabilities({
      shareId: 'share-1', capabilities: [{ plugin: 'files', readable: ['files/absent'], writable: [] }],
    })).rejects.toMatchObject({
      code: 'liveshareShares/endpoint-not-offered', details: { plugin: 'files', kind: 'readable', endpoint: 'files/absent' },
    })
  })

  it('restores the previous selection when the write fails', async () => {
    const h = harness()
    const share = storedShare()
    h.ownerShares.set(share.shareId, share)
    h.viewerDeclarations.declaredCapabilities.mockReturnValue(offers)
    h.persistOwnerState.mockRejectedValue(new Error('disk full'))
    await expect(h.operations.setCapabilities({
      shareId: share.shareId, capabilities: [{ plugin: 'files', readable: ['files/read'], writable: [] }],
    })).rejects.toMatchObject({ code: 'liveshareShares/owner-state-unavailable' })
    expect(h.ownerShares.get(share.shareId)).toBe(share)
    expect(h.accessChanged).not.toHaveBeenCalled()
  })
})

describe('Relay selection and identity', () => {
  it('selects a normalized override, bumps the revision, and persists', async () => {
    const h = harness()
    await h.operations.setRelay({ relayUrl: '  https://other.example.test/base/  ' })
    expect(h.selectRelayAddress).toHaveBeenCalledWith('https://other.example.test/base')
    expect(h.bumpRelayRevision).toHaveBeenCalledTimes(1)
    expect(h.persistOwnerState).toHaveBeenCalledTimes(1)
  })

  it('clears the saved address for null or blank input', async () => {
    const h = harness()
    await h.operations.setRelay({ relayUrl: null })
    expect(h.selectRelayAddress).toHaveBeenLastCalledWith(undefined)
    // Clearing returns the host to no address, which is a change from the one it had.
    expect(h.bumpRelayRevision).toHaveBeenCalledTimes(1)
    await h.operations.setRelay({ relayUrl: '   ' })
    expect(h.selectRelayAddress).toHaveBeenLastCalledWith(undefined)
    // Nothing was in force any more, so clearing again changes nothing.
    expect(h.bumpRelayRevision).toHaveBeenCalledTimes(1)
  })

  it('refuses to publish, ask about an identity, or probe before an address is saved', async () => {
    const h = harness()
    await h.operations.setRelay({ relayUrl: null })

    await expect(h.operations.create({ sessionId: 'session-1' }))
      .rejects.toMatchObject({ code: 'liveshareShares/relay-url-required' })
    await expect(h.operations.identity({}))
      .rejects.toMatchObject({ code: 'liveshareShares/relay-url-required' })
    await expect(h.operations.testRelay()).resolves.toEqual({
      ok: false, httpReachable: false, blocking: true, error: 'no Liveshare server address is saved',
    })
    await expect(h.operations.testPublish({ sessionId: 'session-1' })).resolves.toEqual({
      ok: false, blocking: true, error: 'no Liveshare server address is saved',
    })
    expect(h.tunnel.send).not.toHaveBeenCalled()
    expect(h.tunnel.probeRelayConnectivity).not.toHaveBeenCalled()
    expect(h.tunnel.probeRelayPublish).not.toHaveBeenCalled()
  })

  it('refuses an unusable address and reports a failed write', async () => {
    const h = harness()
    await expect(h.operations.setRelay({ relayUrl: 'not a url' }))
      .rejects.toMatchObject({ code: 'liveshareShares/invalid-relay-url' })
    h.persistOwnerState.mockRejectedValue(new Error('disk full'))
    await expect(h.operations.setRelay({ relayUrl: null }))
      .rejects.toMatchObject({ code: 'liveshareShares/owner-state-unavailable' })
  })

  it('probes an unprobed address before reporting identity', async () => {
    const h = harness()
    h.tunnel.ownerIdentityStatus.mockReturnValue({ state: 'verified', relay: RELAY, subjectId: 'owner' })
    await expect(h.operations.identity({})).resolves.toEqual({ state: 'verified', relay: RELAY, subjectId: 'owner' })
    expect(h.tunnel.probeRelayCredentialSupport).toHaveBeenCalledWith(RELAY)

    h.tunnel.factsFor.mockReturnValue({ supportsCredentials: true })
    await h.operations.identity({ relay: RELAY })
    expect(h.tunnel.probeRelayCredentialSupport).toHaveBeenCalledTimes(1)
  })

  it('re-probes a stale credential so the Relay can extend its horizon', async () => {
    const h = harness()
    h.tunnel.factsFor.mockReturnValue({ supportsCredentials: true })
    h.storedCredential.mockReturnValue({
      relay: RELAY, credential: 'stale-credential', expiresAt: '2020-01-01T00:00:00.000Z',
    })
    h.tunnel.ownerIdentityStatus.mockReturnValue({ state: 'expired', relay: RELAY })
    await h.operations.identity({ relay: RELAY })
    expect(h.tunnel.probeRelayCredentialSupport).toHaveBeenCalledWith(RELAY)
  })

  it('refuses an unusable identity address', async () => {
    const h = harness()
    await expect(h.operations.identity({ relay: 'not a url' }))
      .rejects.toMatchObject({ code: 'liveshareShares/invalid-relay', details: { relay: 'not a url' } })
  })

  it('reports the live offer list and Relay state', () => {
    const h = harness()
    h.viewerDeclarations.declaredCapabilities.mockReturnValue([{ plugin: 'files', readable: ['files/read'], writable: [] }])
    expect(h.operations.capabilities()).toEqual({ capabilities: [{ plugin: 'files', readable: ['files/read'], writable: [] }] })
    expect(h.operations.relay()).toEqual({ override: RELAY, effective: RELAY })
  })
})

describe('reading the Relay audit trail', () => {
  const share = storedShare()

  function respond(body: string, init: ResponseInit = {}): void {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, init)))
  }

  it('forwards the Relay answer with the share identity and token', async () => {
    const h = harness()
    h.ownerShares.set(share.shareId, share)
    respond(JSON.stringify({
      events: [
        { id: 'e1', action: 'open', createdAt: '2026-01-01T00:00:00Z', actor: 'alice', detail: { n: 1 } },
        { id: 'e2', action: 'close', createdAt: '2026-01-01T00:01:00Z' },
      ],
    }), { headers: { 'content-type': 'application/json' } })
    await expect(h.operations.audit({ shareId: share.shareId })).resolves.toEqual({
      events: [
        { id: 'e1', action: 'open', createdAt: '2026-01-01T00:00:00Z', actor: 'alice', detail: { n: 1 } },
        { id: 'e2', action: 'close', createdAt: '2026-01-01T00:01:00Z' },
      ],
    })
    const fetchMock = vi.mocked(fetch)
    const [url, init] = fetchMock.mock.calls[0] ?? []
    // oxlint-disable-next-line typescript/no-base-to-string -- typed test doubles and mock calls.
    expect(String(url)).toBe(`${RELAY}/__liveshare/audit?shareId=share-1`)
    expect(init?.headers).toEqual({ authorization: 'Bearer gateway-token' })
  })

  it('refuses an unknown share before reaching the Relay', async () => {
    const h = harness()
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(h.operations.audit({ shareId: 'absent' }))
      .rejects.toMatchObject({ code: 'liveshareShares/share-not-found' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('reports a Relay refusal with its status, content type, and body', async () => {
    const h = harness()
    h.ownerShares.set(share.shareId, share)
    respond('{"error":"forbidden"}', { status: 403, headers: { 'content-type': 'text/plain' } })
    await expect(h.operations.audit({ shareId: share.shareId })).rejects.toMatchObject({
      code: 'liveshareShares/audit-unavailable',
      details: { relay: RELAY, status: 403, contentType: 'text/plain', body: '{"error":"forbidden"}' },
    })
  })

  it('reports an unavailable audit for a successful answer it cannot parse', async () => {
    const h = harness()
    h.ownerShares.set(share.shareId, share)
    for (const body of [
      '', 'not json', '{}', '{"events":[{"id":"e1"}]}',
      // JSON.parse turns an overflowing number into Infinity, which is not a JSON value.
      '{"events":[{"id":"e1","action":"a","createdAt":"t","detail":{"n":1e999}}]}',
    ]) {
      respond(body)
      await expect(h.operations.audit({ shareId: share.shareId }))
        .rejects.toMatchObject({ code: 'liveshareShares/audit-unavailable', details: { status: 200 } })
    }
    respond('{"events":[{"id":"e1","action":"a","createdAt":"t","detail":{"ok":true}}]}')
    await expect(h.operations.audit({ shareId: share.shareId })).resolves.toEqual({
      events: [{ id: 'e1', action: 'a', createdAt: 't', detail: { ok: true } }],
    })
  })

  it('falls back to JSON as the media type when the Relay states none', async () => {
    const h = harness()
    h.ownerShares.set(share.shareId, share)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new TextEncoder().encode('not json'))))
    await expect(h.operations.audit({ shareId: share.shareId })).rejects.toMatchObject({
      code: 'liveshareShares/audit-unavailable',
      details: { status: 200, contentType: 'application/json; charset=utf-8', body: 'not json' },
    })
  })

  it('reports the Relay as unavailable when the read throws', async () => {
    const h = harness()
    h.ownerShares.set(share.shareId, share)
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    await expect(h.operations.audit({ shareId: share.shareId })).rejects.toMatchObject({
      code: 'liveshareShares/audit-unavailable',
      details: { status: 502, body: '{"error":"relay-unavailable"}' },
    })
  })
})

describe('Relay checks', () => {
  it('flushes owed deletions and probes the effective Relay anonymously', async () => {
    const h = harness()
    await h.operations.testRelay()
    expect(h.tunnel.flushPendingRemovals).toHaveBeenCalledTimes(1)
    expect(h.tunnel.probeRelayConnectivity).toHaveBeenCalledWith(RELAY)
  })

  it('reports the owner login it still owes before publishing a probe share', async () => {
    const h = harness()
    h.tunnel.credentialForRelay.mockReturnValue(undefined)
    await expect(h.operations.testPublish({ sessionId: 'session-1' })).resolves.toMatchObject({
      // oxlint-disable-next-line typescript/no-unsafe-assignment -- typed test doubles and mock calls.
      ok: false, blocking: true, error: expect.stringContaining('no verified owner credential'),
    })
    expect(h.tunnel.probeRelayPublish).not.toHaveBeenCalled()
  })

  it('refuses a publish check with no Session id', async () => {
    const h = harness()
    await expect(h.operations.testPublish({ sessionId: '' }))
      .rejects.toMatchObject({ code: 'liveshareShares/missing-session-id' })
  })

  it('registers one throwaway share with the real credential and identity row', async () => {
    const h = harness()
    h.storedCredential.mockReturnValue({ relay: RELAY, credential: 'owner-credential' })
    h.tunnel.probeRelayPublish.mockResolvedValue({ ok: true, blocking: false })
    await expect(h.operations.testPublish({ sessionId: 'session-1' })).resolves.toEqual({ ok: true, blocking: false })
    expect(h.tunnel.shareSpec).toHaveBeenCalledWith(expect.objectContaining({
      shareId: '', sessionId: 'session-1', sessionTitle: 'session-1', accessMode: 'open', relay: RELAY,
      allowedSubjectIds: [], allowsFork: false, sessionMode: 'view',
    }), { relay: RELAY, credential: 'owner-credential' })
    expect(h.tunnel.probeRelayPublish).toHaveBeenCalledWith(RELAY, expect.objectContaining({ shareId: '' }))
  })
})
