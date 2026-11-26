/**
 * Main-process presentation of Host-supplied textures in the product document. Frames arrive on the native ingress
 * with Main-local handles, and Main replies on the same channel; pixels never enter the Host IPC channel, which carries
 * only capability and adapter queries.
 */
import { app, sharedTexture, type BrowserWindow } from 'electron'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type {
  SharedTextureIngress, SharedTextureIngressBindings, SharedTextureIngressEvent, SharedTextureIngressReply,
} from './ingress.ts'
import { probeSharedTexture } from './probe.ts'
import {
  sendSharedTexture, type SentSharedTexture, type SentSharedTextureSettlement, type SharedTextureNativeHandle,
  type SharedTextureRendererImport,
} from './transfer.ts'
import type { SharedTextureHostRequest, SharedTextureMainCapabilities } from '@deepseek-ai/dsh-desktop-host/types'

/** The requesting Desktop Host: the only process whose ingress connection Main accepts. */
export interface SharedTextureHostLink { readonly pid: number }

/** What a cleanup follows; Chromium can move its compositor to another adapter only when its GPU process exits. */
export interface SharedTextureResetOptions {
  /** The cleanup follows a GPU process exit, so the next adapter query probes again. */
  gpuProcessGone?: boolean
}

type PresentationWindow = {
  isDestroyed(): boolean
  webContents: Pick<BrowserWindow['webContents'], 'isDestroyed' | 'mainFrame'>
}
type FrameEvent = Extract<SharedTextureIngressEvent, { type: 'frame' }>
/** One admitted frame as a presentation backend receives it. */
interface PresentedFrame {
  width: number
  height: number
  pixelFormat: 'bgra' | 'rgba'
  /** The Host's UTF-8 JSON metadata text, or `''` for none; Main forwards it unparsed. */
  metadata: string
}
/** The ingress opened for one Host process. */
interface OpenIngress {
  readonly pid: number
  readonly bindings: SharedTextureIngressBindings
  readonly ingress: SharedTextureIngress
  /** Terminal ingress error; the next capability query replaces this ingress. */
  failed: Error | undefined
  /** Set when closing starts; Main sends no reply afterwards. */
  closing: Promise<void> | undefined
}
/** The one adapter probe in progress, which every adapter query of its GPU process generation shares. */
interface AdapterProbe {
  readonly gpu: number
  readonly controller: AbortController
  readonly result: Promise<string | null>
}

/** Matches the Host hop's limit of unsettled frames. */
const MAX_PRESENTATIONS = 128

