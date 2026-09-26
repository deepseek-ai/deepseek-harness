/** Content-sized model collapse for the composer's two control groups. */

/**
 * Collapse the model text only when the expanded controls cannot share a line.
 * The model seat consumes the row's inherited display variables; wrapping remains
 * available when even the icon cannot fit. Each notification is measured synchronously.
 * @param row - Composer control row with its leading and trailing groups.
 * @returns Disconnect the layout observers and font listener.
 */
export function observeControlRow(row: HTMLElement): () => void {
  const measure = (): void => {
    // Always measure expanded demand, including text changed while collapsed.
    row.removeAttribute('data-model-compact')
    const style = getComputedStyle(row)
    const available = row.getBoundingClientRect().width
      - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
    const widths = Array.from(row.children, child => child.getBoundingClientRect().width)
      .filter(width => width > 0)
    const needed = widths.reduce((sum, width) => sum + width, 0)
      + Math.max(0, widths.length - 1) * parseFloat(style.columnGap)
    row.toggleAttribute('data-model-compact', needed > available)
  }
  const resize = new ResizeObserver(measure)
  resize.observe(row)
  for (const child of row.children) resize.observe(child)
  const mutation = new MutationObserver(measure)
  mutation.observe(row, {
    subtree: true, childList: true, characterData: true,
    attributes: true, attributeFilter: ['hidden'],
  })
  const fonts = document.fonts
  fonts.addEventListener('loadingdone', measure)
  measure()
  return () => {
    resize.disconnect()
    mutation.disconnect()
    fonts.removeEventListener('loadingdone', measure)
  }
}
