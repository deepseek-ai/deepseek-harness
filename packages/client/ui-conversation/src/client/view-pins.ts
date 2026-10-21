/** Persisted pin choices for the Conversation View tabs. */
import { createSnapshotStore, type ObservableSnapshot } from '@deepseek-ai/dsh-client-store'

/** View whose tab always shows and never enters the customization list. */
export const FIXED_VIEW_ID = 'chat'

/** Root-level key shared with the slot layer's future per-list preferences; Sessions share one list. */
const STORAGE_KEY = 'dsh.slot.manual-order.conversation.view.v1'
const NO_VIEWS: readonly string[] = []

/** Unpinned View ids and their only mutation. */
export interface ViewPins {
  /** Unpinned View ids; ids of Views that are not registered stay listed. */
  readonly unpinned: ObservableSnapshot<readonly string[]>
  /**
   * Show or hide one View tab; the fixed View is ignored.
   * @param id - View id.
   * @param pinned - Whether the tab shows in the Conversation header.
   */
  readonly setPinned: (id: string, pinned: boolean) => void
}

/** Stored content is unchecked; anything but a string array leaves every View pinned. */
function unpinnedViews(value: unknown): readonly string[] {
  if (typeof value !== 'object' || value === null || !('unpinned' in value)) return NO_VIEWS
  const { unpinned } = value
  return Array.isArray(unpinned) && unpinned.every((id): id is string => typeof id === 'string') ? unpinned : NO_VIEWS
}

/**
 * Create the persisted View pin list; the snapshot keeps its reference until the list changes.
 * @returns Validated unpinned View ids and the pin mutation.
 */
export function createViewPins(): ViewPins {
  const store = createSnapshotStore<unknown>({ unpinned: NO_VIEWS }, { persist: { name: STORAGE_KEY } })
  return {
    unpinned: { getSnapshot: () => unpinnedViews(store.getSnapshot()), subscribe: listener => store.subscribe(listener) },
    setPinned: (id, pinned) => {
      const current = unpinnedViews(store.getSnapshot())
      if (id === FIXED_VIEW_ID || pinned !== current.includes(id)) return
      store.set({ unpinned: pinned ? current.filter(entry => entry !== id) : [...current, id] })
    },
  }
}