function errorOf(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

function parseRendererImport(value: unknown): SharedTextureRendererImport {
  if (typeof value === 'object' && value !== null) {
    if ('syncToken' in value && typeof value.syncToken === 'string') return { syncToken: value.syncToken }
    if ('error' in value && typeof value.error === 'string') {
      if ('invalidated' in value && value.invalidated === true) return { error: value.error, invalidated: true }
      return { error: value.error }
    }
  }
  return { error: 'Invalid renderer import result' }
}

function nativeHandle(handle: Buffer): SharedTextureNativeHandle {
  return process.platform === 'win32' ? { ntHandle: handle } : { ioSurface: handle }
}

/**
 * One window's shared-texture entry points for one Desktop Host at a time. The ingress opened for the Host lives as
 * long as that Host process: window-level events {@link reset} sent textures only, and a new Host process or
 * {@link dispose} replaces or closes it.
 */
export class DesktopSharedTexturePresenter {
  private bindings: { native: SharedTextureIngressBindings } | { error: Error } | undefined
  private ingress: OpenIngress | undefined
  /** Textures sent to the product renderer whose references are not all released, by Main-assigned renderer receipt. */
  private readonly sent = new Map<number, SentSharedTexture>()
  private readonly operations = new Set<Promise<unknown>>()
  private resetting: Promise<void> | undefined
  /**
   * Product document generation: each cleanup after a committed cross-document navigation, renderer or GPU loss, or
   * window closure starts a new one. Frames arrive synchronously, so a frame that arrives after a cleanup began
   * belongs to the next document; a capability query that spans a cleanup fails.
   */
  private page = 0
  /**
   * GPU process generation: a cleanup after a GPU process exit and {@link dispose} start a new one, which forgets the
   * compositor adapter and keeps a probe of the previous generation from recording its answer.
   */
  private gpu = 0
  /** Chromium's compositor adapter as read in GPU process generation `gpu`. */
  private adapter: { readonly gpu: number; readonly luid: string } | undefined
  private adapterProbe: AdapterProbe | undefined
  private nextReceipt = 0
  /** Admitted frames whose settlement has not run; Main refuses a frame beyond {@link MAX_PRESENTATIONS}. */
  private presenting = 0

  /**
   * @param window - Current owning application window.
   * @param hopAddon - `shared-texture-hop.node` path the Desktop Host loads.
   * @param loadIngress - Load the ingress addon; called at most once, on the first capability or adapter query.
   */
  constructor(
    private readonly window: () => PresentationWindow | undefined,
    private readonly hopAddon: string,
    private readonly loadIngress: () => SharedTextureIngressBindings,
  ) {}

  /** Dispatch a Host control; renderers cannot reach these operations.
   * @param request - Host request validated by the Host channel.
   * @param host - The Host process that sent the request.
   * @returns Capability data or the adapter reading; rejects while a cleanup runs.
   */
  request(request: SharedTextureHostRequest, host: SharedTextureHostLink): Promise<unknown> {
    if (this.resetting !== undefined) return Promise.reject(new Error('Shared textures are closing'))
    return this.track(this.dispatch(request, host))
  }

  private async track<T>(operation: Promise<T>): Promise<T> {
    this.operations.add(operation)
    try {
      return await operation
    } finally {
      this.operations.delete(operation)
    }
  }

  private async dispatch(request: SharedTextureHostRequest, host: SharedTextureHostLink): Promise<unknown> {
    switch (request.op) {
      case 'capabilities':
        return this.capabilities(host)
      case 'adapter-luid':
        return this.adapterLuid(request.timeoutMs)
      /* v8 ignore next -- Host requests are parsed into the exhausted closed union. */
      default: return assertNever(request)
    }
  }

  /**
   * Chromium falls back to software compositing after repeated GPU process crashes, so support is read on every query.
   * @returns Why textures are unsupported now, or the loaded ingress addon.
   */
  private support(): { reason: string } | { bindings: SharedTextureIngressBindings } {
    if (process.platform !== 'win32' && process.platform !== 'darwin') return { reason: 'unsupported-platform' }
    if (!app.getGPUFeatureStatus().gpu_compositing.startsWith('enabled')) return { reason: 'gpu-compositing-disabled' }
    if (typeof sharedTexture.subtle.importSharedTexture !== 'function') return { reason: 'electron-shared-texture-unavailable' }
    const bindings = this.loaded()
    if ('error' in bindings) return { reason: `ingress-unavailable: ${bindings.error.message}` }
    return { bindings: bindings.native }
  }

  private async capabilities(host: SharedTextureHostLink): Promise<SharedTextureMainCapabilities> {
    const pid = process.pid
    const support = this.support()
    if ('reason' in support) return { supported: false, reason: support.reason, pid }
    if (this.ingress !== undefined && (this.ingress.pid !== host.pid || this.ingress.failed !== undefined)) {
      const page = this.page
      await this.closeIngress()
      if (page !== this.page) throw new Error('Shared textures were reset during ingress replacement')
    }
    if (this.ingress === undefined) {
      let record: OpenIngress | undefined = undefined
      let ingress: SharedTextureIngress
      try {
        ingress = support.bindings.open(host.pid, (event) => { if (record !== undefined) this.receive(record, event) })
      } catch (error) {
        return { supported: false, reason: `ingress-unavailable: ${errorOf(error).message}`, pid }
      }
      record = { pid: host.pid, bindings: support.bindings, ingress, failed: undefined, closing: undefined }
      this.ingress = record
    }
    return { supported: true, pid, hop: { addon: this.hopAddon }, ingress: { endpoint: this.ingress.ingress.endpoint } }
  }

  /**
   * Identify the adapter of Chromium's Windows compositor from one texture it exports, without involving the Host or
   * the ingress connection. The answer is kept until the GPU process generation changes; queries while a probe runs
   * share it, and a probe that finds no adapter or fails is not kept, so the next query probes again.
   * @param timeoutMs - Deadline for graphics initialization and the texture export of a new probe.
   * @returns The adapter's LUID text from {@link SharedTextureIngressBindings.adapterLuid}, or null outside Windows,
   *   without a Direct3D 11 compositor texture, when DXGI cannot read the adapter, or when a cleanup cancelled the
   *   probe; rejects when textures are unsupported.
   */
  private async adapterLuid(timeoutMs: number): Promise<string | null> {
    if (process.platform !== 'win32') return null
    const support = this.support()
    if ('reason' in support) throw new Error(`Desktop shared textures are unavailable: ${support.reason}`)
    if (this.adapter?.gpu === this.gpu) return this.adapter.luid
    if (this.adapterProbe?.gpu === this.gpu) return this.adapterProbe.result
    const gpu = this.gpu
    const controller = new AbortController()
    const result = this.readAdapter(gpu, timeoutMs, controller.signal, support.bindings).finally(() => {
      if (this.adapterProbe?.controller === controller) this.adapterProbe = undefined
    })
    this.adapterProbe = { gpu, controller, result }
    return result
  }

  /** Export one compositor texture, read its adapter, and release the texture and its window at once. */
  private async readAdapter(
    gpu: number, timeoutMs: number, signal: AbortSignal, bindings: SharedTextureIngressBindings,
  ): Promise<string | null> {
    const texture = await probeSharedTexture(timeoutMs, signal)
    if (texture === null) return null
    let luid: string | null
    try {
      luid = bindings.adapterLuid(texture.ntHandle)
    } finally {
      texture.release()
    }
    // A GPU process that exited during the probe may have left the adapter it reports.
    if (gpu !== this.gpu) return null
    if (luid !== null) this.adapter = { gpu, luid }
    return luid
  }

  /** A packaged build verifies the addon; a development build without a C++ toolchain reports the ingress unavailable. */
  private loaded(): { native: SharedTextureIngressBindings } | { error: Error } {
    if (this.bindings === undefined) {
      try { this.bindings = { native: this.loadIngress() } } catch (error) { this.bindings = { error: errorOf(error) } }
    }
    return this.bindings
  }

  private receive(record: OpenIngress, event: SharedTextureIngressEvent): void {
    switch (event.type) {
      case 'frame':
        this.frame(record, event)
        return
      case 'error': {
        record.failed = new Error(`Shared-texture ingress failed: ${event.text}`)
        // Sent textures still settle through Electron; their replies are dropped.
        void this.track(this.closeRecord(record)).catch((closeError: unknown) => {
          console.error('Shared-texture ingress teardown failed', closeError)
        })
        return
      }
      /* v8 ignore next -- The addon event union is exhausted above. */
      default: return assertNever(event)
    }
  }

  private reply(record: OpenIngress, requestId: number, reply: SharedTextureIngressReply): void {
    if (record.closing === undefined) record.ingress.reply(requestId, reply)
  }

  /**
   * Admit one frame or refuse it without keeping a reference. An admitted frame gets one delivery reply, then one
   * settlement reply, and its handle is released at settlement.
   */
  private frame(record: OpenIngress, event: FrameEvent): void {
    const { requestId, handle, width, height, pixelFormat, metadata } = event
    const refuse = (error: string): void => {
      record.bindings.release(handle)
      this.reply(record, requestId, { kind: 'failed', error, referenceKept: false })
    }
    if (record !== this.ingress) { refuse('Shared-texture ingress closed'); return }
    if (this.resetting !== undefined) { refuse('Shared textures are closing'); return }
    if (this.presenting >= MAX_PRESENTATIONS) { refuse('Shared-texture presentation limit reached'); return }
    const window = this.window()
    if (window === undefined || window.isDestroyed() || window.webContents.isDestroyed()) { refuse('Shared-texture window is unavailable'); return }
    this.presenting++
    let delivery: Promise<void> | undefined = undefined
    let early: SentSharedTextureSettlement | undefined
    const settle = (settlement: SentSharedTextureSettlement): void => {
      this.presenting--
      record.bindings.release(handle)
      if (delivery === undefined) { early = settlement; return }
      // A backend settles its delivery no later than the texture, so the settlement reply follows the delivery reply.
      void delivery.then(() => { this.reply(record, requestId, { kind: settlement }) })
    }
    let delivered: Promise<void>
    try {
      delivered = this.deliver(window, { width, height, pixelFormat, metadata }, nativeHandle(handle), settle)
    } catch (error) {
      // A backend that throws settled the texture as released first, so Main kept no reference.
      this.reply(record, requestId, { kind: 'failed', error: errorOf(error).message, referenceKept: false })
      return
    }
    delivery = delivered.then(
      () => { this.reply(record, requestId, { kind: 'delivered' }) },
      (error: unknown) => { this.reply(record, requestId, { kind: 'failed', error: errorOf(error).message, referenceKept: true }) },
    )
    if (early !== undefined) {
      const settlement = early
      void delivery.then(() => { this.reply(record, requestId, { kind: settlement }) })
    }
  }

  /**
   * Hand one admitted frame to its presentation backend, the product renderer.
   * @param window - Available product window.
   * @param frame - Pixel description and metadata text.
   * @param handle - Main-local handle; the caller keeps it until `settle` and releases it then.
   * @param settle - Called exactly once when every backend reference is gone (`released`) or unobservable (`invalidated`).
   * @returns Delivery: resolves once the backend holds the texture and rejects on delivery failure; it settles no later
   *   than `settle` is called. Throws only after calling `settle('released')`, when no reference remains.
   */
  private deliver(
    window: PresentationWindow, frame: PresentedFrame, handle: SharedTextureNativeHandle,
    settle: (settlement: SentSharedTextureSettlement) => void,
  ): Promise<void> {
    const receipt = ++this.nextReceipt
    const state = { settled: false }
    const { width, height, pixelFormat, metadata } = frame
    const texture = { handle, width, height, pixelFormat }
    const sent = sendSharedTexture(window.webContents.mainFrame, receipt, texture, metadata, (settlement) => {
      state.settled = true
      this.sent.delete(receipt)
      settle(settlement)
    })
    // Electron can release synchronously when sending fails.
    if (!state.settled) this.sent.set(receipt, sent)
    return sent.delivered
  }

  /**
   * The product renderer's import result for a texture Main sent.
   * @param id - Presentation identifier the renderer received with the texture.
   * @param result - The renderer's report; anything but a sync token or an error message counts as a failed import.
   */
  rendererImported(id: number, result: unknown): void {
    this.sent.get(id)?.imported(parseRendererImport(result))
  }

  /**
   * The product renderer released a texture Main sent, after the GPU work that used it completed.
   * @param id - Presentation identifier the renderer received with the texture.
   */
  rendererReleased(id: number): void {
    this.sent.get(id)?.released()
  }

  /**
   * Window-level cleanup after a committed cross-document navigation, renderer or GPU loss, or window closure: start a
   * new document generation, cancel a pending adapter probe, and settle textures sent to the previous document as
   * `invalidated`, since their renderer references are no longer observable. Frames that arrive meanwhile are refused.
   * The ingress lives with the Host process and stays open, so the Host keeps its connection.
   * @param options - What the cleanup follows; after a GPU process exit the compositor adapter is read again.
   * @returns Completion after pending operations settle.
   */
  reset(options: SharedTextureResetOptions = {}): Promise<void> {
    return this.settle(false, options.gpuProcessGone === true)
  }

  /** Host-level teardown: {@link reset}, forget the compositor adapter, and close the ingress; the next Host's capability
   * query opens a new one.
   * @returns Completion of ingress teardown.
   */
  dispose(): Promise<void> {
    return this.settle(true, true)
  }

  private closeRecord(record: OpenIngress): Promise<void> {
    return record.closing ??= record.ingress.close()
  }

  private async closeIngress(): Promise<void> {
    const record = this.ingress
    if (record === undefined) return
    this.ingress = undefined
    await this.closeRecord(record)
  }

  /** Requests reject while a cleanup runs; a cleanup started during another waits for it first. */
  private settle(closeIngress: boolean, newGpu: boolean): Promise<void> {
    const previous = this.resetting
    this.page++
    if (newGpu) {
      this.gpu++
      this.adapter = undefined
    }
    const run = (async () => {
      if (previous !== undefined) await previous.catch((_error: unknown) => {
        // The previous caller receives its failure; this cleanup must still release its resources.
      })
      this.adapterProbe?.controller.abort()
      for (const sent of [...this.sent.values()]) sent.abandon()
      if (closeIngress) await this.closeIngress()
      await Promise.allSettled([...this.operations])
    })()
    this.resetting = run
    return run.finally(() => { if (this.resetting === run) this.resetting = undefined })
  }
}
