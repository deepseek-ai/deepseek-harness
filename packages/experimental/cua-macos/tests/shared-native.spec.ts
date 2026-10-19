/** Real Unix sockets exercise connection isolation and native startup ownership. */
import { createHash, randomUUID } from 'node:crypto'
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer, Socket } from 'node:net'
import { userInfo } from 'node:os'
import { join } from 'node:path'
import type { SubprocessHandle, SubprocessOutcome, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import type { NativeClientConfig } from '@deepseek-ai/dsh-cua/native-client'
import { createSharedNativeChannel, type NativeChannel } from '../src/shared-native.ts'

const runtime = vi.hoisted(() => ({ source: '', directory: '', foreignOwner: false }))
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>()
  return {
    ...actual,
    mkdir: (path: string, options: import('node:fs').MakeDirectoryOptions) => actual.mkdir(path === runtime.source ? runtime.directory : path, options),
    lstat: async (path: string) => {
      const result = await actual.lstat(path === runtime.source ? runtime.directory : path)
      if (path === runtime.source && runtime.foreignOwner) result.uid += 1
      return result
    },
  }
})
vi.mock('node:path', async (original) => {
  const actual = await original<typeof import('node:path')>()
  return { ...actual, join: (...paths: string[]) => actual.join(...paths.map(path => path === runtime.source ? runtime.directory : path)) }
})

type Peer = (socket: Socket, ready: Buffer) => void

function launcherFixture(): SubprocessHandle {
  return {
    stdin: undefined, stdout: undefined, stderr: undefined, control: undefined, collected: {},
    done: Promise.resolve({ exitCode: 0, signal: null }), waitForExit: vi.fn(async () => true), terminate: vi.fn(),
  }
}

async function fixture(options: {
  ready?: Peer
  close?: (socket: Socket) => void
  root?: 'missing' | 'symlink' | 'file' | 'public' | 'foreign'
  launch?: () => SubprocessHandle
  connectTimeoutMs?: number
  graceMs?: number
  listen?: boolean
} = {}) {
  const root = await mkdtemp('/tmp/cua-')
  const sockets = new Set<Socket>()
  const peerClosures: Promise<void>[] = []
  const channels: NativeChannel[] = []
  const server = createServer({ allowHalfOpen: true })
  runtime.source = `/tmp/dsh-cua-${userInfo().uid}`
  runtime.directory = join(root, 'r')
  runtime.foreignOwner = options.root === 'foreign'
  onTestFinished(async () => {
    for (const channel of channels) channel.close()
    for (const socket of sockets) socket.destroy()
    await Promise.all(channels.map(channel => channel.waitForClose().catch(() => {})))
    await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
    runtime.source = ''
    runtime.directory = ''
    runtime.foreignOwner = false
    await rm(root, { recursive: true, force: true })
  })
  if (options.root === 'symlink') {
    const target = join(root, 'target')
    await mkdir(target, { mode: 0o700 })
    await symlink(target, runtime.directory)
  } else if (options.root === 'file') await writeFile(runtime.directory, 'not a directory')
  else if (options.root !== 'missing') await mkdir(runtime.directory, { mode: 0o700 })
  if (options.root === 'public') await chmod(runtime.directory, 0o755)
  const helperPath = join(root, 'helper')
  const binary = randomUUID()
  await writeFile(helperPath, binary)
  const runtimeKey = createHash('sha256').update(binary).digest('hex')
  const socketPath = join(runtime.directory, `${runtimeKey}.sock`)
  const hellos: unknown[] = []
  const operations: string[] = []
  const helloWaiters: (() => void)[] = []
  server.on('connection', (socket) => {
    sockets.add(socket)
    const closed: PromiseWithResolvers<void> = Promise.withResolvers()
    peerClosures.push(closed.promise)
    socket.on('error', () => {})
    socket.on('close', () => { sockets.delete(socket); closed.resolve() })
    socket.on('end', () => {
      if (options.close) options.close(socket)
      else socket.end()
    })
    let pending = ''
    let hello = true
    let sequence = 0
    socket.on('data', (chunk) => {
      pending += String(chunk)
      for (;;) {
        const newline = pending.indexOf('\n')
        if (newline < 0) return
        const line = pending.slice(0, newline)
        pending = pending.slice(newline + 1)
        if (hello) {
          hello = false
          hellos.push(JSON.parse(line))
          for (const waiter of helloWaiters.splice(0)) waiter()
          const ready = Buffer.from(JSON.stringify({ type: 'ready', protocol: 1, runtimeKey, pid: process.pid, instanceId: randomUUID() }) + '\n')
          if (options.ready) options.ready(socket, ready)
          else socket.write(ready)
        } else {
          operations.push(line)
          sequence += 1
          socket.write(JSON.stringify({ sequence, request: line }) + '\n')
        }
      }
    })
  })
  async function listen(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(socketPath, () => { server.removeListener('error', reject); resolve() })
    })
  }
  if (options.listen !== false && !['file', 'missing'].includes(options.root ?? '')) await listen()
  const handles: SubprocessHandle[] = []
  const spawned: PromiseWithResolvers<void> = Promise.withResolvers()
  const spawn = vi.fn<SubprocessRuntime['spawn']>(() => {
    const handle = options.launch ? options.launch() : launcherFixture()
    handles.push(handle)
    spawned.resolve()
    return handle
  })
  const config: NativeClientConfig = {
    helperPath, cwd: root, connectTimeoutMs: options.connectTimeoutMs ?? 5000, screenshotTimeoutMs: 5000,
    timeoutMs: 30_000, graceMs: options.graceMs ?? 1000, axTimeoutMs: 3000,
    maxRequestBytes: 65536, maxResponseBytes: 1048576, textEventIntervalMs: 0.5, maxClickHoldMs: 7000,
  }
  function open(): NativeChannel {
    const channel = createSharedNativeChannel({ subprocess: { spawn } }, config)
    channels.push(channel)
    return channel
  }
  async function waitHello(count: number): Promise<void> {
    while (hellos.length < count) await new Promise<void>((resolve) => { helloWaiters.push(resolve) })
  }
  return {
    open, config, spawn, spawned: spawned.promise, handles, hellos, waitHello, operations, sockets, peerClosures, socketPath, listen,
  }
}

