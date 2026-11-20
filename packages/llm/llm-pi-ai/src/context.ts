/**
 * Harness request-history conversion into pi-ai's Context vocabulary.
 *
 * @module dsh-llm-pi-ai/context
 */

import { brandString } from '@deepseek-ai/dsh-brand'
import { extractTextContent, requestImageBudgetFailure, uniqueRequestImageRefs } from '@deepseek-ai/dsh-llm/message'
import { contentHasImage, LlmError, offloadedImageText, projectOffloadedImages, requestImageHandleText } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, ImageAttachmentAccessResolver, Message, RequestMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { AttachmentId } from '@deepseek-ai/dsh-attachment/types'
import type {
  AttachmentStore,
  ImageAttachmentRef,
  ImageRequestTarget,
  RequestImageAttachment,
} from '@deepseek-ai/dsh-attachment'
import type { Context as PiContext, ImageContent, Message as PiMessage, SystemMessage, TextContent, Tool as PiTool } from '@earendil-works/pi-ai'
import { toPiAssistant } from './replay.ts'
import type { PrefixDigests } from './prefix-binding.ts'
import { requestImageDimensions } from '@deepseek-ai/dsh-attachment'
import { DEFAULT_REQUEST_IMAGE_MAX_BYTES, DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET } from './config.ts'

function textBlocks(content: readonly ContentBlock[]): TextContent[] {
  return content.filter((block): block is TextContent => block.type === 'text' && block.text.length > 0)
}

/** Pre-join system text with blank lines because pi-ai joins separate blocks with single newlines. */
function systemText(content: readonly ContentBlock[]): string {
  return extractTextContent(content, { separator: '\n\n', trim: true })
}

/** Recover the pi-ai toolResult message for one harness tool-role message. */
function toolResultOf(
  message: Extract<Message, { role: 'tool' }>,
  toolNames: Map<ToolCallId, string>,
  content: (TextContent | ImageContent)[],
): PiMessage {
  return {
    role: 'toolResult',
    toolCallId: message.toolCallId,
    toolName: toolNames.get(message.toolCallId) ?? 'unknown',
    content: content.length > 0 ? content : [{ type: 'text', text: '(no output)' }],
    isError: message.isError ?? false,
    timestamp: 0,
  }
}

/** Reject misplaced tool-change blocks and unsupported image roles before replay or image offloading. */
function assertSupportedHistory(messages: readonly RequestMessage[]): void {
  for (const message of messages) {
    if (message.role !== 'developer' && message.content.some(block => block.type === 'tool-addition' || block.type === 'tool-removal')) {
      throw new LlmError('Tool-change blocks require developer role', 'UNSUPPORTED_CONTENT')
    }
    if (message.role !== 'user' && message.role !== 'tool' && contentHasImage(message.content)) {
      throw new LlmError(
        `pi-ai cannot represent an image in an in-history ${message.role} message`,
        'UNSUPPORTED_CONTENT',
      )
    }
    if (message.role === 'system' && message.content.some(block => block.type !== 'text')) {
      throw new LlmError('pi-ai cannot represent non-text system messages', 'UNSUPPORTED_CONTENT')
    }
  }
}

function userContent(
  blocks: readonly ContentBlock[],
  requestImages: ReadonlyMap<AttachmentId, RequestImageAttachment>,
  resolveImageAccess: ImageAttachmentAccessResolver,
): (TextContent | ImageContent)[] {
  const content: (TextContent | ImageContent)[] = []
  for (const block of blocks) {
    switch (block.type) {
      case 'text':
        if (block.text.length > 0) content.push({ type: 'text', text: block.text })
        break
      case 'image': {
        const version = requestImages.get(block.attachment.attachmentId) as RequestImageAttachment
        content.push({
          type: 'text',
          text: requestImageHandleText(block.attachment, version, resolveImageAccess(block.attachment)),
        })
        content.push({
          type: 'image',
          data: Buffer.from(version.data).toString('base64'),
          mimeType: version.mediaType,
        })
        break
      }
      default:
        // Other merge-extensible blocks are not user-input vocabulary for pi-ai.
        break
    }
  }
  return content
}

