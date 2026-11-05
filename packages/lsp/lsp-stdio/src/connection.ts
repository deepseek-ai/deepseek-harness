/**
 * A JSON-RPC endpoint over one language server spawned through the subprocess
 * capability. Owns id correlation, outbound requests/notifications, and inbound
 * server→client requests: it answers `workspace/configuration` from static
 * config, and rejects `workspace/applyEdit` (this host never applies edits or
 * runs commands). It caps stderr, surfaces framing/decoder failures as a
 * fatal close, and exposes managed-range termination through the handle so the
 * instance owns teardown; platform mechanics live in the subprocess
 * Service Provider.
 * @module @deepseek-ai/dsh-lsp-stdio/connection
 */

import type { Writable } from 'node:stream'
import { LspError } from '@deepseek-ai/dsh-lsp'
import { HarnessError } from '@deepseek-ai/dsh-error'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { encodeMessage, MessageDecoder } from './framing.ts'

/** How to launch the server and answer its config requests. */
export interface ConnectionSpec {
  /** The resolved absolute executable path (no shell). */
  readonly command: string
  /** Arguments passed to the executable. */
  readonly args: readonly string[]
  /** The child's working directory (the canonical workspace). */
  readonly cwd: string
  /** Explicit child environment overrides; the subprocess provider owns its ambient scrub. */
  readonly env: Record<string, string>
  /** Largest single framed message accepted from the server. */
  readonly maxMessageBytes: number
  /** Largest stderr tail retained for diagnostics. */
  readonly maxStderrBytes: number
  /**
   * The subprocess spec's `graceMs`: the SIGTERM→SIGKILL window of
   * {@link LspConnection.terminate}'s escalation, and the bound for draining
   * pipes a surviving helper still holds after the server exits.
   */
  readonly killGraceMs: number
  /** Static answer to every `workspace/configuration` item. */
  readonly configuration: unknown
}

interface Pending {
  method: string
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

/**
 * Write one JSON-RPC message to the child stdin.
 * @param stdin - the spawned server stdin.
 * @param message - the unencoded JSON-RPC message.
 * @param done - callback that reports asynchronous stream settlement.
 */
export type ConnectionWriter = (
  stdin: Writable,
  message: unknown,
  done: (error?: Error | null) => void,
) => void

/** Spawn one subprocess for this connection (the provider passes `ctx.subprocess.spawn`). */
export type ConnectionSpawner = (spec: SubprocessSpawnSpec) => SubprocessHandle

const writeConnectionMessage: ConnectionWriter = (stdin, message, done) => {
  stdin.write(encodeMessage(message), done)
}

/**
 * A live JSON-RPC endpoint bound to one child process. Request and write failures are `LspError`s:
 * `LSP_SERVER_EXITED` when the process exits or its stdin fails, `LSP_SPAWN_FAILED` when the
 * subprocess provider fails to start or run it (a provider `HarnessError` keeps its own identity),
 * `LSP_PROTOCOL_ERROR` or `LSP_MESSAGE_TOO_LARGE` when its stdout breaks framing, and
 * `LSP_SERVER_ERROR` when it answers a request with a JSON-RPC error.
 */
export class LspConnection {
  private readonly handle: SubprocessHandle
  private readonly stdin: Writable
  private readonly decoder: MessageDecoder
  private readonly pending = new Map<number, Pending>()
  private nextId = 1
  private closeReason: Error | undefined
  /** The subprocess provider's launch or run failure; it supersedes the stdin failure it causes. */
  private launchFailure: Error | undefined
  /** Set once the process has fully exited; the instance awaits it during teardown. */
  readonly closed: Promise<void>

