/** Product analytics policy adapter for the shared Cordis OTel service. */
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { validateHeaderValue } from 'node:http'
import { CompressionAlgorithm } from '@opentelemetry/otlp-exporter-base'
import type { EventLogReporter, OTelEventRecord, OTelEventScalar } from '@deepseek-ai/dsh-otel'

declare module '@deepseek-ai/cordis' {
  interface Context { productTelemetry: ProductTelemetry }
}

/** Caller-selected ordinary analytics record. */
export type ProductTelemetryRecord = OTelEventRecord
/** Scalar values accepted in product attributes. */
export type ProductTelemetryScalar = OTelEventScalar

/** Collector routing, application identity, and bounded in-memory batch settings. */
export interface Config {
  /** Full HTTP(S) logs URL. */
  endpoint: string
  /** Collector routing header. */
  channel: string
  /** Resource service.name supplied by the application composition. */
  serviceName: string
  /** Resource service.version supplied by the application composition. */
  serviceVersion: string
  /** Omit to honor OTEL_EXPORTER_OTLP_LOGS_COMPRESSION / OTEL_EXPORTER_OTLP_COMPRESSION. */
  compression?: 'none' | 'gzip'
  /** Maximum records per export; must not exceed maxQueueSize. */
  maxExportBatchSize: number
  /** Maximum queued records; the SDK drops new records when full. */
  maxQueueSize: number
  /** Delay before exporting a partial batch. */
  scheduledDelayMillis: number
  /** Exporter HTTP deadline, including SDK transient-error retries. */
  timeoutMillis: number
  /** Processor deadline for one batch export. */
  exportTimeoutMillis: number
  /** Drain deadline; expiry cancels pending exports before disposal completes. */
  shutdownTimeoutMillis: number
}

const positiveInteger = () => z.number().step(1).min(1).max(2_147_483_647)

/** Loader validation and defaults for application compositions. */
export const Config: z<Partial<Config>, Config> = z.object({
  endpoint: z.string().default('https://dsh-otel-collector.deepseeksvc.com/v1/logs'),
  channel: z.string().min(1).default('dsh_otel_report'),
  serviceName: z.string().required(),
  serviceVersion: z.string().required(),
  compression: z.union(['none', 'gzip']),
  maxExportBatchSize: positiveInteger().default(512),
  maxQueueSize: positiveInteger().default(2048),
  scheduledDelayMillis: positiveInteger().default(30000),
  timeoutMillis: positiveInteger().default(15000),
  exportTimeoutMillis: positiveInteger().default(20000),
  shutdownTimeoutMillis: positiveInteger().default(21000),
})

/** Host analytics sender. Mounting alone sends nothing; the owning fiber drains it on unload. */
export default class ProductTelemetry extends Service {
  static inject = ['otel']
  static Config = Config
  private readonly reporter: EventLogReporter

  constructor(ctx: Context, config: Config) {
    let endpoint: URL
    try {
      endpoint = new URL(config.endpoint)
    } catch (cause) {
      throw new Error('product-telemetry-otel: endpoint must be a valid HTTP(S) URL', { cause })
    }
    try {
      validateHeaderValue('x-channel', config.channel)
    } catch (cause) {
      throw new Error('product-telemetry-otel: channel must be a valid HTTP header value', { cause })
    }
    if (!['http:', 'https:'].includes(endpoint.protocol)) {
      throw new Error('product-telemetry-otel: endpoint must use HTTP or HTTPS')
    }
    if (config.maxExportBatchSize > config.maxQueueSize) {
      throw new Error('product-telemetry-otel: maxExportBatchSize must not exceed maxQueueSize')
    }
    super(ctx, 'productTelemetry')
    const reporter = ctx.otel.createEventReporter({
      exporter: {
        url: config.endpoint, headers: { 'x-channel': config.channel }, timeoutMillis: config.timeoutMillis,
        ...(config.compression === undefined ? {} : { compression: config.compression === 'gzip' ? CompressionAlgorithm.GZIP : CompressionAlgorithm.NONE }),
      },
      resourceAttributes: { 'service.name': config.serviceName, 'service.version': config.serviceVersion },
      scope: { name: '@deepseek-ai/dsh-host-product-telemetry-otel' },
      processor: {
        maxExportBatchSize: config.maxExportBatchSize, maxQueueSize: config.maxQueueSize,
        scheduledDelayMillis: config.scheduledDelayMillis, exportTimeoutMillis: config.exportTimeoutMillis,
      },
      onFailure: (message, error) => { ctx.logger.warn(message, error) },
    })
    this.reporter = reporter
    ctx.effect(() => async () => {
      const cancellation = new AbortController()
      const timer = setTimeout(() => {
        ctx.logger.warn('Product telemetry shutdown deadline exceeded; pending events may be lost')
        cancellation.abort(new Error('Product telemetry shutdown deadline exceeded'))
      }, config.shutdownTimeoutMillis)
      try {
        await reporter.shutdown(cancellation.signal)
      } finally {
        clearTimeout(timer)
      }
    })
  }

  /**
   * Enqueue one selected product event without waiting for network delivery.
   * Queue admission and shutdown completion are not collector or warehouse acknowledgements.
   * @param record - caller-owned event containing only approved analytics fields.
   */
  emit(record: ProductTelemetryRecord): void {
    this.reporter.emit(record)
  }
}
