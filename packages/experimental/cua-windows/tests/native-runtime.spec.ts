/** Real local pipes exercise Host ownership, Agent isolation, cancellation, and startup admission. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createConnection, createServer, type Socket } from 'node:net'
import { PassThrough } from 'node:stream'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { expect, it, onTestFinished, vi } from 'vitest'
import type { SubprocessHandle, SubprocessOutcome, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { NativeClient, type NativeClientConfig } from '@deepseek-ai/dsh-cua/native-client'
import { WindowsNativeRuntime } from '../src/native-runtime.ts'

interface Frame { type?: string; id?: string; method?: string; runtimeKey?: string; config?: Record<string, unknown> }
interface FixtureOptions {
  transport?: 'pipe' | 'stdio'
  bridgeExitJoined?: boolean
  startupDiagnostic?: string
  startup?: 'wrong-runtime' | 'wrong-instance' | 'extra' | 'malformed' | 'oversized' | 'invalid-utf8' | 'exit' | 'silent' | 'stdout-error' | 'stdout-close'
  handshake?: 'wrong-instance' | 'wrong-pid' | 'extra' | 'malformed' | 'oversized' | 'silent' | 'initial-result'
  ignoreClose?: boolean
  eofOnClose?: boolean
  connectionCleanup?: Promise<void>
  ignoreParent?: boolean
  processCleanup?: false | 'reject'
  cleanupGate?: Promise<void>
  onSpawn?: () => void
  split?: boolean
}

async function fixture(options: FixtureOptions = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'cua-windows-pipes-'))
  const clients: NativeClient[] = []
  const generations: Array<{
    stop: () => Promise<void>
    exit: () => void
    stdout: PassThrough
    received: Frame[]
    peers: Set<Socket>
    endpoint: string
  }> = []
  const resources: { runtime?: WindowsNativeRuntime } = {}
  onTestFinished(async () => {
    await Promise.allSettled(clients.map(client => client.dispose()))
    try { await resources.runtime?.dispose().catch(() => {}) } finally {
      await Promise.all(generations.map(generation => generation.stop()))
      await rm(directory, { recursive: true, force: true })
    }
  })
  const helperPath = join(directory, 'helper.exe')
  await writeFile(helperPath, 'Windows helper identity fixture')
  const spawn = vi.fn((request: SubprocessSpawnSpec): SubprocessHandle => {
    if (request.argv.includes('--bridge')) {
      const socket = createConnection(generations.at(-1)!.endpoint)
      const stdin = new PassThrough(), stdout = new PassThrough()
      const done = Promise.withResolvers<SubprocessOutcome>()
      stdin.pipe(socket).pipe(stdout)
      socket.on('error', (error) => { stdout.destroy(error) })
      socket.on('close', () => { done.resolve({ exitCode: 0, signal: null }) })
      return { stdin, stdout, stderr: undefined, control: undefined, collected: {}, done: done.promise,
        terminate: () => { socket.destroy() }, waitForExit: async () => { await done.promise; return options.bridgeExitJoined ?? true } }
    }
    const instanceId = request.argv[request.argv.indexOf('--instance-id') + 1]!
    const runtimeKey = request.argv[request.argv.indexOf('--runtime-key') + 1]!
    const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\cua-test-${randomUUID()}` : join(directory, `${generations.length}.sock`)
    const pid = 100 + generations.length
    const stdin = new PassThrough(), stdout = new PassThrough()
    const exited = Promise.withResolvers<SubprocessOutcome>()
    const ready: PromiseWithResolvers<void> = Promise.withResolvers()
    const peers = new Set<Socket>()
    const received: Frame[] = []
    let stopped: Promise<void> | undefined
    let diagnostic = ''
    let nextConnection = 0
    const server = createServer({ allowHalfOpen: true }, (socket) => {
      peers.add(socket)
      socket.on('end', () => { socket.end() })
      const connection = ++nextConnection
      socket.on('error', () => {})
      socket.on('close', () => { peers.delete(socket) })
      let buffered = ''
      socket.on('data', (chunk: Buffer) => {
        buffered += chunk.toString('utf8')
        for (;;) {
          const newline = buffered.indexOf('\n')
          if (newline < 0) return
          const frame = JSON.parse(buffered.slice(0, newline)) as Frame
          buffered = buffered.slice(newline + 1)
          received.push(frame)
          if (frame.type === 'hello') {
            if (options.handshake === 'silent') return
            const response = { type: 'ready', protocol: 1, runtimeKey, instanceId: options.handshake === 'wrong-instance' ? 'other' : instanceId,
              pid: options.handshake === 'wrong-pid' ? pid + 1 : pid, ...options.handshake === 'extra' ? { extra: true } : {} }
            const text = options.handshake === 'malformed' ? '{bad}\n' : options.handshake === 'oversized' ? 'x'.repeat(8193) : JSON.stringify(response) + '\n'
            if (options.split) { socket.write(text.slice(0, 4)); socket.write(text.slice(4)) }
            else socket.write(text + (options.handshake === 'initial-result' ? '{"id":"early","result":true}\n' : ''))
          } else if (frame.type === 'close') {
            if (!options.ignoreClose) void (async () => {
              await options.connectionCleanup
              if (!options.eofOnClose) {
                if (options.split) { socket.write('{"type":'); socket.write('"closed"}\n') }
                else socket.write('{"type":"closed"}\n')
              }
              socket.end()
            })()
          } else if (frame.type === 'cancel') socket.write(JSON.stringify({ id: frame.id, error: { code: 'NATIVE_CANCELLED', message: 'Cancelled' } }) + '\n')
          else if (frame.method !== 'hold') socket.write(JSON.stringify({ id: frame.id, result: { connection, pid, method: frame.method } }) + '\n')
        }
      })
    })
    const stop = (): Promise<void> => stopped ??= (async () => {
      await ready.promise
      const closedPeers = [...peers].map(peer => once(peer, 'close'))
      for (const peer of peers) peer.destroy()
      await Promise.all(closedPeers)
      await new Promise<void>((resolve, reject) => server.close((error) => { if (error) reject(error); else resolve() }))
      const ended = options.startup === 'exit' ? once(stdout, 'end') : undefined
      stdout.end()
      await ended
      diagnostic = options.startupDiagnostic ?? ''
      exited.resolve({ exitCode: options.startup === 'exit' ? 1 : 0, signal: null })
    })()
    stdin.on('finish', () => { if (!options.ignoreParent) void stop() })
    server.on('error', (error) => { ready.reject(error); exited.reject(error) })
    server.listen(endpoint, () => {
      ready.resolve()
      if (options.startup === 'silent') return
      if (options.startup === 'stdout-error') { stdout.destroy(new Error('readiness IO failure')); return }
      if (options.startup === 'stdout-close') { stdout.end(); return }
      if (options.startup === 'exit') { void stop(); return }
      const response = { type: 'ready', protocol: 1, endpoint, pid,
        runtimeKey: options.startup === 'wrong-runtime' ? 'other' : runtimeKey,
        instanceId, launcherId: options.startup === 'wrong-instance' ? 'other' : instanceId }
      const text = options.startup === 'malformed' ? '{bad}\n' : options.startup === 'oversized' ? 'x'.repeat(8193)
        : JSON.stringify(response) + '\n' + (options.startup === 'extra' ? 'extra' : '')
      if (options.startup === 'invalid-utf8') stdout.write(Buffer.from([255, 10]))
      else if (options.split) { stdout.write(text.slice(0, 5)); stdout.write(text.slice(5)) }
      else stdout.write(text)
    })
    generations.push({ stop, stdout, received, peers, endpoint, exit: () => { exited.resolve({ exitCode: 1, signal: null }) } })
    options.onSpawn?.()
    return { stdin, stdout, stderr: undefined, control: undefined,
      collected: { stderr: { readFrom: () => ({ text: diagnostic, nextOffset: Buffer.byteLength(diagnostic), lossy: false }) } },
      done: exited.promise,
      terminate: () => { void stop() }, waitForExit: async () => { await exited.promise; await options.cleanupGate; if (options.processCleanup === 'reject') throw new Error('cleanup failed'); return options.processCleanup !== false } }
  })
  const owner = { subprocess: { spawn } }
  const runtime = new WindowsNativeRuntime(owner, 25, 750, options.transport)
  resources.runtime = runtime
  const activeRuntime = runtime
  const config: NativeClientConfig = { helperPath, cwd: directory, timeoutMs: 30_000, connectTimeoutMs: 5000,
    screenshotTimeoutMs: 5000, axTimeoutMs: 3000, maxRequestBytes: 1_048_576, maxResponseBytes: 1_048_576,
    graceMs: 3000, textEventIntervalMs: 0, maxClickHoldMs: 10_000 }
  const client = () => {
    const value = new NativeClient(owner, config, (_owner, native) => activeRuntime.connect(native))
    clients.push(value)
    return value
  }
  return { directory, config, spawn, generations, runtime, client }
}

it('shares one Host helper while closing only the selected Agent connection', async () => {
  const f = await fixture({ split: true })
  const a = f.client(), b = f.client(), signal = new AbortController().signal
  expect(await a.request('one', {}, signal)).toMatchObject({ connection: 1, pid: 100 })
  expect(await b.request('two', {}, signal)).toMatchObject({ connection: 2, pid: 100 })
  expect(f.spawn).toHaveBeenCalledOnce()
  expect(f.generations[0]!.received[0]?.config?.pollIntervalMs).toBe(25)
  expect(f.generations[0]!.received[0]?.config?.launchWaitMs).toBe(750)
  await a.dispose()
  expect(await b.request('after-close', {}, signal)).toMatchObject({ connection: 2 })
  await b.dispose()
  await vi.waitFor(() => { expect(f.generations[0]!.peers.size).toBe(0) })
  await f.runtime.dispose()
  expect(() => f.runtime.connect(f.config)).toThrow('disposed')
})

it('cancels a request without replacing the connection or replaying input', async () => {
  const f = await fixture()
  const client = f.client(), controller = new AbortController()
  const pending = client.request('hold', {}, controller.signal)
  const refused = expect(pending).rejects.toThrow('cancelled')
  await vi.waitFor(() => { expect(f.generations[0]?.received.some(frame => frame.method === 'hold')).toBe(true) })
  controller.abort()
  await refused
  expect(client.disposed).toBe(false)
  expect(await client.request('next', {}, new AbortController().signal)).toMatchObject({ connection: 1 })
  expect(f.generations[0]!.received.filter(frame => frame.method === 'hold')).toHaveLength(1)
})

it('starts a fresh helper after process loss and makes the old client unusable', async () => {
  const f = await fixture(), signal = new AbortController().signal
  const first = f.client()
  await first.request('first', {}, signal)
  await f.generations[0]!.stop()
  await vi.waitFor(() => { expect(first.disposed).toBe(true) })
  await expect(first.dispose()).rejects.toThrow('cleanup acknowledgement')
  const next = f.client()
  expect(await next.request('fresh', {}, signal)).toMatchObject({ pid: 101, connection: 1 })
  expect(f.spawn).toHaveBeenCalledTimes(2)
})

it.each(['wrong-runtime', 'wrong-instance', 'extra', 'malformed', 'oversized', 'invalid-utf8', 'exit'] as const)(
  'rejects %s startup before sending any desktop request', async (startup) => {
    const f = await fixture({ startup })
    await expect(f.client().request('input', {}, new AbortController().signal)).rejects.toThrow()
    expect(f.generations[0]!.received.filter(frame => frame.method)).toEqual([])
  },
)

it.each(['wrong-pid', 'extra'] as const)('ignores unused %s handshake metadata', async (handshake) => {
  const f = await fixture({ handshake })
  await expect(f.client().request('input', {}, new AbortController().signal)).resolves.toMatchObject({ connection: 1 })
})

it.each(['wrong-instance', 'malformed', 'oversized'] as const)(
  'rejects a %s Agent handshake before dispatch', async (handshake) => {
    const f = await fixture({ handshake })
    await expect(f.client().request('input', {}, new AbortController().signal)).rejects.toThrow()
    expect(f.generations[0]!.received.filter(frame => frame.method)).toEqual([])
  },
)

it('reports the helper exit diagnostic when stdout ends before process settlement', async () => {
  const f = await fixture({ startup: 'exit', startupDiagnostic: 'Application-control policy refused the executable' })
  const pending = f.client().request('getCapabilities', {}, new AbortController().signal)
  await expect(pending).rejects.toMatchObject({ code: 'NATIVE_EXITED' })
  await expect(pending).rejects.toThrow('Application-control policy refused the executable')
  expect(f.generations[0]!.received).toEqual([])
  await f.runtime.dispose()
})

it('joins a connection closed before helper readiness', async () => {
  const f = await fixture()
  const client = f.client()
  await client.dispose()
  expect(client.disposed).toBe(true)
  await f.runtime.dispose()
})

it('settles a queued write when its connection is closed before readiness', async () => {
  const f = await fixture()
  const channel = f.runtime.connect(f.config)
  const written = new Promise<Error | null | undefined>(resolve => channel.stdin.write('input\n', resolve))
  channel.close()
  expect(await written).toBeInstanceOf(Error)
  await channel.waitForClose()
})

it('ends the native connection when its writable stream is finalized', async () => {
  const f = await fixture()
  const channel = f.runtime.connect(f.config)
  channel.stdin.end()
  await channel.done
  await channel.waitForClose()
})

it('rejects unsolicited process output and closes the admitted Agent', async () => {
  const f = await fixture()
  const client = f.client()
  await client.request('ready', {}, new AbortController().signal)
  f.generations[0]!.stdout.write('unexpected\n')
  await vi.waitFor(() =>{  expect(client.disposed).toBe(true) })
  await expect(client.dispose()).rejects.toThrow('cleanup acknowledgement')
})

it('closes all active Agent connections when the Host unloads', async () => {
  const f = await fixture()
  const client = f.client()
  await client.request('ready', {}, new AbortController().signal)
  await f.runtime.dispose()
  await vi.waitFor(() =>{  expect(client.disposed).toBe(true) })
})

it.each(['silent', 'stdout-error', 'stdout-close'] as const)('settles %s process startup and joins cleanup', async (startup) => {
  const f = await fixture({ startup })
  f.config.connectTimeoutMs = 100
  await expect(f.client().request('input', {}, new AbortController().signal)).rejects.toThrow()
  await f.runtime.dispose()
  expect(f.generations[0]!.received).toEqual([])
})

it('bounds a silent Agent handshake without sending desktop input', async () => {
  const f = await fixture({ handshake: 'silent' })
  f.config.connectTimeoutMs = 100
  await expect(f.client().request('input', {}, new AbortController().signal)).rejects.toThrow()
  expect(f.generations[0]!.received.map(frame => frame.type)).toEqual(['hello'])
})

it('preserves bytes after pipe readiness for the request parser', async () => {
  const f = await fixture({ handshake: 'initial-result' })
  const channel = f.runtime.connect(f.config)
  const data = new Promise<string>(resolve => channel.stdout.once('data', (chunk) =>{  resolve(String(chunk)) }))
  expect(await data).toContain('"id":"early"')
  channel.close()
  await channel.waitForClose()
})

it('rejects a connection cleanup deadline and stops the Host process', async () => {
  const f = await fixture({ ignoreClose: true, ignoreParent: true })
  f.config.graceMs = 100
  const channel = f.runtime.connect(f.config)
  const response = new Promise<void>(resolve => channel.stdout.once('data', () =>{  resolve() }))
  channel.stdin.write('{"id":"one","method":"probe"}\n')
  await response
  await expect(f.runtime.dispose()).rejects.toThrow('cleanup failed')
  await expect(channel.done).rejects.toThrow('cleanup')
  await expect(channel.waitForClose()).rejects.toThrow('cleanup acknowledgement')
})

it.each([false, 'reject'] as const)('reports unsuccessful process-range cleanup: %s', async (processCleanup) => {
  const f = await fixture({ processCleanup })
  await f.client().request('one', {}, new AbortController().signal)
  await expect(f.runtime.dispose()).rejects.toThrow('cleanup failed')
})

it('refuses writes after a ready connection starts closing', async () => {
  const f = await fixture()
  const channel = f.runtime.connect(f.config)
  const response = new Promise<void>(resolve => channel.stdout.once('data', () =>{  resolve() }))
  channel.stdin.write('{"id":"one","method":"probe"}\n')
  await response
  channel.close()
  const error = await new Promise<Error | null | undefined>(resolve => channel.stdin.write('late\n', resolve))
  expect(error?.message).toContain('closing')
  await channel.waitForClose()
})

it('joins shutdown requested synchronously while the subprocess is being acquired', async () => {
  const options: FixtureOptions = {}
  const f = await fixture(options)
  let closing: Promise<void> | undefined
  options.onSpawn = () => { closing = f.runtime.dispose() }
  await expect(f.client().request('input', {}, new AbortController().signal)).rejects.toThrow()
  await closing
})

it('reports an untyped subprocess rejection as a request failure', async () => {
  const f = await fixture()
  f.spawn.mockImplementationOnce(() => { throw 'subprocess failure' })
  const channel = f.runtime.connect(f.config)
  await expect(channel.done).rejects.toThrow('subprocess failure')
  await channel.waitForClose()
})

it('forces a helper that ignores parent closure to stop after malformed readiness', async () => {
  const f = await fixture({ startup: 'malformed', ignoreParent: true })
  f.config.graceMs = 100
  await expect(f.client().request('input', {}, new AbortController().signal)).rejects.toThrow()
  await f.runtime.dispose()
})

it('contains a cleanup failure after unsolicited process output', async () => {
  const f = await fixture({ processCleanup: 'reject' })
  const client = f.client()
  await client.request('ready', {}, new AbortController().signal)
  f.generations[0]!.stdout.write('unexpected\n')
  await vi.waitFor(() =>{  expect(client.disposed).toBe(true) })
  await expect(f.runtime.dispose()).rejects.toThrow('cleanup failed')
})

it('does not restart a stopped helper while the Host is unloading', async () => {
  const release: PromiseWithResolvers<void> = Promise.withResolvers()
  onTestFinished(() =>{  release.resolve() })
  const f = await fixture({ cleanupGate: release.promise })
  await f.client().request('ready', {}, new AbortController().signal)
  await f.generations[0]!.stop()
  await vi.waitFor(() =>{  expect(f.generations[0]!.stdout.readableEnded).toBe(true) })
  const channel = f.runtime.connect(f.config)
  const done = expect(channel.done).resolves.toBeUndefined()
  const closing = f.runtime.dispose()
  release.resolve()
  await Promise.all([done, closing])
  expect(f.spawn).toHaveBeenCalledOnce()
})

it('waits for the native cleanup frame even after an operation has completed', async () => {
  const release: PromiseWithResolvers<void> = Promise.withResolvers()
  const f = await fixture({ connectionCleanup: release.promise })
  const client = f.client()
  await client.request('one', {}, new AbortController().signal)
  let settled = false
  const closing = client.dispose().then(() => { settled = true })
  try {
    await vi.waitFor(() => { expect(f.generations[0]!.received.some(frame => frame.type === 'close')).toBe(true) })
    expect(settled).toBe(false)
  } finally { release.resolve() }
  await closing
  expect(settled).toBe(true)
})

it('refuses EOF as evidence that native connection cleanup completed', async () => {
  const f = await fixture({ eofOnClose: true })
  const client = f.client()
  await client.request('one', {}, new AbortController().signal)
  await expect(client.dispose()).rejects.toThrow('cleanup acknowledgement')
})

it('rejects an unsolicited cleanup frame while an Agent is still active', async () => {
  const f = await fixture()
  const client = f.client()
  await client.request('one', {}, new AbortController().signal)
  for (const peer of f.generations[0]!.peers) peer.write('{"type":"closed"}\n')
  await vi.waitFor(() => { expect(client.disposed).toBe(true) })
  await expect(client.dispose()).rejects.toThrow('cleanup acknowledgement')
})

it('recognizes fragmented cleanup controls without buffering operation payloads', async () => {
  const f = await fixture({ ignoreClose: true })
  const channel = f.runtime.connect(f.config)
  const ready = once(channel.stdout, 'data')
  channel.stdin.write('{"id":"one","method":"probe"}\n')
  await ready
  const peer = [...f.generations[0]!.peers][0]!
  const send = async (part: string) => {
    const received = once(channel.stdout, 'data')
    peer.write(part)
    expect(String((await received)[0])).toBe(part)
  }
  await send('{"id":')
  await send('"two","result":"a long ')
  await send('fragmented operation payload')
  await send('"}\n')
  channel.close()
  peer.write('{"type":')
  peer.end('"closed"}\n')
  await channel.waitForClose()
})


it('joins WSL bridge EOF after cleanup while keeping other Agents usable', async () => {
  const f = await fixture({ transport: 'stdio', split: true })
  const a = f.client(), b = f.client(), signal = new AbortController().signal
  expect(await a.request('first', {}, signal)).toMatchObject({ connection: 1 })
  expect(await b.request('second', {}, signal)).toMatchObject({ connection: 2 })
  expect(f.spawn.mock.calls.filter(([spec]) => spec.argv.includes('--serve'))).toHaveLength(1)
  expect(f.spawn.mock.calls.filter(([spec]) => spec.argv.includes('--bridge'))).toHaveLength(2)
  await a.dispose()
  expect(await b.request('still-open', {}, signal)).toMatchObject({ connection: 2 })
  await b.dispose()
  await f.runtime.dispose()
  expect(f.generations[0]!.peers.size).toBe(0)
})

it('forwards cancellation over WSL without replaying the request', async () => {
  const f = await fixture({ transport: 'stdio' })
  const client = f.client(), controller = new AbortController()
  const pending = client.request('hold', {}, controller.signal)
  const rejected = expect(pending).rejects.toThrow('cancelled')
  await vi.waitFor(() => { expect(f.generations[0]?.received.some(frame => frame.method === 'hold')).toBe(true) })
  controller.abort()
  await rejected
  expect(await client.request('next', {}, new AbortController().signal)).toMatchObject({ connection: 1 })
  expect(f.generations[0]!.received.filter(frame => frame.method === 'hold')).toHaveLength(1)
})

it('rejects WSL EOF without a desktop cleanup acknowledgement', async () => {
  const f = await fixture({ transport: 'stdio', eofOnClose: true })
  const client = f.client()
  await client.request('ready', {}, new AbortController().signal)
  await expect(client.dispose()).rejects.toThrow('cleanup acknowledgement')
})

it('closes a connected Agent when the helper exits with its pipe still open', async () => {
  const f = await fixture()
  const client = f.client()
  await client.request('first', {}, new AbortController().signal)
  f.generations[0]!.exit()
  await vi.waitFor(() => { expect(client.disposed).toBe(true) })
  await expect(client.dispose()).rejects.toThrow('cleanup acknowledgement')
})

it('reports an unjoined WSL bridge after native cleanup was acknowledged', async () => {
  const f = await fixture({ transport: 'stdio', bridgeExitJoined: false })
  const client = f.client()
  await client.request('first', {}, new AbortController().signal)
  await expect(client.dispose()).rejects.toThrow('Windows bridge process did not exit')
})
