/** Channel-specific unlock, default, and failure policy over the shared shell settings document. */
import { appendFileSync } from 'node:fs'
import { DESKTOP_SETTINGS_VERSION, DesktopSettingsFile, DesktopSettingsFileError } from './settings-file.ts'
import type { DesktopUpdateChannel } from './update-channel.ts'

/** Config generation reported on feed metadata requests; 0 denotes missing, unmigrated, or suspended settings. */
export type DesktopUpdateConfigVersion = '0' | typeof DESKTOP_SETTINGS_VERSION

/** Invalid explicit fields suspend ordinary updates; un-unlocked installations always resolve to stable. */
export type DesktopUpdateSettingsResult =
  | {
    kind: 'ready'
    channel: DesktopUpdateChannel
    unlocked: boolean
    configVersion: DesktopUpdateConfigVersion
  }
  | { kind: 'error'; error: DesktopSettingsFileError }

/** No file watching; loading and explicit UI saves share shell storage and validation. */
export class DesktopUpdateSettings {
  private readonly file: DesktopSettingsFile
  readonly path: string

  /** @param userData - Electron userData, independent of Host and DSH_HOME. */
  constructor(userData: string) {
    this.file = new DesktopSettingsFile(userData)
    this.path = this.file.path
  }

  /** @returns Effective startup channel and unlock state, or an error requiring suspension; never creates a missing file. */
  async load(): Promise<DesktopUpdateSettingsResult> {
    const result = await this.file.read()
    if (result.kind === 'error') return result
    if (result.kind === 'missing') return { kind: 'ready', channel: 'stable', unlocked: false, configVersion: '0' }
    if (result.fields.channel.kind === 'invalid') return { kind: 'error', error: result.fields.channel.error }
    if (result.fields.channelUnlocked.kind === 'invalid') return { kind: 'error', error: result.fields.channelUnlocked.error }
    const configVersion: DesktopUpdateConfigVersion = result.document.version === DESKTOP_SETTINGS_VERSION
      ? DESKTOP_SETTINGS_VERSION : '0'
    const unlocked = configVersion === DESKTOP_SETTINGS_VERSION
      && result.fields.channelUnlocked.kind === 'valid'
      && result.fields.channelUnlocked.value
    const channel: DesktopUpdateChannel = unlocked && result.fields.channel.kind === 'valid'
      ? result.fields.channel.value : 'stable'
    return { kind: 'ready', channel, unlocked, configVersion }
  }

  /**
   * Persist an explicit UI selection and mark channel switching unlocked while preserving other fields.
   * @param channel - Validated UI selection.
   * @returns After a confirmed write, including logged lock-release failures.
   * Uncertain writes reject without retry; diagnostics are appended to settings.json.save.jsonl.
   */
  async save(channel: DesktopUpdateChannel): Promise<void> {
    try { await this.file.saveUpdates({ channel, channelUnlocked: true }) } catch (error) {
      if (!(error instanceof DesktopSettingsFileError) || error.problem.kind !== 'write') throw error
      const entry = {
        time: new Date().toISOString(),
        event: 'settings-save-failed',
        effect: error.problem.effect,
        path: this.path,
        reason: error.cause instanceof Error ? error.cause.message : String(error.cause),
      }
      try { appendFileSync(`${this.path}.save.jsonl`, `${JSON.stringify(entry)}\n`, { mode: 0o600, flush: true }) } catch (logError) {
        console.error('desktop settings: could not persist save warning', entry, logError)
      }
      if (error.problem.effect !== 'written') throw error
    }
  }
}
