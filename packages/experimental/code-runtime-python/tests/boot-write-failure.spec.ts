import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { dirname } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'

/**
 * A synchronous `proto.write` throw on the fd-3 pipe is the one boot path a real
 * subprocess cannot be coerced into from a test: the pipe accepts queued bytes
 * until the kernel buffer fills, and a same-tick EPIPE needs fd 3 already closed
 * before the first write. `spawn` is mocked so fd 3 throws on the boot frame,
 * which is exactly the branch that regressed. The mock is confined to this file
 * so the real-subprocess suite in runtime.spec.ts is untouched.
 */
const { execFileSyncMock, spawnMock } = vi.hoisted(() => ({ execFileSyncMock: vi.fn(), spawnMock: vi.fn() }))
vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>()
  execFileSyncMock.mockImplementation(original.execFileSync)
  return { ...original, execFileSync: execFileSyncMock, spawn: spawnMock }
})

const { PythonCodeRuntime } = await import('../src/index.ts')

/** A `child_process.ChildProcess` stand-in whose fd-3 pipe rejects every write. */
function fakeChildWithThrowingFd3(): EventEmitter {
  const child = new EventEmitter() as EventEmitter & {
    pid?: number
    stdout: PassThrough
    stderr: PassThrough
    stdio: unknown[]
  }
  // Leave `pid` absent: `finish()` still runs its `clearTimeout(wallTimer)` /
  // `removeEventListener(onAbort)` prologue (the TDZ site) before short-
  // circuiting on `child.pid === undefined` to `settle` instead of waiting on a
  // `close` this fake never emits, so the run resolves promptly.
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  // A duplex whose `write` throws synchronously, standing in for an fd-3 pipe
  // that fails the moment the boot frame is issued.
  const proto = new PassThrough()
  proto.write = () => { throw Object.assign(new Error('EPIPE: broken pipe, write'), { code: 'EPIPE' }) }
  child.stdio = [new PassThrough(), child.stdout, child.stderr, proto]
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
    stdout: PassThrough
    stderr: PassThrough
    stdio: unknown[]
  }
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  const proto = new PassThrough()
  child.stdio = [new PassThrough(), child.stdout, child.stderr, proto]
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
  child.stdio = [new PassThrough(), child.stdout, child.stderr, proto]
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
  child.stdio = [new PassThrough(), child.stdout, child.stderr, proto]
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

describe('PythonCodeRuntime — boot-write failure', () => {
  it('force-kills a version probe that exceeds its load-time deadline', async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin(PythonCodeRuntime)

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
    const ctx = new Context()
    const fiber = await ctx.plugin(PythonCodeRuntime)
    const runtime = ctx.codeRuntime as InstanceType<typeof PythonCodeRuntime>

    const result = await runtime.run({ program: 'return 1', bindings: [] })

    expect(result.error?.kind).toBe('worker-exit')
    expect(result.error?.message).toContain('failed to boot python subprocess')
    await fiber.dispose()
  })

  it('resolves a worker-exit and removes the staging dir when spawn throws synchronously', async () => {
    // `spawn` can throw same-tick — EMFILE on a descriptor-exhausted host, or a
    // libuv-level failure — before the Promise executor and its settlement path
    // exist. Left uncaught it rejected run() (the seam permits rejection only for
    // misuse) and stranded the staging directory materializePyScripts had just
    // written, which only settle() removes. The fix catches it, unlinks the
    // directory, and resolves the same `worker-exit` class as an async ENOENT.
    //
    // Capture THIS run's exact staging dir from the argv the mocked spawn
    // received (`['-I', <dir>/bootstrap.py]`) and assert only that path is gone.
    // A tmpdir scan — even a set difference against a pre-run snapshot — would
    // flake under vitest's forks pool: a sibling worker creating its own
    // `dsh-code-runtime-python-*` dir in the window reads as a leak here. Keying
    // off our own argv is fully isolated from concurrent staging.
    let stagedBootstrap: string | undefined
    spawnMock.mockImplementation((_bin: string, args: string[]) => {
      stagedBootstrap = args[args.length - 1]
      throw Object.assign(new Error('EMFILE: too many open files'), { code: 'EMFILE' })
    })
    const ctx = new Context()
    const fiber = await ctx.plugin(PythonCodeRuntime)
    const runtime = ctx.codeRuntime as InstanceType<typeof PythonCodeRuntime>

    const result = await runtime.run({ program: 'return 1', bindings: [] })

    expect(result.error?.kind).toBe('worker-exit')
    expect(result.error?.message).toContain('python spawn error')
    expect(stagedBootstrap).toBeDefined()
    expect(existsSync(dirname(stagedBootstrap as string))).toBe(false)
    await fiber.dispose()
  })

  it('resolves a worker-exit when the run write after boot-ack throws', async () => {
    // The run frame goes out from the boot-ack handler; a pipe that accepts
    // the boot frame but rejects the run write must settle the run as a
    // worker-exit rather than reject run() or leave it hanging.
    spawnMock.mockImplementation(() => fakeChildWithAckThenThrowingFd3())
    const ctx = new Context()
    const fiber = await ctx.plugin(PythonCodeRuntime)
    const runtime = ctx.codeRuntime as InstanceType<typeof PythonCodeRuntime>

    const result = await runtime.run({ program: 'return 1', bindings: [] })

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
    const ctx = new Context()
    const fiber = await ctx.plugin(PythonCodeRuntime)
    const runtime = ctx.codeRuntime as InstanceType<typeof PythonCodeRuntime>

    const result = await runtime.run({ program: 'return 1', bindings: [] })

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
    const ctx = new Context()
    const fiber = await ctx.plugin(PythonCodeRuntime, { maxWallMs: 3000 })
    const runtime = ctx.codeRuntime as InstanceType<typeof PythonCodeRuntime>

    const result = await runtime.run({
      program: 'return 1',
      bindings: [{ global: 'tools', functions: { f: async () => 'x'.repeat(4 * 1024 * 1024) } }],
    })

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
