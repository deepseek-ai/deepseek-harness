/**
 * Execution environment service: runs tool-owned functions inside a long-lived
 * daemon on another machine. A tool body splits into daemon-side I/O (the
 * remote function), host-side state changes (handlers the function reaches
 * through `env.origin`, or ordinary code after a call returns) and model-facing
 * formatting (the tool's `output.render`). Transport providers register named
 * environments; each run of a definition names the handle it runs in.
 */

import { Context, Service } from '@deepseek-ai/cordis'
import schema from '@deepseek-ai/schemastery'
import { z } from 'zod'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { EnvironmentError } from './errors.ts'
import { EnvironmentHandle } from './handle.ts'
import {
  asError, definitionHash, ENVIRONMENT_PROTOCOL_VERSION, MIN_LIMIT_BYTES, RemoteRequestError, RpcNotSentError, RpcPeer, type RunDefinition,
} from './protocol.ts'
import type {
  EnvironmentAuthMechanism, EnvironmentChannel, EnvironmentChannelSecurity, EnvironmentConfirmation,
  EnvironmentFunction, EnvironmentHandlers, EnvironmentHostHandler,
  EnvironmentInfo, EnvironmentLimits, EnvironmentTransport, EnvironmentValue,
} from './types.ts'

export { EnvironmentError, type EnvironmentErrorCode } from './errors.ts'
export type { EnvironmentHandle } from './handle.ts'
export type {
  EnvironmentAuthMechanism, EnvironmentChannel, EnvironmentChannelSecurity, EnvironmentConfirmation,
  EnvironmentContext, EnvironmentExecResult, EnvironmentFunction, EnvironmentHandlers, EnvironmentHostHandler, EnvironmentHostKey,
  EnvironmentInfo, EnvironmentLimits, EnvironmentOpenContext, EnvironmentRemoteFailure, EnvironmentTransport, EnvironmentValue,
} from './types.ts'

/** Connection and execution bounds shared by registered environments. */
export interface Config {
  /** Largest frame in either direction; a larger message travels as several frames. At least 1024 and at most `maxMessageBytes`. */
  maxFrameBytes: number
  /**
   * Largest encoded message in either direction: a run's source, arguments and method names, its result, or one origin
   * call or result. It also bounds `exec` output. At least 1024.
   */
  maxMessageBytes: number
  /** Largest number of outstanding runs, and of outstanding host calls from the daemon. */
  maxPending: number
  /**
   * Time the daemon has to answer a cancelled run before the connection closes and the next run reconnects. The daemon
   * terminates the worker thread of a run that has not stopped within half of it.
   */
  cancelGraceMs: number
  /** Time between SIGTERM and SIGKILL for the process groups of a run's remaining `exec` calls. */
  killGraceMs: number
  /** Time to open a channel and complete the handshake, excluding time a person spends confirming trust. */
  connectTimeoutMs: number
}

const positive = z.number().int().positive().max(2_147_483_647)
const configSchema = z.object({
  maxFrameBytes: positive.min(MIN_LIMIT_BYTES), maxMessageBytes: positive.min(MIN_LIMIT_BYTES),
  maxPending: positive, cancelGraceMs: positive, killGraceMs: positive, connectTimeoutMs: positive,
}).strict().refine(({ maxFrameBytes, maxMessageBytes }) => maxFrameBytes <= maxMessageBytes, {
  message: 'maxFrameBytes must not exceed maxMessageBytes', path: ['maxFrameBytes'],
})

const authResponseSchema = z.object({ mechanism: z.literal('transport') }).strict()
const callSchema = z.object({ run: z.number().int().positive(), method: z.string(), params: z.unknown().optional() }).strict()

/** Result validation and origin handlers of one {@link EnvironmentRegistry.define}. */
export type EnvironmentDefineOptions<T, H extends EnvironmentHandlers = Record<never, never>> = {
  /** Validation of the remote function's result. */
  readonly result: z.ZodType<T>
  /**
   * Host-side handlers the remote function reaches through `env.origin`, by name. `define` fixes the names from the
   * object's own property names; every origin call looks its handler up on this object and passes only the
   * parameters the function sends.
   */
  readonly handlers?: H
} & (keyof H extends never ? unknown : { readonly handlers: H })

