/** Native receiver limits for the Desktop window. */
import z from '@deepseek-ai/schemastery'

/** Validated receiver limits. */
export const Config = z.object({
  maxFrames: z.natural().min(3).max(16).default(3),
  maxBytes: z.union([z.const('auto'), z.natural().min(4096)]).default('auto'),
  requestTimeoutMs: z.natural().min(1).max(2_147_483_646).default(10_000),
  maxPendingRequests: z.natural().min(1).max(65536).default(128),
  maxQueuedEvents: z.natural().min(1).max(4096).default(256),
})
/** Receiver limits passed to the Host service. */
export interface Config {
  /** Maximum surfaces per channel. Video needs one displayed surface, one in flight and one for the producer to render into. */
  maxFrames: number
  /**
   * Native surface allocation budget that every channel of the Desktop window shares, including idle pooled surfaces:
   * `auto` is half of physical memory and at least 256 MiB. The budget never exceeds physical memory; a larger byte
   * count is reduced to it with a Host warning when the first channel opens. A producer whose allocation does not fit
   * waits until other channels return surfaces.
   */
  maxBytes: 'auto' | number
  /**
   * Deadline for adapter detection, native frame delivery including each Desktop shared-texture exchange, producer
   * handshakes, and producer acknowledgements, in milliseconds. A frame's presentation through Desktop waits at most
   * 30000 of them, Desktop's limit.
   */
  requestTimeoutMs: number
  /** Maximum control requests per producer connection awaiting acknowledgement. */
  maxPendingRequests: number
  /**
   * Channel events retained for a renderer that has not read them yet. A newer state of a channel replaces its queued
   * one; beyond the limit the unread events become one snapshot of every channel's state, including unread closures of
   * channels already torn down, and unread frame errors are dropped.
   */
  maxQueuedEvents: number
}

/**
 * Resolve the window allocation budget for this machine.
 * @param maxBytes - Configured budget.
 * @param physicalMemory - Physical memory in bytes.
 * @returns The budget in bytes: `auto` is half of physical memory and at least 256 MiB, and no budget exceeds physical
 *   memory.
 */
export function windowBudget(maxBytes: Config['maxBytes'], physicalMemory: number): number {
  const requested = maxBytes === 'auto' ? Math.max(256 * 1024 * 1024, Math.floor(physicalMemory / 2)) : maxBytes
  return Math.min(requested, physicalMemory)
}
