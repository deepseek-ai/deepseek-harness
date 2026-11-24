/** Deployment configuration for DeepSeek speech recognition and its one explicit resolve step. */
import z from '@deepseek-ai/schemastery'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import type { SpeechProviderId } from '@deepseek-ai/dsh-experimental-speech-to-text/types'

/** Registration id and the limits of one recognition request; `ctx.deepseekAuth` supplies the endpoint and credential. */
export interface Config {
  /** Unique registration id; `speech-to-text` selects this exact id. */
  providerId: string
  /** Deadline for the request, including its response body. */
  timeoutMs: number
  /** Largest recording, in bytes, sent to the service; the service rejects files over 8 MiB. */
  maxRequestBytes: number
  /** Longest recording, in seconds, sent to the service; the service rejects recordings over 120 seconds. */
  maxDurationSeconds: number
  /** Maximum response body bytes read from the service. */
  maxResponseBytes: number
}

/** Validate deployment-varying choices at plugin activation. */
export const Config: z<Partial<Config>, Config> = z.object({
  providerId: z.string().min(1).default('deepseek-asr'),
  timeoutMs: z.natural().min(1).max(MAX_TIMER_DELAY_MS).default(30_000),
  maxRequestBytes: z.natural().min(1).default(8 * 1024 * 1024),
  maxDurationSeconds: z.number().min(1).default(120),
  maxResponseBytes: z.natural().min(1).default(64 * 1024),
})

/** One validated configuration generation. */
export interface ResolvedOptions {
  readonly providerId: SpeechProviderId
  readonly timeoutMs: number
  readonly maxRequestBytes: number
  readonly maxDurationSeconds: number
  readonly maxResponseBytes: number
}

/**
 * Brand the provider id before registration.
 * @param config - parsed plugin configuration.
 * @returns the facts every request uses.
 */
export function resolveOptions(config: Config): ResolvedOptions {
  return {
    providerId: config.providerId as SpeechProviderId, timeoutMs: config.timeoutMs, maxRequestBytes: config.maxRequestBytes,
    maxDurationSeconds: config.maxDurationSeconds, maxResponseBytes: config.maxResponseBytes,
  }
}
