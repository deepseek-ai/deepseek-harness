import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { createRuntimeContext } from './setup.ts'

/**
 * Mocked subprocess pipes control synchronous write failures and backpressure
 * transitions independently of kernel buffering. The real-subprocess suite
 * remains in runtime.spec.ts.
 */
const { execFileSyncMock, spawnMock } = vi.hoisted(() => ({ execFileSyncMock: vi.fn(), spawnMock: vi.fn() }))
vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>()
  execFileSyncMock.mockImplementation(original.execFileSync)
  return { ...original, execFileSync: execFileSyncMock, spawn: spawnMock }
})

const { PythonPtcRuntime } = await import('../src/index.ts')

/** A `child_process.ChildProcess` stand-in whose fd-3 pipe rejects every write. */
function fakeChildWithThrowingFd3(): EventEmitter {
  const child = new EventEmitter() as EventEmitter & {
    pid?: number
    stdin: PassThrough
    stdout: PassThrough
    stderr: PassThrough
    stdio: unknown[]
  }
  // An absent pid settles without waiting for a process-close event that this
  // pipe fixture does not emit.
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  // A duplex whose `write` throws synchronously, standing in for an fd-3 pipe
  // that fails the moment the boot frame is issued.
  const proto = new PassThrough()
  proto.write = () => { throw Object.assign(new Error('EPIPE: broken pipe, write'), { code: 'EPIPE' }) }
  child.stdio = [child.stdin = new PassThrough(), child.stdout, child.stderr, proto]
  return child
}

afterEach(() => {
  execFileSyncMock.mockClear()
  spawnMock.mockReset()
})

/** A child that emits an async `error` (an ENOENT-style spawn failure). */
function fakeChildWithAsyncSpawnError(): EventEmitter {
  const child = new EventEmitter() as EventEmitter & {
    pid?: number
    stdin: PassThrough
    stdout: PassThrough
    stderr: PassThrough
    stdio: unknown[]
  }
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  const proto = new PassThrough()
  child.stdio = [child.stdin = new PassThrough(), child.stdout, child.stderr, proto]
  // `spawn` reports an async failure via the child's `error` event; the run
  // settles on it as a worker-exit without waiting for `close`.
  setImmediate(() => {
    child.emit('error', Object.assign(new Error('ENOENT: no such file or directory, spawn python3'), { code: 'ENOENT' }))
  })
  return child
}

/** A child whose fd-3 pipe accepts the boot write, then rejects the run write. */
function fakeChildWithAckThenThrowingFd3(): EventEmitter {
  const child = new EventEmitter() as EventEmitter & {
    pid?: number
    stdin: PassThrough
    stdout: PassThrough
    stderr: PassThrough
    stdio: unknown[]
  }
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  const proto = new PassThrough()
  let writes = 0
  proto.write = () => {
    writes += 1
    if (writes === 1) return true // The boot frame goes out.
    throw Object.assign(new Error('EPIPE: broken pipe, write'), { code: 'EPIPE' })
  }
  child.stdio = [child.stdin = new PassThrough(), child.stdout, child.stderr, proto]
  // Emit the boot-ack after the boot write, so the run-frame write fires and
  // hits the throwing pipe.
  setImmediate(() => proto.emit('data', Buffer.from('{"type":"boot-ack"}\n')))
  return child
}

/**
 * A child whose fd-3 pipe backpressures every write and is then destroyed
 * while the host waits for `drain`. The reply-drain loop must settle on the
 * pipe's `close` (or destroyed state) rather than hanging forever waiting for
 * a `drain` that can never arrive. Returns the pipe as well so the test can
 * assert the drain wait left no listener behind.
 */
function fakeChildBackpressuredThenDestroyed(): { child: EventEmitter; proto: PassThrough } {
  const child = new EventEmitter() as EventEmitter & {
    pid?: number
    stdin: PassThrough
    stdout: PassThrough
    stderr: PassThrough
    stdio: unknown[]
  }
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  const proto = new PassThrough()
  // Every write reports backpressure (never a `drain` event): the only way the
  // reply drain can proceed is the pipe being destroyed under it.
  proto.write = () => false
  child.stdio = [child.stdin = new PassThrough(), child.stdout, child.stderr, proto]
  // Boot-ack → run frame → two binding calls whose replies backpressure, then
  // destroy the pipe while the host still waits for `drain`: the drain loop
  // resumes with a queued reply left and must break on the destroyed pipe.
  setImmediate(() => {
    proto.emit('data', Buffer.from('{"type":"boot-ack"}\n'))
    setImmediate(() => {
      proto.emit('data', Buffer.from('{"type":"call","id":0,"global":"tools","name":"f","args":[]}\n'))
      proto.emit('data', Buffer.from('{"type":"call","id":1,"global":"tools","name":"f","args":[]}\n'))
      setImmediate(() => proto.destroy())
    })
  })
  return { child, proto }
}

