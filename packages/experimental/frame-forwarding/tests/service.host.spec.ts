/** The frame-forwarding Host service exposes channels to Host plugins and drives them from the renderer through its Remote. */
import { receiverAddon } from './desktop-receiver.ts'
import { totalmem } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import { afterEach, expect, test, vi } from 'vitest'
import { windowBudget } from '../src/config.ts'
import FrameForwarding, {
  type FrameConnectionId, type FrameForwardingEvent, type FrameRxId,
} from '../src/index.ts'

/** The forwarder has its own specs; the service sees only its operations and its listeners. */
const forwarder = vi.hoisted(() => ({
  constructions: [] as { sharedTexture: unknown; load: () => unknown; limits: { maxBytes(): number } }[],
  listeners: undefined as { event(event: unknown): void; warn(message: string): void } | undefined,
  snapshot: [] as unknown[],
  methods: {
    capabilities: vi.fn(async (): Promise<{ supported: boolean; reason?: string }> => ({ supported: true })),
    channel: vi.fn(async () => ({ tx: 'tx', rx: 'rx-1' })),
    isOpen: vi.fn(() => true),
    setViewport: vi.fn(async () => ({ applied: true, connectionId: 1 })),
    close: vi.fn(async () => {}),
    closeAll: vi.fn(async () => {}),
  },
}))
vi.mock('../src/host/forwarder.ts', () => ({
  FrameForwarder: class {
    constructor(sharedTexture: unknown, load: () => unknown, limits: { maxBytes(): number }, listeners: typeof forwarder.listeners) {
      forwarder.constructions.push({ sharedTexture, load, limits })
      forwarder.listeners = listeners
    }
    capabilities = forwarder.methods.capabilities
    channel = forwarder.methods.channel
    isOpen = forwarder.methods.isOpen
    setViewport = forwarder.methods.setViewport
    close = forwarder.methods.close
    closeAll = forwarder.methods.closeAll
    snapshot = () => forwarder.snapshot
  },
}))

const load = vi.hoisted(() => vi.fn(() => ({ loaded: true })))
vi.mock('../src/host/native.ts', () => ({ loadFrameForwardingBindings: load }))

afterEach(() => {
  vi.clearAllMocks()
  forwarder.constructions.length = 0
  forwarder.listeners = undefined
  forwarder.snapshot = []
})

async function fixture(options: { desktop?: boolean; receiver?: boolean; config?: Record<string, number> } = {}) {
  const ctx = new Context()
  if (options.receiver !== false) ctx.provide('desktopFrameReceiver', { path: receiverAddon })
  const claim = { capabilities: vi.fn(), nativeSink: vi.fn(), adapterLuid: vi.fn(), release: vi.fn() }
  const sharedTexture = { claim: vi.fn(() => claim) }
  if (options.desktop !== false) ctx.provide('sharedTexture', sharedTexture as never)
  const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
  await ctx.plugin(FrameForwarding, FrameForwarding.Config(options.config ?? {})).await()
  const service = ctx.get('frameForwarding') as FrameForwarding
  return { ctx, service, sharedTexture, claim, warn, dispose: () => ctx.fiber.dispose() }
}
const rx = brandString<FrameRxId>('rx-1')
/** Resolve the window budget the plugin handed to its `index`-th forwarder construction. */
const budgetOf = (index: number): number => forwarder.constructions[index]!.limits.maxBytes()
const state = (channel: string, sequence: number, connectionId?: number): FrameForwardingEvent => connectionId === undefined
  ? { kind: 'state', rx: brandString<FrameRxId>(channel), sequence, channel: { state: 'idle' } }
  : { kind: 'state', rx: brandString<FrameRxId>(channel), sequence, channel: { state: 'connected', connectionId: connectionId as FrameConnectionId } }
function subscribe(service: FrameForwarding) {
  const controller = new AbortController()
  const received: FrameForwardingEvent[] = []
  const done = (async () => {
    for await (const event of service.events(controller.signal)) received.push(event)
  })()
  return { received, done, cancel: () => { controller.abort() } }
}

test('resolves native layer limits and rejects invalid configuration', () => {
  expect(FrameForwarding.Config({})).toMatchObject({ maxFrames: 3 })
  expect(() => FrameForwarding.Config({ maxFrames: 2 })).toThrow()
})

