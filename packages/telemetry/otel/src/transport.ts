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
  return new OTLPExporterBase(createOtlpHttpExportDelegate(logTransportOptions(options), JsonLogsSerializer))
}

/**
 * Resolve collector-local headers and agents with shared SDK timeout and compression defaults.
 * @param options - explicit endpoint and SDK HTTP settings.
 * @returns resolved transport settings without ambient credentials.
 */
export function logTransportOptions(
  options: OTLPExporterNodeConfigBase & { url: string },
): Parameters<typeof createOtlpHttpExportDelegate>[0] {
  const shared = mergeOtlpSharedConfigurationWithDefaults(options, getSharedConfigurationFromEnvironment('LOGS'), getSharedConfigurationDefaults())
  return {
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
}
