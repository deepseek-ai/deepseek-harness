/** ACP wire-content admission and projection owned by the ACP adapter. @module */

import type { ContentBlock as AcpContentBlock } from '@agentclientprotocol/sdk'
import type { Context } from '@deepseek-ai/cordis'
import { isImageAdmissionError } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentRef, ImageMediaType, SaveImageAttachment } from '@deepseek-ai/dsh-attachment'
import type { ModelSelection } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'

/** Raster formats shared by ACP image blocks and the core attachment vocabulary. */
const IMAGE_MEDIA_TYPES: readonly ImageMediaType[] = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
]

/** Canonical RFC 4648 base64, excluding whitespace and URL-safe aliases. */
const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

/** Content-admission failure category used by the protocol handler. */
export type AcpContentFailureKind = 'invalid' | 'internal'

/** Error with a stable ACP request-failure category and no raw binary payload. */
export class AcpContentError extends Error {
  /** Whether the bridge should report invalid params or an internal failure. */
  readonly kind: AcpContentFailureKind

  /**
   * @param message - safe protocol-facing detail without inline binary data.
   * @param kind - request-failure category.
   * @param options - optional causal chain for diagnostics.
   */
  constructor(message: string, kind: AcpContentFailureKind, options?: ErrorOptions) {
    super(message, options)
    this.name = 'AcpContentError'
    this.kind = kind
  }
}

/** Narrow a wire MIME string to the durable raster vocabulary. */
function imageMediaType(value: string): ImageMediaType | undefined {
  return IMAGE_MEDIA_TYPES.includes(value as ImageMediaType) ? value as ImageMediaType : undefined
}

/** Strictly decode one ACP inline image without accepting base64 aliases. */
function decodeImage(block: Extract<AcpContentBlock, { type: 'image' }>): SaveImageAttachment {
  const mediaType = imageMediaType(block.mimeType)
  if (mediaType === undefined) {
    throw new AcpContentError('image mimeType must be image/png, image/jpeg, image/webp, or image/gif', 'invalid')
  }
  if (!CANONICAL_BASE64.test(block.data)) {
    throw new AcpContentError('image data must be canonical base64', 'invalid')
  }
  const data = Buffer.from(block.data, 'base64')
  if (data.toString('base64') !== block.data) {
    throw new AcpContentError('image data must be canonical base64', 'invalid')
  }
  return { data, mediaType }
}

/** Resolve the exact current route and require explicit image input support. */
async function assertImageRoute(ctx: Context, route: ModelSelection | undefined, signal: AbortSignal): Promise<void> {
  const provider = route?.provider
  const model = route?.model
  const llm = ctx.get('llm')
  if (provider === undefined || model === undefined || llm === undefined) {
    throw new AcpContentError('the current model route could not be resolved for image input', 'invalid')
  }
  let info: Awaited<ReturnType<typeof llm.resolveModelInfo>>
  try {
    info = await llm.resolveModelInfo(provider, model, signal)
  } catch (error: unknown) {
    throw new AcpContentError('the current model route could not be verified for image input', 'internal', { cause: error })
  }
  if (info.inputModalities === undefined || !info.inputModalities.includes('image')) {
    throw new AcpContentError(`model "${model}" does not declare image input`, 'invalid')
  }
}

/**
 * Determine whether initialization may truthfully advertise inline image prompts.
 * Unknown service, route, capability, or deployment media support is negative.
 * @param ctx - bridge context carrying optional attachment and model services.
 * @param provider - configured provider route used for newly created sessions.
 * @param model - configured exact model id used for newly created sessions.
 * @returns whether this bridge can admit images at initialization time.
 */
export async function supportsAcpImagePrompts(
  ctx: Context,
  provider: string | undefined,
  model: string | undefined,
): Promise<boolean> {
  const attachments = ctx.get('attachments')
  const llm = ctx.get('llm')
  if (attachments === undefined || llm === undefined || provider === undefined || model === undefined) return false
  if (!attachments.imageLimits.mediaTypes.some(mediaType => IMAGE_MEDIA_TYPES.includes(mediaType))) return false
  try {
    const info = await llm.resolveModelInfo(provider, model)
    return info.inputModalities?.includes('image') === true
  } catch {
    return false
  }
}

/** Render one baseline resource link into the core's current text vocabulary. */
function resourceLinkText(block: Extract<AcpContentBlock, { type: 'resource_link' }>): string {
  return `\n[resource_link name=${JSON.stringify(block.name)} uri=${JSON.stringify(block.uri)}]\n`
}