test('publishes only the renderer operations as Remote methods', async () => {
  const f = await fixture()
  try {
    expect(f.service.typertRemote).toMatchObject({ serviceKey: 'frameForwarding', namespace: 'frameForwarding' })
    expect(remoteMethods(f.service).map(({ method, mode }) => [method, mode ?? 'unary'])).toEqual([['viewport', 'unary'], ['events', 'stream']])
  } finally { await f.dispose() }
})

test('builds one forwarder over the Desktop service with the configured limits and forwards consumer operations', async () => {
  const f = await fixture({ config: { maxFrames: 4, maxBytes: 8192, requestTimeoutMs: 500, maxPendingRequests: 9 } })
  try {
    forwarder.methods.isOpen.mockReturnValueOnce(false)
    expect(f.service.isOpen(rx)).toBe(false)
    expect(await f.service.capabilities()).toEqual({ supported: true })
    expect(await f.service.channel()).toEqual({ tx: 'tx', rx: 'rx-1' })
    expect(f.service.isOpen(rx)).toBe(true)
    expect(await f.service.viewport(rx, { version: 1, width: 4, height: 2, deviceScaleFactor: 2, visible: true }))
      .toEqual({ applied: true, connectionId: 1 })
    await f.service.close(rx)
    await f.service.close(brandString<FrameRxId>('unknown'))
    expect(forwarder.constructions).toMatchObject([{
      sharedTexture: f.claim, limits: { maxFrames: 4, requestTimeoutMs: 500, maxPendingRequests: 9 },
    }])
    expect(budgetOf(0)).toBe(8192)
    expect(f.warn).not.toHaveBeenCalled()
    expect(load).not.toHaveBeenCalled()
    expect(forwarder.constructions[0]!.load()).toEqual({ loaded: true })
    expect(load).toHaveBeenCalledExactlyOnceWith(receiverAddon)
    expect(forwarder.methods.isOpen).toHaveBeenCalledWith(rx)
    expect(forwarder.methods.setViewport).toHaveBeenCalledWith(rx, expect.objectContaining({ version: 1 }))
    expect(forwarder.methods.close.mock.calls).toEqual([[rx], ['unknown']])
    forwarder.listeners!.warn('Native producer refused: channel-busy')
    expect(f.warn).toHaveBeenCalledWith('Native producer refused: channel-busy')
  } finally { await f.dispose() }
  expect(forwarder.methods.closeAll).toHaveBeenCalledOnce()
  expect(f.claim.release).toHaveBeenCalledOnce()
  expect(forwarder.methods.closeAll.mock.invocationCallOrder[0]).toBeLessThan(f.claim.release.mock.invocationCallOrder[0]!)
})

test('sizes the window budget at half of physical memory by default and reduces a larger budget to physical memory with a warning', async () => {
  const f = await fixture()
  try {
    expect(budgetOf(0)).toBe(Math.max(256 * 1024 ** 2, Math.floor(totalmem() / 2)))
    expect(f.warn).not.toHaveBeenCalled()
  } finally { await f.dispose() }
  const large = await fixture({ config: { maxBytes: totalmem() + 1 } })
  try {
    expect(budgetOf(1)).toBe(totalmem())
    expect(large.warn).toHaveBeenCalledExactlyOnceWith(
      `Frame forwarding maxBytes ${totalmem() + 1} exceeds the ${totalmem()} bytes of physical memory; the window budget is ${totalmem()} bytes.`,
    )
  } finally { await large.dispose() }
  expect(windowBudget('auto', 16 * 1024 ** 3)).toBe(8 * 1024 ** 3)
  expect(windowBudget('auto', 300 * 1024 ** 2)).toBe(256 * 1024 ** 2)
  expect(windowBudget('auto', 200 * 1024 ** 2)).toBe(200 * 1024 ** 2)
  expect(windowBudget(16 * 1024 ** 3, 16 * 1024 ** 3)).toBe(16 * 1024 ** 3)
  expect(windowBudget(16 * 1024 ** 3 + 1, 16 * 1024 ** 3)).toBe(16 * 1024 ** 3)
})

test('claims Desktop shared textures once the Desktop Host provides them and releases the claim when they go away', async () => {
  const f = await fixture({ desktop: false })
  try {
    expect(await f.service.capabilities()).toEqual({ supported: false, reason: 'desktop-shared-texture-unavailable' })
    const provided = f.ctx.provide('sharedTexture', f.sharedTexture as never)
    await vi.waitFor(() => { expect(forwarder.constructions).toHaveLength(1) })
    expect(f.sharedTexture.claim).toHaveBeenCalledOnce()
    expect(await f.service.capabilities()).toEqual({ supported: true })
    await f.service.channel()
    provided()
    await vi.waitFor(() => { expect(f.claim.release).toHaveBeenCalledOnce() })
    expect(forwarder.methods.closeAll).toHaveBeenCalledOnce()
    expect(await f.service.capabilities()).toEqual({ supported: false, reason: 'desktop-shared-texture-unavailable' })
    expect(f.service.isOpen(rx)).toBe(false)
  } finally { await f.dispose() }
})

