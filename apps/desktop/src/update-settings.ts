/** Startup-only file reads and explicit UI writes for shell-owned update channels. */
import { readFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type { DesktopUpdateChannel } from './update-channel.ts'

/** A settings operation failed without applying a new runtime channel. */
export class DesktopUpdateSettingsError extends Error {
  /**
   * @param kind - Stable cause for localized configuration guidance.
   * @param path - User-editable document, never its contents.
   * @param options - Original filesystem or parsing failure, when available.
   */
  constructor(readonly kind: 'read' | 'invalid' | 'write', readonly path: string, options?: ErrorOptions) {
    super(`desktop update settings: ${kind}: ${path}`, options)
  }
}

/** Startup result; invalid settings never silently select the packaged channel. */
export type DesktopUpdateSettingsResult =
  | { kind: 'ready'; channel: DesktopUpdateChannel }
  | { kind: 'error'; error: DesktopUpdateSettingsError }

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Validate a channel from disk or IPC.
 * @param value - Untrusted channel value.
 * @returns Whether the value names a supported feed.
 */
export function isDesktopUpdateChannel(value: unknown): value is DesktopUpdateChannel {
  return value === 'nightly' || value === 'latest'
}

/** Reads no files after startup except during an explicit, serialized UI save. */
export class DesktopUpdateSettings {
  readonly path: string

  /**
   * @param userData - Electron userData, independent of Host and DSH_HOME.
   * @param packagedChannel - Default selected by the installer build input.
   */
  constructor(userData: string, private readonly packagedChannel: DesktopUpdateChannel) {
    this.path = join(userData, 'desktop', 'settings.json')
  }

  /** @returns The startup channel, or a failure that must suspend ordinary updates. */
  async load(): Promise<DesktopUpdateSettingsResult> {
    try {
      const document = await this.document()
      const value = object(document.updates) ? document.updates.channel : undefined
      if (value !== undefined && !isDesktopUpdateChannel(value)) throw new DesktopUpdateSettingsError('invalid', this.path)
      return { kind: 'ready', channel: value ?? this.packagedChannel }
    } catch (error) {
      if (!(error instanceof DesktopUpdateSettingsError)) throw error
      return { kind: 'error', error }
    }
  }

  /**
   * Save one explicit UI selection while retaining other fields from the latest document.
   * Cooperating writers serialize; external editors must not write concurrently with a save.
   * An invalid existing document is preserved and rejected, never replaced with defaults.
   * @param channel - Validated UI selection.
   * @returns After the atomic write commits; failures leave the runtime selection unchanged.
   */
  async save(channel: DesktopUpdateChannel): Promise<void> {
    try {
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
      await withFileLock(this.path, async () => {
        const document = await this.document()
        const updates = object(document.updates) ? document.updates : {}
        const next = { ...document, updates: { ...updates, channel } }
        await writeFileAtomic(this.path, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
      })
    } catch (error) {
      if (error instanceof DesktopUpdateSettingsError) throw error
      throw new DesktopUpdateSettingsError('write', this.path, { cause: error })
    }
  }

  private async document(): Promise<Record<string, unknown>> {
    let raw: string
    try { raw = await readFile(this.path, 'utf8') } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
      throw new DesktopUpdateSettingsError('read', this.path, { cause: error })
    }
    let value: unknown
    try { value = JSON.parse(raw) } catch (error) {
      throw new DesktopUpdateSettingsError('invalid', this.path, { cause: error })
    }
    if (!object(value) || (value.updates !== undefined && !object(value.updates))) {
      throw new DesktopUpdateSettingsError('invalid', this.path)
    }
    return value
  }
}
