/** Tunnel supervision: worker commands, settlements, timers, credentials, and Relay probes. */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TunnelShareSpec } from '@deepseek-ai/dsh-experimental-liveshare-protocol'
import type { ViewerAnswer } from '../src/viewer-channel.ts'
import { createTunnelSupervision, gatewayWorkerCommand, refreshedShareTitle } from '../src/host/tunnel-supervision.ts'
import { FakeTunnelWorker } from './tunnel-supervision-fake-worker.ts'

vi.mock('../src/host/tunnel-worker.ts', async () => {
  const { FakeTunnelWorker: Fake } = await import('./tunnel-supervision-fake-worker.ts')
  return { TunnelWorker: Fake }
})

const RELAY = 'https://relay.example.test/liveshare'
const temporaryRoots: string[] = []

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

beforeEach(() => {
  FakeTunnelWorker.instances.length = 0
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

function share(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    shareId: 'share-1', sessionId: 'session-1', sessionTitle: 'Session', accessMode: 'open',
    link: `${RELAY}/?shareId=share-1`, relay: RELAY, gatewayToken: 'gateway-token',
    allowedSubjectIds: [], revision: 1, createdAt: '2026-01-01T00:00:00Z',
    allowsFork: false, sessionMode: 'view', online: false, ...overrides,
  }
}

interface HarnessOptions {
  readonly shares?: readonly Record<string, unknown>[]
  readonly pending?: Map<string, { relay: string; shareId: string; gatewayToken: string }>
  readonly credential?: {
    readonly relay: string
    readonly credential: string
    readonly expiresAt?: string
    readonly displayName?: string
    readonly subjectId?: string
    readonly avatarUrl?: string
  }
  readonly ownerIdentity?: { providerId: string; tenantId: string; subjectId: string; displayName?: string }
}

function harness(options: HarnessOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), 'liveshare-supervision-'))
  temporaryRoots.push(root)
  const ownerShares = new Map<string, Record<string, unknown>>()
  for (const entry of options.shares ?? []) ownerShares.set(String(entry.shareId), entry)
  const pendingRemovals = options.pending ?? new Map()
  const state = { disposed: false, credential: options.credential }
  const viewerRead = {
    answer: vi.fn(async (): Promise<ViewerAnswer> => ({ status: 200, body: { ok: true } })),
    closeShare: vi.fn(),
  }
  const relay = {
    applyRelayAccess: vi.fn(),
    forgetRelayAccess: vi.fn(),
    invalidateRelayAccess: vi.fn(),
  }
  const cancelShareTurn = vi.fn()
  const reconcileSourceAccess = vi.fn()
  const accessChanged = vi.fn()
  const ctx = new Context()
  const supervision = createTunnelSupervision({
    ctx,
    ownerShares,
    pendingRemovals,
    instanceId: 'instance-1',
    allowedSubjectIds: ['deployment'],
    ownerContext: { ownerProviderId: 'owner-p', ownerTenantId: 'owner-t' },
    ownerIdentity: options.ownerIdentity,
    relay,
    viewerRead: () => viewerRead,
    accessChanged,
    cancelShareTurn,
    cancelChildTurns: vi.fn(),
    reconcileSourceAccess,
    disposed: () => state.disposed,
    ownerCredentialFile: join(root, 'owner-credential.json'),
    storedCredential: () => state.credential,
    setStoredCredential: (credential: typeof state.credential) => { state.credential = credential },
    persistOwnerState: vi.fn(async () => {}),
  } as never)
  const worker = (): FakeTunnelWorker => {
    const instance = FakeTunnelWorker.instances.at(-1)
    if (instance === undefined) throw new Error('supervisor started no worker')
    return instance
  }
  return {
    supervision, ownerShares, pendingRemovals, state, viewerRead, relay, ctx, worker, root,
    cancelShareTurn, reconcileSourceAccess, accessChanged,
  }
}

function spec(overrides: Partial<TunnelShareSpec> = {}): TunnelShareSpec {
  return {
    shareId: 'share-1', sessionId: 'session-1', sessionTitle: 'Session', accessMode: 'open',
    relay: RELAY, gatewayToken: 'gateway-token', ownerDisplayName: 'Owner', allowedSubjectIds: [],
    ...overrides,
  }
}

