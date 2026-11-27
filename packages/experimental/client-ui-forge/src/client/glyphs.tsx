/** Lifecycle glyphs of change requests, outcome glyphs of their checks, the marks of their code hosts, and the marks of file headers. */

import type { ReactNode } from 'react'
import clsx from 'clsx'
import { IconCheckCircleFillRegular, IconRightUpOutlineRegular, LinkIconRegular } from '@deepseek-ai/dsh-client-ui-primitives/client'
import type { CheckState, ChecksRollup } from '@deepseek-ai/dsh-experimental-forge/types'
import type { ChangeRequestTone } from './status.ts'
import css from './Forge.module.css'

const BRANCH_ENDS = (
  <>
    <circle cx="4" cy="3.5" r="1.6" />
    <circle cx="4" cy="12.5" r="1.6" />
    <circle cx="12" cy="12.5" r="1.6" />
  </>
)

/** The head branch line that bends back toward the base, shared by the open and blocked shapes. */
const TOWARD_BASE = (
  <>
    <path d="M12 10.9V5.5C12 4.4 11.1 3.5 10 3.5H8.2" />
    <path d="M9.6 1.9L8 3.5L9.6 5.1" />
  </>
)

const OPEN = (
  <>
    {BRANCH_ENDS}
    <path d="M4 5.1V10.9" />
    {TOWARD_BASE}
  </>
)

const SHAPES: Record<ChangeRequestTone, ReactNode> = {
  open: OPEN,
  unknown: OPEN,
  blocked: (
    <>
      <path d="M2.6 2.1L5.4 4.9M5.4 2.1L2.6 4.9" />
      <circle cx="4" cy="12.5" r="1.6" />
      <circle cx="12" cy="12.5" r="1.6" />
      <path d="M4 5.6V10.9" />
      {TOWARD_BASE}
    </>
  ),
  draft: (
    <>
      {BRANCH_ENDS}
      <path d="M4 5.1V10.9M12 10.4V9.6M12 7.9V7.1M12 5.4V4.6" />
    </>
  ),
  merged: (
    <>
      <circle cx="4.5" cy="3.5" r="1.6" />
      <circle cx="4.5" cy="12.5" r="1.6" />
      <circle cx="11.5" cy="8" r="1.6" />
      <path d="M4.5 5.1V10.9M4.5 5.1C4.5 7 6.5 8 9.9 8" />
    </>
  ),
  closed: (
    <>
      {BRANCH_ENDS}
      <path d="M4 5.1V10.9M12 10.9V7.1M10.4 1.9L13.6 5.1M13.6 1.9L10.4 5.1" />
    </>
  ),
}

/** Center of each shape's head branch end, which a checks mark covers. */
const HEAD: Record<ChangeRequestTone, readonly [number, number]> = {
  open: [12, 12.5],
  unknown: [12, 12.5],
  blocked: [12, 12.5],
  draft: [12, 12.5],
  merged: [11.5, 8],
  closed: [12, 12.5],
}

/**
 * Draw a change request in its lifecycle shape: open, open with a cross for
 * one that needs its author, draft, merged, closed, or the open shape for an
 * unknown state.
 * @param props.tone - lifecycle state that picks the shape and, when tinted, the color.
 * @param props.tinted - whether the state picks the color; otherwise the glyph uses the current text color.
 * @param props.size - width and height in pixels, 15 by default.
 * @param props.label - accessible name; omit it for a decorative glyph.
 * @param props.checks - checks outcome drawn as a filled head branch end in its state color; omit it for the plain end.
 * @returns the SVG glyph.
 */
export function ChangeRequestGlyph({ tone, tinted = true, size = 15, label, checks }: {
  readonly tone: ChangeRequestTone
  readonly tinted?: boolean | undefined
  readonly size?: number | undefined
  readonly label?: string | undefined
  readonly checks?: Exclude<ChecksRollup, 'none'> | undefined
}): ReactNode {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.3}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={clsx(css.glyph, tinted && css.tinted)}
      data-tone={tone}
      data-forge-glyph={tone}
      {...label === undefined ? { 'aria-hidden': true } : { role: 'img', 'aria-label': label }}
    >
      {SHAPES[tone]}
      {/* Concentric with the stroked end and larger than its outer edge, so it covers that end completely. */}
      {checks !== undefined && <circle cx={HEAD[tone][0]} cy={HEAD[tone][1]} r="2.3" stroke="none" className={css.checksMark} data-checks={checks} />}
    </svg>
  )
}

