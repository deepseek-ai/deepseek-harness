/**
 * Execution environment daemon connection: authenticates one host connection, then serves its `run` requests over a
 * byte stream pair. Each run occupies one worker thread of the connection's pool, which evaluates the function source
 * in a fresh `node:vm` context; `exec` processes and origin calls stay on the main thread. The connection keeps the
 * definitions it receives, function sources with their origin method names, by hash until it closes; nothing survives
 * the connection.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import type { Readable, Writable } from 'node:stream'
import { Worker } from 'node:worker_threads'
import { z } from 'zod'
import {
  asError, definitionHash, HANDSHAKE_LIMITS, ENVIRONMENT_PROTOCOL_VERSION, MIN_LIMIT_BYTES, RpcPeer, type RunDefinition, type ThrownFields,
} from './protocol.ts'
import type { EnvironmentAuthMechanism, EnvironmentExecResult } from './types.ts'
import { runWorker, type FromWorker, type ToWorker, type WorkerError } from './worker-loop.ts'

const positive = z.number().int().positive().max(2_147_483_647)
/** The `auth` request: protocol version, the host's mechanisms and the limits for this connection. */
const authRequestSchema = z.object({
  protocol: z.number(),
  mechanisms: z.array(z.string()),
  limits: z.object({
    maxFrameBytes: positive.min(MIN_LIMIT_BYTES), maxMessageBytes: positive.min(MIN_LIMIT_BYTES),
    maxPending: positive, cancelGraceMs: positive, killGraceMs: positive,
  }).strict().refine(({ maxFrameBytes, maxMessageBytes }) => maxFrameBytes <= maxMessageBytes, {
    message: 'maxFrameBytes must not exceed maxMessageBytes', path: ['maxFrameBytes'],
  }),
}).strict()
/** A `run` request names its definition by hash and carries the definition until the connection holds it. */
const runSchema = z.object({
  run: z.number().int().positive(), hash: z.string().regex(/^[0-9a-f]{64}$/),
  definition: z.object({ source: z.string(), methods: z.array(z.string()) }).strict().optional(), args: z.unknown(),
}).strict()

/**
 * Code of every worker thread. A worker cannot load a second file, so it evaluates the text of `runWorker`; the no-op
 * `__name` serves esbuild `keepNames` output. An exception or rejection that shipped code leaves uncaught goes to the
 * handlers `runWorker` returns instead of ending the worker.
 */
const WORKER_CODE = `'use strict';
const __name = (target) => target;
const handlers = (${runWorker.toString()})(process.getBuiltinModule('node:worker_threads').parentPort);
process.on('uncaughtException', handlers.uncaughtException);
process.on('unhandledRejection', handlers.unhandledRejection);
`

/** Streams of one host connection and the authentication its execution endpoint accepts. */
export interface ConnectionOptions {
  /** Frames from the host. */
  readonly input: Readable
  /** Frames to the host. */
  readonly output: Writable
  /** Mechanisms the endpoint accepts, in preference order; a channel that does not authenticate never lists `transport`. */
  readonly mechanisms: readonly EnvironmentAuthMechanism[]
  /** Time the host has to complete `auth` before the connection closes. */
  readonly authTimeoutMs: number
  /** Closes the connection and aborts its runs when aborted. */
  readonly signal?: AbortSignal
}

/** Limits the host set with `auth`. */
interface Session {
  readonly maxMessageBytes: number
  readonly killGraceMs: number
  readonly cancelGraceMs: number
}

/** One worker thread of a connection's pool. */
interface PooledWorker {
  readonly thread: Worker
  /** Resolves once the thread has exited. */
  readonly exited: Promise<void>
  /** Whether the worker failed, exited or is terminating; a retired worker takes no further run. */
  retired: boolean
}

/**
 * Serve one host connection until it closes. Every request before a successful `auth` other than `auth` is refused.
 * @param options - streams and accepted mechanisms.
 * @returns the close reason once the host disconnects or the protocol fails, after the connection's workers and
 * `exec` process groups have ended.
 */
