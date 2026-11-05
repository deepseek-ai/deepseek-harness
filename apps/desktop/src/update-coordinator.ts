/** User-authorized downloads and separate installation of one version-bound Desktop release. */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import electronUpdater, { type AppUpdater, type ProgressInfo, type UpdateInfo, type UpdateCheckResult } from 'electron-updater'
import { gt, valid } from 'semver'
import type { DesktopUpdateState } from './ipc.ts'
import { DesktopUpdateHttpExecutor } from './updates/electron-updater/http-executor.ts'
import { DesktopUpdatePreparationError, downloadFailureDetails } from './update-error.ts'
import type { DesktopUpdateChannel } from './update-channel.ts'
import { selectUpdateChannel } from './updates/electron-updater/channel.ts'
import { discardDesktopUpdate } from './updates/electron-updater/discard.ts'

const { autoUpdater } = electronUpdater

/** Owns one updater target until its download and installation settle. */
export class DesktopUpdateCoordinator {
  private current: DesktopUpdateState = { phase: 'idle' }
  private release: { kind: 'none' } | { kind: 'checked' | 'downloaded' | 'handed-off'; version: string } = { kind: 'none' }
  private disposed = false
  private generation = 0
  private switching = 0
  private downloadGeneration = 0
  private switchTail: Promise<void> = Promise.resolve()
  private cancellation: UpdateCheckResult['cancellationToken']
  private configurationError: 'startup' | 'cleanup' | undefined
  private checkOperation: Promise<DesktopUpdateState> | undefined
  private downloadOperation: Promise<DesktopUpdateState> | undefined
  private installOperation: Promise<DesktopUpdateState> | undefined

  private readonly onProgress = (progress: ProgressInfo): void => {
    if (this.downloadGeneration !== this.generation || this.downloadOperation === undefined || this.downloaded) return
    const percent = Math.min(100, Math.max(0, progress.percent))
    this.setState({ phase: percent >= 100 ? 'verifying' : 'downloading', ...this.target(), percent })
  }

  private readonly onDownloaded = (info: UpdateInfo): void => {
    if (this.downloadGeneration !== this.generation || this.downloadOperation === undefined || info.version !== this.candidate) return
    this.release = { kind: 'downloaded', version: info.version }
  }

  private readonly onError = (error: Error): void => {
    // Check/download promises own their failures. Installation can fail after quitAndInstall returns.
    if (this.current.phase === 'installing') {
      this.setState(this.failure(error, 'install'))
    }
  }

  /**
   * @param publish - Receives observable states for every Desktop window.
   * @param beforeRestart - Completes task authorization, admission locking, and owned-process shutdown.
   * @param updater - Process-owned Electron updater, replaceable at the network/platform test boundary.
   * @param enabled - Whether this process has a packaged update source.
   * @param currentVersion - Actual installed application version.
   * @param channel - Installed package channel; omitted test/local callers retain nightly.
   * @param discard - Clears settled library targets and platform resources before another channel is used.
   * @param downloadResult - Once per completed download attempt, including platform preparation failures.
   */
  constructor(
    private readonly publish: (state: DesktopUpdateState) => DesktopUpdateState,
    private readonly beforeRestart: () => Promise<boolean>,
    private readonly updater: AppUpdater = autoUpdater,
    private readonly enabled: () => boolean = () => app.isPackaged && existsSync(join(process.resourcesPath, 'app-update.yml')),
    private readonly currentVersion: () => string = () => app.getVersion(),
    private readonly downloadResult?: (success: boolean, reason?: string) => void,
    private channel: DesktopUpdateChannel = 'nightly',
    private readonly discard: (updater: AppUpdater) => Promise<void> = discardDesktopUpdate,
  ) {
    if (updater === autoUpdater) {
      // electron-updater omits this internal transport property from its public declarations.
      // Real-Electron qualification exercises the pinned dependency integration.
      const transportOwner = updater as AppUpdater & { httpExecutor: DesktopUpdateHttpExecutor }
      transportOwner.httpExecutor = new DesktopUpdateHttpExecutor(
        Number(process.env.DSH_DESKTOP_UPDATE_HTTP_IDLE_TIMEOUT_MS ?? 60_000),
        (authInfo, callback) => { updater.emit('login', authInfo, callback) },
      )
    }
    this.updater.autoDownload = false
    this.updater.autoInstallOnAppQuit = false
    selectUpdateChannel(this.updater, channel)
    this.updater.on('download-progress', this.onProgress)
    this.updater.on('update-downloaded', this.onDownloaded)
    this.updater.on('error', this.onError)
  }

