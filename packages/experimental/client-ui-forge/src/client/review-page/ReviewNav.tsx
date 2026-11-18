/** The review page's navigation row: its glyph, and the number of change requests that ask the user for a review. */

import type { ReactNode } from 'react'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { ChangeRequestGlyph } from '../glyphs.tsx'
import type { NS } from '../locales.ts'
import type { StreamSnapshot } from '../source.ts'
import css from './ReviewPage.module.css'

/**
 * Draw the change request glyph at the size the sidebar asks for; the sidebar names the row.
 * @param props - the sidebar's icon share.
 * @returns the decorative glyph.
 */
export function ReviewNavIcon({ size }: PropsRuntime<'sidebar.panellist'>): ReactNode {
  return <ChangeRequestGlyph tone="open" tinted={false} size={size} />
}

/** Business face of the navigation count. */
export interface ReviewNavCountInjected {
  /** The count stream's latest value; the renderer binds it as `useCount`. */
  readonly hooks: { readonly count: HostObservable<StreamSnapshot<number | null>> }
}

/** Full props of the navigation count. */
export type ReviewNavCountProps = PropsRuntime<'sidebar.panellist.trailing'> & InjectFace<ReviewNavCountInjected> & PropsLocale<typeof NS>

/** Largest count the row spells out; larger counts show as this number followed by `+`. */
const MAX_SHOWN = 99

/**
 * Render the number of change requests that ask the user for a review, nothing before the first count or at zero.
 * The visible number is decorative; the sentence beside it describes the row's button.
 * @param props - the count hook, the row's width state, and copy.
 * @returns the count, or null.
 */
export function ReviewNavCount({ useCount, wide, t }: ReviewNavCountProps): ReactNode {
  const count = useCount(snapshot => snapshot.state)
  if (count === null || count === 0) return null
  return (
    <span className={css.navCount} data-wide={wide ? '' : undefined}>
      <span aria-hidden="true">{count > MAX_SHOWN ? `${MAX_SHOWN}+` : count}</span>
      <span className={css.visuallyHidden}>{t('reviewPage.countAria', { count })}</span>
    </span>
  )
}