test('starts with a late Desktop receiver and releases channels when the provider leaves', async () => {
  const f = await fixture({ receiver: false })
  try {
    expect(await f.service.capabilities()).toEqual({ supported: false, reason: 'receiver-unavailable' })
    await expect(f.service.channel()).rejects.toThrow('Desktop frame receiver is unavailable')
    const remove = f.ctx.provide('desktopFrameReceiver', { path: receiverAddon })
    await vi.waitFor(() => { expect(f.sharedTexture.claim).toHaveBeenCalledOnce() })
    await f.service.channel()
    remove()
    await vi.waitFor(() => { expect(f.claim.release).toHaveBeenCalledOnce() })
    expect(forwarder.methods.closeAll).toHaveBeenCalledOnce()
  } finally { await f.dispose() }
})

test('reports the shared textures claimed when another consumer holds their claim', async () => {
  const ctx = new Context()
  ctx.provide('desktopFrameReceiver', { path: receiverAddon })
  const sharedTexture = { claim: vi.fn(() => { throw new Error('Desktop shared textures are already claimed') }) }
  ctx.provide('sharedTexture', sharedTexture as never)
  const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
  const fiber = ctx.plugin(FrameForwarding, FrameForwarding.Config({}))
  await fiber.await()
  try {
    const service = ctx.get('frameForwarding')!
    expect(await service.capabilities()).toEqual({ supported: false, reason: 'desktop-shared-texture-claimed' })
    await expect(service.channel()).rejects.toThrow('claimed by another consumer')
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ message: 'Desktop shared textures are already claimed' }))
    expect(forwarder.constructions).toEqual([])
  } finally { await ctx.fiber.dispose() }
})

test('a channel closes with the scope that opened it, and an explicit close ends that binding', async () => {
  const f = await fixture()
  try {
    const frames = (scope: Context) => scope.get('frameForwarding')!
    const owner = f.ctx.plugin(async (scope) => { await frames(scope).channel() })
    await owner.await()
    expect(forwarder.methods.close).not.toHaveBeenCalled()
    await owner.dispose()
    expect(forwarder.methods.close.mock.calls).toEqual([[rx]])
    forwarder.methods.channel.mockResolvedValueOnce({ tx: 'tx', rx: 'rx-2' })
    const closing = f.ctx.plugin(async (scope) => {
      const { rx: opened } = await frames(scope).channel()
      await frames(scope).close(opened)
    })
    await closing.await()
    await closing.dispose()
    expect(forwarder.methods.close.mock.calls).toEqual([[rx], ['rx-2']])
    // A scope disposed while its channel opens cannot own it, so the channel closes and the call rejects.
    const opening = Promise.withResolvers<{ tx: string; rx: string }>()
    forwarder.methods.channel.mockReturnValueOnce(opening.promise)
    let late: Promise<unknown> | undefined
    const gone = f.ctx.plugin((scope) => { late = frames(scope).channel() })
    await gone.await()
    await gone.dispose()
    opening.resolve({ tx: 'tx', rx: 'rx-3' })
    await expect(late).rejects.toThrow('inactive')
    expect(forwarder.methods.close.mock.calls).toEqual([[rx], ['rx-2'], ['rx-3']])
  } finally { await f.dispose() }
})

test('reports unsupported without Desktop shared textures and refuses channels, while close stays idempotent', async () => {
  const f = await fixture({ desktop: false })
  try {
    expect(await f.service.capabilities()).toEqual({ supported: false, reason: 'desktop-shared-texture-unavailable' })
    await expect(f.service.channel()).rejects.toThrow('Desktop shared textures are unavailable.')
    await expect(f.service.viewport(rx, { version: 1, width: 1, height: 1, deviceScaleFactor: 1, visible: true })).rejects.toThrow('unavailable')
    await f.service.close(rx)
    const events = subscribe(f.service)
    await vi.waitFor(() => { expect(events.received).toEqual([{ kind: 'snapshot', channels: [] }]) })
    events.cancel()
    await events.done
    expect(forwarder.constructions).toEqual([])
  } finally { await f.dispose() }
})