describe('PythonPtcRuntime — controlled subprocess pipes', () => {
  it.each([
    { asynchronous: false, runnerEvidence: false },
    { asynchronous: false, runnerEvidence: true },
    { asynchronous: true, runnerEvidence: false },
    { asynchronous: true, runnerEvidence: true },
  ])('attributes spawn failures only to an identified runner: $asynchronous / $runnerEvidence', async ({ asynchronous, runnerEvidence }) => {
    const stdin = new PassThrough()
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const proto = new PassThrough()
    const child = Object.assign(new EventEmitter(), { stdin, stdout, stderr, stdio: [stdin, stdout, stderr, proto] })
    onTestFinished(() => { for (const stream of [stdin, stdout, stderr, proto]) stream.destroy() })
    const ctx = await createRuntimeContext({ mode: 'read-only' })
    vi.spyOn(ctx.sandbox, 'confine').mockImplementation(async argv => ({
      argv: [...argv], enforcement: 'partial', denialSignatures: [], runnerFailureRules: [],
    }))
    spawnMock.mockImplementation((bin: string) => {
      const error = Object.assign(new Error('executable disappeared'), {
        code: 'ENOENT', path: runnerEvidence ? bin : '/another-program', syscall: 'spawn',
      })
      if (!asynchronous) throw error
      setImmediate(() => child.emit('error', error))
      return child
    })
    await ctx.plugin(PythonPtcRuntime)
    const result = await ctx.ptcRuntime.run(ctx.ptcRuntime.resolve({ program: 'return 42', bindings: [] }))
    expect(result.error?.kind).toBe(runnerEvidence ? 'sandbox-unavailable' : 'worker-exit')
    expect(result.sandbox).toEqual({ mode: 'read-only', denied: false, enforcement: 'partial' })
  })

  it.each(['synchronous', 'asynchronous'] as const)('reports %s bootstrap source transport failure', async (failure) => {
    const stdin = new PassThrough()
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const proto = new PassThrough()
    const child = Object.assign(new EventEmitter(), { stdin, stdout, stderr, stdio: [stdin, stdout, stderr, proto] })
    onTestFinished(() => { for (const stream of [stdin, stdout, stderr, proto]) stream.destroy() })
    const error = Object.assign(new Error('EPIPE: bootstrap source pipe closed'), { code: 'EPIPE' })
    if (failure === 'synchronous') stdin.end = () => { throw error }
    spawnMock.mockImplementation(() => {
      if (failure === 'asynchronous') setImmediate(() => stdin.emit('error', error))
      return child
    })
    const ctx = await createRuntimeContext()
    await ctx.plugin(PythonPtcRuntime)
    const result = await ctx.ptcRuntime.run(ctx.ptcRuntime.resolve({ program: 'return 42', bindings: [] }))
    expect(result.error?.kind).toBe('worker-exit')
    expect(result.error?.message).toContain('failed to load python bootstrap')
    expect(result.value).toBeUndefined()
    stdin.emit('error', error)
  })

  it('preserves a runner refusal that arrives after the bootstrap source pipe closes', async () => {
    const stdin = new PassThrough()
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const proto = new PassThrough()
    const pid = 900001
    const child = Object.assign(new EventEmitter(), { pid, stdin, stdout, stderr, stdio: [stdin, stdout, stderr, proto] })
    const kill = process.kill.bind(process)
    const killGroup = vi.spyOn(process, 'kill').mockImplementation((target, signal) => {
      if (target !== -pid) return kill(target, signal)
      throw Object.assign(new Error('fixture process group has exited'), { code: 'ESRCH' })
    })
    onTestFinished(() => { killGroup.mockRestore(); for (const stream of [stdin, stdout, stderr, proto]) stream.destroy() })
    const ctx = await createRuntimeContext({ mode: 'read-only' })
    vi.spyOn(ctx.sandbox, 'confine').mockImplementation(async argv => ({
      argv: [...argv], enforcement: 'full', denialSignatures: ['permission denied'],
      runnerFailureRules: [{ allowedExitCodes: [127], fatalSignatures: ['sandbox-fatal:'] }],
    }))
    spawnMock.mockImplementation(() => {
      setImmediate(() => {
        stdin.emit('error', Object.assign(new Error('source pipe closed'), { code: 'EPIPE' }))
        stderr.emit('data', Buffer.from('sandbox-fatal: permission denied\n'))
        child.emit('close', 127, null)
      })
      return child
    })
    await ctx.plugin(PythonPtcRuntime)
    const result = await ctx.ptcRuntime.run(ctx.ptcRuntime.resolve({ program: 'return 42', bindings: [] }))
    expect(result.error?.kind).toBe('sandbox-unavailable')
    expect(result.error?.message).toContain('sandbox-fatal: permission denied')
    expect(result.sandbox).toEqual({ mode: 'read-only', denied: false, enforcement: 'full' })
  })

  it('preserves pending replies across compaction while the pipe stays backpressured', async () => {
    const spawned = Promise.withResolvers<undefined>()
    let written = Promise.withResolvers<undefined>()
    const replies: unknown[] = []
    const proto = new PassThrough()
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const stdin = new PassThrough()
    const child = Object.assign(new EventEmitter(), { stdin, stdout, stderr, stdio: [stdin, stdout, stderr, proto] })
    proto.write = (chunk: unknown) => {
      const frame = JSON.parse(String(chunk)) as { type: string }
      if (frame.type !== 'reply') return true
      replies.push(frame)
      written.resolve(undefined)
      return false
    }
    spawnMock.mockImplementation(() => { spawned.resolve(undefined); return child })
    const ctx = await createRuntimeContext()
    const fiber = await ctx.plugin(PythonPtcRuntime)
    const runtime = ctx.ptcRuntime as InstanceType<typeof PythonPtcRuntime>
    const run = runtime.run(runtime.resolve({
      program: 'return 1',
      bindings: [{ global: 'tools', functions: { echo: async (value: unknown) => value as number } }],
    }))
    onTestFinished(async () => {
      await fiber.dispose()
      await run
      for (const stream of [stdin, stdout, stderr, proto]) stream.destroy()
    })
    const calls = (start: number): void => {
      proto.emit('data', Buffer.from(Array.from({ length: 512 }, (_, offset) => JSON.stringify({
        type: 'call', id: start + offset, global: 'tools', name: 'echo', args: start + offset,
      })).join('\n') + '\n'))
    }
    const drainThrough = async (count: number): Promise<void> => {
      while (replies.length < count) {
        written = Promise.withResolvers<undefined>()
        expect(proto.listenerCount('drain')).toBe(1)
        proto.emit('drain')
        await written.promise
      }
    }
    await spawned.promise
    proto.emit('data', Buffer.from('{"type":"boot-ack"}\n'))
    calls(0)
    await written.promise
    await drainThrough(256)
    calls(512)
    await drainThrough(768)
    calls(1024)
    // Each write remains blocked until this fixture emits drain, keeping
    // pending replies behind the consumed-prefix compaction at frame 1024.
    await drainThrough(1536)
    expect(replies).toEqual(Array.from({ length: 1536 }, (_, id) => ({ type: 'reply', id, ok: true, value: id })))
    proto.emit('drain')
    proto.emit('data', Buffer.from('{"type":"done","value":"done"}\n'))
    expect(await run).toMatchObject({ value: 'done' })
    expect(proto.listenerCount('drain')).toBe(0)
  })

  it('force-kills a version probe that exceeds its load-time deadline', async () => {
    const ctx = await createRuntimeContext()
    const fiber = await ctx.plugin(PythonPtcRuntime)

    expect(execFileSyncMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining(['-I', '-c']),
      expect.objectContaining({ timeout: 5_000, killSignal: 'SIGKILL' }),
    )
    await fiber.dispose()
  })

  it('resolves a worker-exit when the fd-3 boot write throws (no TDZ ReferenceError)', async () => {
    // Before the fix, the boot-write block ran BEFORE `wallTimer`, `onAbort`,
    // and `live` were initialized, so its `finish()` (which clears `wallTimer`,
    // removes `onAbort`, and — through `settle` — deletes `live`) hit the
    // temporal dead zone and threw a ReferenceError. That escaped the Promise
    // executor and REJECTED run() instead of resolving the worker-exit the catch
    // constructs. This test would see that rejection; the fix makes it resolve.
    spawnMock.mockImplementation(() => fakeChildWithThrowingFd3())
    const ctx = await createRuntimeContext()
    const fiber = await ctx.plugin(PythonPtcRuntime)
    const runtime = ctx.ptcRuntime as InstanceType<typeof PythonPtcRuntime>

    const result = await runtime.run(runtime.resolve({ program: 'return 1', bindings: [] }))

    expect(result.error?.kind).toBe('worker-exit')
    expect(result.error?.message).toContain('failed to boot python subprocess')
    await fiber.dispose()
  })

  it('resolves a worker-exit when spawn throws synchronously', async () => {
    spawnMock.mockImplementation(() => {
      throw Object.assign(new Error('EMFILE: too many open files'), { code: 'EMFILE' })
    })
    const ctx = await createRuntimeContext()
    const fiber = await ctx.plugin(PythonPtcRuntime)
    const runtime = ctx.ptcRuntime as InstanceType<typeof PythonPtcRuntime>
    const result = await runtime.run(runtime.resolve({ program: 'return 1', bindings: [] }))
    expect(result.error?.kind).toBe('worker-exit')
    expect(result.error?.message).toContain('python spawn error')
    await fiber.dispose()
  })

  it('resolves a worker-exit when the run write after boot-ack throws', async () => {
    // The run frame goes out from the boot-ack handler; a pipe that accepts
    // the boot frame but rejects the run write must settle the run as a
    // worker-exit rather than reject run() or leave it hanging.
    spawnMock.mockImplementation(() => fakeChildWithAckThenThrowingFd3())
    const ctx = await createRuntimeContext()
    const fiber = await ctx.plugin(PythonPtcRuntime)
    const runtime = ctx.ptcRuntime as InstanceType<typeof PythonPtcRuntime>

    const result = await runtime.run(runtime.resolve({ program: 'return 1', bindings: [] }))

    expect(result.error?.kind).toBe('worker-exit')
    expect(result.error?.message).toContain('failed to boot python subprocess')
    await fiber.dispose()
  })

  it('resolves a worker-exit when spawn reports an async error', async () => {
    // A spawn that fails asynchronously (ENOENT for an interpreter removed
    // after load, or a libuv-level failure) surfaces through the child's
    // `error` event, not a synchronous throw. The run must settle as a
    // worker-exit from that event.
    spawnMock.mockImplementation(() => fakeChildWithAsyncSpawnError())
    const ctx = await createRuntimeContext()
    const fiber = await ctx.plugin(PythonPtcRuntime)
    const runtime = ctx.ptcRuntime as InstanceType<typeof PythonPtcRuntime>

    const result = await runtime.run(runtime.resolve({ program: 'return 1', bindings: [] }))

    expect(result.error?.kind).toBe('worker-exit')
    expect(result.error?.message).toContain('python spawn error')
    await fiber.dispose()
  })

  it('does not hang the reply drain when the pipe is destroyed mid-backpressure', async () => {
    // The reply drain waits for `drain` when fd 3's buffer is full. A pipe
    // destroyed under that wait never emits `drain` again; the drain must
    // settle on `close` instead, or `draining` stays true and the queued reply
    // (here a 4 MiB string) is pinned with the closure forever. The fake child
    // backpressures every write and destroys fd 3 right after the binding
    // call, so the host is mid-drain when the pipe dies. No `done` frame ever
    // arrives, so the run settles on the wall clock — the drain wait must have
    // removed its listeners by then (a `once('drain')` wait would leave one
    // attached to the destroyed pipe forever).
    let proto: PassThrough | undefined
    spawnMock.mockImplementation(() => {
      const fake = fakeChildBackpressuredThenDestroyed()
      proto = fake.proto
      return fake.child
    })
    const ctx = await createRuntimeContext()
    const fiber = await ctx.plugin(PythonPtcRuntime, { maxWallMs: 3000 })
    const runtime = ctx.ptcRuntime as InstanceType<typeof PythonPtcRuntime>

    const result = await runtime.run(runtime.resolve({
      program: 'return 1',
      bindings: [{ global: 'tools', functions: { f: async () => 'x'.repeat(4 * 1024 * 1024) } }],
    }))

    expect(result.error?.kind).toBe('timeout')
    // The drain wait settled on `close` and cleaned up after itself. The
    // discriminating listener is `drain`: a `once('drain')` wait would leave
    // its wrapper attached to the destroyed pipe forever (the event never
    // fires again), while the fixed wait removes it. (`error` is not asserted:
    // the runtime's own `silenceStreamError` occupies one slot.)
    expect(proto).toBeDefined()
    expect(proto?.listenerCount('drain')).toBe(0)
    expect(proto?.listenerCount('close')).toBe(0)
    await fiber.dispose()
  })
})
