/** Default Desktop Office preview: native document sessions, shared frame views, and their Remote operations. */
import { randomUUID } from 'node:crypto'
import { extname } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { WorkspaceFileScope } from '@deepseek-ai/dsh-api-workspace-files'
import { brandString } from '@deepseek-ai/dsh-brand'
import type {
  EditorDocument, EditorInfo, EditorViewport, OfficeEditorRequest, OfficeKit, PresentationControl,
} from '@deepseek-ai/dsh-office-kit'
import type { FrameChannel } from '@deepseek-ai/dsh-frame-forwarding'
import type { FsTarget } from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import { AsyncChannel } from './channel.ts'
import { Config } from './config.ts'
import { MAX_OFFICE_PIXEL_DIMENSION } from './render-limits.ts'
import type {
  OfficeClientId, OfficeDocumentEvent, OfficeDocumentGeometry, OfficeDocumentId, OfficeDocumentInfo,
  OfficeDocumentStatus, OfficeFrameReply, OfficeFrameRequest, OfficeHeaderQuery, OfficeLoadingStage, OfficeOpenedDocument,
  OfficeOpenProgress, OfficeOpenRequest, OfficePagePreviewReply, OfficePagePreviewRequest, OfficePaintRequest,
  OfficePresentationControl, OfficePreviewAvailability, OfficeQueryResult,
  OfficeReconnectResult, OfficeReconnectTrigger, OfficeRetentionFrame, OfficeSelectionCommand, OfficeSelectionFormat,
  OfficeSelectionInput, OfficeSelectionText,
  OfficeViewport, Rect,
} from './types.ts'

export type * from './types.ts'
export type { Config } from './config.ts'

/** One canonical file opened for one view address and owner. */
interface DocumentRecord {
  readonly id: OfficeDocumentId
  readonly viewKey: string
  readonly revision: number
  clientId?: OfficeClientId
  lease?: AsyncChannel<OfficeRetentionFrame>
  orphanTimer?: NodeJS.Timeout
  readonly sessionId: SessionId
  readonly target: FsTarget
  readonly version: string
  readonly format: OfficeOpenedDocument['format']
  readonly document: EditorDocument
  /** Frame-forwarding channel owned by this document view. */
  channel?: FrameChannel
  /** Whether the current engine holds the channel's producer connection. */
  attached: boolean
  /** `performance.now()` of each automatic reconnect inside the current window. */
  automaticReconnects: number[]
  /** Latest slide, including a natural end until the renderer acknowledges it with stop. */
  presentation: Extract<OfficeDocumentEvent['event'], { kind: 'presentation' }> | undefined
  failed?: string
  unsubscribe: () => void
}

type TrackedOpenOptions = OfficeEditorRequest & { readonly onProgress: (stage: OfficeLoadingStage) => void }

const SELECTION_COMMANDS = new Set(['SelectAll', 'GoToStartOfDoc', 'GoToEndOfDoc', 'GoToCell', 'Copy'])
const NAVIGATION_KEYS = new Set([1024, 1025, 1026, 1027, 1028, 1029, 1030, 1031, 1281, 1282])

/**
 * Validate a renderer-supplied coordinate or counter.
 * @param value - Number decoded from the Remote request.
 * @param minimum - Inclusive lower bound.
 * @param maximum - Inclusive upper bound.
 * @returns The bounded safe integer.
 */
function integer(value: number, minimum = 0, maximum = 2147483647): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error('Invalid Office coordinate.')
  return value
}

function rectangle(value: Rect): Rect {
  return { x: integer(value.x), y: integer(value.y), width: integer(value.width, 1), height: integer(value.height, 1) }
}

/** Validate the backend reported across the Kit process boundary before exposing native geometry. */
function documentInfo(value: EditorInfo): OfficeDocumentInfo {
  const { renderBackend } = value
  if (renderBackend !== 'ganesh' && renderBackend !== 'graphite')
    throw new Error('Native Office requires GPU rendering.')
  return { ...value, renderBackend }
}

/**
 * Remote-only service for read-only native Office documents. The operations of one document view run in Remote arrival
 * order; different views run concurrently, so one view's slow or waiting operation does not delay another's.
 */
export default class OfficePreview extends TypertRemoteService {
  static inject = ['fs', 'sandboxPolicy']
  static Config = Config