/**
 * A function defined by {@link EnvironmentRegistry.define}. Each call runs the function at most once with its
 * arguments, in the registration that holds `handle` when the call starts.
 * @param handle - provider-owned identifier selecting the execution environment of this run.
 * @param args - arguments, copied by structured clone.
 * @param options - cancellation and trust confirmation for this run.
 * @returns the validated result. Rejects with a {@link EnvironmentError} whose code names the failure class,
 * a transport's own `HarnessError`, or the caller's abort reason.
 */
export type EnvironmentRunner<A extends EnvironmentValue, T> = (handle: EnvironmentHandle, args: A, options: {
  /** Cancellation; aborts `env.signal` in the daemon and the run's host handler calls, and never rolls back completed remote effects. */
  readonly signal: AbortSignal
  /**
   * Ask a person to agree to a trust decision the transport needs, such as an unknown SSH host key, while the run
   * waits for the connection. Any waiting run that supplies it may be asked; without one such decisions fail with instructions.
   * @param question - the decision and the facts to verify.
   * @returns whether the person agreed.
   */
  readonly confirm?: (question: EnvironmentConfirmation) => Promise<boolean>
}) => Promise<T>

/** Options of one run. */
type CallOptions = Parameters<EnvironmentRunner<EnvironmentValue, unknown>>[2]

/** What every call of one definition sends and validates; `methods` lists the handler names fixed when defining. */
interface Definition<T> extends RunDefinition {
  /** {@link definitionHash} of `source` and `methods`, which names them on a connection that already holds them. */
  readonly hash: string
  readonly result: z.ZodType<T>
  /** The handlers object passed to `define`; origin calls look up only names in `methods`. */
  readonly handlers: EnvironmentHandlers
}

interface Connection {
  readonly peer: RpcPeer
  readonly channel: EnvironmentChannel
  /** Hashes of the definitions the daemon holds: it has answered a run that carried each of them. */
  readonly definitions: Set<string>
  /** The handshake failure with which this service closed the connection, if any. */
  refusal?: Error
}

/** One run waiting for a connection to open. */
interface Waiter {
  readonly confirm: CallOptions['confirm']
  readonly signal: AbortSignal
}

/** An environment's connection, open or opening, with the runs waiting for it. */
interface Entry {
  /** Settles once the channel is open and authenticated. */
  readonly connection: Promise<Connection>
  /** Aborts the open: on unregistration, disposal, timeout, or when every waiting run has left. */
  readonly controller: AbortController
  readonly waiters: Set<Waiter>
  /** Whether the open has settled; only an unsettled open is aborted when its last waiter leaves. */
  settled: boolean
  /** Remove this entry from the service if it is still the environment's current one. */
  readonly release: () => void
}

interface Registration extends EnvironmentInfo {
  readonly transport: EnvironmentTransport
}

interface ActiveRun {
  readonly peer: RpcPeer
  readonly handlers: EnvironmentHandlers
  /** The handler names fixed when defining; no other name is served. */
  readonly methods: readonly string[]
  readonly signal: AbortSignal
}

declare module '@deepseek-ai/cordis' {
  interface Context { environments: EnvironmentRegistry }

  interface Events {
    /**
     * The set of registered environments changed. Fires once per registration and once per effective
     * unregistration, after `list()` and `get()` reflect the change; a removed registration's connection is
     * already detached and closing. Payload-free: listeners re-read `list()`. Listener failures are logged
     * and do not undo the change.
     * @mode emit
     */
    'environments/change'(): void
  }
}

/**
 * Owner of environment registrations and of one daemon connection per environment. A connection opens on
 * the first call and reopens on the next call after it closes; runs in flight when it closes fail and are never replayed.
 * Providers contribute metadata and transports; the registry uses one common execution protocol for all of them.
 */
export class EnvironmentRegistry extends Service {
  static Config: schema<Config> = schema.object({
    maxFrameBytes: schema.natural().min(MIN_LIMIT_BYTES).default(1024 * 1024),
    maxMessageBytes: schema.natural().min(MIN_LIMIT_BYTES).default(64 * 1024 * 1024),
    maxPending: schema.natural().min(1).default(64),
    cancelGraceMs: schema.natural().min(1).default(10_000),
    killGraceMs: schema.natural().min(1).default(2000),
    connectTimeoutMs: schema.natural().min(1).default(30_000),
  })

