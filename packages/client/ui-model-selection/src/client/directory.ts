/**
 * Per-session model directory: the ONE state both selection entries share.
 * The /model popup and composer seat combine one shared Host catalog with the
 * Session's durable selection projection, then submit through the same
 * selectModel call. A switch made in either entry updates this shared state.
 */
import type { ModelSelectionProjection } from '@deepseek-ai/dsh-agent/types'
import type { TrackProductEvent } from '@deepseek-ai/dsh-client-product-analytics/client'
import type {
  ModelCatalogFailure, ModelProviderGroup, ModelSelection, SessionSelectModelValue,
} from '@deepseek-ai/dsh-api-session-controller/types'
import type { SubagentAddress } from '@deepseek-ai/dsh-subagent/client'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { ObservableSnapshot, SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ModelCatalogDirectory } from './catalog.ts'

/** Directory snapshot both entries render from. */
export interface ModelDirectoryState {
  /** Saved selection, retained even when its provider or model leaves the catalog. */
  current: ModelSelection | null
  /** Saved effort caption retained when the selected model is unavailable. */
  retainedEffort?: string
  /** Whether the current selection is present in the available catalog; null while unresolved. */
  routable: boolean | null
  /** Successfully loaded provider groups (last good load). */
  groups: readonly ModelProviderGroup[]
  /** Provider-local failures from the last load; usable groups stay usable. */
  failures: readonly ModelCatalogFailure[]
  /** Lifecycle of the in-flight operation. */
  status: 'idle' | 'loading' | 'ready' | 'selecting' | 'error'
  /** Selection submitted by the latest `select` until it settles; null otherwise. */
  pending: ModelSelection | null
  /** Whole-request or selection failure text; null when none. */
  error: string | null
}

/**
 * Whether a Session offers model selection: ordinary Sessions and continuable subagents do.
 * @param address - direct-parent address for a child, absent for an ordinary Session.
 * @returns whether the /model popup and composer seat may load and submit choices.
 */
export function modelSelectable(address: SubagentAddress | undefined): boolean {
  return address === undefined || address.mode === 'continuable'
}

/** One session's shared directory controller; disposed with the session scope. */
export class ModelDirectory {
  /** The shared snapshot both entries render from (uSES-safe store). */
  readonly store: SnapshotStore<ModelDirectoryState> = createSnapshotStore<ModelDirectoryState>({
    current: null, routable: null, groups: [], failures: [], status: 'idle', pending: null, error: null,
  })

  /** Latest selection operation wins; an older response never overwrites a newer one. */
  private generation = 0
  private disposed = false
  private readonly unsubscribeCatalog: () => void
  private readonly unsubscribeSelection: () => void

  /**
   * @param selectModel - submit a choice through this Session's owning Remote service.
   * @param sessionId - the owning session.
   * @param address - direct-parent address for a child, absent for an ordinary Session.
   * @param catalog - Host-generation catalog shared by every Session.
   * @param projected - durable model selection projected from Session history.
   * @param isBlank - whether this Session has no first message yet.
   * @param track - desktop-only callback after a successful user selection.
   */
  constructor(
    private readonly selectModel: (
      selection: ModelSelection,
    ) => Promise<RemoteResult<SessionSelectModelValue>>,
    private readonly sessionId: SessionId,
    private readonly address: () => SubagentAddress | undefined,
    private readonly catalog: ModelCatalogDirectory,
    private readonly projected: ObservableSnapshot<unknown>,
    private readonly isBlank: () => boolean,
    private readonly track?: TrackProductEvent,
  ) {
    this.unsubscribeCatalog = catalog.store.subscribe(() => { this.syncInputs() })
    this.unsubscribeSelection = projected.subscribe(() => { this.syncInputs() })
    this.syncInputs()
  }

  /**
   * Ensure the Host generation's shared available catalog is loaded.
   * @returns the fresh directory value.
   */
  async load(): Promise<ModelDirectoryState> {
    this.assertAvailable()
    await this.catalog.load()
    this.syncInputs()
    return this.store.getSnapshot()
  }

