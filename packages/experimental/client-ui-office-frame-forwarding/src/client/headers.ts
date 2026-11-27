/** Calc boundaries use the physical render scale; DOM labels use CSS pixels. */
interface Header {
  text: string
  start: number
  end: number
}

/**
 * Decode native cumulative boundaries; the first entry precedes the visible labels.
 * @param value - Native row or column JSON array.
 * @param pixelRatio - Physical pixels per CSS pixel of the render window.
 * @returns Labels with absolute document positions in CSS pixels.
 */
export function headerCells(value: unknown, pixelRatio: number): Header[] {
  if (!Array.isArray(value)) throw new Error('Invalid Office headers.')
  let start = 0
  return value.flatMap((item: unknown, index): Header[] => {
    if (
      typeof item !== 'object' ||
      item === null ||
      !('size' in item) ||
      !('text' in item) ||
      typeof item.size !== 'number' ||
      !Number.isFinite(item.size) ||
      item.size < start ||
      (typeof item.text !== 'number' && typeof item.text !== 'string')
    )
      throw new Error('Invalid Office header boundary.')
    const end = item.size,
      cell = { text: String(item.text), start: start / pixelRatio, end: end / pixelRatio }
    start = end
    return index === 0 || cell.start === cell.end ? [] : [cell]
  })
}

/** Render header labels without rerendering the editor on every scroll. */
export class SheetHeaders {
  private rowTransform = ''
  private columnTransform = ''

  constructor(
    private readonly rows: HTMLDivElement,
    private readonly columns: HTMLDivElement,
    private readonly label: (row: boolean, text: string) => string,
  ) {}

  /** Align header layers with document scrolling.
   * @param x - Horizontal scroll in CSS pixels.
   * @param y - Vertical scroll in CSS pixels.
   */
  scroll(x: number, y: number): void {
    const rowTransform = `translateY(${-y}px)`, columnTransform = `translateX(${-x}px)`
    if (this.rowTransform !== rowTransform) {
      this.rows.style.transform = rowTransform
      this.rowTransform = rowTransform
    }
    if (this.columnTransform !== columnTransform) {
      this.columns.style.transform = columnTransform
      this.columnTransform = columnTransform
    }
  }

  /** Replace row and column header labels.
   * @param value - Native ViewRowColumnHeaders response.
   * @param pixelRatio - Rendered physical pixels per CSS pixel.
   */
  update(value: unknown, pixelRatio: number): void {
    if (typeof value !== 'object' || value === null || !('rows' in value) || !('columns' in value))
      throw new Error('Invalid Office headers.')
    for (const [layer, entries, row] of [
      [this.rows, value.rows, true],
      [this.columns, value.columns, false],
    ] as const) {
      layer.replaceChildren(
        ...headerCells(entries, pixelRatio).map((cell) => {
          const element = layer.ownerDocument.createElement('button')
          element.type = 'button'
          element.dataset.range = `${cell.text}:${cell.text}`
          element.setAttribute('aria-label', this.label(row, cell.text))
          element.textContent = cell.text
          element.style.cssText = row
            ? `top:${cell.start}px;height:${cell.end - cell.start}px`
            : `left:${cell.start}px;width:${cell.end - cell.start}px`
          return element
        }),
      )
    }
  }
}
