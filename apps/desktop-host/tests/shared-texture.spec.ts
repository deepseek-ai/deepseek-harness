/**
 * The Desktop Host shared-texture service queries Main over the child-process channel, keeps one hop connection to
 * Main's ingress, and hands that connection's native sink to its claimant. The hop is a fake native module loaded through
 * {@link plugin.loadSharedTextureHop}, so these specs also cover the addon wrapper.
 */
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SharedTextureHostMessage } from '../src/types.ts'
import * as plugin from '../src/shared-texture.ts'

const SHARED_TEXTURE_MESSAGE = 'shared-texture'

interface HopEvent { type: 'disconnected' }
interface FakeConnection { endpoint: string; onEvent(event: HopEvent): void; native: object; sink: object }

/** The fake native hop the fixture module exports; Node's loader caches it, so its methods change through mocks. */
const native = {
  connections: [] as FakeConnection[],
  connect: vi.fn((endpoint: string, onEvent: (event: HopEvent) => void) => {
    const connection = { endpoint, onEvent, native: { connection: native.connections.length }, sink: { sink: native.connections.length } }
    native.connections.push(connection)
    return { native: connection.native, sink: connection.sink }
  }),
  close: vi.fn((_native: object) => {}),
}
const fixtureDirectory = mkdtempSync(join(tmpdir(), 'dsh-shared-texture-hop-'))
const hopPath = join(fixtureDirectory, 'hop.cjs')
Object.assign(globalThis, { __dshSharedTextureHopFixture: native })
writeFileSync(hopPath, 'module.exports = globalThis.__dshSharedTextureHopFixture\n')
afterAll(() => { rmSync(fixtureDirectory, { recursive: true, force: true }) })

const originalProcess = process
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
function setPlatform(value: NodeJS.Platform): void { Object.defineProperty(originalProcess, 'platform', { value, configurable: true }) }
const send = vi.fn((_message: SharedTextureHostMessage, callback: (error: Error | null) => void) => {
  callback(null)
  return true
})
let channel: { connected: boolean; send: typeof send | undefined }
let ctx: Context
const loadHop = vi.fn((path: string | undefined) => plugin.loadSharedTextureHop(path))

beforeEach(() => {
  vi.clearAllMocks()
  native.connections = []
  channel = { connected: true, send }
  const events = new EventEmitter()
  vi.stubGlobal('process', new Proxy(originalProcess, {
    get(target, property, receiver) {
      if (property === 'on') return events.on.bind(events)
      if (property === 'off') return events.off.bind(events)
      if (property === 'emit') return events.emit.bind(events)
      if (property === 'send') return channel.send
      if (property === 'connected') return channel.connected
      const value: unknown = Reflect.get(target, property, receiver)
      return value
    },
  }))
  ctx = new Context()
})

afterEach(async () => {
  await ctx.fiber.dispose()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  Object.defineProperty(originalProcess, 'platform', platform)
})

/** Default deadline the claimant passes with each operation in these specs. */
const TIMEOUT_MS = 10_000
type Claim = ReturnType<Context['sharedTexture']['claim']>
/** A claim whose operations pass `timeoutMs`, as frame forwarding passes its configured deadline. */
interface BoundClaim {
  capabilities(): ReturnType<Claim['capabilities']>
  nativeSink(): ReturnType<Claim['nativeSink']>
  adapterLuid(): ReturnType<Claim['adapterLuid']>
  release(): void
}
async function service(timeoutMs = TIMEOUT_MS): Promise<BoundClaim> {
  const textures = new plugin.SharedTexture(ctx, loadHop)
  await ctx.plugin(() => {}).await()
  const claim = textures.claim()
  return {
    capabilities: () => claim.capabilities(timeoutMs),
    nativeSink: () => claim.nativeSink(timeoutMs),
    adapterLuid: () => claim.adapterLuid(timeoutMs),
    release: () => { claim.release() },
  }
}
const receive = (message: unknown): void => { process.emit('message', message, undefined) }
const reply = (requestId: number, body: { value?: unknown; error?: string }): void => {
  receive({ type: SHARED_TEXTURE_MESSAGE, requestId, ...body })
}
const sent = (): SharedTextureHostMessage[] => send.mock.calls.map(([message]) => message)
const operations = (): string[] => sent().map(message => message.request.op)
const capabilitiesValue = { supported: true, pid: 77, hop: { addon: hopPath }, ingress: { endpoint: 'ai.deepseek.shared-texture.x' } }

