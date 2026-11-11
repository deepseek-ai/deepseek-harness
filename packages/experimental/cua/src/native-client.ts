/** Agent-scoped JSONL requests over a connection to the shared native helper. */
import { randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'
import { HarnessError } from '@deepseek-ai/dsh-error'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { z } from 'zod'
import type { Readable, Writable } from 'node:stream'

const Reply = z.union([
  z.object({ id: z.string(), result: z.json() }).strict(),
  z.object({ id: z.string(), error: z.object({ code: z.string().min(1), message: z.string() }).strict() }).strict(),
])

const screenshotPrefix = '[cua-screenshot] '
const ScreenshotDiagnostic = z.object({
  requestId: z.string(), stage: z.string(), elapsedMs: z.number().nonnegative(), errorCode: z.string().optional(),
})
const WireReply = z.union([Reply, ScreenshotDiagnostic.extend({ type: z.literal('diagnostic') })])

/** Native refusal or transport failure with a stable machine-readable code. */
export class NativeError extends HarnessError {
  /**
   * @param code - Native error code or a transport-owned NATIVE_* code.
   * @param message - Actionable diagnostic, without its code prefix.
   * @param options - Original failure when available.
   */
  constructor(code: string, message: string, options?: ErrorOptions) {
    super(`${code}: ${message}`, code, options)
  }
}

function connectionFailure(code: string, message: string, cause: unknown): NativeError {
  return cause instanceof NativeError ? cause : new NativeError(code, message, { cause })
}

/** Preserve the original failure together with any distinct cleanup failure. */
function combineFailures(original: unknown, cleanup: unknown): unknown {
  if (original === cleanup) return original
  if (original instanceof AggregateError && original.errors.includes(cleanup)) return original
  if (cleanup instanceof AggregateError && cleanup.errors.includes(original)) return cleanup
  return new AggregateError([original, cleanup], `Native operation and cleanup failed.\nOperation: ${String(original)}\nCleanup: ${String(cleanup)}`, { cause: original })
}

/** Resolved helper executable and bounded process/response configuration. */
export interface NativeClientConfig {
  helperPath: string
  cwd: string
  timeoutMs: number
  connectTimeoutMs: number
  screenshotTimeoutMs: number
  axTimeoutMs: number
  maxRequestBytes: number
  maxResponseBytes: number
  graceMs: number
  textEventIntervalMs: number
  maxClickHoldMs: number
}

/** One Agent's ordered connection to native operations and cleanup acknowledgement. */
export interface NativeChannel {
  readonly stdin: Writable
  readonly stdout: Readable
  readonly done: Promise<void>
  /** Stop writes and release this connection's native state. */
  close(): void
  /** @returns Completion after the connection and its owned startup processes close. */
  waitForClose(): Promise<void>
}
/**
 * Open the platform connection with the configured resource bounds.
 * @param owner - Managed subprocess provider for startup and cleanup.
 * @param config - Executable, operation limits, and deadlines.
 * @returns Agent-owned native byte stream and its cleanup acknowledgement.
 */
export type NativeChannelFactory = (
  owner: { subprocess: Pick<SubprocessRuntime, 'spawn'> }, config: NativeClientConfig,
) => NativeChannel

/** One Agent owns this connection and its native handles; other Agents use independent connections. */
export class NativeClient {
  private readonly handle: NativeChannel
  private readonly config: NativeClientConfig
  private readonly chunks: Buffer[] = []
  private bufferedBytes = 0
  private failure: NativeError | undefined
  private disposal: Promise<void> | undefined
  private transportClosed: Promise<void> | undefined
  private readonly cleanups = new Set<(canRequest: boolean) => Promise<void>>()
  private diagnostics: string[] = []
  private diagnosticBytes = 0
  private discardedDiagnostics = false
  private active: {
    kind: 'request' | 'cleanup'
    id: string
    outcome: Promise<JsonValue>
    resolve: (value: JsonValue) => void
    reject: (error: NativeError) => void
    cancel?: () => void
  } | undefined

  /**
   * @param owner - Managed subprocess provider.
   * @param config - Executable, transport bounds and deadlines.
   * @param createChannel - Platform-owned connection and process lifecycle.
   * @param reportDiagnostic - Optional Host diagnostic sink; never receives captured content.
   */
  constructor(owner: { subprocess: Pick<SubprocessRuntime, 'spawn'> }, config: NativeClientConfig, createChannel: NativeChannelFactory,
    private readonly reportDiagnostic?: (message: string) => void) {
    this.config = config
    this.handle = createChannel(owner, config)
    this.handle.stdout.on('data', (chunk: Buffer) => { this.receive(chunk) })
    this.handle.stdout.on('error', (error: Error) => { this.fail(connectionFailure('NATIVE_IO', `Native connection failed: ${error.message}`, error)) })
    this.handle.stdout.on('end', () => { this.fail(new NativeError('NATIVE_EOF', 'Native connection ended; acquire fresh application handles')) })
    this.handle.stdout.on('close', () => { this.fail(new NativeError('NATIVE_EOF', 'Native connection closed; acquire fresh application handles')) })
    this.handle.stdin.on('error', (error: Error) => { this.fail(connectionFailure('NATIVE_IO', 'Writing native requests failed', error)) })
    void this.handle.done.then(
      () => { this.fail(new NativeError('NATIVE_EXITED', 'Native connection closed; acquire fresh application handles')) },
      (error: unknown) => { this.fail(connectionFailure('NATIVE_EXITED', 'Native connection failed', error)) },
    )
  }

  /**
   * Send one operation. Native refusals preserve this connection; transport failures invalidate its handles.
   * @param method - Helper operation name.
   * @param params - JSON operation parameters.
   * @param signal - Cancellation stops this request; the connection survives when native cleanup acknowledges it.
   * @param callId - Logged tool invocation ID, when this request belongs to a tool execution.
   * @returns The validated helper result, after failure cleanup when needed.
   */
  async request(method: string, params: Record<string, JsonValue>, signal: AbortSignal, callId?: ToolExecution['callId']): Promise<JsonValue> {
    if (signal.aborted) throw new NativeError('NATIVE_CANCELLED', 'Operation was cancelled before dispatch')
    if (this.disposed) {
      await this.dispose()
      throw new NativeError('NATIVE_CLOSED', 'Helper is closed; acquire fresh application handles', { cause: this.failure })
    }
    return this.send('request', method, params, signal, callId)
  }

  private async send(
    kind: 'request' | 'cleanup', method: string, params: Record<string, JsonValue>,
    signal: AbortSignal, callId?: ToolExecution['callId'],
  ): Promise<JsonValue> {
    this.throwIfFailed()
    if (this.active) throw new NativeError('NATIVE_BUSY', 'Await native operations sequentially')
    const id = callId ?? randomUUID()
    const capture = method === 'screenshot'
    this.diagnostics = []
    this.diagnosticBytes = 0
    this.discardedDiagnostics = false
    const started = performance.now()
    let interruption: NativeError | undefined
    let cancellationTimer: ReturnType<typeof setTimeout> | undefined
    const frame = `${JSON.stringify({ id, method, params })}\n`
    if (Buffer.byteLength(frame) > this.config.maxRequestBytes) {
      const error = new NativeError('NATIVE_REQUEST_LIMIT', 'Request exceeded the configured byte limit before dispatch')
      if (kind === 'cleanup') this.fail(error)
      throw error
    }
    const outcome = Promise.withResolvers<JsonValue>()
    const interrupt = (error: NativeError): void => {
      if (interruption || this.active?.id !== id) return
      if (kind === 'cleanup') { this.fail(error); return }
      interruption = error
      cancellationTimer = setTimeout(() => {
        this.fail(new NativeError('NATIVE_CLEANUP', 'Native operation did not acknowledge cancellation; acquire fresh application handles', { cause: error }))
      }, this.config.graceMs)
      try {
        this.handle.stdin.write(`${JSON.stringify({ type: 'cancel', id })}\n`, (failure) => {
          if (failure) this.fail(connectionFailure('NATIVE_IO', 'Sending native cancellation failed', failure))
        })
      } catch (failure) {
        this.fail(connectionFailure('NATIVE_IO', 'Sending native cancellation failed', failure))
      }
    }
    const abort = (): void => { interrupt(new NativeError('NATIVE_CANCELLED', 'Operation cancelled; inspect fresh state before retrying input')) }
    this.active = {
      kind, id, outcome: outcome.promise, resolve: outcome.resolve,
      reject: outcome.reject,
      ...kind === 'request' ? { cancel: abort } : {},
    }
    signal.addEventListener('abort', abort, { once: true })
    const timeoutMs = capture ? Math.min(this.config.timeoutMs, this.config.screenshotTimeoutMs) : this.config.timeoutMs
    const timer = setTimeout(() => {
      interrupt(new NativeError('NATIVE_TIMEOUT', `Operation exceeded ${timeoutMs}ms`))
    }, timeoutMs)
    let diagnostics = ''
    try {
      try {
        try {
          this.handle.stdin.write(frame, (error) => {
            if (error) this.fail(connectionFailure('NATIVE_IO', 'Writing a helper request failed', error))
          })
          if (capture) this.diagnostic(screenshotPrefix + JSON.stringify({ requestId: id, stage: 'host.dispatch', elapsedMs: 0 }))
        } catch (error) {
          this.fail(connectionFailure('NATIVE_IO', 'Writing a helper request failed', error))
        }
        const result = await outcome.promise
        this.throwIfFailed()
        if (interruption) throw interruption
        if (capture) this.diagnostic(screenshotPrefix + JSON.stringify({
          requestId: id, stage: 'host.reply', elapsedMs: performance.now() - started,
        }))
        return result
      } finally {
        clearTimeout(timer)
        clearTimeout(cancellationTimer)
        signal.removeEventListener('abort', abort)
        if (capture) diagnostics = this.screenshotDiagnostics()
      }
    } catch (error) {
      // Native replies and transport callbacks reject with NativeError.
      const failure = (interruption && !this.failure ? interruption : error) as NativeError
      if (capture && diagnostics) failure.message += `\nScreenshot diagnostics:\n${diagnostics}`
      if (kind === 'cleanup') {
        this.fail(connectionFailure('NATIVE_CLEANUP', 'Native resource cleanup failed; acquire fresh application handles', failure))
        return await this.rejectAfterCleanup(failure, this.waitForTransportClose())
      }
      if (this.disposed) return await this.rejectAfterCleanup(failure, this.dispose())
      throw failure
    } finally {
      if (capture) {
        if (diagnostics) this.diagnostic(diagnostics)
        this.diagnostic(screenshotPrefix + JSON.stringify({
          requestId: id, stage: 'host.settled', elapsedMs: performance.now() - started,
        }))
      }
    }
  }

  /**
   * Dispatch cleanup after any active request acknowledges completion or cancellation.
   * Available during graceful disposal. A refusal or timeout invalidates the connection; cleanup
   * awaits its closure before rejecting. Distinct operation and close failures are aggregated.
   * @param method - Host-only helper cleanup operation.
   * @param params - Resources owned by the enclosing execution.
   * @returns The native cleanup acknowledgement, bounded by the connection's request deadline.
   */
  async requestCleanup(method: string, params: Record<string, JsonValue>): Promise<JsonValue> {
    try {
      while (this.active) await this.active.outcome.catch(() => undefined)
      return await this.send('cleanup', method, params, new AbortController().signal)
    } catch (error) {
      this.fail(connectionFailure('NATIVE_CLEANUP', 'Native resource cleanup failed; acquire fresh application handles', error))
      return this.rejectAfterCleanup(error, this.waitForTransportClose())
    }
  }

  /** Await owned cleanup while retaining the operation's original failure. */
  private async rejectAfterCleanup(original: unknown, cleanup: Promise<void>): Promise<never> {
    try { await cleanup }
    catch (error) { throw combineFailures(original, error) }
    throw original
  }

  /**
   * Register resource cleanup before graceful connection closure.
   * @param cleanup Stops resource admission and releases native state through requestCleanup.
   * canRequest is false after forced closure; then perform local cleanup only. A true value
   * does not guarantee that the transport survives the callback. Never call request or dispose here.
   * @returns Removal after the resource's normal cleanup settles; an admitted callback remains awaited.
   * @throws NativeError when the connection has failed or disposal has begun.
   */
  registerCleanup(cleanup: (canRequest: boolean) => Promise<void>): () => void {
    if (this.disposed) throw new NativeError('NATIVE_CLOSED', 'Cannot register cleanup on a closing helper', { cause: this.failure })
    this.cleanups.add(cleanup)
    return () => { this.cleanups.delete(cleanup) }
  }

  private screenshotDiagnostics(): string {
    const records = [...this.diagnostics]
    if (this.discardedDiagnostics) records.unshift('[Earlier screenshot diagnostic records were discarded from the bounded diagnostic buffer.]')
    return records.join('\n')
  }

  private retainDiagnostic(value: z.infer<typeof ScreenshotDiagnostic>): void {
    if (value.requestId !== this.active?.id) return
    const line = screenshotPrefix + JSON.stringify(ScreenshotDiagnostic.parse(value))
    this.diagnostics.push(line)
    this.diagnosticBytes += Buffer.byteLength(line)
    while (this.diagnosticBytes > 8192) {
      const discarded = this.diagnostics.shift()
      assert(discarded !== undefined, 'Diagnostic bytes must belong to retained records')
      this.diagnosticBytes -= Buffer.byteLength(discarded)
      this.discardedDiagnostics = true
    }
  }

  private diagnostic(message: string): void {
    try { this.reportDiagnostic?.(message) }
    catch (error) {
      // Diagnostic consumers must not replace the native result or prevent process cleanup.
      void error
    }
  }

  /** Whether this connection rejects new operations because it failed or is closing. */
  get disposed(): boolean { return this.failure !== undefined || this.disposal !== undefined }

  /** Invalidate this Agent's handles and close its connection; await dispose for native cleanup. */
  invalidate(): void { this.fail(new NativeError('NATIVE_DISPOSED', 'Helper disposed')) }

  /** Stop new operations, settle registered resources, and await connection closure even when cleanup fails. */
  dispose(): Promise<void> {
    return this.disposal ??= Promise.resolve().then(async () => {
      this.active?.cancel?.()
      const results = await Promise.allSettled([...this.cleanups].map(cleanup =>
        Promise.resolve().then(() => cleanup(this.failure === undefined))))
      this.cleanups.clear()
      const errors = new Set<unknown>()
      for (const result of results) if (result.status === 'rejected') errors.add(result.reason)
      try {
        this.invalidate()
        await this.waitForTransportClose()
      } catch (error) { errors.add(error) }
      if (errors.size > 0) throw [...errors].reduce(combineFailures)
    })
  }

  /** Join transport closure without invoking resource callbacks or waiting on their disposal. */
  private waitForTransportClose(): Promise<void> {
    return this.transportClosed ??= Promise.resolve().then(() => this.handle.waitForClose()).finally(() => {
      this.handle.stdout.destroy()
      this.handle.stdin.destroy()
    })
  }

  /** Reject execution after an asynchronous transport callback invalidates the connection. */
  private throwIfFailed(): void {
    if (this.failure !== undefined) throw this.failure
  }

  private fail(error: NativeError): void {
    if (this.failure) return
    this.failure = error
    this.chunks.length = 0
    this.bufferedBytes = 0
    this.active?.reject(error)
    this.active = undefined
    this.handle.close()
  }

  private receive(chunk: Buffer): void {
    let offset = 0
    while (offset < chunk.length && !this.failure) {
      const newline = chunk.indexOf(10, offset)
      const end = newline < 0 ? chunk.length : newline + 1
      const piece = chunk.subarray(offset, end)
      if (this.bufferedBytes + piece.length > this.config.maxResponseBytes) {
        this.fail(new NativeError('NATIVE_RESPONSE_LIMIT', 'Helper response exceeded the configured byte limit'))
        return
      }
      this.chunks.push(piece)
      this.bufferedBytes += piece.length
      if (newline >= 0) this.receiveFrame()
      offset = end
    }
  }

  private receiveFrame(): void {
    try {
      const frame = Buffer.concat(this.chunks, this.bufferedBytes)
      const line = new TextDecoder('utf-8', { fatal: true }).decode(frame.subarray(0, frame.length - 1))
      const reply = WireReply.parse(JSON.parse(line))
      this.chunks.length = 0
      this.bufferedBytes = 0
      if ('type' in reply) {
        this.retainDiagnostic(reply)
        return
      }
      const active = this.active
      if (!active || reply.id !== active.id) throw new Error('Helper reply has no matching request')
      this.active = undefined
      if ('error' in reply) {
        const error = new NativeError(reply.error.code, reply.error.message)
        if (active.kind === 'cleanup' || reply.error.code === 'NATIVE_RESPONSE_LIMIT') this.fail(error)
        active.reject(error)
      } else active.resolve(reply.result)
    } catch (error) {
      this.fail(new NativeError('NATIVE_PROTOCOL', 'Helper returned an invalid response; acquire fresh application handles', { cause: error }))
    }
  }
}
