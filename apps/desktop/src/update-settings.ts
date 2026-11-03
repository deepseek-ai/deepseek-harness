/** Channel-specific default and failure policy over the shared shell settings document. */
import { DesktopSettingsFile, DesktopSettingsFileError } from './settings-file.ts'
import { appendFileSync } from 'node:fs'
import type { DesktopUpdateChannel } from './update-channel.ts'

/** Invalid explicit channels suspend ordinary updates; only absence uses the package default. */
export type DesktopUpdateSettingsResult =
  | { kind: 'ready'; channel: DesktopUpdateChannel }
  | { kind: 'error'; error: DesktopSettingsFileError }

/** No file watching; loading and explicit UI saves share shell storage and validation. */
export class DesktopUpdateSettings {
  private readonly file: DesktopSettingsFile
  readonly path: string

  /**
   * @param userData - Electron userData, independent of Host and DSH_HOME.
   * @param packagedChannel - Default selected by the installer build input.
   */
  constructor(userData: string, private readonly packagedChannel: DesktopUpdateChannel) {
    this.file = new DesktopSettingsFile(userData)
    this.path = this.file.path
  }

  /** @returns Startup channel or an error requiring suspension; never creates a missing file. */
  async load(): Promise<DesktopUpdateSettingsResult> {
    const result = await this.file.read()
    if (result.kind === 'error') return result
    if (result.kind === 'missing') return { kind: 'ready', channel: this.packagedChannel }
    const channel = result.fields.channel
    if (channel.kind === 'invalid') return { kind: 'error', error: channel.error }
    return { kind: 'ready', channel: channel.kind === 'valid' ? channel.value : this.packagedChannel }
  }

  /**
   * Save a selection while preserving other fields; never changes the runtime selection itself.
   * @param channel - Validated UI selection.
   * @returns After a confirmed write, including logged lock-release failures.
   * Uncertain writes reject without retry; diagnostics are appended to settings.json.save.jsonl.
   */
  async save(channel: DesktopUpdateChannel): Promise<void> {
    try { await this.file.saveUpdates({ channel }) } catch (error) {
      if (!(error instanceof DesktopSettingsFileError) || error.problem.kind !== 'write') throw error
      const entry = { time: new Date().toISOString(), event: 'settings-save-failed', effect: error.problem.effect,
        path: this.path, reason: error.cause instanceof Error ? error.cause.message : String(error.cause) }
      try { appendFileSync(`${this.path}.save.jsonl`, `${JSON.stringify(entry)}\n`, { mode: 0o600, flush: true }) } catch (logError) {
        console.error('desktop settings: could not persist save warning', entry, logError)
      }
      if (error.problem.effect !== 'written') throw error
    }
  }
}
