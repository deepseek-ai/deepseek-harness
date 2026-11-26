import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MessageChannel, type MessagePort } from 'node:worker_threads'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { EnvironmentContext, EnvironmentHostHandler } from '../src/types.ts'
import { runWorker, type FromWorker, type ToWorker, type WorkerOutcome } from '../src/worker-loop.ts'

/** The worker loop runs in this process over a port pair, where coverage can observe it. */

const ports: MessagePort[] = []
const limits = { maxMessageBytes: 4096 }
/** The text both the worker and the connection report for a value that structured clone cannot copy. */
const uncloneable = 'Execution environment cannot send a value that structured clone does not support: () => 1 could not be cloned.'
let directory: string | undefined

afterEach(async () => {
  vi.restoreAllMocks()
  for (const port of ports.splice(0)) port.close()
  if (directory !== undefined) await rm(directory, { recursive: true, force: true })
  directory = undefined
})

type Request = Exclude<FromWorker, { type: 'settle' }>
type Shipped = string | ((args: never, env: EnvironmentContext<Record<string, EnvironmentHostHandler>>) => unknown)

/**
 * Start a worker loop answered by `answer`; an undefined answer leaves the request pending.
 * @returns a function posting one run and resolving with its outcome, the recorded requests, a raw sender, and the
 * handlers a worker's `process` events would call.
 */
function start(answer: (request: Request) => WorkerOutcome | undefined = () => ({ value: null })) {
  const { port1, port2 } = new MessageChannel()
  ports.push(port1, port2)
  const handlers = runWorker(port1)
  const requests: Request[] = []
  const outcomes: PromiseWithResolvers<WorkerOutcome>[] = []
  port2.on('message', (message: FromWorker) => {
    if (message.type === 'settle') {
      outcomes.shift()?.resolve(message.outcome)
      return
    }
    requests.push(message)
    const outcome = answer(message)
    if (outcome !== undefined) send({ type: 'settle', id: message.id, outcome })
  })
  const send = (message: ToWorker): void => { port2.postMessage(message) }
  const run = (fn: Shipped, args: unknown = null, methods: readonly string[] = [], hash = String(fn)): Promise<WorkerOutcome> => {
    const outcome = Promise.withResolvers<WorkerOutcome>()
    outcomes.push(outcome)
    send({ type: 'run', hash, source: String(fn), args, methods, limits })
    return outcome.promise
  }
  return { run, requests, send, handlers }
}

/** Collect what the worker loop writes to standard error. */
function stderr(): string[] {
  const written: string[] = []
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
    written.push(Buffer.from(chunk).toString('utf8'))
    return true
  })
  return written
}

