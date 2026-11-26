/**
 * Main admits frames from the native ingress, presents them to the product frame, and answers each admitted frame on
 * the ingress with one delivery reply followed by one settlement reply; a refused frame gets one reply that says Main
 * kept no reference.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SharedTextureIngressBindings, SharedTextureIngressEvent, SharedTextureIngressReply } from '../src/shared-texture/ingress.ts'
import type { SharedTextureMainCapabilities } from '@deepseek-ai/dsh-desktop-host/types'

const f = vi.hoisted(() => ({
  ownerAvailable: true, destroyed: false, rendererDestroyed: false,
  /** Electron's `gpu_compositing` feature status. */
  gpuCompositing: 'enabled',
  /** Electron's callback for Main's own import reference. */
  mainReleased: undefined as (() => void) | undefined,
  imported: {
    release: vi.fn((callback?: () => void) => { f.mainReleased = callback }),
    setReleaseSyncToken: vi.fn<(token: Electron.SharedTextureSyncToken) => void>(),
    startTransferSharedTexture: vi.fn(() => ({ transfer: 'transfer-data' })),
  },
  importTexture: vi.fn<(info: Electron.SharedTextureImportTextureInfo) => void>(),
  send: vi.fn<(channel: string, message: unknown) => void>(),
  probe: vi.fn<(timeoutMs: number, signal: AbortSignal) => Promise<{ ntHandle: Buffer; release(): void } | null>>(async () => null),
}))
vi.mock('electron', () => ({
  app: { getGPUFeatureStatus: () => ({ gpu_compositing: f.gpuCompositing }) },
  sharedTexture: {
    subtle: {
      importSharedTexture: (info: Electron.SharedTextureImportTextureInfo) => {
        f.importTexture(info)
        return f.imported
      },
    },
  },
}))
vi.mock('../src/shared-texture/probe.ts', () => ({ probeSharedTexture: f.probe }))
import { DESKTOP_IPC } from '../src/ipc.ts'
import { loadSharedTextureIngressBindings } from '../src/shared-texture/ingress.ts'
import { DesktopSharedTexturePresenter } from '../src/shared-texture/presenter.ts'
import { createDesktopSharedTextures } from '../src/shared-texture/main.ts'

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
function setPlatform(value: NodeJS.Platform): void { Object.defineProperty(process, 'platform', { value, configurable: true }) }

let presenter: DesktopSharedTexturePresenter
let ingressEvents: ((event: SharedTextureIngressEvent) => void) | undefined
let ingressPeer: number | undefined
let openFailure: Error | undefined
let loadFailure: Error | undefined
let replies: [number, SharedTextureIngressReply][]
const ingressClose = vi.fn(async () => {})
const releaseHandle = vi.fn<(handle: Buffer) => void>()
const adapterLuid = vi.fn<(handle: Buffer) => string | null>(() => '0:1234')
const openIngress = vi.fn<SharedTextureIngressBindings['open']>((peerPid, onEvent) => {
  if (openFailure !== undefined) throw openFailure
  ingressPeer = peerPid
  ingressEvents = onEvent
  return {
    endpoint: 'ai.deepseek.shared-texture.test',
    reply: (requestId, reply) => { replies.push([requestId, reply]) },
    close: ingressClose,
  }
})
const bindings: SharedTextureIngressBindings = { open: openIngress, release: releaseHandle, adapterLuid }
const host = { pid: 4321 }
const otherHost = { pid: 9999 }
const surface = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8])
const secondSurface = Buffer.from([8, 7, 6, 5, 4, 3, 2, 1])

