/** Lazy saved delivery pages owned by the selected task's mounted records view. */
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import {
  Button, IconChevronDownOutlineRegular, IconChevronUpOutlineRegular, IconClockOutlineRegular, IconInfoOutlineRegular,
  IconWarningOutlineRegular, StateDot, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ScheduleDeliveryHistoryRequest, ScheduleDeliveryHistoryResult } from '@deepseek-ai/dsh-schedule/client'
import { formatScheduleNextRun } from './schedule-format.ts'
import css from './TaskManagerPage.module.css'

/** Read saved records without opening or activating the original Session. */
export interface DeliveryHistoryInjected {
  /**
   * Read a newest-first page for the exact task and Session.
   * @param request - Task binding, required page size, and optional older-page cursor.
   * @returns Remote success or failure; transport exceptions may reject the promise.
   */
  readonly loadHistory: (request: ScheduleDeliveryHistoryRequest) => Promise<RemoteResult<ScheduleDeliveryHistoryResult>>
}

type Page = Extract<ScheduleDeliveryHistoryResult, { records: unknown }>
type Cursor = ScheduleDeliveryHistoryRequest['before']
type Failure = { key: 'delivery.error' | 'delivery.notFound' | 'delivery.cursorError'; before: Cursor }
type Props = DeliveryHistoryInjected & PropsLocale<'schedule.manager'> & {
  id: ScheduleDeliveryHistoryRequest['id']
  sessionId: ScheduleDeliveryHistoryRequest['sessionId']
  latestMessageId: Cursor
  /** IANA zone of the task's own wall-clock rule; undefined for a one-shot or interval task. */
  timeZone?: string | undefined
}

/**
 * Render one saved prompt clamped to two lines; the toggle appears only while the clamp hides text.
 * Width changes re-measure a collapsed prompt; an expanded prompt keeps its toggle until collapsed.
 * @param props - Saved prompt text and locale.
 * @returns The prompt paragraph and, when its text exceeds two lines, the expand or collapse toggle.
 */
function SavedPrompt({ prompt, t }: { prompt: string } & PropsLocale<'schedule.manager'>) {
  const ref = useRef<HTMLParagraphElement>(null)
  const id = useId()
  const [expanded, setExpanded] = useState(false)
  const [clamped, setClamped] = useState(false)
  useLayoutEffect(() => {
    if (expanded) return
    const paragraph = ref.current as HTMLParagraphElement
    const measure = () => { setClamped(paragraph.scrollHeight > paragraph.clientHeight) }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(paragraph)
    return () => { observer.disconnect() }
  }, [expanded, prompt])
  return <>
    <p ref={ref} id={id} className={css.savedPrompt} data-expanded={expanded || undefined}>{prompt}</p>
    {clamped && <button type="button" className={css.savedPromptToggle} aria-expanded={expanded} aria-controls={id}
      onClick={() => { setExpanded(open => !open) }}>
      {t(expanded ? 'delivery.collapse' : 'delivery.expand')}
      {expanded ? <IconChevronUpOutlineRegular size={14} /> : <IconChevronDownOutlineRegular size={14} />}
    </button>}
  </>
}

/**
 * Render immutable saved deliveries; the parent keys this view by task and Session.
 * Refreshes supersede pending older pages, and unmount ignores both late outcomes.
 * @param props - Exact task binding, latest receipt identity, Remote callback, task zone, and locale.
 * @returns Saved records and explicit loading, failure, and pagination actions.
 */
