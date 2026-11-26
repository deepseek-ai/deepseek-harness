/**
 * Types Electron Main compiles against for the exchanges it runs with this Host process. The shared-texture control
 * messages are the first: they are the only traffic the child-process channel carries for textures, because frames,
 * their delivery replies, and their settlements travel on the hop addon's native connection. Neither side trusts the
 * other: each validates every message it receives at runtime, so this module only keeps one declaration of a message
 * set. It is not a plugin API: plugins use `ctx.sharedTexture` from `@deepseek-ai/dsh-shared-texture`.
 */
import type { SharedTextureCapabilities } from '@deepseek-ai/dsh-shared-texture'

/** Host control request; Main validates every field before Electron or native work. */
export type SharedTextureHostRequest =
  | { op: 'capabilities' }
  | {
    /** Main replies with the LUID text of Chromium's compositor adapter or null; see `SharedTextureService.adapterLuid`. */
    op: 'adapter-luid'
    /** Deadline in milliseconds for exporting the compositor texture whose adapter Main reads. */
    timeoutMs: number
  }

/** Main's capabilities: what the `sharedTexture` service reports, plus what the Host needs to reach Main. */
export interface SharedTextureMainCapabilities extends SharedTextureCapabilities {
  /** Electron main process. */
  pid: number
  /** Hop addon the Desktop Host loads; present on macOS and Windows whenever textures are supported. */
  hop?: { addon: string }
  /**
   * Ingress endpoint the hop connects to; it accepts the requesting Host process only and lives as long as that
   * process. Present on macOS and Windows whenever textures are supported.
   */
  ingress?: { endpoint: string }
}

/** Host → Main message on the Desktop Host child-process channel; `requestId` is a positive safe integer unique per Host. */
export interface SharedTextureHostMessage {
  type: 'shared-texture'
  requestId: number
  request: SharedTextureHostRequest
}

/** Main → Host reply correlated by `requestId`; exactly one of `value` and `error` is present. */
export interface SharedTextureMainReply {
  type: 'shared-texture'
  requestId: number
  value?: unknown
  error?: string
}
