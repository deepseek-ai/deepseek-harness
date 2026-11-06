/** Deployment configuration for DeepSeek One-Shot recognition and its one explicit resolve step. */
import z from '@deepseek-ai/schemastery'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import type { SpeechProviderId } from '@deepseek-ai/dsh-experimental-speech-to-text/types'

/** Endpoint and service limits; requests authenticate with the DeepSeek account token released for the endpoint. */
export interface Config {
  /** Unique registration id; `speech-to-text` selects this exact id. */
  providerId: string
  /** Complete One-Shot transcription URL. */
  endpoint: string
  /** Permit plain HTTP to a loopback endpoint, for local service doubles. */
  allowLoopbackHttp: boolean
  /** Deadline for one request attempt, including its response body. */
  timeoutMs: number
  /** Maximum multipart request bytes the service accepts. */
  maxRequestBytes: number
  /** Maximum recording duration the service accepts. */
  maxDurationSeconds: number
  /** Maximum response body bytes read from the service. */
  maxResponseBytes: number
  /** Language codes the service recognizes, sent as `preferred_language`; `auto` sends none and must be listed. */
  languages: string[]
}

/** Validate deployment-varying choices at plugin activation. */
export const Config: z<Partial<Config>, Config> = z.object({
  providerId: z.string().min(1).default('deepseek-asr'),
  endpoint: z.string().min(1).default('https://harness.deepseek.com/api/v0/asr/transcribe'),
  allowLoopbackHttp: z.boolean().default(false),
  timeoutMs: z.natural().min(1).max(MAX_TIMER_DELAY_MS).default(30_000),
  maxRequestBytes: z.natural().min(1).default(3_932_160),
  maxDurationSeconds: z.number().min(1).default(120),
  maxResponseBytes: z.natural().min(1).default(64 * 1024),
  languages: z.array(z.string().pattern(/^(auto|[a-z]{2,3})$/)).default(['auto', 'zh', 'en', 'ja', 'es', 'fr', 'de', 'ru', 'pt', 'yue', 'ko']),
})

/** One validated configuration generation. */
export interface ResolvedOptions {
  readonly providerId: SpeechProviderId
  readonly endpoint: URL
  readonly timeoutMs: number
  readonly maxRequestBytes: number
  readonly maxDurationSeconds: number
  readonly maxResponseBytes: number
  readonly languages: readonly string[]
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])

/**
 * Validate the endpoint and languages before registration.
 * @param config - parsed plugin configuration.
 * @returns the facts every request uses.
 */
export function resolveOptions(config: Config): ResolvedOptions {
  const endpoint = new URL(config.endpoint)
  if (endpoint.username !== '' || endpoint.password !== '' || endpoint.search !== '' || endpoint.hash !== '') {
    throw new Error('speech-to-text-deepseek: endpoint must not contain credentials, a query or a fragment')
  }
  const loopbackHttp = endpoint.protocol === 'http:' && LOOPBACK_HOSTS.has(endpoint.hostname) && config.allowLoopbackHttp
  if (endpoint.protocol !== 'https:' && !loopbackHttp) {
    throw new Error('speech-to-text-deepseek: endpoint must use HTTPS; plain HTTP needs allowLoopbackHttp and a loopback host')
  }
  if (!config.languages.includes('auto')) throw new Error('speech-to-text-deepseek: languages must include `auto`')
  return {
    providerId: config.providerId as SpeechProviderId, endpoint, timeoutMs: config.timeoutMs,
    maxRequestBytes: config.maxRequestBytes, maxDurationSeconds: config.maxDurationSeconds, maxResponseBytes: config.maxResponseBytes,
    languages: [...new Set(config.languages)],
  }
}