export function DeliveryHistory({ id, sessionId, latestMessageId, timeZone, loadHistory, t }: Props) {
  const [page, setPage] = useState<Page>()
  const [loading, setLoading] = useState(true)
  const [failure, setFailure] = useState<Failure>()
  const [retentionOpen, setRetentionOpen] = useState(false)
  const retentionId = useId()
  const request = useRef({ epoch: 0, pending: false })
  const load = useCallback(async (before?: Cursor): Promise<void> => {
    if (request.current.pending) return
    request.current.pending = true
    const epoch = ++request.current.epoch
    setLoading(true)
    setFailure(undefined)
    let result: RemoteResult<ScheduleDeliveryHistoryResult>
    try {
      result = await loadHistory({ id, sessionId, limit: 20, ...(before === undefined ? {} : { before }) })
    } catch (_error: unknown) {
      // Transport exceptions use the same localized retry as Remote failures.
      if (epoch !== request.current.epoch) return
      request.current.pending = false
      setLoading(false)
      setFailure({ key: 'delivery.error', before })
      return
    }
    if (epoch !== request.current.epoch) return
    request.current.pending = false
    setLoading(false)
    if (!result.ok) {
      setFailure({ key: 'delivery.error', before })
    } else if ('code' in result.value) {
      setFailure({ key: result.value.code === 'schedule_not_found' ? 'delivery.notFound' : 'delivery.cursorError', before: undefined })
    } else {
      const next = result.value
      setPage((previous) => {
        if (before === undefined || previous === undefined) return next
        const seen = new Set(previous.records.map(record => record.messageId))
        const records = [...previous.records]
        for (const record of next.records) {
          if (!seen.has(record.messageId)) {
            seen.add(record.messageId)
            records.push(record)
          }
        }
        return { ...next, records }
      })
    }
  }, [id, sessionId, loadHistory])

  useEffect(() => {
    void load()
    return () => { request.current.epoch++; request.current.pending = false }
  }, [load, latestMessageId])

  const formatOccurrence = (value: string): string => formatScheduleNextRun(value, t('time.locale'), timeZone)
  const hasRecords = page !== undefined && page.records.length > 0
  return <div className={css.deliveryHistory} aria-busy={loading}>
    <div className={css.detailScroll}>
      {loading && !hasRecords && <div className={css.empty} role="status" aria-label={t('delivery.loading')}>
        <StateDot state="ongoing" />
      </div>}
      {/* The compact form concerns records already on screen; a failure with
          nothing loaded centers itself in the panel. */}
      {failure !== undefined && (hasRecords
        ? <div className={css.notice}>
          <p role="alert">{t(failure.key)}</p>
          <Button variant="outline" size="sm" onClick={() => { void load(failure.before) }}>
            {t(failure.key === 'delivery.cursorError' ? 'delivery.refresh' : 'delivery.retry')}
          </Button>
        </div>
        : <div className={css.empty}>
          <IconWarningOutlineRegular size={24} className={css.emptyGlyph} />
          <p role="alert" className={css.emptyTitle}>{t(failure.key)}</p>
          <Button variant="outline" className={css.emptyAction} onClick={() => { void load(failure.before) }}>
            {t(failure.key === 'delivery.cursorError' ? 'delivery.refresh' : 'delivery.retry')}
          </Button>
        </div>)}
      {!loading && failure === undefined && page?.records.length === 0
        && <div className={css.empty} role="status">
          <IconClockOutlineRegular size={24} className={css.emptyGlyph} />
          <h3>{t('delivery.empty')}</h3>
        </div>}
      {page?.records.map(record => <section key={record.messageId} className={css.delivery} aria-label={t('delivery.label')}>
        <IconClockOutlineRegular className={css.deliveryGlyph} />
        <div className={css.deliveryBody}>
          <div className={css.deliveryHead}>
            <time className={css.deliveryTime} dateTime={record.scheduledAt}>{formatOccurrence(record.scheduledAt)}</time>
          </div>
          {record.prompt !== undefined && <SavedPrompt prompt={record.prompt} t={t} />}
        </div>
      </section>)}
      {page?.nextBefore !== undefined && failure === undefined && <Button variant="outline" disabled={loading}
        onClick={() => { void load(page.nextBefore) }}>
        {t('delivery.loadMore')}
      </Button>}
    </div>
    {hasRecords && page.earlierRecordsPruned && page.nextBefore === undefined && !loading && failure === undefined
      && <footer className={css.retentionEnd}>
        <div className={css.retentionLine}>
          <span>{t('delivery.pruned')}</span>
          <Tooltip label={t('delivery.retention')} side="top" portal>
            <button type="button" className={css.retentionInfo}
              aria-label={t('delivery.retention')} aria-expanded={retentionOpen} aria-controls={retentionId}
              onClick={() => { setRetentionOpen(open => !open) }}>
              <IconInfoOutlineRegular size={14} />
            </button>
          </Tooltip>
        </div>
        {retentionOpen && <div id={retentionId} className={css.retentionRule}>
          <p>{t('delivery.retentionBounds', { days: page.retention.days, records: page.retention.records })}</p>
          <p>{t('delivery.retentionExplanation')}</p>
        </div>}
      </footer>}
  </div>
}