  private readonly documents = new Map<OfficeDocumentId, DocumentRecord>()
  private readonly subscribers = new Set<AsyncChannel<OfficeDocumentEvent>>()
  /** The last queued operation of each document view, by tab and address. */
  private readonly queues = new Map<string, Promise<void>>()
  /** In-flight `officeKit.openDocument` calls, including timed-out opens awaiting late teardown. */
  private readonly pendingOpens = new Set<Promise<void>>()
  /** Cached runtime probe for the active `officeKit` provider instance; replaced if `officeKit` reloads. */
  private nativeRuntime: { readonly kit: OfficeKit; readonly supported: Promise<boolean> } | undefined
  private nativeFrames: Promise<boolean> | undefined
  private stopped = false

  /**
   * @param ctx - Desktop Host scope.
   * @param config - Native preview resource and operation limits.
   */
  constructor(ctx: Context, readonly config: Config) {
    super(ctx, 'officePreview')
    if (config.channelConnectTimeoutMs >= config.operationTimeoutMs)
      throw new Error('Office channelConnectTimeoutMs must be shorter than operationTimeoutMs.')
    ctx.effect(() => async () => {
      this.stopped = true
      for (const subscriber of this.subscribers) subscriber.end()
      await Promise.all(this.queues.values())
      await Promise.all(this.pendingOpens)
      const results = await Promise.allSettled([...this.documents.values()].map(record => this.closeDocument(record)))
      for (const result of results) if (result.status === 'rejected') this.ctx.logger.warn(result.reason)
      this.documents.clear()
    })
  }

  /** The frame-forwarding service; its `capabilities()` report whether this Host can present frames. */
  private frames(): Context['frameForwarding'] {
    const frames = this.ctx.get('frameForwarding')
    if (frames === undefined) throw new Error('Frame forwarding is unavailable.')
    return frames
  }

  /**
   * Decide whether this Host offers native preview through the current `officeKit` and `frameForwarding` providers.
   * Desktop can stop presenting native frames later, after Chromium stops compositing on the GPU; opening a channel
   * then fails, and {@link reconnect} reports it.
   * @returns The active `officeKit` service when native preview is available, otherwise `undefined`.
   */
  private async nativeEngine(): Promise<OfficeKit | undefined> {
    const kit = this.ctx.get('officeKit')
    if (kit === undefined) return undefined
    const frames = this.ctx.get('frameForwarding')
    if (frames === undefined) return undefined
    if (this.nativeRuntime?.kit !== kit) {
      const supported = kit.discoverRuntime().then(
        runtime => runtime !== undefined && runtime.backend === 'native' && runtime.nativePreview,
      )
      this.nativeRuntime = { kit, supported }
      // Do not retain a rejected discovery so a later retry observes current state rather than a cached error.
      supported.catch(() => { if (this.nativeRuntime?.supported === supported) this.nativeRuntime = undefined })
    }
    if (!await this.nativeRuntime.supported) return undefined
    this.nativeFrames ??= frames.capabilities().then((capabilities) => {
      if (!capabilities.supported) this.ctx.logger.warn('Native Office preview is unavailable: %s', capabilities.reason ?? 'frame forwarding is unsupported')
      return capabilities.supported
    }, (error: unknown) => {
      this.ctx.logger.warn('Native Office preview is unavailable: %s', error instanceof Error ? error.message : String(error))
      return false
    })
    return await this.nativeFrames ? kit : undefined
  }

  /**
   * Report whether documents of the connected workspace render natively on this Host.
   * @returns `local` when a native runtime, Desktop frame forwarding, and the workspace files share this Host.
   */
  @Remote
  async availability(): Promise<OfficePreviewAvailability> {
    const workspaceOnHost = this.ctx.fs.processPathFromHostPath(this.ctx.sandboxPolicy.workspaceRoot) !== undefined
    return { local: workspaceOnHost && await this.nativeEngine() !== undefined }
  }