beforeEach(() => {
  vi.clearAllMocks()
  setPlatform('darwin')
  f.ownerAvailable = true; f.destroyed = false; f.rendererDestroyed = false; f.mainReleased = undefined; f.gpuCompositing = 'enabled'
  ingressEvents = undefined; ingressPeer = undefined; openFailure = undefined; loadFailure = undefined
  replies = []
  const mainFrame = { send: f.send } as Partial<Electron.WebFrameMain> as Electron.WebFrameMain
  const window = { isDestroyed: () => f.destroyed, webContents: { isDestroyed: () => f.rendererDestroyed, mainFrame } }
  presenter = new DesktopSharedTexturePresenter(() => f.ownerAvailable ? window : undefined, '/app/lib/native/shared-texture-hop.node', () => {
    if (loadFailure !== undefined) throw loadFailure
    return bindings
  })
})
afterEach(async () => {
  try {
    await presenter.dispose()
    if (vi.isFakeTimers()) expect(vi.getTimerCount()).toBe(0)
  } finally { vi.useRealTimers(); Object.defineProperty(process, 'platform', platform) }
})

const capabilities = (from = host) => presenter.request({ op: 'capabilities' }, from) as Promise<SharedTextureMainCapabilities>
/** Deliver one frame event from the Host, as the ingress does on the JavaScript thread. */
function frame(requestId: number, overrides: Partial<Extract<SharedTextureIngressEvent, { type: 'frame' }>> = {}): void {
  ingressEvents!({
    type: 'frame', requestId, handle: surface, width: 4, height: 2, pixelFormat: 'bgra',
    metadata: '{"viewId":"view","requestId":"r"}', ...overrides,
  })
}
function receipt(index = -1): number {
  return (f.send.mock.calls.at(index)![1] as { id: number }).id
}
/** Replies are queued behind delivery, so the test waits for the reply count it expects. */
async function repliesFor(count: number): Promise<[number, SharedTextureIngressReply][]> {
  await vi.waitFor(() => { expect(replies).toHaveLength(count) })
  return replies
}
const delivered = { kind: 'delivered' } as const
const released = { kind: 'released' } as const
const invalidated = { kind: 'invalidated' } as const
const failed = (error: string, referenceKept: boolean) => ({ kind: 'failed', error, referenceKept }) as const

describe('capabilities', () => {
  it.each(['darwin', 'win32'] as const)('opens one ingress for the requesting %s Host and names the hop addon and endpoint', async (value) => {
    setPlatform(value)
    expect(await capabilities()).toEqual({
      supported: true, pid: process.pid, hop: { addon: '/app/lib/native/shared-texture-hop.node' },
      ingress: { endpoint: 'ai.deepseek.shared-texture.test' },
    })
    expect(ingressPeer).toBe(4321)
    await capabilities()
    expect(openIngress).toHaveBeenCalledOnce()
  })
  it('replaces the ingress when another Host process asks', async () => {
    await capabilities()
    await capabilities(otherHost)
    expect(ingressClose).toHaveBeenCalledOnce()
    expect(ingressPeer).toBe(9999)
  })
  it('keeps the ingress closed when disposal interrupts endpoint replacement', async () => {
    await capabilities()
    const closing = Promise.withResolvers<undefined>()
    ingressClose.mockReturnValueOnce(closing.promise)
    const replacing = capabilities(otherHost)
    const disposal = presenter.dispose()
    closing.resolve(undefined)
    await expect(replacing).rejects.toThrow('reset during ingress replacement')
    await disposal
    expect(openIngress).toHaveBeenCalledOnce()
  })
  it('reports other platforms as unsupported without an ingress', async () => {
    setPlatform('linux')
    expect(await capabilities()).toEqual({ supported: false, reason: 'unsupported-platform', pid: process.pid })
    expect(openIngress).not.toHaveBeenCalled()
  })
  it('reports a missing or failing ingress addon as a reason instead of throwing', async () => {
    loadFailure = new Error('no addon')
    expect(await capabilities()).toMatchObject({ supported: false, reason: 'ingress-unavailable: no addon' })
    openFailure = new Error('bootstrap denied')
    const fresh = new DesktopSharedTexturePresenter(() => undefined, '/app/lib/native/shared-texture-hop.node', () => bindings)
    expect(await fresh.request({ op: 'capabilities' }, host)).toMatchObject({ supported: false, reason: 'ingress-unavailable: bootstrap denied' })
  })
  it('reports textures unsupported while Chromium composites in software, and supported again once it does not', async () => {
    for (const value of ['darwin', 'win32'] as const) {
      setPlatform(value)
      f.gpuCompositing = 'disabled_software'
      expect(await capabilities()).toEqual({ supported: false, reason: 'gpu-compositing-disabled', pid: process.pid })
      f.gpuCompositing = 'enabled_on'
      expect(await capabilities()).toMatchObject({ supported: true })
    }
  })
})