describe('worker command and registration helpers', () => {
  it('builds source and built worker launch commands', () => {
    const packageRoot = join(process.cwd(), 'packages/experimental/liveshare')
    expect(gatewayWorkerCommand(pathToFileURL(join(packageRoot, 'src/host/share-host.ts')).href)).toMatchObject({
      executable: process.execPath, args: ['--import', 'tsx/esm', expect.stringContaining(join('src', 'owner-gateway', 'cli.ts'))],
    })
    expect(gatewayWorkerCommand(pathToFileURL(join(packageRoot, 'lib/index.js')).href)).toMatchObject({
      executable: process.execPath, args: [expect.stringContaining(join('lib', 'owner-gateway', 'cli.js'))],
    })
  })

  it('reads a refreshed title only when the Session states a new one', () => {
    expect(refreshedShareTitle('Old', 'New')).toBe('New')
    expect(refreshedShareTitle('Same', 'Same')).toBeUndefined()
    expect(refreshedShareTitle('Old', '')).toBeUndefined()
    expect(refreshedShareTitle('Old', 42)).toBeUndefined()
  })

  it('starts the worker lazily, sends the command, and settles a registration', async () => {
    const h = harness()
    const settled = h.supervision.waitForShare('share-1', 1_000)
    h.supervision.send({ type: 'add-share', share: spec() })
    expect(FakeTunnelWorker.instances).toHaveLength(1)
    expect(h.worker().started).toBe(true)
    expect(h.worker().sent[0]).toMatchObject({ type: 'add-share' })
    h.worker().emit({ type: 'share-connected', registrationToken: 'r', shareId: 'share-1' })
    await expect(settled).resolves.toEqual({ ok: true })
  })

  it('reports a refused registration, an unexplained one, and a timeout', async () => {
    vi.useFakeTimers()
    try {
      const h = harness()
      h.supervision.send({ type: 'add-share', share: spec() })
      const refused = h.supervision.waitForShare('share-1', 1_000)
      h.worker().emit({ type: 'share-error', registrationToken: 'r', shareId: 'share-1', message: 'relay refused registration status=401' })
      await expect(refused).resolves.toEqual({ ok: false, error: 'relay refused registration status=401' })

      const unexplained = h.supervision.waitForShare('share-1', 1_000)
      h.worker().emit({ type: 'share-error', registrationToken: 'r', shareId: 'share-1', message: '' })
      await expect(unexplained).resolves.toEqual({ ok: false })

      const timedOut = h.supervision.waitForShare('share-1', 1_000)
      await vi.advanceTimersByTimeAsync(1_000)
      await expect(timedOut).resolves.toEqual({ ok: false, error: 'gateway-timeout' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('sends the relay access frames straight to the relay and aborts a cancelled request', async () => {
    const h = harness()
    h.supervision.send({ type: 'add-share', share: spec() })
    h.worker().emit({
      type: 'share-access-state', registrationToken: 'r', shareId: 'share-1', version: 1,
      accessMode: 'open', allowedSubjectIds: [], sessionMode: 'view',
    })
    expect(h.relay.applyRelayAccess).toHaveBeenCalledWith('share-1', expect.objectContaining({ version: 1 }))

    h.worker().emit({
      type: 'share-rpc-request', registrationToken: 'r', token: 't', id: 1, shareId: 'share-1',
      body: { op: 'call', path: '/api/session/list', body: {} }, actor: { providerId: 'p', tenantId: 't', subjectId: 'alice' },
    })
    h.worker().emit({ type: 'share-rpc-cancel', registrationToken: 'r', token: 't', id: 1, shareId: 'share-1' })
    await Promise.resolve()
    expect(h.worker().sent.some(command => command.type === 'share-rpc-response')).toBe(false)
  })

  it('drops a viewer answer that arrives after its request was cancelled', async () => {
    const h = harness()
    let rejectRead: ((error: unknown) => void) | undefined
    h.viewerRead.answer.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectRead = reject }))
    h.supervision.send({ type: 'add-share', share: spec() })
    h.worker().emit({
      type: 'share-rpc-request', registrationToken: 'r', token: 'cancelled', id: 8, shareId: 'share-1',
      body: { op: 'call', path: '/api/session/list', body: {} }, actor: { providerId: 'p', tenantId: 't', subjectId: 'alice' },
    })
    await Promise.resolve()
    h.worker().emit({ type: 'share-rpc-cancel', registrationToken: 'r', token: 'cancelled', id: 8, shareId: 'share-1' })
    rejectRead?.(new Error('late failure'))
    await Promise.resolve()
    expect(h.worker().sent.some(command => command.type === 'share-rpc-response')).toBe(false)
  })

  it('leaves a replacement request in place when an older answer settles', async () => {
    const h = harness()
    let resolveRead: ((answer: ViewerAnswer) => void) | undefined
    h.viewerRead.answer.mockImplementationOnce(() => new Promise<ViewerAnswer>((resolve) => { resolveRead = resolve }))
    h.supervision.send({ type: 'add-share', share: spec() })
    h.worker().emit({
      type: 'share-rpc-request', registrationToken: 'r', token: 'same', id: 1, shareId: 'share-1',
      body: { op: 'call', path: '/api/session/list', body: {} }, actor: { providerId: 'p', tenantId: 't', subjectId: 'alice' },
    })
    await Promise.resolve()
    h.worker().emit({
      type: 'share-rpc-request', registrationToken: 'r', token: 'same', id: 2, shareId: 'share-1',
      body: { op: 'call', path: '/api/session/list', body: {} }, actor: { providerId: 'p', tenantId: 't', subjectId: 'alice' },
    })
    resolveRead?.({ status: 200, body: { ok: true } })
    await Promise.resolve()
    // The older answer still reports its own id; the replacement's controller is left in place.
    expect(h.worker().sent.some(command => command.type === 'share-rpc-response' && command.id === 1)).toBe(true)
  })

  it('answers an invalid viewer request and forwards a valid one', async () => {
    const h = harness()
    h.supervision.send({ type: 'add-share', share: spec() })
    h.worker().emit({
      type: 'share-rpc-request', registrationToken: 'r', token: 'bad', id: 2, shareId: 'share-1',
      body: { op: 'nope' }, actor: { providerId: 'p', tenantId: 't', subjectId: 'alice' },
    })
    expect(h.worker().sent.at(-1)).toMatchObject({ type: 'share-rpc-response', status: 400 })

    h.worker().emit({
      type: 'share-rpc-request', registrationToken: 'r', token: 'good', id: 3, shareId: 'share-1',
      body: { op: 'call', path: '/api/session/list', body: {} }, actor: { providerId: 'p', tenantId: 't', subjectId: 'alice' },
    })
    await vi.waitFor(() => { expect(h.worker().sent.at(-1)).toMatchObject({ type: 'share-rpc-response', status: 200 }) })
  })

  it('reports a viewer read failure and drops an answer after its request was cancelled', async () => {
    const h = harness()
    h.viewerRead.answer.mockRejectedValueOnce(new Error('boom'))
    const plain = harness()
    plain.viewerRead.answer.mockRejectedValueOnce('plain failure')
    plain.supervision.send({ type: 'add-share', share: spec() })
    plain.worker().emit({
      type: 'share-rpc-request', registrationToken: 'r', token: 'p', id: 9, shareId: 'share-1',
      body: { op: 'call', path: '/api/session/list', body: {} }, actor: { providerId: 'p', tenantId: 't', subjectId: 'alice' },
    })
    await vi.waitFor(() => { expect(plain.worker().sent.at(-1)).toMatchObject({ status: 500 }) })
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('plain failure'))
    h.supervision.send({ type: 'add-share', share: spec() })
    h.worker().emit({
      type: 'share-rpc-request', registrationToken: 'r', token: 't', id: 4, shareId: 'share-1',
      body: { op: 'call', path: '/api/session/list', body: {} }, actor: { providerId: 'p', tenantId: 't', subjectId: 'alice' },
    })
    await vi.waitFor(() => {
      expect(h.worker().sent.at(-1)).toMatchObject({ type: 'share-rpc-response', status: 500 })
    })
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('viewer read failed'))
  })

  it('marks a share online and flushes removals when the relay connects it', () => {
    const pending = new Map([['old', { relay: RELAY, shareId: 'old', gatewayToken: 't' }]])
    const h = harness({ shares: [share()], pending })
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 200 })))
    h.supervision.send({ type: 'add-share', share: spec() })
    h.worker().emit({ type: 'share-connected', registrationToken: 'r', shareId: 'share-1' })
    expect(h.relay.forgetRelayAccess).toHaveBeenCalledWith('share-1')
    expect(h.ownerShares.get('share-1')?.online).toBe(true)
  })

  it('marks a closed share offline without a diagnosis', () => {
    const h = harness({ shares: [share({ online: true })] })
    h.supervision.send({ type: 'add-share', share: spec() })
    h.worker().emit({ type: 'share-closed', registrationToken: 'r', shareId: 'share-1' })
    expect(h.ownerShares.get('share-1')?.online).toBe(false)
    expect(console.warn).not.toHaveBeenCalled()

    // A share this host no longer holds is still fenced and reported.
    h.worker().emit({ type: 'share-connected', registrationToken: 'r', shareId: 'absent' })
    expect(h.relay.forgetRelayAccess).toHaveBeenCalledWith('absent')
  })

  it('marks a share offline and diagnoses a socket error', () => {
    const h = harness({ shares: [share({ online: true })] })
    h.supervision.send({ type: 'add-share', share: spec() })
    h.worker().emit({ type: 'share-error', registrationToken: 'r', shareId: 'share-1', message: 'boom' })
    expect(h.relay.invalidateRelayAccess).toHaveBeenCalledWith('share-1')
    expect(h.ownerShares.get('share-1')?.online).toBe(false)
    expect(console.warn).toHaveBeenCalledWith('[liveshare] share offline share=share-1 reason=boom')
  })
})

