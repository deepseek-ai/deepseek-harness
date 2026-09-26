/** Serialized preference transactions; storage owners publish only accepted writes or read diagnostics. */
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import type { Branded } from '@deepseek-ai/dsh-brand'
import { editShortcutDocument, effectiveShortcuts, parseShortcutDocument } from './configuration.ts'
import type { BindingIssue, ShortcutDefinition, ShortcutDocument, ShortcutEdit } from './configuration.ts'
import type { ShortcutCommandId, ShortcutPlatform, ShortcutRuntime } from './binding.ts'

/** Opaque accepted-state identity, invalidated by configuration and catalog changes. */
export type ShortcutRevision = Branded<'ShortcutRevision'>
/** Read state retains the last accepted document on failure; loading does not enable commands. */
export interface ShortcutConfigSnapshot {
  readonly revision: ShortcutRevision
  /** Monotonic within one storage-owner lifetime; clients discard out-of-order IPC replies. */
  readonly sequence: number
  readonly document: ShortcutDocument
  readonly status: 'loading' | 'ready' | 'unreadable'
  readonly error: 'read' | 'invalid' | 'future' | null
  readonly usingDefaults: boolean
}
/** Save failures never replace effective preferences. */
export interface ShortcutSaveResult {
  readonly status: 'saved' | 'stale' | 'unreadable' | 'write-failed' | 'not-ready' | 'conflict'
  readonly snapshot: ShortcutConfigSnapshot
  readonly issue?: BindingIssue
  readonly conflicts?: readonly ShortcutCommandId[]
}
/** Storage adapter owns path/origin isolation and complete replacement on successful writes. */
export interface ShortcutStorage {
  read(): string | null | Promise<string | null>
  write(raw: string): void | Promise<void>
}
/** Restricted Desktop preload API; file paths and accelerators never cross from Renderer. */
export interface DesktopShortcutsApi {
  get(definitions: readonly ShortcutDefinition[]): Promise<ShortcutConfigSnapshot>
  edit(edit: ShortcutEdit, revision: ShortcutRevision): Promise<ShortcutSaveResult>
  subscribe(listener: (snapshot: ShortcutConfigSnapshot) => void): () => void
  recording(active: boolean): Promise<void>
}

/**
 * Create a disabled initial snapshot for asynchronous adapter startup.
 * @returns a fresh configuration with no accepted persisted state.
 */
export function initialShortcutConfig(): ShortcutConfigSnapshot {
  return { revision: randomUUID() as ShortcutRevision, sequence: 0, document: { schemaVersion: 1, profiles: {} },
    status: 'loading', error: null, usingDefaults: true }
}

/** Single-writer coordinator shared by localStorage and Electron's atomic file adapter. */
export class ShortcutPersistence {
  private snapshot = initialShortcutConfig()
  private raw: string | null | undefined
  private queue: Promise<unknown> = Promise.resolve()
  private definitions: readonly ShortcutDefinition[] | null = null
  private active = true

  constructor(private readonly storage: ShortcutStorage, private readonly runtime: ShortcutRuntime,
    private readonly platform: ShortcutPlatform, private readonly rereadBeforeWrite: boolean,
    private readonly publish: (snapshot: ShortcutConfigSnapshot) => void) {}

  /**
   * Install or revoke a product catalog and invalidate drafts from its previous lifetime.
   * @param definitions - current trusted definitions, or null while the product is not ready.
   */
  setDefinitions(definitions: readonly ShortcutDefinition[] | null): void {
    this.definitions = definitions
    this.accept({ ...this.snapshot })
  }

  /** Stop accepting edits or publishing late completions. */
  dispose(): void { this.active = false }

  /**
   * Read the current file; failures retain the last accepted document and disable ordinary writes.
   * @returns the accepted snapshot or diagnostic snapshot.
   */
  readCurrent(): Promise<ShortcutConfigSnapshot> {
    return this.serialize(() => this.read())
  }

  /**
   * Compare the draft revision, validate the complete candidate, then persist before publishing.
   * @param edit - constrained preference operation.
   * @param revision - state against which the user reviewed the edit.
   * @returns a classified outcome and the currently accepted snapshot.
   */
  edit(edit: ShortcutEdit, revision: ShortcutRevision): Promise<ShortcutSaveResult> {
    return this.serialize(async () => {
      if (this.rereadBeforeWrite) await this.read()
      const result = (status: ShortcutSaveResult['status']): ShortcutSaveResult => ({ status, snapshot: this.snapshot })
      if (!this.active || this.definitions === null || this.snapshot.status === 'loading') return result('not-ready')
      if (revision !== this.snapshot.revision) return result('stale')
      if (this.snapshot.status === 'unreadable') return result('unreadable')
      if ((edit.type === 'set' || edit.type === 'reset') && !this.definitions.some(row => row.id === edit.id && row.fixed === undefined)) return result('not-ready')
      const document = editShortcutDocument(this.snapshot.document, edit, this.runtime, this.platform)
      const rows = effectiveShortcuts(this.definitions, document, this.runtime, this.platform)
      const invalid = rows.find(row => (edit.type === 'reset-all' || row.id === edit.id)
        && (row.issue !== null || row.conflicts.length > 0))
      // An explicit edit must not silently disable another command's default binding.
      const displaced = edit.type === 'set' ? rows.find(row => row.conflicts.includes(edit.id)) : undefined
      if (invalid !== undefined || displaced !== undefined) return { ...result('conflict'),
        ...(invalid?.issue ? { issue: invalid.issue } : {}),
        conflicts: invalid?.conflicts.length ? invalid.conflicts : displaced === undefined ? [] : [displaced.id] }
      try {
        const raw = `${JSON.stringify(document, null, 2)}\n`
        await this.storage.write(raw)
        this.raw = raw
        this.accept({ ...this.snapshot, document, status: 'ready', error: null, usingDefaults: false })
        return result('saved')
      } catch (_error) {
        // The adapter retains the previous complete document when a write fails.
        return result('write-failed')
      }
    })
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation)
    this.queue = next.catch(() => undefined)
    return next
  }

  private accept(snapshot: ShortcutConfigSnapshot): void {
    this.snapshot = { ...snapshot, sequence: this.snapshot.sequence + 1, revision: randomUUID() as ShortcutRevision }
    if (!this.active) return
    try { this.publish(this.snapshot) } catch (error) { console.error('Shortcut configuration subscriber failed:', error) }
  }

  private async read(): Promise<ShortcutConfigSnapshot> {
    let raw: string | null
    try {
      raw = await this.storage.read()
    } catch (_error) {
      if (this.snapshot.error !== 'read') this.accept({ ...this.snapshot, status: 'unreadable', error: 'read' })
      return this.snapshot
    }
    if (raw === this.raw && this.snapshot.error !== 'read') return this.snapshot
    this.raw = raw
    const document = parseShortcutDocument(raw)
    if (typeof document === 'string') this.accept({ ...this.snapshot, status: 'unreadable', error: document })
    else this.accept({ ...this.snapshot, document, status: 'ready', error: null, usingDefaults: raw === null })
    return this.snapshot
  }
}
