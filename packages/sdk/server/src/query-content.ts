/** SDK content-block validation and extraction for native command routing. */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SdkEncodedImageBlock, SdkPromptContentBlock } from '@deepseek-ai/dsh-sdk-protocol'

/**
 * Validate fields used by input routing before creating a Session.
 * @param value - untrusted contentBlocks from a JSON-RPC query.
 * @returns ordered input blocks; ordinary prompt admission owns non-routing content.
 * @throws on an empty input or malformed text or encoded image fields.
 */
export function queryContent(value: unknown): SdkPromptContentBlock[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError('session/query requires a non-empty contentBlocks array')
  }
  const values: readonly unknown[] = value
  const blocks = values.map((value): SdkPromptContentBlock => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)
      || !('type' in value) || typeof value.type !== 'string') {
      throw new TypeError('SDK content blocks require a string type')
    }
    if (value.type === 'text') {
      if (!('text' in value) || typeof value.text !== 'string'
        || Object.keys(value).some(key => key !== 'type' && key !== 'text')) {
        throw new TypeError('SDK text blocks require only type and string text')
      }
      return { ...value, type: 'text', text: value.text }
    }
    if (value.type === 'image' && 'data' in value) {
      if (typeof value.data !== 'string' || !('mimeType' in value)
        || (value.mimeType !== 'image/png' && value.mimeType !== 'image/jpeg'
          && value.mimeType !== 'image/webp' && value.mimeType !== 'image/gif')
        || ('name' in value && typeof value.name !== 'string')
        || Object.keys(value).some(key => key !== 'type' && key !== 'data' && key !== 'mimeType' && key !== 'name')) {
        throw new TypeError('SDK encoded images require string data, a supported mimeType and an optional string name')
      }
      return {
        type: 'image', data: value.data, mimeType: value.mimeType,
        ...'name' in value ? { name: value.name as string } : {},
      }
    }
    if (value.type === 'image' && (!('attachment' in value) || typeof value.attachment !== 'object'
      || value.attachment === null || Array.isArray(value.attachment))) {
      throw new TypeError('SDK image blocks require encoded data or a durable attachment reference')
    }
    // Other merge-extensible content retains the existing prompt admission path.
    return { ...value, type: value.type } as ContentBlock
  })
  if (blocks.every(block => block.type === 'text' && block.text.trim().length === 0)) {
    throw new TypeError('session/query requires non-blank text or non-text content')
  }
  return blocks
}

/**
 * Select command images without joining text blocks or dropping other content.
 * @param blocks - validated input containing a recognized command.
 * @param text - the exact first text block used to recognize the command.
 * @returns encoded images in their original order, before any attachment writes.
 * @throws if the command shares its input with another text block or unsupported attachment representation.
 */
export function queryCommandImages(
  blocks: SdkPromptContentBlock[], text: ContentBlock & { type: 'text' },
): SdkEncodedImageBlock[] {
  const images: SdkEncodedImageBlock[] = []
  for (const block of blocks) {
    if (block === text) continue
    if (block.type !== 'image' || !('data' in block)) {
      throw new TypeError('Native SDK commands require one text block and optional encoded image blocks')
    }
    images.push(block)
  }
  return images
}
