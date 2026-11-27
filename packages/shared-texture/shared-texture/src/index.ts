/**
 * Service Definition for the Host `ctx.sharedTexture` capability seam: an exclusive claim that submits GPU-backed
 * frames from a Host process to its presentation host.
 * @module @deepseek-ai/dsh-shared-texture
 */
import { Context, Service } from '@deepseek-ai/cordis'

/** Whether the presentation host presents shared textures; a reason accompanies `false`. */
export interface SharedTextureCapabilities {
  supported: boolean
  reason?: string
}

/**
 * Opaque native object through which a native addon in the Host process submits frames to the presentation host;
 * JavaScript only passes it to that addon. It points to the `dsh_shared_texture_sink_v2` function table, whose
 * contract `apps/desktop/native/shared-texture/shared-texture-sink.h` states. A frame carries a Host-local
 * `IOSurfaceRef` or NT handle that its owner keeps valid until the frame settles. Each frame that left the Host gets
 * one delivery result and then one settlement: released, after which the texture may be written again, or invalidated,
 * after which it must not, because the presentation host lost the document, renderer, GPU process, channel, or GPU
 * synchronization before observing the release. One connection admits 128 unsettled frames.
 */
export interface SharedTextureNativeSink {
  readonly __sharedTextureNativeSink: unique symbol
}

/**
 * Host texture presentation that a claim of `ctx.sharedTexture` grants. The consumer never touches Mach ports, Win32
 * handle transfer, the native channel, or Electron.
 */
export interface SharedTextureService {
  /**
   * Ask the presentation host whether it presents shared textures now. Support ends when Chromium stops compositing on
   * the GPU, for example after repeated GPU process crashes, so a consumer asks again before relying on it after a
   * loss.
   * @param timeoutMs - Deadline in milliseconds for the reply.
   * @returns Shared-texture support of the running presentation host.
   */
  capabilities(timeoutMs: number): Promise<SharedTextureCapabilities>
  /**
   * Connect if needed and return the native object of the current connection, through which a native addon in this
   * process submits frames. The connection is reused until it is lost. The object belongs to that connection: once the
   * connection is lost every submission through it returns `DSH_SHARED_TEXTURE_PRESENT_DISCONNECTED`, and the caller
   * requests a new one; a submission refused with `DSH_SHARED_TEXTURE_PRESENT_REJECTED` leaves it usable. When the
   * claim ends, the provider closes a connection whose object it handed out, invalidating that connection's unsettled
   * frames.
   * @param timeoutMs - Deadline in milliseconds for the capability reply.
   * @returns The connection's native submission object; rejects when the presentation host does not present shared
   *   textures.
   */
  nativeSink(timeoutMs: number): Promise<SharedTextureNativeSink>
  /**
   * Identify the adapter on which Chromium's Windows compositor renders, so a producer can create its textures there.
   * The provider exports one compositor texture, reads its adapter, and releases it at once; it keeps the answer until
   * Chromium's GPU process exits or the Host stops, and concurrent queries share one reading. Elsewhere this returns
   * null without asking, and it never opens the native connection.
   * @param timeoutMs - Deadline in milliseconds for the reply, which includes exporting the texture.
   * @returns The adapter's LUID as `<HighPart>:<LowPart>`, each in lowercase hexadecimal without leading zeros and
   *   `HighPart` read as unsigned, such as `0:1234`. Null outside Windows, and on Windows when Chromium exports no
   *   Direct3D 11 compositor texture, its adapter cannot be read, or a cleanup cancelled the reading; on Windows,
   *   rejects when the presentation host does not present shared textures.
   */
  adapterLuid(timeoutMs: number): Promise<string | null>
}

/** Exclusive claim on `ctx.sharedTexture`, valid until {@link release} or disposal of the claiming scope. */
export interface SharedTextureClaim extends SharedTextureService {
  /** End the claim before its scope is disposed; repeated calls and the later disposal do nothing. */
  release(): void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Absolute path to the receiver addon preinstalled by Desktop for this Host. */
    desktopFrameReceiver: { readonly path: string }
    /**
     * Host shared-texture service; absent in Hosts that do not present shared textures, so read it with
     * `ctx.get('sharedTexture')`. One consumer holds a claim at a time.
     */
    sharedTexture: SharedTexture
  }
}

/**
 * Abstract Host shared-texture service registered as `ctx.sharedTexture`. Subclasses own exclusive-claim concurrency
 * control and the underlying native transport.
 */
export abstract class SharedTexture extends Service {
  constructor(ctx: Context) {
    super(ctx, 'sharedTexture')
  }

  /**
   * Take the only claim for the calling scope. The claim ends at `release` or when that scope is disposed, whichever
   * comes first; afterwards its operations reject, and the frames of a connection whose
   * {@link SharedTextureService.nativeSink} the claim took settle as invalidated.
   * @returns The texture operations until the claim ends; throws while another claim is held or when the calling scope
   *   is inactive.
   */
  abstract claim(): SharedTextureClaim
}

/**
 * Host Loader entry, which does nothing: the Loader mounts this package only to deliver its Client half, and the
 * presentation host, such as Desktop Host, provides the Host `ctx.sharedTexture` by subclassing {@link SharedTexture}.
 */
export function apply(): void {}
