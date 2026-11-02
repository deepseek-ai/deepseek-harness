/** Configuration shared by plugin mounting and direct executor construction. @module */
import z from '@deepseek-ai/schemastery'

/** Program execution limits. */
export interface Config {
  /** Maximum overlapping concurrency-safe program subcalls. */
  maxParallelSubCalls: number
}

/** Validated program subcall concurrency; one makes subcalls serial. */
export const Config: z<Partial<Config>, Config> = z.object({
  maxParallelSubCalls: z.natural().min(1).default(10),
})