test('starts every subscription with a snapshot and replaces an earlier renderer', async () => {
  const f = await fixture()
  try {
    const empty = subscribe(f.service)
    await vi.waitFor(() => { expect(empty.received).toEqual([{ kind: 'snapshot', channels: [] }]) })
    await f.service.channel()
    forwarder.snapshot = [{ rx: 'rx-1', sequence: 1, channel: { state: 'idle' } }]
    const first = subscribe(f.service)
    await empty.done
    await vi.waitFor(() => { expect(first.received).toHaveLength(1) })
    expect(first.received[0]).toEqual({ kind: 'snapshot', channels: forwarder.snapshot })
    forwarder.listeners!.event(state('rx-1', 2, 1))
    await vi.waitFor(() => { expect(first.received).toHaveLength(2) })
    expect(first.received[1]).toEqual(state('rx-1', 2, 1))
    const second = subscribe(f.service)
    await first.done
    second.cancel()
    await second.done
    forwarder.listeners!.event(state('rx-1', 3))
  } finally { await f.dispose() }
})

test('keeps the newest state per channel and resynchronizes with a snapshot when unread events exceed the limit', async () => {
  const f = await fixture({ config: { maxQueuedEvents: 2 } })
  try {
    await f.service.channel()
    const events = subscribe(f.service)
    const error: FrameForwardingEvent = { kind: 'error', rx, connectionId: 1 as FrameConnectionId, source: 'producer', error: 'stream failed' }
    // The stream already took its snapshot; these wait unread.
    forwarder.listeners!.event(state('rx-1', 1))
    forwarder.listeners!.event(state('rx-1', 2, 1))
    forwarder.listeners!.event(error)
    // The forwarder publishes after it updated its channels, so the replacing snapshot holds every newest state.
    forwarder.snapshot = [
      { rx: 'rx-1', sequence: 2, channel: { state: 'connected', connectionId: 1 } }, { rx: 'rx-2', sequence: 3, channel: { state: 'idle' } },
    ]
    forwarder.listeners!.event(state('rx-2', 3))
    forwarder.listeners!.event(state('rx-2', 4, 2))
    await vi.waitFor(() => { expect(events.received).toHaveLength(3) })
    events.cancel()
    await events.done
    expect(events.received).toEqual([{ kind: 'snapshot', channels: [] }, { kind: 'snapshot', channels: forwarder.snapshot }, state('rx-2', 4, 2)])
    const limited = await fixture({ config: { maxQueuedEvents: 1 } })
    try {
      await limited.service.channel()
      forwarder.snapshot = []
      const one = subscribe(limited.service)
      forwarder.listeners!.event(state('rx-1', 1))
      forwarder.snapshot = [{ rx: 'rx-1', sequence: 1, channel: { state: 'idle' } }, { rx: 'rx-2', sequence: 2, channel: { state: 'idle' } }]
      forwarder.listeners!.event(state('rx-2', 2))
      await vi.waitFor(() => { expect(one.received).toHaveLength(2) })
      one.cancel()
      await one.done
      expect(one.received).toEqual([{ kind: 'snapshot', channels: [] }, { kind: 'snapshot', channels: forwarder.snapshot }])
    } finally { await limited.dispose() }
  } finally { await f.dispose() }
})

test('a resynchronizing snapshot keeps the unread closures of channels the forwarder already forgot', async () => {
  const f = await fixture({ config: { maxQueuedEvents: 2 } })
  try {
    const events = subscribe(f.service)
    const error: FrameForwardingEvent = { kind: 'error', rx, connectionId: 1 as FrameConnectionId, source: 'producer', error: 'stream failed' }
    const failed = { rx: brandString<FrameRxId>('rx-failed'), sequence: 1, channel: { state: 'closed', cause: 'failed', reason: 'Native channel failed: device lost' } } as const
    const closed = { rx, sequence: 3, channel: { state: 'closed', cause: 'closed', reason: 'Native channel closed' } } as const
    // rx-failed published its closure and completed its teardown before the renderer read the closure.
    forwarder.listeners!.event({ kind: 'state', ...failed })
    forwarder.listeners!.event(error)
    forwarder.snapshot = [{ rx: 'rx-1', sequence: 2, channel: { state: 'idle' } }]
    forwarder.listeners!.event(state('rx-1', 2))
    // rx-1 is still closing, so the forwarder's snapshot already carries its closure; the earlier snapshot carries rx-failed's.
    forwarder.snapshot = [closed]
    forwarder.listeners!.event({ kind: 'state', ...closed })
    forwarder.listeners!.event(error)
    await vi.waitFor(() => { expect(events.received).toHaveLength(2) })
    events.cancel()
    await events.done
    expect(events.received).toEqual([{ kind: 'snapshot', channels: [] }, { kind: 'snapshot', channels: [closed, failed] }])
  } finally { await f.dispose() }
})

