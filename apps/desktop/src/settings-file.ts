/** Shared shell settings storage; reads have no side effects and fields fail independently. */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { z } from 'zod'

const preferencesSchema = z.object({
  allowTestAuthPopupWindow: z.boolean(),
  channel: z.enum(['nightly', 'stable']),
})
const documentSchema = z.looseObject({ updates: z.looseObject({}).optional() })

/** Known field values before consumers supply defaults for absent fields. */
export type DesktopUpdatePreferences = z.infer<typeof preferencesSchema>
/** Unknown root and updates fields survive a read-modify-write operation. */
export type DesktopSettingsDocument = z.infer<typeof documentSchema>
/** Handling-relevant failure details; validation failures never include document contents. */
export type DesktopSettingsProblem =
  | { kind: 'read' }
  | { kind: 'invalid'; reason: 'json' | 'structure' }
  | { kind: 'invalid'; reason: 'field'; field: keyof DesktopUpdatePreferences }
  | { kind: 'write'; operation: 'initialize' | 'save'; effect: 'unchanged' | 'unknown' | 'written' }

/** A storage or validation failure; business consumers decide fallback or suspension. */
export class DesktopSettingsFileError extends Error {
  /**
   * @param problem - Stable failure classification and mutation outcome, when applicable.
   * @param path - Settings file location, never file contents.
   * @param options - Original filesystem error, when available.
   */
  constructor(readonly problem: DesktopSettingsProblem, readonly path: string, options?: ErrorOptions) {
    super(`desktop settings: ${problem.kind}: ${path}`, options)
  }
}

/** Absence permits a caller default; an invalid explicit field does not. */
export type DesktopSettingsField<T> =
  | { kind: 'absent' }
  | { kind: 'valid'; value: T }
  | { kind: 'invalid'; error: DesktopSettingsFileError }

/** File state and independent field results; a missing file is never implicitly created. */
export type DesktopSettingsRead =
  | { kind: 'missing' }
  | { kind: 'error'; error: DesktopSettingsFileError }
  | {
    kind: 'ready'
    document: DesktopSettingsDocument
    fields: { [K in keyof DesktopUpdatePreferences]: DesktopSettingsField<DesktopUpdatePreferences[K]> }
  }

function field<T>(schema: z.ZodType<T>, value: unknown, name: keyof DesktopUpdatePreferences, path: string): DesktopSettingsField<T> {
  if (value === undefined) return { kind: 'absent' }
  const result = schema.safeParse(value)
  return result.success ? { kind: 'valid', value: result.data }
    : { kind: 'invalid', error: new DesktopSettingsFileError({ kind: 'invalid', reason: 'field', field: name }, path) }
}

/**
 * Validate a channel at the IPC boundary using the same schema as file loading.
 * @param value - Untrusted input.
 * @returns Whether the input is a supported channel.
 */
export function isDesktopUpdateChannel(value: unknown): value is DesktopUpdatePreferences['channel'] {
  return preferencesSchema.shape.channel.safeParse(value).success
}

/**
 * Resolve the document shared by shell preferences and update channels.
 * @param userData - Electron userData, independent of Host and DSH_HOME.
 * @returns Settings file path without filesystem changes.
 */
function desktopSettingsPath(userData: string): string {
  return join(userData, 'desktop', 'settings.json')
}

/** File operations do not watch, cache, choose defaults or apply runtime preferences. */
export class DesktopSettingsFile {
  readonly path: string

  /** @param userData - Electron userData, independent of Host and DSH_HOME. */
  constructor(userData: string) { this.path = desktopSettingsPath(userData) }

  /** @returns Fresh file and field states; performs no creation or repair. */
  async read(): Promise<DesktopSettingsRead> {
    let raw: string
    try { raw = await readFile(this.path, 'utf8') } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' }
      return { kind: 'error', error: new DesktopSettingsFileError({ kind: 'read' }, this.path, { cause: error }) }
    }
    let value: unknown
    try { value = JSON.parse(raw) } catch (_error) {
      // SyntaxError can quote user content; diagnostics expose only the file and failure category.
      return { kind: 'error', error: new DesktopSettingsFileError({ kind: 'invalid', reason: 'json' }, this.path) }
    }
    return this.inspect(value)
  }

  private inspect(value: unknown): DesktopSettingsRead {
    const result = documentSchema.safeParse(value)
    if (!result.success) return { kind: 'error', error: new DesktopSettingsFileError({ kind: 'invalid', reason: 'structure' }, this.path) }
    const document = result.data
    return { kind: 'ready', document, fields: {
      allowTestAuthPopupWindow: field(preferencesSchema.shape.allowTestAuthPopupWindow,
        document.updates?.allowTestAuthPopupWindow, 'allowTestAuthPopupWindow', this.path),
      channel: field(preferencesSchema.shape.channel, document.updates?.channel, 'channel', this.path),
    } }
  }

  /**
   * Explicit startup initialization; existing files, including invalid ones, are never replaced.
   * @returns Current file state after exclusive creation if missing, or a structured failure.
   */
  async initialize(): Promise<DesktopSettingsRead> {
    const current = await this.read()
    if (current.kind !== 'missing') return current
    try { return await this.mutate({ kind: 'initialize' }) } catch (error) {
      if (!(error instanceof DesktopSettingsFileError)) throw error
      return { kind: 'error', error }
    }
  }

  /**
   * Patch known fields under the shared writer lock, preserving unknown and unrelated invalid fields.
   * Malformed JSON/structure is rejected; a missing document starts empty. External editors must
   * not write concurrently. No runtime settings change here. Write errors distinguish unchanged,
   * uncertain write completion, and a committed write whose lock cleanup failed; no rollback is attempted.
   * @param updates - Typed fields to replace; omitted keys remain unchanged.
   * @returns After atomic replacement and lock release; otherwise throws DesktopSettingsFileError.
   */
  async saveUpdates(updates: Partial<DesktopUpdatePreferences>): Promise<void> {
    const result = await this.mutate({ kind: 'save', updates })
    if (result.kind === 'error') throw result.error
  }

  private async mutate(request: { kind: 'initialize' } | { kind: 'save'; updates: Partial<DesktopUpdatePreferences> }): Promise<DesktopSettingsRead> {
    let effect: 'unchanged' | 'unknown' | 'written' = 'unchanged'
    try {
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
      return await withFileLock(this.path, async () => {
        const current = await this.read()
        if (current.kind === 'error') throw current.error
        if (request.kind === 'initialize' && current.kind !== 'missing') return current
        const document = current.kind === 'ready' ? current.document : {}
        const updates = request.kind === 'initialize' ? { allowTestAuthPopupWindow: false } : request.updates
        const next = { ...document, updates: { ...document.updates, ...updates } }
        const raw = `${JSON.stringify(next, null, 2)}\n`
        effect = 'unknown'
        if (request.kind === 'initialize') {
          try { await writeFile(this.path, raw, { flag: 'wx', mode: 0o600 }) } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
            effect = 'unchanged'
            return this.read()
          }
        } else {
          await writeFileAtomic(this.path, raw, { mode: 0o600 })
        }
        effect = 'written'
        return this.inspect(next)
      })
    } catch (error) {
      if (error instanceof DesktopSettingsFileError) throw error
      throw new DesktopSettingsFileError({ kind: 'write', operation: request.kind, effect }, this.path, { cause: error })
    }
  }
}
