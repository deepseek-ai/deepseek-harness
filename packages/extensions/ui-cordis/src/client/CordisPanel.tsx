/** Frame-wide dynamic Plugin inventory, approvals, versions, and lifecycle actions. */

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ButtonHTMLAttributes, ReactNode } from 'react'
import {
  IconCheckOutlineRegular, IconCloseOutlineRegular, IconCordisPluginOutlineRegular, IconPlayOutlineRegular,
  IconStopFillRegular, IconTrashOutlineRegular, StateDot, Tooltip, useDismissOnOutsidePointer,
  type StateDotState,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { CordisRunActivity } from '@deepseek-ai/dsh-cordis-client-runner/client'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type { CordisInventoryRow } from './dynamic-port.ts'
import type { CordisPanelFace } from './slots.ts'
import type { CordisKey } from './locales.ts'
import type {
  ApprovalRequestId, CordisDynamicPackageId, CordisDynamicPluginId,
} from './events.ts'
import { cordisVisibleStatus, packageOf, type CordisVisibleStatus } from './status.ts'
import css from './CordisPanel.module.css'

/** Full panel props composed by the sidebar footer-action slot. */
export type CordisPanelProps =
  PropsRuntime<'sidebar.footer.action'> & InjectFace<CordisPanelFace> & PropsLocale<'cordis'>

type PanelStatus = CordisVisibleStatus | 'awaiting-approval' | 'failed'

const STATUS_LABELS = {
  idle: 'status.idle',
  'awaiting-approval': 'status.awaitingApproval',
  'client-pending': 'status.clientPending',
  running: 'status.running',
  failed: 'status.failed',
} as const satisfies Record<PanelStatus, CordisKey>

const RENDER_FAILURE_LABELS = {
  abdicated: 'render.failedAbdicated',
  held: 'render.failedHeld',
} as const satisfies Record<'abdicated' | 'held', CordisKey>

interface RowView {
  readonly pluginId: CordisDynamicPluginId
  readonly agentId: SessionId
  readonly listed?: CordisInventoryRow
  readonly activity?: CordisRunActivity
}

function selectedPackageIdOf(
  { pluginId, listed, activity }: RowView,
  selected: Readonly<Record<string, CordisDynamicPackageId>>,
): CordisDynamicPackageId | undefined {
  const selectedPackageId = selected[pluginId]
  if (selectedPackageId !== undefined
    && listed?.packages.some(pkg => pkg.packageId === selectedPackageId)) return selectedPackageId
  return listed?.nextPackageId
    ?? listed?.currentPackageId
    ?? listed?.packages.at(-1)?.packageId
    ?? activity?.packageId
}

function visiblePanelStatus(
  view: RowView,
  selectedPackageId: CordisDynamicPackageId | undefined,
  loaded: Parameters<typeof cordisVisibleStatus>[2],
): PanelStatus {
  const { listed, activity } = view
  const latest = listed?.latestRun
  if (activity?.phase === 'awaiting-approval' || latest?.status === 'awaiting-approval') {
    return 'awaiting-approval'
  }
  if (latest?.status === 'failed' && latest.packageId === selectedPackageId) return 'failed'
  if (listed?.activeRun === undefined) return 'idle'
  return cordisVisibleStatus(listed, listed.activeRun.packageId, loaded)
}

function panelDotState(status: PanelStatus, busy: boolean): StateDotState {
  if (busy) return 'ongoing'
  switch (status) {
    case 'idle': return 'idle'
    case 'client-pending': return 'ongoing'
    case 'running': return 'done'
    case 'awaiting-approval': return 'warning'
    case 'failed': return 'error'
  }
}

function blockingFirst(rows: readonly RowView[]): readonly RowView[] {
  return [
    ...rows.filter(row => row.activity?.phase === 'awaiting-approval'),
    ...rows.filter(row => row.activity?.phase !== 'awaiting-approval'),
  ]
}

function RowAction({ label, children, ...props }: {
  label: string
  children: ReactNode
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <Tooltip label={label} side="bottom" delayMs={500}>
      <button type="button" className={css.actionButton} aria-label={label} {...props}>
        {children}
      </button>
    </Tooltip>
  )
}

function DoubleCheckIcon() {
  return (
    <span className={css.doubleCheck} aria-hidden>
      <IconCheckOutlineRegular size={12} />
      <IconCheckOutlineRegular size={12} />
    </span>
  )
}

/** Render the inventory panel and its unified footer action. */
export function CordisPanel({
  wide,
  useSessions, useInventory, useActiveRuns, useRunErrors, useLoaded, useRenderFailures,
  onApprove, onDecline, onRun, onStop, onRemove, onRefresh, t,
}: CordisPanelProps) {
  const inventory = useInventory(snapshot => snapshot)
  const activeRuns = useActiveRuns(snapshot => snapshot)
  const errors = useRunErrors(snapshot => snapshot)
  const loaded = useLoaded(snapshot => snapshot)
  const renderFailures = useRenderFailures(snapshot => snapshot)
  const current = useSessions(state => Object.values(state.byId)
    .find(session => (session.retainedBy.mainView ?? 0) > 0)?.id)
  const [open, setOpen] = useState(false)
  const [selected, setSelected] = useState<Record<string, CordisDynamicPackageId>>({})
  const [pending, setPending] = useState<ReadonlySet<CordisDynamicPluginId>>(new Set())
  const [actionErrors, setActionErrors] = useState<ReadonlyMap<CordisDynamicPluginId, string>>(new Map())
  const visibleRequests = useRef<Set<ApprovalRequestId>>(new Set())
  const rootRef = useRef<HTMLDivElement>(null)
  const [anchor, setAnchor] = useState<{ left: number; bottom: number }>()

  // The panel is position: fixed (the sidebar clips overflow), so it hugs the
  // trigger through a measured offset instead of document flow.
  useLayoutEffect(() => {
    if (!open) return
    const place = (): void => {
      const rect = rootRef.current?.getBoundingClientRect()
      if (rect !== undefined) {
        setAnchor({ left: rect.left, bottom: window.innerHeight - rect.top + 8 })
      }
    }
    place()
    window.addEventListener('resize', place)
    return () => { window.removeEventListener('resize', place) }
  }, [open])

  useDismissOnOutsidePointer(rootRef, open, setOpen)

  useEffect(() => {
    const now = new Set<ApprovalRequestId>()
    for (const activity of activeRuns.values()) {
      if (activity.phase === 'awaiting-approval') now.add(activity.requestId)
    }
    const discovered = [...now].some(requestId => !visibleRequests.current.has(requestId))
    visibleRequests.current = now
    if (discovered) setOpen(true)
  }, [activeRuns])

  useEffect(() => { onRefresh() }, [onRefresh])
  useEffect(() => { if (open) onRefresh() }, [onRefresh, open])

  const byPlugin = new Map<CordisDynamicPluginId, RowView>()
  for (const listed of inventory.rows) {
    const activity = activeRuns.get(listed.pluginId)
    byPlugin.set(listed.pluginId, {
      pluginId: listed.pluginId,
      agentId: activity?.agentId ?? listed.agentId,
      listed,
      ...activity === undefined ? {} : { activity },
    })
  }
  for (const [pluginId, activity] of activeRuns) {
    if (byPlugin.has(pluginId)) continue
    byPlugin.set(pluginId, { pluginId, agentId: activity.agentId, activity })
  }
  const all = [...byPlugin.values()]
  const mine = blockingFirst(all.filter(row => current !== undefined && row.agentId === current))
  const theirs = blockingFirst(all.filter(row => current === undefined || row.agentId !== current))
  const approvals = [...activeRuns.values()].filter(activity => activity.phase === 'awaiting-approval').length
  const running = all.filter(view => visiblePanelStatus(
    view,
    selectedPackageIdOf(view, selected),
    loaded,
  ) === 'running').length

  if (all.length === 0) return null

  const runAction = async (pluginId: CordisDynamicPluginId, action: () => Promise<void | { ok: boolean; message?: string }>) => {
    if (pending.has(pluginId)) return
    setPending(currentPending => new Set(currentPending).add(pluginId))
    setActionErrors((currentErrors) => {
      const next = new Map(currentErrors)
      next.delete(pluginId)
      return next
    })
    try {
      const result = await action()
      if (result !== undefined && !result.ok) {
        setActionErrors(currentErrors => new Map(currentErrors).set(pluginId, result.message ?? 'operation failed'))
      }
    } catch (error) {
      setActionErrors(currentErrors => new Map(currentErrors).set(
        pluginId,
        error instanceof Error ? error.message : String(error),
      ))
    } finally {
      setPending((currentPending) => {
        const next = new Set(currentPending)
        next.delete(pluginId)
        return next
      })
      onRefresh()
    }
  }

  const renderRow = (view: RowView) => {
    const { pluginId, listed, activity } = view
    const selectedPackageId = selectedPackageIdOf(view, selected)
    const selectedPackage = listed !== undefined && selectedPackageId !== undefined
      ? packageOf(listed, selectedPackageId)
      : undefined
    const activePackage = listed?.activeRun === undefined
      ? undefined
      : packageOf(listed, listed.activeRun.packageId)
    const name = selectedPackage?.name
      ?? (activity?.phase === 'awaiting-approval' ? activity.name : pluginId)
    const purpose = selectedPackage?.purpose
      ?? (activity?.phase === 'awaiting-approval' ? activity.purpose : '')
    const latest = listed?.latestRun
    const awaiting = activity?.phase === 'awaiting-approval'
      ? activity.requestId
      : latest?.status === 'awaiting-approval' ? latest.approvalRequestId : undefined
    const status = visiblePanelStatus(view, selectedPackageId, loaded)
    const busy = pending.has(pluginId) || activity?.phase === 'orchestrating'
    const failure = errors.get(pluginId)
    const hostFailure = latest?.status === 'failed' ? latest.error : undefined
    const renderFailure = renderFailures.get(pluginId)
    const actionError = actionErrors.get(pluginId)
    const nextPackageId = listed?.nextPackageId !== undefined
      && listed.nextPackageId !== listed.currentPackageId ? listed.nextPackageId : undefined
    const currentPackageId = listed?.currentPackageId
    const runMode = listed?.currentPackageId !== undefined
      && selectedPackageId !== listed.currentPackageId ? 'update' as const : 'run' as const

    return (
      <li
        key={pluginId}
        className={css.row}
        data-cordis-row={pluginId}
        data-cordis-status={status}
        data-cordis-awaiting={awaiting !== undefined || undefined}
      >
        <div className={css.rowHead}>
          <span className={css.rowId}>{pluginId}</span>
          <span className={css.rowName}>{name}</span>
          <span className={css.rowStatus}>
            <StateDot state={panelDotState(status, busy)} />
            <span>{t(STATUS_LABELS[status])}</span>
          </span>
        </div>
        {listed !== undefined && listed.packages.length > 1 && selectedPackageId !== undefined && (
          <label className={css.versionPicker}>
            <span>{t('panel.version')}</span>
            <select
              value={selectedPackageId}
              disabled={busy}
              onChange={(event) => {
                setSelected(currentSelected => ({
                  ...currentSelected,
                  [pluginId]: event.target.value as CordisDynamicPackageId,
                }))
              }}
            >
              {listed.packages.map(pkg => (
                <option key={pkg.packageId} value={pkg.packageId}>{`${pkg.name} · ${pkg.packageId}`}</option>
              ))}
            </select>
          </label>
        )}
        <div className={css.rowDetail}>
          <span className={css.rowPurpose}>{purpose}</span>
          <div className={css.rowActions}>
            {awaiting !== undefined && (
              <>
                <RowAction
                  label={t('action.approveOnce')}
                  data-cordis-approve={awaiting}
                  disabled={busy}
                  onClick={() => { void runAction(pluginId, async () => {
                    await onApprove(awaiting, false)
                    setOpen(false)
                  }) }}
                >
                  <IconCheckOutlineRegular size={14} />
                </RowAction>
                <RowAction
                  label={t('action.approvePlugin')}
                  data-cordis-approve-plugin={awaiting}
                  disabled={busy}
                  onClick={() => { void runAction(pluginId, async () => {
                    await onApprove(awaiting, true)
                    setOpen(false)
                  }) }}
                >
                  <DoubleCheckIcon />
                </RowAction>
                <RowAction
                  label={t('action.decline')}
                  data-cordis-decline={awaiting}
                  disabled={busy}
                  onClick={() => { void runAction(pluginId, async () => {
                    await onDecline(awaiting)
                    setOpen(false)
                  }) }}
                >
                  <IconCloseOutlineRegular size={14} />
                </RowAction>
              </>
            )}
            {awaiting === undefined && listed !== undefined
              && selectedPackageId !== undefined && listed.activeRun === undefined && (
              <RowAction
                label={t('action.run')}
                data-cordis-switch="run"
                disabled={busy}
                onClick={() => { void runAction(pluginId, () => onRun({
                  agentId: listed.agentId,
                  pluginId,
                  packageId: selectedPackageId,
                  mode: runMode,
                  hasClientHalf: selectedPackage?.hasClientHalf === true,
                })) }}
              >
                <IconPlayOutlineRegular size={14} />
              </RowAction>
            )}
            {awaiting === undefined && listed !== undefined && listed.activeRun !== undefined
              && selectedPackageId !== listed.activeRun.packageId && selectedPackage !== undefined && (
              <RowAction
                label={t('action.run')}
                data-cordis-switch="run"
                disabled={busy}
                onClick={() => { void runAction(pluginId, () => onRun({
                  agentId: listed.agentId,
                  pluginId,
                  packageId: selectedPackage.packageId,
                  mode: runMode,
                  hasClientHalf: selectedPackage.hasClientHalf,
                })) }}
              >
                <IconPlayOutlineRegular size={14} />
              </RowAction>
            )}
            {awaiting === undefined && listed !== undefined && listed.activeRun !== undefined && status === 'client-pending'
              && activePackage !== undefined && selectedPackageId === listed.activeRun.packageId && (
              <RowAction
                label={t('action.run')}
                data-cordis-switch="run"
                disabled={busy}
                onClick={() => { void runAction(pluginId, () => onRun({
                  agentId: listed.agentId,
                  pluginId,
                  packageId: activePackage.packageId,
                  mode: 'run',
                  hasClientHalf: true,
                })) }}
              >
                <IconPlayOutlineRegular size={14} />
              </RowAction>
            )}
            {awaiting === undefined && listed !== undefined && listed.activeRun !== undefined && (
              <RowAction
                label={t('action.stop')}
                data-cordis-switch="stop"
                disabled={busy}
                onClick={() => { void runAction(pluginId, () => onStop(listed.agentId, pluginId)) }}
              >
                <IconStopFillRegular size={14} />
              </RowAction>
            )}
            {awaiting === undefined && listed !== undefined && (
              <RowAction
                label={t('action.remove')}
                data-cordis-remove={pluginId}
                disabled={busy}
                onClick={() => { void runAction(pluginId, () => onRemove(listed.agentId, pluginId)) }}
              >
                <IconTrashOutlineRegular size={14} />
              </RowAction>
            )}
          </div>
        </div>
        {awaiting === undefined && nextPackageId !== undefined && listed !== undefined && (
          <div className={css.transition}>
            <span>{currentPackageId === undefined ? '' : t('panel.current', { packageId: currentPackageId })}</span>
            <span>{t('panel.next', { packageId: nextPackageId })}</span>
            <div className={css.transitionActions}>
              <button
                type="button"
                disabled={busy}
                onClick={() => { void runAction(pluginId, () => onRun({
                  agentId: listed.agentId,
                  pluginId,
                  packageId: nextPackageId,
                  mode: currentPackageId === undefined ? 'run' : 'update',
                  hasClientHalf: packageOf(listed, nextPackageId)?.hasClientHalf === true,
                })) }}
              >{t('action.retry')}</button>
              {currentPackageId !== undefined && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => { void runAction(pluginId, () => onRun({
                    agentId: listed.agentId,
                    pluginId,
                    packageId: currentPackageId,
                    mode: 'run',
                    hasClientHalf: packageOf(listed, currentPackageId)?.hasClientHalf === true,
                  })) }}
                >{t('action.rollback')}</button>
              )}
            </div>
          </div>
        )}
        {failure !== undefined && (
          <div className={css.rowError} role="alert">{`${failure.message} (${failure.reason})`}</div>
        )}
        {failure === undefined && hostFailure !== undefined && (
          <div className={css.rowError} role="alert">{`${hostFailure.message} (${hostFailure.phase})`}</div>
        )}
        {actionError !== undefined && <div className={css.rowError} role="alert">{actionError}</div>}
        {renderFailure !== undefined && (
          <div
            className={css.rowError}
            role="alert"
            data-cordis-render-failure={renderFailure.slot}
            data-cordis-render-abdicated={renderFailure.abdicated || undefined}
          >
            {`${t(RENDER_FAILURE_LABELS[renderFailure.abdicated ? 'abdicated' : 'held'], {
              slot: renderFailure.slot,
            })} ${renderFailure.message}`}
          </div>
        )}
        {activePackage !== undefined && activePackage.packageId !== selectedPackageId && (
          <span className={css.activeVersion}>{`${t('status.running')}: ${activePackage.name} · ${activePackage.packageId}`}</span>
        )}
      </li>
    )
  }

  return (
    <div ref={rootRef} className={wide ? css.layer : `${css.layer} ${css.rail}`}>
      {open && anchor !== undefined && (
        <section className={css.panel} style={anchor} data-cordis-panel aria-label={t('panel.title')}>
          <header className={css.header}>
            <span className={css.title}>{t('panel.title')}</span>
          </header>
          <div className={css.body}>
            {inventory.error !== undefined && (
              <p className={css.readError} role="alert">{t('panel.readFailed', { message: inventory.error })}</p>
            )}
            {!inventory.read && inventory.error === undefined && <p className={css.note}>{t('panel.loading')}</p>}
            {inventory.read && all.length === 0 && <p className={css.note}>{t('panel.empty')}</p>}
            {mine.length > 0 && (
              <section>
                <h3 className={css.group}>{t('panel.group.current')}</h3>
                <ul className={css.rows}>{mine.map(renderRow)}</ul>
              </section>
            )}
            {theirs.length > 0 && (
              <section>
                <h3 className={css.group}>{t('panel.group.others')}</h3>
                <ul className={css.rows}>{theirs.map(renderRow)}</ul>
              </section>
            )}
          </div>
        </section>
      )}
      <div className={css.footerButtons}>
        <button
          type="button"
          className={css.badge}
          data-cordis-badge={all.length}
          data-cordis-approval-badge={approvals}
          data-active={approvals > 0 || undefined}
          aria-label={t('panel.plugins.aria')}
          aria-expanded={open}
          onClick={() => { setOpen(value => !value) }}
        >
          <IconCordisPluginOutlineRegular size={wide ? 16 : 18} />
          {wide && (
            <>
              <span className={css.badgeLabel}>{t('panel.trigger')}</span>
              <span className={css.badgeCount}>{t('panel.runningCount', { count: running })}</span>
            </>
          )}
        </button>
      </div>
    </div>
  )
}