/** Answer the capability query a Host operation issues before connecting. */
async function answerCapabilities(value: unknown = capabilitiesValue): Promise<void> {
  await vi.waitFor(() => { expect(sent().at(-1)).toMatchObject({ request: { op: 'capabilities' } }) })
  reply(sent().at(-1)!.requestId, { value })
}
/** Report the loss of a connection, by default the latest, as the hop does. */
function disconnect(connection = native.connections.length - 1): void {
  native.connections[connection]!.onEvent({ type: 'disconnected' })
}
/** Take the native sink of the first connection, which this request opens. */
async function sinkConnected(textures: BoundClaim): Promise<void> {
  const sinking = textures.nativeSink()
  await answerCapabilities()
  expect(await sinking).toBe(native.connections[0]!.sink)
}

describe('capabilities', () => {
  it('queries Main and reports support without Main\'s process, hop addon, or endpoint', async () => {
    const textures = await service(2500)
    const capabilities = textures.capabilities()
    await vi.waitFor(() => { expect(send).toHaveBeenCalledOnce() })
    expect(sent()).toEqual([{ type: SHARED_TEXTURE_MESSAGE, requestId: 1, request: { op: 'capabilities' } }])
    reply(1, { value: capabilitiesValue })
    await expect(capabilities).resolves.toStrictEqual({ supported: true })
    const unsupported = textures.capabilities()
    reply(2, { value: { supported: false, reason: 'No exportable compositor', pid: 77 } })
    await expect(unsupported).resolves.toStrictEqual({ supported: false, reason: 'No exportable compositor' })
    for (const value of [{ supported: 'yes', pid: 77 }, { supported: true }, { supported: true, pid: 77, ingress: {} },
      { supported: true, pid: 77, hop: { addon: '' } }, { supported: true, pid: 77, reason: 1 }, []]) {
      const malformed = textures.capabilities()
      reply(send.mock.calls.length, { value })
      await expect(malformed).rejects.toThrow('Invalid Desktop shared-texture')
    }
    expect(native.connect).not.toHaveBeenCalled()
  })

  it.each([
    ['unsupported', { supported: false, reason: 'gpu-compositing-disabled', pid: 77 }],
    ['another Main process', { ...capabilitiesValue, pid: 78 }],
    ['another endpoint', { ...capabilitiesValue, ingress: { endpoint: 'replacement' } }],
  ] as const)('closes the connection when Main reports %s, so the next request reconnects', async (_case, value) => {
    const textures = await service()
    await sinkConnected(textures)
    const querying = textures.capabilities()
    await answerCapabilities(value)
    await querying
    expect(native.close).toHaveBeenCalledExactlyOnceWith(native.connections[0]!.native)
    const next = textures.nativeSink()
    await answerCapabilities()
    expect(await next).toBe(native.connections[1]!.sink)
    expect(native.connect).toHaveBeenCalledTimes(2)
  })

  it('keeps the connection while Main reports the same endpoint', async () => {
    const textures = await service()
    await sinkConnected(textures)
    const querying = textures.capabilities()
    await answerCapabilities()
    await querying
    expect(await textures.nativeSink()).toBe(native.connections[0]!.sink)
    expect(native.close).not.toHaveBeenCalled()
    expect(operations()).toEqual(['capabilities', 'capabilities'])
  })
})

