/** Host Loader entry declaring the browser document preview limits; previews belong to the Client. */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { EXCEL_DEFAULTS, OFFICE_DEFAULTS } from './defaults.ts'
import type { DocumentPreviewConfig, ExcelLimits, OfficeLimits } from './types.ts'

/** Preview limits synced to the browser. */
export type Config = DocumentPreviewConfig

/** Deployment limits synced to the browser, which applies them when the plugin activates. */
export const Config: z<{ office?: Partial<OfficeLimits>; excel?: Partial<ExcelLimits> }, Config> = z.object({
  office: z.object({
    maxCachedEntries: z.natural().min(1).max(Number.MAX_SAFE_INTEGER).default(OFFICE_DEFAULTS.maxCachedEntries),
    maxCachedBytes: z.natural().min(1).max(Number.MAX_SAFE_INTEGER).default(OFFICE_DEFAULTS.maxCachedBytes),
    maxPending: z.natural().min(1).max(Number.MAX_SAFE_INTEGER).default(OFFICE_DEFAULTS.maxPending),
    maxReaders: z.natural().min(1).max(Number.MAX_SAFE_INTEGER).default(OFFICE_DEFAULTS.maxReaders),
  }).default({}).volatile(),
  excel: z.object({
    maxBytes: z.natural().min(1).max(Number.MAX_SAFE_INTEGER).default(EXCEL_DEFAULTS.maxBytes),
    maxCells: z.natural().min(1).max(Number.MAX_SAFE_INTEGER).default(EXCEL_DEFAULTS.maxCells),
    timeoutMs: z.natural().min(1).max(2_147_483_647).default(EXCEL_DEFAULTS.timeoutMs),
  }).default({}).volatile(),
})

/**
 * Register the browser plugin without Host behavior; the Loader validates the entry's Config, and the browser face
 * receives its volatile fields.
 * @param _ctx - Host context; unused.
 * @param _config - validated Config; unused on the Host.
 */
export function apply(_ctx: Context, _config: Config): void {}
