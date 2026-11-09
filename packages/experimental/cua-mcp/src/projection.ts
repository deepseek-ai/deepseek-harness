/** MCP projection of one DSH tool execution: text passes through, screenshots become inline images. @module */
import type { AttachmentStore, ImageAttachmentRef, ImageRequestTarget } from '@deepseek-ai/dsh-attachment'
import type { ContentBlock, UserMessage } from '@deepseek-ai/dsh-llm'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type { CallToolResult } from '@modelcontextprotocol/server'

/** Image delivery for one projection: the request version the program observed, or the stored image. */
export interface ScreenshotDelivery {
  /** Store that owns the durable screenshots; only its two image reads are used. */
  readonly attachments: Pick<AttachmentStore, 'readImage' | 'readImageRequest'>
  /** Fixed request target of a screenshot, or undefined to deliver the stored normalized image. */
  readonly target: (image: ImageAttachmentRef) => ImageRequestTarget | undefined
}

/** One text block preceding the projected result. */
function text(value: string): CallToolResult['content'][number] {
  return { type: 'text', text: value }
}

/**
 * Project a settled `cua_run_code` or `cua_reset` outcome onto an MCP call result.
 * Result text keeps the model-facing rendering; images deferred by nested screenshot calls follow it, in
 * capture order, as inline Base64 blocks of the version the program observed, so pixel coordinates in the
 * program's text match the delivered image. Other block kinds are named, not rendered.
 * @param result - Settled DSH execution outcome.
 * @param deferred - Deferred context messages the execution produced, in order.
 * @param delivery - Attachment store and the provider's request target.
 * @param signal - Cancels pending image reads.
 * @param preface - Text blocks placed before the projected result, such as the API reference.
 * @returns The MCP result; `isError` mirrors the DSH outcome.
 */
export async function projectToolResult(
  result: ToolExecutionResult, deferred: readonly UserMessage[], delivery: ScreenshotDelivery,
  signal: AbortSignal, preface: readonly string[] = [],
): Promise<CallToolResult> {
  const content: CallToolResult['content'] = preface.map(text)
  const blocks: ContentBlock[] = [...result.content, ...deferred.flatMap(message => message.content)]
  for (const block of blocks) {
    switch (block.type) {
      case 'text':
        content.push(text(block.text))
        break
      case 'image': {
        const target = delivery.target(block.attachment)
        const image = target === undefined
          ? await delivery.attachments.readImage(block.attachment, signal)
            .then(stored => ({ data: stored.data, mediaType: stored.ref.mediaType }))
          : await delivery.attachments.readImageRequest(block.attachment, target, signal)
        content.push({ type: 'image', data: Buffer.from(image.data).toString('base64'), mimeType: image.mediaType })
        break
      }
      default:
        // Merge-extensible block kinds without an MCP rendering are named so the caller sees the omission.
        content.push(text(`[${block.type} content omitted]`))
    }
  }
  return result.isError ? { content, isError: true } : { content }
}
