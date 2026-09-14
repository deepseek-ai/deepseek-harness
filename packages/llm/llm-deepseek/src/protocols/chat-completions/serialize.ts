/**
 * Serialize harness messages into DeepSeek chat completions. Text-only
 * requests retain string user content; the image path resolves durable
 * attachments into ordered file-id or inline parts. Tool-result images follow their
 * string-only tool messages in a separate user message.
 * @module dsh-llm-deepseek/serialize
 */

import { contentHasImage, IMAGE_OFFLOAD_REQUIRED_CODE, LlmError, offloadedImageText, projectOffloadedImages, requestImageHandleText, requiredImageOffload } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, ImageAttachmentAccessResolver, Message } from '@deepseek-ai/dsh-llm'
import type { ImageAttachmentRef, RequestImageAttachment } from '@deepseek-ai/dsh-attachment'
import type {
  WireImageContentPart,
  WireMessage,
  WireRequest,
  WireTextContentPart,
  WireTool,
  WireUserContentPart,
} from './types.ts'

import type { RequestDefaults } from '../../common/types.ts'

interface ResolvedThinking {
  thinking?: 'enabled' | 'disabled'
  reasoningEffort?: 'low' | 'high' | 'max'
}

/** Provider representation for every retained image in one request. */
export type ImageRequestRepresentation =
  | {
    kind: 'file'
    /** Resolve a retained request version to a reusable DeepSeek file id. */
    resolveFileId: (
      version: RequestImageAttachment,
      block: Extract<ContentBlock, { type: 'image' }>,
      location: ImageWireLocation,
    ) => Promise<string>
  }
  | { kind: 'base64' }

/** Dependencies required only when the request contains image input. */
export interface ImageSerializationOptions {
  /** One representation used for every retained image in this request. */
  representation: ImageRequestRepresentation
  /** Request versions prepared for the conservatively retained normalized attachments, keyed by attachment id. */
  requestImages: ReadonlyMap<ImageAttachmentRef['attachmentId'], RequestImageAttachment>
  /** Resolve current tool access independently from deterministic request-image versions. */
  resolveImageAccess?: ImageAttachmentAccessResolver
  /** Positive bound on accumulated represented image bytes. */
  maxRequestImageBytes: number
  /** Maximum represented images in one request. */
  maxImagesPerRequest?: number
  /** Represented-byte removal step applied after the request exceeds its byte bound. */
  byteQuantum?: number
  /** Image-count removal step applied after the request exceeds its count bound. */
  countQuantum?: number
}

export type { ImageWireLocation } from '../../common/request-files.ts'
import type { ImageWireLocation } from '../../common/request-files.ts'

const TOOL_RESULT_IMAGE_TEXT = 'Attached image(s) from tool result:'

/** Validate the adapter-owned effort before resolving its DeepSeek wire fields. */
function reasoningEffort(effort: NonNullable<GenerateOptions['reasoningEffort']>): 'off' | 'low' | 'high' | 'max' {
  if (effort === 'off' || effort === 'low' || effort === 'high' || effort === 'max') {
    return effort as 'off' | 'low' | 'high' | 'max'
  }
  throw new LlmError(
    `DeepSeek does not support reasoning effort "${effort}"`,
    'UNSUPPORTED_REASONING_EFFORT',
  )
}

/** Resolve one legal thinking/effort pair without exposing `off` as a wire effort. */
function resolveThinking(options: GenerateOptions, defaults: RequestDefaults): ResolvedThinking {
  if (options.purpose === 'session-title') return { thinking: 'disabled' }
  const effort = options.reasoningEffort === undefined
    ? defaults.reasoningEffort
    : reasoningEffort(options.reasoningEffort)
  if (defaults.thinking === 'disabled' && effort !== undefined && effort !== 'off') {
    throw new LlmError(
      `DeepSeek deployment does not support reasoning effort "${effort}"`,
      'UNSUPPORTED_REASONING_EFFORT',
    )
  }
  if (effort === 'off') return { thinking: 'disabled' }
  if (effort === 'low' || effort === 'high' || effort === 'max') {
    return { thinking: 'enabled', reasoningEffort: effort }
  }
  return defaults.thinking === undefined ? {} : { thinking: defaults.thinking }
}

