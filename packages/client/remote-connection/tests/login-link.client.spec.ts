/** Login-link credentials stay in memory and clipboard feedback follows the actual write. */
import { expect, it, vi } from 'vitest'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { LoginLinkController } from '../src/client/login-link-controller.ts'
import type { RemoteConnectionApi } from '../src/client/remote-connection-controller.ts'

const url = 'https://host.example/app/?token=private-login-token'

function setup() {
  const remote = { loginUrl: vi.fn<RemoteConnectionApi['loginUrl']>().mockResolvedValue({ ok: true, value: url }) }
  const write = vi.fn<(text: string) => Promise<boolean>>().mockResolvedValue(true)
  const controller = new LoginLinkController(remote, write)
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

it('prevents overlapping clipboard writes and ignores completion after disposal', async () => {
  const { write, controller, state } = setup()
  await controller.load()
  let finish!: (copied: boolean) => void
  write.mockReturnValueOnce(new Promise((resolve) => { finish = resolve }))
  controller.inject().copyLink()
  await controller.copy()
  const reloading = controller.load()
  expect(write).toHaveBeenCalledOnce()
  expect(state()).toMatchObject({ phase: 'copying', copied: false })
  let disposed = false
  const disposal = controller.dispose().then(() => { disposed = true })
  await Promise.resolve()
  expect(disposed).toBe(false)
  finish(true)
  await Promise.all([reloading, disposal])
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
  await controller.refresh()
  expect(remote.loginUrl).toHaveBeenCalledOnce()
})

it('resets copy success for a changed URL and preserves it for the same URL', async () => {
  const { remote, controller, state } = setup()
  await controller.load()
  await controller.copy()
  remote.loginUrl.mockResolvedValue({ ok: true, value: `${url}-new` })
  await controller.refresh()
  expect(state()).toMatchObject({ url: `${url}-new`, copied: false, notice: null })
  await controller.copy()
  await controller.refresh()
  expect(state()).toMatchObject({ url: `${url}-new`, copied: true, notice: null })
  await controller.dispose()
})

it('reads the current connection after a reset overlaps an earlier read', async () => {
  const { remote, controller, state } = setup()
  let finish!: (result: Awaited<ReturnType<RemoteConnectionApi['loginUrl']>>) => void
  remote.loginUrl.mockReturnValueOnce(new Promise((resolve) => { finish = resolve }))
  const loading = controller.load()
  const refresh = controller.refresh()
  remote.loginUrl.mockResolvedValueOnce({ ok: true, value: `${url}-new` })
  finish({ ok: true, value: url })
  await Promise.all([loading, refresh])
  expect(remote.loginUrl).toHaveBeenCalledTimes(2)
  expect(state()).toMatchObject({ url: `${url}-new`, copied: false, notice: null })
  await controller.dispose()
})