  /**
   * Open a Session file, or reattach the document already bound to this view.
   * @param workspaceFileScope - Session workspace root resolved from the Session identity on the wire.
   * @param request - View identity and file path.
   * @param signal - Stops progress delivery. An admitted open waits for a renderer lease until its grace period expires.
   * @returns Loading stages followed by the opened document.
   */
  @Remote({ mode: 'stream' })
  open(workspaceFileScope: WorkspaceFileScope, request: OfficeOpenRequest, signal: AbortSignal): AsyncIterable<OfficeOpenProgress> {
    const channel = new AsyncChannel<OfficeOpenProgress>()
    const key = JSON.stringify([request.address, request.owner])
    this.enqueue(key, () => this.openDocument(workspaceFileScope, request, key, (stage) => { channel.push({ kind: 'stage', stage }) }))
      .then((document) => { channel.push({ kind: 'opened', document }); channel.end() }, (error: unknown) => { channel.fail(error) })
    return channel.iterate(signal)
  }

  /**
   * Observe engine callbacks and failures independently of document ownership.
   * @param signal - Subscriber lifetime.
   * @returns Live notifications until cancellation or disposal.
   */
  @Remote({ mode: 'stream' })
  events(signal: AbortSignal): AsyncIterable<OfficeDocumentEvent> {
    const channel = new AsyncChannel<OfficeDocumentEvent>()
    this.subscribers.add(channel)
    return channel.iterate(signal, () => { this.subscribers.delete(channel) })
  }

  /**
   * Retain an open document for this renderer and synchronize its slideshow on reattachment.
   * @param documentId - Host-issued identity returned by open.
   * @param clientId - Stable across carrier reconnects within one renderer.
   * @param signal - Losing this lease starts the document's orphan grace period.
   * @returns Current slideshow state followed by changes until release, replacement or disconnection.
   */
  @Remote({ mode: 'stream' })
  async *retain(documentId: OfficeDocumentId, clientId: OfficeClientId, signal: AbortSignal): AsyncIterable<OfficeRetentionFrame> {
    const channel = new AsyncChannel<OfficeRetentionFrame>()
    const record = await this.operate(documentId, async (record) => {
      signal.throwIfAborted()
      if (record.clientId !== undefined && record.clientId !== clientId && record.presentation !== undefined) {
        if (!record.presentation.ended) await record.document.presentation({ action: 'stop' })
        record.presentation = undefined
      }
      clearTimeout(record.orphanTimer)
      delete record.orphanTimer
      record.lease?.end()
      record.lease = channel
      record.clientId = clientId
      channel.push(record.presentation === undefined ? {} : { presentation: record.presentation })
      return record
    })
    yield* channel.iterate(signal, () => {
      if (record.lease !== channel) return
      delete record.lease
      this.scheduleOrphan(record)
    })
  }

  /**
   * Read status and current geometry.
   * @param documentId - Open document.
   * @returns Status, plus geometry unless the renderer failed.
   */
  @Remote
  info(documentId: OfficeDocumentId): Promise<OfficeDocumentGeometry> {
    return this.operate(documentId, async (record) => {
      if (record.failed !== undefined) return this.status(record)
      return { ...this.status(record), info: documentInfo(await record.document.getInfo()) }
    }, { allowFailed: true })
  }

  /**
   * Set the visible area used by native input and drawing.
   * @param documentId - Open document.
   * @param viewport - Visible twip area and the render window's physical-pixel/twip ratio, including render DPR.
   * @returns Document status.
   */
  @Remote
  viewport(documentId: OfficeDocumentId, viewport: OfficeViewport): Promise<OfficeDocumentStatus> {
    return this.operate(documentId, async (record) => {
      const value: EditorViewport = {
        ...rectangle(viewport), pixelSize: integer(viewport.pixelSize, 1, 65536), twipSize: integer(viewport.twipSize, 1, 1000000),
      }
      await record.document.setViewport(value)
      return this.status(record)
    })
  }

  /**
   * Select a sheet or slide.
   * @param documentId - Open document.
   * @param part - Zero-based sheet or slide.
   * @returns Status and the selected part's geometry.
   */
  @Remote
  part(documentId: OfficeDocumentId, part: number): Promise<OfficeDocumentGeometry> {
    return this.operate(documentId, async (record) => {
      return { ...this.status(record), info: documentInfo(await record.document.setPart(integer(part, 0, 10000))) }
    })
  }

