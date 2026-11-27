/** Validation of renderer viewports that enter the Host over Remote. */
import { z } from 'zod'
import type { FrameForwardingViewport } from '../types.ts'

const natural = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const positive = natural.min(1)

const viewport = z.object({
  version: natural,
  width: positive.max(16384),
  height: positive.max(16384),
  deviceScaleFactor: z.number().positive().max(16),
  visible: z.boolean(),
})

/**
 * Parse a viewport received over Remote; size is bounded before native allocation.
 * @param value - Renderer-supplied value.
 * @returns Validated physical dimensions and display state.
 */
export function parseFrameForwardingViewport(value: unknown): FrameForwardingViewport {
  return viewport.parse(value)
}