describe('execution environment worker loop', () => {
  it('evaluates each run in a fresh context and compiles the source of each hash once', async () => {
    const { run } = start()
    await expect(run('(n) => n + 1', 1, [], 'h')).resolves.toEqual({ value: 2 })
    // The worker trusts the hash, so a second source under the same definition hash runs the compiled first one.
    await expect(run('() => 0', 2, [], 'h')).resolves.toEqual({ value: 3 })
    await expect(run('() => { globalThis.leak = 1; return typeof leak }')).resolves.toEqual({ value: 'number' })
    await expect(run('() => typeof leak')).resolves.toEqual({ value: 'undefined' })
    await expect(run('(args) => __name(() => args, "named")()', 'kept')).resolves.toEqual({ value: 'kept' })
    await expect(run('(_args, env) => env.limits')).resolves.toEqual({ value: limits })
  })

  it('reports failures by name, message and string code', async () => {
    const { run } = start()
    await expect(run('() => { throw Object.assign(new TypeError("typed"), { code: "E_TYPED" }) }')).resolves
      .toEqual({ error: { name: 'TypeError', message: 'typed', code: 'E_TYPED' } })
    await expect(run('async () => { throw Object.assign(new Error("numbered"), { code: 7 }) }')).resolves
      .toEqual({ error: { name: 'Error', message: 'numbered' } })
    await expect(run('() => { throw "text" }')).resolves.toEqual({ error: { name: 'Error', message: 'text' } })
    await expect(run('1')).resolves
      .toEqual({ error: { name: 'TypeError', message: 'Execution environment source must evaluate to a function' } })
    const syntax = await run('(')
    expect('error' in syntax && syntax.error.name).toBe('SyntaxError')
    await expect(run('() => () => 1')).resolves.toEqual({ error: { name: 'Error', message: uncloneable } })
    await expect(run('() => { throw Object.create(null) }')).resolves
      .toEqual({ error: { name: 'Error', message: 'Execution environment run threw a value that cannot be described' } })
    await expect(run(() => 'described again')).resolves.toEqual({ value: 'described again' })
    // Fields that are not strings are sent as their text.
    await expect(run('() => { throw Object.assign(new Error("bad name"), { name: 42 }) }')).resolves
      .toEqual({ error: { name: '42', message: 'bad name' } })
  })

  it('fails the run in progress with an exception no code caught, and reports one between runs', async () => {
    const written = stderr()
    const started = Promise.withResolvers<undefined>()
    const later = Promise.withResolvers<number>()
    const { run, send, handlers } = start((request) => {
      if (request.type === 'call' && request.method === 'started') started.resolve(undefined)
      if (request.type === 'call' && request.method === 'later') later.resolve(request.id)
      return request.type === 'call' && request.method === 'started' ? { value: null } : undefined
    })
    const failing = run(async (_args: null, env) => {
      await env.origin.started!()
      return await env.origin.later!()
    }, null, ['started', 'later'])
    await started.promise
    const id = await later.promise
    // The worker's `process` delivers exceptions no code caught to this handler.
    handlers.uncaughtException(Object.assign(new RangeError('thrown by a callback'), { code: 'E_CALLBACK' }))
    await expect(failing).resolves.toEqual({ error: { name: 'RangeError', message: 'thrown by a callback', code: 'E_CALLBACK' } })
    // The failed run's function settles later without sending a second outcome, which the next run would receive.
    send({ type: 'settle', id, outcome: { value: 'late' } })
    handlers.uncaughtException(new Error('left over from a finished run'))
    handlers.unhandledRejection('dropped')
    await expect(run(() => 'still serving')).resolves.toEqual({ value: 'still serving' })
    expect(written.join('')).toBe([
      'execution environment worker: uncaught exception outside a run: left over from a finished run\n',
      'execution environment worker: unhandled rejection: dropped\n',
    ].join(''))
  })

  it('ends the timers of AbortSignal.timeout with their run and keeps the rest of AbortSignal', async () => {
    directory = await mkdtemp(join(tmpdir(), 'dsh-environment-worker-'))
    const { run } = start()
    await expect(run(async () => {
      const fired = await new Promise((resolve) => {
        AbortSignal.timeout(1).addEventListener('abort', (event) => { resolve(((event.target as AbortSignal).reason as Error).name) })
      })
      const invalid = (() => {
        try {
          AbortSignal.timeout(-1)
          return 'accepted'
        } catch (error) {
          return (error as Error).message
        }
      })()
      return { fired, invalid, any: AbortSignal.any([AbortSignal.abort()]).aborted, instance: AbortSignal.abort() instanceof AbortSignal }
    })).resolves.toEqual({
      value: { fired: 'TimeoutError', invalid: 'AbortSignal.timeout requires an integer delay from 0 to 4294967295; received -1', any: true, instance: true },
    })
    const late = join(directory, 'late')
    await expect(run((file: string, env) => {
      AbortSignal.timeout(20).addEventListener('abort', () => { void env.fs.writeFile(file, 'fired') })
      return 'ended'
    }, late)).resolves.toEqual({ value: 'ended' })
    await new Promise(resolve => setTimeout(resolve, 100))
    await expect(access(late)).rejects.toThrow('ENOENT')
  })

  it('relays exec and origin requests with ids that grow across runs', async () => {
    const { run, requests, send } = start((request) => {
      if (request.type === 'exec') {
        return request.argv[0] === 'missing'
          ? { error: { name: 'Error', message: 'spawn missing ENOENT', code: 'ENOENT' } }
          : { value: { exitCode: 0, signal: null, stdout: 'out', stderr: '' } }
      }
      if (request.method === 'later') return undefined
      if (request.method === 'fail') return { error: { name: 'RemoteRequestError', message: 'refused' } }
      return { value: request.params ?? 'omitted' }
    })
    await expect(run(async (_args: null, env) => {
      const failed = await env.exec(['missing']).catch((error: unknown) => {
        const { name, message, code } = error as NodeJS.ErrnoException
        return { name, message, code }
      })
      const unsent = await env.origin.echo!(() => 1).catch((error: unknown) => (error as Error).message)
      // A request this run leaves unanswered settles only when its own reply arrives.
      void env.origin.later!()
      const refused = await env.origin.fail!().catch((error: unknown) => {
        const { name, message, code } = error as NodeJS.ErrnoException
        return { name, message, coded: code !== undefined }
      })
      return [await env.exec(['node', '-v'], { cwd: '/tmp', input: 'in' }), failed, unsent, refused, await env.origin.echo!('text'), await env.origin.echo!()]
    }, null, ['echo', 'later', 'fail'])).resolves.toEqual({
      value: [
        { exitCode: 0, signal: null, stdout: 'out', stderr: '' }, { name: 'Error', message: 'spawn missing ENOENT', code: 'ENOENT' },
        uncloneable, { name: 'RemoteRequestError', message: 'refused', coded: false }, 'text', 'omitted',
      ],
    })
    await expect(run((_args: null, env) => env.origin.echo!('second'), null, ['echo'])).resolves.toEqual({ value: 'second' })
    expect(requests).toEqual([
      { type: 'exec', id: 1, argv: ['missing'], options: { cwd: undefined, input: undefined } },
      { type: 'call', id: 3, method: 'later', params: undefined },
      { type: 'call', id: 4, method: 'fail', params: undefined },
      { type: 'exec', id: 5, argv: ['node', '-v'], options: { cwd: '/tmp', input: 'in' } },
      { type: 'call', id: 6, method: 'echo', params: 'text' },
      { type: 'call', id: 7, method: 'echo', params: undefined },
      { type: 'call', id: 8, method: 'echo', params: 'second' },
    ])
    // Replies to unknown or finished requests change nothing.
    send({ type: 'settle', id: 3, outcome: { value: 'late' } })
    send({ type: 'settle', id: 999, outcome: { error: { name: 'Error', message: 'unknown' } } })
    await expect(run(() => 'still serving')).resolves.toEqual({ value: 'still serving' })
  })

  it('aborts env.signal with the forwarded reason and refuses requests after cancellation or the end of the run', async () => {
    directory = await mkdtemp(join(tmpdir(), 'dsh-environment-worker-'))
    const { run, requests, send } = start(() => undefined)
    // A cancellation that reaches an idle worker changes nothing.
    send({ type: 'cancel', reason: { name: 'Error', message: 'nothing to cancel' } })
    const cancelled = run(async (_args: null, env) => {
      await new Promise((resolve) => { env.signal.addEventListener('abort', resolve) })
      const { name, message, code } = env.signal.reason as NodeJS.ErrnoException
      const refused = await env.exec(['after']).catch((error: unknown) => (error as Error).message)
      return { name, message, code, refused }
    })
    send({ type: 'cancel', reason: { name: 'AbortError', message: 'stop', code: 'E_STOP' } })
    await expect(cancelled).resolves.toEqual({ value: { name: 'AbortError', message: 'stop', code: 'E_STOP', refused: 'stop' } })
    const refusal = join(directory, 'refusal')
    await expect(run((file: string, env) => {
      void env.fs.stat(file).catch(async () => {
        const message = await env.origin.late!().then(() => 'sent', (error: unknown) => (error as Error).message)
        await env.fs.writeFile(file, message)
      })
      return env.signal.aborted
    }, refusal, ['late'])).resolves.toEqual({ value: false })
    await vi.waitFor(async () => { expect(await readFile(refusal, 'utf8')).toBe('Execution environment run finished') })
    expect(requests).toEqual([])
  })

  it('clears pending timers when a run ends and never starts timers for code that outlives its run', async () => {
    directory = await mkdtemp(join(tmpdir(), 'dsh-environment-worker-'))
    const { run } = start()
    const files = { marker: join(directory, 'marker'), late: join(directory, 'late'), pending: join(directory, 'pending') }
    await expect(run(async (paths: { marker: string; late: string; pending: string }, env) => {
      const order: string[] = []
      const cleared = setTimeout(() => { order.push('cleared') }, 0)
      clearTimeout(cleared)
      await new Promise((resolve) => { setTimeout((...values: unknown[]) => { order.push(values.join(' ')); resolve(null) }, 1, 'timer', 'arguments') })
      let ticks = 0
      await new Promise((resolve) => {
        const interval = setInterval(() => {
          if (++ticks < 2) return
          clearInterval(interval)
          resolve(null)
        }, 1)
      })
      const invalid = (() => {
        try {
          // oxlint-disable-next-line typescript/no-implied-eval -- a callback that is not a function must be refused.
          setTimeout(null as never, 1)
          return 'accepted'
        } catch (error) {
          return (error as Error).message
        }
      })()
      let fired = 0
      const refreshed = await new Promise<NodeJS.Timeout>((resolve) => {
        const timer = setTimeout(() => {
          if (++fired > 1) void env.fs.writeFile(paths.pending, 'refreshed')
          resolve(timer)
        }, 1)
      })
      // Refreshing a timeout that already fired schedules it again within this run.
      refreshed.refresh()
      setTimeout(() => { void env.fs.writeFile(paths.pending, 'fired') }, 20)
      setInterval(() => { void env.fs.writeFile(paths.pending, 'fired') }, 20)
      void env.fs.writeFile(paths.marker, 'outlived').then(() => {
        setTimeout(() => { void env.fs.writeFile(paths.late, 'fired') }, 0)
      })
      return { order, ticks, invalid }
    }, files)).resolves.toEqual({ value: { order: ['timer arguments'], ticks: 2, invalid: 'setTimeout requires a callback function' } })
    await vi.waitFor(async () => { expect(await readFile(files.marker, 'utf8')).toBe('outlived') })
    await new Promise(resolve => setTimeout(resolve, 100))
    await expect(access(files.late)).rejects.toThrow('ENOENT')
    await expect(access(files.pending)).rejects.toThrow('ENOENT')
  })
})
