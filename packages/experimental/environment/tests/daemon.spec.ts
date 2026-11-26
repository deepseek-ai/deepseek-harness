import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { serveConnection } from '../src/daemon.ts'
import { ENVIRONMENT_PROTOCOL_VERSION as protocol, RemoteRequestError, RpcPeer, type RpcHandler } from '../src/protocol.ts'
import type { EnvironmentContext, EnvironmentHostHandler } from '../src/types.ts'
import { shipped } from './fixtures/definitions.ts'
import { frame } from './fixtures/frames.ts'
import { exists } from './fixtures/processes.ts'

const node = process.execPath
let directory: string | undefined
const opened: { input: PassThrough; closed: Promise<Error> }[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  for (const { input } of opened) input.end()
  // A closed connection has ended its workers and exec process groups.
  await Promise.all(opened.splice(0).map(({ closed }) => closed))
  if (directory !== undefined) await rm(directory, { recursive: true, force: true })
  directory = undefined
})

interface Opened { peer: RpcPeer; input: PassThrough; closed: Promise<Error>; limits: Record<string, number> }

/** Frame and message limits a test host applies to its side and negotiates for the daemon. */
interface Bounds { readonly maxFrameBytes: number; readonly maxMessageBytes: number }
const bounds: Bounds = { maxFrameBytes: 64 * 1024, maxMessageBytes: 1024 * 1024 }

function connection(
  handler?: RpcHandler, sizes = bounds, extra: { authTimeoutMs?: number; signal?: AbortSignal; cancelGraceMs?: number } = {},
): Opened {
  const toDaemon = new PassThrough()
  const toHost = new PassThrough()
  const { cancelGraceMs = 10_000, ...options } = extra
  const limits = { ...sizes, maxPending: 4, cancelGraceMs }
  const closed = serveConnection({ input: toDaemon, output: toHost, mechanisms: ['transport'], authTimeoutMs: 10_000, ...options })
  opened.push({ input: toDaemon, closed })
  return { peer: new RpcPeer(toHost, toDaemon, limits, handler), input: toDaemon, closed, limits: { ...limits, killGraceMs: 100 } }
}

/** An authenticated connection, as the host service opens one. */
async function daemon(handler?: RpcHandler, sizes = bounds, cancelGraceMs = 10_000): Promise<Opened> {
  const opened = connection(handler, sizes, { cancelGraceMs })
  await expect(opened.peer.request('auth', { protocol, mechanisms: ['transport'], limits: opened.limits })).resolves.toEqual({ mechanism: 'transport' })
  return opened
}

/** Collect what this process, and the workers whose standard error it forwards, writes to standard error. */
function stderr(): string[] {
  const written: string[] = []
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
    written.push(Buffer.from(chunk).toString('utf8'))
    return true
  })
  return written
}

const run = (
  peer: RpcPeer, fn: (args: never, env: EnvironmentContext<Record<string, EnvironmentHostHandler>>) => unknown,
  args: unknown = null, signal?: AbortSignal, methods: readonly string[] = [],
) =>
  peer.request('run', { run: 7, ...shipped(fn.toString(), methods), args }, signal)

