/** Ordinary event SDK batching over a cancellable HTTP transport. */
import type { Attributes } from '@opentelemetry/api'
import { addAbortListener } from 'node:events'
import { SeverityNumber, type Logger } from '@opentelemetry/api-logs'
import { ExportResultCode } from '@opentelemetry/core'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { BatchLogRecordProcessor, LoggerProvider } from '@opentelemetry/sdk-logs'
import type { BatchLogRecordProcessorOptions, LogRecordExporter } from '@opentelemetry/sdk-logs'
import type { SessionLogOptions } from './session-log.ts'
import { createEventLogExporter } from './event-transport.ts'

/** Scalar values accepted by the collector's Arrow attributes map. */
export type OTelEventScalar = string | number | boolean

/** Explicitly selected analytics fields; object values may contain scalars only. */
export interface OTelEventRecord {
  /** Product/DA-owned event name. */
  eventName: string
  /** Human-readable summary; never a prompt, response, credential, or file contents. */
  body: string
  /** Event occurrence time in Unix milliseconds. Observation time is assigned on enqueue. */
  timestamp: number
  /** OTel severity; omitted values use INFO. */
  severityNumber?: SeverityNumber
  /** Business fields selected by the caller; no automatic device or account identity. */
  attributes?: Record<string, OTelEventScalar | Record<string, OTelEventScalar>>
}

/** Ordinary-event transport, resource, scope, and count-batching options. */
export interface EventLogOptions {
  exporter: SessionLogOptions['exporter']
  resourceAttributes: Attributes
  scope: { name: string; version?: string }
  processor: Omit<BatchLogRecordProcessorOptions, 'exporter'>
  onFailure: SessionLogOptions['onFailure']
}

/** One caller-owned ordinary-event queue, independent of every Session-log queue. */
export class EventLogReporter {
  private readonly exporter: LogRecordExporter
  private readonly provider: LoggerProvider
  private readonly logger: Logger
  private readonly cancellation = new AbortController()

  /** @param options - explicit transport, resource, scope, queue, and diagnostic settings. */
  constructor(options: EventLogOptions) {
    const exporter = createEventLogExporter(options.exporter, this.cancellation.signal)
    this.exporter = exporter
    this.provider = new LoggerProvider({
      resource: resourceFromAttributes(options.resourceAttributes),
      processors: [new BatchLogRecordProcessor({
        ...options.processor,
        exporter: {
          export: (records, callback) => {
            exporter.export(records, (result) => {
              if (result.code !== ExportResultCode.SUCCESS) options.onFailure('Product telemetry export failed', result.error)
              callback(result)
            })
          },
          forceFlush: () => exporter.forceFlush(),
          shutdown: () => exporter.shutdown(),
        },
      })],
    })
    this.logger = this.provider.getLogger(options.scope.name, options.scope.version)
  }

  /**
   * Enqueue caller-selected analytics fields without acknowledging delivery.
   * @param record - the ordinary event to report.
   */
  emit(record: OTelEventRecord): void {
    const severityNumber = record.severityNumber ?? SeverityNumber.INFO
    this.logger.emit({ ...record, observedTimestamp: Date.now(), severityNumber, severityText: SeverityNumber[severityNumber] })
  }

  /**
   * Drain the queue and release its transport, cancelling remaining exports when the caller aborts.
   * @param signal - optional shutdown deadline; abort discards pending exports and cancels retry waits.
   * @returns completion of SDK shutdown and transport cleanup.
   */
  async shutdown(signal?: AbortSignal): Promise<void> {
    const abort = (): void => { this.cancellation.abort(signal?.reason) }
    const listener = signal === undefined ? undefined : addAbortListener(signal, abort)
    if (signal?.aborted) abort()
    try { await this.provider.shutdown() }
    finally {
      // SDK batch shutdown can reject before it releases the exporter.
      try { await this.exporter.shutdown() }
      finally { listener?.[Symbol.dispose]() }
    }
  }
}
