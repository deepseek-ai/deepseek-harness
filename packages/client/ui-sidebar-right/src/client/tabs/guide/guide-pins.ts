/** Persisted pin choices for the guide's tool cards. */
import { createSnapshotStore, type ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { SidebarRightGuideBox } from '../../tab-registry.ts'

/** Tab kind whose card always shows and never enters the customization list. */
export const FIXED_GUIDE_KIND = 'files'

/** Root-level key reserved for the future guide list slot's per-list preferences. */
const STORAGE_KEY = 'dsh.slot.manual-order.sidebar.right.tab.guide.list.v1'
const NO_CARDS: readonly string[] = []

/**
 * Pin identity of one guide card; the kind survives an extension taking over that kind.
 * @param entry - Guide card from the tab registry.
 * @returns `kind:id`.
 */
export function guideEntryId(entry: Pick<SidebarRightGuideBox, 'kind' | 'id'>): string {
  return `${entry.kind}:${entry.id}`
}

/** Unpinned guide card ids and their only mutation. */
export interface GuidePins {
  /** Unpinned `kind:id` card ids; ids of cards that are not registered stay listed. */
  readonly unpinned: ObservableSnapshot<readonly string[]>
  /**
   * Show or hide one guide card; cards of the fixed kind are ignored.
   * @param id - `kind:id` card id.
   * @param pinned - Whether the card shows on the guide.
   */
  readonly setPinned: (id: string, pinned: boolean) => void
}

/** Stored content is unchecked; anything but a string array leaves every card pinned. */
function unpinnedCards(value: unknown): readonly string[] {
  if (typeof value !== 'object' || value === null || !('unpinned' in value)) return NO_CARDS
  const { unpinned } = value
  return Array.isArray(unpinned) && unpinned.every((id): id is string => typeof id === 'string') ? unpinned : NO_CARDS
}

/**
 * Create the persisted guide pin list; the snapshot keeps its reference until the list changes.
 * @returns Validated unpinned card ids and the pin mutation.
 */
export function createGuidePins(): GuidePins {
  const store = createSnapshotStore<unknown>({ unpinned: NO_CARDS }, { persist: { name: STORAGE_KEY } })
  return {
    unpinned: { getSnapshot: () => unpinnedCards(store.getSnapshot()), subscribe: listener => store.subscribe(listener) },
    setPinned: (id, pinned) => {
      const current = unpinnedCards(store.getSnapshot())
      if (id.startsWith(`${FIXED_GUIDE_KIND}:`) || pinned !== current.includes(id)) return
      store.set({ unpinned: pinned ? current.filter(entry => entry !== id) : [...current, id] })
    },
  }
}
