/** Type-only Electron update declarations shared by the settings UI and Desktop compatibility checks. */

/** Classified failure copy selected by the Web locale without exposing raw updater diagnostics. */
export type DesktopUpdateFailureKind =
  | 'configuration'
  | 'check'
  | 'check-network'
  | 'download'
  | 'download-network'
  | 'download-space'
  | 'download-permission'
  | 'download-busy'
  | 'install'
  | 'install-network'
  | 'stop-failed'
  | 'tasks-changed'
  | 'tasks-unavailable'
  | 'fullscreen-timeout'

/** Public semantic preload fields consumed by the settings row. */
export interface DesktopUpdatePresentation {
  readonly phase: 'idle' | 'checking' | 'available' | 'downloading' | 'verifying' | 'installing' | 'ready' | 'error'
  readonly version?: string
  readonly percent?: number
  readonly failure?: DesktopUpdateFailureKind
  readonly configurationError?: DesktopChannelState['error']
}

/** Optional carrier API; it cannot select artifacts or authorize installation. */
export interface DesktopUpdateBridge {
  readonly channels?: DesktopChannelBridge
  status(): Promise<DesktopUpdatePresentation>
  open(): Promise<void>
  subscribe(listener: (state: DesktopUpdatePresentation) => void): () => void
}

/** Shared carrier status for the account row and collapsed sidebar badge. */
export interface DesktopUpdateView {
  readonly presentation?: DesktopUpdatePresentation
  readonly failed: boolean
  readonly opening: boolean
}

/** Shell-owned channel choices exposed through the isolated preload. */
export type DesktopUpdateChannel = 'nightly' | 'stable'

/** Current runtime selection and application status; failure never implies a successful switch. */
export interface DesktopChannelState {
  readonly channel: DesktopUpdateChannel | null
  readonly packagedChannel: DesktopUpdateChannel
  readonly changing: boolean
  readonly error?: 'read' | 'format' | 'channel' | 'cleanup'
}

/** Outcome of one UI action; failures are not global updater state. */
export type DesktopChannelChangeResult =
  | { readonly kind: 'applied' | 'unchanged'; readonly state: DesktopChannelState }
  | { readonly kind: 'failed'; readonly state: DesktopChannelState; readonly reason: 'save' | 'format' | 'permission' | 'apply' | 'uncertain' }

/** UI choices persist in the shell configuration, independently of Host settings. */
export interface DesktopChannelBridge {
  /** @returns Current shell selection and application status, without reading disk again. */
  get(): Promise<DesktopChannelState>
  /**
   * @param channel - Explicit user choice to persist and apply.
   * @returns The resulting selection or failure; it does not authorize installation.
   */
  set(channel: DesktopUpdateChannel): Promise<DesktopChannelChangeResult>
  /**
   * @param listener - Receives changes made from any Desktop window.
   * @returns Removes this window's subscription.
   */
  subscribe(listener: (state: DesktopChannelState) => void): () => void
}