describe('frames', () => {
  it.each([
    ['darwin', { ioSurface: surface }],
    ['win32', { ntHandle: surface }],
  ] as const)('presents a %s frame, replies delivered then released, and releases the handle once at settlement', async (value, handle) => {
    setPlatform(value)
    await capabilities()
    frame(7)
    expect(f.importTexture.mock.calls[0]?.[0]).toMatchObject({ handle, pixelFormat: 'bgra', codedSize: { width: 4, height: 2 } })
    expect(f.send).toHaveBeenCalledWith(DESKTOP_IPC.sharedTexture,
      { id: receipt(), transfer: { transfer: 'transfer-data' }, metadata: '{"viewId":"view","requestId":"r"}' })
    presenter.rendererImported(receipt(), { syncToken: 'created' })
    expect(await repliesFor(1)).toEqual([[7, delivered]])
    expect(f.imported.setReleaseSyncToken).toHaveBeenCalledExactlyOnceWith({ syncToken: 'created' })
    f.mainReleased!()
    presenter.rendererReleased(-1)
    presenter.rendererReleased(receipt())
    presenter.rendererReleased(receipt())
    expect(await repliesFor(2)).toEqual([[7, delivered], [7, released]])
    expect(releaseHandle).toHaveBeenCalledExactlyOnceWith(surface)
    // A released frame is not invalidated by a later cleanup, and it no longer counts against the limit.
    await presenter.reset()
    frame(8)
    expect(f.importTexture).toHaveBeenCalledTimes(2)
    expect(replies).toHaveLength(2)
  })
  it('forwards the metadata text unparsed, so the product preload decides what it means', async () => {
    await capabilities()
    frame(1, { metadata: '' })
    frame(2, { metadata: '{' })
    expect(f.send.mock.calls.map(([, message]) => message)).toMatchObject([{ metadata: '' }, { metadata: '{' }])
    expect(replies).toEqual([])
  })
  it.each([
    ['no product window', () => { f.ownerAvailable = false; frame(2) }, 'window is unavailable'],
    ['a destroyed product window', () => { f.destroyed = true; frame(2) }, 'window is unavailable'],
    ['a destroyed product renderer', () => { f.rendererDestroyed = true; frame(2) }, 'window is unavailable'],
    ['a cleanup in progress', () => { void presenter.reset(); frame(2) }, 'Shared textures are closing'],
  ] as const)('refuses a frame with %s, releasing its handle and keeping no reference', async (_case, act, message) => {
    await capabilities()
    act()
    const [, refusal] = replies.find(([requestId]) => requestId === 2) ?? []
    expect(refusal).toMatchObject({ kind: 'failed', referenceKept: false })
    expect(refusal?.kind === 'failed' ? refusal.error : undefined).toContain(message)
    expect(releaseHandle.mock.calls.filter(([handle]) => handle === surface)).toHaveLength(1)
    expect(f.importTexture.mock.calls.filter(([info]) => info.handle.ioSurface === surface)).toHaveLength(0)
  })
  it('refuses the 129th unsettled frame and admits another once one settles', async () => {
    await capabilities()
    for (let index = 1; index <= 128; index++) frame(index)
    frame(129, { handle: secondSurface })
    expect(replies).toEqual([[129, failed('Shared-texture presentation limit reached', false)]])
    expect(releaseHandle).toHaveBeenCalledExactlyOnceWith(secondSurface)
    expect(f.importTexture).toHaveBeenCalledTimes(128)
    presenter.rendererImported(receipt(0), { error: 'GPU is not available' })
    f.mainReleased!()
    await repliesFor(3)
    frame(130)
    expect(f.importTexture).toHaveBeenCalledTimes(129)
    // The refused frame never counted, so the admitted one fills the limit again.
    frame(131, { handle: secondSurface })
    expect(replies.at(-1)).toEqual([131, failed('Shared-texture presentation limit reached', false)])
  })
  it('refuses an Electron import failure with one reply that names it, since Main kept no reference', async () => {
    await capabilities()
    f.importTexture.mockImplementationOnce(() => { throw new Error('Invalid ioSurface value') })
    frame(1)
    expect(replies).toEqual([[1, failed('Invalid ioSurface value', false)]])
    expect(releaseHandle).toHaveBeenCalledExactlyOnceWith(surface)
    frame(2)
    expect(f.importTexture).toHaveBeenCalledTimes(2)
  })
  it.each([
    ['later', false],
    ['synchronously', true],
  ] as const)('fails delivery on a send failure and settles once Electron releases Main\'s reference %s', async (_case, synchronous) => {
    await capabilities()
    f.send.mockImplementationOnce(() => { throw new Error('Render frame was disposed') })
    if (synchronous) f.imported.release.mockImplementationOnce(callback => callback?.())
    frame(1)
    expect(await repliesFor(synchronous ? 2 : 1)).toEqual([[1, failed('Render frame was disposed', true)], ...synchronous ? [[1, released]] : []])
    if (!synchronous) f.mainReleased!()
    expect(await repliesFor(2)).toEqual([[1, failed('Render frame was disposed', true)], [1, released]])
    expect(releaseHandle).toHaveBeenCalledExactlyOnceWith(surface)
  })
  it('fails delivery when the renderer cannot import, then releases once Main\'s reference is gone', async () => {
    setPlatform('win32')
    await capabilities()
    frame(1)
    presenter.rendererImported(receipt(), { error: 'GPU is not available' })
    presenter.rendererImported(receipt(), { syncToken: 'ignored' })
    expect(await repliesFor(1)).toEqual([[1, failed('The product renderer could not import the shared texture: GPU is not available', true)]])
    expect(f.imported.setReleaseSyncToken).not.toHaveBeenCalled()
    f.mainReleased!()
    expect(await repliesFor(2)).toEqual([[1, failed('The product renderer could not import the shared texture: GPU is not available', true)], [1, released]])
    frame(2)
    presenter.rendererImported(receipt(), 42)
    expect((await repliesFor(3))[2]).toEqual([2, failed('The product renderer could not import the shared texture: Invalid renderer import result', true)])
  })
  it('invalidates a frame the renderer imported without its GPU token', async () => {
    await capabilities()
    frame(1)
    presenter.rendererImported(receipt(), { error: 'GPU sync lost', invalidated: true })
    expect(await repliesFor(2)).toEqual([[1, failed('GPU sync lost', true)], [1, invalidated]])
    expect(releaseHandle).toHaveBeenCalledExactlyOnceWith(surface)
  })
  it('sends the delivery reply before the settlement when Electron settles the texture first', async () => {
    await capabilities()
    frame(1)
    // The renderer's release can arrive first, and Electron may release Main's reference synchronously on import.
    presenter.rendererReleased(receipt())
    f.imported.release.mockImplementationOnce(callback => callback?.())
    presenter.rendererImported(receipt(), { syncToken: 'created' })
    expect(await repliesFor(2)).toEqual([[1, delivered], [1, released]])
  })
  it('keeps Main\'s import for a busy renderer until it reports its own reference, however long that takes', async () => {
    vi.useFakeTimers()
    setPlatform('win32')
    await capabilities()
    frame(1)
    await vi.advanceTimersByTimeAsync(5000)
    expect(replies).toEqual([])
    expect(f.imported.release).not.toHaveBeenCalled()
    presenter.rendererImported(receipt(), { syncToken: 'late' })
    await vi.advanceTimersByTimeAsync(0)
    expect(replies).toEqual([[1, delivered]])
    expect(f.imported.release).toHaveBeenCalledOnce()
  })
  it('reset invalidates frames sent to the document, whether or not the renderer imported them, and admits later frames', async () => {
    await capabilities()
    frame(1)
    presenter.rendererImported(receipt(), { syncToken: 'created' })
    f.mainReleased!()
    frame(2, { handle: secondSurface })
    await repliesFor(1)
    const resetting = presenter.reset()
    await expect(capabilities()).rejects.toThrow('Shared textures are closing')
    await resetting
    expect(await repliesFor(4)).toEqual([
      [1, delivered], [1, invalidated],
      [2, failed('The product document closed before importing the shared texture', true)], [2, invalidated],
    ])
    expect(releaseHandle.mock.calls).toEqual([[surface], [secondSurface]])
    // Main still drops its own reference to the texture the renderer never imported, and stale receipts change nothing.
    expect(f.imported.release).toHaveBeenCalledTimes(2)
    const stale = receipt()
    f.mainReleased!()
    presenter.rendererImported(stale, { syncToken: 'late' })
    presenter.rendererReleased(receipt(0))
    expect(f.imported.setReleaseSyncToken).toHaveBeenCalledOnce()
    expect(openIngress).toHaveBeenCalledOnce()
    expect(ingressClose).not.toHaveBeenCalled()
    frame(3)
    presenter.rendererImported(receipt(), { syncToken: 'current' })
    expect((await repliesFor(5))[4]).toEqual([3, delivered])
  })
  it('dispose closes the ingress after abandoning sent frames; a frame the ingress still delivers is released without a reply', async () => {
    await capabilities()
    frame(1)
    presenter.rendererImported(receipt(), { syncToken: 'created' })
    await repliesFor(1)
    const events = ingressEvents!
    // A dispose that starts during a reset waits for it.
    await Promise.all([presenter.reset(), presenter.dispose()])
    expect(ingressClose).toHaveBeenCalledOnce()
    expect(releaseHandle).toHaveBeenCalledExactlyOnceWith(surface)
    events({ type: 'frame', requestId: 2, handle: secondSurface, width: 4, height: 2, pixelFormat: 'bgra', metadata: '' })
    expect(releaseHandle).toHaveBeenLastCalledWith(secondSurface)
    // The reset reported the invalidation before the ingress closed.
    await vi.waitFor(() => { expect(replies).toEqual([[1, delivered], [1, invalidated]]) })
    await capabilities()
    expect(openIngress).toHaveBeenCalledTimes(2)
  })
  it('closes a failed ingress, drops replies for its frames, and reopens on the next capability query', async () => {
    await capabilities()
    frame(1)
    ingressEvents!({ type: 'error', text: 'intruder' })
    await vi.waitFor(() => { expect(ingressClose).toHaveBeenCalledOnce() })
    // Electron still settles the sent texture, and Main releases its handle.
    presenter.rendererImported(receipt(), { error: 'GPU is not available' })
    f.mainReleased!()
    expect(releaseHandle).toHaveBeenCalledExactlyOnceWith(surface)
    await capabilities()
    expect(openIngress).toHaveBeenCalledTimes(2)
    expect(ingressClose).toHaveBeenCalledOnce()
    expect(replies).toEqual([])
  })
})

