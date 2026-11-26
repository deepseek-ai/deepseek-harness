/** Types shared by tool authors, the host service and the daemon. */

import type * as fs from 'node:fs/promises'
import type * as path from 'node:path'
import type { Readable, Writable } from 'node:stream'
import type { EnvironmentHandle } from './handle.ts'

/**
 * A value that crosses the connection as a `node:v8` structured clone, and the daemon's thread boundary as a
 * `postMessage` structured clone: primitives other than symbols, plain objects and arrays, `Date`, `RegExp`, `Map`,
 * `Set`, `ArrayBuffer`, typed arrays such as `Uint8Array`, and errors, which keep only their message, stack, cause and a
 * standard name such as `TypeError`. `undefined` is preserved, also as a property value. Class instances arrive as plain
 * objects of their own enumerable properties, and a `Buffer` arrives as a `Uint8Array`. Functions, symbols, promises and
 * other values the algorithm cannot clone pass this type but fail their message at run time, before anything is sent.
 */
export type EnvironmentValue = undefined | null | boolean | number | bigint | string | object

/** Bounds that apply to every connection of one registry. */
export interface EnvironmentLimits {
  /**
   * Largest `node:v8` encoding of one message: a run's source, arguments and method names, a run's result, or one
   * `origin` call or its result. Larger messages are refused before sending. Binary data counts its byte length;
   * strings count at most two bytes per UTF-16 code unit.
   */
  readonly maxMessageBytes: number
}

/** What a remote function threw: its error's name and message, and its `code` when that is a string. */
export interface EnvironmentRemoteFailure {
  /** The error's `name`, such as `TypeError`. */
  readonly name: string
  /** The error's `message`. */
  readonly message: string
  /** A string `code`, such as an errno name like `ENOENT` or a `HarnessError` code. */
  readonly code?: string
}

/** Public environment metadata; providers keep connection settings private. */
export interface EnvironmentInfo {
  /** Stable identifier chosen by the contributing provider. */
  readonly handle: EnvironmentHandle
  /** User-facing name; it need not be unique. */
  readonly displayName: string
}

/** Outcome of one daemon-side child process; a non-zero exit is not an error. */
export interface EnvironmentExecResult {
  /** Exit code; null when a signal ended the process. */
  readonly exitCode: number | null
  /** Terminating signal; null after a normal exit. */
  readonly signal: string | null
  /** Complete standard output decoded as UTF-8. */
  readonly stdout: string
  /** Complete standard error decoded as UTF-8. */
  readonly stderr: string
}

/** Structured clone preserves undefined; a void annotation can discard any value. */
type OriginCallResult<T> = T extends undefined ? T : T extends void ? EnvironmentValue : T

/** An origin method's parameter: the handler's own parameter type, or any value for a handler accepting `unknown`. */
type OriginParams<P> = unknown extends P ? EnvironmentValue : P

/** Host methods supplied to one definition, preserving each handler's parameter and result types. */
export type EnvironmentHandlers = Readonly<Record<string, EnvironmentHostHandler<never>>>

/**
 * APIs available to a remote function inside the daemon. The function runs in
 * a fresh `node:vm` context on a daemon worker thread, without `require`, `import`,
 * `process` or host closures; this object is its only access to the daemon machine and the host.
 * Besides JavaScript built-ins, the context's globals are timers and web utilities such as
 * `Buffer`, `TextEncoder` and `URL`, created in the worker's realm and shared by the runs on that worker.
 */
export interface EnvironmentContext<H extends EnvironmentHandlers = Record<never, never>> {
  /** The daemon machine's `node:fs/promises`. */
  readonly fs: typeof fs
  /** The daemon machine's `node:path`. */
  readonly path: typeof path
  /** The daemon process working directory. */
  readonly cwd: string
  /** The daemon machine's `process.platform`. */
  readonly platform: string
  /** Aborts when the host cancels the run or the connection closes. */
  readonly signal: AbortSignal
  /** Bounds of this connection, the registry's {@link EnvironmentLimits}. */
  readonly limits: EnvironmentLimits
  /**
   * Run one program on the daemon machine without a shell. Standard output and error together are limited to
   * `limits.maxMessageBytes`; exceeding it kills the process and rejects. The run's result must also fit that limit.
   * @param argv - program and arguments.
   * @param options - working directory and complete standard input.
   * @returns exit facts and complete output.
   */
  exec(argv: readonly string[], options?: { readonly cwd?: string; readonly input?: string }): Promise<EnvironmentExecResult>
  /**
   * Host handlers of the definition being run, with {@link EnvironmentValue} parameters and awaited results. Omitted
   * parameters and undefined results stay `undefined`. A call rejects with an error carrying the `name`, `message` and
   * string `code` of the error the handler threw.
   */
  readonly origin: {
    readonly [K in keyof H & string]: (
      ...params: Parameters<H[K]> extends []
        ? []
        : undefined extends Parameters<H[K]>[0]
          ? [params?: OriginParams<Parameters<H[K]>[0]> | undefined]
          : [params: OriginParams<Parameters<H[K]>[0]>]
    ) => Promise<OriginCallResult<Awaited<ReturnType<H[K]>>>>
  }
}

