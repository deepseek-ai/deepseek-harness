/**
 * High-level run API over {@link HarnessClient}: `DeepSeekHarness` owns one
 * runtime subprocess across many sessions; `HarnessSession.run` sends a
 * prompt and settles when the whole agent next becomes idle.
 *
 * @module @deepseek-ai/dsh-sdk-client/api
 */

import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import type { SessionEvent, TurnEndReason } from '@deepseek-ai/dsh-session'
import { createProcessHarnessClient, HarnessClient, isRecord, SdkProtocolError } from './client.ts'
import type { RuntimeProcessOptions } from './launch.ts'
import type { ContentBlock, DeepSeekHarnessOptions, HarnessNotification, RunResult, SdkPromptContentBlock } from './types.ts'

/**
 * Reusable SDK for running DeepSeek Harness agent turns in a runtime
 * subprocess. The subprocess starts lazily on first use and stays owned by
 * this instance until {@link close}; always close (or `await using`) so the
 * child is reaped.
 */
export class DeepSeekHarness implements AsyncDisposable {
  private clientInstance: HarnessClient
  private readonly createClient: () => HarnessClient
  private readonly cwd: string
  private readonly provider: string
  private readonly model: string
  private readonly reasoningEffort: DeepSeekHarnessOptions['reasoningEffort']
  private readonly maxTokens: number | undefined
  private initialized: Promise<void> | undefined
  private closed = false

  /** @param options - dsh launch configuration plus the session route, effort, and output cap. */
  constructor(options?: DeepSeekHarnessOptions)
  constructor(options: DeepSeekHarnessOptions = {}, clientFactory?: () => HarnessClient) {
    this.createClient = clientFactory ?? (() => new HarnessClient(options))
    this.clientInstance = this.createClient()
    // Absolute before the handshake: the child spawns relative to THIS
    // process's cwd, but the wire cwd is resolved again inside the child — a
    // relative value would double-resolve (e.g. `worker` → `worker/worker`).
    this.cwd = resolve(options.cwd ?? options.processCwd ?? process.cwd())
    this.provider = options.provider ?? 'deepseek-official'
    this.model = options.model ?? 'deepseek-v4-flash'
    this.reasoningEffort = options.reasoningEffort
    this.maxTokens = options.maxTokens
  }

  /**
   * The underlying JSON-RPC client (exposed for low-level access). A failed
   * handshake swaps in a fresh instance only after cleanup proves the runtime
   * exited; cleanup failure retains this client, so do not cache it across a
   * failed {@link start}.
   * @returns the client currently owning the runtime subprocess.
   */
  get client(): HarnessClient {
    return this.clientInstance
  }

  /**
   * Start the subprocess and perform the `initialize` handshake once. On
   * failure, successful SDK-owned cleanup reaps the runtime and installs a
   * fresh client (`HarnessClient.close` is permanent), so a later call retries
   * with a new subprocess unless {@link close} already ended this harness. If
   * cleanup also fails, rejects with an `AggregateError` whose ordered errors
   * preserve both causes and retains the failed client rather than spawning
   * alongside a process whose exit was not proved.
   * @returns settlement of the (memoized) handshake.
   */
  start(): Promise<void> {
    this.initialized ??= (async () => {
      try {
        this.clientInstance.start()
        await this.clientInstance.initialize({
          cwd: this.cwd,
          provider: this.provider,
          model: this.model,
          ...this.reasoningEffort === undefined ? {} : { reasoningEffort: this.reasoningEffort },
          ...this.maxTokens === undefined ? {} : { maxTokens: this.maxTokens },
        })
      } catch (error) {
        this.initialized = undefined
        try {
          await this.clientInstance.close()
        } catch (cleanupError: unknown) {
          throw new AggregateError(
            [error, cleanupError],
            'DeepSeek Harness initialization and cleanup failed',
          )
        }
        if (!this.closed) this.clientInstance = this.createClient()
        throw error
      }
    })()
    return this.initialized
  }