  /** Bounds of every connection, for sizing arguments, results and origin values; functions read them as `env.limits`. */
  readonly limits: EnvironmentLimits

  private readonly config: Config
  private readonly registrations = new Map<EnvironmentHandle, Registration>()
  private readonly connections = new Map<EnvironmentHandle, Entry>()
  private readonly channels = new Set<EnvironmentChannel>()
  private readonly runs = new Map<number, ActiveRun>()
  private readonly lifetime = new AbortController()
  private nextRun = 1
  private disposal: EnvironmentError | undefined

  constructor(ctx: Context, config: Config) {
    super(ctx, 'environments')
    this.config = configSchema.parse(config)
    this.limits = { maxMessageBytes: this.config.maxMessageBytes }
    ctx.effect(() => () => this.dispose(), 'environment.connections')
  }

  /**
   * Admit a provider identifier without interpreting its format.
   * @param value - non-empty stable identifier chosen by the provider.
   * @returns the branded registry key.
   */
  handle(value: string): EnvironmentHandle {
    return EnvironmentHandle(value)
  }

  /**
   * Contribute an environment and its connection capability. Emits `environments/change` once registered.
   * @param info - provider-owned handle and user-facing display name.
   * @param transport - opens channels to this environment's execution process.
   * @returns a disposer that removes this registration, closes its connection and emits `environments/change`;
   * later calls do nothing.
   */
  register(info: EnvironmentInfo, transport: EnvironmentTransport): () => void {
    const { handle, displayName } = info
    if (this.registrations.has(handle)) throw new Error(`Environment "${handle}" is already registered`)
    const registration: Registration = { handle, displayName, transport }
    this.registrations.set(handle, registration)
    this.changed()
    return () => {
      if (this.registrations.get(handle) !== registration) return
      this.registrations.delete(handle)
      const entry = this.connections.get(handle)
      if (entry !== undefined) {
        this.connections.delete(handle)
        const reason = new Error(`Environment "${handle}" was unregistered`)
        entry.controller.abort(reason)
        void entry.connection.then(({ peer }) => { peer.close(reason) }, () => {
          // The aborted open is reported to the runs that waited for it.
        })
      }
      this.changed()
    }
  }

  /** Notify `environments/change` listeners after a committed change; a failing listener is logged and skipped. */
  private changed(): void {
    for (const listener of this.ctx.events.dispatch('emit', ['environments/change'])) {
      try {
        const returned: unknown = listener()
        void Promise.resolve(returned).catch((error: unknown) => { this.listenerFailed(error) })
      } catch (error) {
        this.listenerFailed(error)
      }
    }
  }

  private listenerFailed(error: unknown): void {
    this.ctx.logger.warn(`An environments/change listener failed: ${asError(error).message}`)
  }

  /**
   * Snapshot the public metadata of current provider contributions.
   * @returns metadata without connection settings or execution objects.
   */
  list(): readonly EnvironmentInfo[] {
    return [...this.registrations.values()].map(({ handle, displayName }) => ({ handle, displayName }))
  }

  /**
   * Read the current registration's public metadata.
   * @param handle - provider-owned environment identifier.
   * @returns its handle and display name; throws when the environment is unavailable.
   */
  get(handle: EnvironmentHandle): EnvironmentInfo {
    const { displayName } = this.registration(handle)
    return { handle, displayName }
  }

  private registration(handle: EnvironmentHandle): Registration {
    const registration = this.registrations.get(handle)
    if (registration !== undefined) return registration
    const names = [...this.registrations.keys()]
    throw unreachable(new Error(`Environment "${handle}" is not registered; registered: ${names.length === 0 ? 'none' : names.join(', ')}`))
  }

