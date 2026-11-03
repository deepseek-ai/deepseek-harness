/** Configuration shared by plugin mounting and direct executor construction. @module */
import z from '@deepseek-ai/schemastery'

/** Program execution limits. */
export interface Config {
  /** Maximum nested tool-call attempts per run_code invocation, including failed calls. */
  maxSubCalls: number
  /** Maximum overlapping concurrency-safe program subcalls. */
  maxParallelSubCalls: number
}

/** Validated per-program call count and concurrency; parallelism of one makes subcalls serial. */
export const Config: z<Partial<Config>, Config> = z.object({
  maxSubCalls: z.natural().min(1).default(128),
  maxParallelSubCalls: z.natural().min(1).default(10),
})
