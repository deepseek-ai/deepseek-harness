/** Stable Host facts delivered by one established Remote event generation. */
export interface ConnectionHostInfo {
  /** Host account home used only to abbreviate displayed filesystem paths. */
  readonly home: string
}

/** One successfully established Host generation. */
export interface ConnectionGeneration {
  /** Monotone generation number within this Client runtime. */
  readonly id: number
  /** Host facts carried by this generation's opening frame. */
  readonly host: ConnectionHostInfo
}

/** Reconnect/backoff tunables. All fields are optional; defaults are below. */
export interface ConnectionConfig {
  /** First-retry backoff cap in ms (jittered: actual delay is cap/2..cap). */
  backoffBaseMs?: number
  /** Exponential growth factor per failed attempt; values at or below 1 make the base tier final. */
  backoffFactor?: number
  /** Upper bound for the backoff cap in ms. */
  backoffMaxMs?: number
  /** Maximum wait for the registered generation source's ready signal. */
  generationReadyTimeoutMs?: number
}

const CONNECTION_DEFAULTS: Required<ConnectionConfig> = {
  backoffBaseMs: 500,
  backoffFactor: 2,
  backoffMaxMs: 10_000,
  generationReadyTimeoutMs: 3_000,
}

const MANUAL_RECONNECT = new Error('connection: manual reconnect requested')
const NETWORK_STATE_CHANGED = new Error('connection: browser network state changed')

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(done, ms)
    signal.addEventListener('abort', done, { once: true })
    function done(): void {
      clearTimeout(t)
      signal.removeEventListener('abort', done)
      resolve()
    }
  })
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    signal.addEventListener('abort', () => { resolve() }, { once: true })
  })
}

/** Connection lifecycle state published after the first attempt has an outcome. */
export type ConnectionState =
  | 'connected'
  | 'disconnected'
  | 'connecting'

/** Connection-generation callbacks owned by API Gateway. */
export interface ConnectionSinks {
  /** After the generation source reports ready, first connect included. */
  onConnected?: (host: ConnectionHostInfo) => void
  /** State transitions after the initial attempt has an outcome. Equivalent states are deduplicated. */
  onStateChange?: (state: ConnectionState) => void
  /** Start one fresh physical-carrier attempt before each logical retry. */
  onReconnectRequested?: () => void
}

/**
 * One long-lived source defining a Connection generation. The source must
 * attach its incremental listeners before calling `ready`, then remain pending
 * until the generation is lost or `signal` aborts.
 * @param signal - cancellation for the current generation.
 * @param ready - one-shot report that incremental delivery is attached.
 * @returns a promise settling only when this generation ends or fails.
 */
export type ConnectionGenerationSource = (
  signal: AbortSignal,
  ready: (host: ConnectionHostInfo) => void,
) => Promise<void>

/**
 * Opens the registered generation source, reconnecting with exponential backoff on loss.
 * State (generation/attempt) is instance-private, never in the store.
 * Sink exceptions do not kill the generation loop.
 */
export class ConnectionController {
  private generation = 0
  private attempt = 0
  private current: AbortController | null = null
  private retryDelay: AbortController | null = null
  private running = false
  private immediateRetry = false
  private networkAvailable = true
  private lastState: ConnectionState | undefined
  private readonly config: Required<ConnectionConfig>

  constructor(
    private readonly source: ConnectionGenerationSource,
    private readonly sinks: ConnectionSinks = {},
    config: ConnectionConfig = {},
  ) {
    this.config = { ...CONNECTION_DEFAULTS, ...config }
  }

  /** Idempotent: begin the connect/pump/reconnect loop. */
  start(): void {
    if (this.running) return
    this.running = true
    void this.loop()
  }

  /** Stop the loop and abort the current generation source. */
  stop(): void {
    this.running = false
    this.current?.abort()
    this.current = null
    this.retryDelay?.abort()
    this.retryDelay = null
  }

  /** Reset the retry sequence and replace the current generation or retry delay immediately. */
  reconnect(): void {
    if (!this.running) return
    this.attempt = 0
    this.immediateRetry = true
    this.emitState('connecting')
    if (!this.isRunning()) return
    this.current?.abort(MANUAL_RECONNECT)
    this.retryDelay?.abort(MANUAL_RECONNECT)
  }

  /**
   * Suspend automatic retries while offline and restart backoff when the network returns.
   * @param available - whether the browser reports network access.
   */
  setNetworkAvailable(available: boolean): void {
    if (this.networkAvailable === available) return
    this.networkAvailable = available
    this.attempt = 0
    this.immediateRetry = false
    if (!this.running) return
    this.emitState(available ? 'connecting' : 'disconnected')
    if (!this.isRunning()) return
    this.current?.abort(NETWORK_STATE_CHANGED)
    this.retryDelay?.abort(NETWORK_STATE_CHANGED)
  }

  private backoffCap(attempt: number): number {
    const { backoffBaseMs, backoffFactor, backoffMaxMs } = this.config
    return Math.min(backoffMaxMs, backoffBaseMs * backoffFactor ** Math.max(0, attempt - 1))
  }

  private backoffDelay(attempt: number): number {
    const cap = this.backoffCap(attempt)
    return cap / 2 + Math.random() * (cap / 2)
  }

