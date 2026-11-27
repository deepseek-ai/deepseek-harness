/**
 * The built receiver addon serves producer processes built from test fixtures over one transferable channel: a
 * copied credential connects without PID binding, a successor takes over after the previous connection drains, mixed
 * builds are refused, a trimmed producer returns its idle allocation to the shared budget, crashed and graceful
 * reconnects leave no dead name behind, a successor that dies before ready loses its place, and close settles without
 * libuv handles.
 */
import { receiverAddon } from './desktop-receiver.ts'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadFrameForwardingBindings } from '../src/host/native.ts'
import type { FrameForwardingBindings, FrameForwardingReceiver, FrameForwardingReceiverEvent } from '../src/host/native.ts'
import type { FrameConnectionId } from '../src/types.ts'

const addon = receiverAddon
const native = fileURLToPath(new URL('../native/', import.meta.url))
const fixtures = fileURLToPath(new URL('../../../../apps/desktop/tests/frame-forwarding/fixtures/', import.meta.url))
const fixture = fileURLToPath(new URL('../../../../apps/desktop/tests/frame-forwarding/fixtures/producer.cc', import.meta.url))
type Event = FrameForwardingReceiverEvent
/** Dead names of the process running the receiver, and their references, from `fixtures/mach-port-census.cc`. */
interface PortCensus { deadNames: number; deadNameRefs: number }

/** One receiver whose events are read in order; a channel failure fails the read. */
function channel(bindings: FrameForwardingBindings, readbackTimeoutMs = 10_000, budget = bindings.createBudget(16384)) {
  const queued: Event[] = []
  const waiters: ((event: Event) => void)[] = []
  const receiver = bindings.createReceiver({
    maxFrames: 1, maxBytes: 16384, budget, displayAdapter: null, readbackTimeoutMs,
  }, (event) => { const waiter = waiters.shift(); if (waiter === undefined) queued.push(event); else waiter(event) })
  const next = async <T extends Event['type']>(type: T): Promise<Extract<Event, { type: T }>> => {
    for (;;) {
      const event = queued.shift() ?? await new Promise<Event>((resolve) => { waiters.push(resolve) })
      if (event.type === 'failed' && type !== 'failed') throw new Error(event.text)
      if (event.type === type) return event as Extract<Event, { type: T }>
    }
  }
  return { receiver, next, queued }
}
const connection = (value: number) => value as FrameConnectionId