function write(channel: NativeChannel, text: string): Promise<void> {
  return new Promise((resolve, reject) => { channel.stdin.write(text, (error) => { if (error) reject(error); else resolve() }) })
}

function nextBytes(channel: NativeChannel, lines = 1): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let receivedLines = 0
    const error = (value: Error): void => { channel.stdout.removeListener('data', data); reject(value) }
    const data = (value: Buffer): void => {
      chunks.push(value)
      for (const byte of value) if (byte === 10) receivedLines += 1
      if (receivedLines < lines) return
      channel.stdout.removeListener('data', data)
      channel.stdout.removeListener('error', error)
      resolve(Buffer.concat(chunks))
    }
    channel.stdout.on('data', data)
    channel.stdout.once('error', error)
  })
}

describe.skipIf(process.platform === 'win32')('shared native Unix connection', () => {
  it('keeps concurrent Agent scopes independent and leaves other sockets alive when one closes', async () => {
    const f = await fixture()
    const first = f.open()
    const second = f.open()
    const firstReply = nextBytes(first)
    const secondReply = nextBytes(second)
    await Promise.all([write(first, 'one\n'), write(second, 'two\n')])
    expect(JSON.parse(String(await firstReply))).toEqual({ sequence: 1, request: 'one' })
    expect(JSON.parse(String(await secondReply))).toEqual({ sequence: 1, request: 'two' })
    first.close()
    await first.waitForClose()
    const remaining = nextBytes(second)
    await write(second, 'three\n')
    expect(JSON.parse(String(await remaining))).toEqual({ sequence: 2, request: 'three' })
    expect(f.spawn).toHaveBeenCalledTimes(2)
    // oxlint-disable-next-line typescript/unbound-method -- Fixture termination methods are spies inspected without invocation.
    for (const handle of f.handles) expect(handle.terminate).not.toHaveBeenCalled()
    expect(f.hellos).toEqual([expect.objectContaining({ type: 'hello', protocol: 1, config: {
      axTimeoutMs: 3000, timeoutMs: 30000, screenshotTimeoutMs: 5000, graceMs: 1000,
      maxRequestBytes: 65536, maxResponseBytes: 1048576, textEventIntervalMs: 0.5, maxClickHoldMs: 7000,
    } }), expect.anything()])
  })

  it('waits for both launcher outcome and managed range release before sending any bytes', async () => {
    const outcome = Promise.withResolvers<SubprocessOutcome>()
    const range = Promise.withResolvers<boolean>()
    const f = await fixture({ launch: () => ({ ...launcherFixture(), done: outcome.promise, waitForExit: () => range.promise }) })
    const channel = f.open()
    const reply = nextBytes(channel)
    const pending = write(channel, 'after-ready\n')
    await f.spawned
    outcome.resolve({ exitCode: 0, signal: null })
    expect(f.hellos).toHaveLength(0)
    expect(f.operations).toHaveLength(0)
    range.resolve(true)
    await pending
    expect(String(await reply)).toContain('after-ready')
    expect(f.spawn.mock.calls[0]?.[0].argv).toEqual([
      await realpath(f.config.helperPath), '--ensure-shared', '--runtime-key', expect.stringMatching(/^[0-9a-f]{64}$/),
      '--runtime-directory', runtime.source, '--startup-timeout-ms', '5000',
    ])
  })

  it('removes the ready frame while preserving response bytes from its final chunk', async () => {
    const result = Buffer.from('{"diagnostic":{"stage":"hello"}}\n{"id":"one","result":true}\n')
    const fragment = Promise.withResolvers<{ socket: Socket; ready: Buffer }>()
    const consumed: PromiseWithResolvers<void> = Promise.withResolvers()
    const f = await fixture({ ready: (socket, ready) => {
      socket.write(ready.subarray(0, 7))
      fragment.resolve({ socket, ready })
    } })
    // Kernel buffering can coalesce separate writes; the client must consume the prefix before the suffix is sent.
    // oxlint-disable-next-line typescript/unbound-method -- Reflect.apply supplies the original Socket receiver.
    const originalConnect = Socket.prototype.connect
    const connect = vi.spyOn(Socket.prototype, 'connect').mockImplementation(function (this: Socket, ...args: unknown[]) {
      if (args[0] === f.socketPath) this.once('data', () => { consumed.resolve() })
      Reflect.apply(originalConnect, this, args)
      return this
    })
    try {
      const channel = f.open()
      const response = nextBytes(channel, 2)
      await consumed.promise
      const { socket, ready } = await fragment.promise
      socket.write(Buffer.concat([ready.subarray(7), result]))
      expect(await response).toEqual(result)
      channel.close()
      await channel.waitForClose()
    } finally { connect.mockRestore() }
  })

  it.each(['protocol', 'identity', 'json', 'utf8', 'oversized', 'refusal', 'refusal-retry-code'] as const)('rejects %s handshakes before writing operations', async (kind) => {
    const f = await fixture({ ready: (socket, ready) => {
      if (kind === 'protocol') socket.write(String(ready).replace('"protocol":1', '"protocol":2'))
      else if (kind === 'identity') socket.write(String(ready).replace(/"runtimeKey":"[^"]*"/, '"runtimeKey":"other"'))
      else if (kind === 'json') socket.write('{broken}\n')
      else if (kind === 'utf8') socket.write(Buffer.from([0xff, 10]))
      else if (kind === 'oversized') socket.write('x'.repeat(8193))
      else if (kind === 'refusal') socket.write('{"type":"error","code":"CONFIG_REFUSED","message":"invalid limits"}\n')
      else socket.write('{"type":"error","code":"NATIVE_EOF","message":"explicit refusal"}\n')
    } })
    const channel = f.open()
    const failedWrite = expect(write(channel, 'never\n')).rejects.toBeInstanceOf(Error)
    await expect(channel.done).rejects.toMatchObject({ code: kind === 'refusal' ? 'CONFIG_REFUSED' : kind === 'refusal-retry-code' ? 'NATIVE_EOF' : 'NATIVE_PROTOCOL' })
    await failedWrite
    await channel.waitForClose()
    expect(f.operations).toHaveLength(0)
    expect(f.spawn).toHaveBeenCalledTimes(1)
  })

  it.each(['symlink', 'file', 'public', 'foreign'] as const)('rejects a %s runtime directory without launching native code', async (root) => {
    const f = await fixture({ root, listen: false })
    const channel = f.open()
    await expect(channel.done).rejects.toMatchObject({ code: 'NATIVE_RUNTIME_DIRECTORY' })
    await channel.waitForClose()
    expect(f.spawn).not.toHaveBeenCalled()
  })

  it('creates a private runtime directory before starting the launcher', async () => {
    const outcome = Promise.withResolvers<SubprocessOutcome>()
    const f = await fixture({ root: 'missing', launch: () => ({ ...launcherFixture(), done: outcome.promise }) })
    const channel = f.open()
    const reply = nextBytes(channel)
    const pending = write(channel, 'created\n')
    await f.spawned
    await f.listen()
    outcome.resolve({ exitCode: 0, signal: null })
    await pending
    expect(String(await reply)).toContain('created')
  })

  it('returns a failed launcher outcome with its retained stderr and releases the managed range', async () => {
    const f = await fixture({ launch: () => ({ ...launcherFixture(),
      done: Promise.resolve({ exitCode: 12, signal: null }),
      collected: { stderr: { readFrom: () => ({ text: 'launcher refused private root', nextOffset: 29, lossy: false }) } },
    }) })
    const channel = f.open()
    await expect(channel.done).rejects.toThrow('launcher refused private root')
    await channel.waitForClose()
    expect(f.hellos).toHaveLength(0)
  })

  it.each(['unobservable', 'not-empty'] as const)('reports %s startup ranges as cleanup failures', async (kind) => {
    const failure = new Error('native range is no longer observable')
    const f = await fixture({ launch: () => ({ ...launcherFixture(), waitForExit: async () => {
      if (kind === 'unobservable') throw failure
      return false
    } }) })
    const channel = f.open()
    await expect(channel.done).rejects.toThrow(kind === 'unobservable' ? failure.message : 'process range did not close')
    await expect(channel.waitForClose()).rejects.toThrow(kind === 'unobservable' ? failure.message : 'process range did not close')
    expect(f.hellos).toHaveLength(0)
  })

  it('preserves spawn failures after an empty managed range has settled', async () => {
    const failure = new Error('native executable failed to start')
    const f = await fixture({ launch: () => ({ ...launcherFixture(), done: Promise.reject(failure) }) })
    const channel = f.open()
    await expect(channel.done).rejects.toBe(failure)
    await channel.waitForClose()
    expect(f.hellos).toHaveLength(0)
  })

  it('reports non-Error provider failures through the Error stream without losing their cause', async () => {
    // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- The provider's non-Error rejection is the test input.
    const f = await fixture({ launch: () => ({ ...launcherFixture(), done: Promise.reject('provider unavailable') }) })
    const channel = f.open()
    await expect(channel.done).rejects.toMatchObject({ code: 'NATIVE_CONNECT', cause: 'provider unavailable' })
    await channel.waitForClose()
  })

  it('rejects an unsuccessful launcher with no captured stderr', async () => {
    const f = await fixture({ launch: () => ({ ...launcherFixture(), done: Promise.resolve({ exitCode: 1, signal: null }) }) })
    const channel = f.open()
    await expect(channel.done).rejects.toThrow('Native launcher failed (exit 1, signal null)')
    await channel.waitForClose()
  })

  it('preserves runtime-directory creation errors before starting any native process', async () => {
    const f = await fixture({ listen: false })
    runtime.directory = join(f.config.cwd, 'absent-parent', 'runtime')
    const channel = f.open()
    await expect(channel.done).rejects.toMatchObject({ code: 'ENOENT' })
    await channel.waitForClose()
    expect(f.spawn).not.toHaveBeenCalled()
  })

  it('handles cancellation dispatched synchronously by the managed launcher provider', async () => {
    const f = await fixture({ launch: () => {
      channel.close()
      return launcherFixture()
    } })
    const channel = f.open()
    await expect(channel.done).rejects.toMatchObject({ code: 'NATIVE_CLOSED' })
    await channel.waitForClose()
    expect(f.hellos).toHaveLength(0)
  })

  it('bounds a peer that accepts the socket but never completes its handshake', async () => {
    const f = await fixture({ ready: () => {} })
    vi.useFakeTimers()
    try {
      const channel = f.open()
      await f.waitHello(1)
      await vi.advanceTimersByTimeAsync(f.config.connectTimeoutMs)
      await expect(channel.done).rejects.toMatchObject({ code: 'NATIVE_CONNECT_TIMEOUT' })
      await channel.waitForClose()
      expect(f.operations).toHaveLength(0)
    } finally { vi.useRealTimers() }
  })

  it('waits for the server cleanup acknowledgement after half-closing the socket', async () => {
    const eof = Promise.withResolvers<Socket>()
    const f = await fixture({ close: (socket) => { eof.resolve(socket) } })
    const channel = f.open()
    const reply = nextBytes(channel)
    await write(channel, 'last\n')
    await reply
    let closed = false
    void channel.waitForClose().then(() => { closed = true })
    channel.close()
    const peer = await eof.promise
    expect(closed).toBe(false)
    peer.end()
    await channel.waitForClose()
    expect(closed).toBe(true)
  })

  it('reports cleanup timeout without terminating the shared process', async () => {
    const f = await fixture({ close: () => {}, graceMs: 20 })
    const channel = f.open()
    const reply = nextBytes(channel)
    await write(channel, 'last\n')
    await reply
    channel.close()
    await expect(channel.waitForClose()).rejects.toMatchObject({ code: 'NATIVE_CLEANUP' })
    await expect(channel.done).rejects.toMatchObject({ code: 'NATIVE_CLEANUP' })
    // oxlint-disable-next-line typescript/unbound-method -- The fixture spy is inspected without invoking the method.
    expect(f.handles[0]?.terminate).not.toHaveBeenCalled()
  })

  it('rejects new writes while awaiting the peer cleanup acknowledgement', async () => {
    const eof = Promise.withResolvers<Socket>()
    const f = await fixture({ close: (socket) => { eof.resolve(socket) } })
    const channel = f.open()
    const reply = nextBytes(channel)
    await write(channel, 'before-close\n')
    await reply
    channel.close()
    const peer = await eof.promise
    await expect(write(channel, 'after-close\n')).rejects.toMatchObject({ code: 'NATIVE_CLOSED' })
    peer.end()
    await channel.waitForClose()
    expect(f.operations).toEqual(['before-close'])
  })

  it('contains a synchronous socket write failure and releases the connection', async () => {
    const f = await fixture()
    const channel = f.open()
    const reply = nextBytes(channel)
    await write(channel, 'before-failure\n')
    await reply
    const failure = new Error('socket rejected write')
    const socketWrite = vi.spyOn(Socket.prototype, 'write').mockImplementationOnce(() => { throw failure })
    try { await expect(write(channel, 'never\n')).rejects.toBe(failure) }
    finally { socketWrite.mockRestore() }
    await channel.waitForClose()
    expect(f.operations).toEqual(['before-failure'])
  })

  it('allows the stdin end operation to release the Agent scope', async () => {
    const f = await fixture()
    const channel = f.open()
    const reply = nextBytes(channel)
    await write(channel, 'last\n')
    await reply
    channel.stdin.end()
    await channel.waitForClose()
    await channel.done
    await Promise.all(f.peerClosures)
    expect(f.sockets.size).toBe(0)
  })

  it('reports when a cancelled startup command does not release its managed range', async () => {
    const outcome = Promise.withResolvers<SubprocessOutcome>()
    const range = Promise.withResolvers<boolean>()
    const f = await fixture({ launch: () => ({ ...launcherFixture(), done: outcome.promise,
      waitForExit: () => range.promise,
      terminate: () => { outcome.resolve({ exitCode: null, signal: 'SIGTERM' }) },
    }) })
    const channel = f.open()
    await f.spawned
    vi.useFakeTimers()
    try {
      channel.close()
      await vi.advanceTimersByTimeAsync(f.config.graceMs)
      await expect(channel.done).rejects.toMatchObject({ code: 'NATIVE_CLEANUP' })
      await expect(channel.waitForClose()).rejects.toMatchObject({ code: 'NATIVE_CLEANUP' })
    } finally {
      range.resolve(true)
      vi.useRealTimers()
    }
  })

  it('bounds launcher retries while the listener remains absent', async () => {
    const f = await fixture({ listen: false, connectTimeoutMs: 100 })
    vi.useFakeTimers()
    try {
      const channel = f.open()
      await f.spawned
      await vi.advanceTimersByTimeAsync(f.config.connectTimeoutMs)
      await expect(channel.done).rejects.toMatchObject({ code: 'NATIVE_CONNECT_TIMEOUT' })
      await channel.waitForClose()
      expect(f.spawn).toHaveBeenCalled()
      expect(f.hellos).toHaveLength(0)
    } finally { vi.useRealTimers() }
  })

  it('cancels startup before spawning when closed immediately', async () => {
    const f = await fixture()
    const channel = f.open()
    channel.close()
    await channel.waitForClose()
    await expect(channel.done).rejects.toBeInstanceOf(Error)
    expect(f.spawn).not.toHaveBeenCalled()
  })

  it('terminates only the unfinished startup command and waits for its managed range on cancellation', async () => {
    const outcome = Promise.withResolvers<SubprocessOutcome>()
    const range = Promise.withResolvers<boolean>()
    const stopped: PromiseWithResolvers<void> = Promise.withResolvers()
    const f = await fixture({ launch: () => ({ ...launcherFixture(), done: outcome.promise,
      waitForExit: () => range.promise,
      terminate: () => { stopped.resolve(); outcome.resolve({ exitCode: null, signal: 'SIGTERM' }) },
    }) })
    const channel = f.open()
    await f.spawned
    channel.close()
    await stopped.promise
    let closed = false
    void channel.waitForClose().then(() => { closed = true })
    expect(closed).toBe(false)
    range.resolve(true)
    await channel.waitForClose()
    expect(closed).toBe(true)
  })

  it('starts a replacement server when the previous listener exits between ensure and connect', async () => {
    const replaced: PromiseWithResolvers<void> = Promise.withResolvers()
    const outcome = Promise.withResolvers<SubprocessOutcome>()
    let launches = 0
    const f = await fixture({ listen: false, launch: () => {
      launches += 1
      if (launches === 1) return launcherFixture()
      replaced.resolve()
      return { ...launcherFixture(), done: outcome.promise }
    } })
    const channel = f.open()
    const reply = nextBytes(channel)
    const pending = write(channel, 'replacement\n')
    await replaced.promise
    await f.listen()
    outcome.resolve({ exitCode: 0, signal: null })
    await pending
    expect(String(await reply)).toContain('replacement')
    expect(f.spawn).toHaveBeenCalledTimes(2)
    expect(f.operations).toEqual(['replacement'])
  })

  it('does not restart or replay operations after a ready peer disconnects', async () => {
    const f = await fixture()
    const channel = f.open()
    const reply = nextBytes(channel)
    await write(channel, 'once\n')
    await reply
    for (const socket of f.sockets) socket.end()
    await channel.done
    await channel.waitForClose()
    expect(f.spawn).toHaveBeenCalledTimes(1)
    expect(f.operations).toEqual(['once'])
  })

  it.each(['eof', 'reset'] as const)('retries a pre-ready %s without sending or replaying an operation', async (kind) => {
    let attempts = 0
    const f = await fixture({ ready: (socket, ready) => {
      attempts += 1
      if (attempts === 1) socket.end()
      else socket.write(ready)
    } })
    // oxlint-disable-next-line typescript/unbound-method -- Reflect.apply below supplies the original Socket receiver.
    const originalEmit = Socket.prototype.emit
    let injected = false
    // Unix kernels differ in reporting close as EOF or ECONNRESET; inject only that error event.
    const emit = kind === 'reset' ? vi.spyOn(Socket.prototype, 'emit').mockImplementation(function (this: Socket, event: string | symbol, ...args: unknown[]) {
      if (!injected && event === 'end') {
        injected = true
        Reflect.apply(originalEmit, this, ['error', Object.assign(new Error('peer reset during admission'), { code: 'ECONNRESET' })])
      }
      return Reflect.apply(originalEmit, this, [event, ...args]) === true
    }) : undefined
    try {
      const channel = f.open()
      const reply = nextBytes(channel)
      await write(channel, 'after-admission\n')
      expect(JSON.parse(String(await reply))).toEqual({ sequence: 1, request: 'after-admission' })
      expect(f.spawn).toHaveBeenCalledTimes(2)
      expect(f.operations).toEqual(['after-admission'])
      expect(attempts).toBe(2)
      if (kind === 'reset') expect(injected).toBe(true)
    } finally { emit?.mockRestore() }
  })
})
