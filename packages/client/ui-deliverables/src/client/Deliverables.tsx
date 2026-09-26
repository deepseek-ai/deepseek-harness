/** The changed-files card, shown only while the Host serves the turn's summary, and explicitly declared files for a closing turn. */
import { useEffect, useState } from 'react'
import type { TurnTailOwnerProps } from '@deepseek-ai/dsh-client-ui-chat/client'
import { Button, IconChevronDownOutlineRegular, IconChevronUpOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { GlobalStandardProps, InjectFace, PropsLocale, PropsRenderSlots, PropsRuntime, SessionStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { PresentedOpenController } from './present-open.ts'
import type { ChangesDiffStore } from './changes-diff.ts'
import type { ChangesSummaryStore } from './changes-summary.ts'
import { ChangedFiles } from './ChangedFiles.tsx'
import { changesForClosing, presentedForClosing, type ChangesTurnData, type PresentedPath } from './turn-deliverables.ts'
import type { NS } from './locales.ts'
import { changesSummaryUrl, type ChangesReviewCoordinates } from '../changes.ts'
import { presentedFileUrl } from '../presented.ts'
import { PresentedFileCard } from './PresentedFileCard.tsx'
import css from './Deliverables.module.css'

interface DeliverablesMatch { changes: ChangesTurnData | null; presented: readonly PresentedPath[] }

const COLLAPSED_PRESENTED_COUNT = 4

/** Summary reads, native-open callbacks, and shared gesture status supplied by the plugin. */
export interface DeliverablesInjected {
  hooks: {
    changesDiff: ObservableSnapshot<ReturnType<ChangesDiffStore['state']['getSnapshot']>>
    showCodeDiff: ObservableSnapshot<boolean>
    presentedOpen: ObservableSnapshot<ReturnType<PresentedOpenController['state']['getSnapshot']>>
    presentedHost: ObservableSnapshot<ReturnType<PresentedOpenController['host']['getSnapshot']>>
    changesSummary: ObservableSnapshot<ReturnType<ChangesSummaryStore['state']['getSnapshot']>>
  }
  reloadPresentedHost: PresentedOpenController['loadHost']
  loadChangesDiff: ChangesDiffStore['load']
  loadChangesSummary: ChangesSummaryStore['load']
  openPresented: PresentedOpenController['open']
  openChanged: PresentedOpenController['openChanged']
  /** Open one turn's review in the right Sidebar on the file at an index. */
  openChangesReview: (coordinates: ChangesReviewCoordinates, index: number) => void
}

/**
 * Claim turns with a change announcement or declared files.
 * @param owner - closing turn.
 * @returns matched announcement and deliveries, or null for a turn with neither.
 */
export function selectDeliverables(owner: TurnTailOwnerProps): DeliverablesMatch | null {
  const changes = changesForClosing(owner)
  const presented = presentedForClosing(owner)
  return changes === null && presented.length === 0 ? null : { changes, presented }
}

/**
 * Contribute file deliveries alongside other completed-Turn artifacts.
 * @param props - closing Turn, file actions, and localized copy.
 * @returns file rows, or null when the Turn declares none.
 */
export function DeliverablesTail(props: PropsRuntime<'conversation.chat.turnTail'> & PropsLocale<typeof NS> & InjectFace<DeliverablesInjected> & PropsRenderSlots<'deliverables.file.actions'>) {
  const matched = selectDeliverables(props)
  return matched === null ? null : <Deliverables {...props} matched={matched} />
}

/**
 * Render the changed-files card, once the Host has served the announced
 * summary and it lists a file, and shared native opening controls for declared
 * files. A summary the Host no longer serves leaves no card.
 * @param props - matched announcement and files, workspace opener, and localized copy.
 * @returns the closing turn's file rows.
 */
export function Deliverables({
  matched, openFile, t, sessionId, useSessions, openPresented, openChangesReview, usePresentedOpen, usePresentedHost,
  useChangesDiff, loadChangesDiff, useChangesSummary, reloadPresentedHost, loadChangesSummary, useShowCodeDiff, renderSlot,
}: Pick<TurnTailOwnerProps, 'openFile'> & {
  matched: DeliverablesMatch
} & PropsLocale<typeof NS> & Pick<SessionStandardProps, 'sessionId'> & Pick<GlobalStandardProps, 'useSessions'> & InjectFace<DeliverablesInjected> & PropsRenderSlots<'deliverables.file.actions'>) {
  const [expanded, setExpanded] = useState(false)
  const showCodeDiff = useShowCodeDiff(value => value)
  const cwd = useSessions(state => state.byId[sessionId]?.cwd)
  const states = usePresentedOpen(value => value)
  const host = usePresentedHost(value => value)
  const announced = showCodeDiff ? matched.changes : null
  const summary = useChangesSummary(value => announced === null ? undefined : value[changesSummaryUrl(sessionId, announced.seq)])
  useEffect(() => {
    if (announced !== null && summary === undefined) void loadChangesSummary(sessionId, announced.seq)
  }, [announced, summary, sessionId, loadChangesSummary])
  const changes = announced !== null && typeof summary === 'object' && summary.files.length > 0
    ? { seq: announced.seq, ...summary }
    : null
  const collapsible = matched.presented.length > COLLAPSED_PRESENTED_COUNT
  const presented = collapsible && !expanded
    ? matched.presented.slice(0, COLLAPSED_PRESENTED_COUNT)
    : matched.presented
  useEffect(() => {
    if (host === null) void reloadPresentedHost()
  }, [host, reloadPresentedHost])
  return <>
    {changes !== null && <ChangedFiles changes={changes} cwd={cwd} t={t}
      sessionId={sessionId} useChangesDiff={useChangesDiff} loadChangesDiff={loadChangesDiff}
      openReview={(index) => { openChangesReview({ sessionId, seq: changes.seq, turn: changes.turn }, index) }} />}
    {matched.presented.length > 0 && <div
      className={css.root}
      data-after-changes={changes !== null || undefined}
    >
      {host === 'error' && <div className={css.hostStatus}>
        <span>{t('presented.hostError')}</span>
        <Button size="sm" onClick={() => { void reloadPresentedHost() }}>{t('presented.retry')}</Button>
      </div>}
      {host !== null && host !== 'error' && !host.available && <span className={css.hostStatus}>{t('presented.unavailable')}</span>}
      <div className={css.presented} data-presented-files-row data-single={matched.presented.length === 1 ? true : undefined}>
        {presented.map(file => <PresentedFileCard key={`${file.seq}:${file.index}`} file={file} cwd={cwd}
          phase={states[presentedFileUrl(sessionId, file.seq, file.index)]}
          host={host === 'error' ? null : host} t={t}
          onPreview={() => { openFile(file.path) }}
          actions={renderSlot('deliverables.file.actions', {
            actionUrl: presentedFileUrl(sessionId, file.seq, file.index),
            available: host !== null && host !== 'error' && host.available,
            pending: states[presentedFileUrl(sessionId, file.seq, file.index)] === 'opening'
              || states[presentedFileUrl(sessionId, file.seq, file.index)] === 'revealing',
            onAction: (action, application) => openPresented(sessionId, file.seq, file.index, action, application),
          })} />)}
      </div>
      {collapsible && <button type="button" className={css.toggle}
        aria-expanded={expanded}
        aria-label={t(expanded ? 'presented.collapseAria' : 'presented.expandAria', { count: matched.presented.length })}
        onClick={() => { setExpanded(value => !value) }}>
        <span>{t(expanded ? 'presented.collapse' : 'presented.all', { count: matched.presented.length })}</span>
        {expanded ? <IconChevronUpOutlineRegular /> : <IconChevronDownOutlineRegular />}
      </button>}
    </div>}
  </>
}
