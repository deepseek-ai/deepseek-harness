/** Lifecycle glyphs of change requests and outcome glyphs of their checks. */

import type { ReactNode } from 'react'
import clsx from 'clsx'
import { IconCheckCircleFillRegular, IconCloseCircleFillRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CheckState } from '@deepseek-ai/dsh-experimental-forge/types'
import type { ChangeRequestTone } from './status.ts'
import css from './ForgeTab.module.css'

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
    <path d="M12 10.9V6.6C12 5.5 11.1 4.6 10 4.6H8.2" />
    <path d="M9.6 3L8 4.6L9.6 6.2" />
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
      <path d="M4 5.1V10.9M12 10.9V8.6M10.4 3.2L13.6 6.4M13.6 3.2L10.4 6.4" />
    </>
  ),
}

/**
 * Draw a change request in its lifecycle shape: open, open with a cross for
 * one that needs its author, draft, merged, closed, or the open shape for an
 * unknown state.
 * @param props.tone - lifecycle state that picks the shape and, when tinted, the color.
 * @param props.tinted - whether the state picks the color; otherwise the glyph uses the current text color.
 * @param props.size - width and height in pixels, 15 by default.
 * @param props.label - accessible name; omit it for a decorative glyph.
 * @returns the SVG glyph.
 */
export function ChangeRequestGlyph({ tone, tinted = true, size = 15, label }: {
  readonly tone: ChangeRequestTone
  readonly tinted?: boolean | undefined
  readonly size?: number | undefined
  readonly label?: string | undefined
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
 * Draw the decorative outcome of one check beside its text: a filled circle
 * for success or failure, a half-filled ring while it runs, and an empty ring
 * for neutral, skipped, and cancelled checks.
 * @param props.state - check outcome.
 * @param props.size - width and height in pixels, 16 by default.
 * @returns the glyph.
 */
export function CheckGlyph({ state, size = 16 }: { readonly state: CheckState; readonly size?: number | undefined }): ReactNode {
  const running = state === 'pending'
  return (
    <span className={clsx(css.checkGlyph, CHECK_TONE[state])} data-forge-check={state} aria-hidden="true">
      {state === 'success' && <IconCheckCircleFillRegular size={size} />}
      {state === 'failure' && <IconCloseCircleFillRegular size={size} />}
      {state !== 'success' && state !== 'failure' && (
        <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
          <circle cx="8" cy="8" r="6.25" stroke="currentColor" strokeWidth={1.5} />
          {running
            ? <path d="M8 3.5A4.5 4.5 0 0 1 8 12.5Z" fill="currentColor" />
            : <path d="M5.5 8H10.5" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" />}
        </svg>
      )}
    </span>
  )
}