  /**
   * @param spec - how to launch the server and answer its config requests.
   * @param spawner - the subprocess seam's spawn (the provider passes `ctx.subprocess.spawn`).
   * @param onServerRequest - answers a server→client request; rejects to send an error response.
   * @param writer - message writer; tests inject callback failures without relying on OS pipe races.
   */
  constructor(
    spec: ConnectionSpec,
    spawner: ConnectionSpawner,
    private readonly onServerRequest: (method: string, params: unknown) => Promise<unknown>,
    private readonly writer: ConnectionWriter = writeConnectionMessage,
  ) {
    this.decoder = new MessageDecoder(spec.maxMessageBytes)
    // stdin/stdout are piped protocol streams this endpoint frames itself;
    // stderr is a collected diagnostic tail (no spill — the bounded tail IS
    // the contract). The seam owns managed-range signalling and observation.
    this.handle = spawner({
      argv: [spec.command, ...spec.args],
      cwd: spec.cwd,
      stdio: {
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: { maxBytes: spec.maxStderrBytes },
      },
      graceMs: spec.killGraceMs,
      // The seam merges explicit config entries after its ambient scrub, so a
      // configured credential or DSH_* fact reaches the child deliberately.
      env: spec.env,
    })
    /* v8 ignore start -- 'pipe' dispositions expose both streams by the seam contract; defensive. */
    if (this.handle.stdin === undefined || this.handle.stdout === undefined) {
      throw new Error('lsp-stdio: subprocess implementation dropped a piped protocol stream')
    }
    /* v8 ignore stop */
    this.stdin = this.handle.stdin
    this.closed = new Promise<void>((resolve) => {
      const close = (): void => {
        const reason = this.closeReason ?? new LspError(this.exitMessage(), 'LSP_SERVER_EXITED')
        // Record the reason so any request issued AFTER close rejects immediately instead of hanging
        // (a closed process sends no further responses).
        this.closeReason = reason
        this.failAll(reason)
        resolve()
      }
      this.handle.done.then(close, (error: unknown) => {
        // A spawn-level failure never produces a close event; the rejection is
        // the fatal cause and the close boundary at once.
        const failure = spawnFailure(error)
        this.launchFailure = failure
        this.fail(failure)
        close()
      })
    })
    // Child stdin can fail while the process itself remains alive (for example, a server closes fd
    // 0). Treat that as a fatal connection error so pending requests reject immediately instead of
    // waiting for a process-close event that may never arrive.
    this.stdin.on('error', (error) => { this.fail(this.stdinFailure(error)) })
    this.handle.stdout.on('data', (chunk: Buffer) => { this.onStdout(chunk) })
  }

  /** The retained stderr tail, for diagnostics on a failed server. */
  get stderrTail(): string {
    /* v8 ignore next -- the collect disposition always exposes a stderr reader; defensive. */
    return this.handle.collected.stderr?.readFrom(0).text ?? ''
  }

  /** Whether the transport has failed even if the child close event has not arrived yet. */
  get failed(): boolean {
    return this.closeReason !== undefined
  }

  /**
   * Test whether a caught error is this connection's retained fatal transport cause.
   * @param error - error caught by the instance or provider.
   * @returns `true` only when this connection produced that exact failure.
   */
  failedWith(error: unknown): boolean {
    return this.closeReason === error || (this.launchFailure !== undefined && this.launchFailure === error)
  }

  /**
   * Report a transport failure by its authoritative cause once the process has settled. A failed
   * launch usually surfaces first as a stdin write failure; after `done` rejects, that failure
   * reports the launch failure instead.
   * @param error - error caught by the instance after teardown.
   * @returns the launch failure for this connection's transport failure, otherwise `error`.
   */
  settledFailure(error: unknown): unknown {
    return this.launchFailure !== undefined && this.failedWith(error) ? this.launchFailure : error
  }

  /**
   * Send a request and await its result.
   * @param method - the JSON-RPC method.
   * @param params - the request params.
   * @returns the response result; rejects on an error response, write failure, or close.
   */
  request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++
    const promise = new Promise<unknown>((resolve, reject) => {
      if (this.closeReason !== undefined) {
        reject(this.closeReason)
        return
      }
      this.pending.set(id, { method, resolve, reject })
      // `write()` records either synchronous or callback-delivered failures on the connection and
      // rejects every pending request. This handler only consumes the write promise itself.
      void this.write({ jsonrpc: '2.0', id, method, params }).catch(() => {})
    })
    // A caller that stops awaiting (e.g. an aborted query) can leave this promise to reject later
    // when the process closes; a benign no-op handler keeps that from surfacing as an unhandled
    // rejection. The returned promise still delivers the rejection to the caller's own await/catch.
    promise.catch(() => {})
    return promise
  }

  /**
   * Send a notification (no id, no response).
   * @param method - the JSON-RPC method.
   * @param params - the notification params.
   * @returns a promise that settles when the framed notification has been written.
   */
  notify(method: string, params: unknown): Promise<void> {
    return this.write({ jsonrpc: '2.0', method, params })
  }

  /**
   * Send a `$/cancelRequest` for an in-flight request id (best-effort; ignores write failure).
   * @param requestId - the numeric id of the request to cancel.
   */
  cancel(requestId: number): void {
    // The server is already gone or unwritable when this rejects; `write()` has recorded the fatal
    // connection failure and rejected the pending request, so cancellation remains best-effort.
    void this.write({ jsonrpc: '2.0', method: '$/cancelRequest', params: { id: requestId } }).catch(() => {})
  }

  /**
   * The id the NEXT `request()` will use, so the instance can pre-arm a cancel.
   * @returns the numeric id the next request will be assigned.
   */
  peekNextId(): number {
    return this.nextId
  }

  /** Terminate the server's provider-managed range (idempotent). */
  terminate(): void {
    this.handle.terminate()
  }

  /**
   * Wait until the owned managed range is empty.
   * @param signal - optional bound for the wait.
   * @returns `true` when the range is empty, or `false` when the signal aborted first.
   */
  async waitForManagedRangeExit(signal?: AbortSignal): Promise<boolean> {
    return await this.handle.waitForExit(signal)
  }