describe('execution environment daemon', () => {
  it('closes a connection that does not authenticate in time, and one whose signal aborts', async () => {
    const late = connection(undefined, bounds, { authTimeoutMs: 20 })
    expect((await late.closed).message).toBe('Execution environment host did not authenticate within 20 ms')
    const stop = new AbortController()
    const stopped = connection(undefined, bounds, { signal: stop.signal })
    await stopped.peer.request('auth', { protocol, mechanisms: ['transport'], limits: stopped.limits })
    stop.abort(new Error('replaced'))
    expect((await stopped.closed).message).toBe('replaced')
  })

  it('refuses requests before auth, a second auth, another protocol, unaccepted mechanisms and invalid limits', async () => {
    const { peer, limits } = connection()
    await expect(peer.request('run', { run: 1, ...shipped('() => 1'), args: null })).rejects
      .toThrow(/^Execution environment connection is not authenticated$/)
    await expect(peer.request('auth', { protocol: protocol - 1, mechanisms: ['transport'], limits })).rejects
      .toThrow(new RegExp(`^Execution environment daemon speaks protocol ${protocol}; the host speaks ${protocol - 1}$`))
    await expect(peer.request('auth', { protocol, mechanisms: ['mutual-key'], limits })).rejects
      .toThrow(/^Execution environment daemon accepts transport; the host offered mutual-key$/)
    for (const invalid of [
      { maxPending: 0 }, { maxFrameBytes: 1023 }, { maxMessageBytes: 1023 }, { maxMessageBytes: undefined },
      { maxFrameBytes: 2048, maxMessageBytes: 1024 },
    ]) {
      await expect(peer.request('auth', { protocol, mechanisms: ['transport'], limits: { ...limits, ...invalid } })).rejects.toThrow()
    }
    await expect(peer.request('auth', { protocol, mechanisms: ['transport'], limits })).resolves.toEqual({ mechanism: 'transport' })
    await expect(peer.request('auth', { protocol, mechanisms: ['transport'], limits })).rejects.toThrow('already authenticated')
  })

  it('bounds frames before auth by the handshake limits and messages after it by the host limits', async () => {
    const { peer, closed } = connection(undefined, { maxFrameBytes: 1024 * 1024, maxMessageBytes: 1024 * 1024 })
    await expect(peer.request('auth', {
      protocol, mechanisms: ['transport'],
      limits: { maxFrameBytes: 1024 * 1024, maxMessageBytes: 1024 * 1024, maxPending: 4, cancelGraceMs: 10_000, killGraceMs: 100 }, padding: 'x'.repeat(70_000),
    })).rejects.toThrow()
    expect((await closed).message).toMatch(/^Execution environment peer sent a frame of 70\d{3} bytes; frames hold 1 to 65536 bytes$/)
    // Arguments and results over the 64 KiB frame limit travel as several frames.
    const large = await daemon()
    await expect(run(large.peer, (args: string) => args.repeat(2), 'y'.repeat(200_000))).resolves.toBe('y'.repeat(400_000))
    await expect(run(large.peer, (args: string) => args.length, 'y'.repeat(1024 * 1024))).rejects.toThrow('exceeds maxMessageBytes (1048576)')
    await expect(run(large.peer, () => 'z'.repeat(1024 * 1024))).rejects.toThrow('exceeds maxMessageBytes (1048576)')
  })

  it('copies binary values and undefined both ways and exposes the negotiated message limit', async () => {
    const { peer } = await daemon(async (_method, params) => params)
    const value = await run(peer, async (args: { bytes: Uint8Array; missing: undefined }, env) => ({
      limit: env.limits.maxMessageBytes,
      echoed: await env.origin.echo!({ bytes: args.bytes, missing: args.missing, date: new Date(0) }),
      omitted: 'missing' in args,
    }), { bytes: new Uint8Array([1, 2, 3]), missing: undefined }, undefined, ['echo'])
    expect(value).toEqual({
      limit: 1024 * 1024, omitted: true,
      echoed: { run: 7, method: 'echo', params: { bytes: new Uint8Array([1, 2, 3]), missing: undefined, date: new Date(0) } },
    })
  })

  it('runs shipped source with fs, path, exec and host calls in a fresh context', async () => {
    directory = await mkdtemp(join(tmpdir(), 'dsh-remote-daemon-'))
    const calls: unknown[] = []
    const { peer } = await daemon(async (method, params) => {
      calls.push([method, params])
      return { seen: true }
    })
    const value = await run(peer, async (args: { directory: string; node: string }, env) => {
      const file = env.path.join(args.directory, 'a.txt')
      await env.fs.writeFile(file, 'hello')
      const echoed = await env.exec([args.node, '-e', 'process.stdin.pipe(process.stdout)'], { input: 'piped', cwd: args.directory })
      // @ts-expect-error -- the shipped source sees only a fresh context's globals.
      const leaked = typeof globalThis.marker
      // @ts-expect-error -- set to prove the next run does not observe it.
      globalThis.marker = 1
      return { text: await env.fs.readFile(file, 'utf8'), echoed, host: await env.origin.record!({ file }), defaulted: await env.origin.empty!(), leaked, cwd: env.cwd, platform: env.platform }
    }, { directory, node }, undefined, ['record', 'empty'])
    expect(value).toEqual({
      text: 'hello', echoed: { exitCode: 0, signal: null, stdout: 'piped', stderr: '' }, host: { seen: true }, defaulted: { seen: true },
      leaked: 'undefined', cwd: process.cwd(), platform: process.platform,
    })
    expect(calls).toEqual([
      ['call', { run: 7, method: 'record', params: { file: join(directory, 'a.txt') } }],
      ['call', { run: 7, method: 'empty' }],
    ])
    // @ts-expect-error -- reads the global the previous run set.
    await expect(run(peer, () => typeof globalThis.marker)).resolves.toBe('undefined')
    expect(await readFile(join(directory, 'a.txt'), 'utf8')).toBe('hello')
  })

  it('keeps shipped definitions by hash for later runs of the connection and refuses unknown or mismatched hashes', async () => {
    const { peer } = await daemon()
    const source = '(n, env) => ({ n: n + 1, methods: Object.keys(env.origin) })'
    const plain = shipped(source)
    // The same source with other origin methods is another definition.
    const named = shipped(source, ['echo'])
    expect(named.hash).not.toBe(plain.hash)
    await expect(peer.request('run', { run: 1, ...plain, args: 1 })).resolves.toEqual({ n: 2, methods: [] })
    await expect(peer.request('run', { run: 2, ...named, args: 2 })).resolves.toEqual({ n: 3, methods: ['echo'] })
    await expect(peer.request('run', { run: 3, hash: plain.hash, args: 3 })).resolves.toEqual({ n: 4, methods: [] })
    await expect(peer.request('run', { run: 4, hash: named.hash, args: 4 })).resolves.toEqual({ n: 5, methods: ['echo'] })
    const unknown = shipped('() => 0').hash
    await expect(peer.request('run', { run: 5, hash: unknown, args: null })).rejects
      .toThrow(`Execution environment connection holds no definition with hash ${unknown}`)
    for (const altered of [{ source: '() => 0', methods: [] }, { source, methods: ['echo'] }]) {
      await expect(peer.request('run', { run: 6, hash: plain.hash, definition: altered, args: null })).rejects
        .toThrow(`Execution environment definition does not match its hash ${plain.hash}`)
    }
    // A refused definition leaves the one its hash names in place.
    await expect(peer.request('run', { run: 7, hash: plain.hash, args: 7 })).resolves.toEqual({ n: 8, methods: [] })
    const other = await daemon()
    await expect(other.peer.request('run', { run: 1, hash: plain.hash, args: 1 })).rejects.toThrow('holds no definition')
  })

  it('provides timers and web utilities from the worker realm', async () => {
    const { peer } = await daemon()
    await expect(run(peer, async () => {
      const bytes = new TextEncoder().encode('héllo')
      const controller = new AbortController()
      controller.abort(new Error('stop'))
      const cleared = setTimeout(() => { throw new Error('cleared timers never fire') }, 0)
      clearTimeout(cleared)
      let ticks = 0
      await new Promise<void>((resolve) => {
        const interval = setInterval(() => {
          if (++ticks < 3) return
          clearInterval(interval)
          resolve()
        }, 1)
      })
      return {
        text: new TextDecoder().decode(bytes),
        base64: Buffer.from(bytes).toString('base64'),
        ascii: atob(btoa('ascii')),
        url: new URL('/path?q=1', 'https://example.test').href,
        search: new URLSearchParams({ a: '1', b: 'two' }).toString(),
        clone: structuredClone({ nested: [1, { deep: true }] }),
        aborted: controller.signal.aborted && AbortSignal.abort().aborted,
        now: typeof performance.now(),
        timer: await new Promise(resolve => setTimeout(resolve, 1, 'timer')),
        microtask: await new Promise((resolve) => { queueMicrotask(() => { resolve('microtask') }) }),
        ticks,
        // Utilities come from the worker's realm, not from the context's own intrinsics.
        sameRealm: bytes instanceof Uint8Array,
      }
    })).resolves.toEqual({
      text: 'héllo', base64: Buffer.from('héllo').toString('base64'), ascii: 'ascii', url: 'https://example.test/path?q=1',
      search: 'a=1&b=two', clone: { nested: [1, { deep: true }] }, aborted: true, now: 'number', timer: 'timer',
      microtask: 'microtask', ticks: 3, sameRealm: false,
    })
  })

  it('clears the timers a run leaves pending when it ends', async () => {
    directory = await mkdtemp(join(tmpdir(), 'dsh-remote-daemon-'))
    const { peer } = await daemon()
    const late = join(directory, 'late')
    await expect(run(peer, (file: string, env) => {
      setTimeout(() => { void env.fs.writeFile(`${file}-timeout`, 'fired') }, 50)
      setInterval(() => { void env.fs.writeFile(`${file}-interval`, 'fired') }, 50)
      return 'returned'
    }, late)).resolves.toBe('returned')
    await new Promise(resolve => setTimeout(resolve, 300))
    await expect(access(`${late}-timeout`)).rejects.toThrow('ENOENT')
    await expect(access(`${late}-interval`)).rejects.toThrow('ENOENT')
  })

  it('runs each function on its own worker, so one that blocks delays no other run', async () => {
    const started = Promise.withResolvers<undefined>()
    const { peer, input } = await daemon(async () => { started.resolve(undefined) }, bounds, 400)
    const blocked = run(peer, async (_args: null, env) => {
      await env.origin.started!()
      return /^(a+)+$/.test(`${'a'.repeat(64)}!`)
    }, null, undefined, ['started'])
    await started.promise
    await expect(run(peer, async () => {
      await new Promise(resolve => setTimeout(resolve, 50))
      return 'unblocked'
    })).resolves.toBe('unblocked')
    // Cancel without a host-side abort, so the daemon's own answer reaches the caller; the run is request 2 after auth.
    const cancelledAt = performance.now()
    input.write(frame({ type: 'cancel', id: 2 }))
    await expect(blocked).rejects
      .toThrow(/^Execution environment run did not stop within 200 ms of its cancellation; its worker was terminated$/)
    expect(performance.now() - cancelledAt).toBeGreaterThanOrEqual(190)
    await expect(run(peer, () => 'after')).resolves.toBe('after')
    expect(peer.failed).toBe(false)
  })

  it('answers a cancelled run that ignores its signal before the host grace ends, keeping the connection', async () => {
    const started = Promise.withResolvers<undefined>()
    const { peer } = await daemon(async () => { started.resolve(undefined) }, bounds, 400)
    const controller = new AbortController()
    const ignored = run(peer, async (_args: null, env) => {
      await env.origin.started!()
      return await new Promise(() => {})
    }, null, controller.signal, ['started'])
    await started.promise
    controller.abort(new Error('stop'))
    await expect(ignored).rejects.toThrow('stop')
    // Past the host's grace, a daemon that had not answered would have lost the connection.
    await new Promise(resolve => setTimeout(resolve, 600))
    expect(peer.failed).toBe(false)
    await expect(run(peer, () => 'next')).resolves.toBe('next')
  })

  it('ends the exec process groups of a run whose worker is terminated or dies', async () => {
    directory = await mkdtemp(join(tmpdir(), 'dsh-remote-daemon-'))
    const started = Promise.withResolvers<undefined>()
    const { peer, input } = await daemon(async () => { started.resolve(undefined) }, bounds, 400)
    const script = (file: string) => [
      "process.on('SIGTERM', () => {})",
      `require('fs').writeFileSync(${JSON.stringify(file)}, String(process.pid))`,
      'setInterval(() => {}, 1000)',
    ].join('; ')
    const pid = async (file: string): Promise<number> => {
      await expect.poll(async () => Number(await readFile(file, 'utf8').catch(() => ''))).toBeGreaterThan(0)
      return Number(await readFile(file, 'utf8'))
    }
    const terminated = join(directory, 'terminated')
    const blocked = run(peer, async ({ node, script }: { node: string; script: string }, env) => {
      env.exec([node, '-e', script]).catch(() => {
        // The run's end kills this child; its rejection is expected.
      })
      await env.origin.started!()
      return /^(a+)+$/.test(`${'a'.repeat(64)}!`)
    }, { node, script: script(terminated) }, undefined, ['started'])
    const first = await pid(terminated)
    await started.promise
    input.write(frame({ type: 'cancel', id: 2 }))
    await expect(blocked).rejects.toThrow('its worker was terminated')
    await expect.poll(() => exists(first)).toBe(false)

    const crashed = join(directory, 'crashed')
    const failing = run(peer, async ({ node, script, file }: { node: string; script: string; file: string }, env) => {
      env.exec([node, '-e', script]).catch(() => {
        // The run's end kills this child; its rejection is expected.
      })
      while (await env.fs.readFile(file, 'utf8').catch(() => '') === '') {
        // Wait for the child to record its pid before the worker dies.
      }
      // Shipped code can reach its worker's `process` through any function constructor. Without the worker's handler,
      // an exception no code catches ends the worker.
      const workerProcess = (new (env.signal.constructor.constructor as FunctionConstructor)('return process') as () => NodeJS.Process)()
      workerProcess.removeAllListeners('uncaughtException')
      return await new Promise(() => {
        setTimeout(() => { throw new Error('worker crashed') }, 0)
      })
    }, { node, script: script(crashed), file: crashed })
    const failed = expect(failing).rejects.toThrow(/^worker crashed$/)
    const second = await pid(crashed)
    await failed
    await expect.poll(() => exists(second)).toBe(false)
  })

  it('fails only the run whose code throws outside it or whose worker exits or dies, and keeps serving', async () => {
    const { peer } = await daemon()
    await expect(run(peer, () => new Promise(() => {
      setTimeout(() => { throw Object.assign(new TypeError('uncaught'), { code: 'E_UNCAUGHT' }) }, 0)
    }))).rejects.toMatchObject({ name: 'TypeError', message: 'uncaught', code: 'E_UNCAUGHT' })
    await expect(run(peer, () => new Promise(() => {
      setTimeout(() => { throw 'text' }, 0)
    }))).rejects.toThrow(/^text$/)
    // Shipped code can reach its worker's `process` through any function constructor.
    await expect(run(peer, (_args: null, env) => {
      const constructor = env.signal.constructor.constructor as FunctionConstructor
      const workerProcess = (new constructor('return process') as () => NodeJS.Process)()
      workerProcess.exit(3)
    })).rejects.toThrow(/^Execution environment worker exited with code 3 during the run$/)
    // Without the worker's handler, an exception no code catches ends the worker and fails its run.
    for (const [thrown, failure] of [['new RangeError("fatal")', { name: 'RangeError', message: 'fatal' }], ['"fatal text"', { name: 'Error', message: 'fatal text' }]] as const) {
      await expect(run(peer, (value: string, env) => {
        const constructor = env.signal.constructor.constructor as FunctionConstructor
        const workerProcess = (new constructor('return process') as () => NodeJS.Process)()
        workerProcess.removeAllListeners('uncaughtException')
        const fail = new constructor(`throw ${value}`) as () => never
        return new Promise(() => {
          setTimeout(fail, 0)
        })
      }, thrown)).rejects.toMatchObject(failure)
    }
    await expect(run(peer, () => 'replaced')).resolves.toBe('replaced')
    expect(peer.failed).toBe(false)
  })

  it('keeps code a finished run leaves behind from failing later runs on its worker', async () => {
    const written = stderr()
    const { peer } = await daemon()
    await expect(run(peer, (_args: null, env) => {
      AbortSignal.timeout(50).addEventListener('abort', () => { throw new Error('timeout listener of a finished run') })
      env.signal.addEventListener('abort', () => { throw new Error('abort listener of a finished run') })
      return 'first'
    })).resolves.toBe('first')
    // The pool's only worker serves this run, past the moment the first run's timeout would have fired.
    await expect(run(peer, async () => {
      await new Promise(resolve => setTimeout(resolve, 100))
      return 'second'
    })).resolves.toBe('second')
    await expect.poll(() => written.join('')).toContain('execution environment worker: uncaught exception outside a run: abort listener of a finished run')
    expect(written.join('')).not.toContain('timeout listener of a finished run')
  })

  it('reports an error whose fields are not strings by their text, keeping the connection and its other runs', async () => {
    const { peer } = await daemon()
    const other = run(peer, async () => {
      await new Promise(resolve => setTimeout(resolve, 100))
      return 'other'
    })
    await expect(run(peer, () => { throw Object.assign(new Error('bad name'), { name: 42 }) })).rejects.toMatchObject({ name: '42', message: 'bad name' })
    await expect(other).resolves.toBe('other')
    expect(peer.failed).toBe(false)
  })

  it('reports a rejection that shipped code drops without ending its run', async () => {
    const written = stderr()
    const { peer } = await daemon()
    await expect(run(peer, async () => {
      void Promise.reject(new Error('dropped'))
      await new Promise(resolve => setTimeout(resolve, 50))
      return 'survived'
    })).resolves.toBe('survived')
    await expect.poll(() => written.join('')).toContain('execution environment worker: unhandled rejection: dropped')
  })

  it('does not reject a non-zero exit and reports stderr and signals', async () => {
    const { peer } = await daemon()
    await expect(run(peer, (args: string, env) => env.exec([args, '-e', 'console.error("bad"); process.exit(3)']), node)).resolves
      .toEqual({ exitCode: 3, signal: null, stdout: '', stderr: 'bad\n' })
    await expect(run(peer, (args: string, env) => env.exec([args, '-e', 'process.kill(process.pid, "SIGKILL")']), node)).resolves
      // Windows reports a forced termination as exit code 1 without a signal name.
      .toEqual(expect.objectContaining(process.platform === 'win32' ? { exitCode: 1, signal: null } : { exitCode: null, signal: 'SIGKILL' }))
  })

  it('rejects empty argv, spawn failures and output beyond the message size', async () => {
    const { peer } = await daemon(undefined, { maxFrameBytes: 1024, maxMessageBytes: 4096 })
    await expect(run(peer, (_args: null, env) => env.exec([]))).rejects.toThrow('exec requires a command')
    await expect(run(peer, (_args: null, env) => env.exec(['/nonexistent/dsh-environment']))).rejects.toThrow('ENOENT')
    await expect(run(peer, (args: string, env) => env.exec([args, '-e', 'process.stdout.write("x".repeat(100000))']), node)).rejects
      .toThrow('exec output exceeds 4096 bytes')
  })

  it('aborts env.signal and its processes when the host cancels a run', async () => {
    const started = Promise.withResolvers<undefined>()
    const { peer } = await daemon(async () => { started.resolve(undefined) })
    const controller = new AbortController()
    const pending = run(peer, async (args: string, env) => {
      return await Promise.all([env.exec([args, '-e', 'setInterval(() => {}, 1000)']), env.origin.started!()])
    }, node, controller.signal, ['started'])
    await started.promise
    controller.abort(new Error('cancelled'))
    await expect(pending).rejects.toThrow('cancelled')
  })

  it('reports errors thrown in the run context with their name, message and string code', async () => {
    const { peer } = await daemon()
    const typed = run(peer, () => { throw Object.assign(new TypeError('remote failure'), { code: 'E_REMOTE' }) })
    await expect(typed).rejects.toBeInstanceOf(RemoteRequestError)
    await expect(typed).rejects.toMatchObject({ name: 'TypeError', message: 'remote failure', code: 'E_REMOTE' })
    await expect(run(peer, async (_args: null, env) => await env.fs.readFile('/nonexistent/dsh-environment-daemon')))
      .rejects.toMatchObject({ name: 'Error', code: 'ENOENT' })
  })

  it('rejects exec and origin calls inside the function with the name, message and code of their errors', async () => {
    const { peer } = await daemon(async () => { throw Object.assign(new RangeError('denied'), { code: 'E_DENIED' }) })
    await expect(run(peer, async (_args: null, env) => {
      const fields = (error: unknown) => {
        const { name, message, code } = error as Error & { code?: string }
        return { name, message, code }
      }
      return {
        exec: await env.exec(['/nonexistent/dsh-environment']).then(() => null, fields),
        origin: await env.origin.check!().then(() => null, fields),
      }
    }, null, undefined, ['check'])).resolves.toEqual({
      exec: { name: 'Error', message: expect.stringContaining('ENOENT') as string, code: 'ENOENT' },
      origin: { name: 'RangeError', message: 'denied', code: 'E_DENIED' },
    })
  })

  it('reports a result or origin parameters that structured clone cannot copy', async () => {
    const { peer } = await daemon()
    const uncloneable = 'Execution environment cannot send a value that structured clone does not support: () => 1 could not be cloned.'
    await expect(run(peer, () => ({ callback: () => 1 }))).rejects.toThrow(uncloneable)
    await expect(run(peer, (_args: null, env) => env.origin.call!(() => 1), null, undefined, ['call'])).rejects.toThrow(uncloneable)
  })

  it('ends processes a run leaves running when the run returns', async () => {
    directory = await mkdtemp(join(tmpdir(), 'dsh-remote-daemon-'))
    const pidFile = join(directory, 'pid')
    const { peer } = await daemon()
    const pid = Number(await run(peer, async ({ node, file }: { node: string; file: string }, env) => {
      env.exec([node, '-e', `require('fs').writeFileSync(${JSON.stringify(file)}, String(process.pid)); setInterval(() => {}, 1000)`]).catch(() => {
        // The run ends this child on return; its rejection is expected.
      })
      for (;;) {
        const text = await env.fs.readFile(file, 'utf8').catch(() => '')
        if (text !== '') return text
      }
    }, { node, file: pidFile }))
    await expect.poll(() => exists(pid)).toBe(false)
  })

  it('runs keepNames-transformed sources whose nested helpers call __name', async () => {
    const { peer } = await daemon()
    const source = '(args) => { const helper = __name(() => args + 1, "helper"); return helper() }'
    await expect(peer.request('run', { run: 1, ...shipped(source), args: 1 })).resolves.toBe(2)
  })

  it('kills the process group of an exec that ignores SIGTERM after the run returns', async () => {
    directory = await mkdtemp(join(tmpdir(), 'dsh-remote-daemon-'))
    const pidFile = join(directory, 'pids')
    const script = [
      "process.on('SIGTERM', () => {})",
      "const grandchild = require('child_process').spawn(process.execPath, ['-e', 'process.on(\"SIGTERM\", () => {}); setInterval(() => {}, 1000)'], { stdio: 'ignore' })",
      `require('fs').writeFileSync(${JSON.stringify(pidFile)}, process.pid + ' ' + grandchild.pid)`,
      'setInterval(() => {}, 1000)',
    ].join('; ')
    const { peer } = await daemon()
    const pids = String(await run(peer, async ({ node, file, script }: { node: string; file: string; script: string }, env) => {
      env.exec([node, '-e', script]).catch(() => {
        // The run ends this child on return; its rejection is expected.
      })
      for (;;) {
        const text = await env.fs.readFile(file, 'utf8').catch(() => '')
        if (text !== '') return text
      }
    }, { node, file: pidFile, script })).split(' ').map(Number)
    // Windows has no process groups, so only the direct child is terminated there.
    const expected = process.platform === 'win32' ? pids.slice(0, 1) : pids
    await expect.poll(() => expected.filter(exists)).toEqual([])
    // Windows ends the child on SIGTERM; wait past the 100 ms grace so the SIGKILL escalation also runs there.
    await new Promise(resolve => setTimeout(resolve, 300))
    if (process.platform === 'win32') {
      try {
        process.kill(pids[1]!)
      } catch (error) {
        // ESRCH: the grandchild already exited, which is the cleanup this step ensures.
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
      }
    }
  })

  it('rejects sources that are not functions, invalid run parameters and unknown methods', async () => {
    const { peer } = await daemon()
    await expect(peer.request('run', { run: 1, ...shipped('1'), args: null })).rejects.toThrow('must evaluate to a function')
    // Origin method names travel only inside the definition.
    await expect(peer.request('run', { run: 1, ...shipped('x => x'), args: null, methods: [] })).rejects
      .toThrow(String.raw`Unrecognized key: \"methods\"`)
    const { hash } = shipped('x => x')
    await expect(peer.request('run', { run: 1, hash, definition: { source: 'x => x' }, args: null })).rejects.toThrow('"methods"')
    await expect(peer.request('run', { run: 1, hash: 'not-a-hash', definition: { source: 'x => x', methods: [] }, args: null })).rejects.toThrow('"hash"')
    await expect(peer.request('run', { run: 1, hash, definition: { source: 'x => x', methods: [1] }, args: null })).rejects.toThrow('expected string')
    await expect(peer.request('other', null)).rejects.toThrow('Unknown execution environment method: other')
  })

  it('waits for busy runs to stop when the host disconnects, terminating one that does not', async () => {
    directory = await mkdtemp(join(tmpdir(), 'dsh-remote-daemon-'))
    const { peer, input, closed } = await daemon(undefined, bounds, 400)
    const file = (name: string): string => join(directory!, name)
    // The functions report through files, so the host writes nothing that could follow the end of its stream.
    const honoured = run(peer, async (files: { ready: string; cleaned: string }, env) => {
      const aborted = new Promise((resolve) => { env.signal.addEventListener('abort', resolve) })
      await env.fs.writeFile(files.ready, 'ready')
      await aborted
      await env.fs.writeFile(files.cleaned, String(env.signal.reason))
    }, { ready: file('honoured'), cleaned: file('cleaned') })
    const blocked = run(peer, async (ready: string, env) => {
      await env.fs.writeFile(ready, 'ready')
      return /^(a+)+$/.test(`${'a'.repeat(64)}!`)
    }, file('blocked'))
    await expect.poll(async () => await Promise.all([access(file('honoured')), access(file('blocked'))]).then(() => true, () => false)).toBe(true)
    input.end()
    await expect(honoured).rejects.toThrow()
    await expect(blocked).rejects.toThrow()
    expect((await closed).name).toBe('RpcDisconnectedError')
    // The worker received the abort reason with its name; the daemon waited for the cleanup it allowed.
    expect(await readFile(file('cleaned'), 'utf8')).toBe('RpcDisconnectedError: Execution environment peer disconnected; the outcome of pending requests is unknown')
  })

  it('resolves its lifetime with the host disconnect', async () => {
    const { input, closed } = await daemon()
    input.end()
    expect((await closed).name).toBe('RpcDisconnectedError')
  })
})
