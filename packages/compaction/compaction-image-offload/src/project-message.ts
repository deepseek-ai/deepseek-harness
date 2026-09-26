/** Immutable application of the image occurrences recorded by image/offload. */

import type { ContentBlock, Message } from '@deepseek-ai/dsh-llm'
import { deepFreeze } from '@deepseek-ai/dsh-util-values'

/**
 * Project selected image occurrences to immutable offloaded blocks.
 * @param message - message projected before this decision.
 * @param indexes - nonempty, strictly increasing depth-first image indexes.
 * @returns an immutable message with the same identity and selected images marked.
 * @throws when a selected occurrence is missing or already offloaded.
 */
export function offloadMessageImages(message: Message, indexes: readonly number[]): Message {
  let imageIndex = 0
  let selected = 0
  const visit = (blocks: readonly ContentBlock[]): ContentBlock[] => {
    let next: ContentBlock[] | undefined
    for (const [index, block] of blocks.entries()) {
      let projected = block
      if (block.type === 'image') {
        if (imageIndex === indexes[selected]) {
          if (block.offloaded === true) throw new Error(`image/offload: image index ${imageIndex} is already offloaded`)
          projected = { ...block, offloaded: true }
          selected += 1
        }
        imageIndex += 1
      }
      if (projected !== block) next ??= blocks.slice(0, index)
      next?.push(projected)
    }
    return next ?? blocks as ContentBlock[]
  }
  const content = visit(message.content)
  if (selected !== indexes.length) throw new Error(`image/offload: image index ${indexes[selected]} does not exist`)
  return deepFreeze({ ...message, content })
}
