import {
  useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent,
} from 'react'
import { createPortal } from 'react-dom'
import {
  IconClockOutlineRegular,
  IconTrashOutlineRegular,
  useAnchoredPosition,
  useDismissOnOutsidePointer,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ScheduleId } from '@deepseek-ai/dsh-schedule/client'
import type { CatalogInjected } from './catalog-source.ts'
import { NS } from './locales.ts'
import {
  formatScheduleFrequency, nextRunParts, orderScheduleRecords, taskName,
} from './schedule-format.ts'
import css from './ScheduleCatalogAction.module.css'

/** Full props for the Session-header Schedule catalog action. */
export type ScheduleCatalogActionProps =
  PropsRuntime<'conversation.session.header.utilities'> & PropsLocale<typeof NS> & InjectFace<CatalogInjected & {
    /**
     * Show one task's detail in the right Sidebar for this entry's Session.
     * @param id - Task chosen by the Session entry.
     */
    readonly openTaskDetail: (id: ScheduleId) => void
  }>

const SECOND_MS = 1_000
const MEASURE_STYLE: CSSProperties = { visibility: 'hidden', left: 0, top: 0 }

/** Current-Session reminder catalog with durable deletion. */
export function ScheduleCatalogAction({
  useSession, useCatalog, onDelete, onRetry, openTaskDetail, t,
}: ScheduleCatalogActionProps) {
  const openState = useSession(snapshot => snapshot.openState)
  const catalogState = useCatalog(value => value)
  const { records, status, deleting } = catalogState
  const visible = openState === 'open'
  const [open, setOpen] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const catalogRef = useRef<HTMLUListElement>(null)
  const catalogPosition = useAnchoredPosition({
    open,
    anchorRef: triggerRef,
    panelRef: catalogRef,
    side: 'bottom',
    gap: 5,
    margin: 16,
  })

  useDismissOnOutsidePointer(rootRef, open, setOpen, catalogRef)

  useEffect(() => {
    if (!open) return
    setNow(Date.now())
    const timer = setInterval(() => { setNow(Date.now()) }, SECOND_MS)
    return () => { clearInterval(timer) }
  }, [open])

  useEffect(() => {
    if (visible || !open) return
    setOpen(false)
  }, [visible, open])

  const rows = useMemo(() => orderScheduleRecords(records, now), [records, now])

  if (!visible) return null
  // Show the entry only once it has something to open, or a failed read to
  // retry. An empty first read must not mount a chip that the authoritative
  // answer then removes, which reads as a flash in the header.
  if (records.length === 0 && status !== 'error') return null

  // The entry is icon-only, so its accessible name is the only place the
  // reminder count reaches assistive technology. A refresh republishes
  // `loading` while retaining the rows it already lists, so the count follows
  // the known records rather than the read state: the label may go generic only
  // before the first successful read, when there is no count to name.
  const known = records.length
  const triggerLabel = known === 0
    ? t('trigger.label')
    : t(known === 1 ? 'trigger.one' : 'trigger.other', { count: known })
  // One task has no list to choose from, so its entry opens the detail directly
  // once the read settles. A refresh republishes `loading` while retaining the
  // rows, so the entry stays expandable for that read: the popover shows the
  // loading row above the records it already lists.
  const soleTask = status === 'ready' && records.length === 1 ? records[0] : undefined
  const expandable = soleTask === undefined || open
  const toggleCatalog = (): void => {
    setNow(Date.now())
    setOpen(current => !current)
  }
  const openTask = (id: ScheduleId): void => {
    setOpen(false)
    openTaskDetail(id)
  }
  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key !== 'Escape' || !open) return
    event.preventDefault()
    setOpen(false)
    triggerRef.current?.focus()
  }
  const trigger = (
    <button
      ref={triggerRef}
      type="button"
      className={css.trigger}
      data-schedule-reminder-entry=""
      aria-expanded={expandable ? open : undefined}
      aria-label={triggerLabel}
      onClick={() => {
        if (expandable) {
          toggleCatalog()
          return
        }
        setNow(Date.now())
        openTask(soleTask.id)
      }}
    >
      <IconClockOutlineRegular size={16} />
    </button>
  )
  const catalog = open
    ? createPortal((
      <ul
        ref={catalogRef}
        className={css.menu}
        style={catalogPosition ?? MEASURE_STYLE}
        aria-label={t('list.aria')}
        onKeyDown={onKeyDown}
      >
        {status === 'loading' && <li className={css.row} role="status">{t('list.loading')}</li>}
        {status === 'error' && <li className={css.row}>
          <span role="alert">{t('list.error')}</span>
          <button type="button" onClick={() => { void onRetry() }}>{t('list.retry')}</button>
        </li>}
        {rows.map((record) => {
          const overdue = Date.parse(record.scheduledAt) <= now
          // One pair per row: both halves come from this one call.
          const nextRun = nextRunParts(record.scheduledAt, t('time.locale'), now, t)
          return (
            <li
              key={record.id}
              className={overdue ? `${css.row} ${css.rowTask} ${css.rowOverdue}` : `${css.row} ${css.rowTask}`}
            >
              <span className={css.body}>
                <button
                  type="button"
                  className={css.openButton}
                  aria-label={t('list.open', { title: taskName(record) })}
                  onClick={() => { openTask(record.id) }}
                >
                  <span className={css.title}>{taskName(record)}</span>
                </button>
                <span
                  className={overdue ? `${css.metadata} ${css.metadataOverdue}` : css.metadata}
                >
                  <span>{formatScheduleFrequency(record, t)}</span>
                </span>
                {/* The next target states its own line instead of trailing the
                    frequency: one long weekday rule wraps, and the rows then keep
                    their names and actions on the same lines. */}
                <span className={overdue ? `${css.nextRun} ${css.metadataOverdue}` : css.nextRun}>
                  <span>{`${t('list.nextRun')} `}</span>
                  {/* The list rows and the detail both state the local stamp
                      first; the popover's clock only refreshes the parenthesized
                      distance, which ticks while it is open instead of freezing
                      at the moment the list opened. */}
                  <time dateTime={record.scheduledAt}>{nextRun.absolute}</time>
                  <span className={css.nextRunRelative}>{nextRun.relative}</span>
                </span>
              </span>
              <button
                type="button"
                className={css.deleteButton}
                aria-label={t('delete.label', { title: taskName(record) })}
                title={t(deleting.includes(record.id) ? 'delete.pending' : 'delete.action')}
                disabled={deleting.includes(record.id)}
                onClick={() => { void onDelete(record.id) }}
              >
                <IconTrashOutlineRegular size={14} />
              </button>
            </li>
          )
        })}
      </ul>
    ), document.body)
    : null

  return (
    <div ref={rootRef} className={css.root} onKeyDown={onKeyDown}>
      {trigger}
      {catalog}
    </div>
  )
}
