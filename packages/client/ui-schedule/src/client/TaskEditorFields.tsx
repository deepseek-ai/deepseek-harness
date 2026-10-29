/** Fields shared by manual creation and editing inside the existing Rules view. */
import type { ReactNode } from 'react'
import { useId, useRef, useState } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ScheduleCatalogEntry, ScheduleTargetRequest } from '@deepseek-ai/dsh-schedule/client'
import clsx from 'clsx'
import { DEFAULT_WORKSPACE_DIRECTORY, workspaceDisplayTitle } from '@deepseek-ai/dsh-api-workspace-controller/default-workspace'
import { IconClockOutlineRegular, Input, PathLabel } from '@deepseek-ai/dsh-client-ui-primitives'
import { ClockPicker } from './ClockPicker.tsx'
import { DatePicker } from './DatePicker.tsx'
import { defaultTiming, rruleFromDraft, timingFromRecord } from './editor-timing.ts'
import type { FrequencyPreset, TimingDraft } from './editor-timing.ts'
import { RuleSelectRow, RuleZoneRow } from './RuleSelectRow.tsx'
import { formatScheduleFrequency, zoneLabel } from './schedule-format.ts'
import type { FrequencyZone } from './schedule-format.ts'
import { RuleStepper, RuleWeekdayRow } from './TaskRuleControls.tsx'
import { IconCalendarOutlineRegular } from './CalendarIcon.tsx'
import type { TaskManagerKey } from './task-manager-locales.ts'
import css from './TaskManagerPage.module.css'

/** Local form values; only Save writes a task. */
export interface TaskEditorDraft extends TimingDraft {
  readonly title: string
  readonly prompt: string
  readonly target: 'session' | 'new_once' | 'new'
  readonly sessionId: string
  readonly cwd: string
}

/** A Session or project label supplied by the owning framework readers. */
export interface EditorChoice { readonly value: string; readonly label: string }

/** Registered Workspaces offered as the directory of a created Session. */
export interface ProjectChoices {
  readonly items: readonly EditorChoice[]
  /** Directory a new destination starts with: the default Workspace, else the first listed one, else empty. */
  readonly defaultCwd: string
}

/** Label Workspaces as the Workspace list does and select the directory a new destination starts with. */
export function projectChoices(workspaces: WorkspaceSnapshot['items'], defaultName: string): ProjectChoices {
  return {
    items: workspaces.map(workspace => ({ value: workspace.path, label: workspaceDisplayTitle(workspace.title, defaultName) })),
    defaultCwd: (workspaces.find(workspace => workspace.title === DEFAULT_WORKSPACE_DIRECTORY) ?? workspaces[0])?.path ?? '',
  }
}

/** Name a destination strategy; a Session target is the conversation that the task already uses. */
export function targetLabelKey(target: TaskEditorDraft['target']): TaskManagerKey {
  return target === 'session' ? 'host.currentConversation' : target === 'new_once' ? 'host.targetNewOnce' : 'host.targetNew'
}

/** Initialize a new task without creating or activating a Session. */
export function newTaskDraft(): TaskEditorDraft {
  return { ...defaultTiming(), title: '', prompt: '', target: 'new_once', sessionId: '', cwd: '' }
}

/** Seed an edit without normalizing unsupported stored rules. */
export function taskDraft(task: ScheduleCatalogEntry): TaskEditorDraft {
  return {
    ...timingFromRecord(task), title: task.title, prompt: task.prompt,
    target: task.target.kind, sessionId: task.target.kind === 'session' ? task.target.sessionId : '',
    cwd: task.target.kind === 'session' ? '' : task.target.create.cwd ?? '',
  }
}

/** Required fields and guided selections that the form can validate locally. */
export function taskDraftValid(draft: TaskEditorDraft): boolean {
  return draft.title.trim() !== '' && draft.prompt.trim() !== ''
    && draft.title.trim().length <= 120
    && (draft.target !== 'session' || draft.sessionId !== '')
    && (draft.frequency === 'once' || draft.frequency === 'advanced'
      || (/^[1-9]\d*$/.test(draft.interval) && Number.isSafeInteger(Number(draft.interval))))
    && (draft.frequency !== 'weekly' || draft.weekdays.length > 0)
    && (draft.frequency !== 'monthly' || Number.isInteger(draft.monthDay) && draft.monthDay >= 1 && draft.monthDay <= 31)
    && (draft.frequency !== 'daily' || /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(draft.dailyTime))
}

/** Resolve the explicit destination, preserving an existing preset when the project is unchanged. */
export function draftTarget(draft: TaskEditorDraft, original?: ScheduleCatalogEntry): ScheduleTargetRequest {
  if (draft.target === 'session') return { kind: 'session', sessionId: draft.sessionId as SessionId }
  const previous = original?.target.kind === 'session' ? undefined : original?.target.create
  const create = {
    ...(draft.cwd === '' ? {} : { cwd: draft.cwd }),
    ...((previous?.cwd ?? '') === draft.cwd && previous?.agentPreset !== undefined ? { agentPreset: previous.agentPreset } : {}),
  }
  return { kind: draft.target, create }
}

