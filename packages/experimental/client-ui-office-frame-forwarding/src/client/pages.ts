/** Writer page geometry bounds the static page-preview layer. */
import type { Rect } from '../types.ts'

/**
 * Decode page rectangles from the native document query.
 * @param rectangles - Semicolon-separated rectangles in twips.
 * @returns Actual page extents in document coordinates.
 */
export function pageRectangles(rectangles: string): [Rect, ...Rect[]] {
  return rectangles.split(';').map((rectangle) => {
    const values = rectangle.split(',').map(Number)
    const [x, y, width, height] = values
    if (values.length !== 4 || x === undefined || y === undefined || width === undefined || height === undefined
      || values.some(value => !Number.isFinite(value)) || width <= 0 || height <= 0)
      throw new Error('Invalid Office page rectangle.')
    return { x, y, width, height }
  }) as [Rect, ...Rect[]]
}

/**
 * Clip the static preview layer to Writer's page extents.
 * @param rectangles - LibreOfficeKit's semicolon-separated page rectangles in twips.
 * @param zoom - CSS pixels per document pixel at 96 DPI.
 * @returns A CSS path with one closed subpath per page.
 */
export function pageClipPath(rectangles: string, zoom: number): string {
  const paths = pageRectangles(rectangles).map((rectangle) => {
    const x = (rectangle.x * zoom) / 15,
      y = (rectangle.y * zoom) / 15
    const width = (rectangle.width * zoom) / 15,
      height = (rectangle.height * zoom) / 15
    return `M${x} ${y}h${width}v${height}h${-width}Z`
  })
  return `path('${paths.join(' ')}')`
}
