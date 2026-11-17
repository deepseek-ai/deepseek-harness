/**
 * The search shared by the branch pickers: the query, the listing it read, the search field's focus, and the status a
 * menu shows instead of rows.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { Button, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { NS } from './locales.ts'

/** Milliseconds between the last keystroke of a search and the listing it reads. */
const SEARCH_DELAY_MS = 150

/** A branch picker's search while its menu is shown. */
export interface BranchSearch<T> {
  /** Text in the search field. */
  readonly query: string
  /** Change the search text; the listing is read again after a short pause. */
  readonly setQuery: (query: string) => void
  /** The last listing that arrived, or null before the first one. */
  readonly listing: RemoteResult<T> | null
  /** Read the listing again, as after a failed read. */
  readonly retry: () => void
  /** Clear the search text, as when the menu closes. */
  readonly reset: () => void
  /** The search field, which takes the keyboard once the menu shows unless the pointer is coarse. */
  readonly field: RefObject<HTMLInputElement>
}

/**
 * Read the branches of a picker while its menu is shown: at once on opening and on a retry, and after a pause while
 * the search text changes. Each new read cancels the one before; the last listing stays until the next arrives.
 * @param shown - whether the menu is shown.
 * @param list - reads the branches whose names contain the query; the signal aborts the read.
 * @returns the search state.
 */
export function useBranchSearch<T>(
  shown: boolean,
  list: (query: string, signal: AbortSignal) => Promise<RemoteResult<T>>,
): BranchSearch<T> {
  const [query, setQuery] = useState('')
  const [attempt, setAttempt] = useState(0)
  const [listing, setListing] = useState<RemoteResult<T> | null>(null)
  const field = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (!shown) return
    const controller = new AbortController()
    const timer = setTimeout(() => {
      void list(query, controller.signal).then((result) => { if (!controller.signal.aborted) setListing(result) })
    }, query === '' ? 0 : SEARCH_DELAY_MS)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [shown, query, attempt, list])
  // The portalled menu measures itself hidden before its first frame, and a hidden field cannot take the keyboard.
  // A touch screen keeps its on-screen keyboard closed until the field is tapped.
  useEffect(() => {
    if (!shown || (typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches)) return
    const frame = requestAnimationFrame(() => { field.current?.focus() })
    return () => { cancelAnimationFrame(frame) }
  }, [shown])
  const retry = useCallback(() => { setAttempt(count => count + 1) }, [])
  const reset = useCallback(() => { setQuery('') }, [])
  return { query, setQuery, listing, retry, reset, field }
}

/**
 * The status a branch menu shows instead of its rows: reading, a failed read with a retry, or no matching branch.
 * @param props - the listing, whether no row matches, the retry, the status row's class, and copy.
 * @returns the status row, or null while the menu shows rows.
 */
export function branchSearchStatus({ listing, empty, retry, className, t }: {
  readonly listing: RemoteResult<unknown> | null
  readonly empty: boolean
  readonly retry: () => void
  readonly className: string | undefined
} & PropsLocale<typeof NS>): ReactNode {
  if (listing === null) return <div className={className} role="status"><StateDot state="ongoing" />{t('diff.base.loading')}</div>
  if (!listing.ok) {
    return (
      <div className={className} role="status">
        <span>{t('toast.branchesFailed')}</span>
        <Button size="sm" variant="outline" onClick={retry}>{t('retry')}</Button>
      </div>
    )
  }
  return empty ? <div className={className}>{t('diff.base.empty')}</div> : null
}