/** Render manual creation and inline edits with the existing task rule controls. */
export function TaskEditorFields({ draft, onChange, projects, disabled, original, t }: {
  readonly draft: TaskEditorDraft
  readonly onChange: (draft: TaskEditorDraft) => void
  readonly projects: ProjectChoices
  readonly disabled: boolean
  readonly original?: ScheduleCatalogEntry
  readonly t: PropsLocale<'schedule.manager'>['t']
}): ReactNode {
  const [dateOpen, setDateOpen] = useState(false)
  const [clockOpen, setClockOpen] = useState(false)
  const dateAnchor = useRef<HTMLButtonElement>(null)
  const clockAnchor = useRef<HTMLButtonElement>(null)
  const id = useId()
  const rowId = (name: string): string => `${id}-${name}`
  const change = (patch: Partial<TaskEditorDraft>): void => { onChange({ ...draft, ...patch }) }
  const clock = draft.frequency === 'daily' ? `${draft.dailyTime}:00` : draft.start.slice(11)
  const frequencyZone: FrequencyZone = { system: Intl.DateTimeFormat().resolvedOptions().timeZone, label: zone => zoneLabel(zone, t) }
  const targetLabel = (target: TaskEditorDraft['target']): string => t(targetLabelKey(target))
  const weekdays = draft.frequency === 'weekly' && draft.weekdays.length === 5 && [1, 2, 3, 4, 5].every(day => draft.weekdays.includes(day))
  const frequencyItems = [
    { id: 'weekly', label: t('rule.weekly') }, { id: 'weekdays', label: t('rule.weekdays') },
    { id: 'daily', label: t('rule.daily') }, { id: 'hourly', label: t('rule.everyHours') },
    { id: 'minutely', label: t('rule.everyMinutes') }, { id: 'monthly', label: t('host.frequency.monthly') },
    { id: 'once', label: t('rule.once') }, { id: 'advanced', label: t('host.frequency.advanced') },
  ]
  const frequencyValue = weekdays ? 'weekdays' : draft.frequency
  // The directory line tells which folder a Workspace title such as Default workspace stands for.
  const workspaceItems = projects.items.map(choice => ({
    id: choice.value, label: <span className={css.workspaceMenuItem}><span>{choice.label}</span>
      <PathLabel path={choice.value} className={css.workspaceMenuPath} /></span>,
  }))
  return <fieldset disabled={disabled} className={css.taskEditor} onKeyDownCapture={(event) => {
    if (event.key !== 'Escape' || event.defaultPrevented || !dateOpen && !clockOpen) return
    event.preventDefault(); event.stopPropagation()
    if (dateOpen) { setDateOpen(false); dateAnchor.current?.focus() }
    else { setClockOpen(false); clockAnchor.current?.focus() }
  }}>
    <label className={css.editorField}>{t('detail.name')}<Input value={draft.title} maxLength={120}
      onChange={(event) => { change({ title: event.target.value }) }} /></label>
    <label className={css.editorField}>{t('detail.instruction')}<textarea className={css.instruction}
      value={draft.prompt} onChange={(event) => { change({ prompt: event.target.value }) }} /></label>
    <div className={css.ruleRows}>
      <RuleSelectRow label={t('host.target')} value={draft.target} current={targetLabel(draft.target)} disabled={disabled}
        listClassName={css.targetMenu} items={(['new_once', 'new'] as const).map(value => ({
          id: value, label: <span className={css.targetMenuItem}><span>{targetLabel(value)}</span>
            <span className={css.targetMenuDescription}>{t(value === 'new_once' ? 'host.targetNewOnceHelp' : 'host.targetNewHelp')}</span></span>,
        }))}
        onChange={(value) => { change({ target: value as TaskEditorDraft['target'],
          ...(draft.target === 'session' ? { cwd: projects.defaultCwd } : {}) }) }} />
      {draft.target !== 'session' && <RuleSelectRow label={t('host.project')} value={draft.cwd} disabled={disabled}
        current={projects.items.find(choice => choice.value === draft.cwd)?.label ?? (draft.cwd || t('host.ungrouped'))}
        listClassName={css.workspaceMenu} items={workspaceItems.length === 0 ? [{ id: '', label: t('host.ungrouped'), disabled: true }]
          : workspaceItems} onChange={(cwd) => { change({ cwd }) }} />}
    </div>
    <section className={css.editorField} aria-label={t('rule.title')}><h3>{t('rule.title')}</h3><div className={css.ruleRows}>
      <RuleSelectRow label={t('rule.repeat')} value={frequencyValue} disabled={disabled} items={frequencyItems}
        current={(frequencyItems.find(item => item.id === frequencyValue) as { label: string }).label} onChange={(value) => {
          const frequency = value === 'weekdays' ? 'weekly' : value as FrequencyPreset
          change({ frequency, ...(value === 'weekdays' ? { weekdays: [1, 2, 3, 4, 5] } : {}),
            ...(frequency === 'advanced' ? { rrule: rruleFromDraft(draft, true) } : {}) })
        }} />
      {draft.frequency !== 'once' && draft.frequency !== 'advanced' && <div className={css.ruleRow}>
        <label className={css.ruleLabel} htmlFor={rowId('interval')}>{t('host.interval')}</label>
        <RuleStepper id={rowId('interval')} min={1} max={Number.MAX_SAFE_INTEGER} value={Number(draft.interval)} disabled={disabled}
          increaseLabel={t('timing.intervalIncrease')} decreaseLabel={t('timing.intervalDecrease')}
          onChange={(value) => { change({ interval: String(value) }) }} />
      </div>}
      {draft.frequency === 'weekly' && <RuleWeekdayRow weekdays={draft.weekdays} disabled={disabled} t={t} rowId={rowId}
        onToggle={(day) => { change({ weekdays: draft.weekdays.includes(day)
          ? draft.weekdays.filter(value => value !== day) : [...draft.weekdays, day].sort() }) }} />}
      {draft.frequency === 'monthly' && <div className={css.ruleRow}>
        <label className={css.ruleLabel} htmlFor={rowId('monthDay')}>{t('host.monthDay')}</label>
        <RuleStepper id={rowId('monthDay')} min={1} max={31} value={draft.monthDay} disabled={disabled}
          increaseLabel={t('timing.intervalIncrease')} decreaseLabel={t('timing.intervalDecrease')}
          onChange={(value) => { change({ monthDay: value }) }} />
      </div>}
      {draft.frequency === 'once' && <div className={css.ruleRow}>
        <label className={css.ruleLabel} htmlFor={rowId('date')}>{t('timing.date')}</label>
        <button ref={dateAnchor} id={rowId('date')} type="button" disabled={disabled}
          className={clsx(css.ruleInput, css.ruleControl, css.pickerTrigger)} aria-label={t('timing.date')}
          aria-haspopup="dialog" aria-expanded={dateOpen} onClick={() => { setDateOpen(true) }}>
          <span>{draft.start.slice(0, 10).replaceAll('-', '/')}</span><IconCalendarOutlineRegular className={css.pickerIcon} />
        </button>
        <DatePicker open={dateOpen && !disabled} anchorRef={dateAnchor} value={draft.start.slice(0, 10)}
          onPick={(date) => { change({ start: `${date}T${clock}` }); setDateOpen(false) }}
          onClose={() => { setDateOpen(false) }} t={t} />
      </div>}
      {draft.frequency !== 'advanced' && draft.frequency !== 'minutely' && draft.frequency !== 'hourly' && <div className={css.ruleRow}>
        <label className={css.ruleLabel} htmlFor={rowId('time')}>{t('timing.time')}</label>
        <button ref={clockAnchor} id={rowId('time')} type="button" disabled={disabled}
          className={clsx(css.ruleInput, css.ruleControl, css.pickerTrigger)} aria-label={t('timing.time')}
          aria-haspopup="dialog" aria-expanded={clockOpen} onClick={() => { setClockOpen(true) }}>
          <span>{clock}</span><IconClockOutlineRegular className={css.pickerIcon} />
        </button>
        <ClockPicker open={clockOpen && !disabled} anchorRef={clockAnchor} value={clock} seconds={draft.frequency !== 'daily'}
          onPick={(time) => { change(draft.frequency === 'daily' ? { dailyTime: time.slice(0, 5) }
            : { start: `${draft.start.slice(0, 10)}T${time}` }) }} onClose={() => { setClockOpen(false) }} t={t} />
      </div>}
      {(draft.frequency !== 'advanced' || draft.rrule.trim() !== '' && !draft.rrule.trimStart().startsWith('DTSTART')) && <RuleZoneRow value={draft.timeZone} disabled={disabled} t={t}
        onChange={(timeZone) => { change({ timeZone }) }} />}
    </div></section>
    {draft.frequency === 'advanced' && <div className={css.editorField}>
      {original !== undefined && original.kind !== 'rrule' && original.kind !== 'cron' && draft.rrule === ''
        && <p>{formatScheduleFrequency(original, t, frequencyZone)}</p>}
      <label className={css.editorField}>{t('host.customRule')}<textarea className={css.instruction}
        value={draft.rrule} onChange={(event) => { change({ rrule: event.target.value }) }} /></label>
    </div>}

  </fieldset>
}