/** Join the text blocks of a message (used for user/tool-result content). */
function flattenText(blocks: ContentBlock[]): string {
  return blocks
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
}

/** Reject core image content before any text-flattening path can silently erase it. */
function assertTextOnly(blocks: readonly ContentBlock[]): void {
  if (contentHasImage(blocks)) {
    throw new LlmError('The DeepSeek chat-completions adapter does not support image content.', 'UNSUPPORTED_CONTENT')
  }
}

/** Reject roles whose DeepSeek history format cannot carry image input. */
function assertSupportedImageRoles(messages: readonly Message[]): void {
  for (const message of messages) {
    if (message.role !== 'user' && contentHasImage(message.content)) {
      throw new LlmError(
        `The DeepSeek chat-completions adapter cannot represent image content in a ${message.role} message.`,
        'UNSUPPORTED_CONTENT',
      )
    }
  }
}

/** Describe the exact request preview and its model-callable coordinate system. */
function imageHandle(
  ref: ImageAttachmentRef,
  version: RequestImageAttachment,
  resolveAccess: ImageAttachmentAccessResolver | undefined,
  precededByContent: boolean,
): WireTextContentPart {
  return {
    type: 'text',
    text: `${precededByContent ? '\n' : ''}${requestImageHandleText(ref, version, resolveAccess?.(ref))}`,
  }
}

/** Resolve one durable image into its descriptor and transient DeepSeek image part. */
async function imageParts(
  block: Extract<ContentBlock, { type: 'image' }>,
  images: ImageSerializationOptions,
  location: ImageWireLocation,
  precededByContent: boolean,
): Promise<[WireTextContentPart, WireImageContentPart]> {
  const version = images.requestImages.get(block.attachment.attachmentId)
  if (version === undefined) {
    throw new LlmError(
      `DeepSeek request image ${block.attachment.attachmentId} was not prepared.`,
      'INVALID_REQUEST',
    )
  }
  const image: WireImageContentPart = images.representation.kind === 'file'
    ? { type: 'file', file_id: await images.representation.resolveFileId(version, block, location) }
    : {
      type: 'image_url',
      image_url: { url: `data:${version.mediaType};base64,${Buffer.from(version.data).toString('base64')}` },
    }
  return [imageHandle(block.attachment, version, images.resolveImageAccess, precededByContent), image]
}

/** Convert user or nested tool-result blocks into ordered wire parts. */
async function contentParts(
  blocks: readonly ContentBlock[],
  images: ImageSerializationOptions,
  message: number,
  nextImage: { value: number },
): Promise<WireUserContentPart[]> {
  const parts: WireUserContentPart[] = []
  for (const block of blocks) {
    switch (block.type) {
      case 'text':
        if (block.text.length > 0) parts.push({ type: 'text', text: block.text })
        break
      case 'image':
        nextImage.value += 1
        parts.push(...await imageParts(block, images, { message, image: nextImage.value }, parts.length > 0))
        break
      case 'tool-result':
        parts.push(...await contentParts(block.content, images, message, nextImage))
        break
      default:
        // Other merge-extensible blocks are not DeepSeek user-input vocabulary.
        break
    }
  }
  return parts
}

/** Keep text-only user messages on the compact string wire form. */
function userContent(parts: readonly WireUserContentPart[]): string | WireUserContentPart[] {
  const text: string[] = []
  for (const part of parts) {
    if (part.type !== 'text') return [...parts]
    text.push(part.text)
  }
  return text.join('')
}

/** Serialize one assistant message (text + reasoning + tool calls). */
function serializeAssistant(message: Message): WireMessage {
  const text = flattenText(message.content)
  const reasoning = message.content
    .filter(block => block.type === 'reasoning')
    .map(block => block.text)
    .join('')
  const toolCalls = message.content
    .filter(block => block.type === 'tool-call')
    .map(block => ({
      id: block.id,
      type: 'function' as const,
      function: { name: block.name, arguments: block.arguments },
    }))

  return {
    role: 'assistant',
    // Text-less turns send "" — NEVER null. Pure tool-call turns: the
    // official samples replay message.content verbatim (which is "") and
    // some gateways reject null outright. Reasoning-ONLY turns (the model
    // can answer entirely in the reasoning channel, e.g. a v4-flash
    // greeting): the live API rejects null-content/no-tool_calls assistant
    // messages with a 400 ("content or tool_calls must be set"), and since
    // the message sits durably in the session log, a null here bricks every
    // later turn of that session.
    content: text,
    // CoT passback on every reasoning-carrying turn. The official rule
    // (guides/thinking_mode.mdx) requires it on tool-call turns and ignores it
    // elsewhere; a gateway re-encoding the conversation for another vendor
    // recovers that turn's upstream thinking signature by hashing this exact
    // text, which a tool-call-free turn carries nowhere else.
    ...reasoning.length > 0 ? { reasoning_content: reasoning } : {},
    ...toolCalls.length > 0 ? { tool_calls: toolCalls } : {},
  }
}