export function serveConnection(options: ConnectionOptions): Promise<Error> {
  let session: Session | undefined
  const processes = new Set<Promise<void>>()
  const definitions = new Map<string, RunDefinition>()
  const workers = new Set<PooledWorker>()
  const idle = new Set<PooledWorker>()
  let closed = false
  const deadline = setTimeout(() => {
    peer.close(new Error(`Execution environment host did not authenticate within ${options.authTimeoutMs} ms`))
  }, options.authTimeoutMs)

  /** The definition a run names; a shipped definition is verified and kept for later runs of this connection. */
  const admit = (hash: string, definition: RunDefinition | undefined): RunDefinition => {
    if (definition === undefined) {
      const known = definitions.get(hash)
      if (known === undefined) throw new Error(`Execution environment connection holds no definition with hash ${hash}`)
      return known
    }
    if (definitionHash(definition) !== hash) throw new Error(`Execution environment definition does not match its hash ${hash}`)
    definitions.set(hash, definition)
    return definition
  }

  const retire = (worker: PooledWorker): void => {
    worker.retired = true
    idle.delete(worker)
  }
  const terminate = (worker: PooledWorker): void => {
    retire(worker)
    void worker.thread.terminate()
  }
  const acquire = (): PooledWorker => {
    const { value: reused } = idle.values().next()
    if (reused !== undefined) {
      idle.delete(reused)
      return reused
    }
    const thread = new Worker(WORKER_CODE, { eval: true, stdout: true })
    // Standard output carries the protocol, so worker output is discarded.
    thread.stdout.resume()
    const exited = Promise.withResolvers<void>()
    const worker: PooledWorker = { thread, exited: exited.promise, retired: false }
    // A run in progress fails through its own listeners; an idle worker that fails is only dropped.
    thread.on('error', () => { retire(worker) })
    thread.on('exit', () => {
      retire(worker)
      workers.delete(worker)
      exited.resolve()
    })
    workers.add(worker)
    return worker
  }
  const release = (worker: PooledWorker): void => {
    if (worker.retired) return
    if (closed) terminate(worker)
    else idle.add(worker)
  }

  const execute = async (
    { maxMessageBytes, killGraceMs, cancelGraceMs }: Session, run: number,
    request: Omit<Extract<ToWorker, { type: 'run' }>, 'type' | 'limits'>, signal: AbortSignal,
  ): Promise<unknown> => {
    // Ending the run also ends the processes and origin calls it left running.
    const finished = new AbortController()
    const runSignal = AbortSignal.any([signal, finished.signal])
    const worker = acquire()
    const { thread } = worker
    const outcome = Promise.withResolvers<unknown>()
    const post = (message: ToWorker): void => { thread.postMessage(message) }
    const answer = (id: number, pending: Promise<unknown>): void => {
      void pending.then(value => ({ value }), (error: unknown) => ({ error: describeError(error) })).then((settled) => {
        post({ type: 'settle', id, outcome: settled })
      })
    }
    const onMessage = (message: FromWorker): void => {
      switch (message.type) {
        case 'exec': {
          const pending = exec(message.argv, { ...message.options, maxBytes: maxMessageBytes, killGraceMs, signal: runSignal })
          const settled = pending.then(() => {}, () => {
            // The worker receives the failure; shutdown only waits for process cleanup.
          })
          processes.add(settled)
          void settled.then(() => { processes.delete(settled) })
          answer(message.id, pending)
          return
        }
        case 'call':
          answer(message.id, peer.request('call', { run, method: message.method, params: message.params }, runSignal))
          return
        case 'settle':
          if ('error' in message.outcome) outcome.reject(reviveError(message.outcome.error))
          else outcome.resolve(message.outcome.value)
      }
    }
    const onError = (error: unknown): void => { outcome.reject(reviveError(describeError(error))) }
    const onExit = (code: number): void => {
      outcome.reject(new Error(`Execution environment worker exited with code ${code} during the run`))
    }
    // Half of the host's grace leaves the answer time to arrive before the host closes the connection.
    const stopMs = Math.floor(cancelGraceMs / 2)
    let stopping: NodeJS.Timeout | undefined
    const cancel = (): void => {
      post({ type: 'cancel', reason: describeError(signal.reason) })
      stopping = setTimeout(() => {
        outcome.reject(new Error(`Execution environment run did not stop within ${stopMs} ms of its cancellation; its worker was terminated`))
        terminate(worker)
      }, stopMs)
    }
    thread.on('message', onMessage).on('error', onError).on('exit', onExit)
    signal.addEventListener('abort', cancel, { once: true })
    try {
      post({ type: 'run', ...request, limits: { maxMessageBytes } })
      return await outcome.promise
    } finally {
      signal.removeEventListener('abort', cancel)
      clearTimeout(stopping)
      thread.off('message', onMessage).off('error', onError).off('exit', onExit)
      finished.abort(new Error('Execution environment run finished'))
      release(worker)
    }
  }

  const peer: RpcPeer = new RpcPeer(options.input, options.output, HANDSHAKE_LIMITS, async (method, params, signal) => {
    if (method === 'auth') {
      if (session !== undefined) throw new Error('Execution environment connection is already authenticated')
      const request = authRequestSchema.parse(params)
      if (request.protocol !== ENVIRONMENT_PROTOCOL_VERSION) {
        throw new Error(`Execution environment daemon speaks protocol ${ENVIRONMENT_PROTOCOL_VERSION}; the host speaks ${request.protocol}`)
      }
      const mechanism = options.mechanisms.find(accepted => request.mechanisms.includes(accepted))
      if (mechanism === undefined) {
        throw new Error(`Execution environment daemon accepts ${options.mechanisms.join(', ')}; the host offered ${request.mechanisms.join(', ')}`)
      }
      const { killGraceMs, ...limits } = request.limits
      peer.setLimits(limits)
      clearTimeout(deadline)
      session = { maxMessageBytes: limits.maxMessageBytes, killGraceMs, cancelGraceMs: limits.cancelGraceMs }
      return { mechanism }
    }
    if (session === undefined) throw new Error('Execution environment connection is not authenticated')
    switch (method) {
      case 'run': {
        const { run, hash, definition, args } = runSchema.parse(params)
        return await execute(session, run, { hash, ...admit(hash, definition), args }, signal)
      }
      default: throw new Error(`Unknown execution environment method: ${method}`)
    }
  })
  const stop = (): void => { peer.close(asError(options.signal?.reason)) }
  options.signal?.addEventListener('abort', stop, { once: true })
  return peer.closed.then(async (reason) => {
    clearTimeout(deadline)
    options.signal?.removeEventListener('abort', stop)
    closed = true
    for (const worker of idle) terminate(worker)
    // A busy worker ends once its run settles, which cancellation bounds by half of the grace.
    await Promise.all(Array.from(workers, worker => worker.exited))
    await Promise.all(processes)
    return reason
  })
}