describe('native sink', () => {
  it('connects on the first request and returns that connection\'s sink until it is lost', async () => {
    const textures = await service()
    await sinkConnected(textures)
    expect(loadHop).toHaveBeenCalledExactlyOnceWith(hopPath)
    expect(native.connect).toHaveBeenCalledExactlyOnceWith('ai.deepseek.shared-texture.x', expect.any(Function))
    expect(await textures.nativeSink()).toBe(native.connections[0]!.sink)
    expect(operations()).toEqual(['capabilities'])
  })

  it('shares one connection attempt between overlapping first requests', async () => {
    const textures = await service()
    const first = textures.nativeSink()
    const second = textures.nativeSink()
    await answerCapabilities()
    expect(await first).toBe(await second)
    expect(operations()).toEqual(['capabilities'])
    expect(native.connect).toHaveBeenCalledOnce()
  })

  it('releases a connection the hop lost and reconnects for the next request', async () => {
    const textures = await service()
    await sinkConnected(textures)
    disconnect()
    expect(native.close).toHaveBeenCalledExactlyOnceWith(native.connections[0]!.native)
    // A repeated report changes nothing.
    disconnect()
    expect(native.close).toHaveBeenCalledOnce()
    const next = textures.nativeSink()
    await answerCapabilities()
    expect(await next).toBe(native.connections[1]!.sink)
    expect(operations()).toEqual(['capabilities', 'capabilities'])
    expect(native.connect.mock.calls[1]?.[0]).toBe('ai.deepseek.shared-texture.x')
  })

  it('refuses when Desktop reports textures unsupported or no hop or ingress, or the hop cannot connect', async () => {
    const textures = await service()
    for (const [value, message] of [
      [{ supported: false, reason: 'no-electron', pid: 77 }, 'unavailable: no-electron'],
      [{ supported: false, pid: 77 }, 'unavailable: unsupported'],
      [{ supported: true, pid: 77, ingress: { endpoint: 'x' } }, 'no shared-texture hop addon or ingress'],
      [{ supported: true, pid: 77, hop: { addon: hopPath } }, 'no shared-texture hop addon or ingress'],
      [{ ...capabilitiesValue, hop: { addon: join(fixtureDirectory, 'missing.node') } }, 'missing.node'],
    ] as const) {
      const refused = textures.nativeSink()
      await answerCapabilities(value)
      await expect(refused).rejects.toThrow(message)
    }
    native.connect.mockImplementationOnce(() => { throw new Error('endpoint is unavailable') })
    const refused = textures.nativeSink()
    await answerCapabilities()
    await expect(refused).rejects.toThrow('endpoint is unavailable')
    expect(native.connections).toEqual([])
  })

  it('closes the connection whose sink a claim took when that claim ends', async () => {
    const textures = await service()
    await sinkConnected(textures)
    textures.release()
    expect(native.close).toHaveBeenCalledExactlyOnceWith(native.connections[0]!.native)
  })

  it('keeps a connection whose sink no claim took, and the next claim reuses it', async () => {
    new plugin.SharedTexture(ctx, loadHop)
    await ctx.plugin(() => {}).await()
    const textures = ctx.get('sharedTexture')!
    const first = textures.claim()
    // The claim ends while its request connects, so the connection opens without the claim taking its sink.
    const pending = first.nativeSink(TIMEOUT_MS)
    await vi.waitFor(() => { expect(send).toHaveBeenCalledOnce() })
    first.release()
    await answerCapabilities()
    await expect(pending).rejects.toThrow('claim was released')
    expect(native.close).not.toHaveBeenCalled()
    const second = textures.claim()
    expect(await second.nativeSink(TIMEOUT_MS)).toBe(native.connections[0]!.sink)
    expect(native.connect).toHaveBeenCalledOnce()
    second.release()
  })

  it('leaves a newer connection open when the connection whose sink the claim took is already lost', async () => {
    new plugin.SharedTexture(ctx, loadHop)
    await ctx.plugin(() => {}).await()
    const textures = ctx.get('sharedTexture')!
    const first = textures.claim()
    const sinking = first.nativeSink(TIMEOUT_MS)
    await answerCapabilities()
    await sinking
    disconnect()
    const reconnecting = first.nativeSink(TIMEOUT_MS)
    await vi.waitFor(() => { expect(send).toHaveBeenCalledTimes(2) })
    first.release()
    await answerCapabilities()
    await expect(reconnecting).rejects.toThrow('claim was released')
    expect(native.connect).toHaveBeenCalledTimes(2)
    expect(native.close.mock.calls).toEqual([[native.connections[0]!.native]])
    const second = textures.claim()
    expect(await second.nativeSink(TIMEOUT_MS)).toBe(native.connections[1]!.sink)
    second.release()
  })
})

