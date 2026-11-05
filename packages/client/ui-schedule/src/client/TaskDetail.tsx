/** One task's rule, saved deliveries, edits, runs, and linked Session. */
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import clsx from 'clsx'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ScheduleCatalogEntry, ScheduleCreateRequest, ScheduleEditRequest, ScheduleId } from '@deepseek-ai/dsh-schedule/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import {
  Button, IconCloseOutlineRegular, IconEllipsisOutlineRegular, IconPauseOutlineRegular, IconPlayOutlineRegular,
  IconChevronRightOutlineRegular, Menu, MenuItemButton, Modal, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { CatalogFeedback } from './CatalogFeedback.tsx'
import { DeliveryHistory, type DeliveryHistoryInjected } from './DeliveryHistory.tsx'
import type { CatalogDeleteOutcome, CatalogSnapshot } from './catalog-source.ts'
import { TaskEditorFields, draftTarget, newTaskDraft, projectChoices, reapplyTaskDraft, taskDraft, taskDraftIssue, taskDraftPatch } from './TaskEditorFields.tsx'
import type { TaskEditorDraft } from './TaskEditorFields.tsx'
import type { TaskEditorStoreProps } from './editor-store.ts'
import { timingFromDraft } from './editor-timing.ts'
import { formatAvailableAt, nextRunParts, recordTimeZone } from './schedule-format.ts'
import { sessionLinkState } from './session-link.ts'
import { taskNextRunAt, taskSessionId } from './task-record.ts'
import { NewSessionLimit } from './NewSessionLimit.tsx'
import { RELATIVE_CLOCK_PERIOD_MS, useRelativeClock } from './relative-clock.ts'
import css from './TaskManagerPage.module.css'

/** Localized reason the Host refused an edit, or reason the wiring could not confirm it. */
export type HostEditFailure = 'host.saveError' | 'host.conflict' | 'host.notFuture' | 'host.invalidRule' | 'detail.missing'

/** Localized reason the Host refused a run, or reason the wiring could not confirm it. */
export type HostRunFailure = 'host.runError' | 'host.executionPending' | 'detail.missing'

/** Creation keeps a failed draft and never creates or activates its destination Session. */
export type TaskCreateOutcome = { readonly created: ScheduleCatalogEntry }
  | { readonly failed: 'host.createError' | 'host.notFuture' | 'host.invalidRule' }

/** Target-based mutations supplied by the owning plugin's Remote wiring. */
export interface HostTaskActions {
  /**
   * Apply one edit and refresh the catalog after the Host answers.
   * @param request - task, change, and the `updatedAt` value that the change started from.
   * @returns `saved`, or the localized reason the edit did not take effect.
   */
  readonly edit: (request: ScheduleEditRequest) => Promise<'saved' | { readonly failed: HostEditFailure }>
  /**
   * Queue one run now and refresh the catalog after the Host answers.
   * @param id - task to run.
   * @returns `queued`, or the localized reason the run did not start.
   */
  readonly run: (id: ScheduleId) => Promise<'queued' | { readonly failed: HostRunFailure }>
  /** Read the configured minimum new-conversation interval; undefined means the read failed. */
  readonly loadNewSessionInterval: () => Promise<number | undefined>
}

/** The two views of one task's detail: its rule, or its saved delivery records. */
export type TaskDetailTab = 'rule' | 'records'

/** Deletion, Host edit and run, saved-history, and linked-Session actions one task's detail calls. */
export interface TaskDetailInjected extends DeliveryHistoryInjected {
  /** Host-owned edit, run, and new-Session interval actions. */
  readonly hostActions: HostTaskActions
  /**
   * Delete one task.
   * @param id - Task shown in this detail.
   * @returns The deletion's outcome after the Remote acknowledgement and
   * authoritative refresh; the wiring reports it as the app-wide toast.
   */
  readonly onDelete: (id: ScheduleId) => Promise<CatalogDeleteOutcome>
  /**
   * Reload the catalog after a query failure or an acknowledged edit,
   * and from a surface that needs a read newer than its own record.
   * @param since - request ordinal the caller last observed, 0 to share any read in flight.
   * @returns Resolution after publishing the read result; failures remain in catalog state.
   */
  readonly onRetry: (since?: number) => Promise<void>
  /**
   * Open an available, unarchived linked conversation after rechecking current metadata.
   * @param id - Session linked to the shown task.
   */
  readonly onOpenSession: (id: SessionId) => void
}

