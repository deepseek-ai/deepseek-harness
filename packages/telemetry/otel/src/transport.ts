/** Explicit OTLP JSON transport for feedback-authorized Session logs. */
import { createOtlpHttpExportDelegate, getSharedConfigurationFromEnvironment, httpAgentFactoryFromOptions } from '@opentelemetry/otlp-exporter-base/node-http'
import { getSharedConfigurationDefaults, mergeOtlpSharedConfigurationWithDefaults, OTLPExporterBase, type OTLPExporterNodeConfigBase } from '@opentelemetry/otlp-exporter-base'
import { JsonLogsSerializer } from '@opentelemetry/otlp-transformer'
import type { LogRecordExporter } from '@opentelemetry/sdk-logs'

/**
 * Create an SDK JSON exporter without inheriting another collector's headers or TLS identity.
 * @param options - explicit endpoint, headers, agent, and SDK transport settings.
 * @returns the exporter owned by one independent log pipeline.
 */
export function createLogExporter(options: OTLPExporterNodeConfigBase & { url: string }): LogRecordExporter {
  const shared = mergeOtlpSharedConfigurationWithDefaults(options, getSharedConfigurationFromEnvironment('LOGS'), getSharedConfigurationDefaults())
  const transport = {
    ...shared,
    url: options.url,
    headers: async () => ({
      'Content-Type': 'application/json',
      ...typeof options.headers === 'function' ? await options.headers() : options.headers,
    }),
    // An agent factory owns the returned agent, including its keepAlive setting.
    agentFactory: typeof options.httpAgentOptions === 'function' ? options.httpAgentOptions
      : httpAgentFactoryFromOptions({ keepAlive: options.keepAlive ?? true, ...options.httpAgentOptions }),
    ...(options.userAgent === undefined ? {} : { userAgent: options.userAgent }),
  }
  return new OTLPExporterBase(createOtlpHttpExportDelegate(transport, JsonLogsSerializer))
}
