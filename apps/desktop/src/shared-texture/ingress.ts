/**
 * Electron Main binding to the shared-texture ingress addon built from `apps/desktop/native/shared-texture`. The
 * ingress is Main's end of the native channel to the Desktop Host's hop addon: it receives each frame with a Main-local
 * texture handle and carries Main's delivery and settlement replies back without the Host IPC channel.
 */
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { assertNever } from '@deepseek-ai/dsh-util-values'

/** Ingress notifications, delivered on the JavaScript thread. */
export type SharedTextureIngressEvent =
  | {
    type: 'frame'
    /** The Host's request number; every reply for this frame carries it. */
    requestId: number
    /**
     * Main-local `IOSurfaceRef` on macOS or NT handle on Windows, eight bytes, owned by the receiver until
     * {@link SharedTextureIngressBindings.release}, which it calls exactly once.
     */
    handle: Buffer
    /** 1 to 8192. */
    width: number
    /** 1 to 8192. */
    height: number
    pixelFormat: 'bgra' | 'rgba'
    /** UTF-8 JSON text of at most 4096 bytes, or `''` when the Host sent none; the addon does not parse it. */
    metadata: string
  }
  /** Terminal failure; no event follows. */
  | { type: 'error'; text: string }

/**
 * Main's reply to one frame. `delivered` or `failed` answers delivery; `released` or `invalidated` follows a
 * `delivered`, or a `failed` whose `referenceKept` is true, exactly once. A `failed` with `referenceKept: false` means
 * Main kept no reference, so the Host treats the texture as released and expects no second reply.
 */
export type SharedTextureIngressReply =
  | { kind: 'delivered' }
  | { kind: 'failed'; error: string; referenceKept: boolean }
  | { kind: 'released' }
  | { kind: 'invalidated' }

/** One Host's ingress endpoint; closing stops delivery and releases handles JavaScript never received. */
export interface SharedTextureIngress {
  /** Endpoint name the Host's hop addon connects to. */
  readonly endpoint: string
  /**
   * Write a reply to the Host on the calling thread. It blocks for at most 100 ms while the Host is not reading, and a
   * reply that cannot be written in that time drops the Host connection, so later replies return at once; a reply
   * while no Host connection is open is dropped.
   * @param requestId - The frame's request number.
   * @param reply - Delivery or settlement result.
   */
  reply(requestId: number, reply: SharedTextureIngressReply): void
  /** Stop accepting frames; repeated calls return the same completion. @returns Completion after the endpoint is gone. */
  close(): Promise<void>
}

/** Operations of the loaded ingress addon. */
export interface SharedTextureIngressBindings {
  /**
   * Open an endpoint that accepts frames from one process.
   * @param peerPid - The Desktop Host; connections from any other process are refused and reception continues.
   * @param onEvent - Receives frames and the terminal error. At most 32 frames wait for the JavaScript thread; the
   *   addon releases a frame beyond them and replies `failed` with no reference kept, without an event.
   * @returns The open ingress.
   */
  open(peerPid: number, onEvent: (event: SharedTextureIngressEvent) => void): SharedTextureIngress
  /** Return a delivered frame handle; each delivered handle is released exactly once. */
  release(handle: Buffer): void
  /**
   * Windows: identify the adapter on which the shared resource behind a Main-local NT handle was created.
   * @param handle - Eight-byte NT handle, which the caller keeps.
   * @returns The adapter's LUID as `<HighPart>:<LowPart>`, each in lowercase hexadecimal without leading zeros and
   *   `HighPart` read as unsigned, such as `0:1234`; null when DXGI cannot identify the adapter, and always on macOS.
   */
  adapterLuid(handle: Buffer): string | null
}

/** Reply kinds on the native channel. */
const REPLY_KIND = { delivered: 1, failed: 2, released: 3, invalidated: 4 } as const

interface Addon {
  open(peerPid: number, onEvent: (event: SharedTextureIngressEvent) => void): { native: object; endpoint: string }
  reply(native: object, requestId: number, kind: 1 | 2 | 3 | 4, noReferenceKept: boolean, error: string): void
  release(handle: Buffer): void
  close(native: object): Promise<void>
  adapterLuid(handle: Buffer): string | null
}

/**
 * Locate the ingress addon the Desktop build places beside the main bundle.
 * @param appPath - `app.getAppPath()`.
 * @returns Path of `lib/native/<platform>-<arch>/shared-texture-ingress.node`; packaged builds load it from the unpacked archive.
 */
export function sharedTextureIngressAddonPath(appPath: string): string {
  return join(appPath, 'lib', 'native', `${process.platform}-${process.arch}`, 'shared-texture-ingress.node')
}

/**
 * Locate the hop addon the Desktop build places beside the main bundle; the Desktop Host loads it, not Main.
 * @param appPath - `app.getAppPath()`.
 * @returns Path of `lib/native/<platform>-<arch>/shared-texture-hop.node`; packaged builds load it from the unpacked archive.
 */
export function sharedTextureHopAddonPath(appPath: string): string {
  return join(appPath, 'lib', 'native', `${process.platform}-${process.arch}`, 'shared-texture-hop.node')
}

/**
 * Load the ingress addon once.
 * @param path - Addon file from {@link sharedTextureIngressAddonPath}.
 * @returns Ingress operations; throws when the addon is absent or built for another platform.
 */
export function loadSharedTextureIngressBindings(path: string): SharedTextureIngressBindings {
  const addon = createRequire(import.meta.url)(path) as Addon
  return {
    open(peerPid, onEvent) {
      const { native, endpoint } = addon.open(peerPid, onEvent)
      let closed: Promise<void> | undefined
      return {
        endpoint,
        reply(requestId, reply) {
          switch (reply.kind) {
            case 'delivered':
            case 'released':
            case 'invalidated':
              addon.reply(native, requestId, REPLY_KIND[reply.kind], false, '')
              return
            case 'failed':
              addon.reply(native, requestId, REPLY_KIND.failed, !reply.referenceKept, reply.error)
              return
            /* v8 ignore next -- The reply union is exhausted above. */
            default: assertNever(reply)
          }
        },
        close: () => closed ??= addon.close(native),
      }
    },
    release(handle) { addon.release(handle) },
    adapterLuid: handle => addon.adapterLuid(handle),
  }
}