/** Convert a projected declaration without its harness-owned activation marker. */
function piTool(tool: NonNullable<GenerateOptions['tools']>[number]): PiTool {
  return { name: tool.name, description: tool.description, parameters: tool.parameters }
}

function toolsOf(options: GenerateOptions): PiTool[] | undefined {
  return options.tools?.filter(tool => !tool.deferLoading).map(piTool)
}

/** The request split into pi-ai's initial `systemPrompt` slot and the history that converts to `messages`. */
interface SystemPromptSplit {
  /** Text for pi-ai's `systemPrompt`; `undefined` sends no system prompt. */
  systemPrompt: string | undefined
  /** History messages that convert to pi-ai `messages`. */
  messages: readonly RequestMessage[]
}

/** Combine request-level text and leading system history into the initial prompt. */
function splitSystemPrompt(options: GenerateOptions): SystemPromptSplit {
  const text = [options.system]
  let end = 0
  for (const message of options.messages) {
    if (message.role !== 'system') break
    text.push(systemText(message.content))
    end++
  }
  const systemPrompt = text.filter(Boolean).join('\n\n')
  return { systemPrompt: systemPrompt || undefined, messages: options.messages.slice(end) }
}

/** Assemble the request-level pi-ai context envelope shared by both conversion paths. */
function piContext(systemPrompt: string | undefined, options: GenerateOptions, messages: PiMessage[]): PiContext {
  const tools = toolsOf(options)
  return {
    ...systemPrompt !== undefined ? { systemPrompt } : {},
    messages,
    ...tools !== undefined && tools.length > 0 ? { tools } : {},
  }
}

/** Keep one developer event in one system update, resolving its projected tool declarations. */
function appendDeveloper(message: Extract<Message, { role: 'developer' }>, options: GenerateOptions, messages: PiMessage[]): void {
  const content = systemText(message.content)
  const toolsAdded: PiTool[] = []
  const toolsRemoved: NonNullable<SystemMessage['toolsRemoved']> = []
  for (const block of message.content) {
    switch (block.type) {
      case 'text':
        break
      case 'tool-addition': {
        const tool = options.tools?.find(tool => tool.name === block.toolName)
        if (tool === undefined) throw new LlmError(`pi-ai tool update references undeclared tool "${block.toolName}"`, 'INVALID_REQUEST')
        toolsAdded.push(piTool(tool))
        break
      }
      case 'tool-removal':
        toolsRemoved.push({ name: block.toolName })
        break
      default:
        throw new LlmError(`pi-ai cannot represent developer content ${block.type}`, 'UNSUPPORTED_CONTENT')
    }
  }
  if (content.length === 0 && toolsAdded.length === 0 && toolsRemoved.length === 0) return
  messages.push({
    role: 'system',
    content,
    timestamp: 0,
    ...toolsAdded.length === 0 ? {} : { toolsAdded },
    ...toolsRemoved.length === 0 ? {} : { toolsRemoved },
  })
}

function appendAssistant(
  message: Extract<Message, { role: 'assistant' }>,
  messages: PiMessage[],
  toolNames: Map<ToolCallId, string>,
  onReplayDegrade?: (reason: string) => void,
  prefixDigests?: PrefixDigests,
): void {
  const assistant = toPiAssistant(message, onReplayDegrade, prefixDigests)
  for (const block of assistant.content) {
    if (block.type === 'toolCall') toolNames.set(brandString<ToolCallId>(block.id), block.name)
  }
  messages.push(assistant)
}

/** Append shared system, developer, and assistant roles; true when consumed. */
function appendSharedHistory(
  message: RequestMessage,
  options: GenerateOptions,
  messages: PiMessage[],
  toolNames: Map<ToolCallId, string>,
  supportsMidConvoSystemMessages: boolean,
  onReplayDegrade?: (reason: string) => void,
  prefixDigests?: PrefixDigests,
): boolean {
  if (message.role === 'developer') {
    appendDeveloper(message, options, messages)
    return true
  }
  if (message.role === 'system') {
    const content = systemText(message.content)
    if (content.length > 0) {
      if (supportsMidConvoSystemMessages) {
        messages.push({ role: 'system', content, timestamp: 0 })
      } else {
        const reminder = content.replaceAll('</system-reminder>', '<\\/system-reminder>')
        messages.push({ role: 'user', content: `<system-reminder>\n${reminder}\n</system-reminder>`, timestamp: 0 })
      }
    }
    return true
  }
  if (message.role === 'assistant') {
    appendAssistant(message, messages, toolNames, onReplayDegrade, prefixDigests)
    return true
  }
  return false
}

