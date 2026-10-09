/**
 * OpenTelemetry Service Provider for the DeepSeek Harness telemetry capability.
 *
 * Authorizes feedback-bounded capture and hands complete event strings to the
 * Session-log reporter. This plugin owns resource identity and an outer
 * shutdown deadline; the reporter owns byte-bounded SDK delivery.
 *
 * @module @deepseek-ai/dsh-session-telemetry-otel
 */

import { createRequire } from 'node:module'
import z from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-command-feedback'
import type {} from '@deepseek-ai/dsh-message-feedback'
import { Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import {
  SessionTelemetryBackend,
  SessionTelemetryCoordinator,
  type SessionTelemetrySink,
  type SessionTelemetryRecord,
  type SessionTelemetrySeverity,
  type SessionTelemetrySharingStatus,
} from '@deepseek-ai/dsh-session-telemetry'
import { APP_IDENTITY } from '@deepseek-ai/dsh-llm'
import { getOrCreateAnonymousUserId } from '@deepseek-ai/dsh-anonymous-user-id'
import type { LogExporterOptions, SessionLogProcessorOptions, SessionLogReporter } from '@deepseek-ai/dsh-otel'
import { SeverityNumber } from '@opentelemetry/api-logs'

/** Session-sharing policy selected by {@link Config.mode}. */
export enum SessionTelemetryMode {
  FEEDBACK_ONLY = 'FEEDBACK_ONLY',
  DISABLED = 'DISABLED',
}

/** Default session-sharing policy for schema and direct construction. */
export const DEFAULT_TELEMETRY_MODE = SessionTelemetryMode.FEEDBACK_ONLY

const DISABLED_FEEDBACK_WARNING = 'OpenTelemetry session upload is DISABLED; this feedback is not uploaded through OpenTelemetry'
const NON_CANONICAL_EVENT_WARNING = 'session telemetry ignored an event absent from the canonical session log'

/** Only this Session's explicit feedback authorizes replay; fork seeds do not. */
function isFeedback(session: Session, event: SessionEvent): boolean {
  if (event.seq < session.inheritedEventCount) return false
  switch (event.type) {
    case 'feedback/record': return true
    case 'feedback/message-put':
    case 'feedback/message-delete': return event.data.sessionId === session.id
    default: return false
  }
}

/** Resolve the default and reject unknown runtime values before transport setup. */
function resolveMode(mode: SessionTelemetryMode | undefined): SessionTelemetryMode {
  const resolved = mode ?? DEFAULT_TELEMETRY_MODE
  switch (resolved) {
    case SessionTelemetryMode.FEEDBACK_ONLY:
    case SessionTelemetryMode.DISABLED:
      return resolved
    default:
      return assertNever(resolved)
  }
}

/** Fail closed when direct construction bypasses the runtime config schema. */
function assertNever(value: never): never {
  throw new Error(`session-telemetry-otel: unsupported mode ${JSON.stringify(value)}`)
}

/** Map the serialized mode onto the seam's backend-independent sharing vocabulary. */
function sharingStatusFor(mode: SessionTelemetryMode): SessionTelemetrySharingStatus {
  switch (mode) {
    case SessionTelemetryMode.FEEDBACK_ONLY: return 'feedback-only'
    case SessionTelemetryMode.DISABLED: return 'disabled'
    /* v8 ignore next 2 -- resolveMode already rejected unknown values before this switch; the closed enum cannot reach the default. */
    default: return assertNever(mode)
  }
}

/**
 * Plugin configuration: sharing policy, SDK transport options, byte/count queue
 * settings, and an overall shutdown bound. Uploading modes validate their endpoint
 * and shutdown deadline at plugin load; `DISABLED` reads neither.
 */
export interface Config {
  /** Defaults to `FEEDBACK_ONLY`: capture session history only when feedback is explicitly submitted. */
  mode?: SessionTelemetryMode
  /**
   * Explicit SDK HTTP transport settings, including optional routing headers.
   * Ambient credentials are not inherited. URL is required while uploading.
   * Exporter self-observability metering is not supported.
   */
  exporter?: Omit<LogExporterOptions, 'url'> & {
    /** Full logs endpoint (e.g. `https://collector.example.com/v1/logs`). Required outside `DISABLED`; validated at load. */
    url?: string
  }
  /**
   * Count, queue, cadence, and per-request watchdog settings for the byte-bounded
   * processor. A watchdog warning never releases an unsettled transport slot.
   * SDK processor self-observability metering is not supported.
   */
  processor?: SessionLogProcessorOptions
  /** Maximum time spent awaiting the SDK provider's complete shutdown path. */
  shutdownTimeoutMillis?: number
  /** Uncompressed OTLP request byte limit, at most 4,000,000. */
  maxRequestBytes?: number
}

/**
 * Schemastery validator for {@link Config}; cordis runs it before the plugin
 * starts. The constructor validates endpoint and shutdown requirements; the
 * reporter validates Session byte and queue limits. SDK transport and
 * processor settings use the reporter's accepted option types, which exclude
 * self-observability metering.
 */
export const Config: z<Config> = z.object({
  mode: z.union(Object.values(SessionTelemetryMode)).default(DEFAULT_TELEMETRY_MODE),
  exporter: z.any(),
  processor: z.any(),
  shutdownTimeoutMillis: z.number(),
  maxRequestBytes: z.number().step(1).min(1).max(4_000_000),
})

/** Default outer allowance for the SDK's complete shutdown sequence. */
export const DEFAULT_SHUTDOWN_TIMEOUT_MILLIS = 3_000

// Node clamps larger timer delays to one millisecond. This is a runtime
// protocol limit, not a deployment default.
const MAX_TIMER_DELAY_MILLIS = 2_147_483_647

/** Severity mapping from the Service Definition's three-level vocabulary to OTel severity numbers. */
const SEVERITY: Record<SessionTelemetrySeverity, SeverityNumber> = {
  info: SeverityNumber.INFO,
  warn: SeverityNumber.WARN,
  error: SeverityNumber.ERROR,
}

/**
 * The backend plugin — the only entry a deployment loads. It always registers
 * the `sessionTelemetry` service (duplicate load throws). `FEEDBACK_ONLY` wires the SDK
 * pipeline and on-demand {@link SessionTelemetryCoordinator}; `DISABLED` constructs no
 * SDK state and listens only to warn when recorded feedback stays local.
 */
export class OpenTelemetrySessionBackend extends SessionTelemetryBackend {
  static inject = ['sessions', 'otel']
  static Config = Config

  private readonly provider: SessionLogReporter | undefined
  private readonly shutdownTimeoutMillis: number
  override readonly sharing: SessionTelemetrySharingStatus

  constructor(ctx: Context, config: Config) {
    const mode = resolveMode(config.mode)
    super(ctx)
    this.sharing = sharingStatusFor(mode)
    if (mode === SessionTelemetryMode.DISABLED) {
      this.provider = undefined
      this.shutdownTimeoutMillis = DEFAULT_SHUTDOWN_TIMEOUT_MILLIS
      ctx.on('session/event', (session, event) => {
        if (isFeedback(session, event)) ctx.logger.warn(DISABLED_FEEDBACK_WARNING)
      })
      return
    }

    const url = config.exporter?.url
    if (url === undefined || url.length === 0) {
      throw new Error('session-telemetry-otel: exporter.url is required (the full OTLP logs endpoint)')
    }
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      // Re-thrown as a config error: the only way here is a malformed url string.
      throw new Error(`session-telemetry-otel: exporter.url is not a valid URL: ${JSON.stringify(url)}`)
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`session-telemetry-otel: exporter.url must be http(s), got ${parsed.protocol}`)
    }
    // Reject empty batches before allocating the reporter.
    const batchSize = config.processor?.maxExportBatchSize
    if (batchSize !== undefined && (!Number.isInteger(batchSize) || batchSize < 1)) {
      throw new Error(`session-telemetry-otel: processor.maxExportBatchSize must be a positive integer, got ${String(batchSize)}`)
    }
    const shutdownTimeoutMillis = config.shutdownTimeoutMillis ?? DEFAULT_SHUTDOWN_TIMEOUT_MILLIS
    if (!Number.isFinite(shutdownTimeoutMillis) || shutdownTimeoutMillis <= 0 || shutdownTimeoutMillis > MAX_TIMER_DELAY_MILLIS) {
      throw new Error(`session-telemetry-otel: shutdownTimeoutMillis must be a positive finite number no greater than ${MAX_TIMER_DELAY_MILLIS}, got ${String(shutdownTimeoutMillis)}`)
    }
    this.shutdownTimeoutMillis = shutdownTimeoutMillis
    const { version } = createRequire(import.meta.url)('../package.json') as { version: string }
    const reporter = ctx.otel.createSessionLogReporter({
      scope: { name: '@deepseek-ai/dsh-session-telemetry-otel', version },
      exporter: { ...config.exporter, url },
      ...(config.processor === undefined ? {} : { processor: config.processor }),
      ...(config.maxRequestBytes === undefined ? {} : { maxRequestBytes: config.maxRequestBytes }),
      resourceAttributes: {
        'service.name': APP_IDENTITY.product,
        'service.version': APP_IDENTITY.version,
        'user.id': getOrCreateAnonymousUserId(),
      },
      onFailure: (message, error) => { ctx.logger.warn(message, error) },
    })
    this.provider = reporter
    const enqueue: SessionTelemetrySink['emit'] = (record) => {
      if (record.sourceEvent === undefined) {
        ctx.logger.warn('Session log record withheld: redaction removed sourceEvent')
        return
      }
      reporter.reportSessionLog({
        sessionId: record.sourceEvent.sessionId,
        event: { ...record.sourceEvent.envelope, data: record.body },
        severityNumber: SEVERITY[record.severity],
        attributes: record.attributes,
      })
    }
    const backend: SessionTelemetrySink = {
      emit: enqueue,
      shutdown: () => this.shutdown(),
    }
    const coordinator = new SessionTelemetryCoordinator(ctx, backend, {
      capture: 'on-demand',
      includeHistory: true,
    })
    ctx.on('session/event', (session, event) => {
      if (!isFeedback(session, event)) return
      // Only the canonical appended event authorizes this exact prefix.
      // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
      if (session.eventAt(event.seq) !== event) {
        ctx.logger.warn(NON_CANONICAL_EVENT_WARNING)
        return
      }
      coordinator.captureSession(session, event.seq)
    })
    ctx.on('feedback/committed', (inspection) => {
      const snapshot = structuredClone(inspection)
      const committed = snapshot.events.at(-1)
      if (committed === undefined) return
      const session = Session.fromRestore(
        snapshot.meta.id, snapshot.events, snapshot.meta, snapshot.inheritedEventCount,
        'detached', ctx.sessions.messageProjections,
      )
      // fromRestore appends a lifecycle marker that this submission did not commit.
      if (isFeedback(session, committed)) coordinator.captureSession(session, committed.seq)
    })
  }

  /**
   * Drop direct records. Only a new canonical feedback submission can authorize
   * capture through the private coordinator sink, for every provider.
   * @param _record - the direct record, never uploaded.
   */
  emit(_record: SessionTelemetryRecord): void {}

  /**
   * Drain queued HTTP requests until the deployment deadline. The watchdog
   * never releases an unsettled transport slot. At the outer deadline,
   * queued records are abandoned and no further requests may start.
   * @returns completion after transport shutdown, or rejection at the configured deadline.
   */
  async shutdown(): Promise<void> {
    if (this.provider === undefined) return
    const providerShutdown = this.provider.shutdown()
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        this.provider?.stopPending()
        reject(new Error(`session-telemetry-otel: provider shutdown exceeded ${this.shutdownTimeoutMillis}ms`))
      }, this.shutdownTimeoutMillis)
    })
    try {
      await Promise.race([providerShutdown, deadline])
    } finally {
      /* v8 ignore else -- the Promise executor assigns timer synchronously before this race starts. */
      if (timer !== undefined) clearTimeout(timer)
    }
  }
}

export default OpenTelemetrySessionBackend