  /**
   * Define `fn` for execution processes; each run names its environment. Only its source text and the names of its origin
   * handlers are sent, so `fn` must be a self-contained function or arrow expression without host closures. The type
   * of `fn`'s first parameter determines the arguments of each call. Arguments, results and origin values are copied
   * by structured clone; values it cannot copy, such as functions, fail their run. The own property names of
   * `options.handlers`, read here once, are the `env.origin` methods; names added to the object later are neither
   * exposed nor served, while an origin call looks its handler up on the object when it arrives. The handlers' types
   * determine `env.origin` parameter types and awaited result types. Handlers serve every call and receive only
   * parameters from the function, so host state that belongs to one call, such as a tool call's background job,
   * needs a definition made for that call. Defining neither contacts an environment nor requires a registration.
   * @param fn - daemon-side code receiving each call's arguments and the daemon environment.
   * @param options - result validation and host handlers.
   * @returns a function that runs `fn` at most once per call.
   */
  define<A extends EnvironmentValue, T, H extends EnvironmentHandlers = Record<never, never>>(
    fn: EnvironmentFunction<A, NoInfer<H>>, options: EnvironmentDefineOptions<T, H>,
  ): EnvironmentRunner<A, T> {
    const source = fn.toString()
    const handlers: EnvironmentHandlers = options.handlers ?? {}
    const methods = Object.freeze(Object.getOwnPropertyNames(handlers))
    const definition: Definition<T> = {
      source, methods, hash: definitionHash({ source, methods }), result: options.result, handlers,
    }
    return (handle, args, call) => this.call(definition, handle, args, call)
  }

  private async call<T>(definition: Definition<T>, handle: EnvironmentHandle, args: EnvironmentValue, options: CallOptions): Promise<T> {
    options.signal.throwIfAborted()
    if (this.disposal !== undefined) throw this.disposal
    const registration = this.registration(handle)
    // One reconnect covers a connection that closed before this run was sent, such as a daemon that just went idle.
    for (let attempt = 0; ; attempt++) {
      if (this.registrations.get(handle) !== registration) throw unreachable(new Error(`Environment "${handle}" was unregistered`))
      const connection = await this.connected(handle, options, attempt === 0)
      if (connection === undefined) continue
      try {
        return await this.send(connection, definition, args, options)
      } catch (error) {
        // The connection closed between opening and sending; nothing ran, so reconnect once.
        /* v8 ignore start -- needs the channel to end between the handshake reply and the run request. */
        if (attempt === 0 && error instanceof ConnectionLostError) continue
        if (error instanceof ConnectionLostError) throw unreachable(error)
        /* v8 ignore stop */
        throw error
      }
    }
  }

  /**
   * Wait for an open, authenticated connection. Failures here precede sending, so nothing ran remotely.
   * @returns the connection, or undefined when it closed before use and one retry remains.
   */
  private async connected(id: EnvironmentHandle, options: CallOptions, retry: boolean): Promise<Connection | undefined> {
    const waiter: Waiter = { confirm: options.confirm, signal: options.signal }
    const entry = this.connect(id, waiter)
    let connection: Connection
    try {
      connection = await abortable(entry.connection, options.signal)
    } catch (error) {
      if (retry && error instanceof ConnectionLostError) return undefined
      if (options.signal.aborted || error instanceof HarnessError) throw error
      throw unreachable(error)
    } finally {
      this.leave(entry, waiter)
    }
    return connection
  }

  private async send<T>(connection: Connection, definition: Definition<T>, args: EnvironmentValue, options: CallOptions): Promise<T> {
    const run = this.nextRun++
    const { source, methods, hash, handlers } = definition
    const { definitions } = connection
    // Host handlers stop with the host-side run, whether or not the daemon observes the cancellation.
    const finished = new AbortController()
    this.runs.set(run, { peer: connection.peer, handlers, methods, signal: AbortSignal.any([options.signal, finished.signal]) })
    let value: unknown
    try {
      // Runs carry the definition until the daemon has answered one that carried it; concurrent first runs all carry it.
      value = await connection.peer.request('run', { run, hash, ...definitions.has(hash) ? {} : { definition: { source, methods } }, args }, options.signal)
    } catch (error) {
      /* v8 ignore next -- needs the channel to end between the handshake reply and the run request. */
      if (error instanceof RpcNotSentError) throw new ConnectionLostError(error.message, { cause: error })
      if (options.signal.aborted || error === this.disposal) throw error
      if (error instanceof RemoteRequestError) {
        definitions.add(hash)
        const { name, message, code } = error
        throw new EnvironmentError(message, 'ENVIRONMENT_RUN_FAILED', { cause: error, remote: code === undefined ? { name, message } : { name, message, code } })
      }
      if (!connection.peer.failed) throw new EnvironmentError(asError(error).message, 'ENVIRONMENT_REQUEST_REFUSED', { cause: error })
      const reason = await withEnd(connection.channel, error, options.signal)
      throw new EnvironmentError(reason.message, 'ENVIRONMENT_OUTCOME_UNKNOWN', { cause: error })
    } finally {
      this.runs.delete(run)
      finished.abort(new Error('Execution environment run finished'))
    }
    definitions.add(hash)
    const parsed = definition.result.safeParse(value)
    if (!parsed.success) {
      throw new EnvironmentError(`Execution environment result failed validation: ${parsed.error.message}`, 'ENVIRONMENT_INVALID_RESULT', { cause: parsed.error })
    }
    return parsed.data
  }

