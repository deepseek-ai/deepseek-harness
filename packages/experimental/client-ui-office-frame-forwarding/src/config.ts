/** Desktop-local preview engine limits. */
import z from '@deepseek-ai/schemastery'
import type { OfficeRenderBackend } from './types.ts'

function fraction() {
  return z.transform(z.number().min(0).max(1), (value, options) => {
    if (!Number.isFinite(value)) throw new z.ValidationError('Expected a finite fraction from 0 to 1.', options)
    return value
  })
}

/** Validated deployment settings for read-only native preview. */
export const Config = z.object({
  overscanViewports: fraction().default(0.5),
  reanchorHysteresis: fraction().default(0.25),
  zoomSettleMs: z.natural().max(2_147_483_646).default(120),
  creditRetryLimit: z.natural().min(1).max(Number.MAX_SAFE_INTEGER).default(3),
  maxPagePreviewBytes: z.natural().min(1024 * 1024).max(512 * 1024 * 1024).default(32 * 1024 * 1024),
  renderBackend: z.union(['ganesh', 'graphite'] as const).default('ganesh'),
  presentationFrameRate: z.natural().min(1).max(240).default(60),
  maxDocumentBytes: z
    .natural()
    .min(1)
    .max(256 * 1024 * 1024)
    .default(64 * 1024 * 1024),
  orphanRetentionMs: z.natural().min(1).max(2_147_483_647).default(60_000),
  operationTimeoutMs: z.natural().min(1000).max(300000).default(30000),
  channelConnectTimeoutMs: z.natural().min(1).max(299999).default(10_000),
  frameTimeoutMs: z.natural().min(1).max(2_147_483_646).default(10_000),
  automaticReconnects: z.natural().max(16).default(1),
  automaticReconnectWindowMs: z.natural().min(1000).max(86_400_000).default(600_000),
})
/** Resolved settings passed to the Host service. */
export interface Config {
  /** Render-window margin on each side, as a fraction of the visible viewport, from 0 to 1. */
  overscanViewports: number
  /** Fraction of the overscan margin reserved before reanchoring, from 0 to 1. */
  reanchorHysteresis: number
  /** Milliseconds without a zoom change before requesting a new render window; 0 redraws immediately. */
  zoomSettleMs: number
  /** Consecutive texture-credit timeouts before requesting a visibility reset to reclaim idle surfaces. */
  creditRetryLimit: number
  /** Maximum RGBA bytes in one page preview and total bytes retained in the document's page-preview cache. */
  maxPagePreviewBytes: number
  /**
   * Native GPU rendering backend: `ganesh` selects Skia Ganesh and `graphite` selects Skia Graphite through WebGPU.
   * Opening fails when the selected GPU backend is unavailable; the view uses its format-specific fallback.
   */
  renderBackend: OfficeRenderBackend
  /** Native slideshow scheduling target in frames per second; delivery may be slower. */
  presentationFrameRate: number
  /** Maximum source document size in bytes. */
  maxDocumentBytes: number
  /** Milliseconds an open document can wait for its first or next renderer lease. */
  orphanRetentionMs: number
  /** Deadline for the initial open and for each native operation after an editor has started. */
  operationTimeoutMs: number
  /**
   * Deadline for an engine to connect to its frame-forwarding channel; shorter than `operationTimeoutMs`, whose expiry
   * ends the engine.
   */
  channelConnectTimeoutMs: number
  /** Renderer deadline for a requested frame and for the first slideshow frame of each viewport, in milliseconds. */
  frameTimeoutMs: number
  /**
   * Channels a document may replace without the user asking within `automaticReconnectWindowMs`, after Desktop lost
   * its frames; 0 leaves every replacement to the user. A frame of the new channel can crash Chromium's GPU process
   * again, and Chromium stops compositing on the GPU after 3 recent crashes, forgiving one every 5 minutes; one
   * replacement per 10 minutes keeps the crashes such replacements cause below that limit.
   */
  automaticReconnects: number
  /** Sliding window of `automaticReconnects`, in milliseconds. */
  automaticReconnectWindowMs: number
}