  /**
   * Select the complete provider/model/reasoning selection. Projection updates
   * carry the saved choice; failures surface on the store
   * and return with the operation so each entry can present its own failure.
   * @param selection - provider, provider-owned model id, and optional adapter-owned effort.
   * @returns the selection outcome, including the original Remote failure.
   */
  async select(selection: ModelSelection): Promise<RemoteResult<void>> {
    this.assertAvailable()
    const previous = this.store.getSnapshot().current
    const previousEffort = previous?.reasoningEffort ?? (previous === null ? undefined : this.catalog.reasoningFor(previous)?.defaultEffort)
    const nextEffort = selection.reasoningEffort ?? this.catalog.reasoningFor(selection)?.defaultEffort
    const generation = ++this.generation
    this.store.update((s) => { s.status = 'selecting'; s.pending = selection; s.error = null })
    const result = await this.selectModel(selection)
    if (this.disposed || generation !== this.generation) {
      return result.ok ? { ok: true, value: undefined } : result
    }
    if (!result.ok) {
      this.store.update((s) => {
        s.status = 'error'
        s.pending = null
        s.error = `${result.error.code}: ${result.error.message}`
      })
      return result
    }
    if (previous !== null) {
      const from = `${previous.provider}/${previous.model}`
      const to = `${selection.provider}/${selection.model}`
      if (from !== to) this.track?.('model_switch', { ...this.isBlank() ? {} : { session_id: this.sessionId }, switch_from: from, switch_to: to })
      if (from === to && previousEffort !== nextEffort) this.track?.('thinking_level_switch', {
        ...this.isBlank() ? {} : { session_id: this.sessionId }, model_name: to, switch_from: previousEffort ?? 'default', switch_to: nextEffort ?? 'default',
      })
    }
    this.store.update((s) => { s.status = 'ready'; s.pending = null; s.error = null })
    this.syncInputs()
    return { ok: true, value: undefined }
  }

  /**
   * Invalidate an in-flight selection response from the previous Host generation.
   */
  resetConnected(): void {
    if (this.disposed) return
    ++this.generation
    this.store.update((state) => {
      if (state.status === 'selecting') state.status = 'idle'
      state.pending = null
      state.error = null
    })
    this.syncInputs()
  }

  /** Scope teardown: late settlements lose write access to the store. */
  dispose(): void {
    this.disposed = true
    this.unsubscribeSelection()
    this.unsubscribeCatalog()
  }

  private assertAvailable(): void {
    if (!modelSelectable(this.address())) {
      throw new Error('model selection is unavailable for addressed subagent sessions')
    }
  }

  private syncInputs(): void {
    if (this.disposed) return
    const catalog = this.catalog.store.getSnapshot()
    const projected = modelSelectionProjection(this.projected.getSnapshot())
    const defaultSelection = this.address() === undefined
      ? catalog.value?.default
      : undefined
    const intended = projected?.next ?? defaultSelection
    const reasoning = intended === undefined ? undefined : this.catalog.reasoningFor(intended)
    const effort = intended?.reasoningEffort ?? reasoning?.defaultEffort
    const retainedEffort = effort === undefined ? undefined
      : reasoning?.efforts.find(level => level.id === effort)?.name ?? effort
    if (catalog.status !== 'ready' || catalog.value === null || projected === undefined) {
      this.store.set({
        current: catalog.value === null ? null : this.store.getSnapshot().current,
        ...retainedEffort === undefined ? {} : { retainedEffort },
        routable: null,
        groups: catalog.value?.groups ?? [],
        failures: catalog.value?.failures ?? [],
        status: catalog.status === 'error' ? 'error' : 'loading',
        pending: this.store.getSnapshot().pending,
        error: catalog.error,
      })
      return
    }
    const selection = projected.next ?? defaultSelection
    const routable = selection !== undefined && catalog.value.groups.some(group => group.id === selection.provider
      && group.models.some(model => model.id === selection.model))
    this.store.set({
      current: selection ?? null,
      ...retainedEffort === undefined ? {} : { retainedEffort },
      routable,
      groups: catalog.value.groups,
      failures: catalog.value.failures,
      status: this.store.getSnapshot().status === 'selecting'
        ? 'selecting'
        : 'ready',
      pending: this.store.getSnapshot().pending,
      error: null,
    })
  }
}

function modelSelectionProjection(value: unknown): ModelSelectionProjection | undefined {
  return value === undefined ? undefined : value as ModelSelectionProjection
}