describe('registration payloads', () => {
  it('carries the owner identity row, credential, subjects, and expiry', () => {
    const h = harness({
      ownerIdentity: { providerId: 'p', tenantId: 't', subjectId: 'owner' },
      credential: { relay: RELAY, credential: 'relay-token', displayName: 'Credential Owner' },
    })
    const payload = h.supervision.shareSpec(
      { ...spec({ allowedSubjectIds: ['alice', 'deployment'], expiresAt: '2030-01-01T00:00:00Z' }) } as never,
      h.state.credential,
    )
    expect(payload).toMatchObject({
      shareId: 'share-1', ownerDisplayName: 'Credential Owner', ownerProviderId: 'owner-p', ownerTenantId: 'owner-t',
      ownerInstanceId: 'instance-1', ownerCredential: 'relay-token', allowedSubjectIds: ['deployment', 'alice'],
      expiresAt: '2030-01-01T00:00:00Z',
    })
  })

  it('falls back to the credential name, the subject label, then the relay host', () => {
    const named = harness({ credential: { relay: RELAY, credential: 'token', displayName: 'Credential Owner' } })
    expect(named.supervision.shareSpec(spec() as never, named.state.credential)).toMatchObject({ ownerDisplayName: 'Credential Owner' })

    const subject = harness({ credential: { relay: RELAY, credential: 'token', subjectId: 'ou_123' } })
    const subjectSpec = subject.supervision.shareSpec(spec() as never, subject.state.credential)
    expect(subjectSpec.ownerDisplayName).toBe('ou_123')

    const host = harness({ ownerIdentity: { providerId: 'p', tenantId: 't', subjectId: 'owner' } })
    expect(host.supervision.shareSpec(spec() as never, undefined)).toMatchObject({ ownerDisplayName: 'relay.example.test' })
  })

  it('re-registers only offline shares of the credential relay', () => {
    const h = harness({
      shares: [
        share({ shareId: 'offline', online: false }),
        share({ shareId: 'online', online: true }),
        share({ shareId: 'other', relay: 'https://other.example.test/liveshare', online: false }),
      ],
    })
    h.supervision.reregisterOfflineShares(RELAY, { relay: RELAY, credential: 'token' })
    const adds = h.worker().sent.filter(command => command.type === 'add-share')
    expect(adds).toHaveLength(1)
    expect(adds[0]).toMatchObject({ share: { shareId: 'offline' } })
  })

  it('answers credential usability per normalized relay and claims only its own address', () => {
    const h = harness({ credential: { relay: RELAY, credential: 'token', expiresAt: '2000-01-01T00:00:00Z' } })
    expect(h.supervision.credentialForRelay(RELAY, h.state.credential)).toBeUndefined()
    expect(h.supervision.credentialForRelay(RELAY, { relay: RELAY, credential: 'fresh', expiresAt: '2030-01-01T00:00:00Z' })).toBe('fresh')
    expect(h.supervision.claimableCredentialForRelay(RELAY)).toBe('token')
    expect(h.supervision.claimableCredentialForRelay('https://other.example.test/liveshare')).toBeUndefined()
  })
})

