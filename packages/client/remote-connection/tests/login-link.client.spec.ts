/** Login-link credentials stay in memory and clipboard feedback follows the actual write. */
import { expect, it, onTestFinished, vi } from 'vitest'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { LoginLinkController } from '../src/client/login-link-controller.ts'
import type { RemoteConnectionApi } from '../src/client/remote-connection-controller.ts'

const url = 'https://host.example/app/?token=private-login-token'

function setup(accessAddress: () => string | null = () => null, canCopyCredential: () => boolean = () => true) {
  const remote = { loginUrl: vi.fn<RemoteConnectionApi['loginUrl']>().mockResolvedValue({ ok: true, value: url }) }
  const write = vi.fn<(text: string) => Promise<boolean>>().mockResolvedValue(true)
  const controller = new LoginLinkController(remote, write, accessAddress, canCopyCredential)
  return { remote, write, controller, state: () => controller.store.getSnapshot() }
}

it('prefetches the tokenized link and writes it during the copy gesture without a second request', async () => {
  const { remote, write, controller, state } = setup()
  await controller.copy()
  expect(write).not.toHaveBeenCalled()
  await controller.load()
  expect(state()).toMatchObject({ phase: 'ready', url, copied: false, notice: null })
  const copying = controller.copy()
  expect(write).toHaveBeenCalledWith(url)
  await copying
  expect(state()).toMatchObject({ phase: 'ready', copied: true, notice: 'linkCopied', sequence: 1 })
  await controller.copy()
  expect(remote.loginUrl).toHaveBeenCalledOnce()
  expect(state().sequence).toBe(2)
  controller.inject().dismissCopyNotice(1)
  expect(state().notice).toBe('linkCopied')
  controller.inject().dismissCopyNotice(2)
  expect(state().notice).toBeNull()
  expect(state().copied).toBe(true)
  await controller.dispose()
  expect(state()).toMatchObject({ url: null, notice: null, copied: false })
})

it('reports clipboard refusal and rejection without claiming that a link was copied', async () => {
  const { write, controller, state } = setup()
  await controller.load()
  write.mockResolvedValueOnce(false).mockRejectedValueOnce(new Error('clipboard denied'))
  await controller.copy()
  expect(state()).toMatchObject({ copied: false, notice: 'copyFailed', url })
  await controller.copy()
  expect(state()).toMatchObject({ copied: false, notice: 'copyFailed', sequence: 2 })
  await controller.copy()
  expect(state()).toMatchObject({ copied: true, notice: 'linkCopied', sequence: 3 })
  await controller.dispose()
})

it('resets the copy warning without losing the credential or clipboard outcomes', async () => {
  const { remote, write, controller, state } = setup()
  const writing = Promise.withResolvers<boolean>()
  onTestFinished(async () => { writing.resolve(true); await controller.dispose() })
  await controller.load()
  await controller.copy()
  controller.resetCopyWarning()
  expect(state()).toMatchObject({ phase: 'ready', url, copied: false, notice: 'linkCopied', sequence: 1 })

  write.mockReturnValueOnce(writing.promise)
  const copying = controller.copy()
  controller.resetCopyWarning()
  writing.resolve(true)
  await copying
  expect(state()).toMatchObject({ phase: 'ready', url, copied: false, notice: 'linkCopied', sequence: 2 })
  await controller.copy()
  expect(state()).toMatchObject({ copied: true, notice: 'linkCopied', sequence: 3 })
  expect(remote.loginUrl).toHaveBeenCalledOnce()
})

it('keeps failed link reads retryable and shares an outstanding read', async () => {
  const { remote, controller, write, state } = setup()
  remote.loginUrl.mockRejectedValueOnce(new Error('connection unavailable'))
  const first = controller.load()
  expect(controller.load()).toBe(first)
  await first
  expect(state()).toMatchObject({ phase: 'error', url: null, copied: false })
  await controller.copy()
  expect(write).not.toHaveBeenCalled()
  remote.loginUrl.mockResolvedValueOnce({ ok: false, error: new RemoteError('gateway/internal', 'unavailable', {}) })
  await controller.load()
  expect(state().phase).toBe('error')
  controller.inject().reloadLink()
  await vi.waitFor(() => { expect(state().phase).toBe('ready') })
  await controller.dispose()
})

it('copies the clean address directly before any credential has loaded', async () => {
  const address = 'http://127.0.0.1:5432/'
  const { remote, write, controller, state } = setup(() => address)
  const copying = controller.copy()
  expect(write).toHaveBeenCalledExactlyOnceWith(address)
  expect(remote.loginUrl).not.toHaveBeenCalled()
  await copying
  expect(state()).toMatchObject({ url: null, copied: false, notice: 'linkCopied' })
  await controller.dispose()
})