describe('adapter LUID', () => {
  const probeHandle = Buffer.alloc(8, 0xab)
  const texture = (release = vi.fn()) => ({ ntHandle: probeHandle, release })
  beforeEach(() => {
    setPlatform('win32')
    f.probe.mockImplementation(async () => null)
    adapterLuid.mockImplementation(() => '0:1234')
  })
  const adapter = (timeoutMs = 1000) => presenter.request({ op: 'adapter-luid', timeoutMs }, host) as Promise<string | null>

  it('reads the adapter of one compositor texture, releases the texture at once, and keeps the answer for its GPU process', async () => {
    const release = vi.fn()
    f.probe.mockResolvedValue(texture(release))
    // No ingress is needed: Main reads its own texture.
    expect(await adapter(2500)).toBe('0:1234')
    expect(f.probe).toHaveBeenCalledExactlyOnceWith(2500, expect.any(AbortSignal))
    expect(adapterLuid).toHaveBeenCalledExactlyOnceWith(probeHandle)
    expect(release).toHaveBeenCalledOnce()
    expect(openIngress).not.toHaveBeenCalled()
    // Document cleanups keep the answer; a GPU process exit and Host teardown forget it.
    await presenter.reset()
    expect(await adapter()).toBe('0:1234')
    expect(f.probe).toHaveBeenCalledOnce()
    await presenter.reset({ gpuProcessGone: true })
    adapterLuid.mockReturnValue('0:5678')
    expect(await adapter()).toBe('0:5678')
    expect(await adapter()).toBe('0:5678')
    expect(f.probe).toHaveBeenCalledTimes(2)
    await presenter.dispose()
    expect(await adapter()).toBe('0:5678')
    expect(f.probe).toHaveBeenCalledTimes(3)
    expect(release).toHaveBeenCalledTimes(3)
  })
  it('shares one probe between concurrent queries', async () => {
    const exported = Promise.withResolvers<ReturnType<typeof texture>>()
    f.probe.mockReturnValueOnce(exported.promise)
    const queries = [adapter(), adapter(), adapter()]
    exported.resolve(texture())
    await expect(Promise.all(queries)).resolves.toEqual(['0:1234', '0:1234', '0:1234'])
    expect(f.probe).toHaveBeenCalledOnce()
    expect(adapterLuid).toHaveBeenCalledOnce()
  })
  it('keeps no answer from a probe that exports no texture, reads no adapter, or fails, so the next query probes again', async () => {
    f.probe.mockResolvedValueOnce(null)
    expect(await adapter()).toBeNull()
    const unread = vi.fn()
    f.probe.mockResolvedValueOnce(texture(unread))
    adapterLuid.mockReturnValueOnce(null)
    expect(await adapter()).toBeNull()
    expect(unread).toHaveBeenCalledOnce()
    const failed = vi.fn()
    f.probe.mockResolvedValueOnce(texture(failed))
    adapterLuid.mockImplementationOnce(() => { throw new TypeError('Expected a nonzero eight-byte texture handle') })
    await expect(adapter()).rejects.toThrow('Expected a nonzero eight-byte texture handle')
    expect(failed).toHaveBeenCalledOnce()
    f.probe.mockResolvedValueOnce(texture())
    expect(await adapter()).toBe('0:1234')
    expect(await adapter()).toBe('0:1234')
    expect(f.probe).toHaveBeenCalledTimes(4)
  })
  it('discards the answer of a probe that a GPU process exit overtook, and probes again for the new GPU process', async () => {
    const release = vi.fn()
    f.probe.mockImplementationOnce((_timeoutMs, signal) => new Promise((resolve) => {
      // The texture arrives although the cleanup cancelled the probe.
      signal.addEventListener('abort', () => { resolve(texture(release)) }, { once: true })
    }))
    const stale = adapter()
    const cleaning = presenter.reset({ gpuProcessGone: true })
    await expect(stale).resolves.toBeNull()
    await cleaning
    expect(release).toHaveBeenCalledOnce()
    adapterLuid.mockReturnValue('0:5678')
    f.probe.mockResolvedValue(texture())
    expect(await adapter()).toBe('0:5678')
    expect(await adapter()).toBe('0:5678')
    expect(f.probe).toHaveBeenCalledTimes(2)
  })
  it.each(['reset', 'dispose'] as const)('cancels a pending probe during %s without waiting for its deadline', async (cleanup) => {
    vi.useFakeTimers()
    const pending = Promise.withResolvers<null>()
    const started = Promise.withResolvers<AbortSignal>()
    f.probe.mockImplementationOnce((_timeoutMs, signal) => {
      signal.addEventListener('abort', () => { pending.resolve(null) }, { once: true })
      started.resolve(signal)
      return pending.promise
    })
    const queries = [adapter(), adapter()]
    const signal = await started.promise
    const cleaning = presenter[cleanup]()
    try {
      expect(signal.aborted).toBe(true)
      await expect(Promise.all(queries)).resolves.toEqual([null, null])
      await cleaning
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      // Release the fixture barrier even if cancellation regresses, so teardown never needs the probe deadline.
      pending.resolve(null)
      await Promise.allSettled([...queries, cleaning])
    }
  })
  it('returns null outside Windows without probing, and rejects while textures are unsupported', async () => {
    setPlatform('darwin')
    expect(await adapter()).toBeNull()
    expect(f.probe).not.toHaveBeenCalled()
    setPlatform('win32')
    f.probe.mockResolvedValue(texture())
    expect(await adapter()).toBe('0:1234')
    // Support is read on every query, so a kept answer does not outlive software compositing.
    f.gpuCompositing = 'disabled_software'
    await expect(adapter()).rejects.toThrow('Desktop shared textures are unavailable: gpu-compositing-disabled')
    expect(f.probe).toHaveBeenCalledOnce()
  })
  it('rejects when the ingress addon cannot load', async () => {
    loadFailure = new Error('no addon')
    await expect(adapter()).rejects.toThrow('Desktop shared textures are unavailable: ingress-unavailable: no addon')
    expect(f.probe).not.toHaveBeenCalled()
  })
})