const CHECK_TONE: Record<CheckState, string | undefined> = {
  success: css.pass,
  failure: css.fail,
  pending: css.running,
  neutral: undefined,
  skipped: undefined,
  cancelled: undefined,
}

/**
 * Draw the decorative outcome of one check beside its text, each inside the same ring: a check for success, a cross
 * for failure, a half fill while it runs, and a dash for neutral, skipped, and cancelled checks. The ring has the
 * radius and width of the success icon's, so mixed outcomes read as one set.
 * @param props.state - check outcome.
 * @param props.size - width and height in pixels, 16 by default.
 * @returns the glyph.
 */
export function CheckGlyph({ state, size = 16 }: { readonly state: CheckState; readonly size?: number | undefined }): ReactNode {
  return (
    <span className={clsx(css.checkGlyph, CHECK_TONE[state])} data-forge-check={state} aria-hidden="true">
      {state === 'success' ? <IconCheckCircleFillRegular size={size} /> : (
        <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
          <circle cx="8" cy="8" r="7.25" stroke="currentColor" strokeWidth={1.3} />
          {state === 'failure'
            ? <path d="M5.9 5.9L10.1 10.1M10.1 5.9L5.9 10.1" stroke="currentColor" strokeWidth={1.5} strokeLinecap="square" />
            : state === 'pending'
              ? <path d="M8 2.8A5.2 5.2 0 0 1 8 13.2Z" fill="currentColor" />
              : <path d="M5.5 8H10.5" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" />}
        </svg>
      )}
    </span>
  )
}

/** The public host whose site mark stands for each forge family, self-hosted instances included. */
const FORGE_SITE: Readonly<Record<string, string>> = { github: 'https://github.com', gitlab: 'https://gitlab.com' }

/**
 * Draw the mark of a code host on an action that opens it: the site mark of the provider's forge family, whatever the
 * host name, or the leaving arrow for a family without a mark and for no provider.
 * @param props.forge - forge family of the change request's provider, such as `github`, or null without one.
 * @param props.size - width and height in pixels, 14 by default.
 * @returns the decorative glyph.
 */
export function ForgeGlyph({ forge, size = 14 }: { readonly forge: string | null; readonly size?: number | undefined }): ReactNode {
  const site = forge === null ? undefined : FORGE_SITE[forge]
  return site === undefined ? <IconRightUpOutlineRegular size={size} /> : <LinkIconRegular kind="url" href={site} size={size} />
}

/** A file header mark the shared icons have no drawing of. */
export type FileMark = 'unstage' | 'restore' | 'unviewed'

const FILE_MARKS: Record<FileMark, ReactNode> = {
  // The horizontal stroke of the shared plus, which stages.
  unstage: <path vectorEffect="non-scaling-stroke" d="M2 8H14" />,
  restore: (
    <g strokeLinecap="round" strokeLinejoin="round">
      <path vectorEffect="non-scaling-stroke" d="M5.5 2.5L2.5 5.5L5.5 8.5" />
      <path vectorEffect="non-scaling-stroke" d="M2.5 5.5H9.5A4 4 0 0 1 9.5 13.5H6" />
    </g>
  ),
  // The ring of the shared check circle, which marks a viewed file.
  unviewed: <circle vectorEffect="non-scaling-stroke" cx="8" cy="8" r="6.5" />,
}

/**
 * Draw a decorative mark of a file header at the weight of the shared Regular icons: a minus for unstaging, an arrow
 * turning back for restoring, and the empty ring of a file that is not viewed.
 * @param props.mark - which mark to draw.
 * @returns the glyph, 16 pixels wide unless its control sizes it.
 */
export function FileMarkGlyph({ mark }: { readonly mark: FileMark }): ReactNode {
  return (
    <svg width={16} height={16} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1} aria-hidden="true" data-forge-file-mark={mark}>
      {FILE_MARKS[mark]}
    </svg>
  )
}