function textOnlyContext(
  options: GenerateOptions,
  supportsMidConvoSystemMessages: boolean,
  onReplayDegrade?: (reason: string) => void,
  prefixDigests?: PrefixDigests,
): PiContext {
  assertSupportedHistory(options.messages)
  const split = splitSystemPrompt(options)
  const toolNames = new Map<ToolCallId, string>()
  const messages: PiMessage[] = []
  for (const message of split.messages) {
    if (contentHasImage(message.content)) {
      throw new LlmError('pi-ai image conversion requires the durable attachment service', 'UNSUPPORTED_CONTENT')
    }
    if (appendSharedHistory(message, options, messages, toolNames, supportsMidConvoSystemMessages, onReplayDegrade, prefixDigests)) continue
    if (message.role === 'tool') {
      messages.push(toolResultOf(message, toolNames, textBlocks(message.content)))
      continue
    }
    messages.push({ role: 'user', content: textBlocks(message.content), timestamp: 0 })
  }
  return piContext(split.systemPrompt, options, messages)
}

/** Inputs that bind deterministic request images to one current tool execution world. */
export interface PiImageRequestContext {
  /** Durable provider that resolves request-image bytes and provider-owned host objects. */
  attachments: AttachmentStore
  /** Resolve current tool access separately from deterministic request-image versions. */
  resolveImageAccess: ImageAttachmentAccessResolver
  /** Request-level bound on the base64-encoded payload of retained images; omission leaves the bound unchecked. */
  maxRequestImageBytes?: number
  /** Request-level bound on retained image occurrences; omission leaves the count unchecked. */
  maxRequestImages?: number
  /** Oldest occurrences offloaded per count overflow; omission offloads the minimum. */
  imageOffloadCountQuantum?: number
  /** Route pixel and raw encoded-byte budgets. */
  requestImagePolicy?: PiImageRequestBudget
}

/** Per-route budgets from which each request image's target is derived. */
export interface PiImageRequestBudget {
  /** Total-pixel budget; larger sources are downscaled proportionally. */
  maxPixels: number
  /** Maximum width inherited from the model or explicitly overridden by the route. */
  maxWidth?: number
  /** Maximum height inherited from the model or explicitly overridden by the route. */
  maxHeight?: number
  /** Hard encoded-byte limit for one request image; pi also uses it as the preferred target. */
  maxImageBytes: number
}

/**
 * Resolve the request target for one source under the route budgets.
 * @param ref - normalized source image.
 * @param budget - resolved route pixel and byte limits.
 * @returns dimensions and byte target shared by serialization and screenshot coordinate mapping.
 */
export function requestImageTarget(ref: ImageAttachmentRef, budget: PiImageRequestBudget): ImageRequestTarget {
  return {
    ...requestImageDimensions(ref.width, ref.height, budget.maxPixels, budget.maxWidth, budget.maxHeight),
    maxImageBytes: budget.maxImageBytes,
    imageTargetBytes: budget.maxImageBytes,
  }
}

/**
 * Convert text-only harness history to a synchronous pi-ai Context. Tool
 * result names are recovered from preceding assistant tool calls.
 * @param options - projected request; one-shot system text precedes the leading history prompt.
 * @param images - absent; selects the synchronous conversion.
 * @param onReplayDegrade - forwarded to {@link toPiAssistant} for each assistant message.
 * @param supportsMidConvoSystemMessages - native model capability; otherwise later system text becomes a user-role system-reminder.
 * @param prefixDigests - receives the recorded request-prefix digest of each replayed assistant message that has one.
 * @returns the pi-ai context; `tools` is omitted when the request declares none.
 * @throws {LlmError} `UNSUPPORTED_CONTENT` for images in any history role, including a leading system message.
 */