describe('ingress binding', () => {
  it('maps replies to the addon\'s reply kinds and passes the native object to every operation', () => {
    const directory = mkdtempSync(join(tmpdir(), 'dsh-shared-texture-ingress-'))
    try {
      const calls: unknown[][] = []
      const native = { native: true }
      const close = Promise.resolve()
      const fake = {
        open: (pid: number) => { calls.push(['open', pid]); return { native, endpoint: 'endpoint' } },
        reply: (...args: unknown[]) => { calls.push(['reply', ...args]) },
        release: (handle: Buffer) => { calls.push(['release', handle]) },
        close: (value: object) => { calls.push(['close', value]); return close },
        adapterLuid: (handle: Buffer) => { calls.push(['adapter', handle]); return '0:42' },
      }
      const key = '__dshSharedTextureIngressFixture'
      Object.assign(globalThis, { [key]: fake })
      const path = join(directory, 'ingress.cjs')
      writeFileSync(path, `module.exports = globalThis.${key}\n`)
      const loaded = loadSharedTextureIngressBindings(path)
      const ingress = loaded.open(4321, () => {})
      expect(ingress.endpoint).toBe('endpoint')
      ingress.reply(1, { kind: 'delivered' })
      ingress.reply(1, { kind: 'released' })
      ingress.reply(2, { kind: 'failed', error: 'kept', referenceKept: true })
      ingress.reply(2, { kind: 'invalidated' })
      ingress.reply(3, { kind: 'failed', error: 'dropped', referenceKept: false })
      expect(loaded.adapterLuid(surface)).toBe('0:42')
      loaded.release(surface)
      expect(ingress.close()).toBe(close)
      expect(ingress.close()).toBe(close)
      expect(calls).toEqual([
        ['open', 4321],
        ['reply', native, 1, 1, false, ''], ['reply', native, 1, 3, false, ''],
        ['reply', native, 2, 2, false, 'kept'], ['reply', native, 2, 4, false, ''],
        ['reply', native, 3, 2, true, 'dropped'],
        ['adapter', surface], ['release', surface], ['close', native],
      ])
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })
})

describe('Main entry', () => {
  it('answers Host requests on its channel from a presenter that loads its addons from the application directory', async () => {
    const textures = createDesktopSharedTextures(join('/missing-app'), () => undefined)
    const sent: unknown[] = []
    const fail = vi.fn()
    const receive = textures.channel.attach({
      pid: 4321,
      connected: true,
      send: (message, callback) => {
        sent.push(message)
        callback?.(null)
        return true
      },
      kill: () => true,
    }, { fail, stopping: () => false })
    expect(receive({ type: 'shared-texture', requestId: 1, request: { op: 'capabilities' } })).toBe(true)
    await vi.waitFor(() => { expect(sent).toHaveLength(1) })
    const [reply] = sent as { type: string; requestId: number; value: { supported: boolean; pid: number; reason: string } }[]
    expect(reply).toMatchObject({ type: 'shared-texture', requestId: 1, value: { supported: false, pid: process.pid } })
    expect(reply?.value.reason).toContain(join('/missing-app', 'lib', 'native'))
    expect(fail).not.toHaveBeenCalled()
    textures.rendererImported(-1, { syncToken: 'created' })
    textures.rendererReleased(-1)
    await textures.reset()
    await textures.dispose()
  })
})