/** One task's detail, as the Tasks page and the task tab both compose it. */
type TaskDetailCommonProps = TaskDetailInjected
  & TaskEditorStoreProps
  & PropsLocale<'schedule.manager'>
  & Pick<PropsRuntime<'main'>, 'useSessions' | 'useWorkspaces'>
  & {
    /** Element id shared by the detail panels and any control that points at them. */
    readonly id: string
    /** Catalog query state; loading disables saved-task actions. */
    readonly status: 'loading' | 'ready' | 'error'
    /** Tasks with a deletion in flight. */
    readonly deleting: readonly ScheduleId[]
    /**
     * Retain a task while a confirmed deletion and its catalog refresh settle.
     */
    readonly onRetainTask: (task: ScheduleCatalogEntry | null) => void
    /** Active detail view; the owner resets it to Rules when it selects another task. */
    readonly tab: TaskDetailTab
    /** Select the active detail view. */
    readonly onTabChange: (tab: TaskDetailTab) => void
    /** Task whose deletion confirmation the owner asked for, or null when none is open. */
    readonly confirmId: ScheduleId | null
    /** Ask for one task's deletion confirmation, or dismiss it with null. */
    readonly onConfirm: (id: ScheduleId | null) => void
    /**
     * Leave the shown task once the Host applied its deletion and the catalog refresh after it
     * settled: the Tasks page clears its selection and the session task tab closes.
     */
    readonly onDeleted: () => void
    /** Close this detail; a view with no list to return to omits the control. */
    readonly onClose?: () => void
  }

/** New and existing tasks use the same editable page; only submission and saved-task actions differ. */
export type TaskDetailProps = TaskDetailCommonProps & ({
  readonly task: ScheduleCatalogEntry
  readonly authoritative: boolean
  readonly onCreateTask?: never
  readonly onCreated?: never
} | {
  readonly task?: undefined
  readonly authoritative?: never
  readonly onCreateTask: (request: ScheduleCreateRequest) => Promise<TaskCreateOutcome>
  readonly onCreated: (task: ScheduleCatalogEntry) => void
})

/** One task detail's selected tab, confirmation, and retained catalog row. */
export interface TaskDetailController {
  /** Catalog row the shown id resolves to, or undefined when the read has no such row. */
  readonly record: ScheduleCatalogEntry | undefined
  /** Task to show: the catalog row, an unsaved draft's baseline, or a confirmed deletion's retained row. */
  readonly task: ScheduleCatalogEntry | undefined
  /** Props the shared detail element takes, without the task it shows. */
  readonly props: Omit<TaskDetailCommonProps, 'onClose' | 'onDeleted'>
}

/**
 * Own selected-task state shared by the Tasks page and task tabs.
 *
 * The shown task comes from the catalog, an unsaved form's CAS baseline, or a
 * confirmed deletion. The view and confirmation reset when selection changes;
 * the entry's store retains unsaved fields by task identity.
 * @param injected - detail actions, localized copy, and framework readers.
 * @param catalog - the owner's authoritative task catalog snapshot.
 * @param taskId - task the owner selected, or undefined when it selected none.
 * @returns the shown task and catalog row, its element id, its confirmation, and the detail props.
 */
export function useTaskDetail(
  injected: TaskDetailInjected & TaskEditorStoreProps & PropsLocale<'schedule.manager'> & Pick<PropsRuntime<'main'>, 'useSessions' | 'useWorkspaces'>,
  catalog: CatalogSnapshot<ScheduleCatalogEntry>,
  taskId: ScheduleId | undefined,
): TaskDetailController {
  const [retained, setRetained] = useState<ScheduleCatalogEntry | null>(null)
  const [tab, setTab] = useState<TaskDetailTab>('rule')
  const [confirmId, setConfirmId] = useState<ScheduleId | null>(null)
  const id = useId()
  const savedDraft = injected.useStore(state => taskId === undefined ? undefined : state.drafts[`task:${taskId}`])
  useEffect(() => {
    setRetained(null)
    setTab('rule')
    setConfirmId(null)
  }, [taskId])
  const record = taskId === undefined ? undefined : catalog.records.find(item => item.id === taskId)
  const edited = record === undefined && savedDraft?.base !== undefined
    && Object.keys(taskDraftPatch(savedDraft.draft, savedDraft.base)).length > 0
    ? savedDraft.base : undefined
  const task = record ?? edited ?? (retained !== null && retained.id === taskId ? retained : undefined)
  return {
    record, task,
    props: {
      ...injected,
      status: catalog.status,
      deleting: catalog.deleting,
      id,
      onRetainTask: setRetained,
      tab,
      onTabChange: setTab,
      confirmId,
      onConfirm: setConfirmId,
    },
  }
}

