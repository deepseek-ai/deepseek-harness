import type { ViewTab } from './contract/views.ts'

/** Fallback View selected when no stored preference resolves to a registered View. */
export const DEFAULT_VIEW_ID = 'chat'

/** Registered identity of the trajectory View. */
export const TRAJECTORY_VIEW_ID = 'trajectory'

/**
 * Resolve a preferred registered View, then Chat, without choosing another View.
 * @param tabs - currently registered Views.
 * @param selectedId - preferred View identity, when one is stored.
 * @returns the selected View, Chat fallback, or undefined when neither is registered.
 */
export function resolveActiveView(
  tabs: readonly ViewTab[],
  selectedId: string | null,
): ViewTab | undefined {
  const selected = selectedId === null ? undefined : tabs.find(view => view.id === selectedId)
  return selected ?? tabs.find(view => view.id === DEFAULT_VIEW_ID)
}
