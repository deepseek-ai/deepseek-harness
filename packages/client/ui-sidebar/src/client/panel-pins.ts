/** Persisted pin choices for the global panel launchers. */
import { createSnapshotStore, type ObservableSnapshot } from '@deepseek-ai/dsh-client-store'

/** Panel whose launcher always shows and never enters the customization list. */
export const FIXED_PANEL_ID = 'plugins'

/** Root-level key shared with the slot layer's future per-list preferences. */
const STORAGE_KEY = 'dsh.slot.manual-order.sidebar.panellist.v1'
const NO_PANELS: readonly string[] = []

/** Unpinned panel ids and their only mutation. */
export interface PanelPins {
  /** Unpinned panel ids; ids of panels that are not registered stay listed. */
  readonly unpinned: ObservableSnapshot<readonly string[]>
  /**
   * Show or hide one panel launcher; the fixed panel is ignored.
   * @param id - Panel id.
   * @param pinned - Whether the launcher shows in the sidebar.
   */
  readonly setPinned: (id: string, pinned: boolean) => void
}

/** Stored content is unchecked; anything but a string array leaves every panel pinned. */
function unpinnedPanels(value: unknown): readonly string[] {
  if (typeof value !== 'object' || value === null || !('unpinned' in value)) return NO_PANELS
  const { unpinned } = value
  return Array.isArray(unpinned) && unpinned.every((id): id is string => typeof id === 'string') ? unpinned : NO_PANELS
}

/**
 * Create the persisted panel pin list; the snapshot keeps its reference until the list changes.
 * @returns Validated unpinned panel ids and the pin mutation.
 */
export function createPanelPins(): PanelPins {
  const store = createSnapshotStore<unknown>({ unpinned: NO_PANELS }, { persist: { name: STORAGE_KEY } })
  return {
    unpinned: { getSnapshot: () => unpinnedPanels(store.getSnapshot()), subscribe: listener => store.subscribe(listener) },
    setPinned: (id, pinned) => {
      const current = unpinnedPanels(store.getSnapshot())
      if (id === FIXED_PANEL_ID || pinned !== current.includes(id)) return
      store.set({ unpinned: pinned ? current.filter(entry => entry !== id) : [...current, id] })
    },
  }
}