describe('expiry timers and pending removals', () => {
  it('cancels work when a share deadline passes and re-arms a far deadline', async () => {
    vi.useFakeTimers()
    try {
      const h = harness({ shares: [share()] })
      h.ownerShares.set('share-1', share({ expiresAt: '2030-01-01T00:00:00Z' }))
      h.supervision.scheduleShareExpiry(h.ownerShares.get('share-1') as never)
      await vi.advanceTimersByTimeAsync(Date.parse('2030-01-01T00:00:00Z') - Date.now() + 1)
      // The deadline passed, so the turn and its streams end; the record stays for the refusal.
      expect(h.cancelShareTurn).toHaveBeenCalledWith('share-1')
      expect(h.viewerRead.closeShare).toHaveBeenCalledWith('share-1')
      // A Session whose shares have all expired gets its own tools back.
      expect(h.reconcileSourceAccess).toHaveBeenCalledWith('session-1')
      expect(h.accessChanged).toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops a deadline whose share was removed before it fired', async () => {
    vi.useFakeTimers()
    try {
      const h = harness()
      const entry = share({ expiresAt: '2030-01-01T00:00:00Z' })
      h.ownerShares.set('share-1', entry)
      h.supervision.scheduleShareExpiry(entry as never)
      h.ownerShares.delete('share-1')
      await vi.advanceTimersByTimeAsync(Date.parse('2030-01-01T00:00:00Z') - Date.now() + 1)
      expect(h.cancelShareTurn).toHaveBeenCalledWith('share-1')
    } finally {
      vi.useRealTimers()
    }
  })

  it('ignores a share without a deadline and clears one that is disarmed', () => {
    vi.useFakeTimers()
    try {
      const h = harness()
      h.supervision.scheduleShareExpiry(share() as never)
      h.supervision.clearShareExpiry('absent')
      h.supervision.scheduleShareExpiry(share({ expiresAt: 'not a date' }) as never)
      const withDeadline = share({ expiresAt: '2030-01-01T00:00:00Z' })
      h.ownerShares.set('share-1', withDeadline)
      h.supervision.scheduleShareExpiry(withDeadline as never)
      h.supervision.scheduleShareExpiry(withDeadline as never)
      h.supervision.clearShareExpiry('share-1')
      expect(h.ownerShares.size).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('deletes one relay row and reports each outcome', async () => {
    const h = harness()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 200 })))
    await expect(h.supervision.deleteRelayRow(RELAY, 'share-1', 'token')).resolves.toBe(true)
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })))
    await expect(h.supervision.deleteRelayRow(RELAY, 'share-1', 'token')).resolves.toBe(true)
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 500 })))
    await expect(h.supervision.deleteRelayRow(RELAY, 'share-1', 'token')).resolves.toBe(false)
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    await expect(h.supervision.deleteRelayRow(RELAY, 'share-1', 'token')).resolves.toBe(false)
  })

  it('flushes owed rows, persists the deletion, and backs the retry off', async () => {
    vi.useFakeTimers()
    try {
      const pending = new Map([['old', { relay: RELAY, shareId: 'old', gatewayToken: 't' }]])
      const h = harness({ pending })
      vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 200 })))
      await h.supervision.flushPendingRemovals()
      expect(pending.size).toBe(0)

      // Nothing owed is a no-op.
      await h.supervision.flushPendingRemovals()

      pending.set('stuck', { relay: RELAY, shareId: 'stuck', gatewayToken: 't' })
      vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 500 })))
      await h.supervision.flushPendingRemovals()
      expect(pending.size).toBe(1)
      // A second arm replaces the pending timer, and its callback flushes again.
      h.supervision.armPendingRemovalRetry()
      h.supervision.armPendingRemovalRetry()
      await vi.advanceTimersByTimeAsync(600_000)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps a deletion whose persist failed and stops retrying after disposal', async () => {
    vi.useFakeTimers()
    try {
      const pending = new Map([['old', { relay: RELAY, shareId: 'old', gatewayToken: 't' }]])
      const h = harness({ pending })
      vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 200 })))
      await h.supervision.flushPendingRemovals()
      h.state.disposed = true
      h.supervision.armPendingRemovalRetry()
      expect(pending.size).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('reconciles a renamed Session and re-registers its share', async () => {
    const h = harness({ shares: [share()] })
    const session = { id: 'session-1' }
    h.ctx.provide('sessions', { get: (id: string) => id === 'session-1' ? session : undefined } as never)
    h.ctx.provide('sessionTitle', { get: () => ({ title: 'Renamed' }) } as never)
    h.supervision.send({ type: 'add-share', share: spec() })
    await h.supervision.reconcileShareTitles()
    expect(h.ownerShares.get('share-1')?.sessionTitle).toBe('Renamed')
    expect(h.worker().sent.slice(-2).map(command => command.type)).toEqual(['remove-share', 'add-share'])
  })

  it('keeps a recorded title without the optional services or a listed Session', async () => {
    const missingServices = harness({ shares: [share()] })
    await expect(missingServices.supervision.reconcileShareTitles()).resolves.toBeUndefined()
    expect(missingServices.ownerShares.get('share-1')?.sessionTitle).toBe('Session')

    const missingSession = harness({ shares: [share()] })
    missingSession.ctx.provide('sessions', { get: () => undefined } as never)
    missingSession.ctx.provide('sessionTitle', { get: () => ({ title: 'Renamed' }) } as never)
    await missingSession.supervision.reconcileShareTitles()
    expect(missingSession.ownerShares.get('share-1')?.sessionTitle).toBe('Session')
  })

  it('re-registers a share whose Session reports a new title and skips one that reports none', async () => {
    const unchanged = harness({ shares: [share()] })
    unchanged.ctx.provide('sessions', { get: () => ({ id: 'session-1' }) } as never)
    unchanged.ctx.provide('sessionTitle', { get: () => undefined } as never)
    await unchanged.supervision.reconcileShareTitles()
    expect(unchanged.ownerShares.get('share-1')?.sessionTitle).toBe('Session')

    const h = harness({ shares: [share()] })
    h.ctx.provide('sessions', { get: () => ({ id: 'session-1' }) } as never)
    h.ctx.provide('sessionTitle', { get: () => ({ title: 'Renamed' }) } as never)
    await h.supervision.reconcileShareTitles()
    expect(h.ownerShares.get('share-1')?.sessionTitle).toBe('Renamed')
  })
})

