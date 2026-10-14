import z from '@deepseek-ai/schemastery'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'

export interface CliAccountConfig {
  binDir?: string
  commandTimeoutMs: number
}

export const CliAccountConfig: z<CliAccountConfig> = z.object({
  binDir: z.string().min(1),
  commandTimeoutMs: z.number().min(1).max(MAX_TIMER_DELAY_MS).default(30_000),
})
