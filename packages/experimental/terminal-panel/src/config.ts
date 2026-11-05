/** Validated configuration for sidebar-backed Agent terminals and the user-terminal tools. */

import z from '@deepseek-ai/schemastery'

/** Public plugin configuration. */
export interface Config {
  /** Terminal registry type served by sidebar terminals. */
  backendType: string
  /** Initial terminal width; an attached sidebar view resizes it to its panel. */
  cols: number
  /** Initial terminal height; an attached sidebar view resizes it to its panel. */
  rows: number
  /** Executable names tried among the discovered shells before the execution environment's default shell. */
  preferredShells: string[]
  /** Variables added to Agent terminal environments, such as pagers that would otherwise wait for input. */
  environment: Record<string, string>
  /** Output silence that ends shell startup once the shell owns the foreground. */
  startupSilenceMs: number
  /** Bound on shell startup, including the person's startup files. */
  startupTimeoutMs: number
  /** Output silence after which a send checks whether the shell or a reading program waits for input. */
  promptSilenceMs: number
  /** Minimum interval between foreground process inspections, each of which may start `ps` twice. */
  probeIntervalMs: number
  /** Output silence that ends a send as `inferred_idle`. */
  idleSilenceMs: number
  /** Bound on one send. */
  timeoutMs: number
  /** Maximum UTF-8 bytes in one screen read, send output or startup screen. */
  maxReadBytes: number
  /** Register `user_terminal_list` and `user_terminal_read`, whose screen text enters the Session log and model requests. */
  readUserTerminals: boolean
}

/** Largest delay a Node timer honors; longer delays fire at once. */
const MAX_TIMER_MS = 2 ** 31 - 1

/** Schemastery config exposed by the plugin. */
export const Config: z<Partial<Config>, Config> = z.object({
  backendType: z.string().min(1).default('shell'),
  cols: z.number().step(1).min(2).default(160),
  rows: z.number().step(1).min(1).default(40),
  preferredShells: z.array(z.string().min(1)).default([]),
  environment: z.dict(z.string()).default({ PAGER: 'cat', GIT_PAGER: 'cat' }),
  startupSilenceMs: z.number().step(1).min(1).max(MAX_TIMER_MS).default(300),
  startupTimeoutMs: z.number().step(1).min(1).max(MAX_TIMER_MS).default(15_000),
  promptSilenceMs: z.number().step(1).min(1).max(MAX_TIMER_MS).default(300),
  probeIntervalMs: z.number().step(1).min(1).max(MAX_TIMER_MS).default(1_000),
  idleSilenceMs: z.number().step(1).min(1).max(MAX_TIMER_MS).default(3_000),
  timeoutMs: z.number().step(1).min(1).max(MAX_TIMER_MS).default(30_000),
  maxReadBytes: z.number().step(1).min(64).max(Number.MAX_SAFE_INTEGER).default(256 * 1024),
  readUserTerminals: z.boolean().default(true),
})

/**
 * Reject timing values that cannot produce the documented wait reasons.
 * @param config - Schemastery-resolved configuration.
 */
export function validateConfig(config: Config): void {
  if (config.promptSilenceMs > config.idleSilenceMs) {
    throw new Error('terminal-panel: promptSilenceMs must not exceed idleSilenceMs')
  }
  if (config.idleSilenceMs > config.timeoutMs) {
    throw new Error('terminal-panel: idleSilenceMs must not exceed timeoutMs')
  }
  if (config.startupSilenceMs > config.startupTimeoutMs) {
    throw new Error('terminal-panel: startupSilenceMs must not exceed startupTimeoutMs')
  }
}
