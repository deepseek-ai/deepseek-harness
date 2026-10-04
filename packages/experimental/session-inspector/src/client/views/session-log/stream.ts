/** Block-indexed hierarchy for one live or durable Assistant stream. */

import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import type { InspectorRow } from '../table-model.ts'
import { INSPECTOR_PREVIEW_LIMIT } from '../format.ts'

interface StreamEntry {
  row: InspectorRow
  offset: number
  children: number
  reasoningText?: string
}

/** Keeps original delta rows under their blocks and a bounded reasoning prefix for folded headers. */
export class AssistantLogStream {
  private readonly blocks = new Map<number, StreamEntry>()
  private count = 0

  /** @param parent - Stable Assistant event or live-attempt row identity. */
  constructor(private readonly parent: string) {}

  /**
   * Count all received chunks, including children of folded blocks.
   * @returns Number of original chunks received by this stream.
   */
  get length(): number { return this.count }

  /**
   * Add one original chunk and update the matching block's disclosure state.
   * Chunks without a loaded block-start remain direct Assistant children.
   * @param chunk - Original chunk, correlated by block index.
   * @returns One row insertion, an optional replaced block header, and its folded preview.
   */
  append(chunk: StreamChunk): {
    readonly key: string
    readonly index: number
    readonly position: number
    readonly row: InspectorRow
    readonly header?: { readonly position: number; readonly row: InspectorRow }
    readonly collapsed?: { readonly key: string; readonly summary: string }
  } {
    const index = this.count++
    const key = `${this.parent}/chunk:${index}`
    let position = index
    let row: InspectorRow = { key, parent: this.parent, depth: 1 }
    let header: { readonly position: number; readonly row: InspectorRow } | undefined
    let block: StreamEntry | undefined
    if (chunk.type === 'block-start') {
      block = {
        row: { ...row, disclosure: 'open' }, offset: index, children: 0,
        ...chunk.blockType === 'reasoning' ? { reasoningText: '' } : {},
      }
      row = block.row
      this.blocks.set(chunk.index, block)
    } else {
      block = 'index' in chunk ? this.blocks.get(chunk.index) : undefined
      if (block !== undefined) {
        position = block.offset + 1 + block.children++
        row = { key, parent: block.row.key, depth: 2 }
        for (const following of this.blocks.values()) {
          if (following.offset > block.offset) following.offset++
        }
        if (chunk.type === 'reasoning-delta' && block.reasoningText !== undefined) {
          block.reasoningText = (block.reasoningText + chunk.text).slice(0, INSPECTOR_PREVIEW_LIMIT)
        }
        if (chunk.type === 'block-end') {
          block.row = { ...block.row, disclosure: 'closed' }
          header = { position: block.offset, row: block.row }
        }
      }
    }
    return { key, index, position, row, ...header === undefined ? {} : { header },
      ...block?.reasoningText === undefined ? {} : { collapsed: {
        key: block.row.key,
        summary: `blockType: reasoning${block.reasoningText === '' ? '' : ` · ${block.reasoningText}`}`.slice(0, INSPECTOR_PREVIEW_LIMIT),
      } } }
  }
}
