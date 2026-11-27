/**
 * Interaction limits and dock geometry. The model itself is unbounded; these
 * are the V1 rules the interaction layer enforces before it dispatches, kept
 * pure so they can be asserted without a browser.
 */
import type { DockZone, LayoutState, SplitAxis, SplitDirection } from '../contract/types.ts'
import { assertNever, dockPaneIds } from './tree.ts'

/** V1 caps the docked grid at four panes; floating panes do not count. */
export const MAX_DOCK_PANES = 4

/** Smallest fraction a divider drag may leave a pane, as a share of its split. */
export const MIN_PANE_FRACTION = 0.12

/** Size a tab takes when it first floats, in CSS pixels. */
export const FLOAT_DEFAULT_SIZE = { width: 380, height: 300 } as const

/** Smallest size a floating panel may be resized to, in CSS pixels. */
export const FLOAT_MIN_SIZE = { width: 220, height: 140 } as const

/** Fraction of a pane's width or height that counts as its dock edge. */
export const DOCK_EDGE_FRACTION = 0.25

/**
 * Number of docked panes.
 * @param state - current layout.
 * @returns how many panes the docked tree holds; floating panes do not count.
 */
export function dockPaneCount(state: LayoutState): number {
  return dockPaneIds(state).length
}

/**
 * Whether another docked pane is allowed.
 * @param state - current layout.
 * @returns whether the docked tree is under `MAX_DOCK_PANES`.
 */
export function canSplit(state: LayoutState): boolean {
  return dockPaneCount(state) < MAX_DOCK_PANES
}

/** The five dock regions a tab can be dropped on. */
export const DOCK_ZONES: readonly DockZone[] = ['center', 'top', 'right', 'bottom', 'left']

/**
 * Which dock region a pointer sits in.
 * @param x - pointer x as a fraction of pane width.
 * @param y - pointer y as a fraction of pane height.
 * @param edge - edge band width as a fraction; defaults to `DOCK_EDGE_FRACTION`.
 * @returns the closest edge when the pointer is inside its band, else `'center'`.
 */
export function zoneAt(x: number, y: number, edge: number = DOCK_EDGE_FRACTION): DockZone {
  let zone: DockZone = 'left'
  let distance = x
  if (1 - x < distance) { zone = 'right'; distance = 1 - x }
  if (y < distance) { zone = 'top'; distance = y }
  if (1 - y < distance) { zone = 'bottom'; distance = 1 - y }
  return distance < edge ? zone : 'center'
}

/**
 * How a dock region splits the pane it targets.
 * @param zone - the region the pointer released in.
 * @returns the split's axis and direction, or `undefined` for `'center'`, which moves the tab into the pane instead.
 */
export function zoneSplit(zone: DockZone): { axis: SplitAxis; direction: SplitDirection } | undefined {
  switch (zone) {
    case 'center': return undefined
    case 'left': return { axis: 'row', direction: 'before' }
    case 'right': return { axis: 'row', direction: 'after' }
    case 'top': return { axis: 'column', direction: 'before' }
    case 'bottom': return { axis: 'column', direction: 'after' }
    /* v8 ignore next -- closed-union backstop; the compiler rejects a new zone here. */
    default: return assertNever(zone, 'layout: dock zone')
  }
}

/**
 * Clamp divider sizes so no pane falls under `MIN_PANE_FRACTION`.
 * @param sizes - candidate fractions from the drag preview.
 * @param minimum - smallest allowed share; defaults to the kit's pane fraction.
 * @returns fractions summing to 1 with every entry at or above the minimum.
 */
export function clampSizes(sizes: readonly number[], minimum = MIN_PANE_FRACTION): number[] {
  if (sizes.length === 0) return []
  const floor = Math.min(minimum, 1 / sizes.length)
  const positive = sizes.map(size => (size > 0 ? size : 0))
  const total = positive.reduce((sum, size) => sum + size, 0)
  let shares = total > 0 ? positive.map(size => size / total) : positive.map(() => 1 / sizes.length)
  // Pin every share under the floor at the floor and hand the remainder to the
  // others in proportion; a share that only now drops under joins the pinned
  // set on the next pass, so the result holds the floor exactly. The free
  // shares sit at or above the floor and sum to at least the remainder, so at
  // least one stays free and their total stays positive.
  const pinned = new Set<number>()
  for (;;) {
    const under = shares.flatMap((share, index) => (!pinned.has(index) && share < floor ? [index] : []))
    if (under.length === 0) return shares
    for (const index of under) pinned.add(index)
    const remainder = 1 - pinned.size * floor
    const freeTotal = shares.reduce((sum, share, index) => (pinned.has(index) ? sum : sum + share), 0)
    shares = shares.map((share, index) => (pinned.has(index) ? floor : (share / freeTotal) * remainder))
  }
}