  /** Latest observable state; complete download identity remains main-process-owned. */
  get state(): DesktopUpdateState { return this.current }

  /** Reason ordinary updates are suspended, independently of the last operation result. */
  get configurationFailure(): 'startup' | 'cleanup' | undefined { return this.configurationError }

  /** Selected runtime channel, including while a new feed is being checked. */
  get selectedChannel(): DesktopUpdateChannel { return this.channel }

  /** Revision captured by confirmations so channel changes invalidate old user actions. */
  get revision(): number { return this.generation }

  /**
   * Suspend ordinary updates when settings or previous-target cleanup are invalid.
   * @param detail - File path and safe diagnostic, without document contents.
   * @param reason - Startup validation or retirement of a previous target.
   */
  suspendConfiguration(detail: string, reason: 'startup' | 'cleanup' = 'startup'): void {
    this.configurationError = reason
    this.setState({ phase: 'error', failedOperation: 'configuration', message: detail })
  }

  /**
   * Persist a UI choice, retire the old target, and check the selected feed.
   * Accepted choices serialize; installation cannot start while any choice is pending.
   * Persistence failure leaves the previous channel and target intact. Cleanup failure
   * suspends updates until another explicit switch successfully retires the target.
   * @param channel - Validated UI choice.
   * @param persist - Atomic settings save; rejects before a choice is applied on failure.
   * @returns Whether the selection changed; healthy repeated choices preserve the current operation.
   */
  switchChannel(channel: DesktopUpdateChannel, persist: () => Promise<void>): Promise<'applied' | 'unchanged'> {
    this.assertLive()
    if (this.installOperation !== undefined || this.current.phase === 'installing' || this.release.kind === 'handed-off') {
      return Promise.reject(new Error('desktop update: installation is in progress'))
    }
    this.switching++
    const operation = this.switchTail.then(async () => {
      this.assertLive()
      if (channel === this.channel && this.configurationError === undefined) return 'unchanged' as const
      await persist()
      this.generation++
      this.cancellation?.cancel()
      await Promise.allSettled([this.checkOperation, this.downloadOperation])
      this.assertLive()
      this.release = { kind: 'none' }
      this.cancellation = undefined
      try { await this.discard(this.updater) } catch (error) {
        this.suspendConfiguration('desktop update: could not retire the previous update', 'cleanup')
        throw error
      }
      this.channel = channel
      selectUpdateChannel(this.updater, channel)
      this.configurationError = undefined
      this.setState({ phase: 'checking' })
      const result = await this.doCheck()
      if (result.phase === 'error') this.setState(result)
      return 'applied' as const
    }).finally(() => { this.switching-- })
    this.switchTail = operation.then(() => {}).catch(() => { /* The caller reports this selection's failure; later choices may retry. */ })
    return operation
  }

  /**
   * Check metadata without downloading, joining any current check.
   * @param manual - Whether a failed check must remain visible in the status indicator.
   * @returns The check result, including a silent automatic failure when applicable.
   */
  async check(manual = false): Promise<DesktopUpdateState> {
    this.assertLive()
    if (this.configurationError !== undefined || this.switching > 0
      || this.downloadOperation !== undefined || this.installOperation !== undefined || this.downloaded) return this.current
    if (!manual && this.current.phase === 'error' && this.current.failedOperation === 'download') return this.current
    this.checkOperation ??= Promise.resolve().then(() => this.doCheck())
      .finally(() => { this.checkOperation = undefined })
    const result = await this.checkOperation
    if (manual && result.phase === 'error') this.setState(result)
    return result
  }

  /**
   * @param version - Version shown in the user's download confirmation.
   * @param revision - Revision captured by the download confirmation; omitted uses the current target.
   * @returns Download readiness or failure, without authorizing installation.
   */
  async download(version: string, revision = this.generation): Promise<DesktopUpdateState> {
    this.assertLive()
    if (revision !== this.generation || this.configurationError !== undefined || this.switching > 0) return this.current
    if (this.downloaded || this.installOperation !== undefined) return this.current
    const generation = this.generation
    this.downloadGeneration = generation
    this.downloadOperation ??= Promise.resolve().then(async () => {
      await this.checkOperation
      if (generation !== this.generation) return this.current
      this.assertLive()
      if (this.candidate === undefined) throw new Error('desktop update: no checked update is available')
      if (version !== this.candidate) throw new Error('desktop update: download confirmation is stale')
      this.setState({ phase: 'downloading', version, percent: 0 })
      try {
        await this.updater.downloadUpdate(this.cancellation)
        if (generation !== this.generation || this.disposed) return this.current
        if (!this.downloaded) throw new Error('desktop update: platform preparation did not report readiness')
        this.downloadResult?.(true)
        return this.setState({ phase: 'ready', version })
      } catch (error) {
        if (generation !== this.generation || this.disposed) return this.current
        this.release = { kind: 'checked', version }
        this.downloadResult?.(false, error instanceof DesktopUpdatePreparationError ? error.kind : 'download_failed')
        return this.setState(this.failure(error, 'download'))
      }
    }).finally(() => { this.downloadOperation = undefined })
    return this.downloadOperation
  }

