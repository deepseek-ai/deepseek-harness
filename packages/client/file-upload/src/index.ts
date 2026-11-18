/** Host file-upload service: streamed intake and Session-owned staged receipts. */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-client-connection'
import type { CommandFileReceiptResolver } from '@deepseek-ai/dsh-commands'
import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import { Remote, RemoteError, remoteErrorOf, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { handleFileUploadHttp } from './http-route.ts'
import { FILE_UPLOAD_PATH } from './protocol.ts'
import type {
  EncodedFileUploadRequest, FileUploadReceiptId, FileUploadValue, ImageUploadValue, StagedAttachment,
} from './types.ts'

export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host storage and staged-receipt service for browser file and image uploads. */
    fileUploads: FileUploads
  }
}

interface StagedFileUpload {
  readonly attachment: StagedAttachment
  /** Prompt that accepted this receipt; absent until successful admission. */
  requestId?: string
}

/** Resolve or resume the ordinary Agent that owns one Session identity. */
export type AgentResolver = (sessionId: SessionId) => Promise<Agent>

/** Prompt receipt binding that restores its previous owners unless delivery commits it. */
export interface PromptFileBinding extends Disposable {
  /** Keep the receipt bindings until queue or history observation retires them. */
  commit(): void
}

class PromptFileBindingGuard implements PromptFileBinding {
  private settled = false

  constructor(private readonly rollback: () => void) {}

  commit(): void {
    this.settled = true
  }

  [Symbol.dispose](): void {
    if (this.settled) return
    this.settled = true
    this.rollback()
  }
}

/** Host service owning upload storage and receipts keyed by each receiving Agent's exact Session. */
export class FileUploads extends TypertRemoteService {
  static inject = ['agents', 'attachments', 'commands', 'connection']

  private readonly stagedFiles = new WeakMap<Session, Map<FileUploadReceiptId, StagedFileUpload>>()
  // Inside a method called through `ctx.fileUploads`, Cordis returns a new proxy
  // for every function-valued property read from `this`, so `===` against the
  // registered resolver would always be false; a plain object is returned as is.
  private readonly agentResolution: { resolver: AgentResolver | undefined } = { resolver: undefined }

  /** @param ctx - Host context carrying Agent, attachment, command, and Connection services. */
  constructor(ctx: Context) {
    super(ctx, 'fileUploads')
    // Commands accept staged files only; an image receipt is unknown to them.
    const resolve: CommandFileReceiptResolver = (agent, receiptId) => {
      const staged = this.resolve(agent, receiptId as FileUploadReceiptId)
      return staged?.type === 'file' ? staged.attachment : undefined
    }
    ctx.effect(
      () => ctx.commands.registerFileReceiptResolver(resolve),
      'file-upload: command file receipt resolver',
    )
    ctx.effect(
      () => ctx.connection.fetch.register({
        path: FILE_UPLOAD_PATH,
        methods: ['POST'],
        requestBody: 'streaming',
        fetch: request => handleFileUploadHttp(this, request),
      }),
      'file-upload: streaming route',
    )
    ctx.on('session/event', (session, event) => { this.observeSessionEvent(session, event) })
    ctx.on('session/disposed', (session) => { this.stagedFiles.delete(session) })
  }

  /**
   * Register the ordinary-Session resolver used when a raw upload addresses a cold Session.
   * @param resolve - resolver that returns the exact live Agent or throws a Remote error.
   * @returns disposer removing this resolver.
   */
  registerAgentResolver(resolve: AgentResolver): () => void {
    if (this.agentResolution.resolver !== undefined) throw new Error('file-upload: Agent resolver is already registered')
    this.agentResolution.resolver = resolve
    return () => {
      if (this.agentResolution.resolver === resolve) this.agentResolution.resolver = undefined
    }
  }

  /**
   * Persist one encoded upload and stage it under the Agent receiver selected by Typert.
   * @param agent - receiving Agent resolved from the Remote Agent scope.
   * @param request - canonical base64 bytes and optional display name.
   * @param signal - caller cancellation before storage begins.
   * @returns the staged receipt and durable file reference.
   */
  @Remote('upload')
  async upload(agent: Agent, request: EncodedFileUploadRequest, signal: AbortSignal): Promise<FileUploadValue> {
    signal.throwIfAborted()
    const file = await this.store(agent, async () => this.ctx.attachments.admitEncodedFile({
      data: request.data,
      ...(request.name === undefined ? {} : { name: request.name }),
    }))
    return { receiptId: this.stage(agent, { type: 'file', attachment: file }), file }
  }

