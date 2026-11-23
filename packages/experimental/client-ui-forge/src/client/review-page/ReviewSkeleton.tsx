/**
 * Skeletons of the review page's detail, drawn while a change request, its description, or its activity is read.
 * Each row is as tall as the content it stands for, so the content replaces it without moving what follows.
 */

import type { ReactNode } from 'react'
import clsx from 'clsx'
import loading from '../ChangesLoading.module.css'
import css from './ReviewPage.module.css'

/** Widths of the description's lines in percent; zero is the gap between two paragraphs. */
const DESCRIPTION_LINES = [96, 100, 88, 54, 0, 92, 70, 38] as const

/** Rows of each block of the status column, as the width of each row's text in percent; a headed block has a caption row. */
const STATUS_BLOCKS: readonly { readonly head: boolean; readonly rows: readonly number[] }[] = [
  { head: false, rows: [58] },
  { head: true, rows: [46, 62, 40] },
  { head: true, rows: [34, 30] },
  { head: false, rows: [28] },
]

function Fill({ className, width }: { readonly className?: string | undefined; readonly width?: string | undefined }): ReactNode {
  return <span className={clsx(loading.fill, className)} style={width === undefined ? undefined : { width }} />
}

function Lines({ widths }: { readonly widths: readonly number[] }): ReactNode {
  return (
    <div className={css.skeletonLines}>
      {widths.map((width, index) => width === 0 ? <i key={index} /> : <Fill key={index} width={`${width}%`} />)}
    </div>
  )
}

function Row({ width, timed = false }: { readonly width: number; readonly timed?: boolean }): ReactNode {
  return (
    <div className={css.skeletonRow}>
      <Fill className={css.skeletonGlyph} />
      <Fill className={css.skeletonBar} width={`${width}%`} />
      {timed && <Fill className={css.skeletonTime} />}
    </div>
  )
}

/**
 * Draw the title, the line under it, and the tabs of a change request that is not read yet.
 * @returns the three rows, hidden from assistive technology.
 */
export function HeaderSkeleton(): ReactNode {
  return (
    <>
      <div className={css.skeletonTitle} aria-hidden="true"><Fill /></div>
      <div className={css.skeletonDetailMeta} aria-hidden="true"><Fill /></div>
      <div className={css.tabs} aria-hidden="true">
        {[0, 1, 2].map(tab => <span key={tab} className={css.skeletonTab}><Fill /></span>)}
      </div>
    </>
  )
}

/**
 * Draw the lines of a description that is not read yet.
 * @returns the lines, hidden from assistive technology.
 */
export function DescriptionSkeleton(): ReactNode {
  return <div aria-hidden="true" data-forge-review-skeleton="description"><Lines widths={DESCRIPTION_LINES} /></div>
}

/**
 * Draw the rows of an activity that is not read yet: two lines, a comment card, and one more line.
 * @returns the rows, hidden from assistive technology.
 */
export function ActivitySkeleton(): ReactNode {
  return (
    <div className={css.activityLines} aria-hidden="true" data-forge-review-skeleton="activity">
      <Row width={34} timed />
      <Row width={52} timed />
      <div className={css.activityComment}>
        <div className={css.activityCommentHead}>
          <Fill className={css.skeletonAvatar} />
          <Fill className={css.skeletonBar} width="96px" />
        </div>
        <Lines widths={[94, 60]} />
      </div>
      <Row width={40} timed />
    </div>
  )
}

/**
 * Draw the blocks of a status column that is not read yet.
 * @returns the blocks, hidden from assistive technology.
 */
export function StatusSkeleton(): ReactNode {
  return (
    <aside className={css.facts} aria-hidden="true" data-forge-review-skeleton="status">
      {STATUS_BLOCKS.map((block, index) => (
        <div key={index} className={css.statusSection}>
          {block.head && (
            <div className={css.statusHead}><Fill className={css.skeletonBar} width="36px" /><Fill className={css.skeletonSummary} /></div>
          )}
          <div className={clsx(css.statusList, !block.head && css.skeletonHeadless)}>
            {block.rows.map((width, row) => <Row key={row} width={width} />)}
          </div>
        </div>
      ))}
    </aside>
  )
}
