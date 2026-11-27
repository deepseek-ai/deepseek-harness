// @vitest-environment jsdom
/** Default Desktop Office contributions and their Remote namespace belong to the Client plugin lifecycle. */
import { brandString } from '@deepseek-ai/dsh-brand'
import type { OfficeDocumentId } from '../src/types.ts'
import { officeLease } from './helpers/office-lease.client.ts'
import { Context, Service } from '@deepseek-ai/cordis'
import type { TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import { afterEach, expect, test, vi } from 'vitest'
import * as plugin from '../src/client/mount.ts'
import type { OfficePreviewClient } from '../src/client/service.ts'
import { officeViewFixture } from './helpers/office-view.client.tsx'
import { fakeFrameForwarding } from './helpers/frame-forwarding.client.ts'

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

const contribution: TypertRemoteContribution = { package: '@deepseek-ai/dsh-client-ui-office-frame-forwarding', descriptors: [] }

test('exports only the mount and its injections at runtime', () => {
  expect(Object.keys(plugin).sort()).toEqual(['inject', 'mountOfficePreview'])
})

test('mounts the Remote but registers no UI when the Host does not render this workspace locally', async () => {
  const f = fixture(() => (async function* () {})(), false, { local: false })
  const dispose = await plugin.mountOfficePreview(f.ctx, contribution)
  expect(f.remote.$mount).toHaveBeenCalledExactlyOnceWith(contribution)
  expect(f.availability).toHaveBeenCalledOnce()
  expect(f.definitions).toEqual([])
  await dispose()
  expect(f.order).toEqual(['remote'])
  await f.ctx.fiber.dispose()
})

test('registers no UI and queries nothing without the renderer-side frame-forwarding service', async () => {
  const f = fixture(() => (async function* () {})(), false, { local: true }, false)
  const dispose = await plugin.mountOfficePreview(f.ctx, contribution)
  expect(f.availability).not.toHaveBeenCalled()
  expect(f.definitions).toEqual([])
  await dispose()
  await f.ctx.fiber.dispose()
})

test('registers no UI when frame forwarding is withdrawn before the Remote mount finishes', async ({ onTestFinished }) => {
  const f = fixture(() => (async function* () {})(), false, { local: true }, false)
  onTestFinished(() => f.ctx.fiber.dispose())
  const provider = f.ctx.plugin((ctx) => {
    ctx.provide('frameForwarding', fakeFrameForwarding().client as never)
  })
  await provider
  const remoteReady = Promise.withResolvers<undefined>()
  f.remote.$mount.mockImplementationOnce(async () => {
    await remoteReady.promise
    return async () => { f.order.push('remote') }
  })
  const mounting = plugin.mountOfficePreview(f.ctx, contribution)
  await provider.dispose()
  remoteReady.resolve(undefined)
  const dispose = await mounting
  onTestFinished(dispose)
  expect(f.availability).not.toHaveBeenCalled()
  expect(f.definitions).toEqual([])
})

test('a failed availability query withdraws the mounted Remote contribution', async () => {
  const f = fixture(() => (async function* () {})(), false, new Error('Host unavailable'))
  await expect(plugin.mountOfficePreview(f.ctx, contribution)).rejects.toThrow('Host unavailable')
  expect(f.order).toEqual(['remote'])
  await f.ctx.fiber.dispose()
})

test('registers nothing and does not fail when the Host withdraws its Office service during the availability query', async () => {
  const withdrawn = Object.assign(new Error('officePreview/availability: its strict definition was withdrawn'), {
    code: 'gateway/definition-unavailable',
  })
  const f = fixture(() => (async function* () {})(), false, withdrawn)
  const dispose = await plugin.mountOfficePreview(f.ctx, contribution)
  expect(f.availability).toHaveBeenCalledOnce()
  expect(f.definitions).toEqual([])
  await dispose()
  await f.ctx.fiber.dispose()
})

test('registers native preview when frame forwarding arrives after the Remote contribution', async () => {
  const f = fixture(() => (async function* () {})(), false, { local: true }, false)
  const dispose = await plugin.mountOfficePreview(f.ctx, contribution)
  expect(f.definitions).toEqual([])
  f.ctx.provide('frameForwarding', fakeFrameForwarding().client as never)
  await vi.waitFor(() => { expect(f.definitions.map(value => value.name)).toEqual([
    'shell.overlay', 'sidebar.right.tab.document.office.native', 'sidebar.right.tab.document.office.native.action',
  ]) })
  expect(f.availability).toHaveBeenCalledOnce()
  await dispose()
  expect(f.order.at(-1)).toBe('remote')
  await f.ctx.fiber.dispose()
})

function fixture(
  stream: () => AsyncIterable<unknown>, failingSlots = false, availability: { local: boolean } | Error = { local: true }, frames = true,
) {
  const order: string[] = []
  const removeLocale = vi.fn(() => { order.push('locale') })
  const definitions: {
    name: string
    inject?: () => { office?: OfficePreviewClient; views?: unknown }
    store?: { create: () => object }
  }[] = []
  const register = vi.fn((definition: typeof definitions[number]) => {
    definitions.push(definition)
    return () => { order.push(definition.name) }
  })
  const events = vi.fn(() => ({}))
  const available = vi.fn(async () => availability instanceof Error
    ? { ok: false as const, error: { message: availability.message, code: 'code' in availability ? availability.code : 'gateway/internal' } }
    : { ok: true as const, value: availability })
  let streamOptions: { name: string; open(signal: AbortSignal): unknown; ended(accepted: boolean): Error } | undefined
  const namespace = { retain: vi.fn(), events, availability: available }
  const ctx = new Context()
  const remote = {
    [Service.tracker]: { property: 'ctx' },
    ctx, officePreview: namespace,
    $mount: vi.fn(async function (this: { ctx: Context }) {
      const revoke = this.ctx.effect(() => () => { order.push('remote') })
      return async () => { await revoke() }
    }),
    $stream: vi.fn((options: NonNullable<typeof streamOptions>) => {
      streamOptions = options
      if (options.name === 'Office document lease') return officeLease()
      return { [Symbol.asyncIterator]: () => stream()[Symbol.asyncIterator](), dispose: vi.fn(async () => { order.push('events') }) }
    }),
  }
  const wire = fakeFrameForwarding()
  if (frames) ctx.provide('frameForwarding', wire.client as never)
  ctx.provide('remote', remote as never)
  ctx.provide('remote.officePreview', namespace as never)
  ctx.provide('slots', (failingSlots ? { inject: () => { throw new Error('slots unavailable') }, register }
    : { inject: vi.fn((_name: string, mount: () => () => void) => mount()), register }) as never)
  ctx.provide('locale', { register: vi.fn(() => removeLocale) } as never)
  const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
  return { ctx, wire, remote, events, availability: available, order, definitions, warn, options: () => streamOptions! }
}

test('mounts the Remote contribution, registers preview contributions, and withdraws the UI before the Remote', async () => {
  const delivered = Promise.withResolvers<undefined>()
  const accept = vi.fn()
  const f = fixture(() => (async function* () {
    await delivered.promise
    yield { value: { documentId: 'doc', event: { kind: 'callback', type: 0, payload: '' } }, accept }
  })())
  const dispose = await plugin.mountOfficePreview(f.ctx, contribution)
  expect(f.remote.$mount).toHaveBeenCalledExactlyOnceWith(contribution)
  expect(f.definitions.map(value => value.name)).toEqual(['shell.overlay', 'sidebar.right.tab.document.office.native',
    'sidebar.right.tab.document.office.native.action'])
  const office = f.definitions[1]!.inject!().office!
  expect(f.definitions[0]!.inject!()).toEqual({ hooks: { views: office.views } })
  expect(f.definitions[1]!.store!.create()).toBeDefined()
  const listener = vi.fn()
  office.connection.listeners.add(listener)
  delivered.resolve(undefined)
  await vi.waitFor(() => { expect(listener).toHaveBeenCalledWith({ documentId: 'doc', event: { kind: 'callback', type: 0, payload: '' } }) })
  expect(accept).toHaveBeenCalledOnce()
  const signal = new AbortController().signal
  f.options().open(signal)
  expect(f.events).toHaveBeenCalledWith(signal)
  expect(f.options().ended(true).message).toBe('Office preview events ended.')
  await dispose()
  expect(f.order.at(-1)).toBe('remote')
  expect(f.order).toContain('events')
  expect(f.order.indexOf('locale')).toBeLessThan(f.order.indexOf('remote'))
  await f.ctx.fiber.dispose()
})

test.each([new Error('events ended'), 'events ended'])('a terminal event stream failure %s is logged, fails the open documents, and the UI remains registered', async (failure) => {
  const f = fixture(() => (async function* () { yield* []; throw failure })())
  const dispose = await plugin.mountOfficePreview(f.ctx, contribution)
  await vi.waitFor(() => { expect(f.warn).toHaveBeenCalledWith(failure) })
  const office = f.definitions[1]!.inject!().office!
  await expect(office.connection.document(() => brandString<OfficeDocumentId>('doc')).info()).rejects.toThrow('Office engine events are unavailable: events ended')
  expect(f.definitions.map(value => value.name)).toContain('sidebar.right.tab.document.office.native')
  await dispose()
  await f.ctx.fiber.dispose()
})

test('a failed UI registration withdraws the mounted Remote contribution', async () => {
  const f = fixture(() => (async function* () {})(), true)
  await expect(plugin.mountOfficePreview(f.ctx, contribution)).rejects.toThrow('slots unavailable')
  expect(f.order).toContain('remote')
  await f.ctx.fiber.dispose()
})

test('plugin unload waits for a mounted view to release its document while its Remote is live', async () => {
  const f = fixture(() => (async function* () {})())
  const scope = f.ctx.plugin(async ctx => plugin.mountOfficePreview(ctx, contribution))
  await scope
  const office = f.definitions[1]!.inject!().office!
  const gate = Promise.withResolvers<undefined>()
  const view = officeViewFixture('text', false, ({ props, remote }) => {
    props.connection = office.connection
    Object.assign(f.remote.officePreview, remote, {
      release: async () => {
        f.order.push('release started')
        await gate.promise
        f.order.push('release completed')
        return { ok: true, value: undefined }
      },
    })
  }, f.wire)
  try {
    await view.flush()
    expect(view.paint).toHaveBeenCalled()
    const signal = new AbortController().signal
    f.options().open(signal)
    expect(f.remote.officePreview.retain).toHaveBeenCalledWith(view.opened.documentId, expect.any(String), signal)
    expect(f.options().ended(true).message).toBe('Office document lease ended.')
    const unloading = scope.dispose()
    await view.flush()
    expect(f.order).toContain('release started')
    expect(f.order).not.toContain('remote')
    gate.resolve(undefined)
    await unloading
    expect(f.order.indexOf('release completed')).toBeLessThan(f.order.indexOf('remote'))
  } finally { gate.resolve(undefined); await view.close(); await f.ctx.fiber.dispose() }
})