/**
 * Serialize the conversation. `tool-result` blocks become standalone
 * `{role: 'tool'}` messages; the harness puts each tool result in its own
 * user-role message, so a mixed user message contributes its text first and
 * its tool results as separate wire messages after.
 * @param messages - the harness conversation, in order.
 * @returns the wire messages; order preserved, each tool result expanded into its own entry.
 */
export function serializeMessages(messages: Message[]): WireMessage[] {
  const wire: WireMessage[] = []
  for (const message of messages) {
    assertTextOnly(message.content)
    if (message.role === 'system') {
      wire.push({ role: 'system', content: flattenText(message.content) })
      continue
    }
    if (message.role === 'assistant') {
      wire.push(serializeAssistant(message))
      continue
    }
    // user role: tool results ride in user messages in the harness
    // vocabulary, but DeepSeek wants them as role:'tool' messages.
    const toolResults = message.content.filter(block => block.type === 'tool-result')
    const text = flattenText(message.content)
    if (text.length > 0 || toolResults.length === 0) {
      wire.push({ role: 'user', content: text })
    }
    for (const result of toolResults) {
      wire.push({
        role: 'tool',
        tool_call_id: result.toolCallId,
        // Empty tool output still needs SOME content on the wire.
        content: flattenText(result.content) || '(no output)',
      })
    }
  }
  return wire
}

/**
 * Serialize image-capable history after resolving durable attachments.
 * Consecutive tool results keep string `tool` messages and share one following
 * user message containing their images.
 * @param messages - request history whose offloaded occurrences are already placeholder text.
 * @param images - prepared request versions, one provider representation, and its budget.
 * @returns ordered DeepSeek wire messages.
 */
export async function serializeMessagesWithImages(
  messages: readonly Message[],
  images: ImageSerializationOptions,
): Promise<WireMessage[]> {
  assertSupportedImageRoles(messages)
  const wire: WireMessage[] = []
  let pendingToolImages: WireImageContentPart[] = []
  const flushToolImages = (): void => {
    if (pendingToolImages.length === 0) return
    wire.push({
      role: 'user',
      content: [{ type: 'text', text: TOOL_RESULT_IMAGE_TEXT }, ...pendingToolImages],
    })
    pendingToolImages = []
  }

  for (const [messageIndex, message] of messages.entries()) {
    const nextImage = { value: 0 }
    if (message.role === 'system') {
      flushToolImages()
      wire.push({ role: 'system', content: flattenText(message.content) })
      continue
    }
    if (message.role === 'assistant') {
      flushToolImages()
      wire.push(serializeAssistant(message))
      continue
    }

    const regular = message.content.filter(block => block.type !== 'tool-result')
    const toolResults = message.content.filter((block): block is Extract<ContentBlock, { type: 'tool-result' }> => (
      block.type === 'tool-result'
    ))
    const content = userContent(await contentParts(regular, images, messageIndex + 1, nextImage))
    if (content.length > 0 || toolResults.length === 0) {
      flushToolImages()
      wire.push({
        role: 'user',
        content,
      })
    }
    for (const result of toolResults) {
      const parts = await contentParts(result.content, images, messageIndex + 1, nextImage)
      const imageParts = parts.filter((part): part is WireImageContentPart => part.type !== 'text')
      const text = parts.filter(part => part.type === 'text').map(part => part.text).join('')
      wire.push({
        role: 'tool',
        tool_call_id: result.toolCallId,
        content: text || '(no output)',
      })
      pendingToolImages.push(...imageParts)
    }
  }
  flushToolImages()
  return wire
}