export function toPiContext(
  options: GenerateOptions,
  images?: undefined,
  onReplayDegrade?: (reason: string) => void,
  supportsMidConvoSystemMessages?: boolean,
  prefixDigests?: PrefixDigests,
): PiContext
/**
 * Convert harness history to a pi-ai Context while resolving durable images.
 * Tool result names are recovered from preceding assistant tool calls. Image
 * occurrences the surface marks offloaded become text placeholders; when the
 * retained occurrences still exceed `maxRequestImages` or their exact base64
 * payload exceeds `maxRequestImageBytes`, the call fails with
 * `IMAGE_OFFLOAD_REQUIRED` naming how many more oldest occurrences must be
 * offloaded, rounded up to `imageOffloadCountQuantum` for a count overflow.
 * @param options - projected request; one-shot system text precedes the leading history prompt.
 * @param images - attachment provider, current path resolver, and request limits.
 * @param onReplayDegrade - forwarded to {@link toPiAssistant} for each assistant message.
 * @param supportsMidConvoSystemMessages - native model capability; otherwise later system text becomes a user-role system-reminder.
 * @param prefixDigests - receives the recorded request-prefix digest of each replayed assistant message that has one.
 * @returns the asynchronously resolved pi-ai context.
 */
export function toPiContext(
  options: GenerateOptions,
  images: PiImageRequestContext,
  onReplayDegrade?: (reason: string) => void,
  supportsMidConvoSystemMessages?: boolean,
  prefixDigests?: PrefixDigests,
): Promise<PiContext>
export function toPiContext(
  options: GenerateOptions,
  images?: PiImageRequestContext,
  onReplayDegrade?: (reason: string) => void,
  supportsMidConvoSystemMessages = false,
  prefixDigests?: PrefixDigests,
): PiContext | Promise<PiContext> {
  return images === undefined
    ? textOnlyContext(options, supportsMidConvoSystemMessages, onReplayDegrade, prefixDigests)
    : toPiContextWithImages(options, images, supportsMidConvoSystemMessages, onReplayDegrade, prefixDigests)
}

async function toPiContextWithImages(
  options: GenerateOptions,
  images: PiImageRequestContext,
  supportsMidConvoSystemMessages: boolean,
  onReplayDegrade?: (reason: string) => void,
  prefixDigests?: PrefixDigests,
): Promise<PiContext> {
  const { attachments, resolveImageAccess, maxRequestImageBytes, maxRequestImages, imageOffloadCountQuantum } = images
  const requestImagePolicy = images.requestImagePolicy ?? {
    maxPixels: DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET,
    maxImageBytes: DEFAULT_REQUEST_IMAGE_MAX_BYTES,
  }
  assertSupportedHistory(options.messages)
  const split = splitSystemPrompt(options)
  const refs = uniqueRequestImageRefs(split.messages)
  const requestImages = new Map(await Promise.all(refs.map(async (ref) => {
    const version = await attachments.readImageRequest(ref, requestImageTarget(ref, requestImagePolicy), options.signal)
    return [ref.attachmentId, version] as const
  })))
  const failure = requestImageBudgetFailure(split.messages, requestImages, {
    representation: 'base64',
    ...maxRequestImageBytes === undefined ? {} : { maxBytes: maxRequestImageBytes },
    ...maxRequestImages === undefined ? {} : { maxImages: maxRequestImages },
    ...imageOffloadCountQuantum === undefined ? {} : { countQuantum: imageOffloadCountQuantum },
  }, 'pi-ai request images exceed the route image budget')
  if (failure !== undefined) throw LlmError.fromFailure(failure)
  const exactMessages = projectOffloadedImages(
    split.messages,
    ref => offloadedImageText(ref, resolveImageAccess(ref)),
  )
  const toolNames = new Map<ToolCallId, string>()
  const messages: PiMessage[] = []

  for (const message of exactMessages) {
    if (appendSharedHistory(message, options, messages, toolNames, supportsMidConvoSystemMessages, onReplayDegrade, prefixDigests)) continue
    if (message.role === 'tool') {
      messages.push(toolResultOf(message, toolNames, userContent(message.content, requestImages, resolveImageAccess)))
      continue
    }
    const content = userContent(message.content, requestImages, resolveImageAccess)
    messages.push({ role: 'user', content, timestamp: 0 })
  }

  return piContext(split.systemPrompt, options, messages)
}
