/** Configuration shared by plugin mounting and direct executor construction. @module */
import z from '@deepseek-ai/schemastery'

/** Program execution limits. */
export interface Config {
  /** Nested tool-call attempts per minute of resolved runtime timeout, including failed calls. */
  maxSubCallsPerMinute: number
  /** Maximum overlapping concurrency-safe program subcalls. */
  maxParallelSubCalls: number
}

/** Validated timeout-based call allowance and concurrency; parallelism of one makes subcalls serial. */
export const Config: z<Partial<Config>, Config> = z.object({
  maxSubCallsPerMinute: z.natural().min(1).default(1024),
  maxParallelSubCalls: z.natural().min(1).default(10),
})