  /**
   * Open a session handle (no wire traffic; the runtime creates the session
   * on its first prompt).
   * @param sessionId - explicit id to reuse; omitted mints a fresh one.
   * @returns the session handle.
   */
  session(sessionId?: string): HarnessSession {
    return new HarnessSession(this, sessionId ?? `session-${randomUUID().replaceAll('-', '')}`)
  }

  /**
   * Run one prompt on a fresh (or named) session.
   * @param input - prompt text, or content blocks sent verbatim.
   * @param options - optional session id and per-notification observer.
   * @returns the owned activity interval.
   */
  run(input: string | SdkPromptContentBlock[], options?: RunOptions): Promise<RunResult> {
    return this.session(options?.sessionId).run(input, options)
  }

  /**
   * Shut down and reap the runtime subprocess. Idempotent and terminal —
   * a closed harness no longer retries a failed handshake.
   * @returns settlement of the complete teardown.
   */
  close(): Promise<void> {
    this.closed = true
    return this.clientInstance.close()
  }

  /**
   * `await using` support: {@link close}.
   * @returns settlement of the teardown.
   */
  [Symbol.asyncDispose](): Promise<void> {
    return this.close()
  }
}

/** Construct the high-level API against a generic process for package-local fake-runtime tests. */
export function createProcessDeepSeekHarness(
  runtime: RuntimeProcessOptions,
  options: DeepSeekHarnessOptions = {},
): DeepSeekHarness {
  const Constructor = DeepSeekHarness as new (
    publicOptions: DeepSeekHarnessOptions,
    clientFactory: () => HarnessClient,
  ) => DeepSeekHarness
  return new Constructor({
    ...runtime.cwd === undefined ? {} : { processCwd: runtime.cwd },
    ...options,
  }, () => createProcessHarnessClient(runtime))
}

/** Per-run options: target session and streaming observer. */
export interface RunOptions {
  /** Session id to run on; omitted mints a fresh session per call. */
  sessionId?: string
  /** Observer invoked with every notification for this session tree, in wire order. */
  onNotification?: (notification: HarnessNotification) => void
}

/**
 * One SDK session: a stable id plus owned activity intervals.
 */
export class HarnessSession {
  /**
   * @param harness - the owning harness (supplies the client and handshake).
   * @param id - the wire session id this handle runs on.
   */
  constructor(readonly harness: DeepSeekHarness, readonly id: string) {}

  /**
   * Queue one prompt, then observe the whole session through its next idle.
   * @param input - prompt text, or content blocks sent verbatim.
   * @param options - optional per-notification observer.
   * @returns the owned activity interval; rejects on transport loss, timeout,
   * or a protocol error.
   */
  async run(input: string | SdkPromptContentBlock[], options?: Pick<RunOptions, 'onNotification'>): Promise<RunResult> {
    await this.harness.start()
    const client = this.harness.client
    const contentBlocks = normalizeInput(input)
    const events: SessionEvent[] = []
    const notifications: HarnessNotification[] = []

    const subscription = client.subscribeSessionTree(this.id)
    const collect = (notification: HarnessNotification): void => {
      if (notification.method === 'session.event' && notification.params.sessionId === this.id) {
        // Wire boundary: the envelope feeds the typed RunResult, so a
        // malformed runtime surfaces as a protocol error, not as type-invalid
        // data (or a TypeError out of finalResponse).
        const event = validatedSessionEvent(notification.params.event)
        notifications.push(notification)
        options?.onNotification?.(notification)
        events.push(event)
        return
      }
      notifications.push(notification)
      options?.onNotification?.(notification)
    }
    try {
      const messageId = await client.prompt(this.id, contentBlocks)
      let received = false
      while (true) {
        const notification = await subscription.next()
        if (!received) {
          if (notification.method !== 'session.event'
            || notification.params.sessionId !== this.id
            || !isInboxReceipt(notification.params.event, messageId)) continue
          received = true
        }
        collect(notification)
        if (notification.method === 'session.status'
          && notification.params.sessionId === this.id
          && notification.params.status === 'idle') break
      }
    } finally {
      subscription.close()
    }

    return {
      sessionId: this.id,
      finalResponse: finalResponse(events),
      events,
      notifications,
    }
  }
}