/**
 * Daemon-side code. Only the function source is sent: it must not reference
 * host variables or imports, and its {@link EnvironmentValue} result is returned.
 */
export type EnvironmentFunction<
  A extends EnvironmentValue, H extends EnvironmentHandlers = Record<never, never>,
> = (args: A, env: EnvironmentContext<H>) => unknown

/**
 * Host-side handler a remote function reaches through `env.origin`. Parameter and
 * return annotations determine the remote call's types; input still needs validation when untrusted.
 * @param params - {@link EnvironmentValue} parameters from the daemon; `undefined` when omitted.
 * @param signal - aborts with the run.
 * @returns an {@link EnvironmentValue} result.
 */
export type EnvironmentHostHandler<P = unknown> = (params: P, signal: AbortSignal) => unknown

/**
 * Connection-authentication mechanisms. `transport` trusts the channel itself: SSH authentication or
 * a provider-owned local process. A future network transport adds a mechanism that proves identity
 * over the channel; the execution endpoint names the mechanisms it accepts and never accepts `transport`
 * on a channel that does not authenticate.
 */
export type EnvironmentAuthMechanism = 'transport'

/** Security facts a transport reports about one channel; authentication mechanisms consume them. */
export type EnvironmentChannelSecurity = {
  /** The channel only reaches the daemon through an authenticated transport. */
  readonly kind: 'authenticated-transport'
}

/** One open byte channel to a daemon. */
export interface EnvironmentChannel {
  /** Frames from the daemon, as bytes; a stream with a text encoding set fails the connection. */
  readonly input: Readable
  /** Frames to the daemon. */
  readonly output: Writable
  /** What the transport guarantees about this channel. */
  readonly security: EnvironmentChannelSecurity
  /** Resolves once the channel has ended, with an error describing why, such as an exit status and stderr. */
  readonly ended: Promise<Error>
  /** End the channel; `ended` settles once its resources are released. Idempotent. */
  close(): void
}

/** A host key a server presented, as `ssh-keygen -l` describes it. */
export interface EnvironmentHostKey {
  /** Key type, such as `ED25519`. */
  readonly type: string
  /** `SHA256:` fingerprint. */
  readonly fingerprint: string
}

/**
 * A question a transport asks a person before trusting the host keys a server presented, such as an SSH server that no
 * known-hosts file records. A client renders the fields in the person's language.
 */
export interface EnvironmentConfirmation {
  /** Host name the transport connects to. */
  readonly hostname: string
  /** TCP port the transport connects to. */
  readonly port: number
  /** Keys to compare with the host's own key files before agreeing. */
  readonly keys: readonly EnvironmentHostKey[]
  /** The same facts as English text, naming the host and every fingerprint; equal text asks the same question. */
  readonly detail: string
}

/** Inputs to one {@link EnvironmentTransport.open}. */
export interface EnvironmentOpenContext {
  /** Aborts opening; an opened channel is ended with `close`. */
  readonly signal: AbortSignal
  /** Grace negotiated for exec process groups; process supervisors allow this before forcing daemon termination. */
  readonly killGraceMs: number
  /**
   * Ask a person to agree, when the run that opens the channel can reach one.
   * @param question - the decision and the facts to verify.
   * @returns whether the person agreed.
   */
  readonly confirm?: (question: EnvironmentConfirmation) => Promise<boolean>
}

/**
 * Supplies authenticated byte channels for one environment. The provider owns execution-process startup,
 * termination and any persistence across connections; the registry owns the execution protocol.
 */
export interface EnvironmentTransport {
  /**
   * Open a channel to the daemon, starting it when the transport can.
   * @param context - cancellation and an optional person to confirm trust decisions.
   * @returns the open channel.
   */
  open(context: EnvironmentOpenContext): Promise<EnvironmentChannel>
}