  /**
   * Render one document region into the document's shared view.
   * @param documentId - Open document with a native view.
   * @param request - Twip area, physical size, and the generation resolved by `setContentWindow` after the preceding paint.
   * @returns Shared frame dimensions; the frame arrives through frame forwarding. `office/frame-retry` rejects with a
   * structured reason while leaving the document usable: `stale` waits for viewport readiness, `credit-timeout` for credit.
   */
  @Remote
  paint(documentId: OfficeDocumentId, request: OfficePaintRequest): Promise<OfficeFrameReply> {
    return this.operate(documentId, async (record) => {
      const area = { ...rectangle(request), ...(request.part === undefined ? {} : { part: integer(request.part, 0, 10000) }) }
      const frame = await record.document.renderSurface(area, integer(request.pixelWidth, 1, MAX_OFFICE_PIXEL_DIMENSION),
        integer(request.pixelHeight, 1, MAX_OFFICE_PIXEL_DIMENSION), this.frameRequest(record, request.frame))
      return { ...this.status(record), width: frame.width, height: frame.height }
    })
  }

  /**
   * Render a static page preview without using the shared-frame channel. Queued with this document's other operations.
   * @param documentId - Open document; closed or failed documents reject without rendering.
   * @param request - Twip area and physical size; each edge is at most 4096 and RGBA bytes must fit `maxPagePreviewBytes`.
   * @returns Document status and owned, tightly packed, straight-alpha RGBA pixels.
   */
  @Remote
  pagePreview(documentId: OfficeDocumentId, request: OfficePagePreviewRequest): Promise<OfficePagePreviewReply> {
    return this.operate(documentId, async (record) => {
      const area = { ...rectangle(request), ...(request.part === undefined ? {} : { part: integer(request.part, 0, 10000) }) }
      const width = integer(request.pixelWidth, 1, MAX_OFFICE_PIXEL_DIMENSION)
      const height = integer(request.pixelHeight, 1, MAX_OFFICE_PIXEL_DIMENSION)
      if (width * height * 4 > this.config.maxPagePreviewBytes) {
        throw new RemoteError('gateway/bad-request', 'Office page preview exceeds maxPagePreviewBytes; request fewer pixels.', {
          issues: [{ pixelWidth: width, pixelHeight: height, maxPagePreviewBytes: this.config.maxPagePreviewBytes }],
        })
      }
      const rendered = await record.document.render(area, width, height)
      if (rendered.pixels.byteLength > this.config.maxPagePreviewBytes)
        throw new RemoteError('gateway/internal', 'Office page preview returned more bytes than maxPagePreviewBytes.', {})
      return { ...this.status(record), width: rendered.width, height: rendered.height, rgba: rendered.pixels }
    })
  }

  /**
   * Query Calc row and column boundaries.
   * @param documentId - Open spreadsheet.
   * @param query - Visible twip area.
   * @returns LibreOfficeKit's header JSON.
   */
  @Remote
  values(documentId: OfficeDocumentId, query: OfficeHeaderQuery): Promise<OfficeQueryResult> {
    return this.operate(documentId, async record => ({
      value: await record.document.getValues(query.command, rectangle(query.area)),
    }))
  }

  /**
   * Control a slideshow.
   * @param documentId - Open presentation.
   * @param control - Playback action; streams require a native view.
   * @returns Document status.
   */
  @Remote
  presentation(documentId: OfficeDocumentId, control: OfficePresentationControl): Promise<OfficeDocumentStatus> {
    return this.operate(documentId, async (record) => {
      let native: PresentationControl
      switch (control.action) {
        case 'start':
          native = { action: 'start', pixelWidth: integer(control.pixelWidth, 1, MAX_OFFICE_PIXEL_DIMENSION),
            pixelHeight: integer(control.pixelHeight, 1, MAX_OFFICE_PIXEL_DIMENSION), part: integer(control.part, 0, 10000) }
          break
        case 'resize':
          native = { action: 'resize', pixelWidth: integer(control.pixelWidth, 1, MAX_OFFICE_PIXEL_DIMENSION),
            pixelHeight: integer(control.pixelHeight, 1, MAX_OFFICE_PIXEL_DIMENSION) }
          break
        case 'next':
        case 'previous':
        case 'stop':
          native = { action: control.action }
          break
        case 'pause':
          native = { action: 'pause', paused: control.paused }
          break
        case 'stream': {
          if (!record.attached) throw new Error('Office shared rendering is unavailable.')
          if (control.streamId.length > 256) throw new Error('Invalid Office stream identifier.')
          const requestId = control.streamId, generation = integer(control.generation)
          native = control.enabled
            ? { action: 'stream', enabled: true, requestId, generation, frameRate: this.config.presentationFrameRate }
            : { action: 'stream', enabled: false, requestId, generation }
          break
        }
        default:
          assertNever(control, 'Office presentation control')
      }
      if (control.action === 'start') {
        // Kit may report a later slide or the end before acknowledging start.
        const previous = record.presentation
        const starting = { kind: 'presentation', part: control.part, ended: false } as const
        record.presentation = starting
        try { await record.document.presentation(native) }
        catch (error) {
          if (record.presentation === starting) record.presentation = previous
          throw error
        }
      } else {
        await record.document.presentation(native)
        if (control.action === 'stop') record.presentation = undefined
      }
      return this.status(record)
    })
  }

