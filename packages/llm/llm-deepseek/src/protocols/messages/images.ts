/** Deterministic Messages image preparation for Files references and bounded inline fallback. */

import type { AttachmentStore, ImageAttachmentRef, RequestImageAttachment } from '@deepseek-ai/dsh-attachment'
import { contentHasImage, IMAGE_OFFLOAD_REQUIRED_CODE, LlmError, offloadedImageText, projectOffloadedImages, requiredImageOffload } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, ImageAttachmentAccessResolver, Message } from '@deepseek-ai/dsh-llm'
import type { DeepSeekConnectionOptions as Connection } from '../../common/types.ts'
import { resolveRequestImageTarget } from '../../common/request-pricing.ts'
import type { DeepSeekFileId } from '../../common/file-id.ts'
import type { RequestFiles } from '../../common/request-files.ts'

export { deepSeekImageRequestPricing as imagePricing } from '../../common/request-pricing.ts'

function bounds(connection: Connection, representation: 'raw' | 'base64') {
  return {
    representation,
    maxBytes: representation === 'raw' ? connection.maxRequestFilesBytes : connection.maxInlineRequestImageBytes,
    maxImages: connection.maxImagesPerRequest,
    byteQuantum: representation === 'raw' ? connection.imageOffloadByteQuantum : connection.inlineImageOffloadByteQuantum,
    countQuantum: connection.imageOffloadCountQuantum,
  }
}

function* imageRefs(blocks: readonly ContentBlock[]): Generator<ImageAttachmentRef> {
  for (const block of blocks) {
    if (block.type === 'image') yield block.attachment
    else if (block.type === 'tool-result') yield* imageRefs(block.content)
  }
}

/** Normalize retained image references before converting Messages content.
 * @param history - durable history; never mutated.
 * @param connection - request-local image budgets.
 * @param modelId - target model id.
 * @param attachments - mounted attachment store, required only for image requests.
 * @param access - current execution-world path resolver.
 * @param signal - request cancellation.
 * @returns projected history and prepared image bytes keyed by attachment id.
 */
export async function prepareImages(
  history: readonly Message[], connection: Connection, modelId: string,
  attachments: AttachmentStore | undefined, access: ImageAttachmentAccessResolver, signal: AbortSignal,
): Promise<{ messages: readonly Message[]; versions: Map<ImageAttachmentRef['attachmentId'], RequestImageAttachment> }> {
  const versions = new Map<ImageAttachmentRef['attachmentId'], RequestImageAttachment>()
  const messages = projectOffloadedImages(history, ref => offloadedImageText(ref, access(ref)))
  if (!messages.some(message => contentHasImage(message.content))) return { messages, versions }
  const model = connection.models.find(entry => entry.id === modelId)
  if (model?.inputModalities?.includes('image') !== true || attachments === undefined) {
    throw new LlmError('DeepSeek Messages image input requires a vision model and attachment service', 'UNSUPPORTED_CONTENT')
  }
  if (messages.some(message => message.role !== 'user' && contentHasImage(message.content))) {
    throw new LlmError('DeepSeek Messages supports images only in user messages and tool results', 'UNSUPPORTED_CONTENT')
  }
  for (const message of messages) {
    for (const ref of imageRefs(message.content)) {
      if (!versions.has(ref.attachmentId)) {
        versions.set(ref.attachmentId, await attachments.readImageRequest(ref, resolveRequestImageTarget(model, ref), signal))
      }
    }
  }
  assertImagesFit(messages, versions, connection, 'raw')
  return { messages, versions }
}

/** Require logged offload before retrying images that exceed the inline budget.
 * @param messages - history already within the Files budget.
 * @param versions - normalized versions prepared for retained references.
 * @param connection - resolved inline bounds.
 * @returns unchanged history within both byte and image-count limits.
 */
export function inlineImages(
  messages: readonly Message[], versions: ReadonlyMap<ImageAttachmentRef['attachmentId'], RequestImageAttachment>,
  connection: Connection,
): readonly Message[] {
  assertImagesFit(messages, versions, connection, 'base64')
  return messages
}

/** Count additional oldest occurrences requiring durable offload at their exact represented bytes. */
function assertImagesFit(
  messages: readonly Message[], versions: ReadonlyMap<ImageAttachmentRef['attachmentId'], RequestImageAttachment>,
  connection: Connection, representation: 'raw' | 'base64',
): void {
  const offloadImages = requiredImageOffload(messages, bounds(connection, representation),
    block => (versions.get(block.attachment.attachmentId) as RequestImageAttachment).bytes)
  if (offloadImages > 0) {
    throw new LlmError(
      `DeepSeek Messages ${representation} request images exceed the route budget; ${offloadImages} more oldest occurrence(s) must be offloaded.`,
      IMAGE_OFFLOAD_REQUIRED_CODE,
      { offloadImages },
    )
  }
}

/** Resolve retained images to Files ids, recording every occurrence for failure diagnostics.
 * @param messages - history within the Files byte/count budget.
 * @param versions - normalized versions for every retained reference.
 * @param files - request-owned Files resolution and recovery.
 * @returns ids keyed by durable attachment identity.
 */
export async function prepareFileIds(
  messages: readonly Message[], versions: ReadonlyMap<ImageAttachmentRef['attachmentId'], RequestImageAttachment>, files: RequestFiles,
): Promise<Map<ImageAttachmentRef['attachmentId'], DeepSeekFileId>> {
  const ids = new Map<ImageAttachmentRef['attachmentId'], DeepSeekFileId>()
  for (const [index, message] of messages.entries()) {
    let image = 0
    for (const ref of imageRefs(message.content)) {
      const version = versions.get(ref.attachmentId) as RequestImageAttachment
      ids.set(ref.attachmentId, await files.resolve(version, { message: index + 1, image: ++image }))
    }
  }
  return ids
}
