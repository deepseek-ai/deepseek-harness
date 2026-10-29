/** Cross-session retained reminders with local search and selection. */
import { useEffect, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import {
  Button, IconClockOutlineRegular, IconCloseOutlineRegular, IconEllipsisOutlineRegular, IconPlusOutlineRegular,
  IconSearchOutlineRegular, IconTrashOutlineRegular, IconChevronDownOutlineRegular, IconEditOutlineRegular,
  Input, Menu, MenuItemButton, Modal, ReferenceIconRegular, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { ScheduleId, ScheduleCatalogEntry, ScheduleCreateRequest } from '@deepseek-ai/dsh-schedule/client'
import { TaskCreateDialog, type TaskCreateOutcome } from './TaskCreateDialog.tsx'
import { projectChoices } from './TaskEditorFields.tsx'
import { taskNextRunAt, taskSessionId } from './task-record.ts'
import type { CatalogSnapshot } from './catalog-source.ts'
import { CatalogFeedback } from './CatalogFeedback.tsx'
import { TaskDetail, useTaskDetail, type TaskDetailInjected } from './TaskDetail.tsx'
import { useRelativeClock } from './relative-clock.ts'
import { formatScheduleFrequency, nextRunParts, taskName, zoneLabel } from './schedule-format.ts'
import type { FrequencyZone } from './schedule-format.ts'
import { ScheduleEmptyIllustration } from './ScheduleEmptyIllustration.tsx'
import css from './TaskManagerPage.module.css'

/** Injected catalog and task actions for the management page. */
export interface TaskManagerInjected extends TaskDetailInjected {
  /** Host task catalog with its query and deletion state. */
  readonly hooks: { readonly catalog: HostObservable<CatalogSnapshot<ScheduleCatalogEntry>> }
  /**
   * Start a new Session, where a reminder is created by asking the model to
   * schedule it, using the existing new-conversation action.
   */
  readonly onNewTask: () => void
  /**
   * Remove every ended Host task, after this page has confirmed the action.
   *
   * The call requests no task ids, so the Host's ended set is the one removed;
   * the page's rows are only a snapshot that a delivery can have moved. It
   * resolves once the settled outcome has been reported through the app-wide
   * notice, which is the only place the result is stated.
   * @returns resolution after the outcome is reported.
   */
  readonly onClearEnded: () => Promise<void>
  /** Create a task directly through the Host, without a model request. */
  readonly onCreateTask: (request: ScheduleCreateRequest) => Promise<TaskCreateOutcome>
}

/** Root-scoped task catalog props derived from the framework and injected actions. */
export type TaskManagerPageProps = PropsRuntime<'main'>
  & InjectFace<TaskManagerInjected>
  & PropsLocale<'schedule.manager'>

type StatusFilter = 'all' | ScheduleCatalogEntry['status']

/**
 * Render retained tasks with manual creation, inline editing, and authoritative deletion.
 * @param props - framework catalog snapshot, localized copy, and action callbacks.
 * @returns the searchable task list beside the selected task's detail.
 */
export function TaskManagerPage(props: TaskManagerPageProps) {
  const { useCatalog, onNewTask, onClearEnded, onRetry, onCreateTask, useWorkspaces, t } = props
  const workspaces = useWorkspaces(snapshot => snapshot)
  const [createMenuOpen, setCreateMenuOpen] = useState(false)
  const [manualOpen, setManualOpen] = useState(false)
  const catalog = useCatalog(snapshot => snapshot)
  const { records, status } = catalog
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('active')
  const [selectedId, setSelectedId] = useState<ScheduleId | null>(null)
  const [clearConfirm, setClearConfirm] = useState(false)
  const [clearMenu, setClearMenu] = useState(false)
  const [clearing, setClearing] = useState(false)
  // The rows state how long remains, so they read the shared ticking clock
  // rather than a value sampled at mount: a catalog refresh can move the target
  // this text describes.
  const now = useRelativeClock()
  const detail = useTaskDetail(props, catalog, selectedId ?? undefined)
  const { record: catalogRecord, task: selected,
    props: { id: detailId, confirmId, onConfirm: setConfirmId, onTabChange: setTab } } = detail
  const rowRef = useRef<HTMLButtonElement | null>(null)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const clearTriggerRef = useRef<HTMLButtonElement | null>(null)
  // Set when the confirmation opens: its settled removal can hide the trigger
  // before the Modal returns focus, and so can another client's cleanup.
  const clearFocusPending = useRef(false)
  // Set when the removal settles: a readback superseded by `schedule/changed`
  // can publish its rows after the dialog closed, removing the trigger then.
  const clearSettled = useRef(false)
  const confirming = records.find(record => record.id === confirmId)
  // The bulk action's target and count come from the complete catalog, not from
  // the filtered rows: it removes every ended task, whatever the view shows.
  const endedCount = useMemo(
    () => records.filter(record => record.status === 'ended').length,
    [records],
  )
  const rows = useMemo(() => {
    const query = search.trim().toLowerCase()
    return records.filter(record => (
      (statusFilter === 'all' || record.status === statusFilter)
      && (record.prompt.toLowerCase().includes(query)
        || (taskSessionId(record) ?? '').toLowerCase().includes(query)
        || taskName(record).toLowerCase().includes(query))
    )).toSorted((left, right) =>
      Date.parse(taskNextRunAt(left)) - Date.parse(taskNextRunAt(right)))
  }, [records, search, statusFilter])

  const emptyTitle = search.trim() !== '' ? 'list.noMatches'
    : statusFilter === 'paused' ? 'list.emptyPaused'
      : statusFilter === 'ended' ? 'list.emptyInactive'
        : statusFilter === 'active' ? 'list.emptyActive' : 'list.empty'
  // The list's frequency line omits a rule zone equal to the host's and otherwise
  // names it, the same way the detail's Repeat row does.
  const systemZone = Intl.DateTimeFormat().resolvedOptions().timeZone
  const frequencyZone: FrequencyZone = { system: systemZone, label: zone => zoneLabel(zone, t) }

  useEffect(() => {
    // The detail focuses its own panel; with nothing selected, focus returns
    // to the row that opened it, or to the page heading once that row is gone.
    // An open confirmation owns the focus until it closes, even when a refresh
    // drops the selected task behind it.
    if (selectedId !== null || clearConfirm) return
    if (rowRef.current !== null) {
      const target = rowRef.current.isConnected ? rowRef.current : headingRef.current
      target?.focus()
      rowRef.current = null
    }
  }, [selectedId, clearConfirm])

  useEffect(() => {
    if (status !== 'ready') return
    if (selectedId !== null && selected === undefined) setSelectedId(null)
    if (confirmId !== null && confirming === undefined) setConfirmId(null)
  }, [status, selectedId, selected, confirmId, confirming])

  const closeDetails = (): void => {
    setSelectedId(null)
  }

  // The Modal restores focus to the element it captured when it opened; the
  // trigger can be removed or rebuilt while the confirmation is open, so the
  // page points focus at the current control, or the heading when it is gone.
  // A settled removal whose readback lands later unmounts the trigger after the
  // dialog closed, which drops focus to the document body; that handoff is
  // caught by the same effect watching the ended count.
  useEffect(() => {
    if (clearConfirm) return
    if (clearFocusPending.current) {
      clearFocusPending.current = false
      const trigger = clearTriggerRef.current
      if (trigger?.isConnected === true) {
        trigger.focus()
        return
      }
      clearSettled.current = false
      headingRef.current?.focus()
      return
    }
    if (!clearSettled.current || endedCount > 0 || document.activeElement !== document.body) return
    clearSettled.current = false
    headingRef.current?.focus()
  }, [clearConfirm, endedCount])

  const confirmClearEnded = (): void => {
    // The confirmation button stays focusable while the removal runs, so a
    // second press has to be ignored here instead of by `disabled`.
    if (clearing) return
    setClearing(true)
    void onClearEnded().finally(() => {
      clearSettled.current = true
      setClearing(false)
      setClearConfirm(false)
    })
  }

  return (
    <section
      className={clsx(css.page, selected !== undefined && css.hasDetails)}
      aria-label={t('title')}
      data-testid="task-manager-page"
      onKeyDown={(event) => {
        // An Escape that closed a dropdown is already consumed by the Menu's
        // document capture listener. A confirmation's own Escape reaches the
        // Modal's document bubble listener, which runs after this React handler,
        // so the `clearConfirm` guard is what keeps this page from also closing
        // the detail while the dialog closes.
        if (event.key !== 'Escape' || event.defaultPrevented || confirmId !== null || clearConfirm || manualOpen
          || selectedId === null) return
        event.preventDefault()
        event.stopPropagation()
        closeDetails()
      }}
    >
      {manualOpen && <TaskCreateDialog
        loadNewSessionInterval={props.hostActions.loadNewSessionInterval}
        projects={projectChoices(workspaces.items, t('host.defaultProject'))}
        onCreate={onCreateTask} onClose={() => { setManualOpen(false) }}
        onCreated={(task) => {
          setManualOpen(false); setSearch(''); setStatusFilter('all'); setSelectedId(task.id); setTab('rule')
        }} t={t} />}
      <div className={css.listPane}>
        <div className={css.pageScroll}>
          <div className={css.pageContent}>
            <div className={css.pageHeading}>
              <h1 ref={headingRef} tabIndex={-1}>{t('title')}</h1>
              <div className={css.creationActions}>
                <span className={css.createGroup} role="group" aria-label={t('host.create')}>
                  <Button variant="primary" size="sm" className={clsx(css.headerAction, css.createPrimary)} icon={<IconPlusOutlineRegular size={13} />}
                    onClick={onNewTask}>{t('new.action')}</Button>
                  <Menu open={createMenuOpen} onClose={() => { setCreateMenuOpen(false) }} align="end" portal autoFocus
                    listClassName={css.createMenu}
                    anchor={<Button variant="primary" size="sm" className={css.createMore} aria-label={t('host.createMethod')}
                      aria-haspopup="menu" aria-expanded={createMenuOpen} onClick={() => { setCreateMenuOpen(value => !value) }}>
                      <IconChevronDownOutlineRegular size={12} />
                    </Button>}>
                    <MenuItemButton icon={<ReferenceIconRegular kind="session" size={14} />}
                      onSelect={() => { setCreateMenuOpen(false); onNewTask() }}>{t('host.chatCreate')}</MenuItemButton>
                    <MenuItemButton icon={<IconEditOutlineRegular size={14} />}
                      onSelect={() => { setCreateMenuOpen(false); setManualOpen(true) }}>
                      {t('host.manualCreate')}
                    </MenuItemButton>
                  </Menu>
                </span>
              </div>
            </div>
            <div className={css.filters}>
              <div className={css.filterTabs} role="group" aria-label={t('statusFilter.label')}>
                {(['active', 'paused', 'ended', 'all'] as const).map(value => (
                  <button
                    key={value}
                    type="button"
                    className={clsx(css.filterTab, statusFilter === value && css.filterTabActive)}
                    aria-pressed={statusFilter === value}
                    onClick={() => { setStatusFilter(value) }}
                  >
                    {t(value === 'all' ? 'statusFilter.all' : `status.${value}`)}
                  </button>
                ))}
              </div>
            </div>
            <div className={css.searchTools}>
              <div className={css.searchField}>
                <Input
                  type="search"
                  icon={<IconSearchOutlineRegular />}
                  aria-label={t('search.label')}
                  placeholder={t('search.placeholder')}
                  value={search}
                  onChange={(event) => { setSearch(event.target.value) }}
                />
                {search !== '' && <Button size="sm" className={css.searchClear} aria-label={t('search.clear')} onClick={() => { setSearch('') }}>
                  <IconCloseOutlineRegular />
                </Button>}
              </div>
              {statusFilter !== 'active' && endedCount > 0 && <Menu
                open={clearMenu}
                onClose={() => { setClearMenu(false) }}
                align="end"
                portal
                items={[{
                  id: 'clear-inactive', label: t(clearing ? 'clear.pending' : 'clear.action'),
                  icon: <IconTrashOutlineRegular />, danger: true,
                  disabled: clearing || status !== 'ready',
                }]}
                onSelect={() => {
                  setClearMenu(false)
                  clearFocusPending.current = true
                  setClearConfirm(true)
                }}
                anchor={<Tooltip label={t('list.more')} side="bottom" portal disabled={clearMenu}>
                  <Button
                    ref={clearTriggerRef}
                    variant="outline"
                    className={css.catalogMore}
                    aria-label={t('list.more')}
                    aria-haspopup="menu"
                    aria-expanded={clearMenu}
                    aria-busy={clearing}
                    onClick={() => { setClearMenu(value => !value) }}
                  >
                    <IconEllipsisOutlineRegular />
                  </Button>
                </Tooltip>}
              />}
            </div>
            <div className={css.list}>
              {selected === undefined && <CatalogFeedback status={status} populated={rows.length > 0} onRetry={onRetry} t={t} />}
              {status === 'ready' && rows.length === 0 && <div className={css.empty} role="status">
                <ScheduleEmptyIllustration className={css.emptyIllustration} />
                <h2>{t(emptyTitle)}</h2>
                <Button variant="outline" className={css.emptyAction} onClick={() => { setManualOpen(true) }}>
                  {t('empty.action')}
                </Button>
              </div>}
              <ul className={css.listRows} aria-label={t('list.label')} aria-busy={status === 'loading'}>
                {rows.map((record) => {
                  // One pair per row: the same absolute stamp and distance reach
                  // both halves, from one formatting call.
                  const nextRunAt = taskNextRunAt(record)
                  const nextRun = nextRunParts(nextRunAt, t('time.locale'), now, t)
                  return (
                    <li key={record.id}>
                      <Button
                        className={clsx(css.row, selectedId === record.id && css.selectedRow,
                          record.status !== 'active' && css.endedRow)}
                        aria-label={taskName(record)}
                        aria-describedby={`${detailId}-metadata-${record.id}`}
                        aria-expanded={selectedId === record.id}
                        aria-controls={selectedId === record.id ? detailId : undefined}
                        onClick={(event) => {
                          rowRef.current = event.currentTarget
                          setSelectedId(record.id)
                          setTab('rule')
                        }}
                      >
                        <IconClockOutlineRegular className={css.rowGlyph} />
                        <span className={css.rowContent}>
                          <span className={css.rowTitle}>{taskName(record)}</span>
                          <span className={css.rowSummary} id={`${detailId}-metadata-${record.id}`}>
                            {record.status !== 'active'
                              && <span className={css.metadata}>{t(`status.${record.status}`)}</span>}
                            <span className={css.metadata}>{formatScheduleFrequency(record, t, frequencyZone)}</span>
                            {record.status === 'active' && <span className={css.metadata}>
                              {t('list.nextPrefix')}<time dateTime={nextRunAt}>
                                {nextRun.absolute}
                              </time>
                              {' '}<span className={css.nextRunRelative}>{nextRun.relative}</span>
                            </span>}
                          </span>
                        </span>
                      </Button>
                    </li>
                  )
                })}
              </ul>
            </div>
          </div>
        </div>
      </div>
      {selected !== undefined && <TaskDetail
        {...detail.props}
        task={selected}
        authoritative={catalogRecord !== undefined}
        onDeleted={closeDetails}
        onClose={closeDetails}
      />}
      <Modal
        className={css.confirmDialog as string}
        contentClassName={css.confirmContent as string}
        open={clearConfirm}
        title={t('clear.title', { count: endedCount })}
        description={t('clear.description')}
        closeLabel={t('clear.close')}
        // Dismissal waits for the settled removal: the confirmation is the only
        // place that states the operation is still running.
        onClose={() => { if (!clearing) setClearConfirm(false) }}
        footer={<div className={css.confirmActions}>
          <Button variant="outline" disabled={clearing} onClick={() => { setClearConfirm(false) }}>
            {t('delete.cancel')}
          </Button>
          <Button
            variant="outline"
            className={css.deleteButton}
            aria-disabled={clearing}
            onClick={confirmClearEnded}
          >
            {t(clearing ? 'clear.pending' : 'clear.confirm')}
          </Button>
        </div>}
      />

    </section>
  )
}