/**
 * Admit one ACP prompt into ordered durable core content.
 * Every wire block and image is validated before the ordered image batch starts
 * writing; cancellation after a successful content-addressed write may leave an
 * unreachable object but never queues a late user message.
 * @param ctx - bridge context carrying attachment and model services.
 * @param route - Agent model selection current at prompt admission.
 * @param prompt - untrusted ACP prompt blocks in wire order.
 * @param imageEnabled - capability result advertised during initialization.
 * @param signal - admission cancellation signal.
 * @returns core content with durable image references in wire order.
 */
export async function admitAcpPrompt(
  ctx: Context,
  route: ModelSelection | undefined,
  prompt: readonly AcpContentBlock[],
  imageEnabled: boolean,
  signal: AbortSignal,
): Promise<ContentBlock[]> {
  const images: SaveImageAttachment[] = []
  for (const block of prompt) {
    switch (block.type) {
      case 'text':
      case 'resource_link':
        break
      case 'image':
        if (!imageEnabled) throw new AcpContentError('inline image prompts were not advertised by this connection', 'invalid')
        images.push(decodeImage(block))
        break
      case 'audio':
        throw new AcpContentError('audio prompt content is not supported', 'invalid')
      case 'resource':
        throw new AcpContentError('embedded resource prompt content is not supported', 'invalid')
      /* v8 ignore next 2 -- ACP ContentBlock is a closed generated union. */
      default:
        throw new AcpContentError('unsupported ACP prompt content', 'invalid')
    }
  }

  let refs: readonly ImageAttachmentRef[] = []
  if (images.length > 0) {
    const attachments = ctx.get('attachments')
    if (attachments === undefined) throw new AcpContentError('no attachment store is mounted', 'invalid')
    await assertImageRoute(ctx, route, signal)
    signal.throwIfAborted()
    try {
      refs = await attachments.saveImages(images)
    } catch (error: unknown) {
      if (isImageAdmissionError(error)) {
        throw new AcpContentError(error.message, 'invalid', { cause: error })
      }
      throw new AcpContentError('unable to persist the prompt image batch', 'internal', { cause: error })
    }
    signal.throwIfAborted()
  }

  const content: ContentBlock[] = []
  let pendingText = ''
  let imageIndex = 0
  const flushText = (): void => {
    if (pendingText.length === 0) return
    content.push({ type: 'text', text: pendingText })
    pendingText = ''
  }
  for (const block of prompt) {
    switch (block.type) {
      case 'text':
        pendingText += block.text
        break
      case 'resource_link':
        pendingText += resourceLinkText(block)
        break
      case 'image': {
        flushText()
        const ref = refs[imageIndex++] as ImageAttachmentRef
        content.push({ type: 'image', attachment: ref })
        break
      }
      /* v8 ignore start -- the validation pass above rejects both tags before reconstruction. */
      case 'audio':
      case 'resource':
        break
      /* v8 ignore stop */
      /* v8 ignore next 2 -- validated by the first closed-union switch. */
      default:
        break
    }
  }
  flushText()
  if (!content.some(block => block.type === 'image' || (block.type === 'text' && block.text.trim().length > 0))) {
    throw new AcpContentError('empty prompt', 'invalid')
  }
  return content
}

/**
 * Translate one committed assistant block to ACP wire content.
 * Images are re-read and integrity-verified before inline base64 delivery;
 * unsupported core output blocks stay off the automation wire.
 * @param ctx - bridge context carrying the authoritative attachment store.
 * @param block - committed core assistant block.
 * @returns ACP text/image content, or undefined for non-output blocks.
 */
export async function assistantBlockToAcp(
  ctx: Context,
  block: ContentBlock,
): Promise<AcpContentBlock | undefined> {
  if (block.type === 'text') {
    return block.text.length === 0 ? undefined : { type: 'text', text: block.text }
  }
  if (block.type !== 'image') return undefined
  const attachments = ctx.get('attachments')
  if (attachments === undefined) {
    throw new AcpContentError('cannot deliver assistant image: no attachment store is mounted', 'internal')
  }
  let stored: Awaited<ReturnType<typeof attachments.readImage>>
  try {
    stored = await attachments.readImage(block.attachment)
  } catch (error: unknown) {
    throw new AcpContentError('cannot deliver assistant image: the attachment is unavailable or corrupt', 'internal', { cause: error })
  }
  return {
    type: 'image',
    data: Buffer.from(stored.data).toString('base64'),
    mimeType: stored.ref.mediaType,
  }
}
