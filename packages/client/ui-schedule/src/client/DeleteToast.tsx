/**
 * Transient outcome notice for schedule deletions.
 *
 * Every deletion — the Tasks page detail, the session task tab, and the
 * Session-header popover — reports its settled outcome into one store, and one
 * `shell.overlay` entry renders it as the app-wide banner. The surfaces keep no
 * in-place deletion notice of their own, so an outcome outlives the panel or
 * tab that asked for it.
 */
import type { ReactNode } from 'react'
import { IconWarningOutlineRegular, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { CatalogDeleteOutcome } from './catalog-source.ts'

/** One reported deletion outcome; `seq` keys the banner so a re-show restarts it. */
export interface DeleteToastState {
  readonly kind: 'deleted' | 'deleteFailed'
  readonly seq: number
}

/** Store the deletion wiring reports into and the overlay entry reads. */
export interface DeleteToastSource {
  /** Current notice for the overlay entry, or null while none shows. */
  readonly hooks: { readonly toast: HostObservable<DeleteToastState | null> }
  /**
   * Show the notice of one settled deletion; 'pending' raises nothing because
   * the deletion already in flight reports its own outcome.
   * @param outcome - resolution of `CatalogInjected.onDelete`.
   */
  readonly report: (outcome: CatalogDeleteOutcome) => void
  /** Clear the shown notice. */
  readonly dismiss: () => void
}

/**
 * Create the one deletion-outcome store the overlay entry shows.
 * @returns the observable notice with its report and dismiss actions.
 */
export function createDeleteToastSource(): DeleteToastSource {
  let state: DeleteToastState | null = null
  let seq = 0
  const listeners = new Set<() => void>()
  const publish = (next: DeleteToastState | null): void => {
    state = next
    for (const listener of listeners) listener()
  }
  return {
    hooks: {
      toast: {
        getSnapshot: () => state,
        subscribe(listener) {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
      },
    },
    report: (outcome) => {
      if (outcome === 'pending') return
      publish({ kind: outcome === 'deleted' ? 'deleted' : 'deleteFailed', seq: ++seq })
    },
    dismiss: () => { publish(null) },
  }
}

/** Props of the `shell.overlay` entry: the notice store and localized copy. */
export type ScheduleDeleteToastProps = PropsRuntime<'shell.overlay'>
  & PropsLocale<'schedule.manager'>
  & InjectFace<Omit<DeleteToastSource, 'report'>>

/**
 * Render the current deletion notice: a success banner for a confirmed
 * deletion, a warning for one that could not be confirmed, or nothing.
 * @param props - the notice hook, its dismissal, and the locale seat.
 * @returns the banner on display, or null.
 */
export function ScheduleDeleteToast({ useToast, dismiss, t }: ScheduleDeleteToastProps): ReactNode {
  const toast = useToast(current => current)
  if (toast === null) return null
  return toast.kind === 'deleted'
    ? <Toast key={`schedule-delete-${String(toast.seq)}`} text={t('toast.deleted')} tone="success" onDone={dismiss} />
    : <Toast
      key={`schedule-delete-${String(toast.seq)}`}
      text={t('toast.deleteFailed')}
      icon={<IconWarningOutlineRegular />}
      onDone={dismiss}
    />
}
