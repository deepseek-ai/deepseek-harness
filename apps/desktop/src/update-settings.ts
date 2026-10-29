/** Channel-specific default and failure policy over the shared shell settings document. */
import { DesktopSettingsFile, type DesktopSettingsFileError } from './settings-file.ts'
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
   * @returns After the atomic save and lock release; failures retain the storage error's effect details.
   */
  async save(channel: DesktopUpdateChannel): Promise<void> {
    await this.file.saveUpdates({ channel })
  }
}