/* jscpd:ignore-start -- the worker loop repeats these conversions because a worker evaluates one self-contained
   function and cannot import them. */
/**
 * Error fields sent to a worker. Errors from a worker's `error` event are not native errors of this realm, and their
 * fields need not be strings.
 */
function describeError(error: unknown): WorkerError {
  if (!(error instanceof Error)) return { name: 'Error', message: String(error) }
  const { name, message, code }: ThrownFields = error
  const failure = { name: String(name), message: String(message) }
  return typeof code === 'string' ? { ...failure, code } : failure
}

/** Re-create an error a worker described, with its name, message and string code. */
function reviveError({ name, message, code }: WorkerError): Error {
  return Object.assign(new Error(message), code === undefined ? { name } : { name, code })
}
/* jscpd:ignore-end */

interface ExecOptions {
  readonly cwd?: string | undefined
  readonly input?: string | undefined
  readonly maxBytes: number
  readonly killGraceMs: number
  readonly signal: AbortSignal
}

/* v8 ignore start -- one branch per platform; each platform's CI lane exercises its own. */
/** Signal the child's process group on POSIX, where the child leads its own group, and the child on Windows. */
function signalTree(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    if (process.platform === 'win32' || child.pid === undefined) child.kill(signal)
    else process.kill(-child.pid, signal)
  } catch (error) {
    // ESRCH: the whole group already exited, which is the outcome the signal asks for.
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
  }
}
/* v8 ignore stop */

async function exec(argv: readonly string[], { cwd, input, maxBytes, killGraceMs, signal }: ExecOptions): Promise<EnvironmentExecResult> {
  const [command, ...args] = argv
  if (command === undefined) return Promise.reject(new TypeError('exec requires a command'))
  let escalation: Promise<void> | undefined
  try {
    return await new Promise<EnvironmentExecResult>((resolve, reject) => {
      // An exec started after its run ended rejects instead of leaving an untracked process.
      signal.throwIfAborted()
      const child = spawn(command, args, { cwd, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] })
      const output = { stdout: [] as Buffer[], stderr: [] as Buffer[] }
      let bytes = 0
      let failure: Error | undefined
      for (const stream of ['stdout', 'stderr'] as const) {
        child[stream].on('data', (chunk: Buffer) => {
          if (failure !== undefined) return
          bytes += chunk.length
          if (bytes > maxBytes) {
            failure = new Error(`exec output exceeds ${maxBytes} bytes`)
            signalTree(child, 'SIGKILL')
            return
          }
          output[stream].push(chunk)
        })
      }
      const abort = (): void => {
        failure ??= asError(signal.reason)
        signalTree(child, 'SIGTERM')
        // The group may outlive its direct child; shutdown waits until escalation reaches it.
        escalation = new Promise(resolve => setTimeout(() => {
          signalTree(child, 'SIGKILL')
          resolve()
        }, killGraceMs))
      }
      signal.addEventListener('abort', abort, { once: true })
      child.on('error', (error) => { failure ??= error })
      child.on('close', (exitCode, exitSignal) => {
        signal.removeEventListener('abort', abort)
        if (failure !== undefined) reject(failure)
        else resolve({ exitCode, signal: exitSignal, stdout: Buffer.concat(output.stdout).toString('utf8'), stderr: Buffer.concat(output.stderr).toString('utf8') })
      })
      // EPIPE from a child that exits without reading stdin is not an exec failure.
      /* v8 ignore next -- depends on the child closing stdin before the write completes. */
      child.stdin.on('error', () => {})
      child.stdin.end(input)
    })
  } finally {
    await escalation
  }
}