  private onStdout(chunk: Buffer): void {
    let messages: unknown[]
    try {
      messages = this.decoder.push(chunk)
    } catch (error) {
      // A framing/JSON failure corrupts the stream position irrecoverably: fail the instance and
      // terminate the managed range so helper processes do not outlive the leader.
      this.fail(asError(error))
      this.handle.terminate()
      return
    }
    for (const message of messages) this.dispatch(message)
  }

  private dispatch(message: unknown): void {
    if (message === null || typeof message !== 'object') return
    const frame = message as Record<string, unknown>
    const id = frame.id
    const method = frame.method
    if (typeof method === 'string' && (typeof id === 'number' || typeof id === 'string')) {
      // A response-write failure has already invalidated the connection in `write()`.
      /* v8 ignore next -- protocol tests exercise response writes; only a simultaneous connection
         failure makes this consumption handler run. */
      void this.handleServerRequest(id, method, frame.params).catch(() => {})
      return
    }
    if (typeof method === 'string') {
      // A server→client notification (e.g. diagnostics, logs): ignored by this MVP host.
      return
    }
    if (typeof id === 'number') this.handleResponse(id, frame)
  }

  private async handleServerRequest(id: number | string, method: string, params: unknown): Promise<void> {
    try {
      const result = await this.onServerRequest(method, params)
      await this.write({ jsonrpc: '2.0', id, result })
    } catch (error) {
      await this.write({ jsonrpc: '2.0', id, error: { code: -32601, message: asError(error).message } })
    }
  }

  private handleResponse(id: number, frame: Record<string, unknown>): void {
    const pending = this.pending.get(id)
    if (!pending) return
    this.pending.delete(id)
    const error = frame.error
    if (error !== null && typeof error === 'object') {
      pending.reject(responseError(pending.method, error as Record<string, unknown>))
      return
    }
    pending.resolve(frame.result)
  }

  private write(message: unknown): Promise<void> {
    if (this.closeReason !== undefined) return Promise.reject(this.closeReason)
    return new Promise<void>((resolve, reject) => {
      const done = (error?: Error | null): void => {
        if (error === undefined || error === null) {
          resolve()
          return
        }
        const failure = this.stdinFailure(error)
        this.fail(failure)
        reject(failure)
      }
      try {
        this.writer(this.stdin, message, done)
      /* v8 ignore start -- Node stream write failures are callback-delivered; this guards a
         nonconforming Writable implementation throwing synchronously. */
      } catch (error) {
        const failure = asError(error)
        this.fail(failure)
        reject(failure)
      }
      /* v8 ignore stop */
    })
  }

  /** The exit-close error message, appending the retained stderr tail when the server wrote any. */
  private exitMessage(): string {
    const tail = this.stderrTail.trim()
    return tail === '' ? 'language server exited' : `language server exited; stderr: ${tail}`
  }

  /**
   * Convert a stdin failure to `LSP_SERVER_EXITED`. The stream reports one failure through both its
   * `error` event and the write callback, so the second report reuses the first conversion and
   * {@link failedWith} still recognizes the rejection.
   */
  private stdinFailure(error: Error): Error {
    const current = this.closeReason
    if (current instanceof LspError && current.cause === error) return current
    return new LspError(`language server stopped accepting input: ${error.message}`, 'LSP_SERVER_EXITED', { cause: error })
  }

  private fail(error: Error): void {
    /* v8 ignore next -- the second arm needs a second failure before close, such as a launch failure after a stdin
       failure; the subprocess provider does not fix that order, so coverage cannot rely on it. */
    if (this.closeReason === undefined) this.closeReason = error
    this.failAll(error)
  }

  private failAll(error: Error): void {
    const waiting = [...this.pending.values()]
    this.pending.clear()
    for (const pending of waiting) pending.reject(error)
  }
}

/**
 * Convert a subprocess `done` rejection to `LSP_SPAWN_FAILED`; a provider `HarnessError` already
 * carries the classification and propagates unchanged.
 */
function spawnFailure(error: unknown): Error {
  if (error instanceof HarnessError) return error
  return new LspError(`language server process failed: ${asError(error).message}`, 'LSP_SPAWN_FAILED', { cause: error })
}

/** Convert a JSON-RPC error response, keeping its numeric code and message in `message`. */
function responseError(method: string, error: Record<string, unknown>): LspError {
  const code = typeof error.code === 'number' ? ` ${error.code}` : ''
  const detail = typeof error.message === 'string' ? error.message : 'no message'
  return new LspError(`language server rejected ${method} with JSON-RPC error${code}: ${detail}`, 'LSP_SERVER_ERROR')
}

/** Coerce an unknown thrown value to an `Error`. */
function asError(value: unknown): Error {
  /* v8 ignore next -- the non-Error branch guards against a non-Error throw, which our paths never produce. */
  return value instanceof Error ? value : new Error(String(value))
}
