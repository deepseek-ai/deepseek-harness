/** Cancellable ordinary-event HTTP exports, including retry waits and response reads. */
import type { Agent as HttpsAgent } from 'node:https'
import { gzipSync } from 'node:zlib'
import got from 'got'
import { createOtlpNetworkExportDelegate, OTLPExporterBase } from '@opentelemetry/otlp-exporter-base'
import { JsonLogsSerializer } from '@opentelemetry/otlp-transformer'
import type { LogRecordExporter } from '@opentelemetry/sdk-logs'
import { createLogExporterMetrics, type LogExporterOptions, logTransportOptions } from './transport.ts'

/**
 * Create a channel-owned exporter whose cancellation releases requests and retry timers.
 * @param options - explicit collector and SDK HTTP settings.
 * @param signal - channel cancellation, shared by current and future batch exports.
 * @returns the SDK exporter; shutdown also destroys its owned HTTP agent.
 */
export function createEventLogExporter(options: LogExporterOptions, signal: AbortSignal): LogRecordExporter {
  const config = logTransportOptions(options)
  let agent: ReturnType<typeof config.agentFactory> | undefined
  const exporter = new OTLPExporterBase(createOtlpNetworkExportDelegate(config, JsonLogsSerializer, createLogExporterMetrics(config.url), {
    async send(data, timeoutMillis) {
      signal.throwIfAborted()
      agent ??= config.agentFactory(new URL(config.url).protocol)
      const selectedAgent = await agent
      const headers = await config.headers()
      signal.throwIfAborted()
      const compressed = config.compression === 'gzip'
      const request = got.post(config.url, {
        body: compressed ? gzipSync(data) : Buffer.from(data),
        headers: { ...headers, ...(compressed ? { 'content-encoding': 'gzip' } : {}),
          ...(config.userAgent === undefined ? {} : { 'user-agent': config.userAgent }) },
        agent: new URL(config.url).protocol === 'https:' ? { https: selectedAgent as HttpsAgent } : { http: selectedAgent },
        signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMillis)]),
        followRedirect: false,
        retry: { limit: 5, methods: ['POST'], statusCodes: [429, 502, 503, 504], errorCodes: [], backoffLimit: 5000 },
        responseType: 'buffer',
      })
      // Match the SDK's OTLP response-body limit, including chunked responses.
      void request.on('downloadProgress', ({ transferred }) => { if (transferred > 4 * 1024 * 1024) request.cancel() })
      const response = await request
      if (response.statusCode >= 300) throw new Error(`OTLP collector returned HTTP ${response.statusCode}`)
      return { status: 'success', data: response.body }
    },
    shutdown() { /* The exporter awaits agent cleanup below. */ },
  }))
  let shutdown: Promise<void> | undefined
  return {
    export: (records, callback) => { exporter.export(records, callback) },
    forceFlush: () => exporter.forceFlush(),
    shutdown() {
      shutdown ??= (async () => {
        try { await exporter.shutdown() }
        finally { (await agent)?.destroy() }
      })()
      return shutdown
    },
  }
}
