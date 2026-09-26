/** Window-local timing accepted by the Host and browser keyboard service. */
import z from '@deepseek-ai/schemastery'

/** Fixed shortcut sequence settings. */
export interface Config {
  /** Maximum interval between independent Escape presses for stopping a reply, in milliseconds. */
  stopSequenceMs: number
}

/** Validated deployment settings for fixed keyboard sequences. */
export const Config: z<Partial<Config>, Config> = z.object({
  stopSequenceMs: z.natural().min(1).max(2_147_483_646).default(500),
})