it.each(['rejection', 'missing Token provider'] as const)('copies the clean loopback address after credential-read %s', async (outcome) => {
  const address = 'http://127.0.0.1:5432/'
  const { remote, write, controller, state } = setup(() => address)
  if (outcome === 'rejection') remote.loginUrl.mockRejectedValueOnce(new Error('connection unavailable'))
  else remote.loginUrl.mockResolvedValueOnce({ ok: false, error: new RemoteError('remote-connection/token-unavailable', 'Token login is disabled', {}) })
  await controller.load()
  expect(state()).toMatchObject({ phase: 'error', url: null, copied: false })
  const copying = controller.copy()
  expect(write).toHaveBeenCalledExactlyOnceWith(address)
  await copying
  expect(state()).toMatchObject({ copied: false, notice: 'linkCopied' })
  expect(remote.loginUrl).toHaveBeenCalledOnce()
  await controller.dispose()
})

it('uses the current clean address instead of a cached credential once deployment disallows it', async () => {
  let address = 'https://host.example/app/'
  let available = true
  const { remote, write, controller, state } = setup(() => address, () => available)
  await controller.load()
  available = false
  address = 'http://127.0.0.1:5432/'
  await controller.copy()
  expect(write).toHaveBeenCalledExactlyOnceWith(address)
  expect(state()).toMatchObject({ url, copied: false, notice: 'linkCopied' })
  expect(remote.loginUrl).toHaveBeenCalledOnce()
  await controller.dispose()
  await controller.copy()
  expect(write).toHaveBeenCalledOnce()
})

it.each(['response', 'rejection', 'refusal'] as const)('keeps a plain-address copy busy when a credential-read %s arrives', async (outcome) => {
  const address = 'https://host.example/app/'
  const { remote, write, controller, state } = setup(() => address)
  const reading = Promise.withResolvers<Awaited<ReturnType<RemoteConnectionApi['loginUrl']>>>()
  const writing = Promise.withResolvers<boolean>()
  onTestFinished(async () => {
    reading.resolve({ ok: true, value: url })
    writing.resolve(true)
    await controller.dispose()
  })
  remote.loginUrl.mockReturnValueOnce(reading.promise)
  write.mockReturnValueOnce(writing.promise)
  const loading = controller.load()
  const copying = controller.copy()
  expect(write).toHaveBeenCalledExactlyOnceWith(address)
  expect(controller.copy()).toBe(copying)
  if (outcome === 'response') reading.resolve({ ok: true, value: url })
  else if (outcome === 'rejection') reading.reject(new Error('connection unavailable'))
  else reading.resolve({ ok: false, error: new RemoteError('gateway/internal', 'unavailable', {}) })
  await loading
  expect(state()).toMatchObject({ phase: 'copying', copied: false, notice: null })
  expect(controller.copy()).toBe(copying)
  expect(write).toHaveBeenCalledOnce()
  writing.resolve(true)
  await copying
  expect(state()).toMatchObject({ phase: 'ready', copied: false, notice: 'linkCopied' })
})

it('does not attribute a plain-address copy to a credential that loads afterward', async () => {
  const address = 'https://host.example/app/'
  const { remote, write, controller, state } = setup(() => address)
  const reading = Promise.withResolvers<Awaited<ReturnType<RemoteConnectionApi['loginUrl']>>>()
  onTestFinished(async () => {
    reading.resolve({ ok: true, value: url })
    await controller.dispose()
  })
  remote.loginUrl.mockReturnValueOnce(reading.promise)
  const loading = controller.load()
  await controller.copy()
  expect(write).toHaveBeenCalledExactlyOnceWith(address)
  expect(state()).toMatchObject({ url: null, copied: false, notice: 'linkCopied' })
  reading.resolve({ ok: true, value: url })
  await loading
  expect(state()).toMatchObject({ phase: 'ready', url, copied: false, notice: 'linkCopied' })
})

it('withdraws the old link before a pending clipboard write finishes on another deployment', async () => {
  const { remote, write, controller, state } = setup()
  await controller.load()
  const writing = Promise.withResolvers<boolean>()
  write.mockReturnValueOnce(writing.promise)
  const copying = controller.copy()
  controller.invalidate()
  expect(state()).toMatchObject({ url: null, copied: false, phase: 'copying' })
  const next = 'http://127.0.0.1/?token=local'
  remote.loginUrl.mockResolvedValueOnce({ ok: true, value: next })
  const loading = controller.load()
  writing.resolve(true)
  await Promise.all([copying, loading])
  expect(state()).toMatchObject({ url: next, copied: false })
  await controller.dispose()
})

