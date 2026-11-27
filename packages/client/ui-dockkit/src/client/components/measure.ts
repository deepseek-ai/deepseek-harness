/**
 * DOM side of the room rule: read each docked pane's rectangles after a commit
 * and ask `halvesFit` whether a split would leave two working halves. Pixels
 * live here and in `geometry.ts`; the engine's planners never see them.
 */
import type { PaneId } from '../contract/types.ts'
import { halvesFit, SPLIT_MINIMUMS } from '../engine/geometry.ts'
import type { HalvesFit, Rect, SplitMinimums } from '../engine/geometry.ts'

const NO_RECT: Rect = { x: 0, y: 0, width: 0, height: 0 }

/** What an unmeasured pane is taken to be: fitting, until a reading says otherwise. */
const UNMEASURED: HalvesFit = { row: true, column: true }

function rectOf(element: Element | null): Rect {
  return element === null ? NO_RECT : element.getBoundingClientRect()
}

function px(value: string): number {
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : 0
}

/**
 * Every docked pane element under `root`, in document order, with the pane id
 * each carries.
 * @param root - the docked surface's element.
 * @returns pane ids paired with their elements.
 */
export function paneElements(root: HTMLElement): readonly (readonly [PaneId, HTMLElement])[] {
  const panes: (readonly [PaneId, HTMLElement])[] = []
  for (const pane of root.querySelectorAll<HTMLElement>('[data-dockkit-pane]')) {
    // The attribute is the kit's own PaneId written on render; the DOM hands it
    // back as a bare string, so the brand is restored here and nowhere else.
    const paneId = pane.dataset.dockkitPane as PaneId | undefined
    /* v8 ignore next -- the selector admits only elements carrying the attribute. */
    if (paneId === undefined) continue
    panes.push([paneId, pane])
  }
  return panes
}

/**
 * One chip's minimum footprint from a rendered chip's computed style; the
 * stylesheet fallback where none is rendered or styles are not applied.
 */
function chipMinimum(root: HTMLElement): number {
  const chip = root.querySelector('[data-dockkit-tab]')
  if (chip === null) return SPLIT_MINIMUMS.chip
  const style = getComputedStyle(chip)
  const min = px(style.minWidth)
  if (min <= 0) return SPLIT_MINIMUMS.chip
  if (style.boxSizing === 'border-box') return min
  return min + px(style.paddingLeft) + px(style.paddingRight) + px(style.borderLeftWidth) + px(style.borderRightWidth)
}

/** A rendered divider's thickness, or the stylesheet fallback before the first split. */
function dividerSize(root: HTMLElement): number {
  const divider = root.querySelector('[data-dockkit-divider]')
  if (divider === null) return SPLIT_MINIMUMS.divider
  const { width, height } = divider.getBoundingClientRect()
  const thickness = Math.min(width, height)
  return thickness > 0 ? thickness : SPLIT_MINIMUMS.divider
}

/**
 * The rendered split control's footprint in the strip's fixed part: its box
 * plus the strip's own gap, both of which the strip sheds when the control
 * hides. 0 while the control is hidden or unmeasured.
 */
function splitControlFootprint(pane: HTMLElement): number {
  const control = pane.querySelector('[data-dockkit-split-button]')
  if (control === null) return 0
  const width = control.getBoundingClientRect().width
  if (!(width > 0)) return 0
  const strip = pane.querySelector('[data-dockkit-strip]')
  /* v8 ignore next -- the control only renders inside a strip. */
  return width + (strip === null ? 0 : px(getComputedStyle(strip).columnGap))
}

/**
 * Measure every docked pane under `root`.
 * @param root - the docked surface's element.
 * @param splitHiddenWhenBlocked - whether the embedder hides blocked split
 * controls (`hideSplitWhenBlocked`); the room rule then leaves the control's
 * footprint out of each strip's fixed part, so the reading cannot flip with
 * the control's visibility (see `PaneMeasure.splitControlWidth`).
 * @returns each pane's fit, keyed by pane id.
 */
export function measurePaneFits(root: HTMLElement, splitHiddenWhenBlocked = false): ReadonlyMap<PaneId, HalvesFit> {
  const minimums: SplitMinimums = { divider: dividerSize(root), chip: chipMinimum(root), body: SPLIT_MINIMUMS.body }
  const fits = new Map<PaneId, HalvesFit>()
  for (const [paneId, pane] of paneElements(root)) {
    fits.set(paneId, halvesFit({
      pane: rectOf(pane),
      strip: rectOf(pane.querySelector('[data-dockkit-strip]')),
      chipsWidth: rectOf(pane.querySelector('[data-dockkit-strip-tabs]')).width,
      fillWidth: rectOf(pane.querySelector('[data-dockkit-strip-fill]')).width,
      splitControlWidth: splitHiddenWhenBlocked ? splitControlFootprint(pane) : 0,
    }, minimums))
  }
  return fits
}

/**
 * One pane's latest reading. A pane the map does not name has not been
 * measured and fits: the rule only blocks on a positive reading.
 * @param fits - the latest measurement.
 * @param paneId - the pane asked about.
 * @returns whether each split axis leaves two working halves.
 */
export function fitOf(fits: ReadonlyMap<PaneId, HalvesFit>, paneId: PaneId): HalvesFit {
  return fits.get(paneId) ?? UNMEASURED
}

/**
 * Whether two measurements agree, so a re-measure that changed nothing re-renders nothing.
 * @param a - one measurement.
 * @param b - the other.
 * @returns whether both name the same panes with the same readings.
 */
export function sameFits(a: ReadonlyMap<PaneId, HalvesFit>, b: ReadonlyMap<PaneId, HalvesFit>): boolean {
  if (a.size !== b.size) return false
  for (const [paneId, fit] of a) {
    const other = b.get(paneId)
    if (other === undefined || other.row !== fit.row || other.column !== fit.column) return false
  }
  return true
}
