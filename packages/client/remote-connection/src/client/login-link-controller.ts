/** In-memory login link and clipboard outcomes, independent of the QR invitation. */
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { TypertClientRemote } from '@deepseek-ai/dsh-typert-protocol'

/** Link readiness and clipboard feedback; credentials must never be persisted or logged. */
export interface LoginLinkState {
  /** Tokenized address displayed by the settings panel and used for explicit clipboard writes. */
  url: string | null
  /** Credential-read or clipboard activity; failed reads leave the clean address copyable. */
  phase: 'loading' | 'ready' | 'copying' | 'error'
  /** Whether the credential warning is enabled for the current Remote connection settings visit. */
  copied: boolean
  /** Transient clipboard outcome presented by the shell overlay. */
  notice: 'linkCopied' | 'copyFailed' | null
  /** Identity of the latest notice; older toast completion cannot dismiss it. */
  sequence: number
}

/** Link actions and private state bound by the slot renderer. */
export interface LoginLinkFace {
  /** Copy the credential link or clean access address without changing a QR invitation. */
  copyLink: () => void
  /** Retry a failed login-link read. */
  reloadLink: () => void
  /** Retire the specified clipboard notice. */
  dismissCopyNotice: (sequence: number) => void
  /** Shared source for the settings panel and the longer-lived shell toast. */
  hooks: { loginLink: SnapshotStore<LoginLinkState> }
}

/** Owns credential reads and clipboard writes; disposal drains them and discards late results. */
export class LoginLinkController {
  /** In-memory credential and feedback, cleared when the plugin unloads. */
  readonly store = createSnapshotStore<LoginLinkState>({ url: null, phase: 'loading', copied: false, notice: null, sequence: 0 })
  private live = true
  private loading: Promise<void> | undefined
  private copying: Promise<void> | undefined
  private readGeneration = 0
  private warningGeneration = 0
  private readonly pending = new Set<Promise<void>>()

  /**
   * @param remote - owner-authenticated login-link reader.
   * @param write - clipboard writer returning true only after a successful write.
   * @param accessAddress - current clean address, or null before an address has been read.
   * @param canCopyCredential - whether the current deployment permits copying a credential link.
   */
  constructor(
    private readonly remote: Pick<TypertClientRemote['remoteConnection'], 'loginUrl'>,
    private readonly write: (text: string) => Promise<boolean>,
    private readonly accessAddress: () => string | null,
    private readonly canCopyCredential: () => boolean,
  ) {}

  /**
   * Bind stable actions and the shared feedback source.
   * @returns settings and shell-overlay injection values.
   */
  inject(): LoginLinkFace {
    return {
      copyLink: () => { void this.copy() },
      reloadLink: () => { void this.load() },
      dismissCopyNotice: (sequence) => {
        if (this.store.getSnapshot().sequence === sequence) this.store.update((state) => { state.notice = null })
      },
      hooks: { loginLink: this.store },
    }
  }

  /**
   * Read the login link before a copy gesture so HTTP clipboard fallback keeps user activation.
   * @returns after the read settles; duplicate reads share it, and a refresh waits for a clipboard write.
   */
  load(): Promise<void> {
    if (!this.live || !this.canCopyCredential()) return Promise.resolve()
    if (this.copying !== undefined) return this.track(this.copying.then(() => this.load()))
    if (this.loading !== undefined) return this.loading
    const previousUrl = this.store.getSnapshot().url
    this.store.update((state) => { state.phase = 'loading'; state.url = null; state.notice = null })
    const generation = this.readGeneration
    this.loading = this.track(this.read(previousUrl, generation).finally(() => {
      if (this.readGeneration === generation) this.loading = undefined
    }))
    return this.loading
  }

  /** Discard the previous deployment's credential and its outstanding read when the login address changes. */
  invalidate(): void {
    this.readGeneration += 1
    this.warningGeneration += 1
    this.loading = undefined
    this.store.update((state) => {
      state.url = null
      state.copied = false
      state.notice = null
      state.phase = this.copying === undefined ? 'ready' : 'copying'
    })
  }

  /** Clear the page's credential warning without discarding clipboard outcomes or the cached URL. */
  resetCopyWarning(): void {
    this.warningGeneration += 1
    this.store.update((state) => { state.copied = false })
  }

  /**
   * Copy the cached credential or current clean address directly from the user's gesture.
   * @returns after clipboard completion; overlapping gestures share the write, and failures remain retryable.
   */
  copy(): Promise<void> {
    if (!this.live) return Promise.resolve()
    if (this.copying !== undefined) return this.copying
    const credentialUrl = this.canCopyCredential() ? this.store.getSnapshot().url : null
    const url = credentialUrl ?? this.accessAddress()
    if (url === null) return Promise.resolve()
    const warningGeneration = this.warningGeneration
    const completion = Promise.withResolvers<void>()
    this.copying = this.track(completion.promise.finally(() => { this.copying = undefined }))
    this.store.update((state) => { state.phase = 'copying'; state.notice = null })
    void this.writeLink(url, credentialUrl !== null, warningGeneration).then(completion.resolve, completion.reject)
    return this.copying
  }

  /**
   * Discard the credential, stop new work, and ignore late results.
   * @returns after all admitted reads, clipboard writes, and queued refreshes settle.
   */
  async dispose(): Promise<void> {
    this.live = false
    this.store.update((state) => { state.url = null; state.notice = null; state.copied = false })
    await Promise.all(this.pending)
  }

  private track(operation: Promise<void>): Promise<void> {
    this.pending.add(operation)
    void operation.finally(() => { this.pending.delete(operation) })
    return operation
  }

  private async writeLink(url: string, credential: boolean, warningGeneration: number): Promise<void> {
    let copied: boolean
    try { copied = await this.write(url) } catch (_clipboardFailure) { copied = false }
    if (!this.active()) return
    this.store.update((state) => {
      state.phase = 'ready'
      state.copied ||= copied && credential && state.url === url && this.warningGeneration === warningGeneration
      state.notice = copied ? 'linkCopied' : 'copyFailed'
      state.sequence += 1
    })
  }

  private async read(previousUrl: string | null, generation: number): Promise<void> {
    try {
      const result = await this.remote.loginUrl()
      if (!this.live || this.readGeneration !== generation) return
      this.store.update((state) => {
        state.url = result.ok ? result.value : null
        state.phase = this.copying !== undefined ? 'copying' : result.ok ? 'ready' : 'error'
        if (state.url !== previousUrl) state.copied = false
      })
    } catch (_requestFailure) {
      if (this.live && this.readGeneration === generation) this.store.update((state) => {
        state.phase = this.copying !== undefined ? 'copying' : 'error'
        state.copied = false
      })
    }
  }

  private active(): boolean { return this.live }
}