  private connect(id: EnvironmentHandle, waiter: Waiter): Entry {
    const existing = this.connections.get(id)
    if (existing !== undefined) {
      existing.waiters.add(waiter)
      return existing
    }
    const controller = new AbortController()
    const waiters = new Set([waiter])
    const pending = Promise.withResolvers<Connection>()
    const connection = pending.promise
    const release = (): void => { if (this.connections.get(id) === entry) this.connections.delete(id) }
    const entry: Entry = { connection, controller, waiters, settled: false, release }
    const settle = (): void => { entry.settled = true }
    void connection.then(settle, settle)
    connection.then(({ peer }) => peer.closed).then(release, release)
    this.connections.set(id, entry)
    void this.open(id, controller.signal, waiters).then(pending.resolve, pending.reject)
    return entry
  }

  /** Remove a run that stopped waiting; an open nobody waits for any more is aborted. */
  private leave(entry: Entry, waiter: Waiter): void {
    entry.waiters.delete(waiter)
    if (entry.waiters.size > 0 || entry.settled) return
    entry.release()
    entry.controller.abort(new Error('Every run waiting for the execution environment connection was cancelled'))
  }

  private async open(id: EnvironmentHandle, signal: AbortSignal, waiters: ReadonlySet<Waiter>): Promise<Connection> {
    const { transport } = this.registration(id)
    const { maxFrameBytes, maxMessageBytes, maxPending, cancelGraceMs, killGraceMs, connectTimeoutMs } = this.config
    // The deadline pauses while a person is asked to confirm trust.
    const deadline = new Deadline(connectTimeoutMs, () => new Error(`Environment "${id}" did not connect within ${connectTimeoutMs} ms`))
    const aborted = AbortSignal.any([this.lifetime.signal, signal, deadline.signal])
    const confirm = async (question: EnvironmentConfirmation): Promise<boolean> => {
      const asked = [...waiters].find(waiter => waiter.confirm !== undefined && !waiter.signal.aborted)?.confirm
      if (asked === undefined) return false
      deadline.pause()
      try {
        return await asked(question)
      } finally {
        deadline.resume()
      }
    }
    try {
      const opening = transport.open({ signal: aborted, killGraceMs, confirm })
      const channel = await abortable(opening, aborted).catch((error: unknown) => {
        // A transport that finishes opening after the abort still hands over a channel, which is closed here.
        void opening.then((late) => { late.close() }, () => {
          // The transport's own failure is superseded by the abort already reported.
        })
        throw error
      })
      this.channels.add(channel)
      void channel.ended.finally(() => { this.channels.delete(channel) })
      const serve = (method: string, params: unknown, served: AbortSignal): Promise<unknown> => this.serve(peer, method, params, served)
      const peer = new RpcPeer(channel.input, channel.output, { maxFrameBytes, maxMessageBytes, maxPending, cancelGraceMs }, serve)
      void channel.ended.then((error) => { peer.close(error) })
      void peer.closed.then(() => { channel.close() })
      const connection: Connection = { peer, channel, definitions: new Set() }
      try {
        authResponseSchema.parse(await peer.request('auth', {
          protocol: ENVIRONMENT_PROTOCOL_VERSION, mechanisms: MECHANISMS[channel.security.kind],
          limits: { maxFrameBytes, maxMessageBytes, maxPending, cancelGraceMs, killGraceMs },
        }, aborted))
      } catch (error) {
        if (peer.failed) {
          // The channel ended during the handshake; this is retryable because nothing was sent.
          /* v8 ignore next -- an abort while waiting for the channel's end reports the original error instead. */
          const reason = await withEnd(channel, error, aborted).catch(() => asError(error))
          throw new ConnectionLostError(reason.message, { cause: error })
        }
        connection.refusal = asError(error)
        peer.close(connection.refusal)
        throw error
      }
      return connection
    } finally {
      deadline.clear()
    }
  }