  /**
   * Copy the native selection.
   * @param documentId - Open document.
   * @param mime - Requested clipboard format.
   * @returns Selected text in that format.
   */
  @Remote
  selection(documentId: OfficeDocumentId, mime: OfficeSelectionFormat): Promise<OfficeSelectionText> {
    return this.operate(documentId, async record => ({
      ...this.status(record), text: await record.document.getSelection(mime),
    }))
  }

  /**
   * Run a selection or navigation command; content commands remain unavailable.
   * @param documentId - Open document.
   * @param request - Whitelisted command and its UNO arguments.
   * @returns Document status.
   */
  @Remote
  command(documentId: OfficeDocumentId, request: OfficeSelectionCommand): Promise<OfficeDocumentStatus> {
    return this.operate(documentId, async (record) => {
      if (!SELECTION_COMMANDS.has(request.command)) throw new Error('Office document is read-only.')
      await record.document.dispatch(request.command, request.arguments)
      return this.status(record)
    })
  }

  /**
   * Deliver selection pointer input or a navigation key.
   * @param documentId - Open document.
   * @param input - Mouse input in twips or a navigation key without a character.
   * @returns Document status.
   */
  @Remote
  input(documentId: OfficeDocumentId, input: OfficeSelectionInput): Promise<OfficeDocumentStatus> {
    return this.operate(documentId, async (record) => {
      if (input.op === 'mouse') {
        await record.document.input({ op: 'mouse', type: input.type, x: integer(input.x), y: integer(input.y),
          count: integer(input.count, 1, 3), buttons: integer(input.buttons, 0, 7), modifiers: integer(input.modifiers, 0, 65535) })
      } else {
        if (input.character !== 0 || !NAVIGATION_KEYS.has(input.key & 4095)) throw new Error('Office document is read-only.')
        await record.document.input({ op: 'key', type: input.type, character: 0, key: integer(input.key, 0, 65535) })
      }
      return this.status(record)
    })
  }

  /**
   * Connect the document's running engine to a new frame-forwarding channel after the renderer lost the previous one.
   * The engine keeps its render backend and unsaved edits. Preview resumes on the last slide shown. An automatic request
   * changes nothing while the channel is open, and each document replaces at most `automaticReconnects` channels per
   * `automaticReconnectWindowMs` automatically, because a frame of the new channel can crash Chromium's GPU process
   * again. A user request always replaces the channel and is not limited.
   * @param documentId - Open document whose engine has not failed.
   * @param trigger - `automatic` when the renderer lost the channel, `user` when the user asked to reconnect.
   * @returns The document's status on its channel, or why no channel was connected.
   */
  @Remote
  reconnect(documentId: OfficeDocumentId, trigger: OfficeReconnectTrigger): Promise<OfficeReconnectResult> {
    return this.operate(documentId, async (record) => {
      const frames = this.frames()
      if (trigger === 'automatic' && record.channel !== undefined && frames.isOpen(record.channel.rx))
        return { outcome: 'reconnected', status: this.status(record) }
      const now = performance.now()
      const { automaticReconnects, automaticReconnectWindowMs } = this.config
      if (trigger === 'automatic') {
        record.automaticReconnects = record.automaticReconnects.filter(time => now - time < automaticReconnectWindowMs)
        if (record.automaticReconnects.length >= automaticReconnects) return { outcome: 'limited' }
      }
      const capabilities = await frames.capabilities()
      if (!capabilities.supported) return { outcome: 'unavailable', reason: capabilities.reason ?? 'frame forwarding is unsupported' }
      if (record.presentation !== undefined) {
        let playback = record.presentation
        record.presentation = undefined
        try {
          if (!playback.ended) {
            await record.document.presentation({ action: 'stop' })
            playback = { ...playback, ended: true }
          }
          await record.document.setPart(playback.part)
        } catch (error) {
          record.presentation = playback
          throw error
        }
      }
      // The renderer's viewport versions start over on the new channel, which the engine joins at once.
      await this.closeChannel(record)
      await this.connectProducer(record, record.document)
      record.attached = true
      if (trigger === 'automatic') record.automaticReconnects.push(now)
      return { outcome: 'reconnected', status: this.status(record) }
    })
  }