// macOS needs only the Xcode command-line tools. Run `pnpm --filter @deepseek-ai/dsh-desktop run build:native` first.
describe.skipIf(process.platform !== 'darwin')('built frame-forwarding receiver', () => {
  let temporary = ''
  let producer = ''
  let newerProducer = ''
  let olderProducer = ''
  let legacyProducer = ''
  let duplicatingProducer = ''
  let bindings: FrameForwardingBindings
  let census = (): PortCensus => { throw new Error('the Mach port census addon is not built') }
  const children: ChildProcess[] = []
  const frameworks = ['-framework', 'IOSurface', '-framework', 'CoreFoundation', '-lbsm']
  const arch = ['-arch', process.arch === 'x64' ? 'x86_64' : 'arm64', '-std=c++17']
  /** Build the producer with changed protocol declarations, each `[file, from, to]`, in its own source directory. */
  async function variant(name: string, ...changes: [file: string, from: string, to: string][]): Promise<string> {
    const root = join(temporary, name)
    await mkdir(root)
    for (const file of ['transport.h', 'transport.cc', 'fixture-client.cc']) {
      const directory = file === 'fixture-client.cc' ? fixtures : native
      let source = await readFile(join(directory, file), 'utf8')
      for (const [target, from, to] of changes) {
        if (target !== file) continue
        expect(source).toContain(from)
        source = source.replaceAll(from, to)
      }
      await writeFile(join(root, file), source)
    }
    const output = join(root, 'producer')
    const build = spawnSync('clang++', [...arch, `-I${root}`, `-I${fixtures}`, `-I${native}`, fixture,
      join(root, 'fixture-client.cc'), join(root, 'transport.cc'), ...frameworks, '-o', output], { encoding: 'utf8', timeout: 60_000 })
    expect(build.error).toBeUndefined()
    expect(build.signal).toBeNull()
    expect(build.status, build.stdout + build.stderr).toBe(0)
    return output
  }
  function start(path: string, receiver: FrameForwardingReceiver) {
    const child = spawn(path, [receiver.tx], { stdio: ['ignore', 'ignore', 'pipe'] })
    children.push(child)
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    return { child, exited: once(child, 'exit'), stderr: () => stderr }
  }
  /** True while `candidate` is still waiting for ready after `timeout`; false once it was refused and exited. */
  async function waits(candidate: ReturnType<typeof start>, timeout = 300): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([candidate.exited.then(() => false),
        new Promise<boolean>((resolve) => { timer = setTimeout(() => { resolve(true) }, timeout) })])
    } finally { if (timer !== undefined) clearTimeout(timer) }
  }
  beforeAll(async () => {
    temporary = await mkdtemp(join(tmpdir(), 'dsh-office-frame-forwarding-'))
    producer = await variant('current')
    expect(existsSync(addon), 'run build:native before native e2e').toBe(true)
    newerProducer = await variant('protocol-v3', ['transport.h',
      '#define DSH_FRAME_FORWARDING_PROTOCOL_VERSION 2', '#define DSH_FRAME_FORWARDING_PROTOCOL_VERSION 3'])
    // A protocol 1 producer, such as Kit 0.2.3's, names version 1 in a hello the size of the whole fixed packet.
    olderProducer = await variant('protocol-v1', ['transport.h',
      '#define DSH_FRAME_FORWARDING_PROTOCOL_VERSION 2', '#define DSH_FRAME_FORWARDING_PROTOCOL_VERSION 1'],
    ['transport.cc', 'offsetof(MachMessage, text) + aligned_text', 'offsetof(MachMessage, trailer)'])
    // A producer of an earlier build declares no transferable channel in its hello.
    legacyProducer = await variant('pid-bound', ['fixture-client.cc', 'hello_transferable | hello_producer_local_handles;', '0;'])
    // A 0.2.2 producer declares transferable channels but sends Windows handles it duplicated into the receiver.
    duplicatingProducer = await variant('duplicating', ['fixture-client.cc', 'hello_transferable | hello_producer_local_handles;', 'hello_transferable;'])
    // The census addon counts this process's dead names, which no API of the receiver exposes.
    const censusHeaders = dirname(createRequire(import.meta.url).resolve('node-api-headers/package.json'))
    const censusOutput = join(temporary, 'mach-port-census.node')
    const censusBuild = spawnSync('clang++', [...arch, `-I${join(censusHeaders, 'include')}`, '-DNAPI_VERSION=8',
      '-shared', '-undefined', 'dynamic_lookup', fileURLToPath(new URL('../../../../apps/desktop/tests/frame-forwarding/fixtures/mach-port-census.cc', import.meta.url)),
      '-o', censusOutput], { encoding: 'utf8', timeout: 60_000 })
    expect(censusBuild.error).toBeUndefined()
    expect(censusBuild.signal).toBeNull()
    expect(censusBuild.status, censusBuild.stdout + censusBuild.stderr).toBe(0)
    const loadedCensus = createRequire(import.meta.url)(censusOutput) as { count: () => PortCensus }
    census = () => loadedCensus.count()
    bindings = loadFrameForwardingBindings(addon)
  }, 180_000)
  afterAll(async () => {
    await Promise.all(children.map(async (child) => {
      if (child.exitCode !== null || child.signalCode !== null) return
      const exited = once(child, 'exit')
      child.kill()
      await exited
    }))
    if (temporary) await rm(temporary, { recursive: true, force: true })
  })

  it('delivers a frame from the test producer, returns its credit, and drains after the producer exits', async () => {
    const { receiver, next } = channel(bindings)
    const process = start(producer, receiver)
    try {
      expect(await next('connected')).toEqual({ type: 'connected', connectionId: 1, pid: process.child.pid })
      const frame = await next('frame')
      const { connectionId, width, height, transport } = frame
      expect({ connectionId, width, height, transport, handle: frame.handle.length })
        .toEqual({ connectionId: 1, width: 64, height: 64, transport: 'shared-texture', handle: 8 })
      receiver.send(connection(1), 'ack')
      expect(JSON.parse((await next('message')).text)).toEqual({ applied: 1 })
      expect(receiver.release(frame.deliveryId)).toBe(true)
      expect(receiver.release(frame.deliveryId)).toBe(false)
      receiver.send(connection(1), 'exit')
      await process.exited
      expect(await next('disconnected')).toEqual({ type: 'disconnected', connectionId: 1 })
      expect(await next('drained')).toEqual({ type: 'drained', connectionId: 1 })
      expect(() => { receiver.send(connection(1), 'ack') }).toThrow('not active')
    } finally {
      await receiver.close()
    }
  }, 30_000)

  it('lets a successor process connect with the same credential only after the crashed producer\'s frame is released', async () => {
    const { receiver, next, queued } = channel(bindings)
    try {
      const first = start(producer, receiver)
      await next('connected')
      const held = await next('frame')
      first.child.kill('SIGKILL')
      await first.exited
      expect((await next('disconnected')).text).toMatch(/connection lost/i)
      const busy = start(producer, receiver)
      const successor = start(producer, receiver)
      // One candidate waits for the drain; the other is refused while the channel drains.
      const refused = (await next('rejected')).text
      expect(refused).toBe('channel-busy')
      expect(queued.some(event => event.type === 'connected')).toBe(false)
      expect(receiver.release(held.deliveryId)).toBe(true)
      await next('drained')
      const takeover = await next('connected')
      expect(takeover.connectionId).toBe(2)
      expect([busy.child.pid, successor.child.pid]).toContain(takeover.pid)
      const frame = await next('frame')
      expect(frame).toMatchObject({ connectionId: 2, frameId: held.frameId })
      expect(frame.deliveryId).toBeGreaterThan(held.deliveryId)
      expect(receiver.release(held.deliveryId)).toBe(false)
      receiver.release(frame.deliveryId)
      receiver.send(connection(2), 'exit')
    } finally {
      await receiver.close()
    }
  }, 30_000)

  it.each([['crashed', 'crash'], ['graceful', 'goodbye']] as const)(
    'leaves no dead name behind across repeated %s reconnects',
    async (_label, mode) => {
      const { receiver, next } = channel(bindings)
      try {
        const before = census()
        const cycles = 20
        for (let cycle = 0; cycle < cycles; ++cycle) {
          const process = start(producer, receiver)
          const connected = await next('connected')
          const frame = await next('frame')
          if (mode === 'crash') {
            process.child.kill('SIGKILL')
            await process.exited
            expect((await next('disconnected')).text).toMatch(/connection lost/i)
            expect(receiver.release(frame.deliveryId)).toBe(true)
          } else {
            expect(receiver.release(frame.deliveryId)).toBe(true)
            receiver.send(connection(connected.connectionId), 'exit')
            await process.exited
            expect(await next('disconnected')).toEqual({ type: 'disconnected', connectionId: connected.connectionId })
          }
          await next('drained')
        }
        const after = census()
        // Connection liveness watches `MACH_NOTIFY_NO_SENDERS` on the receiver's own port rather than
        // `MACH_NOTIFY_DEAD_NAME` on the peer's port, so releasing the channel drops the peer port's single reference
        // with no queued dead-name notification references left behind.
        expect(after.deadNames - before.deadNames).toBe(0)
        expect(after.deadNameRefs - before.deadNameRefs).toBe(0)
      } finally {
        await receiver.close()
      }
    }, 120_000)

  it('drops a waiting successor that dies before ready, and admits the next candidate in its place', async () => {
    const { receiver, next } = channel(bindings)
    try {
      const crashed = start(producer, receiver)
      await next('connected')
      const held = await next('frame')
      crashed.child.kill('SIGKILL')
      await crashed.exited
      expect((await next('disconnected')).text).toMatch(/connection lost/i)
      // While the crashed connection drains, one candidate waits for it and the other is refused as busy.
      const first = start(producer, receiver)
      const second = start(producer, receiver)
      expect((await next('rejected')).text).toBe('channel-busy')
      const refused = await Promise.race([first.exited.then(() => first), second.exited.then(() => second)])
      const waiting = refused === first ? second : first
      expect(refused.child.exitCode).toBe(3)
      // A candidate still waiting for ready arms no notice, so the listener reads its reply port's type on every
      // accept timeout (100 ms). Until the dead candidate is dropped, a new candidate is refused as busy.
      waiting.child.kill('SIGKILL')
      await waiting.exited
      let successor: ReturnType<typeof start> | undefined
      const deadline = Date.now() + 10_000
      while (successor === undefined && Date.now() < deadline) {
        const candidate = start(producer, receiver)
        if (await waits(candidate)) successor = candidate
        else expect(candidate.stderr()).toContain('channel-busy')
      }
      if (successor === undefined) throw new Error('no candidate took the dead successor\'s place')
      expect(receiver.release(held.deliveryId)).toBe(true)
      await next('drained')
      const takeover = await next('connected')
      expect(takeover.pid).toBe(successor.child.pid)
      const frame = await next('frame')
      expect(receiver.release(frame.deliveryId)).toBe(true)
      receiver.send(connection(takeover.connectionId), 'exit')
    } finally {
      await receiver.close()
    }
  }, 60_000)

  it('refuses producers of other builds: other protocol versions, a producer without transferable channels, and one that sends receiver handles', async () => {
    const { receiver, next } = channel(bindings)
    try {
      const newer = start(newerProducer, receiver)
      expect((await next('rejected')).text).toBe('protocol-mismatch: producer version 3, receiver version 2')
      // The receiver names both versions; the newer producer cannot read the protocol 2 refusal itself.
      expect(await newer.exited).toEqual([3, null])
      const older = start(olderProducer, receiver)
      expect((await next('rejected')).text).toBe('protocol-mismatch: producer version 1, receiver version 2')
      expect(await older.exited).toEqual([3, null])
      const legacy = start(legacyProducer, receiver)
      expect((await next('rejected')).text).toBe('transferable-tx-required')
      expect(await legacy.exited).toEqual([3, null])
      expect(legacy.stderr()).toContain('requires a transferable TX producer')
      const duplicating = start(duplicatingProducer, receiver)
      expect((await next('rejected')).text).toBe('producer-local-handles-required')
      expect(await duplicating.exited).toEqual([3, null])
      expect(duplicating.stderr()).toContain('names only its own handles')
    } finally {
      await receiver.close()
    }
  }, 30_000)

  it('returns a trimmed producer\'s idle allocation to the shared budget, which another channel then receives', async () => {
    const budget = bindings.createBudget(16384)
    const hidden = channel(bindings, 10_000, budget), visible = channel(bindings, 10_000, budget)
    try {
      start(producer, hidden.receiver)
      await hidden.next('connected')
      const frame = await hidden.next('frame')
      expect(hidden.receiver.release(frame.deliveryId)).toBe(true)
      start(producer, visible.receiver)
      await visible.next('connected')
      // The idle allocation of the first channel holds the whole budget, so the second producer gets no surface.
      visible.receiver.send(connection(1), 'ack')
      await visible.next('message')
      expect(visible.queued.some(event => event.type === 'frame')).toBe(false)
      hidden.receiver.send(connection(1), 'trim')
      expect(JSON.parse((await hidden.next('message')).text)).toEqual({ trimmed: 1 })
      const delivered = await visible.next('frame')
      expect(visible.receiver.release(delivered.deliveryId)).toBe(true)
      // The trimmed producer stays connected and allocates again for its next frame.
      expect(hidden.queued.some(event => event.type === 'disconnected')).toBe(false)
      visible.receiver.send(connection(1), 'exit')
      hidden.receiver.send(connection(1), 'exit')
    } finally {
      await Promise.all([hidden.receiver.close(), visible.receiver.close()])
    }
  }, 30_000)

  it('withdraws the credential on close, so a producer started afterwards cannot connect', async () => {
    const { receiver } = channel(bindings, 1000)
    await expect(receiver.close()).resolves.toBeUndefined()
    await expect(receiver.close()).resolves.toBeUndefined()
    const late = start(producer, receiver)
    expect(await late.exited).toEqual([3, null])
  }, 30_000)

  it('lets a process exit while a receiver is still open', () => {
    const script = `import { createRequire } from 'node:module'; const b = createRequire(import.meta.url)(${JSON.stringify(addon)});
      b.create(1, 16384, () => {}, b.createBudget(16384), '', 1000); setTimeout(() => process.exit(0), 50)`
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 20_000 })
    expect(result.status, result.stderr).toBe(0)
  })
})
