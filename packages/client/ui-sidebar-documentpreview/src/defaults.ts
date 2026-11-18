/** Default preview limits, shared by the Host schema and the browser's fallback for an absent synced value. */
import type { ExcelLimits, OfficeLimits } from './types.ts'

/** Office cache limits a Config without `office` keys resolves to. */
export const OFFICE_DEFAULTS: Readonly<OfficeLimits> = Object.freeze({
  maxCachedEntries: 8,
  maxCachedBytes: 64 * 1024 * 1024,
  maxPending: 8,
  maxReaders: 32,
})

/** Spreadsheet parser limits a Config without `excel` keys resolves to. */
export const EXCEL_DEFAULTS: Readonly<ExcelLimits> = Object.freeze({
  maxBytes: 16 * 1024 * 1024,
  maxCells: 250_000,
  timeoutMs: 15_000,
})
