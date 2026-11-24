/** Invitation state transitions and teardown under delayed Remote responses. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { RemoteConnectionStatus, RemoteLoginId, RemoteLoginTicket, RemoteLoginState } from '../src/types.ts'
import { RemoteConnectionController, type RemoteConnectionApi } from '../src/client/remote-connection-controller.ts'

const deployment: RemoteConnectionStatus = { url: 'https://host.example/app/', availability: 'available', loginUrlAllowed: true, ticket: 'none', pollIntervalMs: 1000 }
const ticket: RemoteLoginTicket = { id: 'invitation-a' as RemoteLoginId, url: 'https://host.example/app/?login=qr#token=private-a', lifetimeMs: 10_000 }
const failure = { ok: false as const, error: new RemoteError('gateway/internal', 'unavailable', {}) }
const controllers: RemoteConnectionController[] = []

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(2000) })
afterEach(async () => {
  await Promise.all(controllers.splice(0).map(controller => controller.dispose()))
  vi.useRealTimers()
})

function setup() {
  const remote = {
    status: vi.fn<RemoteConnectionApi['status']>().mockResolvedValue({ ok: true, value: deployment }),
    create: vi.fn<RemoteConnectionApi['create']>().mockResolvedValue({ ok: true, value: ticket }),
    cancel: vi.fn<RemoteConnectionApi['cancel']>().mockResolvedValue({ ok: true, value: 'cancelled' }),
    loginUrl: vi.fn<RemoteConnectionApi['loginUrl']>().mockResolvedValue({ ok: true, value: 'https://host.example/app/?token=private' }),
  }
  const controller = new RemoteConnectionController(remote)
  controllers.push(controller)
  return { remote, controller, state: () => controller.store.getSnapshot() }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => { resolve = settle })
  return { promise, resolve }
}

describe('Remote connection invitation state', () => {
  it('loads the clean address and only creates a code when the deployment is available', async () => {
    const { remote, controller, state } = setup()
    await controller.create()
    expect(remote.create).not.toHaveBeenCalled()
    remote.status.mockResolvedValueOnce({ ok: true, value: { ...deployment, availability: 'untrusted-host' } })
    await controller.load()
    await controller.create()
    expect(state()).toMatchObject({ phase: 'ready', deployment: { availability: 'untrusted-host' } })
    expect(remote.create).not.toHaveBeenCalled()
    await controller.load()
    await controller.create()
    expect(remote.status).toHaveBeenCalledWith(null)
    expect(state()).toMatchObject({ phase: 'pending', ticket })
  })

  it('only issues one code per pending gesture, then forgets the secret after redemption', async () => {
    const { remote, controller, state } = setup()
    await controller.load()
    const pending = deferred<RemoteResult<RemoteLoginTicket>>()
    remote.create.mockReturnValueOnce(pending.promise)
    const creation = controller.create()
    expect(state()).toMatchObject({ phase: 'creating', ticket: null, retainDetails: false })
    await controller.create()
    await controller.cancel()
    await controller.load()
    expect(remote.create).toHaveBeenCalledTimes(1)
    expect(remote.cancel).not.toHaveBeenCalled()
    pending.resolve({ ok: true, value: ticket })
    await creation
    remote.status.mockResolvedValue({ ok: true, value: { ...deployment, ticket: 'used' } })
    await vi.advanceTimersByTimeAsync(1000)
    expect(remote.status).toHaveBeenLastCalledWith(ticket.id)
    expect(state()).toMatchObject({ phase: 'used', ticket: null })
    await vi.advanceTimersByTimeAsync(12_000)
    expect(state().phase).toBe('used')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('hides the previous code as soon as replacement starts, and never restores it after an unknown outcome', async () => {
    const { remote, controller, state } = setup()
    await controller.load()
    await controller.create()
    const pending = deferred<RemoteResult<RemoteLoginTicket>>()
    remote.create.mockReturnValueOnce(pending.promise)
    const replacement = controller.create()
    expect(state()).toMatchObject({ phase: 'creating', ticket: null, retainDetails: true, remainingSeconds: 10 })
    pending.resolve(failure)
    await replacement
    expect(state()).toMatchObject({ phase: 'error', ticket: null, error: 'createFailed', retainDetails: false })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps the countdown during replacement and resets it when the new code arrives', async () => {
    const { remote, controller, state } = setup()
    await controller.load()
    await controller.create()
    remote.status.mockResolvedValue({ ok: true, value: { ...deployment, ticket: 'pending' } })
    await vi.advanceTimersByTimeAsync(1000)
    const pending = deferred<RemoteResult<RemoteLoginTicket>>()
    remote.create.mockReturnValueOnce(pending.promise)
    const replacement = controller.create()
    expect(state()).toMatchObject({ phase: 'creating', ticket: null, retainDetails: true, remainingSeconds: 9 })
    const next = { ...ticket, id: 'invitation-b' as RemoteLoginId, url: 'https://host.example/app/?login=qr#token=private-b', lifetimeMs: 20_000 }
    pending.resolve({ ok: true, value: next })
    await replacement
    expect(state()).toMatchObject({ phase: 'pending', ticket: next, retainDetails: false, remainingSeconds: 20 })
  })

  it('rechecks the login address after reconnecting during an outstanding QR creation', async () => {
    const { remote, controller, state } = setup()
    await controller.load()
    const creating = deferred<RemoteResult<RemoteLoginTicket>>()
    remote.create.mockReturnValueOnce(creating.promise)
    const creation = controller.create()
    const reconnect = controller.reconnect()
    expect(state().deployment).toBeNull()
    expect(remote.status).toHaveBeenCalledOnce()
    const loopback = { ...deployment, url: 'http://127.0.0.1/', availability: 'unreachable-host' as const }
    remote.status.mockResolvedValueOnce({ ok: true, value: loopback })
    creating.resolve({ ok: true, value: ticket })
    await Promise.all([creation, reconnect])
    expect(state()).toMatchObject({ deployment: loopback, ticket: null })
  })

  it('expires the code even while a status request is stalled, and ignores its late answer', async () => {
    const { remote, controller, state } = setup()
    await controller.load()
    await controller.create()
    const pending = deferred<RemoteResult<RemoteConnectionStatus>>()
    remote.status.mockReturnValueOnce(pending.promise)
    await vi.advanceTimersByTimeAsync(1000)
    expect(state().phase).toBe('pending')
    await vi.advanceTimersByTimeAsync(9000)
    expect(state()).toMatchObject({ phase: 'expired', ticket: null })
    pending.resolve({ ok: true, value: { ...deployment, ticket: 'pending' } })
    await Promise.resolve()
    expect(state().phase).toBe('expired')
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['unreachable-host', 'untrusted-host'] as const)('forgets a pending credential and stops polling when the address becomes %s', async (availability) => {
    const { remote, controller, state } = setup()
    await controller.load()
    await controller.create()
    expect(state()).toMatchObject({ phase: 'pending', ticket })
    remote.status.mockResolvedValueOnce({ ok: true, value: { ...deployment, availability, ticket: 'pending' } })
    await vi.advanceTimersByTimeAsync(1000)
    expect(state()).toMatchObject({ deployment: { availability }, ticket: null, retainDetails: false })
    expect(vi.getTimerCount()).toBe(0)
    const reads = remote.status.mock.calls.length
    await vi.advanceTimersByTimeAsync(10_000)
    expect(remote.status).toHaveBeenCalledTimes(reads)
    remote.status.mockResolvedValueOnce({ ok: true, value: { ...deployment, ticket: 'pending' } })
    await controller.load()
    expect(remote.status).toHaveBeenLastCalledWith(null)
    expect(state()).toMatchObject({ phase: 'ready', ticket: null })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('polls a live code and drops it if another owner replaces it', async () => {
    const { remote, controller, state } = setup()
    await controller.load()
    await controller.create()
    remote.status.mockResolvedValueOnce({ ok: true, value: { ...deployment, ticket: 'pending' } })
    await vi.advanceTimersByTimeAsync(1000)
    expect(state()).toMatchObject({ phase: 'pending', remainingSeconds: 9 })
    remote.status.mockResolvedValueOnce({ ok: true, value: { ...deployment, ticket: 'none' } })
    await vi.advanceTimersByTimeAsync(1000)
    expect(state()).toMatchObject({ phase: 'replaced', ticket: null })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cancels its exact code and ignores an older in-flight status reply', async () => {
    const { remote, controller, state } = setup()
    await controller.cancel()
    expect(remote.cancel).not.toHaveBeenCalled()
    await controller.load()
    await controller.create()
    const pending = deferred<RemoteResult<RemoteConnectionStatus>>()
    remote.status.mockReturnValueOnce(pending.promise)
    await vi.advanceTimersByTimeAsync(1000)
    await controller.cancel()
    expect(remote.cancel).toHaveBeenCalledWith(ticket.id)
    expect(state()).toMatchObject({ phase: 'cancelled', ticket: null })
    pending.resolve({ ok: true, value: { ...deployment, ticket: 'pending' } })
    await Promise.resolve()
    expect(state().phase).toBe('cancelled')
  })

  it.each(['reply', 'rejection'] as const)('keeps cancellation uncertainty visible after a %s failure', async (kind) => {
    const { remote, controller, state } = setup()
    await controller.load()
    await controller.create()
    if (kind === 'reply') remote.cancel.mockResolvedValueOnce(failure)
    else remote.cancel.mockRejectedValueOnce(new Error('network'))
    await controller.cancel()
    expect(state()).toMatchObject({ phase: 'error', error: 'cancelFailed', ticket })
    await controller.cancel()
    expect(state()).toMatchObject({ phase: 'cancelled', ticket: null })
  })

  it.each(['reply', 'rejection'] as const)('reports deployment read failures from a %s and permits retry', async (kind) => {
    const { remote, controller, state } = setup()
    if (kind === 'reply') remote.status.mockResolvedValueOnce(failure)
    else remote.status.mockRejectedValueOnce(new Error('network'))
    await controller.load()
    expect(state()).toMatchObject({ phase: 'error', error: 'loadFailed' })
    await controller.load()
    expect(state()).toMatchObject({ phase: 'ready', error: null })
  })

  it.each(['reply', 'rejection'] as const)('hides the QR on a status %s failure, and can recover its confirmed state', async (kind) => {
    const { remote, controller, state } = setup()
    await controller.load()
    await controller.create()
    if (kind === 'reply') remote.status.mockResolvedValueOnce(failure)
    else remote.status.mockRejectedValueOnce(new Error('network'))
    await vi.advanceTimersByTimeAsync(1000)
    expect(state()).toMatchObject({ phase: 'error', error: 'statusFailed' })
    remote.status.mockResolvedValueOnce({ ok: true, value: { ...deployment, ticket: 'pending' } })
    await controller.load()
    expect(state()).toMatchObject({ phase: 'pending', error: null })
  })

  it('reports thrown creation failures and uses a monotonic clock for the code lifetime', async () => {
    const { remote, controller, state } = setup()
    await controller.load()
    remote.create.mockRejectedValueOnce(new Error('network'))
    await controller.create()
    expect(state()).toMatchObject({ phase: 'error', error: 'createFailed' })
    remote.create.mockResolvedValueOnce({ ok: true, value: ticket })
    await controller.create()
    expect(state()).toMatchObject({ phase: 'pending', remainingSeconds: 10 })
    remote.status.mockResolvedValue({ ok: true, value: { ...deployment, ticket: 'pending' } })
    const clock = vi.spyOn(performance, 'now').mockReturnValue(performance.now() + 11_000)
    try { await controller.load() } finally { clock.mockRestore() }
    expect(state()).toMatchObject({ phase: 'expired', ticket: null, remainingSeconds: 0 })
  })

  it('awaits disposal without publishing late credentials or starting further calls', async () => {
    const { remote, controller, state } = setup()
    await controller.load()
    const pending = deferred<RemoteResult<RemoteLoginTicket>>()
    remote.create.mockReturnValueOnce(pending.promise)
    const creation = controller.create()
    const disposal = controller.dispose()
    pending.resolve({ ok: true, value: ticket })
    await Promise.all([creation, disposal])
    expect(state().ticket).toBeNull()
    await controller.create()
    await controller.cancel()
    await controller.load()
    expect(remote.create).toHaveBeenCalledTimes(1)
    expect(remote.status).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('runs the section actions against the same invitation owner', async () => {
    const { controller, state } = setup()
    const face = controller.inject()
    face.reload()
    await vi.advanceTimersByTimeAsync(0)
    expect(state().phase).toBe('ready')
    face.create()
    await vi.advanceTimersByTimeAsync(0)
    expect(state().phase).toBe('pending')
    face.cancel()
    await vi.advanceTimersByTimeAsync(0)
    expect(state().phase).toBe('cancelled')
  })

  it('does not publish a cancellation response after disposal', async () => {
    const { remote, controller, state } = setup()
    await controller.load()
    await controller.create()
    const pending = deferred<RemoteResult<RemoteLoginState>>()
    remote.cancel.mockReturnValueOnce(pending.promise)
    const cancellation = controller.cancel()
    const disposal = controller.dispose()
    pending.resolve({ ok: true, value: 'cancelled' })
    await Promise.all([cancellation, disposal])
    expect(state()).toMatchObject({ phase: 'cancelling', ticket: null })
  })

  it('does not publish a rejected request after disposal', async () => {
    const { remote, controller, state } = setup()
    await controller.load()
    let reject!: (error: Error) => void
    remote.create.mockReturnValueOnce(new Promise((_resolve, fail) => { reject = fail }))
    const creation = controller.create()
    const disposal = controller.dispose()
    reject(new Error('closed transport'))
    await Promise.all([creation, disposal])
    expect(state()).toMatchObject({ phase: 'creating', ticket: null, error: null })
  })

  it.each(['used', 'expired', 'replaced', 'none'] as const)('shows %s when cancellation finds that outcome already committed', async (outcome) => {
    const { remote, controller, state } = setup()
    await controller.load()
    await controller.create()
    remote.cancel.mockResolvedValueOnce({ ok: true, value: outcome })
    await controller.cancel()
    expect(state()).toMatchObject({ phase: outcome === 'none' ? 'replaced' : outcome, ticket: null })
  })

})