describe('adapter LUID', () => {
  beforeEach(() => { setPlatform('win32') })

  it.each(['darwin', 'linux'] as const)('returns null on %s without asking Desktop or connecting', async (value) => {
    setPlatform(value)
    const textures = await service()
    await expect(textures.adapterLuid()).resolves.toBeNull()
    expect(send).not.toHaveBeenCalled()
    expect(native.connect).not.toHaveBeenCalled()
  })

  it('returns the adapter Main reads, or null, without opening the native connection', async () => {
    const textures = await service()
    const reading = textures.adapterLuid()
    await vi.waitFor(() => { expect(send).toHaveBeenCalledOnce() })
    expect(sent()).toEqual([{ type: SHARED_TEXTURE_MESSAGE, requestId: 1, request: { op: 'adapter-luid', timeoutMs: TIMEOUT_MS } }])
    reply(1, { value: 'ffffffff:1a2b' })
    await expect(reading).resolves.toBe('ffffffff:1a2b')
    const none = textures.adapterLuid()
    reply(2, { value: null })
    await expect(none).resolves.toBeNull()
    expect(native.connect).not.toHaveBeenCalled()
    expect(operations()).toEqual(['adapter-luid', 'adapter-luid'])
  })

  it('rejects a reading that is not an adapter LUID', async () => {
    const textures = await service()
    for (const value of ['', '0', '0:', ':1', '0:1:2', '0:123456789', 'A:1', ' 0:1', 0, {}, []]) {
      const malformed = textures.adapterLuid()
      expect(sent().at(-1)?.request).toEqual({ op: 'adapter-luid', timeoutMs: TIMEOUT_MS })
      reply(sent().at(-1)!.requestId, { value })
      await expect(malformed).rejects.toThrow('Invalid Desktop shared-texture adapter')
    }
  })

  it('rejects with Desktop\'s reason when Desktop does not present shared textures', async () => {
    const textures = await service()
    const reading = textures.adapterLuid()
    await vi.waitFor(() => { expect(send).toHaveBeenCalledOnce() })
    reply(1, { error: 'Desktop shared textures are unavailable: gpu-compositing-disabled' })
    await expect(reading).rejects.toThrow('unavailable: gpu-compositing-disabled')
    expect(native.connect).not.toHaveBeenCalled()
  })

  it('times out without waiting for Desktop, and ignores the reply that arrives later', async () => {
    vi.useFakeTimers()
    const textures = await service(100)
    const reading = textures.adapterLuid()
    const failure = expect(reading).rejects.toThrow('timed out')
    await vi.waitFor(() => { expect(send).toHaveBeenCalledOnce() })
    await vi.advanceTimersByTimeAsync(100)
    await failure
    reply(1, { value: '0:1' })
    expect(vi.getTimerCount()).toBe(0)
    const next = textures.adapterLuid()
    reply(2, { value: '0:2' })
    await expect(next).resolves.toBe('0:2')
  })
})