  private isFinalBackoffTier(attempt: number): boolean {
    const cap = this.backoffCap(attempt)
    const nextCap = this.backoffCap(attempt + 1)
    return cap >= this.config.backoffMaxMs || !Number.isFinite(nextCap) || nextCap <= cap
  }

  /** Read through a method: stop() flips the flag across awaits, so narrowing from the loop condition must not stick. */
  private isRunning(): boolean {
    return this.running
  }

  /** Re-read both mutable liveness guards after a potentially reentrant sink. */
  private isGenerationActive(controller: AbortController): boolean {
    return this.isRunning() && !controller.signal.aborted
  }

  private async loop(): Promise<void> {
    let retry = false
    while (this.running) {
      if (!this.networkAvailable && !this.immediateRetry) {
        const retryDelay = new AbortController()
        this.retryDelay = retryDelay
        this.emitState('disconnected')
        await waitForAbort(retryDelay.signal)
        if (this.retryDelay === retryDelay) this.retryDelay = null
        if (!this.isRunning()) return
        retry = true
        continue
      }

      let manualAttempt = false
      if (retry) {
        const immediate = this.immediateRetry
        this.immediateRetry = false
        if (immediate) this.attempt = 0
        manualAttempt = immediate
        if (!immediate && this.attempt > 0 && this.isFinalBackoffTier(this.attempt)) {
          const retryDelay = new AbortController()
          this.retryDelay = retryDelay
          this.emitState('disconnected')
          await waitForAbort(retryDelay.signal)
          if (this.retryDelay === retryDelay) this.retryDelay = null
          continue
        }
        const attempt = ++this.attempt
        this.emitState('connecting')
        if (!this.isRunning()) return
        if (!immediate) {
          const retryDelay = new AbortController()
          this.retryDelay = retryDelay
          await sleep(this.backoffDelay(attempt), retryDelay.signal)
          if (this.retryDelay === retryDelay) this.retryDelay = null
          if (!this.isRunning()) return
          if (retryDelay.signal.aborted) continue
        }
        console.warn(`[connection] connection lost, retry #${String(attempt)}`)
        this.callSink(() => { this.sinks.onReconnectRequested?.() })
        if (!this.isRunning()) return
      }

      const gen = ++this.generation
      const ac = new AbortController()
      this.current = ac

      let sourceReady = false
      let resolveReady!: (host: ConnectionHostInfo) => void
      let rejectReady!: (error: Error) => void
      let rejectSourceLost!: (error: Error) => void
      const ready = new Promise<ConnectionHostInfo>((resolve, reject) => {
        resolveReady = resolve
        rejectReady = reject
      })
      const sourceLost = new Promise<never>((_resolve, reject) => {
        rejectSourceLost = reject
      })
      const reportReady = (host: ConnectionHostInfo): void => {
        if (sourceReady) return
        sourceReady = true
        resolveReady(host)
      }

      const failed = new Promise<void>((resolve) => {
        const settle = (): void => {
          if (gen === this.generation && !ac.signal.aborted) ac.abort()
          resolve()
        }
        void Promise.resolve()
          .then(() => this.source(ac.signal, reportReady))
          .then(
            () => {
              const error = new Error('connection generation ended')
              if (!sourceReady) rejectReady(error)
              rejectSourceLost(error)
              settle()
            },
            (error: unknown) => {
              const failure = error instanceof Error
                ? error
                : new Error('connection generation failed', { cause: error })
              if (!sourceReady) rejectReady(failure)
              rejectSourceLost(failure)
              settle()
            },
          )
      })

      try {
        const host = await Promise.race([
          waitForReady(ready, this.config.generationReadyTimeoutMs, ac.signal),
          sourceLost,
        ])
        if (ac.signal.aborted) throw new Error('generation aborted during readiness handshake')
        this.attempt = 0
        this.emitState('connected')
        // A state sink may synchronously stop this controller.
        if (this.isGenerationActive(ac)) {
          this.callSink(() => { this.sinks.onConnected?.(host) })
        }
      } catch {
        // Source settlement and controller cancellation already abort the generation.
      }

      await failed
      if (!this.isRunning()) return
      if (manualAttempt) this.attempt = 0
      retry = true
    }
  }

  /** Deduplicated state emission (sink isolation applies). */
  private emitState(state: ConnectionState): void {
    if (this.lastState === state) return
    this.lastState = state
    this.callSink(() => this.sinks.onStateChange?.(state))
  }

  /** Sink exception isolation: a business-layer throw is logged only, never affecting pump or reconnect semantics. */
  private callSink(fn: () => void): void {
    try {
      fn()
    } catch (error) {
      console.error('[connection] connection sink threw:', error)
    }
  }
}

/** Await source readiness while reporting, but not cancelling, a slow Host. */
function waitForReady<T>(ready: Promise<T>, timeoutMs: number, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const timeout = setTimeout(() => {
      console.warn(`[connection] generation is still not ready after ${String(timeoutMs)}ms`)
    }, timeoutMs)
    const aborted = (): void => {
      finish({ error: new Error('connection generation aborted', { cause: signal.reason }) })
    }
    const finish = (outcome: { readonly value: T } | { readonly error: Error }): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      signal.removeEventListener('abort', aborted)
      if ('error' in outcome) reject(outcome.error)
      else resolve(outcome.value)
    }
    signal.addEventListener('abort', aborted, { once: true })
    void ready.then(
      (value) => { finish({ value }) },
      (error: unknown) => {
        finish({ error: error as Error })
      },
    )
  })
}
