/** In-memory pin choices for the guide's tool cards. */
import { createSnapshotStore, type ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { SidebarRightGuideBox } from '../../tab-registry.ts'

/** Tab kind whose card always shows and never enters the customization list. */
export const FIXED_GUIDE_KIND = 'files'

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
   * Pin or unpin one guide card; cards of the fixed kind are ignored.
   * @param id - `kind:id` card id.
   * @param pinned - Whether the card is manually pinned.
   */
  readonly setPinned: (id: string, pinned: boolean) => void
}

/**
 * Create the in-memory guide pin list; the snapshot keeps its reference until the list changes.
 * @returns Unpinned card ids and the pin mutation.
 */
export function createGuidePins(): GuidePins {
  const store = createSnapshotStore<{ readonly unpinned: readonly string[] }>({ unpinned: NO_CARDS })
  return {
    unpinned: { getSnapshot: () => store.getSnapshot().unpinned, subscribe: listener => store.subscribe(listener) },
    setPinned: (id, pinned) => {
      const current = store.getSnapshot().unpinned
      if (id.startsWith(`${FIXED_GUIDE_KIND}:`) || pinned !== current.includes(id)) return
      store.set({ unpinned: pinned ? current.filter(entry => entry !== id) : [...current, id] })
    },
  }
}
