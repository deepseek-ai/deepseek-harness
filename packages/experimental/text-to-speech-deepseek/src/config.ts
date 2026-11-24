/** Deployment configuration for DeepSeek speech synthesis and its one explicit resolve step. */
import z from '@deepseek-ai/schemastery'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import type { SynthesisProviderId } from '@deepseek-ai/dsh-text-to-speech/types'

/** Voices of the speech synthesis API: `stella` is the female default, `tide` the male voice. */
export type Voice = 'stella' | 'tide'

/** Registration id, voice, and the wait bound of one synthesis request; `ctx.deepseekAuth` supplies the endpoint and credential. */
export interface Config {
  /** Unique registration id; `text-to-speech` selects this exact id. */
  providerId: string
  /** Voice that speaks every request. */
  voice: Voice
  /** Longest wait, in milliseconds, for the next audio bytes while a consumer is asking, the first bytes included. */
  idleTimeoutMs: number
}

/** Validate deployment-varying choices at plugin activation. */
export const Config: z<Partial<Config>, Config> = z.object({
  providerId: z.string().min(1).default('deepseek-tts'),
  voice: z.union(['stella', 'tide']).default('stella'),
  idleTimeoutMs: z.natural().min(1).max(MAX_TIMER_DELAY_MS).default(30_000),
})

/** One validated configuration generation. */
export interface ResolvedOptions {
  readonly providerId: SynthesisProviderId
  readonly voice: Voice
  readonly idleTimeoutMs: number
}

/**
 * Brand the provider id before registration.
 * @param config - parsed plugin configuration.
 * @returns the facts every request uses.
 */
export function resolveOptions(config: Config): ResolvedOptions {
  return { providerId: config.providerId as SynthesisProviderId, voice: config.voice, idleTimeoutMs: config.idleTimeoutMs }
}
