import type { StreamChunk } from '@deepseek-ai/dsh-llm/types'
import type {
  AssistantBlock, PartialAssistant,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { emptyAssistantBlock, toAssistantBlock } from './event-projection.ts'

/**
 * Whether a stream chunk changes the partial assistant projection shown by the UI.
 * @param type - Stream chunk discriminant.
 * @returns Whether publishing the accumulated partial can change the visible snapshot.
 */
export function isVisibleAssistantChunk(type: string): boolean {
  return type === 'block-start'
    || type === 'text-delta'
    || type === 'reasoning-delta'
    || type === 'tool-call-delta'
    || type === 'block-end'
}

/** Live Assistant-frame accumulator: folds StreamChunks into AssistantBlock[] with block-level immutability. */
export class PartialAccumulator {
  // Sparse on purpose: block-start may arrive out of order, leaving holes until compaction.
  private blocks: (AssistantBlock | undefined)[] = []
  private changed = true
  private snapshot: PartialAssistant

  /**
   * @param turn - Owning agent turn.
   * @param step - Owning model step.
   * @param initialBlocks - Materialized prefix when accumulation begins after history replay.
   */
  constructor(
    readonly turn: number,
    readonly step: number,
    initialBlocks: readonly AssistantBlock[] = [],
  ) {
    this.blocks = [...initialBlocks]
    this.snapshot = { turn, step, blocks: initialBlocks }
  }

  /**
   * Fold one chunk.
   * @param chunk - the stream chunk.
   * @returns whether it caused a visible change (usage/finish return false, skipping notification).
   */
  push(chunk: StreamChunk): boolean {
    switch (chunk.type) {
      case 'block-start': {
        this.blocks[chunk.index] = emptyAssistantBlock(chunk.blockType)
        this.changed = true
        return true
      }
      case 'text-delta': {
        const prev = this.blocks[chunk.index]
        this.blocks[chunk.index] = { kind: 'text', text: (prev?.kind === 'text' ? prev.text : '') + chunk.text }
        this.changed = true
        return true
      }
      case 'reasoning-delta': {
        const prev = this.blocks[chunk.index]
        this.blocks[chunk.index] = { kind: 'reasoning', text: (prev?.kind === 'reasoning' ? prev.text : '') + chunk.text }
        this.changed = true
        return true
      }
      case 'tool-call-delta': {
        const prev = this.blocks[chunk.index]
        const base = prev?.kind === 'tool-call' ? prev : { kind: 'tool-call' as const, callId: '', name: '', argsRaw: '' }
        this.blocks[chunk.index] = {
          kind: 'tool-call',
          callId: base.callId || String(chunk.id),
          name: chunk.name ?? base.name,
          argsRaw: base.argsRaw + chunk.argumentsDelta,
        }
        this.changed = true
        return true
      }
      case 'block-end': {
        this.blocks[chunk.index] = toAssistantBlock(chunk.block)
        this.changed = true
        return true
      }
      default:
        // usage / finish / merge-extensible unknown variants: no visible block change
        // (finish is immediately followed by the assistant/message that supersedes the partial).
        return false
    }
  }

  /**
   * Current partial projection.
   * @returns the cached snapshot (the blocks array reference only changes after a mutation).
   */
  toPartial(): PartialAssistant {
    if (this.changed) {
      // Compact sparse indexes (out-of-order block-start) into render order.
      this.snapshot = { turn: this.turn, step: this.step, blocks: this.blocks.filter((b): b is AssistantBlock => b !== undefined) }
      this.changed = false
    }
    return this.snapshot
  }
}