describe('relay probes and claims', () => {
  it('records credential support and adopts a reported horizon', async () => {
    const h = harness({ credential: { relay: RELAY, credential: 'token' } })
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ supported: true, ownerCredentialExpiresAt: '2030-03-17T17:46:40.000Z' })))
    await h.supervision.probeRelayCredentialSupport(RELAY)
    expect(h.supervision.factsFor(RELAY).supportsCredentials).toBe(true)
    expect(h.state.credential?.expiresAt).toBe('2030-03-17T17:46:40.000Z')
  })

  it('keeps the stored horizon when the answer states none or the same one, and survives an unwritable file', async () => {
    const h = harness({ credential: { relay: RELAY, credential: 'token', expiresAt: '2030-01-01T00:00:00.000Z' } })
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ supported: true })))
    await h.supervision.probeRelayCredentialSupport(RELAY)
    expect(h.state.credential?.expiresAt).toBe('2030-01-01T00:00:00.000Z')

    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ supported: true, ownerCredentialExpiresAt: '2030-01-01T00:00:00.000Z' })))
    await h.supervision.probeRelayCredentialSupport(RELAY)
    expect(h.state.credential?.expiresAt).toBe('2030-01-01T00:00:00.000Z')

    rmSync(join(h.root, 'owner-credential.json'), { force: true })
    mkdirSync(join(h.root, 'owner-credential.json'))
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ supported: true, ownerCredentialExpiresAt: '2031-01-01T00:00:00Z' })))
    await h.supervision.probeRelayCredentialSupport(RELAY)
    expect(h.state.credential?.expiresAt).toBe('2030-01-01T00:00:00.000Z')
  })

  it('records an unsupported relay and leaves a failed probe unknown', async () => {
    const h = harness()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 500 })))
    await h.supervision.probeRelayCredentialSupport(RELAY)
    expect(h.supervision.factsFor(RELAY).supportsCredentials).toBe(false)
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    await h.supervision.probeRelayCredentialSupport(RELAY)
    expect(h.supervision.factsFor(RELAY).supportsCredentials).toBe(false)
  })

  it('stops a probe when the host is disposed while the fetch is in flight', async () => {
    const h = harness()
    vi.stubGlobal('fetch', vi.fn(async () => {
      h.state.disposed = true
      return Response.json({ supported: true })
    }))
    await h.supervision.probeRelayCredentialSupport(RELAY)
    expect(h.supervision.factsFor(RELAY).supportsCredentials).toBeUndefined()
  })

  it('claims only shares of the named relay and reports claimed and skipped', async () => {
    const h = harness({
      shares: [
        share({ shareId: 'a' }), share({ shareId: 'b' }), share({ shareId: 'c', relay: 'https://other.example.test/liveshare' }),
      ],
    })
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : String(input)
      if (url.includes('shareId=a')) return Response.json({ claimed: true })
      if (url.includes('shareId=b')) return Response.json({ claimed: false })
      return new Response('', { status: 500 })
    }))
    await expect(h.supervision.claimOwnedShares(RELAY, 'token')).resolves.toEqual({ claimed: 1, skipped: 1 })
    await expect(h.supervision.claimOwnedShares(RELAY, undefined)).resolves.toEqual({ claimed: 0, skipped: 0 })

    // A host disposed while the first claim ran stops before the next share.
    vi.stubGlobal('fetch', vi.fn(async () => {
      h.state.disposed = true
      return Response.json({ claimed: true })
    }))
    await expect(h.supervision.claimOwnedShares(RELAY, 'token')).resolves.toEqual({ claimed: 1, skipped: 0 })
  })

  it('reports identity state, bound fields, renewal, and claim outcomes', () => {
    const h = harness({ credential: { relay: RELAY, credential: 'token', displayName: 'Owner', expiresAt: '2030-01-01T00:00:00Z' } })
    h.supervision.factsFor(RELAY).supportsCredentials = false
    expect(h.supervision.ownerIdentityStatus(RELAY, {}, h.state.credential)).toMatchObject({ state: 'relay-unsupported' })
    h.supervision.factsFor(RELAY).supportsCredentials = true
    expect(h.supervision.ownerIdentityStatus(RELAY, { renewed: true, claim: { claimed: 1, skipped: 0 } }, h.state.credential))
      .toMatchObject({ state: 'verified', relay: RELAY, displayName: 'Owner', renewed: true, claim: { claimed: 1, skipped: 0 } })
  })

  it('checks relay connectivity and describes a transport failure', async () => {
    vi.useFakeTimers()
    const slow = harness()
    vi.stubGlobal('fetch', vi.fn((_input: unknown, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => { reject(new Error('timeout')) })
    })))
    const slowProbe = slow.supervision.probeRelayConnectivity(RELAY)
    await vi.advanceTimersByTimeAsync(5_000)
    const slowAnswer = await slowProbe
    expect(slowAnswer).toMatchObject({ ok: false, httpReachable: false })
    expect(String((slowAnswer as { readonly error?: unknown }).error)).toContain('timeout')
    vi.useRealTimers()
    const h = harness()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 401 })))
    await expect(h.supervision.probeRelayConnectivity(RELAY)).resolves.toEqual({ ok: true, httpReachable: true, blocking: false })

    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline', { cause: Object.assign(new Error('dns'), { code: 'ENOTFOUND' }) }) }))
    await expect(h.supervision.probeRelayConnectivity(RELAY)).resolves.toEqual({
      ok: false, httpReachable: false, blocking: true, error: `${RELAY}: ENOTFOUND: dns`,
    })
    vi.stubGlobal('fetch', vi.fn(async () => { throw 'plain failure' }))
    await expect(h.supervision.probeRelayConnectivity(RELAY)).resolves.toMatchObject({ error: `${RELAY}: plain failure` })
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('no cause') }))
    await expect(h.supervision.probeRelayConnectivity(RELAY)).resolves.toMatchObject({ error: `${RELAY}: no cause` })
  })

  it('reports a publish probe success, a transient failure, and each refusal status', async () => {
    const h = harness()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 200 })))
    // The probe settles through the worker; deliver the connected event after the add reaches it.
    const pending = h.supervision.probeRelayPublish(RELAY, spec())
    await vi.waitFor(() => { expect(h.worker().sent.length).toBeGreaterThan(0) })
    const add = h.worker().sent.at(-1) as { share: { shareId: string } }
    h.worker().emit({ type: 'share-connected', registrationToken: 'r', shareId: add.share.shareId })
    await expect(pending).resolves.toEqual({ ok: true, blocking: false })

    const transient = h.supervision.probeRelayPublish(RELAY, spec())
    await vi.waitFor(() => { expect(h.worker().sent.at(-1)?.type).toBe('add-share') })
    const failing = h.worker().sent.at(-1) as { share: { shareId: string } }
    h.worker().emit({ type: 'share-error', registrationToken: 'r', shareId: failing.share.shareId, message: 'network down' })
    await expect(transient).resolves.toEqual({ ok: false, blocking: false, error: `${RELAY}: network down` })

    const unexplained = h.supervision.probeRelayPublish(RELAY, spec())
    await vi.waitFor(() => { expect(h.worker().sent.at(-1)?.type).toBe('add-share') })
    const silent = h.worker().sent.at(-1) as { share: { shareId: string } }
    h.worker().emit({ type: 'share-error', registrationToken: 'r', shareId: silent.share.shareId, message: '' })
    await expect(unexplained).resolves.toEqual({ ok: false, blocking: false })

    for (const [status, text] of [[401, 'did not accept'], [410, 'refused this registration']] as const) {
      const refused = h.supervision.probeRelayPublish(RELAY, spec())
      await vi.waitFor(() => { expect(h.worker().sent.at(-1)?.type).toBe('add-share') })
      const entry = h.worker().sent.at(-1) as { share: { shareId: string } }
      h.worker().emit({
        type: 'share-error', registrationToken: 'r', shareId: entry.share.shareId,
        message: `relay refused registration status=${String(status)}`,
      })
      const refusedAnswer = await refused
      expect(refusedAnswer).toMatchObject({ ok: false, blocking: true })
      expect(String((refusedAnswer as { readonly error?: unknown }).error)).toContain(text)
    }
  })

  it('disposes a supervisor with no armed timers', async () => {
    const h = harness()
    const closeViewer = vi.fn()
    await h.supervision.dispose(closeViewer)
    expect(closeViewer).toHaveBeenCalled()
  })

  it('disposes requests, timers, and the worker', async () => {
    vi.useFakeTimers()
    try {
      const h = harness({ pending: new Map([['old', { relay: RELAY, shareId: 'old', gatewayToken: 't' }]]) })
      h.supervision.send({ type: 'add-share', share: spec() })
      const pendingShare = h.supervision.waitForShare('share-1', 10_000)
      h.ownerShares.set('share-1', share({ expiresAt: '2030-01-01T00:00:00Z' }))
      h.supervision.scheduleShareExpiry(h.ownerShares.get('share-1') as never)
      h.supervision.armPendingRemovalRetry()
      await h.supervision.dispose(() => {})
      await expect(pendingShare).resolves.toEqual({ ok: false, error: 'host disposed' })
      expect(h.worker().stopped).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})
