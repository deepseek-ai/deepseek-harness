/**
 * Shared spec fixtures. The kit has no notion of a guide or a preview tab, so
 * the suites supply their own content families — exactly as an embedder does.
 */
import type { NodeId, PaneId, PaneNode, SplitId, SplitNode, TabId, TabRecord } from '../src/contract/types.ts'
import { createIdMinter, createInitialState, DockController, type IdMinter } from '../src/index.ts'
import type { DockLabels } from '../src/contract/adapter.ts'
import type { LayoutState } from '../src/contract/types.ts'

/** Consistency id of the seeded tab these suites use. */
export const SEED_CONTENT_ID = 'seed:start'

/** Title of the seeded tab. */
export const SEED_TITLE = 'Start'

/** The seeded tab an embedder would put in a fresh pane. */
export function seedTab(id: TabId): TabRecord {
  return { id, kind: 'seed', contentId: SEED_CONTENT_ID, title: SEED_TITLE }
}

/** A content tab addressed by a file URL, the shape the first embedder uses. */
export function fileTab(id: TabId, contentId: string, title: string): TabRecord {
  return { id, kind: 'file', contentId, title }
}

/** A controller seeded on both the initial pane and every pane a split creates. */
export function seededController(): DockController {
  return new DockController({ makeInitialTab: seedTab, makePaneTab: seedTab })
}

/** An initial state holding one seeded tab, plus the minter that produced it. */
export function seededState(): { state: LayoutState; minter: IdMinter } {
  const minter = createIdMinter()
  return { state: createInitialState(minter, seedTab), minter }
}

/** Labels a spec can pass without caring what they say. */
export const TEST_LABELS: DockLabels = {
  emptyPane: 'empty pane',
  splitPane: 'split right',
  splitPaneDisabled: 'pane budget spent',
  splitPaneNarrow: 'too narrow to split',
  closeTab: 'close',
  addTab: 'new tab',
  dockFloat: 'dock',
  closeFloat: 'close panel',
  dropZone: { center: 'move here', left: 'split left', right: 'split right', top: 'split top', bottom: 'split bottom' },
}

/** Brand a literal a spec spells out: an id the kit would have minted. */
export const asPane = (id: string): PaneId => id as PaneId
/** See {@link asPane}. */
export const asSplit = (id: string): SplitId => id as SplitId
/** See {@link asPane}. */
export const asTab = (id: string): TabId => id as TabId

/** The first tab of a pane the spec knows is not empty. */
export function firstTab(pane: PaneNode): TabId {
  const id = pane.tabs[0]
  if (id === undefined) throw new Error(`fixture: pane ${pane.id} holds no tab`)
  return id
}

/** A split's child at an index the spec knows exists. */
export function childAt(split: SplitNode, index: number): NodeId {
  const id = split.children[index]
  if (id === undefined) throw new Error(`fixture: split ${split.id} has no child ${String(index)}`)
  return id
}
