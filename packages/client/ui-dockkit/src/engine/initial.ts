/**
 * Initial state and the identity mint every operation draws its new ids from.
 * Ids are minted outside `applyOp` so a recorded sequence replays to the exact
 * same tree.
 *
 * What the first tab *is* belongs to the embedder: pass a factory and this
 * module only decides where it sits.
 */
import type { DockMode, LayoutState, PaneId, TabId, TabRecord } from '../contract/types.ts'
import type { Mint } from './planner.ts'

/** Monotonic id source; one instance belongs to one surface's sequence. */
export interface IdMinter {
  /** Next id under `prefix`, unique for the life of this minter; the prefix names the id's kind. */
  readonly next: Mint
}

/**
 * Create an id source.
 * @param seed - number the first id counts from; defaults to 0.
 * @returns a minter producing `<prefix><n>` ids.
 */
export function createIdMinter(seed = 0): IdMinter {
  let counter = seed
  // The one place a string becomes an id: the prefix names the kind, the counter
  // keeps every id this minter hands out unique.
  const next = ((prefix: string): string => {
    counter += 1
    return `${prefix}${counter}`
  }) as Mint
  return { next }
}

/** Builds the tab record a newly seeded pane should hold. */
export type TabFactory = (id: TabId) => TabRecord

/**
 * The state a surface starts in: collapsed, one docked pane, and whatever tab
 * `makeInitialTab` supplies.
 *
 * The first tab belongs to the initial state rather than to an operation, so
 * expanding and collapsing never accumulates copies of it.
 * @param minter - id source this surface's sequence will keep using.
 * @param makeInitialTab - builds the starting tab; omit for an empty pane.
 * @param mode - starting presentation; the embedder's product default.
 * @returns the collapsed single-pane starting state.
 */
export function createInitialState(
  minter: IdMinter,
  makeInitialTab?: TabFactory,
  mode: DockMode = 'push',
): LayoutState {
  const paneId: PaneId = minter.next('pane')
  const initial = makeInitialTab?.(minter.next('tab'))
  return {
    nodes: {
      [paneId]: {
        kind: 'pane',
        id: paneId,
        host: 'dock',
        tabs: initial === undefined ? [] : [initial.id],
        activeTabId: initial?.id,
        rect: undefined,
      },
    },
    tabs: initial === undefined ? {} : { [initial.id]: initial },
    rootId: paneId,
    floats: [],
    activePaneId: paneId,
    expanded: false,
    mode,
  }
}