  /**
   * Install a prepared target after a separate user confirmation.
   * @param version - Exact version displayed in the confirmation, never a renderer-selected URL.
   * @param revision - Revision captured when the confirmation began; omitted uses the current target.
   * @returns Installation handoff or a recoverable preparation error.
   */
  async install(version: string, revision = this.generation): Promise<DesktopUpdateState> {
    this.assertLive()
    if (revision !== this.generation) return this.current
    if (this.configurationError !== undefined || this.switching > 0) throw new Error('desktop update: channel selection is not ready')
    if (!this.downloaded || this.downloadOperation !== undefined || version !== this.candidate) throw new Error('desktop update: confirmed target is not ready')
    this.installOperation ??= Promise.resolve().then(async () => {
      this.setState({ phase: 'installing', version })
      try {
        if (!await this.beforeRestart()) return this.setState({ phase: 'ready', version })
        this.assertLive()
        this.release = { kind: 'handed-off', version }
        this.updater.quitAndInstall(true, true)
        return this.current
      } catch (error) {
        if (this.current.phase === 'error' && this.current.failedOperation === 'install') return this.current
        return this.setState(this.failure(error, 'install'))
      }
    }).finally(() => { this.installOperation = undefined })
    return this.installOperation
  }

  /** Remove owned listeners and prevent pending library operations from publishing into closed UI. */
  dispose(): void {
    this.disposed = true
    this.updater.off('download-progress', this.onProgress)
    this.updater.off('update-downloaded', this.onDownloaded)
    // Pending updater promises can still emit EventEmitter errors during shutdown.
    void Promise.allSettled([this.checkOperation, this.downloadOperation, this.installOperation, this.switchTail])
      .then(() => { this.updater.off('error', this.onError) })
  }

  private get candidate(): string | undefined { return this.release.kind === 'none' ? undefined : this.release.version }

  private get downloaded(): boolean { return this.release.kind === 'downloaded' || this.release.kind === 'handed-off' }

  private assertLive(): void {
    if (this.disposed) throw new Error('desktop update: coordinator is disposed')
  }

  private setState(state: DesktopUpdateState): DesktopUpdateState {
    if (!this.disposed) {
      this.current = state
      this.publish(state)
    }
    return state
  }

  private failure(error: unknown, failedOperation: 'check' | 'download' | 'install'): DesktopUpdateState {
    return { phase: 'error', ...this.target(), failedOperation,
      message: error instanceof Error ? error.message : String(error),
      ...(failedOperation === 'download' ? downloadFailureDetails(error) : {}),
      ...(error instanceof DesktopUpdatePreparationError ? {
        preparationFailure: error.kind,
        ...(error.technicalDetails === undefined ? {} : { technicalDetails: error.technicalDetails }),
      } : {}) }
  }

  private target(): { version?: string } {
    return this.candidate === undefined ? {} : { version: this.candidate }
  }

  private async doCheck(): Promise<DesktopUpdateState> {
    const generation = this.generation
    try {
      this.assertLive()
      if (!this.enabled()) throw new Error('desktop update: this application has no packaged update source')
      const result = await this.updater.checkForUpdates()
      if (generation !== this.generation || this.disposed) return this.current
      if (result === null) throw new Error('desktop update: no check result was returned')
      this.cancellation = result.cancellationToken
      const version = result.updateInfo.version
      if (valid(version) === null) throw new Error('desktop update: feed version is invalid')
      this.release = result.isUpdateAvailable && gt(version, this.currentVersion())
        ? { kind: 'checked', version } : { kind: 'none' }
      return this.setState(this.candidate === undefined ? { phase: 'idle' } : { phase: 'available', version })
    } catch (error) {
      if (generation !== this.generation || this.disposed) return this.current
      return this.failure(error, 'check')
    }
  }
}
