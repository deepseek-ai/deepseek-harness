/**
 * The built shared-texture hop and ingress addons exchange DSTX v3 requests and replies between two real processes:
 * a `main` peer that opens the ingress for the Host's process identifier and a `host` peer that connects the hop.
 * A probe addon built from `fixtures/shared-texture/texture-probe.cc` supplies real textures whose identity survives
 * the hop, drives the C sink from native threads, and forges malformed requests. Run `build:native` first; the suite
 * skips where the addons are absent. Frames carry their test label as metadata, the only Host-chosen field Main sees.
 */
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from 'vitest'
import { nativeBuildEnvironment } from '../scripts/native-package-builds.mjs'
import { sharedTextureHopAddonPath, sharedTextureIngressAddonPath } from '../src/shared-texture/ingress.ts'

/** Ingress addon exports (Electron Main). */
interface IngressAddon {
  open(peerPid: number, onEvent: (event: { type: string }) => void): { native: object; endpoint: string }
  close(native: object): Promise<void>
}
/** Hop addon exports (Desktop Host). */
interface HopAddon {
  connect(endpoint: string, onEvent: (event: { type: string }) => void): { native: object; sink: object }
  close(native: object): void
}

interface PeerEvent {
  type: string
  /** Main: the Host's request number of a `frame`. */
  requestId?: number
  /** Host: the fixture's key of the presented frame an event belongs to. */
  key?: number
  error?: string | null
  invalidated?: boolean
  tag?: number
  code?: number
  [key: string]: unknown
}
/** One frame the Host peer presented: its key and, when the sink refused it, the reason. */
interface Presented { key: number; error?: string }

const appDir = fileURLToPath(new URL('..', import.meta.url))
const ingressAddon = sharedTextureIngressAddonPath(appDir)
const hopAddon = sharedTextureHopAddonPath(appDir)
const nativeDir = fileURLToPath(new URL('../native/shared-texture/', import.meta.url))
const peerScript = fileURLToPath(new URL('./fixtures/shared-texture/peer.mjs', import.meta.url))
const INVALID_MESSAGE = 'Shared-texture ingress received an invalid message'
const supported = process.platform === 'darwin' || process.platform === 'win32'

/** One fixture process speaking JSON lines; every event it reported stays in `log`. */
class Peer {
  readonly log: PeerEvent[] = []
  readonly exited: Promise<number | null>
  private readonly waiters: { match: (event: PeerEvent) => boolean; resolve: (event: PeerEvent) => void }[] = []
  private readonly calls = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  private nextId = 1

  constructor(readonly role: 'main' | 'host', readonly child: ChildProcessWithoutNullStreams) {
    this.exited = new Promise((resolve) => { child.once('exit', (code) => { resolve(code) }) })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => { process.stderr.write(`[${role}] ${chunk}`) })
    createInterface({ input: child.stdout }).on('line', (line) => {
      const message = JSON.parse(line) as { id?: number; result?: unknown; error?: string; event?: PeerEvent }
      if (message.event !== undefined) {
        this.log.push(message.event)
        for (const [index, waiter] of this.waiters.entries()) {
          if (!waiter.match(message.event)) continue
          this.waiters.splice(index, 1)
          waiter.resolve(message.event)
          break
        }
        return
      }
      const call = this.calls.get(message.id!)
      this.calls.delete(message.id!)
      if (message.error !== undefined) call?.reject(new Error(message.error))
      else call?.resolve(message.result)
    })
  }

  get pid(): number { return this.child.pid! }

  call<T>(op: string, args: Record<string, unknown> = {}): Promise<T> {
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      this.calls.set(id, { resolve: (value) => { resolve(value as T) }, reject })
      this.child.stdin.write(`${JSON.stringify({ id, op, ...args })}\n`)
    })
  }

  /** The first logged event matching `match`, waiting for it when none has arrived. */
  event(match: (event: PeerEvent) => boolean, timeoutMs = 20_000): Promise<PeerEvent> {
    const found = this.log.find(match)
    if (found !== undefined) return Promise.resolve(found)
    return new Promise((resolve, reject) => {
      const waiter = { match, resolve }
      const timer = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(waiter), 1)
        reject(new Error(`${this.role}: no matching event within ${String(timeoutMs)} ms; log ${JSON.stringify(this.log)}`))
      }, timeoutMs)
      waiter.resolve = (event) => { clearTimeout(timer); resolve(event) }
      this.waiters.push(waiter)
    })
  }

  events(match: (event: PeerEvent) => boolean): PeerEvent[] { return this.log.filter(match) }

  /** End input, which exits the fixture, and wait for the exit; kill it when it does not exit. */
  async stop(): Promise<void> {
    if (this.child.exitCode === null && this.child.signalCode === null) {
      this.child.stdin.end()
      const timer = setTimeout(() => { this.child.kill() }, 10_000)
      await this.exited
      clearTimeout(timer)
    }
  }
}