  /**
   * Persist raw chunks for one Session without aggregating the upload.
   * @param request - Session identity, ordered bytes, cancellation, and optional display name.
   * @returns the staged receipt and durable file reference.
   */
  async uploadStream(request: {
    readonly sessionId: SessionId
    readonly data: AsyncIterable<Uint8Array>
    readonly signal?: AbortSignal
    readonly name?: string
  }): Promise<FileUploadValue> {
    const agent = await this.resolveAgent(request.sessionId)
    const file = await this.store(agent, async () => this.ctx.attachments.saveFileStream({
      data: request.data,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
      ...(request.name === undefined ? {} : { name: request.name }),
    }))
    return { receiptId: this.stage(agent, { type: 'file', attachment: file }), file }
  }

  /**
   * Persist one prompt image for a Session: read at most the smaller of the
   * deployment's per-image and per-message byte limits, then validate,
   * normalize, and store the image the way prompt admission does, so a later
   * prompt cites it by receipt.
   * Cancellation before storage begins stores nothing; a cancelled upload
   * never receives a receipt, although an image whose storage already began
   * stays in the content-addressed store.
   * @param request - Session identity, ordered bytes, the declared media type that this deployment
   * must accept, cancellation, and optional display name.
   * @returns the staged receipt and durable normalized image reference.
   */
  async uploadImageStream(request: {
    readonly sessionId: SessionId
    readonly data: AsyncIterable<Uint8Array>
    readonly mediaType: string
    readonly signal?: AbortSignal
    readonly name?: string
  }): Promise<ImageUploadValue> {
    const agent = await this.resolveAgent(request.sessionId)
    const limits = this.ctx.attachments.imageLimits
    const mediaType = limits.mediaTypes.find(type => type === request.mediaType)
    if (mediaType === undefined) {
      throw new RemoteError(
        'session/attachment-invalid' as never,
        `Image type ${request.mediaType} is not accepted by this deployment.`,
        { reason: 'UNSUPPORTED_IMAGE_TYPE' } as never,
      )
    }
    const staged = await this.store(agent, async () => {
      // One image must also fit a whole message; stop at the smaller bound, as read-image does.
      const data = await readAtMost(request.data, Math.min(limits.maxImageBytes, limits.maxMessageImageBytes), request.signal)
      // readAtMost checks cancellation per chunk; an abort after the last chunk still stops here.
      request.signal?.throwIfAborted()
      const refs = await this.ctx.attachments.saveImages([{
        data,
        mediaType,
        ...(request.name === undefined ? {} : { name: request.name }),
      }])
      request.signal?.throwIfAborted()
      // saveImages returns one reference per input, in input order.
      return { type: 'image' as const, attachment: refs[0] as ImageAttachmentRef, encodedBytes: data.byteLength }
    })
    return { receiptId: this.stage(agent, staged), image: staged.attachment }
  }

  /**
   * Resolve one staged receipt for the receiving Agent's exact Session.
   * @param agent - receiving Agent.
   * @param receiptId - opaque receipt minted for one completed upload.
   * @returns the staged file or image, or `undefined` for an unknown or foreign receipt.
   */
  resolve(agent: Agent, receiptId: FileUploadReceiptId): StagedAttachment | undefined {
    return this.stagedFiles.get(agent.session)?.get(receiptId)?.attachment
  }

  /**
   * Bind receipts while one prompt enters an Agent inbox.
   * Disposal restores every prior binding unless the caller commits successful delivery.
   * @param agent - receiving Agent.
   * @param receiptIds - distinct staged receipts referenced by the prompt.
   * @param requestId - prompt identity later observed in queue or history.
   * @returns binding kept after commit until queue or history observation retires its receipts.
   */
  bindPrompt(
    agent: Agent,
    receiptIds: readonly FileUploadReceiptId[],
    requestId: string,
  ): PromptFileBinding {
    const staged = this.stagedFiles.get(agent.session)
    const bound = receiptIds.map((receiptId) => {
      const upload = staged?.get(receiptId)
      if (upload === undefined) throw fileNotStaged()
      return { upload, previous: upload.requestId }
    })
    for (const { upload } of bound) upload.requestId = requestId
    return new PromptFileBindingGuard(() => {
      for (const { upload, previous } of bound) {
        if (previous === undefined) delete upload.requestId
        else upload.requestId = previous
      }
    })
  }