describe('channel loss', () => {
  it.each([
    ['the channel disconnects', () => { process.emit('disconnect') }],
    ['Main sends a malformed reply', () => { receive({ type: SHARED_TEXTURE_MESSAGE, requestId: 3, error: 42 }) }],
    ['Main sends a reply without a request number', () => { receive({ type: SHARED_TEXTURE_MESSAGE }) }],
    ['the service scope is disposed', () => { void ctx.fiber.dispose() }],
  ] as const)('rejects pending requests and closes the connection when %s', async (_case, lose) => {
    const textures = await service()
    await sinkConnected(textures)
    const pending = textures.capabilities()
    const rejection = expect(pending).rejects.toThrow('disconnected')
    await vi.waitFor(() => { expect(send).toHaveBeenCalledTimes(2) })
    lose()
    await rejection
    expect(native.close).toHaveBeenCalledOnce()
    await expect(textures.nativeSink()).rejects.toThrow(_case.includes('scope') ? 'claim was released' : 'disconnected')
    expect(native.connect).toHaveBeenCalledOnce()
  })

  it('ignores unrelated channel traffic and rejects pending work on disposal', async () => {
    vi.useFakeTimers()
    const textures = await service(100)
    receive({ type: 'update-tasks', requestId: 1, active: false })
    const first = textures.capabilities()
    await vi.waitFor(() => { expect(send).toHaveBeenCalledOnce() })
    for (const message of [null, 1, {}, { type: 'other' }, { type: 'shutdown' }]) receive(message)
    reply(1, { value: capabilitiesValue })
    await expect(first).resolves.toStrictEqual({ supported: true })
    const second = textures.capabilities()
    const rejection = expect(second).rejects.toThrow('disconnected')
    await ctx.fiber.dispose()
    await rejection
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['reply-error', 'timeout', 'send-error'] as const)(
    'rejects one request after %s and contains unrelated or late replies', async (failure) => {
      vi.useFakeTimers()
      const textures = await service(100)
      if (failure === 'send-error') send.mockImplementationOnce((_message, callback) => { callback(new Error('send failed')); return false })
      const rejected = expect(textures.capabilities()).rejects.toThrow()
      await vi.waitFor(() => { expect(send).toHaveBeenCalledOnce() })
      reply(999, { error: 'late error' })
      reply(999, { value: null })
      if (failure === 'reply-error') reply(1, { error: 'native failed' })
      else if (failure === 'timeout') await vi.advanceTimersByTimeAsync(100)
      await rejected
      reply(1, { value: capabilitiesValue })
      expect(vi.getTimerCount()).toBe(0)
      const next = textures.capabilities()
      reply(2, { value: capabilitiesValue })
      await expect(next).resolves.toStrictEqual({ supported: true })
    },
  )

  it.each(['connected', 'send'] as const)('refuses requests when process.%s is unavailable', async (field) => {
    const textures = await service()
    if (field === 'connected') channel.connected = false
    else channel.send = undefined
    await expect(textures.capabilities()).rejects.toThrow('unavailable')
    expect(send).not.toHaveBeenCalled()
  })
})

describe('claim', () => {
  it('grants one claim at a time; a released claim rejects its operations', async () => {
    new plugin.SharedTexture(ctx, loadHop)
    await ctx.plugin(() => {}).await()
    const textures = ctx.get('sharedTexture')!
    const first = textures.claim()
    expect(() => textures.claim()).toThrow('already claimed')
    first.release()
    first.release()
    await expect(first.capabilities(TIMEOUT_MS)).rejects.toThrow('claim was released')
    await expect(first.nativeSink(TIMEOUT_MS)).rejects.toThrow('claim was released')
    await expect(first.adapterLuid(TIMEOUT_MS)).rejects.toThrow('claim was released')
    const second = textures.claim()
    // Releasing an earlier claim does not free its successor's.
    first.release()
    expect(() => textures.claim()).toThrow('already claimed')
    second.release()
  })

  it('ends a claim with the scope that took it, including a claim taken inside an effect of that scope', async () => {
    new plugin.SharedTexture(ctx, loadHop)
    await ctx.plugin(() => {}).await()
    const textures = ctx.get('sharedTexture')!
    // A plugin that claims and never releases loses the claim when it is unloaded.
    let direct: Claim | undefined
    const owner = ctx.plugin({ inject: ['sharedTexture'], apply: (scope: Context) => { direct = scope.sharedTexture.claim() } })
    await owner.await()
    expect(() => textures.claim()).toThrow('already claimed')
    await owner.dispose()
    await expect(direct!.capabilities(TIMEOUT_MS)).rejects.toThrow('claim was released')
    // Frame forwarding claims inside an effect of the scope that injected the service.
    let nested: Claim | undefined
    const forwarding = ctx.inject(['sharedTexture'], (scope) => {
      scope.effect(() => { nested = scope.sharedTexture.claim(); return () => {} })
    })
    await forwarding.await()
    expect(() => textures.claim()).toThrow('already claimed')
    await forwarding.dispose()
    await expect(nested!.adapterLuid(TIMEOUT_MS)).rejects.toThrow('claim was released')
    textures.claim().release()
  })

  it('releasing a claim before its scope is disposed does not end the next holder\'s claim', async () => {
    new plugin.SharedTexture(ctx, loadHop)
    await ctx.plugin(() => {}).await()
    const textures = ctx.get('sharedTexture')!
    let first: Claim | undefined
    const owner = ctx.plugin({ inject: ['sharedTexture'], apply: (scope: Context) => { first = scope.sharedTexture.claim() } })
    await owner.await()
    first!.release()
    const second = textures.claim()
    await owner.dispose()
    first!.release()
    expect(() => textures.claim()).toThrow('already claimed')
    second.release()
    textures.claim().release()
  })

  it('a claim cannot be taken for a disposed scope', async () => {
    new plugin.SharedTexture(ctx, loadHop)
    await ctx.plugin(() => {}).await()
    let stale: Context['sharedTexture'] | undefined
    const owner = ctx.plugin({ inject: ['sharedTexture'], apply: (scope: Context) => { stale = scope.sharedTexture } })
    await owner.await()
    await owner.dispose()
    expect(() => stale!.claim()).toThrow()
    ctx.get('sharedTexture')!.claim().release()
  })
})

describe('hop addon', () => {
  it('registers the service through the plugin entry and loads the hop only from the path Main names', async () => {
    await ctx.plugin(plugin).await()
    expect(ctx.get('sharedTexture')).toBeDefined()
    expect(() => plugin.loadSharedTextureHop(join(fixtureDirectory, 'missing.node'))).toThrow()
    expect(() => plugin.loadSharedTextureHop(undefined)).toThrow('no shared-texture hop addon')
  })

  it('closes each connection once, whether the service closes it or the hop loses it', () => {
    const hop = plugin.loadSharedTextureHop(hopPath)
    const onDisconnect = vi.fn()
    const connection = hop.connect('endpoint', onDisconnect)
    connection.close()
    connection.close()
    disconnect()
    expect(native.close).toHaveBeenCalledOnce()
    expect(onDisconnect).not.toHaveBeenCalled()
    // A connection the hop loses reports it once and is released once.
    const lost = hop.connect('endpoint', onDisconnect)
    disconnect()
    disconnect()
    lost.close()
    expect(onDisconnect).toHaveBeenCalledOnce()
    expect(native.close).toHaveBeenCalledTimes(2)
  })
})