const closure = (channel: string, sequence: number) =>
  ({ rx: brandString<FrameRxId>(channel), sequence, channel: { state: 'closed', cause: 'closed', reason: 'Native channel closed' } }) as const

test('a resynchronizing snapshot keeps every current channel and only the newest forgotten closures', async () => {
  const f = await fixture({ config: { maxQueuedEvents: 2 } })
  try {
    const events = subscribe(f.service)
    const live = { rx: brandString<FrameRxId>('rx-live'), sequence: 1, channel: { state: 'idle' } } as const
    // An unread renderer sees ten channels open and close; each closure is still closing when it is published.
    for (let index = 1; index <= 10; index++) {
      const closing = closure(`rx-${index}`, index + 1)
      forwarder.snapshot = [live, closing]
      forwarder.listeners!.event({ kind: 'state', ...closing })
    }
    await vi.waitFor(() => { expect(events.received).toHaveLength(3) })
    events.cancel()
    await events.done
    // Without the bound the snapshot would carry all nine closures preceding the last one.
    expect(events.received).toEqual([
      { kind: 'snapshot', channels: [] },
      { kind: 'snapshot', channels: [live, closure('rx-9', 10), closure('rx-7', 8), closure('rx-8', 9)] },
      { kind: 'state', ...closure('rx-10', 11) },
    ])
  } finally { await f.dispose() }
})

test('a resynchronizing snapshot keeps the newest closure of a channel that several unread events carry', async () => {
  const f = await fixture({ config: { maxQueuedEvents: 3 } })
  try {
    const events = subscribe(f.service)
    const error: FrameForwardingEvent = { kind: 'error', rx, connectionId: 1 as FrameConnectionId, source: 'producer', error: 'stream failed' }
    for (let index = 0; index < 3; index++) forwarder.listeners!.event(error)
    forwarder.snapshot = [closure('rx-a', 5), closure('rx-b', 6)]
    forwarder.listeners!.event(state('rx-live', 7))
    forwarder.listeners!.event({ kind: 'state', ...closure('rx-a', 8) })
    forwarder.listeners!.event({ kind: 'state', ...closure('rx-b', 2) })
    forwarder.snapshot = [{ rx: 'rx-live', sequence: 9, channel: { state: 'idle' } }]
    forwarder.listeners!.event(state('rx-live', 9))
    await vi.waitFor(() => { expect(events.received).toHaveLength(2) })
    events.cancel()
    await events.done
    expect(events.received[1]).toEqual({ kind: 'snapshot', channels: [...forwarder.snapshot, closure('rx-b', 6), closure('rx-a', 8)] })
  } finally { await f.dispose() }
})

test('a channel the forwarder closed itself releases the scope that opened it', async () => {
  const f = await fixture()
  try {
    const owner = f.ctx.plugin(async (scope) => { await scope.get('frameForwarding')!.channel() })
    await owner.await()
    forwarder.methods.close.mockRejectedValueOnce(new Error('receiver teardown failed'))
    forwarder.listeners!.event({ kind: 'state', rx, sequence: 5, channel: { state: 'closed', cause: 'lost', reason: 'Desktop invalidated a presented frame' } })
    expect(forwarder.methods.close.mock.calls).toEqual([[rx]])
    await owner.dispose()
    expect(forwarder.methods.close.mock.calls).toEqual([[rx]])
    // A closed state without an owner, such as one the owner's own close published, changes nothing.
    forwarder.listeners!.event({ kind: 'state', rx, sequence: 6, channel: { state: 'closed', cause: 'closed', reason: 'Native channel closed' } })
    expect(forwarder.methods.close.mock.calls).toEqual([[rx]])
  } finally { await f.dispose() }
})

test('disposal ends the renderer stream and logs a failed receiver cleanup', async () => {
  const f = await fixture()
  const events = subscribe(f.service)
  await f.service.channel()
  forwarder.methods.closeAll.mockRejectedValueOnce(new Error('cleanup failed'))
  await f.dispose()
  await events.done
  expect(f.warn).toHaveBeenCalledWith(expect.objectContaining({ message: 'cleanup failed' }))
})