  /**
   * Retire every receipt accepted by one removed queue occurrence.
   * @param agent - receiving Agent.
   * @param requestId - prompt identity carried by the queue occurrence.
   */
  retirePrompt(agent: Agent, requestId: string): void {
    this.retire(agent.session, requestId)
  }

  /** Store one upload for an ordinary Agent; storage failures become Remote failures. */
  private async store<T>(agent: Agent, save: () => Promise<T>): Promise<T> {
    this.assertOrdinaryAgent(agent)
    try {
      return await save()
    } catch (error) {
      if (remoteErrorOf(error) !== undefined) throw error
      if (this.ctx.attachments.isAttachmentError(error)) {
        throw new RemoteError('session/attachment-invalid' as never, error.message, { reason: error.code } as never)
      }
      throw new RemoteError(
        'gateway/internal',
        `failed to store file upload: ${String(error)}`,
        {},
        { cause: error },
      )
    }
  }

  /** Stage one stored upload under a new receipt for the Agent's exact Session. */
  private stage(agent: Agent, attachment: StagedAttachment): FileUploadReceiptId {
    if (this.ctx.agents.get(agent.id) !== agent) {
      throw new RemoteError(
        'session/not-found',
        `session "${agent.id}" was disposed before its file upload completed`,
        { sessionId: agent.id },
      )
    }
    let staged = this.stagedFiles.get(agent.session)
    if (staged === undefined) {
      staged = new Map()
      this.stagedFiles.set(agent.session, staged)
    }
    const receiptId = randomUUID() as FileUploadReceiptId
    staged.set(receiptId, { attachment })
    return receiptId
  }

  private async resolveAgent(sessionId: SessionId): Promise<Agent> {
    const live = this.ctx.agents.get(sessionId)
    if (live !== undefined) return live
    const resolver = this.agentResolution.resolver
    if (resolver === undefined) {
      throw new RemoteError('session/not-found', `session "${sessionId}" is not attached`, { sessionId })
    }
    return resolver(sessionId)
  }

  private assertOrdinaryAgent(agent: Agent): void {
    if (agent.session.header.origin === 'subagent') {
      throw new RemoteError(
        'subagent/attachment-invalid' as never,
        'subagent conversations do not accept file uploads',
        { reason: 'SUBAGENT_FILE_UNSUPPORTED' } as never,
      )
    }
  }

  private observeSessionEvent(session: Session, event: SessionEvent): void {
    if (event.type !== 'user/message' || event.data.source.kind !== 'user'
      || !('rpcId' in event.data.source)) return
    if (typeof event.data.source.rpcId === 'string') this.retire(session, event.data.source.rpcId)
  }

  private retire(session: Session, requestId: string): void {
    const staged = this.stagedFiles.get(session)
    if (staged === undefined) return
    for (const [receiptId, upload] of staged) {
      if (upload.requestId === requestId) staged.delete(receiptId)
    }
    if (staged.size === 0) this.stagedFiles.delete(session)
  }
}

/** Collect one body of at most `limit` bytes, refusing it as soon as it passes the limit. */
async function readAtMost(data: AsyncIterable<Uint8Array>, limit: number, signal?: AbortSignal): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  let length = 0
  for await (const chunk of data) {
    signal?.throwIfAborted()
    length += chunk.byteLength
    if (length > limit) {
      throw new RemoteError(
        'session/attachment-invalid' as never,
        'Image exceeds the configured byte limit.',
        { reason: 'IMAGE_TOO_LARGE' } as never,
      )
    }
    chunks.push(chunk)
  }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

function fileNotStaged(): RemoteError {
  return new RemoteError(
    'session/attachment-invalid' as never,
    'File was not uploaded for this session.',
    { reason: 'FILE_NOT_STAGED' } as never,
  )
}

export default FileUploads
