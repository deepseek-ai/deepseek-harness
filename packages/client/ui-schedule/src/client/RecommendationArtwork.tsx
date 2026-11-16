/**
 * Tile glyphs for recommended tasks: a 20px grid drawn 1:1 at 20px with 1.25px
 * `currentColor` strokes, the shared icons' Regular weight (one unit on their
 * 16-unit grid) at this size, with round caps and round joins. Each glyph marks
 * its main shape with `data-fill`; the page stylesheet supplies that fill color.
 */
import type { ReactNode } from 'react'

/** Props every tile glyph accepts. */
export interface TileGlyphProps {
  readonly className?: string | undefined
}

function Glyph({ className, children }: TileGlyphProps & { readonly children: ReactNode }): ReactNode {
  return (
    <svg className={className} width={20} height={20} viewBox="0 0 20 20" fill="none" stroke="currentColor"
      strokeWidth={1.25} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
      {children}
    </svg>
  )
}

/**
 * Half sun over a horizon: a morning brief.
 * @param props - class of the root SVG.
 * @returns the glyph.
 */
export function SunriseGlyph(props: TileGlyphProps): ReactNode {
  return (
    <Glyph {...props}>
      <path data-fill="" d="M5 14A5 5 0 0 1 15 14Z" />
      <path d="M2.5 14H17.5" />
      <path d="M6.5 17H13.5" />
      <path d="M10 4.75V6.75" />
      <path d="M3.92 7.92L5.19 9.19" />
      <path d="M16.08 7.92L14.81 9.19" />
    </Glyph>
  )
}

/**
 * Calendar page with a check: a week in review.
 * @param props - class of the root SVG.
 * @returns the glyph.
 */
export function CalendarCheckGlyph(props: TileGlyphProps): ReactNode {
  return (
    <Glyph {...props}>
      <path data-fill="" d="M5 4.5H15A2 2 0 0 1 17 6.5V15A2 2 0 0 1 15 17H5A2 2 0 0 1 3 15V6.5A2 2 0 0 1 5 4.5Z" />
      <path d="M3 8.5H17" />
      <path d="M7 2.75V6" />
      <path d="M13 2.75V6" />
      <path d="M7.5 12.75L9.25 14.5L12.75 11" />
    </Glyph>
  )
}

/**
 * Open-issue mark: a ring with a center dot.
 * @param props - class of the root SVG.
 * @returns the glyph.
 */
export function IssueGlyph(props: TileGlyphProps): ReactNode {
  return (
    <Glyph {...props}>
      <circle data-fill="" cx="10" cy="10" r="7" />
      <circle cx="10" cy="10" r="1.75" fill="currentColor" stroke="none" />
    </Glyph>
  )
}

/**
 * Puzzle piece with a check: plugins that still fit.
 * @param props - class of the root SVG.
 * @returns the glyph.
 */
export function PluginCheckGlyph(props: TileGlyphProps): ReactNode {
  return (
    <Glyph {...props}>
      <path data-fill="" d="M4.5 6.5H7A2 2 0 1 1 11 6.5H13.5A1 1 0 0 1 14.5 7.5V10A2 2 0 1 1 14.5 14V16.5A1 1 0 0 1 13.5 17.5H4.5A1 1 0 0 1 3.5 16.5V7.5A1 1 0 0 1 4.5 6.5Z" />
      <path d="M6.5 12.25L8.25 14L11.5 10.5" />
    </Glyph>
  )
}

/**
 * Newspaper page: an image block, short headlines and a body line.
 * @param props - class of the root SVG.
 * @returns the glyph.
 */
export function NewspaperGlyph(props: TileGlyphProps): ReactNode {
  return (
    <Glyph {...props}>
      <path data-fill="" d="M4.5 3.5H15.5A2 2 0 0 1 17.5 5.5V14.5A2 2 0 0 1 15.5 16.5H4.5A2 2 0 0 1 2.5 14.5V5.5A2 2 0 0 1 4.5 3.5Z" />
      <path data-fill="" d="M5.5 6.75H9.25V10.25H5.5Z" />
      <path d="M11.75 7H14.5" />
      <path d="M11.75 10H14.5" />
      <path d="M5.5 13.25H14.5" />
    </Glyph>
  )
}

/**
 * Branch: a trunk with a side branch joining it.
 * @param props - class of the root SVG.
 * @returns the glyph.
 */
export function BranchGlyph(props: TileGlyphProps): ReactNode {
  return (
    <Glyph {...props}>
      <circle data-fill="" cx="6" cy="4.5" r="2" />
      <circle data-fill="" cx="6" cy="15.5" r="2" />
      <circle data-fill="" cx="14" cy="6.5" r="2" />
      <path d="M6 6.5V13.5" />
      <path d="M14 8.5V9A4.5 4.5 0 0 1 9.5 13.5H6" />
    </Glyph>
  )
}

/**
 * Sun partly behind a cloud: weather.
 * @param props - class of the root SVG.
 * @returns the glyph.
 */
export function CloudSunGlyph(props: TileGlyphProps): ReactNode {
  return (
    <Glyph {...props}>
      <path d="M10.43 8.12A3 3 0 1 0 6.62 10.37" />
      <path d="M7.5 1.9V3.1" />
      <path d="M1.9 7.5H3.1" />
      <path d="M3.54 3.54L4.39 4.39" />
      <path d="M11.46 3.54L10.61 4.39" />
      <path d="M3.54 11.46L4.39 10.61" />
      <path data-fill="" d="M7 16.5H14.5A3 3 0 0 0 14.5 10.5A4.5 4.5 0 0 0 6.2 12.4A2.1 2.1 0 0 0 7 16.5Z" />
    </Glyph>
  )
}

/**
 * Dumbbell: a bar between two plates and two collars.
 * @param props - class of the root SVG.
 * @returns the glyph.
 */
export function DumbbellGlyph(props: TileGlyphProps): ReactNode {
  return (
    <Glyph {...props}>
      <path d="M7.5 10H12.5" />
      <path data-fill="" d="M6 4.5H7.5V15.5H6A1.5 1.5 0 0 1 4.5 14V6A1.5 1.5 0 0 1 6 4.5Z" />
      <path data-fill="" d="M14 4.5H12.5V15.5H14A1.5 1.5 0 0 0 15.5 14V6A1.5 1.5 0 0 0 14 4.5Z" />
      <path d="M4.5 7H3A1 1 0 0 0 2 8V12A1 1 0 0 0 3 13H4.5" />
      <path d="M15.5 7H17A1 1 0 0 1 18 8V12A1 1 0 0 1 17 13H15.5" />
    </Glyph>
  )
}