/** Assemble request fields shared by text-only and image-capable conversion. */
function requestWithMessages(
  options: GenerateOptions,
  messages: WireMessage[],
  defaults: RequestDefaults,
): WireRequest {
  const tools: WireTool[] | undefined = options.tools?.map(tool => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }))
  const resolvedThinking = resolveThinking(options, defaults)
  return {
    model: options.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    ...resolvedThinking.thinking !== undefined ? { thinking: { type: resolvedThinking.thinking } } : {},
    ...resolvedThinking.reasoningEffort !== undefined
      ? { reasoning_effort: resolvedThinking.reasoningEffort }
      : {},
    ...tools !== undefined && tools.length > 0 ? { tools } : {},
    ...options.temperature !== undefined ? { temperature: options.temperature } : {},
    ...options.maxTokens === undefined ? {} : { max_tokens: options.maxTokens },
    ...options.stop !== undefined ? { stop: options.stop } : {},
  }
}

/**
 * Build the full wire request. Always streaming (`stream: true`, usage
 * reporting on); optional fields are omitted rather than sent as null, so
 * provider defaults apply.
 * @param options - the harness request (model, history, system, tools, sampling).
 * @param defaults - adapter-level thinking defaults; undefined fields put nothing on the wire.
 * @returns the chat-completions request body.
 */
export function serializeRequest(
  options: GenerateOptions,
  defaults: RequestDefaults = {},
): WireRequest {
  const messages: WireMessage[] = []
  if (options.system !== undefined) {
    messages.push({ role: 'system', content: options.system })
  }
  messages.push(...serializeMessages(options.messages))

  return requestWithMessages(options, messages, defaults)
}

/**
 * Reject a request whose retained occurrences, at their exact request-version
 * byte lengths under this representation, still exceed the route budget. The
 * failure names how many more oldest retained occurrences need durable
 * omission before the request can be retried.
 */
function assertRetainedImagesFit(messages: readonly Message[], images: ImageSerializationOptions): void {
  const representation = images.representation.kind === 'file' ? 'raw' : 'base64'
  const offloadImages = requiredImageOffload(messages, {
    representation,
    maxBytes: images.maxRequestImageBytes,
    ...images.maxImagesPerRequest === undefined ? {} : { maxImages: images.maxImagesPerRequest },
    ...images.byteQuantum === undefined ? {} : { byteQuantum: images.byteQuantum },
    ...images.countQuantum === undefined ? {} : { countQuantum: images.countQuantum },
  }, (block) => {
    const version = images.requestImages.get(block.attachment.attachmentId)
    if (version === undefined) {
      throw new LlmError(`DeepSeek request image ${block.attachment.attachmentId} was not prepared.`, 'INVALID_REQUEST')
    }
    return version.bytes
  })
  if (offloadImages > 0) {
    throw new LlmError(
      `DeepSeek ${representation} request images exceed the route budget; ${offloadImages} more oldest occurrence(s) must be offloaded.`,
      IMAGE_OFFLOAD_REQUIRED_CODE,
      { offloadImages },
    )
  }
}

/**
 * Build one image-capable request while keeping durable bytes out of session
 * messages. Offloaded occurrences become per-image text; retained occurrences
 * must fit the route budget at their exact request-version byte lengths.
 * @param options - harness request containing image-capable user content.
 * @param images - request versions, optional current access resolver, and request bounds.
 * @param defaults - adapter-level thinking defaults.
 * @returns the fully materialized DeepSeek request body.
 */
export async function serializeRequestWithImages(
  options: GenerateOptions,
  images: ImageSerializationOptions,
  defaults: RequestDefaults = {},
): Promise<WireRequest> {
  assertSupportedImageRoles(options.messages)
  assertRetainedImagesFit(options.messages, images)
  const requestMessages = projectOffloadedImages(
    options.messages,
    ref => offloadedImageText(ref, images.resolveImageAccess?.(ref)),
  )
  const messages: WireMessage[] = []
  if (options.system !== undefined) {
    messages.push({ role: 'system', content: options.system })
  }
  messages.push(...await serializeMessagesWithImages(requestMessages, images))
  return requestWithMessages(options, messages, defaults)
}