  /**
   * Close a document and its frame-forwarding channel; an unknown document is already released.
   * @param documentId - Document to release.
   * @returns Completion after the native process and channel are closed.
   */
  @Remote
  release(documentId: OfficeDocumentId): Promise<void> {
    const queued = this.documents.get(documentId)
    if (queued === undefined) return Promise.resolve()
    return this.enqueue(queued.viewKey, async () => {
      const record = this.documents.get(documentId)
      if (record === undefined) return
      await this.closeDocument(record)
    })
  }

  private enqueue<T>(view: string, work: () => Promise<T>): Promise<T> {
    const run = (this.queues.get(view) ?? Promise.resolve()).then(work)
    const tail = run.then(() => {}, () => {})
    this.queues.set(view, tail)
    void tail.then(() => { if (this.queues.get(view) === tail) this.queues.delete(view) })
    return run
  }

  private operate<T>(
    documentId: OfficeDocumentId, run: (record: DocumentRecord) => Promise<T>, options: { readonly allowFailed?: boolean } = {},
  ): Promise<T> {
    const queued = this.documents.get(documentId)
    if (queued === undefined) return Promise.reject(new RemoteError('office/document-expired', 'Office document is closed.', {}))
    return this.enqueue(queued.viewKey, async () => {
      const record = this.documents.get(documentId)
      if (record === undefined) throw new RemoteError('office/document-expired', 'Office document is closed.', {})
      if (record.failed !== undefined && options.allowFailed !== true) throw new Error(record.failed)
      try {
        return await run(record)
      } catch (error) {
        // Kit exposes these transient frame rejections as text; only this Host adapter interprets it.
        if (error instanceof Error) {
          const reason = error.message === 'Native frame viewport is stale' ? 'stale'
            : error.message === 'Native texture credit timed out' ? 'credit-timeout' : undefined
          if (reason !== undefined) throw new RemoteError('office/frame-retry', error.message, { reason }, { cause: error })
        }
        throw error
      }
    })
  }

  /** Supply the Kit-only correlation field; Office callers send only an acknowledged generation. */
  private frameRequest(record: DocumentRecord, request: OfficeFrameRequest): Parameters<EditorDocument['renderSurface']>[3] {
    if (!record.attached) throw new Error('Office shared rendering is unavailable.')
    return { requestId: randomUUID(), generation: integer(request.generation) }
  }

  private status(record: DocumentRecord): OfficeDocumentStatus {
    return {
      documentId: record.id,
      ...(record.channel === undefined || record.failed !== undefined ? {} : {
        nativeView: { rx: record.channel.rx, frameTimeoutMs: this.config.frameTimeoutMs },
      }),
      ...(record.failed === undefined ? {} : { failed: record.failed }),
    }
  }

  private opened(record: DocumentRecord, info: OfficeOpenedDocument['info']): OfficeOpenedDocument {
    const { operationTimeoutMs, overscanViewports, reanchorHysteresis, zoomSettleMs, creditRetryLimit, maxPagePreviewBytes } = this.config
    return { ...this.status(record), info, format: record.format, version: record.version,
      rendering: { operationTimeoutMs, overscanViewports, reanchorHysteresis, zoomSettleMs, creditRetryLimit, maxPagePreviewBytes } }
  }

