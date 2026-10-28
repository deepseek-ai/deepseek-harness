import { Context } from '@deepseek-ai/cordis'
import { RemoteError, TestRemote } from '@deepseek-ai/dsh-client-test-runtime'
import type { BundleDetail } from '@deepseek-ai/dsh-api-remotes/client'
import { expect, it, onTestFinished, vi } from 'vitest'
import { BundleDetailController, bundleDetailKey } from '../src/client/detail-store.ts'

type Answer<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: RemoteError<never> }
const ok = <T>(value: T): Promise<Answer<T>> => Promise.resolve({ ok: true, value })
const FOUND: BundleDetail = { status: 'found', origin: 'readme', path: 'README.md', markdown: '# A' }
const flush = () => new Promise((resolve) => { setTimeout(resolve, 0) })

function setup() {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  const manager = {
    readBundleDetail: vi.fn((_name: string, _language: string, _options: object): Promise<Answer<BundleDetail>> => ok(FOUND)),
  }
  const probe = { fastest: vi.fn((): Promise<Answer<string | null>> => ok('https://registry.npmmirror.com/')) }
  new TestRemote(ctx, { pluginManager: manager, pluginRegistryProbe: probe })
  const controller = new BundleDetailController(ctx, () => 'https://dsh.example/prefix/')
  const state = (name: string, version: string | undefined, language: string) =>
    controller.store.getSnapshot()[bundleDetailKey(name, version, language)]
  return { controller, manager, probe, state }
}

it('reads each bundle version once per language and publishes the result', async () => {
  const { controller, manager, state } = setup()
  controller.load('a', '1.0.0', 'en', false)
  controller.load('a', '1.0.0', 'en', false)
  expect(state('a', '1.0.0', 'en')).toEqual({ status: 'loading' })
  await vi.waitFor(() => { expect(state('a', '1.0.0', 'en')).toEqual({ status: 'ready', detail: FOUND }) })
  controller.load('a', undefined, 'zh', false)
  await vi.waitFor(() => { expect(state('a', undefined, 'zh')?.status).toBe('ready') })
  expect(manager.readBundleDetail.mock.calls).toEqual([['a', 'en', { npmFileSources: [] }], ['a', 'zh', { npmFileSources: [] }]])
})

it('reports failures by reason, reads again on retry, and settles a retried key with the latest answer', async () => {
  const { controller, manager, state } = setup()
  manager.readBundleDetail.mockImplementationOnce(() => Promise.resolve({ ok: false, error: new RemoteError('plugin-manager/detail-unavailable' as never, 'big', { reason: 'too-large' } as never) }))
  manager.readBundleDetail.mockImplementationOnce(() => Promise.resolve({ ok: false, error: new RemoteError('plugin-manager/unknown-bundle' as never, 'gone', { name: 'b' } as never) }))
  controller.load('a', '1.0.0', 'en', false)
  controller.load('b', '1.0.0', 'en', false)
  await vi.waitFor(() => {
    expect(state('a', '1.0.0', 'en')).toEqual({ status: 'error', failure: 'too-large' })
    expect(state('b', '1.0.0', 'en')).toEqual({ status: 'error', failure: 'other' })
  })
  let first: (value: Answer<BundleDetail>) => void = () => {}
  manager.readBundleDetail.mockImplementationOnce(() => new Promise((resolve) => { first = resolve }))
  controller.retry('a', '1.0.0', 'en', false)
  controller.retry('a', '1.0.0', 'en', false)
  await vi.waitFor(() => { expect(state('a', '1.0.0', 'en')).toEqual({ status: 'ready', detail: FOUND }) })
  first({ ok: true, value: { status: 'none' } })
  await flush()
  expect(state('a', '1.0.0', 'en')).toEqual({ status: 'ready', detail: FOUND })
})

it('invalidates reads on reset, drops superseded answers, and stops publishing after disposal', async () => {
  const { controller, manager, state } = setup()
  let answer: (value: Answer<BundleDetail>) => void = () => {}
  manager.readBundleDetail.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve }))
  controller.load('a', '1.0.0', 'en', false)
  controller.reset()
  answer({ ok: true, value: FOUND })
  await flush()
  expect(controller.store.getSnapshot()).toEqual({})
  // A read from before a reset that settles after the read that replaced it does not overwrite it.
  let stale: (value: Answer<BundleDetail>) => void = () => {}
  manager.readBundleDetail.mockImplementationOnce(() => new Promise((resolve) => { stale = resolve }))
  controller.load('a', '1.0.0', 'en', false)
  controller.reset()
  manager.readBundleDetail.mockImplementationOnce(() => ok({ status: 'none' }))
  controller.load('a', '1.0.0', 'en', false)
  await vi.waitFor(() => { expect(state('a', '1.0.0', 'en')).toEqual({ status: 'ready', detail: { status: 'none' } }) })
  stale({ ok: true, value: FOUND })
  await flush()
  expect(state('a', '1.0.0', 'en')).toEqual({ status: 'ready', detail: { status: 'none' } })
  controller.reset()
  manager.readBundleDetail.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve }))
  controller.load('a', '1.0.0', 'en', false)
  controller.dispose()
  answer({ ok: true, value: FOUND })
  await flush()
  expect(state('a', '1.0.0', 'en')).toEqual({ status: 'ready', detail: { status: 'none' } })
})

