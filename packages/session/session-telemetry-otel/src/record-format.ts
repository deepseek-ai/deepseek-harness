/**
 * OTLP record granularity for Session-log delivery, kept outside the plugin
 * entry because a plugin entry exports only its plugin surface.
 *
 * @module @deepseek-ai/dsh-session-telemetry-otel/record-format
 */

/** OTLP record granularity selected by the recordFormat Config field. */
export type SessionLogRecordFormat = 'per-event' | 'per-batch'

/** Default granularity: one OTLP record per canonical Session event. */
export const DEFAULT_RECORD_FORMAT: SessionLogRecordFormat = 'per-event'
