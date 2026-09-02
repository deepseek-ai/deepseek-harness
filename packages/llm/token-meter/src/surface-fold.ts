/**
 * The measurement service's positional surface fold: the per-node priced
 * surface `measure()` serves and compaction plans against. The projection
 * units do NOT share this fold — their state must stay O(1) for the
 * persisted checkpoint, so they ride `surface-projection.ts`'s shadow-price
 * protocol; the two agree because both price through `estimate.ts` and every
 * logged shadow price derives from this fold's fixed-heuristic node prices.
 *
 * The fold is a plan/commit pair: {@link planSurfaceTokens} runs every
 * fallible step read-only and {@link commitSurfaceTokens} mutates in place,
 * so a throw leaves the caller's state untouched and the same malformed
 * event fails identically on every retry.
 * Nodes also carry their durable image occurrences and image-free heuristic
 * price, so `measure()` can reprice image content for the routed model.
 *
 * @module @deepseek-ai/dsh-token-meter/surface-fold
 */

import { deriveEventMessage } from '@deepseek-ai/dsh-session'
import type { SessionSeq, SurfaceEvent } from '@deepseek-ai/dsh-session'
import type { ContentBlock, Message } from '@deepseek-ai/dsh-llm'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { estimateMessage, estimateStructuralBlock } from './estimate.ts'

/** One priced surface node with the image occurrences route pricing replaces. */
export interface MeterSurfaceNode {
  /** Durable sequence number of the surface event. */
  readonly seq: SessionSeq
  /** Fixed-heuristic price of the node's exact message. */
  readonly heuristicTokens: number
  /** Fixed-heuristic price with every image occurrence's structural price removed. */
  readonly imageFreeTokens: number
  /** Durable image occurrences in message order; empty for image-free nodes. */
  readonly images: readonly ImageAttachmentRef[]
}

/** One validated surface transition that has not mutated the priced surface yet. */
export interface SurfaceTokenPlan {
  /** Heuristic price of the event's own message; 0 when it derives none. */
  readonly tokens: number
  /** Signed change in the surface total: `tokens` minus anything shadowed. */
  readonly deltaTokens: number
  /** The priced node the commit inserts for this event. */
  readonly node: MeterSurfaceNode
  /** Commit position: `append`, or the inclusive replaced index range. */
  readonly target: 'append' | { readonly startIdx: number; readonly endIdx: number }
}

/** Collect image occurrences recursively and total their structural prices. */
function collectImages(blocks: readonly ContentBlock[], images: ImageAttachmentRef[]): number {
  let structuralTokens = 0
  for (const block of blocks) {
    if (block.type === 'image') {
      images.push(block.attachment)
      structuralTokens += estimateStructuralBlock(block)
    } else if (block.type === 'tool-result') {
      structuralTokens += collectImages(block.content, images)
    }
  }
  return structuralTokens
}

/** Build one priced node from a surface event's derived message. */
function analyzeNode(seq: SessionSeq, message: Message | null): MeterSurfaceNode {
  if (message === null) return { seq, heuristicTokens: 0, imageFreeTokens: 0, images: [] }
  const heuristicTokens = estimateMessage(message)
  const images: ImageAttachmentRef[] = []
  const imageStructuralTokens = collectImages(message.content, images)
  return {
    seq,
    heuristicTokens,
    imageFreeTokens: heuristicTokens - imageStructuralTokens,
    images,
  }
}

/**
 * Validate and price one surface event without mutating the surface.
 * @param nodes - the priced surface preceding this event, in model-visible order.
 * @param event - the surface event to place.
 * @returns the plan for {@link commitSurfaceTokens}.
 * @throws when a replacement names a range absent from `nodes` — committed
 *   logs are surface-validated at append time, so an unresolvable range is log
 *   corruption and must fail loud rather than skip the event.
 */
export function planSurfaceTokens(
  nodes: readonly MeterSurfaceNode[],
  event: SurfaceEvent,
): SurfaceTokenPlan {
  const node = analyzeNode(event.seq, deriveEventMessage(event))
  const tokens = node.heuristicTokens
  const op = event.surfaceOp
  if (op === 'append') {
    return { tokens, deltaTokens: tokens, node, target: 'append' }
  }
  const startIdx = nodes.findIndex(candidate => candidate.seq === op.start)
  const endIdx = nodes.findIndex(candidate => candidate.seq === op.end)
  if (startIdx === -1 || endIdx === -1 || startIdx > endIdx) {
    throw new Error(
      `token surface: replace at seq ${event.seq} has invalid current range ${op.start}-${op.end}`,
    )
  }
  const removed = nodes
    .slice(startIdx, endIdx + 1)
    .reduce((total, candidate) => total + candidate.heuristicTokens, 0)
  return { tokens, deltaTokens: tokens - removed, node, target: { startIdx, endIdx } }
}

/**
 * Apply one validated plan to the priced surface in place; infallible, so it
 * cannot leave a half-applied surface behind.
 * @param nodes - the exact priced surface the plan was built against.
 * @param plan - the transition returned by {@link planSurfaceTokens}.
 */
export function commitSurfaceTokens(nodes: MeterSurfaceNode[], plan: SurfaceTokenPlan): void {
  if (plan.target === 'append') {
    nodes.push(plan.node)
    return
  }
  nodes.splice(plan.target.startIdx, plan.target.endIdx - plan.target.startIdx + 1, plan.node)
}