/**
 * Render one new or existing task's editable rule or saved deliveries.
 * @param props - Task, catalog state, detail view, confirmation, locale, and actions.
 * @returns The detail region and its deletion confirmation dialog.
 */
export function TaskDetail(props: TaskDetailProps): ReactNode {
  return <TaskDetailView key={props.task === undefined ? 'new' : `task:${props.task.id}`} {...props} />
}

function TaskDetailView(props: TaskDetailProps): ReactNode {
  const { task, id, tab, onTabChange, onClose, onDelete, onConfirm, confirmId, onDeleted,
    onRetry, onOpenSession, loadHistory, status, deleting, useSessions, useWorkspaces, t, hostActions } = props
  const sessions = useSessions(snapshot => snapshot)
  const workspaces = useWorkspaces(snapshot => snapshot)
  const key = task === undefined ? 'new' : `task:${task.id}`
  const stored = props.useStore(state => state.drafts[key])
  const [seed] = useState(newTaskDraft)
  const initial = stored?.initial ?? seed
  const changes = useMemo(() => stored?.base === undefined ? undefined : taskDraftPatch(stored.draft, stored.base),
    [stored?.draft, stored?.base])
  const storedDirty = changes !== undefined && Object.keys(changes).length > 0
  const cached = stored?.base !== undefined && !storedDirty && !stored.pending && stored.failure === undefined
    && stored.base.updatedAt !== task?.updatedAt ? undefined : stored
  const base = cached?.base ?? task
  const input = cached?.draft ?? (task === undefined ? initial : taskDraft(task))
  const projects = projectChoices(workspaces.items, t('host.defaultProject'))
  // Until a directory is chosen, a new form follows the Workspace list as it arrives.
  const draft = task === undefined && input.cwd === '' ? { ...input, cwd: projects.defaultCwd } : input
  const dirty = base === undefined
    ? JSON.stringify(draft) !== JSON.stringify({ ...initial, cwd: initial.cwd || projects.defaultCwd }) : storedDirty
  const issue = dirty ? taskDraftIssue(draft, changes) : undefined
  const valid = issue === undefined
  const [actionPending, setPending] = useState<'toggle' | 'run' | 'delete' | null>(null)
  const [actionFailure, setFailure] = useState<HostEditFailure | HostRunFailure | null>(null)
  const saving = cached?.pending === true
  const pending = actionPending !== null || saving
  // A pause, resume, or run would otherwise flash its controls grey between two enabled states.
  const actionHold = actionPending === 'toggle' || actionPending === 'run'
  const nativeHold = pending && !actionHold
  const failure = !pending && dirty && base !== undefined && task !== undefined && base.updatedAt !== task.updatedAt
    ? 'host.conflict' : actionFailure ?? cached?.failure ?? null
  const [menuOpen, setMenuOpen] = useState(false)
  const moreRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const mounted = useRef(true)
  useLayoutEffect(() => {
    const scroll = scrollRef.current as HTMLDivElement
    const measure = (): void => {
      scroll.style.setProperty('--detail-scrollbar-space', `${scroll.offsetWidth - scroll.clientWidth}px`)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(scroll)
    return () => { observer.disconnect() }
  }, [tab])
  useEffect(() => {
    mounted.current = true
    panelRef.current?.focus({ preventScroll: true })
    return () => { mounted.current = false }
  }, [])
  const floorEndsAt = task?.deliveryFloorEndsAt === undefined ? undefined : Date.parse(task.deliveryFloorEndsAt)
  // A sample at the floor's end enables Run now when the interval passes, not up to one period later.
  const now = useRelativeClock(RELATIVE_CLOCK_PERIOD_MS, floorEndsAt)
  const deletingTask = task !== undefined && deleting.includes(task.id)
  const busy = pending || deletingTask || task !== undefined && status === 'loading'
  const executionActive = task?.executionActive === true
  const deliveryFloor = floorEndsAt !== undefined && floorEndsAt > now
  const linkedId = task === undefined ? undefined : taskSessionId(task)
  const linkedText = linkedId === undefined ? '' : sessions.byId[linkedId]?.displayTitle ?? linkedId
  const linkedState = linkedId === undefined ? 'unavailable' : sessionLinkState(linkedId, sessions, workspaces)
  // The Host refuses to deliver to an archived target Session.
  const targetArchived = task?.target.kind !== 'new' && linkedState === 'archived'
  // Only the interval needs the row to explain itself: each other cause shows in the detail or is transient.
  const runHeld = busy || dirty || executionActive || targetArchived || !props.authoritative
  const nextRunAt = task === undefined ? '' : taskNextRunAt(task)
  const next = task === undefined ? undefined : nextRunParts(nextRunAt, t('time.locale'), now, t)
  // SessionListState gives every listed id a byId row.
  const choices = sessions.ids.map(value => ({ value, label: (sessions.byId[value] as SessionSummary).displayTitle }))
  const setDraft = (value: TaskEditorDraft): void => {
    props.actions.setDraft(key, { base, draft: value, ...(task === undefined ? { initial } : {}),
      ...(cached?.failure === 'host.conflict' ? { failure: cached.failure } : {}) })
    setFailure(null)
  }
  const reset = (): void => { props.actions.clearDraft(key); setFailure(null) }
  const save = async (): Promise<void> => {
    props.actions.setDraft(key, { base, draft, pending: true, ...(task === undefined ? { initial } : {}) })
    setFailure(null)
    const existingBase = base as ScheduleCatalogEntry
    const outcome = task === undefined
      ? await props.onCreateTask({ title: draft.title.trim(), prompt: draft.prompt.trim(),
        timing: timingFromDraft(draft, true), target: draftTarget(draft) })
      : await hostActions.edit({ id: task.id, action: 'update', patch: taskDraftPatch(draft, existingBase, true),
        expectedUpdatedAt: existingBase.updatedAt ?? null })
    if (outcome === 'saved' || 'created' in outcome) {
      props.actions.clearDraft(key)
      if (mounted.current && outcome !== 'saved') props.onCreated?.(outcome.created)
      if (mounted.current && outcome === 'saved') panelRef.current?.focus({ preventScroll: true })
    } else props.actions.setDraft(key, { base, draft, failure: outcome.failed, ...(task === undefined ? { initial } : {}) })
  }
  const setActive = async (task: ScheduleCatalogEntry): Promise<void> => {
    // The toggle stays focusable while busy, so a second press is ignored here instead of by `disabled`.
    if (busy) return
    setPending('toggle')
    const outcome = await hostActions.edit({ id: task.id, action: 'update', patch: { active: task.status !== 'active' }, expectedUpdatedAt: task.updatedAt ?? null })
    if (!mounted.current) return
    setPending(null)
    setFailure(outcome === 'saved' ? null : outcome.failed)
  }
  const run = async (id: ScheduleId): Promise<void> => {
    setMenuOpen(false)
    setPending('run')
    const outcome = await hostActions.run(id)
    if (!mounted.current) return
    setPending(null)
    setFailure(outcome === 'queued' ? null : outcome.failed)
  }

  return <>
    <aside ref={panelRef} tabIndex={-1} className={css.detail} id={id} aria-busy={pending || deletingTask}
      aria-label={t(task === undefined ? 'host.manualCreate' : 'detail.label')}
      onKeyDown={(event) => {
        if (pending && event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); event.stopPropagation() }
      }}>
      <div className={css.detailTabsBar}>
        {task === undefined ? <h2 className={css.createTitle}>{t('host.manualCreate')}</h2>
          : <div className={css.detailTabs} role="tablist" aria-label={t('detail.tabs')}>
            {(['rule', 'records'] as const).map(value => <button key={value} type="button" role="tab"
              id={`${id}-${value}-tab`} aria-controls={`${id}-${value}-panel`} tabIndex={tab === value ? 0 : -1}
              aria-selected={tab === value} className={css.detailTab}
              onKeyDown={(event) => {
                if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
                if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
                event.preventDefault()
                const next = event.key === 'Home' ? 0 : event.key === 'End' ? 1 : value === 'rule' ? 1 : 0
                onTabChange(next === 0 ? 'rule' : 'records')
                const button = event.currentTarget.parentElement?.children[next]
                if (button instanceof HTMLButtonElement) button.focus()
              }}
              onClick={() => { onTabChange(value) }}>{t(value === 'rule' ? 'detail.rule' : 'detail.records')}</button>)}
          </div>}
        <div className={css.detailActions}>
          {task !== undefined && <><Tooltip label={t(task.status === 'active' ? 'host.pause' : 'host.resume')} side="bottom" delayMs={500} portal>
            {/* Native disabling while busy would flash the not-allowed cursor and dimmed icon for the length of the request. */}
            <span><Button size="sm" className={css.detailIconButton} disabled={dirty || executionActive || task.status === 'ended' || !props.authoritative}
              aria-disabled={busy || undefined} aria-label={t(task.status === 'active' ? 'host.pause' : 'host.resume')}
              onClick={() => { void setActive(task) }}>
              {task.status === 'active' ? <IconPauseOutlineRegular /> : <IconPlayOutlineRegular />}
            </Button></span>
          </Tooltip>
          <Menu open={menuOpen} onClose={() => { setMenuOpen(false) }} align="end" portal autoFocus
            anchor={<Button ref={moreRef} size="sm" className={css.detailIconButton} aria-label={t('detail.more')}
              aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => { setMenuOpen(value => !value) }}>
              <IconEllipsisOutlineRegular />
            </Button>}>
            <MenuItemButton disabled={runHeld || deliveryFloor}
              disabledReason={deliveryFloor && !runHeld
                ? t('host.runAfterInterval', { time: formatAvailableAt(floorEndsAt, t('time.locale'), now) }) : undefined}
              onSelect={() => { void run(task.id) }}>{t('host.run')}</MenuItemButton>
            <MenuItemButton disabled={busy || dirty || executionActive || !props.authoritative}
              onSelect={() => {
                // The dialog returns focus to the control that held it on open, not to the removed menu row.
                moreRef.current?.focus()
                setMenuOpen(false)
                onConfirm(task.id)
              }}>
              {t('delete.action')}
            </MenuItemButton>
          </Menu></>}
          {onClose !== undefined && <Button size="sm" className={css.detailIconButton} aria-label={t(task === undefined ? 'host.closeCreate' : 'detail.close')}
            disabled={nativeHold} aria-disabled={actionHold || undefined}
            onClick={() => { if (!actionHold) onClose() }}><IconCloseOutlineRegular /></Button>}
        </div>
      </div>
      <div ref={scrollRef} className={clsx(css.detailScroll, tab === 'records' && css.detailRecords)} role={task === undefined ? undefined : 'tabpanel'}
        id={`${id}-${tab}-panel`} aria-labelledby={task === undefined ? undefined : `${id}-${tab}-tab`} tabIndex={0}>
        <CatalogFeedback status={status} populated onRetry={onRetry} t={t} />
        {tab === 'rule' && <>
          {task !== undefined && <>
            <header className={css.detailHeader}><h2 className={css.readonlyName}>{task.title}</h2></header>
            <div className={css.nextRun}><p>{task.status === 'active'
              ? <>{t('detail.nextRun')} <time dateTime={nextRunAt}>{next?.absolute}</time>{' '}
                <span className={css.nextRunRelative}>{next?.relative}</span></>
              : t(`status.${task.status}`)}</p></div>
            {linkedId !== undefined && linkedState !== 'available' && task.target.kind === 'session'
              && <p className={css.detailNotice} role="status">{t(linkedState === 'archived' ? 'detail.sessionArchived'
                : linkedState === 'loading' ? 'detail.sessionLoading' : 'detail.sessionUnavailable')}</p>}
            {/* A refused run states the same cause, so it alone reports a queued or running execution. */}
            {executionActive && failure !== 'host.executionPending'
              && <p className={css.detailNotice} role="status">{t('host.executionActive')}</p>}
            {dirty && !props.authoritative && status === 'ready' && !deletingTask && failure !== 'detail.missing'
              && <p className={css.detailNotice} role="status">{t('detail.missing')}</p>}
          </>}
          {/* A refused run is an expected wait, not a failure of the Host or of the user's input. */}
          {failure === 'host.conflict' ? <div className={clsx(css.notice, css.conflictNotice)}>
            <p role="alert">{t(failure)}</p>
            {changes !== undefined && dirty && task !== undefined && props.authoritative && status === 'ready'
              && <Button variant="outline" size="sm" disabled={busy} onClick={() => {
                props.actions.setDraft(key, { base: task, draft: reapplyTaskDraft(draft, task, changes) })
                setFailure(null)
                panelRef.current?.focus({ preventScroll: true })
              }}>{t('host.reapply')}</Button>}
          </div> : failure === 'host.executionPending' ? <p className={css.detailNotice} role="status">{t(failure)}</p>
            : failure !== null && <p className={css.saveFailure} role="alert">{t(failure)}</p>}
          <TaskEditorFields draft={draft} onChange={setDraft}
            disabled={pending || executionActive || deletingTask} held={actionHold}
            projects={projects} original={base} t={t} />
          {draft.target === 'new'
            && <NewSessionLimit load={hostActions.loadNewSessionInterval} t={t} />}
          {failure === null && issue !== undefined && issue !== 'incomplete'
            && <p className={css.saveFailure} role="status">{t(issue)}</p>}
        </>}
        {tab === 'records' && task !== undefined && <DeliveryHistory id={task.id} latestMessageId={task.lastDelivery?.messageId}
          timeZone={recordTimeZone(task)} loadHistory={loadHistory} onOpenSession={onOpenSession}
          sessionTitles={Object.fromEntries(choices.map(choice => [choice.value, choice.label]))}
          availableSessionIds={sessions.ids.filter(value => sessionLinkState(value, sessions, workspaces) === 'available')} t={t} />}
      </div>
      {task !== undefined && (task.target.kind !== 'new' || linkedId !== undefined) && <footer className={css.hostSessionFooter}>
        <span>{t(task.target.kind === 'new' ? 'host.latestConversation' : 'detail.session')}</span>
        {linkedId === undefined || (task.target.kind === 'new_once' && linkedState === 'unavailable')
          ? <span className={css.hostSessionEmpty}>{t('host.sessionAfterFirstRun')}</span>
          : <Button variant="outline" disabled={linkedState !== 'available'}
            aria-label={linkedText === linkedId ? t('detail.openSession') : t('detail.openSessionTitle', { title: linkedText })}
            onClick={() => { onOpenSession(linkedId) }}>
            {linkedText}<IconChevronRightOutlineRegular />
          </Button>}
      </footer>}
      {(tab === 'rule' || dirty) && <footer className={css.saveFooter}>
        <span className={css.saveNotice}>{dirty ? t('rule.unsaved') : ''}</span>
        <Button disabled={nativeHold || task !== undefined && !dirty && failure === null} aria-disabled={actionHold || undefined}
          onClick={() => { if (actionHold) return; reset(); if (task === undefined) onClose?.() }}>{t('rule.cancel')}</Button>
        <Button variant="primary" disabled={busy || !dirty || !valid || failure === 'host.conflict'
          || task !== undefined && (!props.authoritative || executionActive)}
        onClick={() => { void save() }}>{t(saving ? task === undefined ? 'host.creating' : 'rule.saving' : task === undefined ? 'host.create' : 'rule.save')}</Button>
      </footer>}
    </aside>
    {task !== undefined && <Modal open={confirmId === task.id}
      className={css.confirmDialog as string} contentClassName={css.confirmContent as string}
      title={t('delete.title')} description={t('delete.description')} closeLabel={t('delete.close')} onClose={() => { onConfirm(null) }}
      footer={<div className={css.confirmActions}>
        <Button data-modal-autofocus onClick={() => { onConfirm(null) }}>{t('delete.cancel')}</Button>
        <Button disabled={busy} onClick={() => {
          onConfirm(null)
          setPending('delete')
          // The refresh that drops the row lands before the outcome, so the owner retains the task until then.
          props.onRetainTask(task)
          void onDelete(task.id).then((outcome) => {
            if (!mounted.current) return
            setPending(null)
            if (outcome === 'deleted') { props.actions.clearDraft(key); onDeleted() }
            else props.onRetainTask(null)
          })
        }}>{t('delete.confirm')}</Button>
      </div>}><p className={css.confirmPrompt}>{task.prompt}</p></Modal>}
  </>
}
