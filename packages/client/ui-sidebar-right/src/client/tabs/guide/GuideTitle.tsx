/**
 * The guide type's chip title: the compass before the type's label. Registered
 * under `sidebar.right.pane.tab.title`; without it the chip would show the
 * bare label. Both guide glyphs live here: the compass the chip and the body's
 * hero draw, and the cube the body's icon-less capsules fall back to.
 */
import type { ReactNode } from 'react'
import type { IconProps } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './GuideBody.module.css'

/**
 * The compass: a ring with the needle's rhombus pointing north-east, on
 * `currentColor` so each rendering picks its own ink.
 * @param props - rendered size and class.
 * @returns the compass glyph.
 */
export function CompassGlyph({ size = 16, className }: IconProps): ReactNode {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true" className={className}>
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.4" />
      <path d="M 10.9 5.1 L 9.1 9.1 L 5.1 10.9 L 6.9 6.9 Z" fill="currentColor" />
    </svg>
  )
}

/**
 * The cube: an isometric box — hexagonal silhouette, the top face's two edges,
 * and the front seam — in straight strokes with softly rounded joins, on
 * `currentColor`. The guide body draws it in a capsule whose type registered
 * no glyph of its own.
 * @param props - rendered size and class.
 * @returns the cube glyph.
 */
export function CubeGlyph({ size = 16, className }: IconProps): ReactNode {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true" className={className}>
      <path
        d="M 8 2.5 L 12.9 5.2 V 10.8 L 8 13.5 L 3.1 10.8 V 5.2 Z"
        stroke="currentColor"
        strokeWidth="1.1"
        strokeLinejoin="round"
      />
      <path
        d="M 3.1 5.2 L 8 7.9 L 12.9 5.2 M 8 7.9 V 13.5"
        stroke="currentColor"
        strokeWidth="1.1"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  )
}

/**
 * The title as the chip and a floating panel's header show it.
 * @param props - the tab information hook.
 * @returns the compass followed by the tab's title text.
 */
export function GuideTitle({ useTabInfo }: PropsRuntime<'sidebar.right.pane.tab.title'>): ReactNode {
  const { tab } = useTabInfo()
  return (
    <>
      <CompassGlyph className={css.titleIcon} />
      {tab.title}
    </>
  )
}
