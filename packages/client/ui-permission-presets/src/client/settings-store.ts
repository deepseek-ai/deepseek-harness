/**
 * Permission default-settings controller. The permission descriptor comes
 * from the shared describe mirror and choices from the permission catalog; writes target
 * only `defaultPreset`, carry the descriptor revision, and fold their answer
 * back into the mirror.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SettingsNamespaceView } from '@deepseek-ai/dsh-api-remotes/client'
import {
  createSnapshotStore, type SnapshotStore,
} from '@deepseek-ai/dsh-client-store'
import type { SettingsDescribeFace } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { PermissionCatalog } from '@deepseek-ai/dsh-permission-presets/client'
import type { PermissionCatalogDirectory } from './catalog.ts'
import { displayPermissionPreset } from './presentation.ts'

/** Permission's settings namespace on the host wire. */
export const PERMISSION_SETTINGS_NS = 'permission'

/** One selectable new-session default. */
export interface PermissionDefaultOption {
  /** Preset key written to Settings. */
  id: string
  /** Host-supplied label or a title-cased preset key. */
  label: string
}

/** Permission settings-row snapshot. */
export interface PermissionSettingsState {
  status: 'idle' | 'loading' | 'ready' | 'saving' | 'unavailable' | 'error'
  error: string | null
  writable: boolean
  currentValue: string
  options: readonly PermissionDefaultOption[]
  revision: number
}

/** Resolve the new-session choices from the permission domain's catalog.
 * @param view Live configuration descriptor.
 * @param catalog Configured permission options and effective default.
 * @returns Current choice and labels for its allowed options.
 */
export function permissionDefaultOf(view: SettingsNamespaceView, catalog: PermissionCatalog): {
  currentValue: string
  options: PermissionDefaultOption[]
} {
  const currentValue = (view.value as { defaultPreset?: string }).defaultPreset ?? catalog.defaultPreset
  const options = catalog.defaultOptions.map(option => ({
    id: option.value, label: displayPermissionPreset(option.value, option.name),
  }))
  if (!options.some(option => option.id === currentValue)) throw new Error('permission catalog does not advertise its current default')
  return { currentValue, options }
}

/** Controller deriving the row from the shared mirror and writing the default through it. */
export class PermissionPresetSettingsController {
  /** Row snapshot consumed through a bound selector hook. */
  readonly store: SnapshotStore<PermissionSettingsState> = createSnapshotStore({
    status: 'idle',
    error: null,
    writable: false,
    currentValue: '',
    options: [],
    revision: 0,
  })

  private following: (() => void) | undefined
  private followingCatalog: (() => void) | undefined
  private saving = false
  private disposed = false

  /**
   * @param describeFace - the shared mirror's read/fold face (descriptor and schema source).
   * @param ctx - the row plugin's context, whose `remote.settings` namespace
   * carries the `defaultPreset` write.
   * @param catalog - configured permission choices and their effective default.
   */
  constructor(
    private readonly describeFace: SettingsDescribeFace,
    private readonly ctx: ClientContext,
    private readonly catalog: Pick<PermissionCatalogDirectory, 'store' | 'load'>,
  ) {}

  /**
   * Begin following the mirror (idempotent) and reflect its current answer.
   * @returns settlement once the snapshot reflects the mirror.
   */
  async load(): Promise<void> {
    if (this.disposed) return
    this.following ??= this.describeFace.subscribe(() => { this.derive() })
    this.followingCatalog ??= this.catalog.store.subscribe(() => { this.derive() })
    this.store.update((state) => {
      state.status = 'loading'
      state.error = null
    })
    await this.describeFace.ensure()
    if (this.describeFace.getSnapshot().status !== 'unavailable') {
      try { await this.catalog.load() } catch (error) { this.fail(error); return }
    }
    this.derive()
  }

  /**
   * Persist one preset as the default for subsequently created sessions.
   * A selection made while one is already saving is ignored — the row's
   * control is disabled during the save, so this only drops programmatic
   * double-submits rather than user intent.
   * @param preset - advertised preset key.
   * @returns nothing; {@link store} carries success or failure.
   */
  async select(preset: string): Promise<void> {
    const state = this.store.getSnapshot()
    const view = this.describeFace.getSnapshot().view?.namespaces
      .find(entry => entry.ns === PERMISSION_SETTINGS_NS)
    if (view === undefined || !state.writable || this.saving) return
    this.saving = true
    this.store.update((draft) => {
      draft.status = 'saving'
      draft.error = null
    })
    let response
    try {
      response = await this.ctx.remote.settings.mutate(
        PERMISSION_SETTINGS_NS,
        [{ op: 'set', path: ['defaultPreset'], value: preset }],
        view.revision,
      )
    } finally {
      // Cleared before the fold below, whose publish reaches `derive` through
      // this row's own subscription and is skipped while a save is pending.
      this.saving = false
    }
    if (this.disposed) return
    if (!response.ok) {
      this.fail(response.error)
      return
    }
    // The mirror publish reaches this row's own subscription, so the fold
    // is also what republishes the accepted value here.
    this.describeFace.acceptView(response.value)
  }

  /** Stop following the mirror; later publishes leave the snapshot alone. */
  dispose(): void {
    this.disposed = true
    this.following?.()
    this.following = undefined
    this.followingCatalog?.()
    this.followingCatalog = undefined
  }

  private derive(): void {
    if (this.disposed || this.saving) return
    const mirrored = this.describeFace.getSnapshot()
    if (mirrored.status === 'unavailable') {
      // The terminal non-loopback state: this client keeps Host persistence disabled, so
      // the row hides itself exactly like an unserved namespace.
      this.store.update((state) => {
        state.status = 'unavailable'
        state.writable = false
        state.currentValue = ''
        state.options = []
      })
      return
    }
    if (mirrored.view === undefined) {
      // A held failure with no answer is a failed row; without one the read
      // is still in flight and the row keeps its loading state.
      if (mirrored.error !== null) this.fail(new Error(mirrored.error))
      return
    }
    const view = mirrored.view.namespaces.find(entry => entry.ns === PERMISSION_SETTINGS_NS)
    if (view === undefined) {
      this.store.update((state) => {
        state.status = 'unavailable'
        state.writable = false
        state.currentValue = ''
        state.options = []
      })
      return
    }
    try {
      const catalog = this.catalog.store.getSnapshot().value
      if (catalog === null) return
      const resolved = permissionDefaultOf(view, catalog)
      const { writable } = mirrored.view
      this.store.update((state) => {
        state.status = 'ready'
        state.error = null
        state.writable = writable
        state.currentValue = resolved.currentValue
        state.options = resolved.options
        state.revision = view.revision
      })
    } catch (error) {
      this.fail(error)
    }
  }

  private fail(error: unknown): void {
    this.store.update((state) => {
      state.status = 'error'
      state.error = error instanceof Error ? error.message : String(error)
    })
  }
}
