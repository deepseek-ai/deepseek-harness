/** Width-driven folding of the changes toolbar into its More menu. */

/** Fold levels, from none to the deepest: level 1 folds the line totals, expansion, side by side, and wrapping; level 2
 * the test switch, with the progress label shortened to the bare count beside its ring; level 3 refresh. */
export const DEEPEST_FOLD = 3

/**
 * Read the fold level a toolbar shows.
 * @param inside - an element inside the toolbar, such as its More button.
 * @returns the level, or the deepest level outside a measured toolbar.
 */
export function foldOf(inside: Element): number {
  const level = Number.parseInt(inside.closest('[data-fold]')?.getAttribute('data-fold') ?? '', 10)
  return Number.isInteger(level) ? level : DEEPEST_FOLD
}

/**
 * Width the row's displayed items need on one line: each item but the spacer at its own width, and one column gap
 * between neighbours, the spacer included.
 * @param row - the toolbar row.
 * @param gap - its column gap in pixels.
 * @returns the width in pixels.
 */
function demand(row: HTMLElement, gap: number): number {
  let width = 0
  let items = 0
  for (const child of row.children) {
    const spacer = child.hasAttribute('data-fold-spacer')
    const own = spacer ? 0 : child.getBoundingClientRect().width
    if (!spacer && own === 0) continue
    width += own
    items += 1
  }
  return width + Math.max(0, items - 1) * gap
}

/**
 * Keep a toolbar row on one line by setting `data-fold` to the shallowest level whose items fit, measuring each level's
 * demand synchronously; the row's styles hide each level's items and show the More button. Content, size, and font
 * changes measure again.
 * @param row - the toolbar row; its children are the items, and the one with `data-fold-spacer` takes the slack.
 * @returns Disconnect the observers and the font listener.
 */
export function observeToolbarFold(row: HTMLElement): () => void {
  const resize = new ResizeObserver(() => { measure() })
  const measure = (): void => {
    // Items React adds after the first measure are observed too; observing an observed element again does nothing.
    for (const child of row.children) resize.observe(child)
    const style = getComputedStyle(row)
    const available = row.getBoundingClientRect().width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
    const gap = parseFloat(style.columnGap)
    let level = 0
    for (; level < DEEPEST_FOLD; level += 1) {
      row.setAttribute('data-fold', String(level))
      if (demand(row, gap) <= available) break
    }
    row.setAttribute('data-fold', String(level))
  }
  resize.observe(row)
  const mutation = new MutationObserver(measure)
  mutation.observe(row, { subtree: true, childList: true, characterData: true })
  const fonts = document.fonts
  fonts.addEventListener('loadingdone', measure)
  measure()
  return () => {
    resize.disconnect()
    mutation.disconnect()
    fonts.removeEventListener('loadingdone', measure)
  }
}