it('asks the registry comparison only for bundles read from npm, and reads them and their images from npmmirror first where it won', async () => {
  const { controller, manager, probe, state } = setup()
  controller.load('installed', '1.0.0', 'en', false)
  await vi.waitFor(() => { expect(state('installed', '1.0.0', 'en')?.status).toBe('ready') })
  expect(probe.fastest).not.toHaveBeenCalled()
  expect(controller.image('x', 'README.md', 'a.png', true)).not.toContain('sources=')
  controller.load('offered', '1.0.0', 'en', true)
  await vi.waitFor(() => { expect(state('offered', '1.0.0', 'en')?.status).toBe('ready') })
  expect(manager.readBundleDetail.mock.calls.at(-1)).toEqual(['offered', 'en', { npmFileSources: ['npmmirror'] }])
  expect(controller.image('offered', 'README.md', 'a.png', true)).toContain('&sources=npmmirror')
  expect(controller.image('installed', 'README.md', 'a.png', false)).not.toContain('sources=')
  probe.fastest.mockImplementationOnce(() => Promise.resolve({ ok: false, error: new RemoteError('remote/unavailable' as never, 'gone', {} as never) }))
  controller.retry('offered', '1.0.0', 'en', true)
  await vi.waitFor(() => { expect(manager.readBundleDetail.mock.calls.at(-1)).toEqual(['offered', 'en', { npmFileSources: [] }]) })
})

it('drops a read whose registry comparison settles after a reset or disposal, without asking the Host', async () => {
  const { controller, manager, probe, state } = setup()
  let settle: (value: Answer<string | null>) => void = () => {}
  probe.fastest.mockImplementation(() => new Promise((resolve) => { settle = resolve }))
  controller.load('offered', '1.0.0', 'en', true)
  controller.reset()
  settle({ ok: true, value: 'https://registry.npmmirror.com/' })
  await flush()
  controller.load('offered', '1.0.0', 'en', true)
  controller.dispose()
  settle({ ok: true, value: 'https://registry.npmmirror.com/' })
  await flush()
  expect(manager.readBundleDetail).not.toHaveBeenCalled()
  expect(state('offered', '1.0.0', 'en')).toEqual({ status: 'loading' })
})

it('addresses relative images through the Host route and leaves other destinations alone', () => {
  const { controller } = setup()
  expect(controller.image('@acme/x', 'guide/D.md', 'img/a b.png', false))
    .toBe('https://dsh.example/prefix/api/plugin-manager/detail-file?bundle=%40acme%2Fx&document=guide%2FD.md&path=img%2Fa+b.png')
  for (const destination of ['https://example.com/a.png', 'data:image/png;base64,AA', '//cdn.example/a.png', '#top']) {
    expect(controller.image('x', 'README.md', destination, false)).toBeUndefined()
  }
})


it('retains a displayed document during invalidation and replaces it after one fresh read', async () => {
  const { controller, manager, state } = setup()
  controller.load('a', '1.0.0', 'en', false)
  await vi.waitFor(() => { expect(state('a', '1.0.0', 'en')).toEqual({ status: 'ready', detail: FOUND }) })
  const response = Promise.withResolvers<Answer<BundleDetail>>()
  onTestFinished(() => { response.resolve({ ok: true, value: FOUND }) })
  manager.readBundleDetail.mockImplementationOnce(() => response.promise)
  controller.reset()
  expect(state('a', '1.0.0', 'en')).toEqual({ status: 'ready', detail: FOUND })
  controller.load('a', '1.0.0', 'en', false)
  controller.load('a', '1.0.0', 'en', false)
  expect(manager.readBundleDetail).toHaveBeenCalledTimes(2)
  expect(state('a', '1.0.0', 'en')).toEqual({ status: 'ready', detail: FOUND })
  const replacement = { ...FOUND, markdown: '# Updated' }
  response.resolve({ ok: true, value: replacement })
  await vi.waitFor(() => { expect(state('a', '1.0.0', 'en')).toEqual({ status: 'ready', detail: replacement }) })
})