  private options(): NonNullable<OfficeEditorRequest['options']> {
    const { maxDocumentBytes, operationTimeoutMs } = this.config
    return { maxInputBytes: maxDocumentBytes, maxOutputBytes: this.config.maxPagePreviewBytes, timeoutMs: operationTimeoutMs }
  }

  private async openDocument(
    scope: WorkspaceFileScope, request: OfficeOpenRequest, key: string, onProgress: (stage: OfficeLoadingStage) => void,
  ): Promise<OfficeOpenedDocument> {
    const { address, owner, path: sourcePath } = request
    const kit = this.stopped ? undefined : await this.nativeEngine()
    if (kit === undefined) throw new Error('Native Office preview is unavailable.')
    if (sourcePath.length === 0 || address.length === 0 || owner.length === 0)
      throw new Error('Office requires an explicit session file and view identity.')
    const revision = integer(request.revision, 0, Number.MAX_SAFE_INTEGER)
    const target = await this.ctx.fs.resolve(sourcePath, { cwd: scope.workspaceRoot })
    const path = this.ctx.fs.processPath(target)
    if (this.ctx.fs.processPathFromHostPath(path) !== path) throw new Error('Native Office requires a local filesystem.')
    const owned = [...this.documents.values()].find(record => record.viewKey === key)
    if (owned !== undefined) {
      if (owned.sessionId !== scope.sessionId || owned.target.targetKey !== target.targetKey)
        throw new Error('Office view is already bound to another file.')
      if (owned.revision !== revision) {
        await this.closeDocument(owned)
      }
    }
    if (owned?.revision === revision) {
      try {
        if (owned.failed !== undefined) throw new Error(owned.failed)
        // A reattaching renderer starts its viewport versions over, so it receives a fresh channel.
        await this.closeChannel(owned)
        await this.connectProducer(owned, owned.document)
        owned.attached = true
        const info = documentInfo(await owned.document.getInfo())
        // oxlint-disable-next-line typescript/no-unnecessary-condition -- Engine events can mark the record failed during reattachment.
        if (owned.failed !== undefined) throw new Error(owned.failed)
        this.scheduleOrphan(owned)
        return this.opened(owned, info)
      } catch (error) {
        try { await this.closeDocument(owned) } catch (cleanupError) { this.ctx.logger.warn(cleanupError) }
        throw error
      }
    }
    const format = extname(path).slice(1).toLowerCase()
    if (format !== 'docx' && format !== 'xlsx' && format !== 'pptx') throw new Error('Unsupported native Office format.')
    const stat = await this.ctx.fs.stat(target)
    if (stat?.type !== 'file') throw new Error('Office file is missing or is not a regular file.')
    const bytes = await this.ctx.fs.readBytes(target, undefined, this.config.maxDocumentBytes)
    if ((await this.ctx.fs.stat(target))?.version !== stat.version) throw new Error('Office file changed while opening.')
    const renderBackend = this.config.renderBackend
    const document = await this.openWithinDeadline(kit, {
      onProgress, bytes, format, renderBackend, options: this.options(),
    })
    let openingFailure: Error | undefined
    const record: DocumentRecord = {
      id: brandString<OfficeDocumentId>(randomUUID()), viewKey: key, revision, sessionId: scope.sessionId, target,
      version: stat.version, format, document, attached: false, automaticReconnects: [], presentation: undefined,
      unsubscribe: document.onEvent((event) => { if (event.kind === 'failure') openingFailure = event.error }),
    }
    let initialInfo: OfficeDocumentInfo
    try {
      initialInfo = documentInfo(document.initialInfo)
      await this.connectProducer(record, document)
      record.attached = true
      if (openingFailure !== undefined) throw openingFailure
    } catch (error) {
      await this.closeDocument(record)
      throw error
    }
    record.unsubscribe()
    this.documents.set(record.id, record)
    this.subscribe(record)
    this.scheduleOrphan(record)
    return this.opened(record, initialInfo)
  }

