/**
 * Electron Main ownership of a native texture until the product renderer and the GPU have finished with it. Desktop
 * carries the texture over its own IPC with Electron's `sharedTexture.subtle` operations rather than
 * `sendSharedTexture`, whose 1000 ms acknowledgement deadline lets Main drop a texture a busy renderer still imports
 * ([`sharedTexture`](https://www.electronjs.org/docs/latest/api/shared-texture)).
 */
import { sharedTexture, type WebFrameMain } from 'electron'
import { DESKTOP_IPC } from '../ipc.ts'

/** Main-local texture handle in Electron's platform form. */
export type SharedTextureNativeHandle = { ioSurface: Buffer } | { ntHandle: Buffer }

/** Main → product renderer message on `DESKTOP_IPC.sharedTexture`. */
export interface SharedTextureTransferMessage {
  /** Presentation identifier the renderer echoes in its import result and release. */
  readonly id: number
  readonly transfer: Electron.SharedTextureTransfer
  /** The Host's metadata as the UTF-8 JSON text it sent, or `''` for none; the product preload parses it. */
  readonly metadata: string
}

/** The renderer's import result on `DESKTOP_IPC.sharedTextureImported`: its reference's creation sync token, or why it has none. */
export type SharedTextureRendererImport = Electron.SharedTextureSyncToken | { readonly error: string; readonly invalidated?: true }

/** How one sent texture ended: every reference observed released, or its document gone first. */
export type SentSharedTextureSettlement = 'released' | 'invalidated'

/** One texture Main sent to the product renderer. */
export interface SentSharedTexture {
  /** Resolves once the renderer holds its own reference; rejects when its import failed or {@link abandon} ran first. */
  readonly delivered: Promise<void>
  /**
   * Apply the renderer's import result; Main then drops its own reference. Only the first result counts.
   * @param result - The renderer's report.
   */
  imported(result: SharedTextureRendererImport): void
  /** The renderer released its reference after the GPU work that used it completed. */
  released(): void
  /**
   * The document is gone: settle as `invalidated` at once unless already settled, drop Main's reference, and ignore
   * the renderer's later messages.
   */
  abandon(): void
}

/**
 * Import one texture and send it to a renderer frame. The caller validates the recipient. Main keeps its reference
 * until the renderer reports its own, however long the renderer is busy, so the renderer never imports a released
 * texture; renderer messages arrive through the returned object.
 * @param frame - Authorized renderer frame.
 * @param id - Presentation identifier the renderer echoes.
 * @param texture - Main-local handle and pixel description.
 * @param metadata - Host metadata text forwarded unparsed to the renderer.
 * @param settle - Called exactly once: `released` after Main's and the renderer's references are gone and the GPU work
 *   that used them has completed, where a failed import or send and a failed renderer import count the renderer's
 *   reference as gone; `invalidated` when GPU synchronization fails or {@link SentSharedTexture.abandon} runs first.
 * @returns The sent texture, whose `delivered` rejects when Electron cannot send it; throws when Electron cannot import
 *   it. A texture Electron imported is returned in every case, so its caller can abandon it until Main's reference is
 *   gone.
 */
export function sendSharedTexture(
  frame: WebFrameMain,
  id: number,
  texture: { handle: SharedTextureNativeHandle; width: number; height: number; pixelFormat: 'bgra' | 'rgba' },
  metadata: string,
  settle: (settlement: SentSharedTextureSettlement) => void,
): SentSharedTexture {
  let main: Electron.SharedTextureImportedSubtle | undefined
  try {
    // Electron duplicates an NT handle and retains an IOSurface on import, so the caller still owns the handle it passed.
    main = sharedTexture.subtle.importSharedTexture({
      handle: texture.handle,
      pixelFormat: texture.pixelFormat,
      codedSize: { width: texture.width, height: texture.height },
      colorSpace: { primaries: 'bt709', transfer: 'srgb', matrix: 'rgb', range: 'full' },
    })
  } catch (error) {
    settle('released')
    throw error
  }
  const delivery = Promise.withResolvers<void>()
  let mainReleased = false
  let rendererReleased = false
  let settled = false
  let finished = false
  const finish = (): void => {
    if (finished || !mainReleased || !rendererReleased) return
    finished = true
    settle('released')
  }
  const releaseMain = (): void => {
    const reference = main
    if (reference === undefined) return
    main = undefined
    reference.release(() => {
      mainReleased = true
      finish()
    })
  }
  const releaseRenderer = (): void => {
    rendererReleased = true
    finish()
  }
  const sent: SentSharedTexture = {
    delivered: delivery.promise,
    imported(result) {
      if (settled) return
      settled = true
      if ('syncToken' in result) {
        try {
          main?.setReleaseSyncToken(result)
        } catch (error) {
          delivery.reject(error)
          sent.abandon()
          return
        }
        releaseMain()
        delivery.resolve()
        return
      }
      if (result.invalidated) {
        delivery.reject(new Error(result.error))
        sent.abandon()
        return
      }
      releaseMain()
      releaseRenderer()
      delivery.reject(new Error(`The product renderer could not import the shared texture: ${result.error}`))
    },
    released: releaseRenderer,
    abandon() {
      // The renderer's reference died with its document or process, or survives unobserved; either way it will not be
      // reported, so the texture is never counted as released.
      if (!finished) {
        finished = true
        settle('invalidated')
      }
      releaseMain()
      if (settled) return
      settled = true
      delivery.reject(new Error('The product document closed before importing the shared texture'))
    },
  }
  try {
    const message: SharedTextureTransferMessage = { id, transfer: main.startTransferSharedTexture(), metadata }
    frame.send(DESKTOP_IPC.sharedTexture, message)
  } catch (error) {
    settled = true
    releaseMain()
    releaseRenderer()
    delivery.reject(error)
  }
  return sent
}
