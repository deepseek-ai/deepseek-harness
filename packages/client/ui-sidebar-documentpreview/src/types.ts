/** Document preview configuration shared by the Host and Client faces; types only. */
import type { Volatile } from '@deepseek-ai/cordis'

/** Retained PDF limits; pending conversions share cancellation by reader lifetime. */
export interface OfficeLimits {
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
export interface ExcelLimits {
  /** Maximum source file bytes. */
  maxBytes: number
  /** Maximum combined rectangular cell area across worksheets. */
  maxCells: number
  /** Maximum parser Worker lifetime in milliseconds. */
  timeoutMs: number
}

/** Preview limits; the browser receives each object through its synced Config and reads it once when the plugin activates. */
export interface DocumentPreviewConfig {
  /** Transient Office conversion reuse within one Client connection. */
  office: Volatile<OfficeLimits>
  /** Browser spreadsheet parser limits. */
  excel: Volatile<ExcelLimits>
}