const delivered = (key: number) => (event: PeerEvent) => event.type === 'delivered' && event.key === key
const settled = (key: number) => (event: PeerEvent) => event.type === 'settled' && event.key === key

/** With the default `wait: true`, the peer logs each native return code before replying to `present`. */
function expectReturnCode(host: Peer, { key }: Presented, code: 0 | 1 | 2): void {
  expect(host.events(event => event.key === key && event.type === 'returned')).toMatchObject([{ key, code }])
}

/** Main's `frame` event for the Host's `nth` request whose metadata is exactly `metadata`. */
function frameWith(main: Peer, metadata: string, nth = 0): Promise<PeerEvent> {
  let seen = 0
  return main.event(event => event.type === 'frame' && event.metadata === metadata && seen++ === nth)
}

/** Main's `frame` event for the Host's `nth` request labelled `label`. */
function frameOf(main: Peer, label: string, nth = 0): Promise<PeerEvent> {
  return frameWith(main, JSON.stringify(label), nth)
}

/** The labels of the frames Main received, in arrival order. */
function receivedLabels(main: Peer): unknown[] {
  return main.events(event => event.type === 'frame').map((event): unknown => JSON.parse(String(event.metadata)))
}

describe.skipIf(!supported || !existsSync(ingressAddon) || !existsSync(hopAddon))('built shared-texture hop and ingress', () => {
  let scratch = ''
  let probe = ''

  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'dsh-shared-texture-native-'))
    probe = join(scratch, 'texture-probe.node')
    const source = fileURLToPath(new URL('./fixtures/shared-texture/texture-probe.cc', import.meta.url))
    const environment = nativeBuildEnvironment(process.arch)
    const headers = environment.DSH_NODE_API_HEADERS ?? ''
    const run = (command: string, args: string[]) => {
      const result = spawnSync(command, args, { cwd: scratch, env: environment, encoding: 'utf8', timeout: 120_000 })
      expect(result.error).toBeUndefined()
      expect(result.signal).toBeNull()
      expect(result.status, result.stdout + result.stderr).toBe(0)
    }
    if (process.platform === 'win32') {
      run('lib.exe', ['/nologo', `/def:${join(headers, 'def', 'node_api.def')}`, '/name:node.exe', `/machine:${process.arch}`, `/out:${join(scratch, 'node.lib')}`])
      run('cl.exe', ['/nologo', '/LD', '/EHsc', '/MD', '/std:c++17', `/I${join(headers, 'include')}`, `/I${nativeDir}`, '/DNAPI_VERSION=8',
        '/DNODE_GYP_MODULE_NAME=texture_probe', `/Fo${scratch}\\`, source, join(nativeDir, 'win-delay-load.cc'),
        '/link', '/DELAYLOAD:node.exe', 'delayimp.lib', join(scratch, 'node.lib'), 'd3d11.lib', 'dxgi.lib',
        `/IMPLIB:${join(scratch, 'texture-probe.lib')}`, `/OUT:${probe}`])
    } else {
      run('clang++', ['-arch', process.arch === 'x64' ? 'x86_64' : 'arm64', '-std=c++17', `-I${join(headers, 'include')}`, `-I${nativeDir}`,
        '-DNAPI_VERSION=8', '-DNODE_GYP_MODULE_NAME=texture_probe', '-shared', '-undefined', 'dynamic_lookup', source,
        '-framework', 'IOSurface', '-framework', 'CoreFoundation', '-o', probe])
    }
  }, 180_000)
  afterAll(async () => { await rm(scratch, { recursive: true, force: true }) })

  async function startPeer(role: 'main' | 'host'): Promise<Peer> {
    const child = spawn(process.execPath, ['--expose-gc', peerScript, role, role === 'main' ? ingressAddon : hopAddon, probe], { stdio: 'pipe' })
    const peer = new Peer(role, child)
    onTestFinished(() => peer.stop())
    await peer.event(event => event.type === 'ready')
    return peer
  }

  /** A Main peer serving one Host peer that is connected and owns one texture. */
  async function startPair(options: { autoReply?: boolean } = {}) {
    const main = await startPeer('main')
    const host = await startPeer('host')
    const endpoint = await main.call<string>('open', { peerPid: host.pid, autoReply: options.autoReply ?? false })
    await host.call('connect', { endpoint })
    const tag = await host.call<number>('texture')
    return { main, host, endpoint, tag }
  }

  /** Present one frame the sink accepts. @returns Its key. */
  async function presentOne(host: Peer, tag: number, frame: Record<string, unknown>): Promise<number> {
    const [result] = await host.call<Presented[]>('present', { tag, frames: [frame] })
    expectReturnCode(host, result!, 0)
    expect(result!.error).toBeUndefined()
    return result!.key
  }

  /**
   * Present `count` frames labelled `<prefix>-<index>` that stay unsettled. Main receives them in batches below its
   * delivery capacity, so that none is rejected and settled early.
   * @returns Every frame the sink accepted, in order.
   */
  async function fill(main: Peer, host: Peer, tag: number, count: number, prefix: string): Promise<Presented[]> {
    const presented: Presented[] = []
    for (let start = 0; start < count; start += 30) {
      const end = Math.min(start + 30, count)
      presented.push(...await host.call<Presented[]>('present', {
        tag, frames: Array.from({ length: end - start }, (_, offset) => ({ label: `${prefix}-${String(start + offset)}` })),
      }))
      await frameOf(main, `${prefix}-${String(end - 1)}`)
    }
    for (const result of presented) expectReturnCode(host, result, 0)
    return presented
  }

  it('delivers a presentation with every field and returns each reply kind to the Host', async () => {
    const { main, host, tag } = await startPair()
    const metadata = JSON.stringify({ frame: 7, label: 'π' })
    const first = await presentOne(host, tag, { width: 640, height: 480, pixelFormat: 'rgba', metadata, timeoutMs: 5000 })
    const frame = await frameWith(main, metadata)
    const requestId = frame.requestId!
    expect(Number.isSafeInteger(requestId) && requestId >= 1).toBe(true)
    expect(frame).toEqual({ type: 'frame', requestId, width: 640, height: 480, pixelFormat: 'rgba', metadata, handleBytes: 8, handleTag: tag })
    await main.call('reply', { requestId, kind: 1 })
    expect(await host.event(delivered(first))).toEqual({ type: 'delivered', key: first, error: null })
    await main.call('reply', { requestId, kind: 3 })
    expect(await host.event(settled(first))).toEqual({ type: 'settled', key: first, invalidated: false })
    await main.call('release', { requestId })

    // Each further request exercises one reply sequence; an empty metadata text reaches Main unchanged.
    type Reply = { kind: number; noReferenceKept?: boolean; error?: string }
    const sequences: { replies: Reply[]; error: string | null; invalidated: boolean }[] = [
      { replies: [{ kind: 1 }, { kind: 4 }], error: null, invalidated: true },
      { replies: [{ kind: 2, error: 'renderer refused' }, { kind: 4 }], error: 'renderer refused', invalidated: true },
      { replies: [{ kind: 2, noReferenceKept: true, error: 'gone' }], error: 'gone', invalidated: false },
      { replies: [{ kind: 3 }], error: 'Desktop shared-texture request settled before delivery', invalidated: false },
    ]
    for (const [index, sequence] of sequences.entries()) {
      const key = await presentOne(host, tag, { metadata: '' })
      const next = await frameWith(main, '', index)
      expect(next).toMatchObject({ metadata: '', handleTag: tag })
      for (const reply of sequence.replies) await main.call('reply', { requestId: next.requestId, ...reply })
      expect(await host.event(settled(key))).toEqual({ type: 'settled', key, invalidated: sequence.invalidated })
      expect(host.events(delivered(key))).toEqual([{ type: 'delivered', key, error: sequence.error }])
      await main.call('release', { requestId: next.requestId })
    }
    expect(main.events(event => event.type === 'error')).toEqual([])
  })

  it('refuses what cannot leave the Host and settles outstanding requests when JavaScript closes the connection', async () => {
    const { main, host, tag } = await startPair()
    // The probe's own reference keeps the sink usable after JavaScript drops and collects the `sink` external.
    await host.call('dropSink')
    const accepted = await presentOne(host, tag, { label: 'native' })
    const frame = await frameOf(main, 'native')
    expect(frame).toMatchObject({ handleTag: tag, width: 64, height: 32 })
    await main.call('reply', { requestId: frame.requestId, kind: 1 })
    await main.call('reply', { requestId: frame.requestId, kind: 3 })
    expect(await host.event(settled(accepted))).toMatchObject({ invalidated: false })
    // An accepted request reports one delivery and then one settlement.
    expect(host.events(event => event.key === accepted).map(event => event.type)).toEqual(['returned', 'delivered', 'settled'])
    await main.call('release', { requestId: frame.requestId })

    // 128 unsettled requests fill the connection; the next is refused without a callback.
    const burst = await fill(main, host, tag, 128, 'burst')
    const [beyond] = await host.call<Presented[]>('present', { tag, frames: [{ label: 'beyond' }] })
    expectReturnCode(host, beyond!, 1)
    expect(beyond!.error).toBe('Shared-texture presentation limit reached')
    expect(host.events(event => event.key === beyond!.key).map(event => event.type)).toEqual(['returned'])
    // The refusal leaves the connection usable: once one request settles, the next one reaches Main.
    const oldest = (await frameOf(main, 'burst-0')).requestId
    await main.call('reply', { requestId: oldest, kind: 2, noReferenceKept: true })
    await main.call('release', { requestId: oldest })
    expect(await host.event(settled(burst[0]!.key))).toMatchObject({ invalidated: false })
    const resumed = await presentOne(host, tag, { label: 'resumed' })
    expect(await frameOf(main, 'resumed')).toMatchObject({ handleTag: tag })
    expect(host.events(event => event.type === 'disconnected')).toEqual([])

    // Closing settles every outstanding request as invalidated; later presents report the closed connection.
    await host.call('close')
    for (const key of [...burst.slice(1).map(result => result.key), resumed]) {
      await host.event(settled(key))
      expect(host.events(event => event.key === key && event.type !== 'returned')).toEqual([
        { type: 'delivered', key, error: 'Desktop shared-texture connection closed' },
        { type: 'settled', key, invalidated: true },
      ])
    }
    const [late] = await host.call<Presented[]>('present', { tag, frames: [{ label: 'after-close' }] })
    expectReturnCode(host, late!, 2)
    expect(late!.error).toBe('Desktop shared-texture connection is closed')
    expect(host.events(event => event.type === 'disconnected')).toEqual([])
  })

  it('reports sink ABI version 2, which a consumer built for another version refuses', async () => {
    const { host } = await startPair()
    await expect(host.call('checkSink', { version: 2 })).resolves.toBeNull()
    await expect(host.call('checkSink', { version: 1 })).rejects.toThrow('Unexpected sink ABI')
  })

  it('rejects frames beyond the delivery queue at once while Main JavaScript is blocked, then resumes', async () => {
    const { main, host, tag } = await startPair({ autoReply: true })
    // Main's JavaScript thread is busy before the burst is sent and stays busy until long after it ends.
    expect(await main.call('block', { ms: 4000 })).toBe('blocking')
    const labels = Array.from({ length: 40 }, (_, index) => `burst-${String(index)}`)
    const burst = await host.call<Presented[]>('present', { tag, frames: labels.map(label => ({ label })) })
    expect(burst.every(result => result.error === undefined)).toBe(true)
    const keys = burst.map(result => result.key)
    for (const key of keys.slice(32)) {
      expect(await host.event(settled(key), 3000)).toEqual({ type: 'settled', key, invalidated: false })
      expect(host.events(delivered(key))).toEqual([{ type: 'delivered', key, error: 'Shared-texture ingress queue is full' }])
    }
    // The rejections arrived while Main was still blocked.
    expect(main.events(event => event.type === 'unblocked')).toEqual([])
    await main.event(event => event.type === 'unblocked')
    for (const key of keys.slice(0, 32)) {
      expect(await host.event(settled(key))).toEqual({ type: 'settled', key, invalidated: false })
      expect(host.events(delivered(key))).toEqual([{ type: 'delivered', key, error: null }])
    }
    await frameOf(main, 'burst-31')
    expect(receivedLabels(main)).toEqual(labels.slice(0, 32))
    const after = await host.call<Presented[]>('present', { tag, frames: [{ label: 'after-0' }, { label: 'after-1' }, { label: 'after-2' }] })
    for (const { key } of after) expect(await host.event(settled(key))).toMatchObject({ invalidated: false })
    expect(main.events(event => event.type === 'error')).toEqual([])
  })

  it.each(['closes the ingress', 'exits'] as const)('invalidates every outstanding request once when Main %s', async (how) => {
    const { main, host, tag } = await startPair()
    const [first, second, third] = (await host.call<Presented[]>('present', {
      tag, frames: [{ label: 'one' }, { label: 'two' }, { label: 'three' }],
    })).map(result => result.key)
    await frameOf(main, 'three')
    await main.call('reply', { requestId: (await frameOf(main, 'one')).requestId, kind: 1 })
    await host.event(delivered(first!))
    if (how === 'exits') main.child.kill()
    else await main.call('closeIngress')
    await host.event(event => event.type === 'disconnected')
    for (const key of [first!, second!, third!]) {
      expect(await host.event(settled(key))).toEqual({ type: 'settled', key, invalidated: true })
    }
    expect(host.events(event => event.type === 'delivered')).toEqual([
      { type: 'delivered', key: first, error: null },
      { type: 'delivered', key: second, error: 'Desktop shared-texture ingress disconnected' },
      { type: 'delivered', key: third, error: 'Desktop shared-texture ingress disconnected' },
    ])
    expect(host.events(event => event.type === 'disconnected')).toHaveLength(1)
    const [late] = await host.call<Presented[]>('present', { tag, frames: [{ label: 'late' }] })
    expectReturnCode(host, late!, 2)
    expect(late!.error).toBe('Desktop shared-texture connection is closed')
    expect(main.events(event => event.type === 'error')).toEqual([])
  })

  it('ends the connection when a send finds Main gone before the reader does', async () => {
    const { main, host, tag } = await startPair()
    const stalled = await presentOne(host, tag, { label: 'stall', blockDeliveredMs: 3000 })
    await main.call('reply', { requestId: (await frameOf(main, 'stall')).requestId, kind: 1 })
    // The reader is now held in the delivery callback, so only the send below can observe the exit.
    await host.event(delivered(stalled))
    main.child.kill()
    await main.exited
    const [failed] = await host.call<Presented[]>('present', { tag, frames: [{ label: 'after-exit' }] })
    expectReturnCode(host, failed!, 2)
    expect(failed!.error).toBe('Desktop shared-texture ingress disconnected')
    expect(host.events(event => event.type === 'disconnected')).toEqual([])
    await host.event(event => event.type === 'disconnected')
    expect(await host.event(settled(stalled))).toMatchObject({ invalidated: true })
    const [later] = await host.call<Presented[]>('present', { tag, frames: [{ label: 'later' }] })
    expectReturnCode(host, later!, 2)
    expect(later!.error).toBe('Desktop shared-texture connection is closed')
    expect(host.events(event => event.type === 'disconnected')).toHaveLength(1)
    await host.call('close')
  })

  it('serves the same Host again after it closes and reconnects to the endpoint', async () => {
    const { main, host, endpoint, tag } = await startPair({ autoReply: true })
    const labels: string[] = []
    for (const round of [0, 1, 2]) {
      if (round > 0) {
        await host.call('close')
        await host.call('connect', { endpoint })
      }
      // Every request of a connection is answered, the first one and those after it.
      const frames = [0, 1, 2].map(index => ({ label: `round-${String(round)}-${String(index)}` }))
      labels.push(...frames.map(frame => frame.label))
      for (const result of await host.call<Presented[]>('present', { tag, frames })) {
        expectReturnCode(host, result, 0)
        expect(await host.event(settled(result.key))).toEqual({ type: 'settled', key: result.key, invalidated: false })
        expect(host.events(delivered(result.key))).toEqual([{ type: 'delivered', key: result.key, error: null }])
      }
    }
    expect(receivedLabels(main)).toEqual(labels)
    expect(host.events(event => event.type === 'disconnected')).toEqual([])
    expect(main.events(event => event.type === 'error')).toEqual([])
  })

  it('drops a Host connection whose replies Main cannot deliver, then serves the Host again after it reconnects', async () => {
    const { main, host, endpoint, tag } = await startPair()
    // The Host's reader is held in this delivery callback while Main's replies fill the Host's queue.
    const held = await presentOne(host, tag, { label: 'held', blockDeliveredMs: 2000 })
    const requestId = (await frameOf(main, 'held')).requestId!
    await main.call('reply', { requestId, kind: 1 })
    await host.event(delivered(held))
    // The Host ignores repeated delivery replies; the one that finds the queue full times out and drops the connection.
    expect(await main.call('flood', { requestId })).toMatchObject({ slow: true })
    let stale: Presented | undefined
    if (process.platform === 'darwin') {
      // Sent on the dropped connection without a reply port: Main discards it, and the Host settles it at the drop.
      // A Windows pipe instead discards unread data when Main disconnects it, and a later write fails.
      stale = (await host.call<Presented[]>('present', { tag, frames: [{ label: 'stale' }] }))[0]
      expectReturnCode(host, stale!, 0)
    }
    await host.event(event => event.type === 'disconnected', 30_000)
    expect(await host.event(settled(held))).toEqual({ type: 'settled', key: held, invalidated: true })
    if (stale !== undefined) {
      expect(await host.event(settled(stale.key))).toEqual({ type: 'settled', key: stale.key, invalidated: true })
      expect(host.events(delivered(stale.key))).toEqual([{ type: 'delivered', key: stale.key, error: 'Desktop shared-texture ingress disconnected' }])
    }
    // The endpoint survives the drop, and every request of the next connection is answered.
    await host.call('connect', { endpoint })
    const after = await host.call<Presented[]>('present', { tag, frames: [{ label: 'after-0' }, { label: 'after-1' }] })
    for (const [index, result] of after.entries()) {
      expectReturnCode(host, result, 0)
      const next = (await frameOf(main, `after-${String(index)}`)).requestId
      await main.call('reply', { requestId: next, kind: 1 })
      await main.call('reply', { requestId: next, kind: 3 })
      expect(await host.event(settled(result.key))).toEqual({ type: 'settled', key: result.key, invalidated: false })
      expect(host.events(delivered(result.key))).toEqual([{ type: 'delivered', key: result.key, error: null }])
      await main.call('release', { requestId: next })
    }
    expect(receivedLabels(main)).toEqual(['held', 'after-0', 'after-1'])
    expect(main.events(event => event.type === 'error')).toEqual([])
  })

  it('settles exactly once every request a native thread sent while JavaScript closes the connection', async () => {
    const { host, endpoint, tag } = await startPair({ autoReply: true })
    for (const round of [0, 1, 2]) {
      if (round > 0) await host.call('connect', { endpoint })
      // Frames 20 µs apart take over 60 ms, so the close request that follows lands while the thread is presenting.
      const frames = Array.from({ length: 3000 }, () => ({ pauseMicros: 20 }))
      const keys = new Set((await host.call<Presented[]>('present', { tag, frames, wait: false })).map(result => result.key))
      await host.call('close')
      await host.event(event => event.type === 'returned' && event.key === Math.max(...keys))
      const returned = host.events(event => event.type === 'returned' && keys.has(event.key!))
      expect(returned).toHaveLength(keys.size)
      for (const result of returned.filter(event => event.code === 0)) await host.event(settled(result.key!))
      const callbacks = new Map<number, string[]>()
      for (const event of host.events(event => (event.type === 'delivered' || event.type === 'settled') && keys.has(event.key!))) {
        callbacks.set(event.key!, [...callbacks.get(event.key!) ?? [], event.type])
      }
      for (const result of returned) {
        expect(callbacks.get(result.key!) ?? []).toEqual(result.code === 0 ? ['delivered', 'settled'] : [])
      }
    }
  })

  it.runIf(process.platform === 'win32')('never imports a handle from a request Main reads after the Host closed its connection', async () => {
    const { main, host, endpoint, tag } = await startPair()
    const before = await presentOne(host, tag, { label: 'before' })
    const served = (await frameOf(main, 'before')).requestId
    for (const kind of [1, 3]) await main.call('reply', { requestId: served, kind })
    await main.call('release', { requestId: served })
    expect(await host.event(settled(before))).toMatchObject({ invalidated: false })
    // While Main is suspended its reader reads nothing, so this request is still in the pipe when the Host closes the
    // connection and settles it; its owner then closes the handle, and a new texture takes over the handle value.
    await host.call('suspend', { pid: main.pid })
    let replacement: { tag: number; reused: boolean }
    try {
      const stale = await presentOne(host, tag, { label: 'stale' })
      await host.call('close')
      expect(await host.event(settled(stale))).toEqual({ type: 'settled', key: stale, invalidated: true })
      replacement = await host.call<{ tag: number; reused: boolean }>('replaceTexture', { tag })
      expect(replacement.reused).toBe(true)
    } finally {
      await host.call('resume', { pid: main.pid })
    }
    // The single pipe instance accepts the next connection only after Main has finished the closed one.
    await host.call('connect', { endpoint })
    await presentOne(host, replacement.tag, { label: 'after' })
    expect(await frameOf(main, 'after')).toMatchObject({ handleTag: replacement.tag })
    // Main never delivered the settled request, under either texture.
    expect(main.events(event => event.type === 'frame').map((event): unknown[] => [JSON.parse(String(event.metadata)), event.handleTag]))
      .toEqual([['before', tag], ['after', replacement.tag]])
    expect(main.events(event => event.type === 'error')).toEqual([])
  })

  it('ignores another process at the endpoint and keeps serving the registered Host', async () => {
    const main = await startPeer('main')
    const host = await startPeer('host')
    const intruder = await startPeer('host')
    const endpoint = await main.call<string>('open', { peerPid: host.pid, autoReply: true })
    // Windows disconnects the intruder; macOS drops its messages. Either way its request never reaches Main.
    await intruder.call('connect', { endpoint }).catch((error: unknown) => { expect(String(error)).toContain('unavailable') })
    const intruderTag = await intruder.call<number>('texture')
    await intruder.call<Presented[]>('present', { tag: intruderTag, frames: [{ label: 'intruder', timeoutMs: 1000 }] }).catch(() => [])
    await host.call('connect', { endpoint })
    const tag = await host.call<number>('texture')
    const key = await presentOne(host, tag, { label: 'host' })
    expect(await host.event(settled(key))).toMatchObject({ invalidated: false })
    await frameOf(main, 'host')
    expect(main.events(event => event.type === 'frame')).toEqual([expect.objectContaining({ metadata: JSON.stringify('host'), handleTag: tag })])
    expect(main.events(event => event.type === 'error')).toEqual([])
  })

  it('reports the hop deadline as a delivery failure and keeps the slot until Main settles', async () => {
    const { main, host, tag } = await startPair()
    const started = Date.now()
    const key = await presentOne(host, tag, { label: 'slow', timeoutMs: 300 })
    expect(await host.event(delivered(key))).toEqual({ type: 'delivered', key, error: 'Desktop shared-texture request timed out' })
    expect(Date.now() - started).toBeGreaterThanOrEqual(250)
    // The timed-out request still holds one of the 128 slots.
    await fill(main, host, tag, 127, 'held')
    const [beyond] = await host.call<Presented[]>('present', { tag, frames: [{ label: 'beyond' }] })
    expectReturnCode(host, beyond!, 1)
    expect(beyond!.error).toBe('Shared-texture presentation limit reached')
    // A late success is ignored; the settlement frees the slot.
    const requestId = (await frameOf(main, 'slow')).requestId
    await main.call('reply', { requestId, kind: 1 })
    await main.call('reply', { requestId, kind: 3 })
    expect(await host.event(settled(key))).toEqual({ type: 'settled', key, invalidated: false })
    expect(host.events(delivered(key))).toHaveLength(1)
    await main.call('release', { requestId })

    // A late delivery error that keeps no reference settles the timed-out request as released.
    const second = await presentOne(host, tag, { label: 'slower', timeoutMs: 200 })
    await host.event(delivered(second))
    const secondRequest = (await frameOf(main, 'slower')).requestId
    await main.call('reply', { requestId: secondRequest, kind: 2, noReferenceKept: true, error: 'late' })
    expect(await host.event(settled(second))).toEqual({ type: 'settled', key: second, invalidated: false })
    expect(host.events(delivered(second))).toEqual([{ type: 'delivered', key: second, error: 'Desktop shared-texture request timed out' }])
    await main.call('release', { requestId: secondRequest })
  })

  it.each([
    ['the previous protocol version', { version: 2 }, ''],
    ['a width beyond 8192', { width: 9000 }, ''],
    ['metadata longer than 4096 bytes', { metadataLength: 4097 }, ''],
    ['lengths that disagree with the message', { metadataLength: 5 }, '"ab"'],
    ['a nonzero reserved byte', { reserved: 1 }, ''],
    ['a nonzero trailing reserved field', { reserved2: 1 }, ''],
  ] as const)('ends the ingress with a terminal error for a Host request with %s', async (_name, override, payload) => {
    const main = await startPeer('main')
    const host = await startPeer('host')
    const endpoint = await main.call<string>('open', { peerPid: host.pid })
    const tag = await host.call<number>('texture')
    const header = {
      magic: 0x44535458, version: 3, requestId: 1, width: 16, height: 16, pixelFormat: 0, metadataLength: payload.length, ...override,
    }
    await host.call('raw', { endpoint, tag, header, payload })
    expect(await main.event(event => event.type === 'error')).toEqual({ type: 'error', text: INVALID_MESSAGE })
    expect(main.events(event => event.type === 'frame')).toEqual([])
  })

  it('reads no adapter from a handle that is not a shared Direct3D 11 texture, and refuses a zero handle', async () => {
    const main = await startPeer('main')
    expect(await main.call('adapterLuid', { kind: 'plain' })).toEqual({ read: null, created: null })
    await expect(main.call('adapterLuid', { kind: 'zero' })).rejects.toThrow('Expected a nonzero eight-byte texture handle')
  })

  it.runIf(process.platform === 'win32')('reads the adapter of a shared Direct3D 11 texture as the LUID text Host addons derive', async () => {
    const main = await startPeer('main')
    const { read, created } = await main.call<{ read: string | null; created: string }>('adapterLuid', { kind: 'd3d' })
    expect(created).toMatch(/^[0-9a-f]{1,8}:[0-9a-f]{1,8}$/)
    expect(read).toBe(created)
  })

  it('refuses an unknown endpoint', () => {
    const hop = createRequire(import.meta.url)(hopAddon) as HopAddon
    const missing = process.platform === 'win32' ? `\\\\.\\pipe\\dsh-shared-texture-${'0'.repeat(64)}` : 'ai.deepseek.shared-texture.missing'
    expect(() => hop.connect(missing, () => {})).toThrow('Desktop shared-texture ingress endpoint is unavailable')
    expect(() => hop.connect('C:\\Windows\\win.ini', () => {})).toThrow('Desktop shared-texture ingress endpoint is unavailable')
  })

  it('refuses invalid presentations without sending them', async () => {
    const { main, host, tag } = await startPair({ autoReply: true })
    const invalid = await host.call<Presented[]>('present', {
      tag, frames: [
        { width: 0 }, { width: 8193 }, { height: 0 }, { height: 8193 }, { pixelFormat: 2 }, { timeoutMs: 0 }, { timeoutMs: 30_001 },
        { metadata: 'm'.repeat(4097) }, { noHandle: true },
      ],
    })
    for (const result of invalid) {
      expectReturnCode(host, result, 1)
      expect(result.error).toContain('Expected a nonzero texture handle')
    }
    expect(host.events(event => event.type === 'delivered' || event.type === 'settled')).toEqual([])
    // None of them reached Main, and the connection still carries the next frame.
    const key = await presentOne(host, tag, { label: 'valid' })
    expect(await host.event(settled(key))).toMatchObject({ invalidated: false })
    expect(receivedLabels(main)).toEqual(['valid'])
  })

  it('lets a process exit while an ingress is still open', () => {
    const script = `import { createRequire } from 'node:module'; const b = createRequire(import.meta.url)(${JSON.stringify(ingressAddon)});
      b.open(process.pid, () => {}); setTimeout(() => process.exit(0), 50)`
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 20_000 })
    expect(result.error).toBeUndefined()
    expect(result.status, result.stderr).toBe(0)
  })

  it('settles close more than once for an ingress nobody sent to', async () => {
    const ingress = createRequire(import.meta.url)(ingressAddon) as IngressAddon
    const opened = ingress.open(process.pid, () => {})
    await expect(Promise.all([ingress.close(opened.native), ingress.close(opened.native)])).resolves.toEqual([undefined, undefined])
    await expect(ingress.close(opened.native)).resolves.toBeUndefined()
  })

  it('closes an idle ingress at once instead of at a later wake-up of its reader', async () => {
    const ingress = createRequire(import.meta.url)(ingressAddon) as IngressAddon
    const durations: number[] = []
    // Ten idle rounds make a reader that woke on a 100 ms period exceed the bound with near certainty.
    for (let round = 0; round < 10; round++) {
      const opened = ingress.open(process.pid, () => {})
      await delay(120)
      const started = performance.now()
      await ingress.close(opened.native)
      durations.push(performance.now() - started)
    }
    expect(Math.max(...durations), JSON.stringify(durations)).toBeLessThan(50)
  })
})
