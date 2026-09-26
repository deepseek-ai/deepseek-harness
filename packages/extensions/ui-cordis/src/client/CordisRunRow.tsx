/** `cordis_run` card and the host seat for Package-owned interactive UI. */

import { useEffect } from 'react'
import {
  IconCodeOutlineRegular, IconInspectOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import { cordisRunCard } from './card-model.ts'
import { cordisToolViewKey } from './run-card-index.ts'
import type { CordisRunCardFace } from './slots.ts'
import { cordisVisibleStatus, type CordisVisibleStatus } from './status.ts'
import type { CordisKey } from './locales.ts'
import css from './CordisRunRow.module.css'
import { CordisPreparingRow } from './CordisPreparingRow.tsx'

/** Full Run-card props including its declared Package business-view child slot. */
export type CordisRunRowProps = ToolCallViewProps
  & InjectFace<CordisRunCardFace>
  & PropsRenderSlots<'tool.view.cordis'>
  & PropsLocale<'cordis'>

type RunReading = CordisVisibleStatus | 'awaiting-approval' | 'failed' | 'removed' | 'superseded'

const READING_LABELS = {
  idle: 'status.idle',
  'awaiting-approval': 'status.awaitingApproval',
  failed: 'status.failed',
  'client-pending': 'status.clientPending',
  running: 'status.running',
  removed: 'status.removed',
  superseded: 'status.superseded',
} as const satisfies Record<RunReading, CordisKey>

/** Render one activation result and, when eligible, its Package-owned view. */
export function CordisRunRow(props: CordisRunRowProps) {
  if (props.phase === 'preparing') return <CordisPreparingRow {...props}
    icon={<IconCodeOutlineRegular size={14} />} title={props.t('row.runTitle')}
    className={css.card} rowClassName={css.row} titleClassName={css.title} />
  return <StartedCordisRunRow {...props} />
}

function StartedCordisRunRow({
  callId, block, inspect, renderSlot, useInventory, useLoaded, useRunCards, useActiveRuns,
  onObserveRunCard, t,
}: Exclude<CordisRunRowProps, { phase: 'preparing' }>) {
  const card = cordisRunCard(block)
  const inventory = useInventory(snapshot => snapshot)
  const loaded = useLoaded(snapshot => snapshot)
  const latest = useRunCards(snapshot => snapshot)
  const activeRuns = useActiveRuns(snapshot => snapshot)
  const key = card.state === 'ok'
    && card.pluginId !== null
    && card.packageId !== null
    && card.pluginRunId !== null
    && card.seq !== null
    ? cordisToolViewKey(card.pluginId, card.packageId)
    : null
  useEffect(() => {
    if (key === null || card.seq === null || card.pluginRunId === null) return
    onObserveRunCard({ key, callId, seq: card.seq, pluginRunId: card.pluginRunId })
  }, [callId, card.pluginRunId, card.seq, key, onObserveRunCard])

  const row = card.pluginId === null
    ? undefined
    : inventory.rows.find(candidate => candidate.pluginId === card.pluginId)
  const pointer = key === null ? undefined : latest.get(key)
  const superseded = pointer !== undefined && pointer.callId !== callId && pointer.seq >= (card.seq ?? -1)
  const activity = card.pluginId === null ? undefined : activeRuns.get(card.pluginId)
  const attempt = card.pluginRunId !== null && row?.latestRun?.pluginRunId === card.pluginRunId
    ? row.latestRun
    : undefined
  const awaitingApproval = attempt?.status === 'awaiting-approval' || (card.packageId !== null
    && activity?.phase === 'awaiting-approval'
    && activity.packageId === card.packageId
    && (card.mode === null || activity.mode === card.mode))
  const reading: RunReading = card.pluginId !== null && inventory.removed.has(card.pluginId)
    ? 'removed'
    : superseded
      ? 'superseded'
      : awaitingApproval
        ? 'awaiting-approval'
        : attempt?.status === 'failed'
          ? 'failed'
          : row !== undefined && card.packageId !== null
            ? cordisVisibleStatus(row, card.packageId, loaded)
            : 'idle'
  const status = t(READING_LABELS[reading])
  const summary = card.errorSummary
    ?? (card.pluginId === null ? callId : `${card.pluginId}${card.packageId === null ? '' : ` · ${card.packageId}`}`)
  const showBusiness = reading === 'running' && key !== null
  return (
    <div
      className={css.card}
      data-tool="cordis_run"
      data-state={card.state}
      data-cordis-plugin-id={card.pluginId ?? undefined}
      data-cordis-package-id={card.packageId ?? undefined}
      data-cordis-run-id={card.pluginRunId ?? undefined}
      data-cordis-status={reading}
    >
      <div className={css.row}>
        <span className={css.icon}><IconCodeOutlineRegular size={14} /></span>
        <span className={css.title}>{t(card.mode === 'update' ? 'row.updateTitle' : 'row.runTitle')}</span>
        <span className={css.separator} aria-hidden />
        <span className={card.errorSummary === null ? css.summary : css.error}>{summary}</span>
        <span className={css.status}>{status}</span>
        {inspect !== undefined && (
          <button type="button" className={css.inspect} aria-label={t('action.inspect')} onClick={inspect}>
            <IconInspectOutlineRegular />
          </button>
        )}
      </div>
      {reading === 'removed' && <div className={css.message}>{t('run.removed')}</div>}
      {reading === 'superseded' && <div className={css.message}>{t('run.superseded')}</div>}
      {reading === 'failed' && attempt?.error !== undefined && (
        <div className={css.message}>{attempt.error.message}</div>
      )}
      {showBusiness && card.pluginId !== null && card.packageId !== null && card.pluginRunId !== null && (
        <div className={css.business} data-cordis-business-view={key}>
          {renderSlot('tool.view.cordis', {
            pluginId: card.pluginId,
            packageId: card.packageId,
            pluginRunId: card.pluginRunId,
          }, {
            entryKey: key,
            fallback: card.output === null ? null : <pre className={css.output}>{card.output}</pre>,
          })}
        </div>
      )}
      {!showBusiness && reading !== 'removed' && reading !== 'superseded' && card.output !== null && (
        <pre className={css.output}>{card.output}</pre>
      )}
    </div>
  )
}
