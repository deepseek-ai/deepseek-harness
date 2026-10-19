/**
 * Menu reduction pure core. One group per source;
 * generation-gated settlement; empty ready groups auto-close. Zero React /
 * DOM / cordis. Stale or no-op events return the same state reference so
 * store subscribers skip re-renders.
 *
 * Roster protocol: the frozen `hit` event carries no source roster, so the
 * reducer cannot invent groups. Opening from a closed state, the shell seeds
 * the roster with {@link seedGroups} and then dispatches `hit`; a `hit`
 * while open (query refinement) resets the existing groups to pending under
 * a new generation while keeping their items on screen until the new fetch
 * settles (stale-while-revalidate — the render layer shows skeletons only
 * for a pending group with no items). Auto-close and explicit close drop
 * the groups.
 */
import type { InputTriggerCandidate, InputTriggerSource } from '../types.ts'
import type { ExactMatch, MenuReduce, MenuState } from './contract.ts'

/** Closed rest state with generation 0; store initializer and test seed. */
export const MENU_CLOSED: MenuState = { open: false, hit: null, generation: 0, groups: [], highlight: null }

/**
 * Replace the group roster with pending groups for `sources`, in order.
 * Shell-side step before dispatching `hit` on a fresh menu open.
 *
 * @param state - Current menu state.
 * @param sources - Sources registered for the hit trigger, in menu order.
 * @returns State carrying the new pending roster; highlight cleared.
 */
export function seedGroups(
  state: MenuState,
  sources: readonly Pick<InputTriggerSource, 'name' | 'showGroupTitle'>[],
): MenuState {
  return {
    ...state,
    groups: sources.map(source => ({
      source: source.name,
      ...(source.showGroupTitle === false ? { showGroupTitle: false } : {}),
      status: 'pending',
      items: [],
    })),
    highlight: null,
  }
}

/** Close, preserving the generation so in-flight settlements stay droppable. */
const closed = (state: MenuState): MenuState =>
  state.open || state.hit !== null || state.groups.length > 0 || state.highlight !== null
    ? { open: false, hit: null, generation: state.generation, groups: [], highlight: null }
    : state

/**
 * First item in menu order, or null while an earlier group is still pending, so
 * whichever source answers first cannot take the default highlight.
 */
function firstHighlight(groups: MenuState['groups']): MenuState['highlight'] {
  for (const g of groups) {
    if (g.status === 'pending') return null
    if (g.items.length > 0) return { source: g.source, index: 0 }
  }
  return null
}

/** The highlight itself when it still points at a ready item, else null. */
function validHighlight(highlight: MenuState['highlight'], groups: MenuState['groups']): MenuState['highlight'] {
  if (!highlight) return null
  const g = groups.find(x => x.source === highlight.source)
  return g && g.status === 'ready' && highlight.index < g.items.length ? highlight : null
}

/**
 * The highlight after a group settles or fails: kept while valid or parked on a
 * group that is still revalidating, otherwise the first item in menu order.
 */
function settledHighlight(highlight: MenuState['highlight'], groups: MenuState['groups']): MenuState['highlight'] {
  const valid = validHighlight(highlight, groups)
  if (valid !== null) return valid
  if (highlight && groups.some(g => g.source === highlight.source && g.status === 'pending')) return highlight
  return firstHighlight(groups)
}

/** Flatten ready items into (source, index) positions in group order. */
function positions(groups: MenuState['groups']): { source: string; index: number }[] {
  const out: { source: string; index: number }[] = []
  for (const g of groups) {
    if (g.status !== 'ready') continue
    for (let i = 0; i < g.items.length; i++) out.push({ source: g.source, index: i })
  }
  return out
}

/** True when every group is ready with zero items (the auto-close condition). */
const allReadyEmpty = (groups: MenuState['groups']): boolean =>
  groups.every(g => g.status === 'ready' && g.items.length === 0)

/**
 * Pure menu reducer. `hit` opens a new generation over the seeded roster
 * (null hit closes); `source-settled` outside the current generation, the
 * open menu, or the roster is dropped; a settlement or failure leaving every
 * group ready-and-empty (or no groups) auto-closes; `source-failed` silently
 * removes the group (the shell logs); `move` cycles the highlight across
 * ready items; `hover` parks it on one ready item (pointer and keyboard
 * share the single highlight — last input wins).
 *
 * @param state - Current menu state.
 * @param ev - Menu event.
 * @returns Next state; the same reference when stale or a no-op.
 */
export const menuReduce: MenuReduce = (state, ev) => {
  switch (ev.type) {
    case 'hit': {
      if (ev.hit === null) return closed(state)
      return {
        open: true,
        hit: ev.hit,
        generation: state.generation + 1,
        // Items and highlight survive the refinement (stale-while-revalidate):
        // the previous query's candidates stay rendered with the highlight
        // parked where it was while the new fetch runs, and the settled
        // generation replaces the items and revalidates the highlight
        // wholesale. Pending status still fences picks off the stale rows.
        groups: state.groups.map(g => ({ ...g, status: 'pending' })),
        highlight: state.highlight,
      }
    }
    case 'source-settled': {
      if (!state.open || ev.generation !== state.generation) return state
      const idx = state.groups.findIndex(g => g.source === ev.source)
      if (idx < 0) return state
      const items: readonly InputTriggerCandidate[] = ev.items ?? []
      const groups = state.groups.map((g, i) =>
        i === idx ? { ...g, status: 'ready' as const, items } : g)
      if (allReadyEmpty(groups)) return closed(state)
      const highlight = settledHighlight(state.highlight, groups)
      return { ...state, groups, highlight }
    }
    case 'source-failed': {
      if (!state.open || ev.generation !== state.generation) return state
      if (!state.groups.some(g => g.source === ev.source)) return state
      const groups = state.groups.filter(g => g.source !== ev.source)
      if (groups.length === 0 || allReadyEmpty(groups)) return closed(state)
      const highlight = settledHighlight(state.highlight, groups)
      return { ...state, groups, highlight }
    }
    case 'move': {
      if (!state.open) return state
      const pos = positions(state.groups)
      if (pos.length === 0) return state
      const hl = state.highlight
      const at = hl ? pos.findIndex(p => p.source === hl.source && p.index === hl.index) : -1
      const next = pos[at < 0
        ? (ev.dir === 1 ? 0 : pos.length - 1)
        : (at + ev.dir + pos.length) % pos.length]
      if (next === undefined) return state
      if (hl && next.source === hl.source && next.index === hl.index) return state
      return { ...state, highlight: next }
    }
    case 'hover': {
      if (!state.open) return state
      const target = validHighlight({ source: ev.source, index: ev.index }, state.groups)
      if (target === null) return state
      const hl = state.highlight
      if (hl && hl.source === target.source && hl.index === target.index) return state
      return { ...state, highlight: target }
    }
    case 'close':
      return closed(state)
  }
}

/**
 * Exact-name lookup in one source's ready group.
 *
 * @param groups - Menu groups.
 * @param source - Source (group) name.
 * @param name - Candidate name to match exactly.
 * @returns The candidate, or null when the group is absent, not ready, or
 * has no candidate of that name.
 */
export const exactMatch: ExactMatch = (groups, source, name) => {
  const group = groups.find(g => g.source === source)
  if (!group || group.status !== 'ready') return null
  return group.items.find(c => c.name === name) ?? null
}