/**
 * Normalize run input: a string becomes one text block; blocks pass verbatim.
 * @param input - prompt text or content blocks.
 * @returns the content blocks to send.
 */
export function normalizeInput(input: string | SdkPromptContentBlock[]): SdkPromptContentBlock[] {
  return typeof input === 'string' ? [{ type: 'text', text: input }] : input
}

/** Validate the provider-read fields of one wire turn-end reason. */
function validatedTurnEndReason(value: unknown): TurnEndReason {
  if (!isRecord(value) || typeof value.kind !== 'string') {
    throw new SdkProtocolError(`turn/end carried no reason envelope: ${JSON.stringify(value)}`)
  }
  if (value.kind === 'aborted') {
    if (!isRecord(value.reason) || typeof value.reason.kind !== 'string') {
      throw new SdkProtocolError(`turn/end carried a malformed aborted reason: ${JSON.stringify(value)}`)
    }
    switch (value.reason.kind) {
      case 'user':
      case 'parent':
      case 'disposed':
      case 'legacy':
        break
      case 'hook':
        if (typeof value.reason.reason !== 'string') {
          throw new SdkProtocolError(`turn/end carried a malformed hook abort reason: ${JSON.stringify(value)}`)
        }
        break
      default:
        throw new SdkProtocolError(`turn/end carried an unknown abort reason: ${JSON.stringify(value)}`)
    }
  }
  return value as TurnEndReason
}

/** Validate the fields in a wire `session.event` envelope before returning the typed result. */
function validatedSessionEvent(value: unknown): SessionEvent {
  if (!isRecord(value) || typeof value.type !== 'string') {
    throw new SdkProtocolError(`session.event carried no event envelope: ${JSON.stringify(value)}`)
  }
  // The one variant this module reads into (finalResponse) must carry
  // kind-tagged content blocks; other variants pass through under their
  // envelope shape.
  if (value.type === 'assistant/message') {
    const message = isRecord(value.data) ? value.data.message : undefined
    const content = isRecord(message) ? message.content : undefined
    if (!Array.isArray(content) || !content.every(block => isRecord(block) && typeof block.type === 'string')) {
      throw new SdkProtocolError(`assistant/message event carried malformed content: ${JSON.stringify(value)}`)
    }
  }
  if (value.type === 'turn/end') {
    const data = isRecord(value.data) ? value.data : undefined
    if (data === undefined) {
      throw new SdkProtocolError(`turn/end event carried malformed data: ${JSON.stringify(value)}`)
    }
    validatedTurnEndReason(data.reason)
  }
  return value as SessionEvent
}

/** Whether a raw session event is the durable enqueue receipt for `messageId`. */
function isInboxReceipt(value: unknown, messageId: string): boolean {
  if (!isRecord(value) || value.type !== 'agent/inbox/spliced' || !isRecord(value.data)) return false
  const inserted = value.data.inserted
  return Array.isArray(inserted) && inserted.some(message => isRecord(message) && message.id === messageId)
}

/**
 * Extract the concatenated text of the last assistant message.
 * @param events - the activity interval's `session.event` payloads in wire order.
 * @returns the final response text, or `''` when no assistant message exists.
 */
export function finalResponse(events: SessionEvent[]): string {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]
    if (event?.type !== 'assistant/message') continue
    return event.data.message.content
      .filter((block): block is ContentBlock & { type: 'text' } => block.type === 'text')
      .map(block => block.text)
      .join('')
  }
  return ''
}
