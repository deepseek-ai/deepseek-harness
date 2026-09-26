/** Cache limits shared by the Host configuration and browser document previews. */
import z from '@deepseek-ai/schemastery'

/** Transient Office conversion reuse within one Client connection. */
export interface Config {
  /** Retained PDF limits; pending conversions share cancellation by reader lifetime. */
  office: {
    /** Maximum retained completed PDFs. */
    maxCachedEntries: number
    /** Maximum retained PDF bytes, counted by each binary buffer's byteLength. */
    maxCachedBytes: number
    /** Maximum unsettled Host conversion RPCs, including cancellation teardown. */
    maxPending: number
    /** Maximum readers including source and renderer metadata lookups. */
    maxReaders: number
  }
  /** Browser spreadsheet parser and dense cell allocation limits. */
  excel: {
    /** Maximum source file bytes. */
    maxBytes: number
    /** Maximum combined rectangular cell area across worksheets. */
    maxCells: number
    /** Maximum parser Worker lifetime in milliseconds. */
    timeoutMs: number
  }
}

/** Deployment limits applied before Office preview registration. */
export const Config: z<{ office?: Partial<Config['office']>; excel?: Partial<Config['excel']> }, Config> = z.object({
  office: z.object({
    maxCachedEntries: z.natural().min(1).max(Number.MAX_SAFE_INTEGER).default(8),
    maxCachedBytes: z.natural().min(1).max(Number.MAX_SAFE_INTEGER).default(64 * 1024 * 1024),
    maxPending: z.natural().min(1).max(Number.MAX_SAFE_INTEGER).default(8),
    maxReaders: z.natural().min(1).max(Number.MAX_SAFE_INTEGER).default(32),
  }),
  excel: z.object({
    maxBytes: z.natural().min(1).max(Number.MAX_SAFE_INTEGER).default(16 * 1024 * 1024),
    maxCells: z.natural().min(1).max(Number.MAX_SAFE_INTEGER).default(250_000),
    timeoutMs: z.natural().min(1).max(2_147_483_647).default(15_000),
  }),
})