  private async openWithinDeadline(kit: OfficeKit, options: TrackedOpenOptions): Promise<EditorDocument> {
    const deadline = `Office open exceeded ${this.config.operationTimeoutMs}ms.`
    const startup = new AbortController()
    const aborted = Promise.withResolvers<undefined>()
    const onAbort = (): void => { aborted.resolve(undefined) }
    startup.signal.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => { startup.abort(new Error(deadline)) }, this.config.operationTimeoutMs)
    // Keep observing an opener that ignores abort so a late document cannot escape ownership.
    const tracked: TrackedOpenOptions = { ...options, signal: startup.signal, onProgress: (stage) => {
      if (!startup.signal.aborted) options.onProgress(stage)
    } }
    const opening = kit.openDocument(tracked).then(async (document) => {
      if (!startup.signal.aborted) return document
      try {
        await document.close()
      } catch (error) {
        this.ctx.logger.warn(error)
      }
      return undefined
    }, (error: unknown) => {
      if (!startup.signal.aborted) throw error
      if (error !== startup.signal.reason) this.ctx.logger.warn(error)
      return undefined
    })
    const trackedOpen = opening.then(() => {}, () => {}).finally(() => { this.pendingOpens.delete(trackedOpen) })
    this.pendingOpens.add(trackedOpen)
    try {
      const document = await Promise.race([opening, aborted.promise])
      if (document === undefined) throw new Error(deadline)
      return document
    } finally {
      clearTimeout(timer)
      startup.signal.removeEventListener('abort', onAbort)
    }
  }

  private subscribe(record: DocumentRecord): void {
    record.unsubscribe = record.document.onEvent((event) => {
      if (event.kind === 'revision') return
      if (event.kind === 'presentation') {
        if (record.presentation === undefined) return
        record.presentation = event
        record.lease?.push({ presentation: event })
        return
      }
      if (event.kind === 'failure') {
        record.failed = event.error.message
        record.attached = false
        record.presentation = undefined
        // Serialize channel teardown with admitted operations and release.
        void this.enqueue(record.viewKey, () => this.closeChannel(record)).catch((error: unknown) => { this.ctx.logger.warn(error) })
      }
      for (const subscriber of this.subscribers) subscriber.push({
        ...this.status(record), event: event.kind === 'failure' ? { kind: 'failure', error: event.error.message } : event,
      })
    })
  }

  /** Open a channel after the caller has released any preceding one. */
  private async ensureChannel(record: DocumentRecord): Promise<FrameChannel> {
    const frames = this.frames()
    const capabilities = await frames.capabilities()
    if (!capabilities.supported) throw new Error('Office FrameForwarding is unavailable.')
    record.channel = await frames.channel()
    return record.channel
  }

  /** Connect the document engine to its channel; the caller records the attachment. */
  private async connectProducer(record: DocumentRecord, document: EditorDocument): Promise<void> {
    const { tx } = await this.ensureChannel(record)
    await document.attachSurfaceTransport(tx, { timeoutMs: this.config.channelConnectTimeoutMs })
  }

  /** Close the current engine's producer connection and keep the channel; an exited engine has none to close. */
  private async disconnectProducer(record: DocumentRecord): Promise<void> {
    if (!record.attached) return
    record.attached = false
    await record.document.detachSurfaceTransport()
  }

  /** Destroy the document view's channel; releasing, reattaching, or reconnecting the view does this. */
  private async closeChannel(record: DocumentRecord): Promise<void> {
    const channel = record.channel
    if (channel === undefined) return
    delete record.channel
    try { await this.disconnectProducer(record) } finally { await this.frames().close(channel.rx) }
  }

  private scheduleOrphan(record: DocumentRecord): void {
    if (record.lease !== undefined || this.stopped) return
    clearTimeout(record.orphanTimer)
    const timer = setTimeout(() => {
      void this.enqueue(record.viewKey, async () => {
        if (record.orphanTimer !== timer) return
        await this.closeDocument(record)
      }).catch((error: unknown) => { this.ctx.logger.warn(error) })
    }, this.config.orphanRetentionMs)
    timer.unref()
    record.orphanTimer = timer
  }

  private async closeDocument(record: DocumentRecord): Promise<void> {
    clearTimeout(record.orphanTimer)
    delete record.orphanTimer
    record.lease?.end()
    delete record.lease
    record.unsubscribe()
    try { await this.closeChannel(record) } catch (error) { this.ctx.logger.warn(error) }
    try { await record.document.close() }
    catch (error) {
      record.failed = 'Office document cleanup failed.'
      this.documents.set(record.id, record)
      this.scheduleOrphan(record)
      throw error
    }
    this.documents.delete(record.id)
  }
}