it('shares a copy reentered while its busy state is published', async () => {
  const { write, controller, state } = setup()
  await controller.load()
  const writing = Promise.withResolvers<boolean>()
  write.mockReturnValueOnce(writing.promise)
  let duplicate: Promise<void> | undefined
  const unsubscribe = controller.store.subscribe(() => {
    if (state().phase === 'copying') duplicate = controller.copy()
  })
  onTestFinished(async () => {
    unsubscribe()
    writing.resolve(true)
    await controller.dispose()
  })
  const copying = controller.copy()
  expect(duplicate).toBe(copying)
  expect(write).toHaveBeenCalledExactlyOnceWith(url)
  writing.resolve(true)
  await copying
  expect(state()).toMatchObject({ copied: true, notice: 'linkCopied' })
})

it('prevents overlapping clipboard writes and ignores completion after disposal', async () => {
  const { write, controller, state } = setup()
  await controller.load()
  let finish!: (copied: boolean) => void
  write.mockReturnValueOnce(new Promise((resolve) => { finish = resolve }))
  const copying = controller.copy()
  expect(controller.copy()).toBe(copying)
  controller.inject().copyLink()
  const reloading = controller.load()
  expect(write).toHaveBeenCalledOnce()
  expect(state()).toMatchObject({ phase: 'copying', copied: false })
  let disposed = false
  const disposal = controller.dispose().then(() => { disposed = true })
  await Promise.resolve()
  expect(disposed).toBe(false)
  finish(true)
  await Promise.all([copying, reloading, disposal])
  expect(disposed).toBe(true)
  expect(state()).toMatchObject({ url: null, copied: false, notice: null })
  await controller.load()
  await controller.copy()
  expect(write).toHaveBeenCalledOnce()
})

it('refreshes the cached token after an outstanding clipboard write completes', async () => {
  const { remote, write, controller, state } = setup()
  await controller.load()
  let finish!: (copied: boolean) => void
  write.mockReturnValueOnce(new Promise((resolve) => { finish = resolve }))
  const copying = controller.copy()
  const reloading = controller.load()
  expect(remote.loginUrl).toHaveBeenCalledOnce()
  remote.loginUrl.mockResolvedValueOnce({ ok: true, value: `${url}-new` })
  finish(true)
  await Promise.all([copying, reloading])
  expect(state()).toMatchObject({ phase: 'ready', url: `${url}-new`, copied: false, notice: null })
  await controller.copy()
  expect(write).toHaveBeenLastCalledWith(`${url}-new`)
  await controller.dispose()
})

it.each(['response', 'failure'] as const)('discards a login-link %s arriving after disposal and refuses later refreshes', async (outcome) => {
  const { remote, controller, state } = setup()
  let finish!: (result: Awaited<ReturnType<RemoteConnectionApi['loginUrl']>>) => void
  let reject!: (error: Error) => void
  remote.loginUrl.mockReturnValueOnce(new Promise((resolve, rejectRequest) => { finish = resolve; reject = rejectRequest }))
  const loading = controller.load()
  let disposed = false
  const disposal = controller.dispose().then(() => { disposed = true })
  await Promise.resolve()
  expect(disposed).toBe(false)
  if (outcome === 'response') finish({ ok: true, value: url })
  else reject(new Error('transport closed'))
  await Promise.all([loading, disposal])
  expect(disposed).toBe(true)
  expect(state()).toMatchObject({ url: null, copied: false, notice: null })
  await controller.load()
  expect(remote.loginUrl).toHaveBeenCalledOnce()
})

it('resets copy success for a changed URL and preserves it for the same URL', async () => {
  const { remote, controller, state } = setup()
  await controller.load()
  await controller.copy()
  remote.loginUrl.mockResolvedValue({ ok: true, value: `${url}-new` })
  await controller.load()
  expect(state()).toMatchObject({ url: `${url}-new`, copied: false, notice: null })
  await controller.copy()
  await controller.load()
  expect(state()).toMatchObject({ url: `${url}-new`, copied: true, notice: null })
  await controller.dispose()
})

it.each(['success', 'failure'] as const)('ignores a late credential %s after the deployment changes', async (outcome) => {
  const { remote, controller, state } = setup()
  const previous = Promise.withResolvers<Awaited<ReturnType<RemoteConnectionApi['loginUrl']>>>()
  remote.loginUrl.mockReturnValueOnce(previous.promise)
  const oldRead = controller.load()
  controller.invalidate()
  const local = 'http://127.0.0.1/?token=local'
  remote.loginUrl.mockResolvedValueOnce({ ok: true, value: local })
  await controller.load()
  if (outcome === 'success') previous.resolve({ ok: true, value: url })
  else previous.reject(new Error('previous connection closed'))
  await oldRead
  expect(state()).toMatchObject({ url: local, phase: 'ready', copied: false })
  await controller.dispose()
})
