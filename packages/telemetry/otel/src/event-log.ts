/** Ordinary event batching over an explicit SDK HTTP transport. */
import type { Attributes } from '@opentelemetry/api'
import { SeverityNumber, type Logger } from '@opentelemetry/api-logs'
import { ExportResultCode } from '@opentelemetry/core'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { BatchLogRecordProcessor, LoggerProvider, type BatchLogRecordProcessorOptions } from '@opentelemetry/sdk-logs'
import type { SessionLogOptions } from './session-log.ts'
import { createLogExporter } from './transport.ts'

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
  private readonly provider: LoggerProvider
  private readonly logger: Logger

  /** @param options - explicit transport, resource, scope, queue, and diagnostic settings. */
  constructor(options: EventLogOptions) {
    const exporter = createLogExporter(options.exporter)
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
   * Drain the queue and release its SDK transport.
   * @returns completion of SDK shutdown; callers own their outer deadline.
   */
  shutdown(): Promise<void> { return this.provider.shutdown() }
}