  private async serve(peer: RpcPeer, method: string, params: unknown, signal: AbortSignal): Promise<unknown> {
    if (method !== 'call') throw new Error(`Unknown execution environment host method: ${method}`)
    const call = callSchema.parse(params)
    const run = this.runs.get(call.run)
    if (run === undefined || run.peer !== peer) throw new Error('Execution environment run is no longer active')
    const handler = run.methods.includes(call.method) && Object.hasOwn(run.handlers, call.method) ? run.handlers[call.method] : undefined
    if (handler === undefined) throw new Error(`Unknown host handler: ${call.method}`)
    // Handler parameter types are erased on the wire; handlers validate untrusted daemon input.
    return await (handler as EnvironmentHostHandler)(call.params, AbortSignal.any([signal, run.signal]))
  }

  private async dispose(): Promise<void> {
    const disposal = new EnvironmentError('Execution environment is disposed', 'ENVIRONMENT_DISPOSED')
    this.disposal = disposal
    this.lifetime.abort(disposal)
    const entries = [...this.connections.values()]
    this.connections.clear()
    for (const entry of entries) entry.controller.abort(disposal)
    await Promise.allSettled(entries.map(entry => entry.connection.then(({ peer }) => { peer.close(disposal) })))
    const channels = [...this.channels]
    for (const channel of channels) channel.close()
    await Promise.allSettled(channels.map(channel => channel.ended))
  }
}

export default EnvironmentRegistry

/** The mechanisms a host offers on each kind of channel; only authenticated transports offer `transport`. */
const MECHANISMS: { readonly [K in EnvironmentChannelSecurity['kind']]: readonly EnvironmentAuthMechanism[] } = {
  'authenticated-transport': ['transport'],
}

function unreachable(error: unknown): EnvironmentError {
  return new EnvironmentError(asError(error).message, 'ENVIRONMENT_UNREACHABLE', { cause: error })
}

/** The channel ended before a run was sent; a retry may reconnect. */
class ConnectionLostError extends Error {
  override name = 'ConnectionLostError'
}

/** Pausable timer that aborts its signal when the remaining time runs out. */
class Deadline {
  private readonly controller = new AbortController()
  private remaining: number
  private closed = false
  private startedAt = Date.now()
  private timer: NodeJS.Timeout | undefined

  /**
   * @param ms - total running time before the deadline fires.
   * @param reason - creates the abort reason.
   */
  constructor(ms: number, private readonly reason: () => Error) {
    this.remaining = ms
    this.resume()
  }

  /** Aborts when the deadline fires. */
  get signal(): AbortSignal {
    return this.controller.signal
  }

  /** Stop counting, as while a person decides. */
  pause(): void {
    clearTimeout(this.timer)
    this.remaining -= Date.now() - this.startedAt
  }

  /** Continue counting the remaining time. */
  resume(): void {
    if (this.closed) return
    this.startedAt = Date.now()
    this.timer = setTimeout(() => { this.controller.abort(this.reason()) }, Math.max(0, this.remaining))
  }

  /** Stop the deadline for good. */
  clear(): void {
    this.closed = true
    clearTimeout(this.timer)
  }
}

/**
 * Add the channel's end reason to a connection failure, once.
 * @param channel - the channel the operation used.
 * @param error - the error the operation received.
 * @param signal - stops waiting for the channel's end.
 * @returns the error to report.
 */
async function withEnd(channel: EnvironmentChannel, error: unknown, signal: AbortSignal): Promise<Error> {
  const reason = asError(error)
  const ended = await abortable(channel.ended, signal)
  // The end may itself be the reason when it closed the connection before the input stream ended.
  return new Error([...new Set([reason.message, ended.message])].join('; '), { cause: reason })
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- preserve the caller's arbitrary AbortSignal reason.
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => { reject(asError(signal.reason)) }
    signal.addEventListener('abort', abort, { once: true })
    promise.then(resolve, reject).finally(() => { signal.removeEventListener('abort', abort) })
  })
}
