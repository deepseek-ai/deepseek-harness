// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { act, cleanup, fireEvent, isInaccessible, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bindSnapshotSelector, makeTranslate, RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { ScheduleCatalogEntry, ScheduleDeleteResult, ScheduleId, ScheduleUpdateResult } from '@deepseek-ai/dsh-schedule/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { TaskManagerPage, type TaskManagerPageProps } from '../src/client/TaskManagerPage.tsx'
import { TaskManagerIcon } from '../src/client/TaskManagerIcon.tsx'
import { createCatalogSource, type CatalogSnapshot } from '../src/client/catalog-source.ts'
import {
  FALLBACK_ZONES, formatScheduleAbsolute, formatScheduleFrequency, formatScheduleNextRun,
  formatScheduleRelative, zoneLabel,
} from '../src/client/schedule-format.ts'
import { timingSnapshot } from '../src/client/task-timing.ts'
import { en, zh } from '../src/client/task-manager-locales.ts'
import { zoneDifferingFrom, zoneOffsetMinutes } from './zone-fixture.ts'
import css from '../src/client/TaskManagerPage.module.css'
import taskMenuCss from '../src/client/TaskMenu.module.css'
import modalCss from '../../ui-primitives/src/Modal.module.css'
import pluginsCss from '../../ui-plugin-manager/src/client/PluginManagerPage.module.css'

/** The Modal layer's own padding, which the delete dialog's cap has to clear. */
const MODAL_LAYER_PADDING = 24

/**
 * The stylesheet this suite appends so jsdom computes the module's declarations,
 * or undefined before the first install.
 */
let installedStyles: HTMLStyleElement | undefined

/**
 * Apply this module's stylesheet and the Modal layer's using Vite's module
 * names. jsdom loads no CSS, so a computed style stays unset until the sheets
 * are in the document; `code-body.client.spec.tsx` installs its own the same way.
 * @param selectors - module class names to map from their source names.
 */
function installStyles(selectors: Record<string, string | undefined>): void {
  const directory = resolve(import.meta.dirname, '../src/client')
  const own = readFileSync(resolve(directory, 'TaskManagerPage.module.css'), 'utf8')
  let mapped = own
  for (const [name, hashed] of Object.entries(selectors)) {
    if (hashed !== undefined) mapped = mapped.replaceAll(`.${name}`, `.${hashed}`)
  }
  const layer = readFileSync(resolve(import.meta.dirname, '../../ui-primitives/src/Modal.module.css'), 'utf8')
    .replaceAll('.root', `.${modalCss.root}`)
  installedStyles = document.createElement('style')
  installedStyles.textContent = `${mapped}\n${layer}`
  document.head.append(installedStyles)
}

const at: ScheduleCatalogEntry = {
  id: 'task-at' as ScheduleId, sessionId: 'session-alpha' as SessionId, kind: 'at', status: 'active',
  title: 'Review release',
  prompt: 'Review release\nCheck risks and <img src=x onerror=alert(1)>',
  scheduledAt: '2026-10-01T09:00:00.000Z',
}
const after: ScheduleCatalogEntry = {
  id: 'task-after' as ScheduleId, sessionId: 'session-beta' as SessionId, kind: 'after', status: 'active',
  title: 'Send summary', prompt: 'Send summary', afterSeconds: 90, scheduledAt: '2026-10-01T08:00:00.000Z',
}
const every: ScheduleCatalogEntry = {
  id: 'task-every' as ScheduleId, sessionId: 'session-gamma' as SessionId, kind: 'every', status: 'active',
  title: 'Check metrics', prompt: 'Check metrics', everySeconds: 301, scheduledAt: '2026-10-01T09:30:00.000Z',
}
const daily: ScheduleCatalogEntry = {
  id: 'task-daily' as ScheduleId, sessionId: 'session-weather' as SessionId, kind: 'daily', status: 'active',
  title: 'Daily weather', prompt: 'Daily weather', time: '23:00:00.000', timeZone: 'Asia/Shanghai',
  scheduledAt: '2026-10-01T15:00:00.000Z',
}
const weekly = {
  id: 'task-weekly' as ScheduleId, sessionId: 'session-standup' as SessionId, kind: 'weekly', status: 'active',
  title: 'Weekly review', prompt: 'Weekly review', time: '09:30:00.000', timeZone: 'Asia/Shanghai', weekdays: [1, 3],
  scheduledAt: '2026-10-05T01:30:00.000Z',
} satisfies ScheduleCatalogEntry
const cron = {
  id: 'task-cron' as ScheduleId, sessionId: 'session-report' as SessionId, kind: 'cron', status: 'active',
  title: 'Cron report', prompt: 'Cron report', expression: '0 9 * * 1-5', timeZone: 'Asia/Shanghai',
  scheduledAt: '2026-10-05T01:00:00.000Z',
} satisfies ScheduleCatalogEntry
const delivery: NonNullable<ScheduleCatalogEntry['lastDelivery']> = {
  scheduledAt: at.scheduledAt,
  deliveredAt: '2026-10-01T09:00:03.000Z',
  messageId: 'message-release-delivery' as NonNullable<ScheduleCatalogEntry['lastDelivery']>['messageId'],
}
const ended: ScheduleCatalogEntry = { ...at, status: 'inactive', lastDelivery: delivery }
const records = [at, every, after]
const sessions: SessionListState = {
  ids: [...records, daily, weekly].map(record => record.sessionId),
  byId: Object.fromEntries([...records, daily, weekly].map(record => [record.sessionId, {
    id: record.sessionId, displayTitle: record.sessionId, running: false, blank: false, updatedAt: 0, retainedBy: {},
  }] as const)),
  phase: 'ready', projectionsBySession: {},
}
const workspaces: WorkspaceSnapshot = { items: [], archivedSessionIds: [], pinnedSessionIds: [], state: 'idle', phase: 'ready', error: null }

/**
 * Session list whose catalog rows carry the given titles.
 * @param titles - title one Session id carries; an omitted id keeps its untitled row.
 * @returns the Session list projection those titles produce.
 */
function sessionsWithTitles(titles: Partial<Record<SessionId, string>>): SessionListState {
  return {
    ...sessions,
    byId: Object.fromEntries(Object.entries(sessions.byId).map(([id, summary]) => {
      const title = titles[id as SessionId]
      return [id, title === undefined ? summary : { ...summary, title }] as const
    })),
  }
}

afterEach(() => {
  try {
    cleanup()
    vi.restoreAllMocks()
    localStorage.clear()
  } finally {
    installedStyles?.remove()
    installedStyles = undefined
  }
})

/**
 * Pin the browser-resolved zone so menu order and the system suffix are
 * deterministic on any host zone.
 * @param timeZone - IANA zone the component must resolve as the system zone.
 */
function pinSystemZone(timeZone: string): void {
  const options = new Intl.DateTimeFormat().resolvedOptions()
  vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockReturnValue({ ...options, timeZone })
}

// Zone menu cases run against one pinned system zone and re-pin it to prove the
// system-first ordering and the suffix rule. jsdom has no `scrollIntoView`, which
// the open clock panel calls to bring the staged value into view.
/** Device zone the cases pin: a rule without a stored zone seeds its clock in it. */
const DEVICE_ZONE = 'Asia/Shanghai'
/** Elements whose `scrollIntoView` the open pickers called, in call order. */
const scrolledIntoView: Element[] = []
const scrollIntoView = vi.fn(function (this: Element) { scrolledIntoView.push(this) })
beforeEach(() => {
  pinSystemZone(DEVICE_ZONE)
  Element.prototype.scrollIntoView = scrollIntoView
  scrollIntoView.mockClear()
  scrolledIntoView.length = 0
})

// A task zone whose offset at the instant a case formats differs from the
// runner's own, so a task-zone render is distinguishable from a browser-zone
// render on any host. The zone is chosen per instant by that offset rather than
// by name, because two names can hold the same offset at one instant.
const taskZone = (instant: string): string => zoneDifferingFrom(instant)

function mount(
  initial: Partial<CatalogSnapshot<ScheduleCatalogEntry>> = {},
  dictionary: typeof en | typeof zh = en,
  overrides: Partial<TaskManagerPageProps> = {},
) {
  let snapshot: CatalogSnapshot<ScheduleCatalogEntry> = {
    records, status: 'ready', deleting: [], settled: true, readRequest: 0, readSettled: 0, ...initial,
  }
  const props: TaskManagerPageProps = {
    useCatalog: select => select(snapshot),
    useSessions: select => select(sessions),
    useWorkspaces: select => select(workspaces),
    usePanelInfo: select => select({ activePanelId: null }),
    useSessionStatus: select => select(new Map()),
    useSessionRetainInfo: () => undefined,
    useResource: () => { throw new Error('The task manager does not load document resources') },
    onDelete: vi.fn<TaskManagerPageProps['onDelete']>(async () => 'deleted'),
    onRetry: vi.fn(async () => {}),
    onNewTask: vi.fn(),
    onUpdateTiming: vi.fn<TaskManagerPageProps['onUpdateTiming']>(async ({ expected }) => ({
      ok: true, value: { id: expected.id, updated: false, record: expected },
    })),
    onOpenSession: vi.fn(),
    loadHistory: vi.fn<TaskManagerPageProps['loadHistory']>(async ({ id }) => {
      const receipt = snapshot.records.find(record => record.id === id)?.lastDelivery
      return { ok: true, value: {
        id, records: receipt === undefined ? [] : [receipt], earlierRecordsUnavailable: true,
        earlierRecordsPruned: false, retention: { days: 30, records: 200 },
      } }
    }),
    t: makeTranslate(dictionary),
    ...overrides,
  }
  const view = render(<TaskManagerPage {...props} />)
  return {
    props, view,
    updateTiming: vi.mocked(props.onUpdateTiming),
    update(next: Partial<CatalogSnapshot<ScheduleCatalogEntry>>) {
      snapshot = { ...snapshot, ...next }
      view.rerender(<TaskManagerPage {...props} />)
    },
  }
}

function taskNames(): string[] {
  return within(screen.getByRole('list', { name: en['list.label'] })).queryAllByRole('button')
    .filter(button => button.closest('li') !== null)
    .map(button => button.getAttribute('aria-label')!)
}

/** The empty state's mock action, which starts a new Session like the heading's. */
function emptyNewTaskButton(dictionary: typeof en | typeof zh = en): HTMLElement {
  return within(screen.getByRole('status')).getByRole('button', { name: dictionary['empty.action'] })
}

function detailViewLabels(dictionary: typeof en | typeof zh) {
  return dictionary === en
    ? {
      tablist: 'Task detail views', rules: 'Rules', records: 'Delivery records',
      empty: 'No delivery record available',
    }
    : {
      tablist: '任务详情视图', rules: '规则', records: '任务运行记录',
      empty: '暂无任务运行记录',
    }
}

function expectDetailView(dictionary: typeof en | typeof zh, active: 'rules' | 'records'): HTMLElement {
  const labels = detailViewLabels(dictionary)
  const detail = screen.getByRole('complementary', { name: dictionary['detail.label'] })
  const tabs = within(detail).getByRole('tablist', { name: labels.tablist })
  expect(within(tabs).getAllByRole('tab')).toHaveLength(2)
  for (const view of ['rules', 'records'] as const) {
    const tab = within(tabs).getByRole('tab', { name: labels[view] })
    expect(tab.getAttribute('aria-selected')).toBe(String(view === active))
    expect(tab.tabIndex).toBe(view === active ? 0 : -1)
  }
  const tab = within(tabs).getByRole('tab', { name: labels[active] })
  const panel = within(detail).getByRole('tabpanel', { name: labels[active] })
  expect(within(detail).getAllByRole('tabpanel')).toEqual([panel])
  expect(panel.id).not.toBe('')
  expect(tab.id).not.toBe('')
  expect(tab.getAttribute('aria-controls')).toBe(panel.id)
  expect(panel.getAttribute('aria-labelledby')).toBe(tab.id)
  expect(isInaccessible(panel)).toBe(false)
  return panel
}

function visibleText(root: HTMLElement, text: string): HTMLElement[] {
  return within(root).queryAllByText(text, { exact: true }).filter(element => !isInaccessible(element))
}

/** The detail's non-scrolling linked-Session row, or null when the view has none. */
function detailContext(detail: HTMLElement): HTMLElement | null {
  return detail.querySelector<HTMLElement>(`.${css.detailContext}`)
}

/** The next-run `<time>` the detail's next-run line shows, or null for an ended rule. */
function nextRunTime(root: HTMLElement): HTMLTimeElement | null {
  return root.querySelector<HTMLTimeElement>(`.${css.nextRun} time`)
}

/**
 * The absolute next-run text the row and detail state for one instant, in the
 * device zone the cases pin.
 */
function absoluteNextRun(scheduledAt: string, dictionary: typeof en | typeof zh): string {
  return formatScheduleAbsolute(scheduledAt, dictionary['time.locale'])
}

/** The parenthesized distance the row and detail keep beside that absolute time. */
function relativeNextRun(scheduledAt: string, dictionary: typeof en | typeof zh): string {
  return `(${remainingUntil(scheduledAt, dictionary)})`
}

/** One element's parenthesized distance, or null when it states none. */
function relativeText(root: HTMLElement): string | null {
  return root.querySelector<HTMLElement>(`.${css.nextRunRelative}`)?.textContent ?? null
}

/**
 * The relative next-run text both the row and the detail render for one instant.
 *
 * The components sample their reference clock once per mount, so the assertion
 * reads the same clock at assert time; every fixture instant is days away, where
 * one unit of drift cannot change the rendered value.
 * @param scheduledAt - stored target instant.
 * @param dictionary - active locale dictionary.
 * @returns the localized time remaining, or overdue text.
 */
function remainingUntil(scheduledAt: string, dictionary: typeof en | typeof zh): string {
  return formatScheduleRelative(scheduledAt, Date.now(), makeTranslate(dictionary))
}

/** Whether `later` follows `earlier` in document order. */
function follows(earlier: Element, later: Element): boolean {
  return (earlier.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
}

/** The detail's editable task name control. */
function nameField(dictionary: typeof en | typeof zh = en): HTMLInputElement {
  return screen.getByRole<HTMLInputElement>('textbox', { name: dictionary['detail.name'] })
}

/** The detail's editable instruction control. */
function instructionField(dictionary: typeof en | typeof zh = en): HTMLTextAreaElement {
  return screen.getByRole<HTMLTextAreaElement>('textbox', { name: dictionary['detail.instruction'] })
}

/**
 * Assert the vertical structure the mock fixes for Rules: the detail views at
 * the top of the panel, the editable name leading the scrolling area, the
 * next-run line directly under it, and the instruction under that. Delivery
 * records drops the name and next-run line, leaving the tab strip as its whole header.
 * @param detail - the detail region to inspect.
 * @param dictionary - locale whose accessible names the region carries.
 * @param name - the task name the name control must show.
 */
function expectDetailOrder(detail: HTMLElement, dictionary: typeof en | typeof zh, name: string): void {
  const tabs = within(detail).getByRole('tablist', { name: detailViewLabels(dictionary).tablist })
  const nameControl = within(detail).getByRole<HTMLInputElement>('textbox', { name: dictionary['detail.name'] })
  const body = detail.querySelector<HTMLElement>(`.${css.detailScroll}`)!
  const heading = body.querySelector<HTMLElement>(`.${css.detailHeader}`)
  const nextRun = body.querySelector<HTMLElement>(`.${css.nextRun}`)!
  expect(nameControl.value).toBe(name)
  expect(follows(tabs, nameControl)).toBe(true)
  // The mock nests `.detail-heading` as the scrolling rule view's first content,
  // so the name control sits inside `.detail-scroll`, not in a bar above it.
  expect(heading).not.toBeNull()
  expect(heading?.parentElement).toBe(body)
  expect(body.firstElementChild).toBe(heading)
  expect(heading?.contains(nameControl)).toBe(true)
  expect(follows(nameControl, nextRun)).toBe(true)
  expect(follows(nextRun, within(body).getByRole('textbox', { name: dictionary['detail.instruction'] }))).toBe(true)
}

/** Open the detail's overflow menu and return it. */
function openMore(dictionary: typeof en | typeof zh = en): HTMLElement {
  fireEvent.click(screen.getByRole('button', { name: dictionary['detail.more'] }))
  return screen.getByRole('menu')
}

/** Open the shown rule's Repeat menu and choose one recurrence option. */
function chooseRepeat(label: string, dictionary: typeof en | typeof zh = en): void {
  fireEvent.click(within(screen.getByRole('region', { name: dictionary['rule.title'] }))
    .getByRole('button', { name: new RegExp(`^${dictionary['rule.repeat']}`) }))
  fireEvent.click(screen.getByRole('menuitem', { name: label }))
}

/** The Frequency selector of the cron builder's rows. */
function cronFrequencyButton(dictionary: typeof en | typeof zh = en): HTMLElement {
  return within(screen.getByRole('region', { name: dictionary['rule.title'] }))
    .getByRole('button', { name: new RegExp(`^${dictionary['cronForm.frequency']}`) })
}

/** Open the cron builder's Frequency menu and choose one shape. */
function chooseCronShape(label: string, dictionary: typeof en | typeof zh = en): void {
  fireEvent.click(cronFrequencyButton(dictionary))
  fireEvent.click(screen.getByRole('menuitem', { name: label }))
}

/** The Repeat selector of the shown rule's Run time card. */
function repeatButton(dictionary: typeof en | typeof zh = en): HTMLElement {
  return within(screen.getByRole('region', { name: dictionary['rule.title'] }))
    .getByRole('button', { name: new RegExp(`^${dictionary['rule.repeat']}`) })
}

/** The Time zone selector of the shown rule's Run time card. */
function zoneButton(dictionary: typeof en | typeof zh = en): HTMLElement {
  return within(screen.getByRole('region', { name: dictionary['rule.title'] }))
    .getByRole('button', { name: new RegExp(`^${dictionary['timing.zone']}`) })
}

/** Localized offset/name pair produced by the same ICU-backed formatter as the UI. */
function displayedZone(zone: string, dictionary: typeof en | typeof zh = en): string {
  return zoneLabel(zone, makeTranslate(dictionary))
}

/** Open the Time zone menu, filter by canonical IANA id, and choose the result. */
function chooseZone(zone: string, dictionary: typeof en | typeof zh = en): void {
  fireEvent.click(zoneButton(dictionary))
  fireEvent.change(screen.getByRole('searchbox', { name: dictionary['timing.zoneSearch'] }), {
    target: { value: zone },
  })
  fireEvent.click(screen.getByRole('menuitem'))
}

/** The Weekday toggle group of the shown rule's Run time card. */
function weekdayGroup(dictionary: typeof en | typeof zh = en): HTMLElement {
  return within(screen.getByRole('region', { name: dictionary['rule.title'] }))
    .getByRole('group', { name: dictionary['rule.weekday'] })
}

/**
 * The Date row's picker trigger of the shown rule's Run time card.
 *
 * Scoped to the card: the open panel carries the row's own label and is portaled
 * outside it, so an unscoped lookup would match both while the panel shows.
 */
function dateButton(dictionary: typeof en | typeof zh = en): HTMLButtonElement {
  return within(screen.getByRole('region', { name: dictionary['rule.title'] }))
    .getByLabelText<HTMLButtonElement>(dictionary['timing.date'])
}

/** The Time row's picker trigger of the shown rule's Run time card, scoped like `dateButton`. */
function timeButton(dictionary: typeof en | typeof zh = en): HTMLButtonElement {
  return within(screen.getByRole('region', { name: dictionary['rule.title'] }))
    .getByLabelText<HTMLButtonElement>(dictionary['timing.time'])
}

/** One column of the open clock panel, by the row copy that names it. */
function clockColumn(
  key: 'timing.hour' | 'timing.minute' | 'timing.second', dictionary: typeof en | typeof zh = en,
): HTMLElement {
  return screen.getByRole('listbox', { name: dictionary[key] })
}

/**
 * Pick one clock value from the open column and return the staged clock text.
 * @param hour - hour option text.
 * @param minute - minute option text.
 * @param second - second option text, or undefined for a panel without the seconds column.
 * @param dictionary - active locale.
 * @returns the trigger's text once the picks are staged.
 */
function chooseClock(
  hour: string, minute: string, second: string | undefined, dictionary: typeof en | typeof zh = en,
): string {
  const picks: readonly (readonly ['timing.hour' | 'timing.minute' | 'timing.second', string])[] = [
    ['timing.hour', hour], ['timing.minute', minute],
    ...second === undefined ? [] : [['timing.second', second] as const],
  ]
  for (const [key, value] of picks) {
    fireEvent.click(within(clockColumn(key, dictionary)).getByRole('option', { name: value }))
  }
  return timeButton(dictionary).textContent ?? ''
}

/**
 * Stage one clock from the Time row's picker, opening its panel when closed.
 * @param hour - hour option text.
 * @param minute - minute option text.
 * @param second - second option text, or undefined for a panel without the seconds column.
 * @param dictionary - active locale.
 * @returns the trigger's text once the picks are staged.
 */
function chooseTime(
  hour: string, minute: string, second: string | undefined, dictionary: typeof en | typeof zh = en,
): string {
  if (screen.queryByRole('listbox', { name: dictionary['timing.hour'] }) === null) fireEvent.click(timeButton(dictionary))
  return chooseClock(hour, minute, second, dictionary)
}

/**
 * Stage one calendar day from the Date row's picker, opening its panel and moving
 * forward through the months it needs.
 * @param day - day of the target month.
 * @param monthsAhead - months to move forward from the month the row shows.
 * @param dictionary - active locale.
 * @returns the trigger's text once the day is staged.
 */
function chooseDay(day: number, monthsAhead = 0, dictionary: typeof en | typeof zh = en): string {
  if (screen.queryByRole('grid', { name: /.+/ }) === null) fireEvent.click(dateButton(dictionary))
  for (let step = 0; step < monthsAhead; step += 1) {
    fireEvent.click(screen.getByRole('button', { name: dictionary['timing.nextMonth'] }))
  }
  fireEvent.click(dayCell(day))
  return dateButton(dictionary).textContent ?? ''
}

/** The day cell of the open month grid. */
function dayCell(day: number): HTMLElement {
  return screen.getAllByRole('gridcell', { name: String(day) })[0]!
}

/** The monthly date toggle group of the shown rule's Run time card. */
function dateGroup(dictionary: typeof en | typeof zh = en): HTMLElement {
  return within(screen.getByRole('region', { name: dictionary['rule.title'] }))
    .getByRole('group', { name: dictionary['cronForm.dates'] })
}

/** Accessible name of one date toggle. */
function dateName(day: number, dictionary: typeof en | typeof zh = en): string {
  return dictionary['cronForm.dateOption'].replace('{day}', String(day))
}

/** Days of the monthly date group whose toggles are pressed. */
function datesPressed(group: HTMLElement): number[] {
  return within(group).getAllByRole('button')
    .filter(day => day.getAttribute('aria-pressed') === 'true')
    .map(day => Number(day.textContent))
}

/** Pressed state of the Weekday group's seven toggles, Monday through Sunday. */
function weekdayPressed(group: HTMLElement): (string | null)[] {
  return within(group).getAllByRole('button').map(day => day.getAttribute('aria-pressed'))
}

/** Accessible name of one English Weekday toggle. */
function weekdayName(key: `frequency.weekday.${1 | 2 | 3 | 4 | 5 | 6 | 7}`): string {
  return en['rule.weekdayOption'].replace('{weekday}', en[key])
}

/** The staged-edit bar of the shown detail, or null while the draft is clean. */
function saveFooter(): HTMLElement | null {
  return document.querySelector<HTMLElement>(`.${css.saveFooter}`)
}

/** The dirty notice of the staged-edit bar, or null while the bar is absent. */
function saveNotice(): HTMLElement | null {
  return saveFooter()?.querySelector<HTMLElement>(`.${css.saveNotice}`) ?? null
}

/** Click the staged-edit bar's Save changes action. */
function clickSave(dictionary: typeof en | typeof zh = en): void {
  fireEvent.click(within(saveFooter()!).getByRole('button', { name: dictionary['rule.save'] }))
}

/** Click the staged-edit bar's Cancel action. */
function clickCancel(dictionary: typeof en | typeof zh = en): void {
  fireEvent.click(within(saveFooter()!).getByRole('button', { name: dictionary['rule.cancel'] }))
}

/** Choose the overflow menu's delete row, opening the menu first. */
function chooseDelete(dictionary: typeof en | typeof zh = en): void {
  fireEvent.click(screen.getByRole('button', { name: dictionary['detail.more'] }))
  fireEvent.click(screen.getByRole('menuitem', { name: dictionary['delete.action'] }))
}

function openDelete(dictionary: typeof en | typeof zh = en): HTMLElement {
  fireEvent.click(screen.getByRole('button', { name: 'Review release' }))
  chooseDelete(dictionary)
  return screen.getByRole('dialog', { name: dictionary['delete.title'] })
}

function remoteCatalog() {
  const list = vi.fn<() => Promise<RemoteResult<ScheduleCatalogEntry[]>>>()
    .mockResolvedValue({ ok: true, value: [at] })
  const remove = vi.fn<(id: ScheduleId) => Promise<RemoteResult<ScheduleDeleteResult>>>()
    .mockResolvedValue({ ok: true, value: { id: at.id, deleted: true } })
  const source = createCatalogSource({
    list, remove,
    subscribeChanged: () => () => {},
    subscribeReset: () => () => {},
  })
  const onDelete = vi.fn(source.onDelete)
  const mounted = mount({}, en, {
    useCatalog: bindSnapshotSelector(source.hooks.catalog), onDelete, onRetry: source.onRetry,
  })
  return { ...mounted, list, remove, onDelete }
}

describe.each([['English', en], ['Chinese', zh]] as const)('original Session availability in %s', (_name, dictionary) => {
  it.each([
    ['Session list pending', { ...sessions, phase: 'pending' as const }, workspaces, 'Loading original session information.', '正在加载原会话信息'],
    ['Workspace list pending', sessions, { ...workspaces, phase: 'pending' as const }, 'Loading original session information.', '正在加载原会话信息'],
    ['archived', sessions, { ...workspaces, archivedSessionIds: [at.sessionId] }, 'The original session is archived.', '原会话已归档'],
    ['missing', { ...sessions, ids: [], byId: {} }, workspaces, 'The original session is unavailable.', '原会话当前不可用'],
    ['archive read failed', sessions, { ...workspaces, state: 'error' as const, error: new RemoteError('gateway/internal', 'Archive unavailable', {}) }, 'The original session is unavailable.', '原会话当前不可用'],
  ] satisfies [string, SessionListState, WorkspaceSnapshot, string, string][])('disables navigation while %s without hiding the task', (_reason, sessionState, workspaceState, english, chinese) => {
    const { props } = mount({ records: [ended] }, dictionary, {
      useSessions: select => select(sessionState), useWorkspaces: select => select(workspaceState),
    })
    fireEvent.click(screen.getByRole('button', { name: 'Review release' }))
    const link = screen.getByRole('button', { name: dictionary['detail.openSession'] })
    expect(link.hasAttribute('disabled')).toBe(true)
    fireEvent.click(link)
    expect(props.onOpenSession).not.toHaveBeenCalled()
    expect(screen.getByText(dictionary === en ? english : chinese)).toBeDefined()
    expect(within(link).getByText(at.sessionId)).toBeDefined()
    openMore(dictionary)
    expect(screen.getByRole('menuitem', { name: dictionary['delete.action'] }).hasAttribute('disabled')).toBe(false)
  })
})

describe.each([['English', en], ['Chinese', zh]] as const)('linked-Session control naming in %s', (_name, dictionary) => {
  it('contains the visible Linked session label when a catalog title names the Session', () => {
    mount({ records: [ended] }, dictionary, {
      useSessions: select => select(sessionsWithTitles({ [ended.sessionId]: 'Planning chat' })),
    })
    fireEvent.click(screen.getByRole('button', { name: 'Review release' }))
    const link = screen.getByRole('button', {
      name: dictionary['detail.openSessionTitle'].replace('{title}', 'Planning chat'),
    })
    expect(within(link).getByText(dictionary['detail.session'])).toBeDefined()
    expect(link.getAttribute('aria-label')).toContain(dictionary['detail.session'])
  })

  it('contains the visible Linked session label without a catalog title', () => {
    mount({ records: [ended] }, dictionary)
    fireEvent.click(screen.getByRole('button', { name: 'Review release' }))
    const link = screen.getByRole('button', { name: dictionary['detail.openSession'] })
    expect(within(link).getByText(dictionary['detail.session'])).toBeDefined()
    expect(link.getAttribute('aria-label')).toContain(dictionary['detail.session'])
  })
})

it('updates original Session navigation as metadata arrives and archive state changes', () => {
  let state: WorkspaceSnapshot = { ...workspaces, phase: 'pending' }
  const mounted = mount({ records: [ended] }, en, { useWorkspaces: select => select(state) })
  fireEvent.click(screen.getByRole('button', { name: 'Review release' }))
  const link = () => screen.getByRole('button', { name: en['detail.openSession'] })
  expect(link().hasAttribute('disabled')).toBe(true)
  state = { ...workspaces, archivedSessionIds: [at.sessionId] }
  mounted.update({})
  expect(screen.getByText(en['detail.sessionArchived'])).toBeDefined()
  state = workspaces
  mounted.update({})
  expect(link().hasAttribute('disabled')).toBe(false)
  expect(screen.queryByText(en['detail.sessionArchived'])).toBeNull()
  fireEvent.click(link())
  expect(mounted.props.onOpenSession).toHaveBeenCalledWith(at.sessionId)
  openMore()
  expect(screen.getByRole('menuitem', { name: en['delete.action'] })).toBeDefined()
})

describe('Task manager catalog', () => {
  it('starts a new Session instead of offering a page creation form', () => {
    const h = mount({ records: [at] })
    // The heading's compact action and the empty state's named action are the
    // mock's two creation entries; only the heading's shows while a row exists.
    fireEvent.click(screen.getByRole('button', { name: en['new.action'] }))
    expect(h.props.onNewTask).toHaveBeenCalledOnce()
    expect(screen.queryByRole('button', { name: en['empty.action'] })).toBeNull()
  })

  it('lays the page out on the mock content column, heading, search field, and rows', () => {
    mount()
    const page = screen.getByTestId('task-manager-page')
    // The mock's `.page-scroll` > `.automation-content` scroll as one column.
    const scroll = page.querySelector<HTMLElement>(`.${css.pageScroll!}`)!
    const content = page.querySelector<HTMLElement>(`.${css.pageContent!}`)!
    expect(scroll.contains(content)).toBe(true)
    // The mock's heading row: one h1 beside the creation actions, no subtitle.
    const heading = page.querySelector<HTMLElement>(`.${css.pageHeading!}`)!
    expect(heading.querySelector('h1')?.textContent).toBe(en['title'])
    expect(heading.querySelector('p')).toBeNull()
    expect(heading.querySelector(`.${css.creationActions!}`)?.textContent).toBe(en['new.action'])
    // The filter row carries the status group alone: the type chips are gone.
    const filters = page.querySelector<HTMLElement>(`.${css.filters!}`)!
    expect(within(filters).getAllByRole('group')).toHaveLength(1)
    const statuses = within(filters).getByRole('group', { name: en['statusFilter.label'] })
    expect(statuses.parentElement).toBe(filters)
    expect(within(statuses).getAllByRole('button')[0]?.textContent).toBe(en['statusFilter.all'])
    // The mock's `.searchbox`: the same field carries the leading glyph, the
    // placeholder, and — once a value exists — the inline clear control.
    const field = page.querySelector<HTMLElement>(`.${css.searchField!}`)!
    const input = screen.getByRole('searchbox', { name: en['search.label'] })
    expect(field.contains(input)).toBe(true)
    expect(input.getAttribute('placeholder')).toBe(en['search.placeholder'])
    expect(field.querySelector('svg')).not.toBeNull()
    expect(field.querySelector(`.${css.searchClear!}`)).toBeNull()
    fireEvent.change(input, { target: { value: 'metrics' } })
    expect(field.querySelector(`.${css.searchClear!}`)).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en['search.clear'] }))
    expect(field.querySelector(`.${css.searchClear!}`)).toBeNull()
    // The Plugins page's card column: plain list items with no separator; the
    // column's own 2px gap breaks the rows apart.
    const list = screen.getByRole('list', { name: en['list.label'] })
    const wraps = list.querySelectorAll(':scope > li')
    expect(wraps).toHaveLength(3)
    for (const wrap of wraps) expect(wrap.querySelector(`.${css.row!}`)).not.toBeNull()
    expect(list.querySelector(`.${css.row!}`)?.querySelector(`.${css.rowTitle!}`)?.textContent).toBe('Send summary')
  })

  it('lists cross-session active records by target time without unsupported actions', () => {
    mount()
    expect(screen.getByRole('heading', { level: 1, name: 'Automation tasks' })).toBeDefined()
    expect(taskNames()).toEqual(['Send summary', 'Review release', 'Check metrics'])
    expect(screen.queryByText('session-alpha')).toBeNull()
    expect(screen.queryByText('session-beta')).toBeNull()
    expect(screen.queryByText('session-gamma')).toBeNull()
    expect(screen.getAllByText('Once')).toHaveLength(2)
    expect(screen.getByText('Every 301 seconds')).toBeDefined()
    expect(screen.queryByRole('button', { name: /create|new task|pause|resume|edit|run now|history/i })).toBeNull()
    expect(screen.queryByRole('complementary')).toBeNull()
    fireEvent.keyDown(screen.getByRole('searchbox'), { key: 'Escape' })
    expect(taskNames()).toHaveLength(3)
  })

  it('names every list row and the selected detail from the stored title', () => {
    const named = { ...at, title: 'Release review' }
    mount({ records: [named, after] })
    expect(taskNames()).toEqual(['Send summary', 'Release review'])
    fireEvent.click(screen.getByRole('button', { name: 'Release review' }))
    const detail = within(screen.getByRole('complementary'))
    // The detail names the task through the editable name control, not the list row's label.
    expect((detail.getByRole<HTMLInputElement>('textbox', { name: en['detail.name'] })).value).toBe('Release review')
    // The instruction control still shows the complete stored instruction.
    expect((detail.getByRole<HTMLTextAreaElement>('textbox', { name: en['detail.instruction'] })).value)
      .toContain(named.prompt)
  })

  it('uses shared exact frequency units in the list and selected detail', () => {
    const h = mount({ records: [{ ...every, everySeconds: 3_600 }] })
    expect(screen.getByText('Every 1 hour')).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: 'Check metrics' }))
    expect(within(screen.getByRole('complementary')).getByText(en['rule.everyHours'])).toBeDefined()
    h.view.rerender(<TaskManagerPage {...h.props} t={makeTranslate(zh)} />)
    expect(within(screen.getByRole('complementary')).getByText(zh['rule.everyHours'])).toBeDefined()
  })

  it('describes row frequency and next time without exposing its Session', () => {
    const h = mount({ records: [every] })
    const row = screen.getByRole('button', {
      name: 'Check metrics', description: /^Every 301 seconds.*Next scheduled time:/,
    })
    const descriptionId = row.getAttribute('aria-describedby')!
    const metadata = document.getElementById(descriptionId)!
    const time = metadata.querySelector('time')!
    expect(time.dateTime).toBe(every.scheduledAt)
    // The line leads with the absolute stamp in the device zone and keeps the
    // distance in parentheses beside it.
    expect(time.textContent).toBe(absoluteNextRun(every.scheduledAt, en))
    expect(relativeText(metadata)).toBe(relativeNextRun(every.scheduledAt, en))
    expect(time.parentElement?.textContent)
      .toBe(`${en['list.nextPrefix']}${time.textContent} ${relativeNextRun(every.scheduledAt, en)}`)
    expect(metadata.textContent).not.toContain(every.sessionId)
    // Rows carry no Enabled word: every listed task is running unless the line
    // says otherwise, so only the ended state is named.
    expect(metadata.textContent).not.toContain(en['status.active'])
    row.focus()
    expect(document.activeElement).toBe(row)
    h.view.rerender(<TaskManagerPage {...h.props} t={makeTranslate(zh)} />)
    expect(screen.getByRole('button', {
      name: 'Check metrics', description: /^每 301 秒.*下次计划时间：/,
    })).toBe(row)
    expect(time.textContent).toBe(absoluteNextRun(every.scheduledAt, zh))
    expect(relativeText(metadata)).toBe(relativeNextRun(every.scheduledAt, zh))
    expect(time.parentElement?.textContent)
      .toBe(`${zh['list.nextPrefix']}${time.textContent} ${relativeNextRun(every.scheduledAt, zh)}`)
  })

  it('shortens the stated time remaining as the clock advances', () => {
    // A page left open keeps reading its clock: the text names the time until
    // the target now, not the time it had when the row mounted.
    vi.useFakeTimers()
    try {
      const base = Date.parse('2026-09-18T12:00:00.000Z')
      vi.setSystemTime(base)
      const soon: ScheduleCatalogEntry = {
        ...at, title: 'Three minutes out', prompt: 'Three minutes out',
        scheduledAt: new Date(base + 3 * 60_000).toISOString(),
      }
      mount({ records: [soon] })
      const rowList = (): HTMLElement => screen.getByRole('list')
      expect(relativeText(rowList())).toBe('(in 3 minutes)')
      fireEvent.click(screen.getByRole('button', { name: 'Three minutes out' }))
      const detail = screen.getByRole('complementary', { name: en['detail.label'] })
      expect(nextRunTime(detail)?.textContent).toBe(absoluteNextRun(soon.scheduledAt, en))
      expect(relativeText(detail)).toBe('(in 3 minutes)')

      act(() => { vi.advanceTimersByTime(121_000) })
      expect(relativeText(rowList())).toBe('(in 1 minute)')
      expect(relativeText(detail)).toBe('(in 1 minute)')
      // The absolute stamp names the same instant before and after the tick.
      expect(nextRunTime(detail)?.textContent).toBe(absoluteNextRun(soon.scheduledAt, en))
    } finally {
      vi.useRealTimers()
    }
  })

  it('states the time remaining until the next run in each locale', () => {
    // The row and the detail state a duration, not a date: zh reads `2小时后`
    // and en reads `in 2 hours`, and neither renders a clock time for it. The
    // fixture is two hours out, where a few milliseconds of clock drift cannot
    // change the rendered unit.
    const soon: ScheduleCatalogEntry = {
      ...at, title: 'Two hours out', prompt: 'Two hours out',
      scheduledAt: new Date(Date.now() + 2 * 3_600_000).toISOString(),
    }
    for (const dictionary of [en, zh]) {
      const h = mount({ records: [soon] }, dictionary)
      const expected = dictionary === en ? 'in 2 hours' : '2小时后'
      const row = screen.getByRole('button', { name: 'Two hours out' })
      const summary = row.querySelector<HTMLElement>(`.${css.rowSummary!}`)?.textContent ?? ''
      expect(summary).toContain(expected)
      // The distance itself renders no clock; the absolute stamp beside it does.
      expect(relativeText(row)).toBe(`(${expected})`)
      expect(relativeText(row) ?? '').not.toMatch(/\d{1,2}:\d{2}/)
      expect(row.querySelector('time')?.textContent).toBe(absoluteNextRun(soon.scheduledAt, dictionary))
      fireEvent.click(row)
      const detail = screen.getByRole('complementary', { name: dictionary['detail.label'] })
      expect(nextRunTime(detail)?.textContent).toBe(absoluteNextRun(soon.scheduledAt, dictionary))
      expect(relativeText(detail)).toBe(`(${expected})`)
      h.view.unmount()
    }
  })

  it('searches the complete instruction and session ID case-insensitively', () => {
    mount()
    const input = screen.getByRole('searchbox', { name: en['search.label'] })
    fireEvent.change(input, { target: { value: '  RISKS  ' } })
    expect(taskNames()).toEqual(['Review release'])
    fireEvent.change(input, { target: { value: 'SESSION-GAMMA' } })
    expect(taskNames()).toEqual(['Check metrics'])
    fireEvent.click(screen.getByRole('button', { name: en['search.clear'] }))
    expect((input as HTMLInputElement).value).toBe('')
    expect(taskNames()).toHaveLength(3)
    expect(screen.queryByRole('button', { name: en['search.clear'] })).toBeNull()
  })

  it('matches the stored task name and instruction without exposing the Session label', () => {
    const renamed: ScheduleCatalogEntry = { ...at, title: 'Quarterly report', prompt: 'Send the numbers' }
    mount({ records: [renamed, every] }, en, {
      useSessions: select => select(sessionsWithTitles({ [renamed.sessionId]: 'Planning chat' })),
    })
    const input = screen.getByRole('searchbox', { name: en['search.label'] })
    fireEvent.change(input, { target: { value: 'quarterly' } })
    expect(taskNames()).toEqual(['Quarterly report'])
    fireEvent.change(input, { target: { value: 'planning' } })
    expect(taskNames()).toEqual([])
    fireEvent.change(input, { target: { value: 'numbers' } })
    expect(taskNames()).toEqual(['Quarterly report'])
  })

  it('combines search with the status filter and clears a no-match result from the empty state', () => {
    const h = mount()
    const statuses = screen.getByRole('group', { name: en['statusFilter.label'] })
    const chooseStatus = (name: string) => fireEvent.click(within(statuses).getByRole('button', { name }))
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'release' } })
    expect(taskNames()).toEqual(['Review release'])
    chooseStatus(en['status.inactive'])
    expect(taskNames()).toEqual([])
    expect(screen.getByRole('status').textContent).toContain(en['list.noMatches'])
    expect(screen.queryByText(en['list.empty'])).toBeNull()
    // The empty state's action keeps the mock's single creation entry: it starts a
    // new Session instead of resetting the filters the reader chose.
    fireEvent.click(emptyNewTaskButton())
    expect(h.props.onNewTask).toHaveBeenCalledOnce()
    expect(taskNames()).toEqual([])
    expect(screen.getByRole<HTMLInputElement>('searchbox').value).toBe('release')
    expect(within(statuses).getByRole('button', { name: en['status.inactive'] }).getAttribute('aria-pressed')).toBe('true')
    // The status filter is the one excluding every row the search selects.
    chooseStatus(en['statusFilter.all'])
    expect(taskNames()).toEqual(['Review release'])
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: '' } })
    expect(taskNames()).toEqual(['Send summary', 'Review release', 'Check metrics'])
  })

  it.each([en, zh])('combines all, active, and inactive status filters with search', (dictionary) => {
    mount({ records: [ended, every, after] }, dictionary)
    const list = screen.getByRole('list', { name: dictionary['list.label'] })
    const names = () => within(list).queryAllByRole('button')
      .filter(button => button.closest('li') !== null)
      .map(button => button.getAttribute('aria-label'))
    const statuses = screen.getByRole('group', { name: dictionary['statusFilter.label'] })
    const chooseStatus = (name: string) => fireEvent.click(within(statuses).getByRole('button', { name }))
    expect(names()).toEqual(['Send summary', 'Review release', 'Check metrics'])
    expect(within(statuses).getByRole('button', { name: dictionary['statusFilter.all'] }).getAttribute('aria-pressed')).toBe('true')
    chooseStatus(dictionary['status.active'])
    expect(names()).toEqual(['Send summary', 'Check metrics'])
    chooseStatus(dictionary['status.inactive'])
    expect(names()).toEqual(['Review release'])
    expect(within(statuses).getByRole('button', { name: dictionary['status.inactive'] }).getAttribute('aria-pressed')).toBe('true')
    chooseStatus(dictionary['statusFilter.all'])
    expect(names()).toHaveLength(3)
    chooseStatus(dictionary['status.inactive'])
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'SESSION-ALPHA' } })
    expect(names()).toEqual(['Review release'])
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'nothing matches' } })
    expect(names()).toEqual([])
    expect(screen.getByRole('status').textContent).toContain(dictionary['list.noMatches'])
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: '' } })
    expect(names()).toEqual(['Review release'])
    chooseStatus(dictionary['statusFilter.all'])
    expect(names()).toHaveLength(3)
    expect(screen.getByRole<HTMLInputElement>('searchbox').value).toBe('')
    expect(within(statuses).getByRole('button', { name: dictionary['statusFilter.all'] }).getAttribute('aria-pressed')).toBe('true')
  })

  it.each([
    { dictionary: en, frequency: 'Daily at 23:00' },
    { dictionary: zh, frequency: '每天 23:00' },
  ])('classifies daily wall-clock rules as repeating and omits the host zone: $frequency', ({ dictionary, frequency }) => {
    mount({ records: [...records, daily] }, dictionary)
    const list = screen.getByRole('list', { name: dictionary['list.label'] })
    const dailyRow = within(list).getByRole('button', { name: daily.prompt })
    expect(dailyRow.textContent).toContain(frequency)
    fireEvent.click(dailyRow)
    const detail = screen.getByRole('complementary', { name: dictionary['detail.label'] })
    expect(within(detail).getByText(frequency, { exact: true })).toBeDefined()
    expect(within(detail).queryByText(dictionary['frequency.once'], { exact: true })).toBeNull()
  })

  it('clears a status-only exclusion from its own filter group', () => {
    mount()
    fireEvent.click(screen.getByRole('button', { name: en['status.inactive'] }))
    expect(taskNames()).toEqual([])
    expect(screen.getByRole('status').textContent).toContain(en['list.emptyInactive'])
    expect(screen.getByRole('status').textContent).not.toContain(en['list.noMatches'])
    fireEvent.click(screen.getByRole('button', { name: en['statusFilter.all'] }))
    expect(taskNames()).toHaveLength(3)
    expect(screen.getByRole('button', { name: en['statusFilter.all'] }).getAttribute('aria-pressed')).toBe('true')
  })

  it('distinguishes an empty catalog, loading, and a failed read', () => {
    const h = mount({ records: [], status: 'loading' })
    expect(screen.getByRole('status', { name: en['list.loading'] }).textContent).toBe('')
    expect(screen.queryByText(en['list.empty'])).toBeNull()
    expect(screen.getByRole('list').getAttribute('aria-busy')).toBe('true')
    h.update({ status: 'error' })
    expect(screen.getByRole('alert').textContent).toBe(en['list.error'])
    expect(screen.queryByText(en['list.empty'])).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en['list.retry'] }))
    expect(h.props.onRetry).toHaveBeenCalledOnce()
    h.update({ status: 'ready' })
    expect(screen.getByRole('status').textContent).toContain(en['list.empty'])
    // The mock keeps one creation entry in the empty state whether or not a
    // query is active, so the action never disappears behind a filter.
    expect(emptyNewTaskButton().textContent).toBe(en['empty.action'])
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'missing' } })
    expect(screen.getByRole('status').textContent).toContain(en['list.empty'])
    expect(emptyNewTaskButton().textContent).toBe(en['empty.action'])
  })

  it('keeps previously loaded rows available during loading and errors', () => {
    const h = mount({ status: 'loading' })
    expect(taskNames()).toHaveLength(3)
    fireEvent.click(screen.getByRole('button', { name: 'Review release' }))
    openMore()
    expect(screen.getByRole('menuitem', { name: en['delete.action'] }).hasAttribute('disabled')).toBe(true)
    h.update({ status: 'error' })
    expect(taskNames()).toHaveLength(3)
    expect(screen.getByRole('complementary', { name: en['detail.label'] })).toBeDefined()
    expect(screen.getByRole('alert').textContent).toBe(en['list.error'])
  })
})

describe.each([['English', en], ['Chinese', zh]] as const)('task detail views in %s', (_name, dictionary) => {
  it('opens Rules under the selected task and separates rule fields from saved deliveries', async () => {
    const labels = detailViewLabels(dictionary)
    const h = mount({ records: [{ ...at, lastDelivery: delivery }] }, dictionary)
    const list = screen.getByRole('list', { name: dictionary['list.label'] })
    expect(screen.queryByRole('tablist', { name: labels.tablist })).toBeNull()
    const row = within(list).getByRole('button', { name: 'Review release' })
    fireEvent.click(row)
    const detail = screen.getByRole('complementary', { name: dictionary['detail.label'] })
    expect(row.getAttribute('aria-controls')).toBe(detail.id)
    expect(row.getAttribute('aria-expanded')).toBe('true')
    expect(within(list).queryByRole('tablist')).toBeNull()
    expectDetailOrder(detail, dictionary, 'Review release')
    const rules = expectDetailView(dictionary, 'rules')
    expect(h.props.loadHistory).not.toHaveBeenCalled()
    expect((within(rules).getByRole<HTMLTextAreaElement>('textbox', { name: dictionary['detail.instruction'] })).value)
      .toContain(at.prompt)
    // One compact next-run line leads the scrolling area under the name control.
    expect(nextRunTime(detail)?.dateTime).toBe(at.scheduledAt)
    expect(nextRunTime(detail)?.textContent).toBe(absoluteNextRun(at.scheduledAt, dictionary))
    expect(relativeText(detail)).toBe(relativeNextRun(at.scheduledAt, dictionary))
    // The Run time card carries the recurrence; status and task ID stay out of the overflow menu.
    const card = within(rules).getByRole('region', { name: dictionary['rule.title'] })
    expect(within(card).getByRole('button', { name: new RegExp(`^${dictionary['rule.repeat']}`) })).toBeDefined()
    expect(visibleText(card, dictionary['frequency.once'])).toHaveLength(1)
    expect(visibleText(detail, dictionary['status.active'])).toHaveLength(0)
    expect(visibleText(detail, at.id)).toHaveLength(0)
    const menu = openMore(dictionary)
    expect(within(menu).getAllByRole('menuitem')).toHaveLength(1)
    expect(within(menu).getByRole('menuitem', { name: dictionary['delete.action'] })).toBeDefined()
    fireEvent.keyDown(menu, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(within(detail).queryByRole('region', { name: dictionary['delivery.label'] })).toBeNull()
    expect(visibleText(detail, delivery.messageId)).toHaveLength(0)
    // The linked-Session strip belongs to Rules and sits outside the scroll region.
    const context = detailContext(detail)!
    const link = within(context).getByRole('button', { name: dictionary['detail.openSession'] })
    expect(rules.contains(context)).toBe(false)
    expect(isInaccessible(link)).toBe(false)
    fireEvent.click(link)
    expect(h.props.onOpenSession).toHaveBeenCalledExactlyOnceWith(at.sessionId)

    fireEvent.click(within(detail).getByRole('tab', { name: labels.records }))
    const recordPanel = expectDetailView(dictionary, 'records')
    const receipt = await within(recordPanel).findByRole('region', { name: dictionary['delivery.label'] })
    expect(h.props.loadHistory).toHaveBeenCalledExactlyOnceWith({ id: at.id, sessionId: at.sessionId, limit: 20 })
    expect(within(recordPanel).getAllByRole('region', { name: dictionary['delivery.label'] })).toHaveLength(1)
    expect(receipt.querySelector<HTMLTimeElement>(`.${css.deliveryTime}`)?.dateTime).toBe(delivery.scheduledAt)
    expect(receipt.querySelector('details')).toBeNull()
    expect(within(receipt).queryByRole('button')).toBeNull()
    expect(visibleText(recordPanel, labels.empty)).toHaveLength(0)
    expect(within(detail).queryByRole('textbox', { name: dictionary['detail.instruction'] })).toBeNull()
    for (const text of [dictionary['detail.status'], dictionary['detail.frequency'], dictionary['detail.id'], dictionary['rule.title'], at.id]) {
      expect(visibleText(detail, text)).toHaveLength(0)
    }
    // Delivery records replaces the name control, next-run line, and linked-Session strip.
    expect(visibleText(detail, dictionary['detail.nextRun'])).toHaveLength(0)
    expect(within(detail).queryByRole('textbox', { name: dictionary['detail.name'] })).toBeNull()
    expect(detail.querySelector(`.${css.nextRun}`)).toBeNull()
    expect(recordPanel.textContent).not.toContain(at.prompt)
    expect(recordPanel.querySelectorAll('time')).toHaveLength(1)
    expect(detailContext(detail)).toBeNull()
    expect(within(detail).queryByRole('button', { name: dictionary['detail.openSession'] })).toBeNull()
    expect(within(detail).queryByText(at.sessionId)).toBeNull()

    fireEvent.click(within(detail).getByRole('tab', { name: labels.rules }))
    expectDetailView(dictionary, 'rules')
    expect(within(detail).queryByRole('region', { name: dictionary['delivery.label'] })).toBeNull()
    expect(visibleText(detail, delivery.messageId)).toHaveLength(0)
    expect(detailContext(detail)).not.toBeNull()
  })

  it('drops the task name and next-run line on Delivery records and restores them on Rules', async () => {
    const labels = detailViewLabels(dictionary)
    mount({ records: [{ ...at, lastDelivery: delivery }] }, dictionary)
    fireEvent.click(screen.getByRole('button', { name: 'Review release' }))
    const detail = screen.getByRole('complementary', { name: dictionary['detail.label'] })
    expect(nameField(dictionary).value).toBe('Review release')
    expect(nextRunTime(detail)?.dateTime).toBe(at.scheduledAt)
    fireEvent.click(within(detail).getByRole('tab', { name: labels.records }))
    const panel = expectDetailView(dictionary, 'records')
    await within(panel).findByRole('region', { name: dictionary['delivery.label'] })
    expect(within(detail).queryByRole('textbox', { name: dictionary['detail.name'] })).toBeNull()
    expect(detail.querySelector(`.${css.nextRun}`)).toBeNull()
    expect(visibleText(detail, dictionary['detail.nextRun'])).toHaveLength(0)
    fireEvent.click(within(detail).getByRole('tab', { name: labels.rules }))
    expectDetailView(dictionary, 'rules')
    expect(nameField(dictionary).value).toBe('Review release')
    expect(nextRunTime(detail)?.dateTime).toBe(at.scheduledAt)
  })

  it.each(['active', 'inactive'] as const)('shows the no-record message for a successful empty history of a %s task', async (status) => {
    const labels = detailViewLabels(dictionary)
    mount({ records: [{ ...at, status }] }, dictionary)
    fireEvent.click(screen.getByRole('button', { name: 'Review release' }))
    fireEvent.click(screen.getByRole('tab', { name: labels.records }))
    const panel = expectDetailView(dictionary, 'records')
    await within(panel).findByText(labels.empty)
    expect(visibleText(panel, labels.empty)).toHaveLength(1)
    expect(within(panel).queryByRole('region', { name: dictionary['delivery.label'] })).toBeNull()
    expect(panel.querySelector('time')).toBeNull()
    expect(panel.textContent).not.toContain(at.prompt)
  })

  it('loads history independently of catalog loading and failure', async () => {
    const labels = detailViewLabels(dictionary)
    const pending = Promise.withResolvers<Awaited<ReturnType<TaskManagerPageProps['loadHistory']>>>()
    const h = mount({ records: [at], status: 'loading' }, dictionary, { loadHistory: vi.fn(() => pending.promise) })
    fireEvent.click(screen.getByRole('button', { name: 'Review release' }))
    fireEvent.click(screen.getByRole('tab', { name: labels.records }))
    const detail = screen.getByRole('complementary', { name: dictionary['detail.label'] })
    const panel = expectDetailView(dictionary, 'records')
    expect(visibleText(detail, labels.empty)).toHaveLength(0)
    expect(within(panel).getByRole('status', { name: dictionary['delivery.loading'] }).textContent).toBe('')
    // The detail already shows the selected task, so a catalog load adds no
    // indicator of its own there.
    expect(within(detail).queryByText(dictionary['list.loading'])).toBeNull()
    h.update({ status: 'error' })
    expect(visibleText(detail, labels.empty)).toHaveLength(0)
    expect(within(detail).getByRole('alert').textContent).toBe(dictionary['list.error'])
    fireEvent.click(within(detail).getByRole('button', { name: dictionary['list.retry'] }))
    expect(h.props.onRetry).toHaveBeenCalledOnce()
    await act(async () => {
      pending.resolve({ ok: true, value: {
        id: at.id, records: [], earlierRecordsUnavailable: false,
        earlierRecordsPruned: false, retention: { days: 30, records: 200 },
      } })
      await pending.promise
    })
    expect(visibleText(panel, labels.empty)).toHaveLength(1)
    expect(within(detail).getByRole('alert').textContent).toBe(dictionary['list.error'])
  })

  it('cycles and focuses tabs with arrows and Home or End without intercepting Tab', () => {
    const labels = detailViewLabels(dictionary)
    mount({ records: [ended] }, dictionary)
    fireEvent.click(screen.getByRole('button', { name: 'Review release' }))
    const rules = screen.getByRole('tab', { name: labels.rules })
    const recordTab = screen.getByRole('tab', { name: labels.records })
    rules.focus()
    for (const [key, active] of [
      ['ArrowRight', 'records'], ['ArrowRight', 'rules'],
      ['ArrowLeft', 'records'], ['ArrowLeft', 'rules'],
      ['End', 'records'], ['End', 'records'], ['Home', 'rules'], ['Home', 'rules'],
    ] as const) {
      expect(fireEvent.keyDown(document.activeElement!, { key })).toBe(false)
      expectDetailView(dictionary, active)
      expect(document.activeElement).toBe(active === 'rules' ? rules : recordTab)
    }
    expect(fireEvent.keyDown(rules, { key: 'Tab' })).toBe(true)
    expectDetailView(dictionary, 'rules')
    expect(fireEvent.keyDown(rules, { key: 'Tab', shiftKey: true })).toBe(true)
    fireEvent.keyDown(rules, { key: 'End' })
    expect(fireEvent.keyDown(recordTab, { key: 'Tab' })).toBe(true)
    expectDetailView(dictionary, 'records')
    expect(document.activeElement).toBe(recordTab)
    fireEvent.keyDown(recordTab, { key: 'Escape' })
    expect(screen.queryByRole('complementary')).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Review release' }))
  })

  it.each(['altKey', 'ctrlKey', 'metaKey', 'shiftKey'] as const)('preserves modified tab-navigation shortcuts for %s', (modifier) => {
    const labels = detailViewLabels(dictionary)
    mount({ records: [ended] }, dictionary)
    fireEvent.click(screen.getByRole('button', { name: 'Review release' }))
    const rules = screen.getByRole('tab', { name: labels.rules })
    rules.focus()
    for (const key of ['ArrowLeft', 'ArrowRight', 'Home', 'End']) {
      expect(fireEvent.keyDown(rules, { key, [modifier]: true })).toBe(true)
      expectDetailView(dictionary, 'rules')
      expect(document.activeElement).toBe(rules)
    }
  })

  it('resets to Rules when selecting another task or reopening closed details', () => {
    const labels = detailViewLabels(dictionary)
    mount({ records: [ended, every] }, dictionary)
    fireEvent.click(screen.getByRole('button', { name: 'Review release' }))
    fireEvent.click(screen.getByRole('tab', { name: labels.records }))
    expectDetailView(dictionary, 'records')
    fireEvent.click(screen.getByRole('button', { name: 'Check metrics' }))
    expect((within(expectDetailView(dictionary, 'rules')).getByRole<HTMLTextAreaElement>('textbox', { name: dictionary['detail.instruction'] })).value)
      .toContain(every.prompt)
    fireEvent.click(screen.getByRole('tab', { name: labels.records }))
    fireEvent.click(screen.getByRole('button', { name: 'Review release' }))
    // The reopened task is the ended one, whose instruction is plain text.
    expect(expectDetailView(dictionary, 'rules').querySelector(`.${css.readonlyPrompt}`)?.textContent)
      .toBe(at.prompt)
    for (const close of ['button', 'Escape'] as const) {
      fireEvent.click(screen.getByRole('tab', { name: labels.records }))
      if (close === 'button') fireEvent.click(screen.getByRole('button', { name: dictionary['detail.close'] }))
      else fireEvent.keyDown(screen.getByRole('tab', { name: labels.records }), { key: 'Escape' })
      expect(screen.queryByRole('complementary')).toBeNull()
      fireEvent.click(screen.getByRole('button', { name: 'Review release' }))
      expectDetailView(dictionary, 'rules')
    }
  })

  it('keeps the unavailable original Session on Rules and deletion available in Delivery records', () => {
    const labels = detailViewLabels(dictionary)
    const h = mount({ records: [ended] }, dictionary, {
      useSessions: select => select({ ...sessions, ids: [], byId: {} }),
    })
    fireEvent.click(screen.getByRole('button', { name: 'Review release' }))
    const detail = screen.getByRole('complementary', { name: dictionary['detail.label'] })
    const link = within(detail).getByRole('button', { name: dictionary['detail.openSession'] })
    expect(link.hasAttribute('disabled')).toBe(true)
    // The notice states its own line under the strip; the control stays in it.
    expect(visibleText(detail, dictionary['detail.sessionUnavailable'])).toHaveLength(1)
    expect(detailContext(detail)?.contains(link)).toBe(true)
    fireEvent.click(link)
    expect(h.props.onOpenSession).not.toHaveBeenCalled()
    fireEvent.click(within(detail).getByRole('tab', { name: labels.records }))
    expectDetailView(dictionary, 'records')
    // The linked-Session strip is Rules-only; deletion stays reachable from the header.
    expect(detailContext(detail)).toBeNull()
    const more = within(detail).getByRole('button', { name: dictionary['detail.more'] })
    chooseDelete(dictionary)
    const dialog = screen.getByRole('dialog', { name: dictionary['delete.title'] })
    // The dialog names the stored task, never its instruction body.
    expect(dialog.textContent).toContain(at.title)
    expect(dialog.textContent).not.toContain(at.prompt)
    expect(dialog.textContent).toContain(dictionary['delete.description'])
    // The English copy is two fragments joined into one sentence, so the dialog must
    // not render them run together.
    expect(en['delete.description']).toContain('records. The original session')
    expect(h.props.onDelete).not.toHaveBeenCalled()
    fireEvent.keyDown(dialog, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expectDetailView(dictionary, 'records')
    expect(document.activeElement).toBe(more)
    chooseDelete(dictionary)
    fireEvent.click(screen.getByRole('button', { name: dictionary['delete.cancel'] }))
    expectDetailView(dictionary, 'records')
    expect(h.props.onDelete).not.toHaveBeenCalled()
    chooseDelete(dictionary)
    fireEvent.click(screen.getByRole('button', { name: dictionary['delete.confirm'] }))
    expect(h.props.onDelete).toHaveBeenCalledExactlyOnceWith(ended.id)
    expect(screen.queryByRole('dialog')).toBeNull()
    expectDetailView(dictionary, 'records')
    h.update({ deleting: [ended.id] })
    openMore(dictionary)
    expect(screen.getByRole('menuitem', { name: dictionary['delete.pending'] }).hasAttribute('disabled')).toBe(true)
    h.update({ records: [], deleting: [] })
    // The refreshed catalog reports the row gone, so the detail closes; the
    // app-wide toast, not the panel, announces the outcome.
    expect(screen.queryByRole('complementary')).toBeNull()
  })
})

describe('saved-history task binding', () => {
  it.each([en, zh])('renders saved prompts rather than the current instruction', async (dictionary) => {
    const savedPrompt = 'Original saved instruction\n<img src=x onerror=alert(1)>'
    const loadHistory = vi.fn<TaskManagerPageProps['loadHistory']>().mockResolvedValue({ ok: true, value: {
      id: at.id, records: [{ ...delivery, prompt: savedPrompt }], earlierRecordsUnavailable: false,
      earlierRecordsPruned: false, retention: { days: 30, records: 200 },
    } })
    mount({ records: [ended] }, dictionary, { loadHistory })
    fireEvent.click(screen.getByRole('button', { name: 'Review release' }))
    expect(loadHistory).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('tab', { name: dictionary['detail.records'] }))
    const record = await screen.findByRole('region', { name: dictionary['delivery.label'] })
    expect(record.textContent).toContain(savedPrompt)
    expect(record.textContent).not.toContain(at.prompt)
    expect(record.querySelector('img')).toBeNull()
    expect(record.querySelector<HTMLElement>(`.${css.savedPrompt}`)?.textContent).toBe(savedPrompt)
  })

  it.each([en, zh])('never substitutes the current instruction for a record without a saved prompt', async (dictionary) => {
    const loadHistory = vi.fn<TaskManagerPageProps['loadHistory']>().mockResolvedValue({ ok: true, value: {
      id: at.id, records: [delivery], earlierRecordsUnavailable: false, earlierRecordsPruned: false, retention: { days: 30, records: 200 },
    } })
    mount({ records: [ended] }, dictionary, { loadHistory })
    fireEvent.click(screen.getByRole('button', { name: 'Review release' }))
    fireEvent.click(screen.getByRole('tab', { name: dictionary['detail.records'] }))
    const record = await screen.findByRole('region', { name: dictionary['delivery.label'] })
    expect(record.textContent).not.toContain(at.prompt)
    expect(record.querySelector(`.${css.savedPrompt}`)).toBeNull()
    expect(record.querySelectorAll('p')).toHaveLength(0)
    expect(record.querySelector('details')).toBeNull()
    expect(within(record).queryByRole('button')).toBeNull()
  })

  it.each(['success', 'rejection'] as const)('ignores old-task late %s and never displays its records in another task', async (outcome) => {
    const pending = Promise.withResolvers<Awaited<ReturnType<TaskManagerPageProps['loadHistory']>>>()
    const secondMessage = 'other-session-message' as typeof delivery.messageId
    const loadHistory = vi.fn<TaskManagerPageProps['loadHistory']>().mockReturnValueOnce(pending.promise)
      .mockResolvedValue({ ok: true, value: {
        id: every.id, records: [{ ...delivery, messageId: secondMessage, scheduledAt: every.scheduledAt }],
        earlierRecordsUnavailable: false,
        earlierRecordsPruned: false, retention: { days: 30, records: 200 },
      } })
    const h = mount({ records: [ended, every] }, en, { loadHistory })
    fireEvent.click(screen.getByRole('button', { name: 'Review release' }))
    fireEvent.click(screen.getByRole('tab', { name: en['detail.records'] }))
    fireEvent.click(screen.getByRole('button', { name: 'Check metrics' }))
    expectDetailView(en, 'rules')
    expect(loadHistory).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('tab', { name: en['detail.records'] }))
    await screen.findByText(formatScheduleNextRun(every.scheduledAt, en['time.locale']))
    expect(loadHistory).toHaveBeenLastCalledWith({ id: every.id, sessionId: every.sessionId, limit: 20 })
    await act(async () => {
      if (outcome === 'success') pending.resolve({ ok: true, value: {
        id: ended.id, records: [delivery], earlierRecordsUnavailable: true,
        earlierRecordsPruned: false, retention: { days: 30, records: 200 },
      } })
      else pending.reject(new Error('Old task query failed'))
      await pending.promise.catch(() => {})
    })
    const panel = expectDetailView(en, 'records')
    expect(within(panel).getByText(formatScheduleNextRun(every.scheduledAt, en['time.locale']))).toBeDefined()
    expect(within(panel).queryByText(formatScheduleNextRun(delivery.scheduledAt, en['time.locale']))).toBeNull()
    expect(within(panel).queryByRole('alert')).toBeNull()
    expect(h.props.onOpenSession).not.toHaveBeenCalled()
    openMore()
    expect(screen.getByRole('menuitem', { name: en['delete.action'] }).hasAttribute('disabled')).toBe(false)
  })

  it.each(['Rules', 'close', 'unmount'] as const)('ignores a pending history failure after %s leaves the records view', async (leave) => {
    const pending = Promise.withResolvers<Awaited<ReturnType<TaskManagerPageProps['loadHistory']>>>()
    const loadHistory = vi.fn<TaskManagerPageProps['loadHistory']>(() => pending.promise)
    const h = mount({ records: [ended] }, en, { loadHistory })
    fireEvent.click(screen.getByRole('button', { name: 'Review release' }))
    fireEvent.click(screen.getByRole('tab', { name: en['detail.records'] }))
    if (leave === 'Rules') fireEvent.click(screen.getByRole('tab', { name: en['detail.rule'] }))
    else if (leave === 'close') fireEvent.click(screen.getByRole('button', { name: en['detail.close'] }))
    else h.view.unmount()
    await act(async () => { pending.reject(new Error('Late rejection')); await pending.promise.catch(() => {}) })
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByRole('region', { name: en['delivery.label'] })).toBeNull()
  })
})

describe('Task manager details', () => {
  it.each([en, zh])('retains the selected row and detail after an authoritative inactive update with a delivery receipt', async (dictionary) => {
    const h = mount({ records: [at] }, dictionary)
    const row = screen.getByRole('button', { name: 'Review release' })
    fireEvent.click(row)
    const detail = screen.getByRole('complementary', { name: dictionary['detail.label'] })
    expect(nextRunTime(detail)?.dateTime).toBe(at.scheduledAt)
    expect(within(detail).queryByRole('region', { name: dictionary['delivery.label'] })).toBeNull()
    h.update({ records: [ended] })
    expect(screen.getByRole('complementary')).toBe(detail)
    expect(screen.getByRole('button', { name: 'Review release' })).toBe(row)
    expect(row.getAttribute('aria-expanded')).toBe('true')
    expect(row.querySelector('time')).toBeNull()
    expect(document.getElementById(row.getAttribute('aria-describedby')!)?.textContent).toContain(dictionary['status.inactive'])
    expect(within(detail).getByText(dictionary['status.inactive'])).toBeDefined()
    expect(visibleText(detail, dictionary['detail.nextRun'])).toHaveLength(0)
    expect(nextRunTime(detail)).toBeNull()
    expect(row.textContent).not.toContain(dictionary['list.nextPrefix'])
    expect(detail.textContent).not.toMatch(/execution completed|completed successfully|execution succeeded|执行已完成|执行成功/i)
    // The linked-Session strip belongs to Rules, so open it before switching views.
    const context = detailContext(detail)!
    const link = within(context).getByRole('button', { name: dictionary['detail.openSession'] })
    fireEvent.click(link)
    expect(h.props.onOpenSession).toHaveBeenCalledExactlyOnceWith(at.sessionId)
    fireEvent.click(within(detail).getByRole('tab', { name: detailViewLabels(dictionary).records }))
    const receipt = await within(expectDetailView(dictionary, 'records')).findByRole('region', { name: dictionary['delivery.label'] })
    const occurrence = receipt.querySelector<HTMLTimeElement>(`.${css.deliveryTime}`)
    expect(occurrence?.dateTime).toBe(delivery.scheduledAt)
    expect(occurrence?.textContent).toBe(formatScheduleNextRun(delivery.scheduledAt, dictionary['time.locale']))
    // The occurrence names its month in the active locale and never shows the
    // retired zero-padded `MM-DD` pair.
    expect(occurrence?.textContent ?? '').toMatch(/[A-Za-z]{3,}|月/)
    expect(occurrence?.textContent ?? '').not.toMatch(/\d{2}-\d{2}/)
    expect(receipt.querySelector('details')).toBeNull()
    expect(within(receipt).queryByRole('button')).toBeNull()
    expect(receipt.querySelectorAll('time')).toHaveLength(1)
    expect(within(detail).queryByRole('region', { name: /history|历史/i })).toBeNull()
    expect(detail.querySelector('footer')).toBeNull()
    expect(h.props.onDelete).not.toHaveBeenCalled()
  })

  it('preserves the selected detail when its active row becomes ended and is filtered out', () => {
    const h = mount({ records: [at] })
    fireEvent.click(screen.getByRole('button', { name: en['status.active'] }))
    fireEvent.click(screen.getByRole('button', { name: 'Review release' }))
    const detail = screen.getByRole('complementary')
    h.update({ records: [ended] })
    expect(taskNames()).toEqual([])
    expect(screen.getByRole('complementary')).toBe(detail)
    expect(within(detail).getByText(en['status.inactive'])).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: en['statusFilter.all'] }))
    expect(screen.getByRole('button', { name: 'Review release' }).getAttribute('aria-expanded')).toBe('true')
  })

  it('does not invent receipt fields or a next scheduled time for ended tasks without receipts', () => {
    mount({ records: [{ ...at, status: 'inactive' }] })
    fireEvent.click(screen.getByRole('button', { name: 'Review release' }))
    const detail = screen.getByRole('complementary')
    expect(within(detail).getByText(en['status.inactive'])).toBeDefined()
    expect(visibleText(detail, en['detail.nextRun'])).toHaveLength(0)
    expect(screen.getByRole('list').querySelector('time')).toBeNull()
    expect(detail.querySelector('time')).toBeNull()
    fireEvent.click(within(detail).getByRole('tab', { name: detailViewLabels(en).records }))
    const panel = expectDetailView(en, 'records')
    expect(within(panel).queryByRole('region', { name: en['delivery.label'] })).toBeNull()
    expect(panel.querySelector('time')).toBeNull()
  })

  it.each([en, zh])('preserves Delivery records on same-task refresh and replaces the actual latest receipt separately from the next target', async (dictionary) => {
    const labels = detailViewLabels(dictionary)
    const h = mount({ records: [{ ...every, lastDelivery: delivery }] }, dictionary)
    fireEvent.click(screen.getByRole('button', { name: 'Check metrics' }))
    const detail = screen.getByRole('complementary')
    const rules = expectDetailView(dictionary, 'rules')
    expect(nextRunTime(detail)?.dateTime).toBe(every.scheduledAt)
    expect(within(rules).getByRole('region', { name: dictionary['rule.title'] })).toBeDefined()
    fireEvent.click(within(detail).getByRole('tab', { name: labels.records }))
    const firstPanel = expectDetailView(dictionary, 'records')
    await within(firstPanel).findByRole('region', { name: dictionary['delivery.label'] })
    within(firstPanel).getByRole('region', { name: dictionary['delivery.label'] })
    const nextDelivery: NonNullable<ScheduleCatalogEntry['lastDelivery']> = {
      scheduledAt: every.scheduledAt,
      deliveredAt: '2026-10-01T09:30:04.000Z',
      messageId: 'message-metrics-delivery' as typeof delivery.messageId,
    }
    h.update({ status: 'loading' })
    expectDetailView(dictionary, 'records')
    h.update({ status: 'ready', records: [{ ...every, scheduledAt: '2026-10-01T09:35:01.000Z', lastDelivery: nextDelivery }] })
    expect(screen.getByRole('complementary')).toBe(detail)
    const panel = expectDetailView(dictionary, 'records')
    await within(panel).findByText(formatScheduleNextRun(nextDelivery.scheduledAt, dictionary['time.locale']))
    const receipt = within(panel).getByRole('region', { name: dictionary['delivery.label'] })
    expect(within(panel).queryByText(formatScheduleNextRun(delivery.scheduledAt, dictionary['time.locale']))).toBeNull()
    expect(within(panel).getAllByRole('region', { name: dictionary['delivery.label'] })).toHaveLength(1)
    expect(receipt.querySelector<HTMLTimeElement>(`.${css.deliveryTime}`)?.dateTime).toBe(nextDelivery.scheduledAt)
    // The tab strip is the whole header while Delivery records shows; the
    // next-run line returns with Rules.
    expect(visibleText(detail, dictionary['detail.nextRun'])).toHaveLength(0)
    expect(nextRunTime(detail)).toBeNull()
    fireEvent.click(within(detail).getByRole('tab', { name: labels.rules }))
    const refreshedRules = expectDetailView(dictionary, 'rules')
    expect(visibleText(refreshedRules, dictionary['status.active'])).toHaveLength(0)
    expect(within(refreshedRules).getByRole('region', { name: dictionary['rule.title'] })).toBeDefined()
    expect(nextRunTime(detail)?.dateTime).toBe('2026-10-01T09:35:01.000Z')
  })

  it.each([en, zh])('keeps the linked Session entry separate from scrolling details and destructive actions', (dictionary) => {
    const h = mount({ records: [at] }, dictionary)
    fireEvent.click(screen.getByRole('button', { name: 'Review release' }))
    const detail = screen.getByRole('complementary', { name: dictionary['detail.label'] })
    const link = within(detail).getByRole('button', { name: dictionary['detail.openSession'] })
    const context = detailContext(detail)!
    expect(context.contains(link)).toBe(true)
    expect(within(context).getAllByRole('button')).toHaveLength(1)
    expect(within(link).getByText(dictionary['detail.session'])).toBeDefined()
    expect(link.getAttribute('title')).toBe(at.sessionId)
    expect(within(link).getByText(at.sessionId).getAttribute('title')).toBeNull()
    expect(document.getElementById(link.getAttribute('aria-describedby')!)?.textContent).toBe(at.sessionId)
    expect(detail.querySelector(`.${css.detailScroll}`)?.contains(link)).toBe(false)
    // The overflow menu and the close control sit in the top strip, not in the heading row.
    const strip = detail.querySelector(`.${css.detailTabsBar}`)!
    expect(strip.contains(within(detail).getByRole('button', { name: dictionary['detail.more'] }))).toBe(true)
    expect(strip.contains(within(detail).getByRole('button', { name: dictionary['detail.close'] }))).toBe(true)
    expect(detail.querySelector('header')?.contains(strip)).toBe(false)
    const menu = openMore(dictionary)
    expect(within(menu).getByRole('menuitem', { name: dictionary['delete.action'] })).toBeDefined()
    fireEvent.keyDown(menu, { key: 'Escape' })
    fireEvent.click(link)
    expect(h.props.onOpenSession).toHaveBeenCalledExactlyOnceWith(at.sessionId)
    expect(h.props.onDelete).not.toHaveBeenCalled()
  })

  it('names the linked Session only in the detail and opens its id', () => {
    const title = 'Release review'
    const h = mount({ records: [at] }, en, {
      useSessions: select => select(sessionsWithTitles({ [at.sessionId]: title })),
    })
    const row = screen.getByRole('button', { name: 'Review release' })
    const metadata = document.getElementById(row.getAttribute('aria-describedby')!)!
    expect(metadata.textContent).not.toContain(title)
    expect(metadata.textContent).not.toContain(at.sessionId)
    fireEvent.click(row)
    const detail = screen.getByRole('complementary', { name: en['detail.label'] })
    const link = within(detail).getByRole('button', {
      name: en['detail.openSessionTitle'].replace('{title}', title),
    })
    expect(within(link).getByText(title)).toBeDefined()
    expect(within(detail).queryByText(at.sessionId)).toBeNull()
    fireEvent.click(link)
    expect(h.props.onOpenSession).toHaveBeenCalledExactlyOnceWith(at.sessionId)
  })

  it.each([
    ['an absent title', undefined],
    ['a blank title', ''],
  ] satisfies [string, string | undefined][])('keeps the Session id as the label with %s', (_reason, title) => {
    mount({ records: [at] }, en, {
      useSessions: select => select(title === undefined ? sessions : sessionsWithTitles({ [at.sessionId]: title })),
    })
    const row = screen.getByRole('button', { name: 'Review release' })
    expect(document.getElementById(row.getAttribute('aria-describedby')!)?.textContent).not.toContain(at.sessionId)
    fireEvent.click(row)
    const detail = screen.getByRole('complementary', { name: en['detail.label'] })
    const link = within(detail).getByRole('button', { name: en['detail.openSession'] })
    expect(within(link).getByText(at.sessionId)).toBeDefined()
  })

  it('keeps the Session id as the label while the catalog holds no such Session', () => {
    mount({ records: [at] }, en, {
      useSessions: select => select({ ...sessions, ids: [], byId: {} }),
    })
    const row = screen.getByRole('button', { name: 'Review release' })
    expect(document.getElementById(row.getAttribute('aria-describedby')!)?.textContent).not.toContain(at.sessionId)
    fireEvent.click(row)
    const detail = screen.getByRole('complementary', { name: en['detail.label'] })
    const link = within(detail).getByRole('button', { name: en['detail.openSession'] })
    expect(within(link).getByText(at.sessionId)).toBeDefined()
    expect(link.hasAttribute('disabled')).toBe(true)
    expect(detail.textContent).toContain(en['detail.sessionUnavailable'])
  })

  it('keeps loading and query retry in the selected detail without duplicate alerts', () => {
    const h = mount({ records: [at] })
    fireEvent.click(screen.getByRole('button', { name: 'Review release' }))
    const detail = screen.getByRole('complementary', { name: en['detail.label'] })
    h.update({ status: 'loading' })
    // The detail already shows its task, so a catalog refresh renders no
    // spinner over it.
    expect(screen.queryByRole('status')).toBeNull()
    h.update({ status: 'error' })
    expect(within(detail).getByRole('alert').textContent).toBe(en['list.error'])
    expect(screen.getAllByRole('alert')).toHaveLength(1)
    expect(detail.querySelector(`.${css.detailScroll}`)?.contains(screen.getByRole('alert'))).toBe(true)
    const retry = within(detail).getByRole('button', { name: en['list.retry'] })
    expect(screen.getAllByRole('button', { name: en['list.retry'] })).toHaveLength(1)
    fireEvent.click(retry)
    expect(h.props.onRetry).toHaveBeenCalledOnce()
    // Deletion outcomes raise no in-detail alert: the app-wide toast announces them.
    h.update({ status: 'ready' })
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('opens a keyboard-focusable row, shows complete instructions, and navigates to its session', () => {
    const h = mount()
    const row = screen.getByRole('button', { name: 'Review release' })
    expect(row.tabIndex).toBe(0)
    row.focus()
    fireEvent.click(row, { detail: 0 })
    const detail = screen.getByRole('complementary', { name: en['detail.label'] })
    expect(row.getAttribute('aria-expanded')).toBe('true')
    expect(row.getAttribute('aria-controls')).toBe(detail.id)
    // The panel takes focus so the keyboard lands inside it; the name control keeps
    // the text caret out of the reader's way until they choose to edit.
    expect(document.activeElement).toBe(detail)
    expect(nameField()).not.toBe(document.activeElement)
    expect(instructionField().value).toContain(at.prompt)
    expect(within(detail).getByText(at.sessionId)).toBeDefined()
    expect(nextRunTime(detail)?.dateTime).toBe(at.scheduledAt)
    expect(nextRunTime(detail)?.textContent).toBe(absoluteNextRun(at.scheduledAt, en))
    expect(relativeText(detail)).toBe(relativeNextRun(at.scheduledAt, en))
    const menu = openMore()
    expect(within(menu).getAllByRole('menuitem')).toHaveLength(1)
    expect(within(menu).getByRole('menuitem', { name: en['delete.action'] })).toBeDefined()
    fireEvent.keyDown(menu, { key: 'Escape' })
    expect(detail.querySelector('img')).toBeNull()
    fireEvent.keyDown(detail, { key: 'ArrowDown' })
    expect(screen.getByRole('complementary')).toBe(detail)
    fireEvent.click(within(detail).getByRole('button', { name: en['detail.openSession'] }))
    expect(h.props.onOpenSession).toHaveBeenCalledWith(at.sessionId)
  })

  it('closes by button or Escape and restores focus to the selected row', () => {
    mount()
    const row = screen.getByRole('button', { name: 'Check metrics' })
    fireEvent.click(row)
    fireEvent.click(screen.getByRole('button', { name: en['detail.close'] }))
    expect(screen.queryByRole('complementary')).toBeNull()
    expect(document.activeElement).toBe(row)
    fireEvent.click(row)
    fireEvent.keyDown(screen.getByRole('complementary'), { key: 'Escape' })
    expect(screen.queryByRole('complementary')).toBeNull()
    expect(row.getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(row)
  })

  it('keeps the detail open when a dropdown consumed the Escape first', () => {
    mount()
    fireEvent.click(screen.getByRole('button', { name: 'Review release' }))
    const page = screen.getByTestId('task-manager-page')
    // A dropdown closes Escape from the document capture phase and calls
    // preventDefault there, so the page's own handler only ever sees the
    // consumed key — the ordering a real browser reaches and a bare keydown on
    // the open menu does not.
    const consumed = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    consumed.preventDefault()
    fireEvent(page, consumed)
    expect(screen.getByRole('complementary')).toBeDefined()
    // An Escape no dropdown consumed still closes the detail.
    fireEvent.keyDown(page, { key: 'Escape' })
    expect(screen.queryByRole('complementary')).toBeNull()
  })

  it('keeps details independent of search and returns focus to the heading if the row is filtered out', () => {
    mount()
    fireEvent.click(screen.getByRole('button', { name: 'Review release' }))
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'metrics' } })
    expect(instructionField().value).toContain(at.prompt)
    fireEvent.click(screen.getByRole('button', { name: en['detail.close'] }))
    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1 }))
  })

  it('renders Chinese labels and local time without translating stored user data', () => {
    mount({}, zh)
    expect(screen.getByRole('heading', { level: 1, name: '自动化任务' })).toBeDefined()
    expect(screen.getByRole('searchbox', { name: '搜索任务' })).toBeDefined()
    const statuses = screen.getByRole('group', { name: '任务状态' })
    expect(within(statuses).getAllByRole('button')[0]?.textContent).toBe('全部')
    fireEvent.click(screen.getByRole('button', { name: 'Check metrics' }))
    const detail = screen.getByRole('complementary', { name: '任务详情' })
    expect(within(detail).getByText(zh['rule.everySeconds'])).toBeDefined()
    expect(nextRunTime(detail)?.textContent).toBe(absoluteNextRun(every.scheduledAt, zh))
    expect(relativeText(detail)).toBe(relativeNextRun(every.scheduledAt, zh))
    chooseDelete(zh)
    expect(screen.getByRole('dialog', { name: '删除此任务？' })).toBeDefined()
    expect(screen.getByRole('button', { name: '确认删除' })).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: '关闭删除确认' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByRole('button', { name: zh['detail.openSession'] })).toBeDefined()
  })

  it('republishes the next-run line in the language of the injected locale', () => {
    const h = mount({ records: [at] })
    const time = screen.getByRole('list').querySelector('time')
    const row = screen.getByRole('list')
    expect(time?.textContent).toBe(absoluteNextRun(at.scheduledAt, en))
    expect(relativeText(row)).toBe(relativeNextRun(at.scheduledAt, en))
    // English names the year; the Chinese date form reads month and day only.
    expect(absoluteNextRun(at.scheduledAt, en)).toMatch(/\d{4}/)
    expect(absoluteNextRun(at.scheduledAt, zh)).not.toMatch(/\d{4}/)
    h.view.rerender(<TaskManagerPage {...h.props} t={makeTranslate(zh)} />)
    expect(time?.textContent).toBe(absoluteNextRun(at.scheduledAt, zh))
    expect(relativeText(row)).toBe(relativeNextRun(at.scheduledAt, zh))
    expect(screen.getByRole('heading', { level: 1, name: '自动化任务' })).toBeDefined()
  })

  it('states the next run in the device zone even when the rule stores another one', () => {
    const stored: ScheduleCatalogEntry = { ...daily, timeZone: 'America/New_York' }
    mount({ records: [stored] })
    const locale = en['time.locale']
    const ruleZone = new Intl.DateTimeFormat(locale, {
      timeZone: 'America/New_York', month: 'short', day: 'numeric', year: 'numeric',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(Date.parse(stored.scheduledAt))
    const device = absoluteNextRun(stored.scheduledAt, en)
    // The reader compares the target with their own clock, so the stamp names the
    // device-zone instant rather than the wall clock the rule's own zone states.
    expect(device).not.toBe(ruleZone)
    expect(screen.getByRole('list').querySelector('time')?.textContent).toBe(device)
    fireEvent.click(screen.getByRole('button', { name: daily.prompt }))
    const detail = screen.getByRole('complementary', { name: en['detail.label'] })
    expect(nextRunTime(detail)?.textContent).toBe(device)
    // The rule keeps stating its own zone where the zone belongs.
    expect(zoneButton().textContent).toContain(displayedZone('America/New_York'))
  })

  /**
   * Render the sidebar glyph with the sidebar's owner share and nothing else:
   * every runtime hook throws, because the glyph must read no application state.
   * @param size - the edge the sidebar requests for this row.
   * @returns the render result of the clock occupant.
   */
  function renderSidebarGlyph(size: number) {
    const unread = (): never => { throw new Error('The sidebar icon must not read application state') }
    return render(<TaskManagerIcon
      size={size}
      active={false}
      usePanelInfo={unread}
      useSessions={unread}
      useWorkspaces={unread}
      useResource={unread}
      useSessionStatus={unread}
      useSessionRetainInfo={unread}
    />)
  }

  it('renders the requested sidebar glyph edge on the row icon itself', () => {
    // The sidebar centres the row's direct icon child; an inline wrapper makes
    // the clock a line-box baseline and lifts it above the label beside it.
    const glyph = renderSidebarGlyph(18).container.firstElementChild
    expect(glyph?.tagName.toLowerCase()).toBe('svg')
    expect(glyph?.getAttribute('width')).toBe('18')
    expect(glyph?.getAttribute('height')).toBe('18')
  })

  it('renders only a decorative sidebar glyph', () => {
    const view = renderSidebarGlyph(16)
    expect(view.container.querySelector('svg')).not.toBeNull()
    expect(view.container.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true')
    expect(screen.queryByRole('button')).toBeNull()
    expect(view.container.textContent).toBe('')
  })
})

describe('Task detail rule header and run-time card', () => {
  it.each([en, zh])('shows the heading, one compact next-run line, and an overflow menu with only deletion', (dictionary) => {
    mount({ records: [at] }, dictionary)
    fireEvent.click(screen.getByRole('button', { name: 'Review release' }))
    const detail = screen.getByRole('complementary', { name: dictionary['detail.label'] })
    expectDetailOrder(detail, dictionary, 'Review release')
    expect(nextRunTime(detail)?.dateTime).toBe(at.scheduledAt)
    expect(nextRunTime(detail)?.textContent).toBe(absoluteNextRun(at.scheduledAt, dictionary))
    expect(relativeText(detail)).toBe(relativeNextRun(at.scheduledAt, dictionary))
    const card = within(detail).getByRole('region', { name: dictionary['rule.title'] })
    const repeat = within(card).getByRole('button', { name: new RegExp(`^${dictionary['rule.repeat']}`) })
    expect(repeat.textContent).toContain(dictionary['frequency.once'])
    const menu = openMore(dictionary)
    expect(within(menu).getAllByRole('menuitem')).toHaveLength(1)
    expect(within(menu).getByRole('menuitem', { name: dictionary['delete.action'] }).hasAttribute('disabled')).toBe(false)
  })

  it('gives every run-time value control the shared class that owns the row right edge', () => {
    mount({ records: [weekly] })
    fireEvent.click(screen.getByRole('button', { name: 'Weekly review' }))
    const card = screen.getByRole('region', { name: en['rule.title'] })
    const sharedControl = css.ruleControl!
    const valueFace = css.ruleValueFace!
    // jsdom has no layout, so the applied local rule that keeps every value
    // control's own box on the rows container's padding edge is the evidence.
    const controls = [...card.querySelectorAll<HTMLElement>(`.${sharedControl}`)]
    const faces = controls.filter(control => control.classList.contains(valueFace))
    // Repeat and Time zone faces, the Weekday group with its seven pills, the Time input.
    expect(faces).toHaveLength(2)
    expect(controls).toHaveLength(2 + 1 + 7 + 1)
    expect(controls).toContain(weekdayGroup())
    expect(controls).toContain(timeButton())
    for (const day of within(weekdayGroup()).getAllByRole('button')) {
      expect(day.classList.contains(sharedControl)).toBe(true)
    }
    // The triggers stay whole-row click targets, so the face inside each one is
    // the box the ring hugs; the trigger itself never paints a ring.
    for (const trigger of [repeatButton(), zoneButton()]) {
      expect(trigger.classList.contains(css.ruleValue!)).toBe(true)
      expect(trigger.querySelector(`.${valueFace}`)?.classList.contains(sharedControl)).toBe(true)
    }
    const stylesheet = readFileSync(resolve(import.meta.dirname, '../src/client/TaskManagerPage.module.css'), 'utf8')
    expect(stylesheet).toMatch(/\.ruleControl\s*\{[^}]*margin-right:\s*0;/)
    expect(stylesheet).toMatch(new RegExp([
      '\\.ruleRows \\.ruleControl:focus-visible\\s*\\{[^}]*',
      'outline:\\s*2px solid var\\(--dsw-focus-ring-color, var\\(--dsw-alias-state-business-primary\\)\\);',
      '[^}]*outline-offset:\\s*1px;',
    ].join('')))
    expect(stylesheet).toMatch(new RegExp([
      '\\.ruleValue:focus-visible \\.ruleValueFace\\s*\\{[^}]*',
      'outline:\\s*2px solid var\\(--dsw-focus-ring-color, var\\(--dsw-alias-state-business-primary\\)\\);',
      '[^}]*outline-offset:\\s*1px;',
    ].join('')))
    expect(stylesheet).toMatch(/\.ruleRows \.ruleValue:focus-visible\s*\{[^}]*outline:\s*none;/)
    // The removed compensation: no value control offsets its box past the row,
    // and the trigger keeps the row's left edge for the label column.
    const trigger = /\.ruleValue\s*\{([^}]*)\}/.exec(stylesheet)?.[1] ?? ''
    expect(trigger).toMatch(/padding:\s*0;/)
    expect(trigger).not.toMatch(/margin-right/)
    expect(/\.ruleInput\s*\{([^}]*)\}/.exec(stylesheet)?.[1] ?? '').toMatch(/margin-right:\s*0;/)
  })

  it('gives the Interval row input the same shared class as the menu rows', () => {
    mount({ records: [every] })
    fireEvent.click(screen.getByRole('button', { name: 'Check metrics' }))
    const interval = screen.getByLabelText<HTMLInputElement>(en['timing.interval'])
    expect(interval.classList.contains(css.ruleInput!)).toBe(true)
    expect(interval.classList.contains(css.ruleControl!)).toBe(true)
    expect(repeatButton().querySelector(`.${css.ruleValueFace!}`)?.classList.contains(css.ruleControl!)).toBe(true)
  })

  it('closes the overflow menu with Escape and returns focus to its trigger', () => {
    mount({ records: [at] })
    fireEvent.click(screen.getByRole('button', { name: 'Review release' }))
    const more = screen.getByRole('button', { name: en['detail.more'] })
    // While the list is closed the guard leaves every key to the page.
    fireEvent.keyDown(more, { key: 'Tab' })
    expect(screen.getByRole('complementary')).toBeDefined()
    more.focus()
    fireEvent.click(more)
    const menu = screen.getByRole('menu')
    expect(within(menu).getAllByRole('menuitem')).toHaveLength(1)
    fireEvent.keyDown(menu, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(more)
    expect(screen.getByRole('complementary')).toBeDefined()
    // With no menu open, Escape still closes the detail itself.
    fireEvent.keyDown(more, { key: 'Escape' })
    expect(screen.queryByRole('complementary')).toBeNull()
  })

  it('closes the Repeat menu with Escape without closing the detail', () => {
    mount({ records: [at] })
    fireEvent.click(screen.getByRole('button', { name: 'Review release' }))
    const repeat = repeatButton()
    repeat.focus()
    fireEvent.click(repeat)
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(screen.getByRole('complementary')).toBeDefined()
    expect(document.activeElement).toBe(repeat)
  })

  it('submits a one-shot target from separate Date and Time rows', () => {
    const h = mount({ records: [at] })
    fireEvent.click(screen.getByRole('button', { name: 'Review release' }))
    const date = dateButton()
    const time = timeButton()
    // Both rows show the stored value itself — the date in the design's slashed
    // form and one 24-hour clock — and open their own picker instead of a native
    // control. Only the exposed text slashes the date: the calendar compares and
    // the save submits the ISO text the draft holds.
    expect(date.textContent).toBe('2026/10/01')
    expect(date.getAttribute('aria-label')).toBe(en['timing.date'])
    expect(date.getAttribute('aria-haspopup')).toBe('dialog')
    // A one-shot target stores only its instant, so its rows start in this
    // device's zone: 09:00:00Z reads as 17:00:00 here.
    expect(time.textContent).toBe('17:00:00')
    expect(time.getAttribute('aria-haspopup')).toBe('dialog')
    chooseTime('10', '25', '30')
    expect(h.updateTiming).not.toHaveBeenCalled()
    clickSave()
    expect(h.updateTiming).toHaveBeenCalledExactlyOnceWith({
      sessionId: at.sessionId, id: at.id, expected: timingSnapshot(at),
      change: { kind: 'at', at: { date: '2026-10-01', time: '10:25:30', time_zone: DEVICE_ZONE } },
    })
  })

  it('exposes the picked day slashed while the save submits the same ISO text', () => {
    const h = mount({ records: [at] })
    fireEvent.click(screen.getByRole('button', { name: 'Review release' }))
    chooseDay(2, 1)
    // The row states the day the reader picked in the design's slashed form...
    expect(dateButton().textContent).toBe('2026/11/02')
    clickSave()
    // ...while the compare-and-update still carries the ISO text the draft holds.
    expect(h.updateTiming).toHaveBeenCalledExactlyOnceWith({
      sessionId: at.sessionId, id: at.id, expected: timingSnapshot(at),
      change: { kind: 'at', at: { date: '2026-11-02', time: '17:00:00.000', time_zone: DEVICE_ZONE } },
    })
  })

  it('submits a one-shot date edit with the untouched stored time', () => {
    const h = mount({ records: [at] })
    fireEvent.click(screen.getByRole('button', { name: 'Review release' }))
    chooseDay(2, 1)
    expect(h.updateTiming).not.toHaveBeenCalled()
    clickSave()
    expect(h.updateTiming).toHaveBeenCalledExactlyOnceWith({
      sessionId: at.sessionId, id: at.id, expected: timingSnapshot(at),
      change: { kind: 'at', at: { date: '2026-11-02', time: '17:00:00.000', time_zone: DEVICE_ZONE } },
    })
  })

  it('stages a one-shot date edit from the Date row and saves it', () => {
    const h = mount({ records: [at] })
    fireEvent.click(screen.getByRole('button', { name: 'Review release' }))
    chooseDay(24, 2)
    // A pick stages the draft; the staged bar's Save action commits it.
    expect(h.updateTiming).not.toHaveBeenCalled()
    expect(saveNotice()?.textContent).toBe(en['rule.unsaved'])
    clickSave()
    expect(h.updateTiming).toHaveBeenCalledExactlyOnceWith({
      sessionId: at.sessionId, id: at.id, expected: timingSnapshot(at),
      change: { kind: 'at', at: { date: '2026-12-24', time: '17:00:00.000', time_zone: DEVICE_ZONE } },
    })
  })

  it('keeps an untouched one-shot millisecond value out of a Time zone submit', () => {
    const stored: ScheduleCatalogEntry = { ...at, scheduledAt: '2026-10-01T09:00:15.500Z' }
    const h = mount({ records: [stored] })
    fireEvent.click(screen.getByRole('button', { name: 'Review release' }))
    expect(timeButton().textContent).toBe('17:00:15')
    chooseZone('Europe/Berlin')
    expect(h.updateTiming).not.toHaveBeenCalled()
    clickSave()
    expect(h.updateTiming).toHaveBeenCalledExactlyOnceWith({
      sessionId: stored.sessionId, id: stored.id, expected: timingSnapshot(stored),
      change: { kind: 'at', at: { date: '2026-10-01', time: '17:00:15.500', time_zone: 'Europe/Berlin' } },
    })
  })

  it('submits an interval from its Interval row and keeps other keys inert', () => {
    const h = mount({ records: [every] })
    fireEvent.click(screen.getByRole('button', { name: 'Check metrics' }))
    const interval = screen.getByLabelText<HTMLInputElement>(en['timing.interval'])
    expect(interval.value).toBe('301')
    fireEvent.change(interval, { target: { value: '600' } })
    fireEvent.keyDown(interval, { key: 'Tab' })
    expect(h.updateTiming).not.toHaveBeenCalled()
    fireEvent.keyDown(interval, { key: 'Enter' })
    expect(h.updateTiming).not.toHaveBeenCalled()
    clickSave()
    expect(h.updateTiming).toHaveBeenCalledExactlyOnceWith({
      sessionId: every.sessionId, id: every.id, expected: timingSnapshot(every),
      change: { kind: 'every', every_seconds: 600 },
    })
  })

  it('offers minute and hour intervals as separate repeat choices', () => {
    const twoHours: ScheduleCatalogEntry = { ...every, everySeconds: 7_200 }
    const h = mount({ records: [twoHours] })
    fireEvent.click(screen.getByRole('button', { name: 'Check metrics' }))
    const interval = screen.getByLabelText<HTMLInputElement>(en['timing.interval'])
    expect(interval.value).toBe('2')
    expect(repeatButton().textContent).toContain(en['rule.everyHours'])
    chooseRepeat(en['rule.everyMinutes'])
    expect(interval.value).toBe('120')
    fireEvent.change(interval, { target: { value: '90' } })
    clickSave()

    expect(h.updateTiming).toHaveBeenCalledExactlyOnceWith({
      sessionId: every.sessionId, id: every.id, expected: timingSnapshot(twoHours),
      change: { kind: 'every', every_seconds: 5_400 },
    })
  })

  it('shows a sub-hour interval in minutes and submits it in seconds', () => {
    const tenMinutes: ScheduleCatalogEntry = { ...every, everySeconds: 600 }
    const h = mount({ records: [tenMinutes] })
    fireEvent.click(screen.getByRole('button', { name: 'Check metrics' }))
    const interval = screen.getByLabelText<HTMLInputElement>(en['timing.interval'])
    // A whole number of minutes below the hour reads in minutes, at minutes' own minimum.
    expect(repeatButton().textContent).toContain(en['rule.everyMinutes'])
    expect(interval.value).toBe('10')
    expect(interval.getAttribute('min')).toBe('1')
    fireEvent.change(interval, { target: { value: '20' } })
    clickSave()
    expect(h.updateTiming).toHaveBeenCalledExactlyOnceWith({
      sessionId: every.sessionId, id: every.id, expected: timingSnapshot(tenMinutes),
      change: { kind: 'every', every_seconds: 1_200 },
    })
  })

  it('offers hour and second intervals as their own choices and keeps their unit', () => {
    const h = mount({ records: [daily] })
    fireEvent.click(screen.getByRole('button', { name: 'Daily weather' }))
    // Every N hours: the seeded 3600 seconds read as one hour.
    chooseRepeat(en['rule.everyHours'])
    const interval = screen.getByLabelText<HTMLInputElement>(en['timing.interval'])
    expect(repeatButton().textContent).toContain(en['rule.everyHours'])
    expect(interval.value).toBe('1')
    fireEvent.change(interval, { target: { value: '2' } })
    clickSave()
    expect(h.updateTiming).toHaveBeenCalledExactlyOnceWith({
      sessionId: daily.sessionId, id: daily.id, expected: timingSnapshot(daily),
      change: { kind: 'every', every_seconds: 7_200 },
    })

    cleanup()
    // A rule already repeating in seconds keeps that unit when its own choice is
    // selected again, so the field seeds the stored interval as seconds.
    const seconds = mount({ records: [every] })
    fireEvent.click(screen.getByRole('button', { name: 'Check metrics' }))
    expect(repeatButton().textContent).toContain(en['rule.everySeconds'])
    chooseRepeat(en['rule.everySeconds'])
    const field = screen.getByLabelText<HTMLInputElement>(en['timing.interval'])
    expect(repeatButton().textContent).toContain(en['rule.everySeconds'])
    expect(field.value).toBe('301')
    expect(field.getAttribute('min')).toBe('60')
    fireEvent.change(field, { target: { value: '600' } })
    clickSave()
    expect(seconds.updateTiming).toHaveBeenCalledExactlyOnceWith({
      sessionId: every.sessionId, id: every.id, expected: timingSnapshot(every),
      change: { kind: 'every', every_seconds: 600 },
    })
    expect(h.updateTiming).toHaveBeenCalledOnce()
  })

  it.each([
    ['1.1', 3_960], ['1.5', 5_400], ['3', 10_800],
  ] as const)('submits whole seconds from a %s-hour entry', (entered, seconds) => {
    const h = mount({ records: [daily] })
    fireEvent.click(screen.getByRole('button', { name: 'Daily weather' }))
    chooseRepeat(en['rule.everyHours'])
    const interval = screen.getByLabelText<HTMLInputElement>(en['timing.interval'])
    // The row states its own unit's floor, and accepts any fraction of it: a
    // whole-unit step would mark a legal interval such as 1.5 hours as a step
    // mismatch, so the field lets the staged value through.
    expect(interval.getAttribute('min')).toBe('1')
    expect(interval.getAttribute('step')).toBe('any')
    // A fractional hour still reaches the Host as whole seconds rather than a
    // float artifact like 3960.0000000000005.
    fireEvent.change(interval, { target: { value: entered } })
    clickSave()
    expect(h.updateTiming).toHaveBeenCalledExactlyOnceWith({
      sessionId: daily.sessionId, id: daily.id, expected: timingSnapshot(daily),
      change: { kind: 'every', every_seconds: seconds },
    })
  })

  it('accepts a fractional hour as whole seconds without a step mismatch', () => {
    const h = mount({ records: [daily] })
    fireEvent.click(screen.getByRole('button', { name: 'Daily weather' }))
    chooseRepeat(en['rule.everyHours'])
    const interval = screen.getByLabelText<HTMLInputElement>(en['timing.interval'])
    fireEvent.change(interval, { target: { value: '1.5' } })
    // The field constrains no step, and the value is not invalid at the field
    // level: 1.5 hours is exactly 5400 whole seconds.
    expect(interval.getAttribute('step')).toBe('any')
    expect(interval.validity.stepMismatch).toBe(false)
    expect(interval.validity.valid).toBe(true)
    clickSave()
    expect(h.updateTiming).toHaveBeenCalledExactlyOnceWith({
      sessionId: daily.sessionId, id: daily.id, expected: timingSnapshot(daily),
      change: { kind: 'every', every_seconds: 5_400 },
    })
  })

  it.each(['59', 'abc'])('rejects an interval below the supported minimum: %s', (value) => {
    const h = mount({ records: [every] })
    fireEvent.click(screen.getByRole('button', { name: 'Check metrics' }))
    const interval = screen.getByLabelText<HTMLInputElement>(en['timing.interval'])
    fireEvent.change(interval, { target: { value } })
    fireEvent.focusOut(interval)
    expect(h.updateTiming).not.toHaveBeenCalled()
    expect(screen.queryByRole('alert')).toBeNull()
    clickSave()
    expect(h.updateTiming).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toBe(en['timing.invalidInterval.second'])
  })

  it('states the below-floor message in the unit the row shows', () => {
    const h = mount({ records: [every] })
    fireEvent.click(screen.getByRole('button', { name: 'Check metrics' }))
    chooseRepeat(en['rule.everyHours'])
    const interval = screen.getByLabelText<HTMLInputElement>(en['timing.interval'])
    // 0.01 hours is 36 whole seconds, under the 60-second floor, and the
    // message speaks the row's own unit as the hint above the rows does.
    fireEvent.change(interval, { target: { value: '0.01' } })
    clickSave()
    expect(h.updateTiming).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toBe(en['timing.invalidInterval.hour'])
  })

  it.each([
    ['a one-shot date', at, 'Review release', 'no-date', 'timing.date', ''],
    ['a time', daily, 'Daily weather', 'not a clock', 'timing.time', 'not a clock'],
  ] as const)(
    'rejects a stored unparsable %s locally without an update',
    (_case, task, row, broken, field, shown) => {
      // The pickers only ever stage a complete clock and a real ISO date, so the
      // locally invalid state the guard exists for is a record the Host stored
      // with an unreadable value: another edit makes the draft dirty, and Save
      // must refuse it instead of submitting the broken field.
      const stored: ScheduleCatalogEntry = field === 'timing.date'
        ? { ...task, scheduledAt: broken }
        : { ...task, time: broken }
      const h = mount({ records: [stored] })
      fireEvent.click(screen.getByRole('button', { name: row }))
      // An instant the runtime cannot place drafts empty rows; a stored clock the
      // rule itself states stays on screen.
      expect(screen.getByLabelText(en[field]).textContent).toBe(shown)
      // The picker opens on such a value instead of failing to render it.
      fireEvent.click(screen.getByLabelText(en[field]))
      if (field === 'timing.date') expect(screen.getByRole('grid')).toBeDefined()
      else expect(screen.getByRole('listbox', { name: en['timing.hour'] })).toBeDefined()
      fireEvent.keyDown(screen.getByRole('dialog', { name: en[field] }), { key: 'Escape' })
      fireEvent.change(nameField(), { target: { value: 'Renamed while broken' } })
      expect(h.updateTiming).not.toHaveBeenCalled()
      clickSave()
      expect(h.updateTiming).not.toHaveBeenCalled()
      expect(screen.getByRole('alert').textContent).toBe(en['timing.invalid'])
    },
  )

  it.each([
    ['daily', daily, 'Daily weather', { kind: 'daily', daily: { time: '23:00:00.000', time_zone: 'Europe/Berlin' } }],
    ['weekly', weekly, 'Weekly review', {
      kind: 'weekly', weekly: { time: '09:30:00.000', time_zone: 'Europe/Berlin', weekdays: [1, 3] },
    }],
  ] as const)('commits a %s Time zone edit and shows the refreshed zone', async (_kind, task, row, change) => {
    const h = mount({ records: [task] })
    const saved: ScheduleCatalogEntry = { ...task, timeZone: 'Europe/Berlin' }
    h.updateTiming.mockResolvedValue({ ok: true, value: { id: task.id, updated: true, record: saved } })
    fireEvent.click(screen.getByRole('button', { name: row }))
    expect(zoneButton().textContent).toContain(displayedZone('Asia/Shanghai'))
    chooseZone('Europe/Berlin')
    expect(h.updateTiming).not.toHaveBeenCalled()
    clickSave()
    expect(h.updateTiming).toHaveBeenCalledExactlyOnceWith({
      sessionId: task.sessionId, id: task.id, expected: timingSnapshot(task), change,
    })
    // The authoritative refresh reports the record the Host saved.
    h.update({ records: [saved] })
    await act(async () => { await h.updateTiming.mock.results[0]!.value })
    expect(zoneButton().textContent).toContain(displayedZone('Europe/Berlin'))
  })

  it.each([
    ['at', at, 'Review release', {
      kind: 'at', at: { date: '2026-10-01', time: '17:00:00.000', time_zone: 'Europe/Berlin' },
    }],
    ['after', after, 'Send summary', {
      kind: 'at', at: { date: '2026-10-01', time: '16:00:00.000', time_zone: 'Europe/Berlin' },
    }],
  ] as const)('commits a %s Time zone edit as an interpreted absolute target', async (_kind, task, row, change) => {
    const h = mount({ records: [task] })
    const savedAt: ScheduleCatalogEntry = {
      id: task.id, sessionId: task.sessionId, kind: 'at', status: 'active', title: task.title, prompt: task.prompt,
      scheduledAt: '2026-10-01T09:00:00.000Z',
    }
    h.updateTiming.mockResolvedValue({ ok: true, value: { id: task.id, updated: true, record: savedAt } })
    fireEvent.click(screen.getByRole('button', { name: row }))
    // The rows start in the device zone, and the chosen zone only interprets the
    // wall clock: the stored record keeps the instant those fields name.
    expect(zoneButton().textContent).toContain(displayedZone(DEVICE_ZONE))
    chooseZone('Europe/Berlin')
    expect(h.updateTiming).not.toHaveBeenCalled()
    clickSave()
    expect(h.updateTiming).toHaveBeenCalledExactlyOnceWith({
      sessionId: task.sessionId, id: task.id, expected: timingSnapshot(task), change,
    })
    h.update({ records: [savedAt] })
    await act(async () => { await h.updateTiming.mock.results[0]!.value })
    expect(zoneButton().textContent).toContain(displayedZone(DEVICE_ZONE))
  })

  it.each([en, zh])('offers IANA zones by offset with the system zone first and marked', (dictionary) => {
    mount({ records: [daily] }, dictionary)
    fireEvent.click(screen.getByRole('button', { name: 'Daily weather' }))
    const selector = zoneButton(dictionary)
    expect(selector.getAttribute('aria-haspopup')).toBe('menu')
    expect(selector.getAttribute('aria-expanded')).toBe('false')
    // The stored zone is the resolved system zone: it leads the menu and carries the suffix.
    const systemLabel = `${displayedZone('Asia/Shanghai', dictionary)}${dictionary['rule.zone.system']}`
    expect(selector.textContent).toContain(systemLabel)
    fireEvent.click(selector)
    const menu = screen.getByRole('menu')
    const names = within(menu).getAllByRole('menuitem').map(item => item.textContent)
    expect(names[0]).toBe(systemLabel)
    for (const zone of FALLBACK_ZONES) {
      expect(names.some(name => name?.includes(displayedZone(zone, dictionary)))).toBe(true)
    }
    // The runtime's own inventory extends the menu far past the minimal fallback.
    expect(names).toContain(displayedZone('Africa/Lagos', dictionary))
    expect(names).toContain(displayedZone('Pacific/Auckland', dictionary))
    expect(names.length).toBeGreaterThan(9)
    expect(within(menu).getAllByRole('menuitem')[0]?.querySelector('svg')).not.toBeNull()
    expect(within(menu).getAllByRole('menuitem')
      .find(item => item.textContent === displayedZone('Asia/Tokyo', dictionary))?.querySelector('svg')).toBeNull()
  })

  it('starts with an unlabeled system-zone and UTC recent block, then promotes a selection', () => {
    mount({ records: [daily] })
    fireEvent.click(screen.getByRole('button', { name: 'Daily weather' }))
    fireEvent.click(zoneButton())
    let menu = screen.getByRole('menu')
    let entries = [...menu.querySelectorAll('[role="menuitem"], [role="separator"]')]
    expect(entries.slice(0, 3).map(entry => entry.textContent)).toEqual([
      `${displayedZone('Asia/Shanghai')}${en['rule.zone.system']}`,
      displayedZone('UTC'),
      '',
    ])
    expect(entries[2]?.getAttribute('role')).toBe('separator')

    fireEvent.change(screen.getByRole('searchbox', { name: en['timing.zoneSearch'] }), {
      target: { value: 'Europe/Berlin' },
    })
    fireEvent.click(screen.getByRole('menuitem'))
    fireEvent.click(zoneButton())
    menu = screen.getByRole('menu')
    entries = [...menu.querySelectorAll('[role="menuitem"], [role="separator"]')]
    expect(entries[0]?.textContent).toBe(displayedZone('Europe/Berlin'))
    expect(entries[1]?.textContent).toBe(`${displayedZone('Asia/Shanghai')}${en['rule.zone.system']}`)
    expect(entries[2]?.textContent).toBe(displayedZone('UTC'))
    expect(entries[3]?.getAttribute('role')).toBe('separator')
  })

  it('shows only the recent block when its zones are the whole inventory', () => {
    // A runtime that enumerates only the seeded zones leaves the recent block
    // covering the list: it renders alone, without a separator for the rest.
    vi.spyOn(Intl, 'supportedValuesOf').mockReturnValue(['Asia/Shanghai', 'UTC'])
    mount({ records: [daily] })
    fireEvent.click(screen.getByRole('button', { name: 'Daily weather' }))
    fireEvent.click(zoneButton())
    const menu = screen.getByRole('menu')
    expect([...menu.querySelectorAll('[role="menuitem"]')].map(item => item.textContent)).toEqual([
      `${displayedZone('Asia/Shanghai')}${en['rule.zone.system']}`,
      displayedZone('UTC'),
    ])
    expect(menu.querySelectorAll('[role="separator"]')).toHaveLength(0)
  })

  it('clears a typed zone query when the open menu is closed again', () => {
    mount({ records: [daily] })
    fireEvent.click(screen.getByRole('button', { name: 'Daily weather' }))
    fireEvent.click(zoneButton())
    fireEvent.change(screen.getByRole('searchbox', { name: en['timing.zoneSearch'] }), {
      target: { value: 'Asia/Tokyo' },
    })
    expect(screen.getAllByRole('menuitem')).toHaveLength(1)
    // The trigger closes the open menu; its query must not survive into the next opening.
    fireEvent.click(zoneButton())
    expect(screen.queryByRole('menu')).toBeNull()
    fireEvent.click(zoneButton())
    expect(screen.getByRole<HTMLInputElement>('searchbox', { name: en['timing.zoneSearch'] }).value).toBe('')
    expect(screen.getAllByRole('menuitem').length).toBeGreaterThan(1)
  })

  it.each([en, zh])('filters zones by hidden IANA id, localized ICU name, and UTC offset', (dictionary) => {
    mount({ records: [daily] }, dictionary)
    fireEvent.click(screen.getByRole('button', { name: 'Daily weather' }))
    fireEvent.click(zoneButton(dictionary))
    const search = screen.getByRole('searchbox', { name: dictionary['timing.zoneSearch'] })

    fireEvent.change(search, { target: { value: 'Asia/Tokyo' } })
    expect(screen.getAllByRole('menuitem')).toHaveLength(1)
    expect(screen.getByRole('menuitem').textContent).toBe(displayedZone('Asia/Tokyo', dictionary))

    const localized = displayedZone('Asia/Tokyo', dictionary).split(' · ')[1] ?? ''
    fireEvent.change(search, { target: { value: localized } })
    expect(screen.getAllByRole('menuitem').some(item => item.textContent === displayedZone('Asia/Tokyo', dictionary))).toBe(true)

    fireEvent.change(search, { target: { value: 'UTC+05:30' } })
    expect(screen.getAllByRole('menuitem').every(item => item.textContent?.startsWith('UTC+05:30'))).toBe(true)
  })

  it('collapses identical ICU labels while retaining every hidden IANA search alias', () => {
    vi.spyOn(Intl, 'supportedValuesOf').mockReturnValue([
      'America/Anchorage', 'America/Juneau', 'Asia/Shanghai',
    ])
    const stored: ScheduleCatalogEntry = { ...daily, timeZone: 'America/Juneau' }
    mount({ records: [stored] }, zh)
    fireEvent.click(screen.getByRole('button', { name: 'Daily weather' }))
    fireEvent.click(zoneButton(zh))
    const alaska = displayedZone('America/Anchorage', zh)
    expect(displayedZone('America/Juneau', zh)).toBe(alaska)
    expect(screen.getAllByRole('menuitem').filter(item => item.textContent === alaska)).toHaveLength(1)

    fireEvent.change(screen.getByRole('searchbox', { name: zh['timing.zoneSearch'] }), {
      target: { value: 'America/Juneau' },
    })
    const result = screen.getByRole('menuitem')
    expect(result.textContent).toBe(alaska)
    // The grouped row retains the exact stored id, so merely opening or
    // selecting it does not canonicalize an existing schedule behind the user.
    expect(result.querySelector('svg')).not.toBeNull()
  })

  it('leads the menu with a system zone that is not first by offset', () => {
    pinSystemZone('Europe/Berlin')
    mount({ records: [daily] })
    fireEvent.click(screen.getByRole('button', { name: 'Daily weather' }))
    fireEvent.click(zoneButton())
    expect(within(screen.getByRole('menu')).getAllByRole('menuitem')[0]?.textContent)
      .toBe(`${displayedZone('Europe/Berlin')}${en['rule.zone.system']}`)
  })

  it('marks only the resolved system zone with the localized suffix', () => {
    pinSystemZone('Asia/Tokyo')
    mount({ records: [weekly] }, zh)
    fireEvent.click(screen.getByRole('button', { name: 'Weekly review' }))
    // The stored zone is Shanghai, not the system zone, so the trigger stays unmarked.
    expect(zoneButton(zh).textContent).toContain(displayedZone('Asia/Shanghai', zh))
    expect(zoneButton(zh).textContent).not.toContain(zh['rule.zone.system'])
    fireEvent.click(zoneButton(zh))
    const items = within(screen.getByRole('menu')).getAllByRole('menuitem')
    expect(items[0]?.textContent)
      .toBe(`${displayedZone('Asia/Tokyo', zh)}${zh['rule.zone.system']}`)
    // No later inventory entry picks the suffix up.
    expect(items.filter(item => item.textContent?.includes(zh['rule.zone.system']))).toHaveLength(1)
  })

  it('leads the menu with any system zone', () => {
    pinSystemZone('Europe/Paris')
    mount({ records: [daily] })
    fireEvent.click(screen.getByRole('button', { name: 'Daily weather' }))
    fireEvent.click(zoneButton())
    const items = within(screen.getByRole('menu')).getAllByRole('menuitem')
    expect(items[0]?.textContent).toBe(`${displayedZone('Europe/Paris')}${en['rule.zone.system']}`)
    expect(items.filter(item => item.textContent?.includes(en['rule.zone.system']))).toHaveLength(1)
  })

  it.each([en, zh])('localizes a stored zone outside the minimal fallback', (dictionary) => {
    const stored: ScheduleCatalogEntry = { ...daily, timeZone: 'Europe/Paris' }
    mount({ records: [stored] }, dictionary)
    fireEvent.click(screen.getByRole('button', { name: 'Daily weather' }))
    const selector = zoneButton(dictionary)
    expect(selector.textContent).toContain(displayedZone('Europe/Paris', dictionary))
    expect(selector.textContent).not.toContain(dictionary['rule.zone.system'])
    fireEvent.click(selector)
    const menu = screen.getByRole('menu')
    const items = within(menu).getAllByRole('menuitem')
    const paris = items.filter(item => item.textContent === displayedZone('Europe/Paris', dictionary))
    expect(paris.length).toBeGreaterThan(0)
    expect(items[0]?.textContent)
      .toBe(`${displayedZone('Asia/Shanghai', dictionary)}${dictionary['rule.zone.system']}`)
    expect(paris.filter(item => item.querySelector('svg') !== null)).toHaveLength(1)
  })

  it('keeps a stored zone the runtime inventory omits in the menu', () => {
    vi.spyOn(Intl, 'supportedValuesOf').mockReturnValue(['Asia/Shanghai', 'Europe/Berlin'])
    const stored: ScheduleCatalogEntry = { ...daily, timeZone: 'US/Pacific' }
    mount({ records: [stored] })
    fireEvent.click(screen.getByRole('button', { name: 'Daily weather' }))
    expect(zoneButton().textContent).toContain(displayedZone('US/Pacific'))
    fireEvent.click(zoneButton())
    const menu = screen.getByRole('menu')
    const storedItem = within(menu).getAllByRole('menuitem')
      .filter(item => item.textContent === displayedZone('US/Pacific'))
    expect(storedItem.length).toBeGreaterThan(0)
    expect(storedItem.filter(item => item.querySelector('svg') !== null)).toHaveLength(1)
  })

  it('commits a Time zone edit found through the runtime inventory', () => {
    const h = mount({ records: [daily] })
    fireEvent.click(screen.getByRole('button', { name: 'Daily weather' }))
    chooseZone('Africa/Lagos')
    clickSave()
    expect(h.updateTiming).toHaveBeenCalledExactlyOnceWith({
      sessionId: daily.sessionId, id: daily.id, expected: timingSnapshot(daily),
      change: { kind: 'daily', daily: { time: '23:00:00.000', time_zone: 'Africa/Lagos' } },
    })
  })

  it('keeps the long zone list bounded and keyboard-reachable', () => {
    mount({ records: [daily] })
    fireEvent.click(screen.getByRole('button', { name: 'Daily weather' }))
    const zone = zoneButton()
    zone.focus()
    fireEvent.click(zone)
    const menu = screen.getByRole('menu')
    // The card caps and scrolls a menu with no submenu rows.
    expect(menu.className).toContain(taskMenuCss.scrollable)
    const items = within(menu).getAllByRole('menuitem')
    expect(items.length).toBeGreaterThan(100)
    fireEvent.keyDown(menu, { key: 'End' })
    expect(document.activeElement).toBe(items.at(-1))
    fireEvent.keyDown(menu, { key: 'Home' })
    expect(document.activeElement).toBe(items[0])
  })

  it('marks a stored zone when it is the system zone', () => {
    pinSystemZone('Europe/Paris')
    const stored: ScheduleCatalogEntry = { ...daily, timeZone: 'Europe/Paris' }
    mount({ records: [stored] })
    fireEvent.click(screen.getByRole('button', { name: 'Daily weather' }))
    expect(zoneButton().textContent).toContain(`${displayedZone('Europe/Paris')}${en['rule.zone.system']}`)
  })

  it.each([en, zh])('keeps the shown zone when the Time zone menu selects it again', (dictionary) => {
    const h = mount({ records: [daily] }, dictionary)
    fireEvent.click(screen.getByRole('button', { name: 'Daily weather' }))
    chooseZone('Asia/Shanghai', dictionary)
    expect(h.updateTiming).not.toHaveBeenCalled()
    expect(screen.queryByRole('menu')).toBeNull()
    expect(zoneButton(dictionary).textContent).toContain(displayedZone('Asia/Shanghai', dictionary))
  })

  it.each([en, zh])('shows the staged-edit bar only while the draft differs and clears it on Cancel', (dictionary) => {
    const h = mount({ records: [daily] }, dictionary)
    fireEvent.click(screen.getByRole('button', { name: 'Daily weather' }))
    // A clean draft has no save controls at all.
    expect(saveFooter()).toBeNull()
    chooseZone('Europe/Berlin', dictionary)
    const footer = saveFooter()!
    expect(footer.querySelector(`.${css.saveNotice}`)?.textContent).toBe(dictionary['rule.unsaved'])
    expect(within(footer).getAllByRole('button').map(button => button.textContent))
      .toEqual([dictionary['rule.cancel'], dictionary['rule.save']])
    // Cancel restores the stored values without reaching the Host.
    clickCancel(dictionary)
    expect(h.updateTiming).not.toHaveBeenCalled()
    expect(saveFooter()).toBeNull()
    expect(zoneButton(dictionary).textContent).toContain(displayedZone('Asia/Shanghai', dictionary))
    // A draft that returns to the stored value clears the notice again.
    chooseZone('Europe/Berlin', dictionary)
    expect(saveNotice()?.textContent).toBe(dictionary['rule.unsaved'])
    chooseZone('Asia/Shanghai', dictionary)
    expect(saveFooter()).toBeNull()
    expect(h.updateTiming).not.toHaveBeenCalled()
  })

  it('closes the Time zone menu with Escape without closing the detail', () => {
    mount({ records: [daily] })
    fireEvent.click(screen.getByRole('button', { name: 'Daily weather' }))
    const zone = zoneButton()
    zone.focus()
    fireEvent.click(zone)
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(screen.getByRole('complementary')).toBeDefined()
    expect(document.activeElement).toBe(zone)
  })

  it('names the zone in the active locale and finds it by IANA id', () => {
    mount({ records: [daily] })
    fireEvent.click(screen.getByRole('button', { name: 'Daily weather' }))
    // The row states the zone through its ICU name, and its picker searches by
    // that name or by the raw IANA id.
    expect(zoneButton().textContent).toContain(displayedZone('Asia/Shanghai'))
    fireEvent.click(zoneButton())
    const search = screen.getByRole('searchbox', { name: en['timing.zoneSearch'] })
    fireEvent.change(search, { target: { value: 'Europe/Berlin' } })
    expect(screen.getAllByRole('menuitem')).toHaveLength(1)
    expect(screen.getByRole('menuitem').textContent).toBe(displayedZone('Europe/Berlin'))
  })

  it('states the one-shot target that saved no zone, and stays quiet when the rule stores one', () => {
    mount({ records: [at] })
    fireEvent.click(screen.getByRole('button', { name: 'Review release' }))
    // A one-shot target stores only its instant, so one line says which zone
    // interprets the date and time its rows now show.
    expect(screen.getByText(en['timing.zoneNoStored'])).toBeDefined()

    cleanup()
    // A rule that stores its own zone needs no such line: its frequency names it.
    mount({ records: [daily] })
    fireEvent.click(screen.getByRole('button', { name: 'Daily weather' }))
    expect(screen.queryByText(en['timing.zoneNoStored'])).toBeNull()
    chooseRepeat(en['rule.once'])
    expect(screen.queryByText(en['timing.zoneNoStored'])).toBeNull()
  })

  it('keeps an untouched stored millisecond value out of the submitted change', () => {
    const stored: ScheduleCatalogEntry = { ...daily, time: '23:00:15.500' }
    const h = mount({ records: [stored] })
    fireEvent.click(screen.getByRole('button', { name: 'Daily weather' }))
    const time = timeButton()
    expect(time.textContent).toBe('23:00:15')
    chooseZone('Europe/Berlin')
    expect(h.updateTiming).not.toHaveBeenCalled()
    clickSave()
    expect(h.updateTiming).toHaveBeenCalledExactlyOnceWith({
      sessionId: stored.sessionId, id: stored.id, expected: timingSnapshot(stored),
      change: { kind: 'daily', daily: { time: '23:00:15.500', time_zone: 'Europe/Berlin' } },
    })
  })

  it.each([
    ['a daily rule', daily, 'Daily weather', '23:00:00'],
    ['a weekly rule', weekly, 'Weekly review', '09:30:00'],
  ] as const)('shows %s time as one 24-hour clock without milliseconds', (_case, task, row, shown) => {
    mount({ records: [task] })
    fireEvent.click(screen.getByRole('button', { name: row }))
    expect(timeButton().textContent).toBe(shown)
    expect(timeButton().textContent).not.toContain('.')
    // Both locales read the same 24-hour clock: no AM/PM marker anywhere.
    expect(timeButton().textContent).not.toMatch(/[AP]M/)
  })

  it('shows a one-shot date and time as separate whole-second rows', () => {
    mount({ records: [at] })
    fireEvent.click(screen.getByRole('button', { name: 'Review release' }))
    // The Date row shows the stored date in the design's slashed form; the Time
    // row shows a whole-second clock. Both are read-only triggers that open their
    // own picker.
    expect(dateButton().textContent).toBe('2026/10/01')
    expect(timeButton().textContent).toBe('17:00:00')
    expect(timeButton().textContent).not.toContain('.')
    expect(screen.queryByRole('textbox', { name: en['timing.date'] })).toBeNull()
    expect(screen.queryByRole('textbox', { name: en['timing.time'] })).toBeNull()
  })

  it('submits a second-precision time edit without milliseconds', () => {
    const stored: ScheduleCatalogEntry = { ...daily, time: '23:00:15.500' }
    const h = mount({ records: [stored] })
    fireEvent.click(screen.getByRole('button', { name: 'Daily weather' }))
    chooseTime('10', '23', '45')
    expect(h.updateTiming).not.toHaveBeenCalled()
    clickSave()
    expect(h.updateTiming).toHaveBeenCalledExactlyOnceWith({
      sessionId: stored.sessionId, id: stored.id, expected: timingSnapshot(stored),
      change: { kind: 'daily', daily: { time: '10:23:45', time_zone: 'Asia/Shanghai' } },
    })
  })

  it.each([
    ['daily', daily, 'Daily weather', '2026-10-02T15:00:00.000Z', {
      kind: 'daily', daily: { time: '10:23:45', time_zone: 'Asia/Shanghai' },
    }],
    ['weekly', weekly, 'Weekly review', '2026-10-12T01:30:00.000Z', {
      kind: 'weekly', weekly: { time: '10:23:45', time_zone: 'Asia/Shanghai', weekdays: [1, 3] },
    }],
  ] as const)(
    'keeps and commits an unsaved %s Time edit when an authoritative refresh changes the stored record',
    async (_kind, task, row, rescheduled, change) => {
      const h = mount({ records: [task] })
      const refreshed: ScheduleCatalogEntry = { ...task, scheduledAt: rescheduled }
      const saved: ScheduleCatalogEntry = { ...refreshed, time: '10:23:45.000' }
      h.updateTiming.mockResolvedValue({ ok: true, value: { id: task.id, updated: true, record: saved } })
      fireEvent.click(screen.getByRole('button', { name: row }))
      const time = timeButton()
      expect(time.textContent).toBe(task.time.slice(0, 8))
      chooseTime('10', '23', '45')
      // The Host re-anchors the stored record (its next occurrence advanced) while
      // the time edit is still unsaved.
      h.update({ records: [refreshed] })
      expect(timeButton().textContent).toBe('10:23:45')
      expect(h.updateTiming).not.toHaveBeenCalled()
      clickSave()
      expect(h.updateTiming).toHaveBeenCalledExactlyOnceWith({
        sessionId: task.sessionId, id: task.id, expected: timingSnapshot(refreshed), change,
      })
      h.update({ records: [saved] })
      await act(async () => { await h.updateTiming.mock.results[0]!.value })
      expect(timeButton().textContent).toBe('10:23:45')
    },
  )

  it('shows the stored rule when a task with an unsaved draft ends', () => {
    const h = mount({ records: [at] })
    fireEvent.click(screen.getByRole('button', { name: 'Review release' }))
    fireEvent.change(nameField(), { target: { value: 'Edited name' } })
    fireEvent.change(instructionField(), { target: { value: 'Edited instruction' } })
    expect(saveNotice()?.textContent).toBe(en['rule.unsaved'])
    // The catalog reports the task ended while the draft was unsaved. The panel
    // is read-only plain text from here on, so the uncommitted values must not
    // keep reading as the stored rule.
    h.update({ records: [{ ...at, status: 'inactive' }] })
    const detail = screen.getByRole('complementary', { name: en['detail.label'] })
    expect(within(detail).getByRole('heading', { name: at.title })).toBeDefined()
    expect(detail.querySelector(`.${css.readonlyPrompt}`)?.textContent).toBe(at.prompt)
    expect(within(detail).queryByRole('textbox')).toBeNull()
    expect(saveFooter()).toBeNull()
    expect(h.updateTiming).not.toHaveBeenCalled()
  })

  it('shows the refreshed rule when the task ends and that refresh also changed it', () => {
    const h = mount({ records: [at] })
    fireEvent.click(screen.getByRole('button', { name: 'Review release' }))
    fireEvent.change(nameField(), { target: { value: 'Edited name' } })
    fireEvent.change(instructionField(), { target: { value: 'Edited instruction' } })
    expect(saveNotice()?.textContent).toBe(en['rule.unsaved'])
    // The delivered record both moves the target and ends the task, so the draft
    // has no stored rule left to differ from and the panel shows the new values.
    const endedAt: ScheduleCatalogEntry = {
      ...at, status: 'inactive', prompt: 'Revised instruction', scheduledAt: '2026-10-02T08:00:00.000Z',
    }
    h.update({ records: [endedAt] })
    const detail = screen.getByRole('complementary', { name: en['detail.label'] })
    expect(within(detail).getByRole('heading', { name: at.title })).toBeDefined()
    expect(detail.querySelector(`.${css.readonlyPrompt}`)?.textContent).toBe('Revised instruction')
    expect(within(detail).queryByRole('textbox')).toBeNull()
    expect(saveFooter()).toBeNull()
    expect(h.updateTiming).not.toHaveBeenCalled()
  })

  it('restores the stored rule when the Repeat menu returns to the stored kind', () => {
    const h = mount({ records: [daily] })
    fireEvent.click(screen.getByRole('button', { name: 'Daily weather' }))
    // The weekly choice stages another kind and its own weekday set, so returning
    // to the stored Daily must read the stored rule back — 23:00 in Asia/Shanghai —
    // rather than keep the staged choice.
    chooseRepeat(en['rule.weekly'])
    expect(repeatButton().textContent).toContain(en['rule.weekly'])
    chooseRepeat(en['rule.daily'])
    // The row reads back the stored rule's own frequency, which is the evidence
    // that the draft equals the stored values again.
    expect(repeatButton().textContent).toContain('Daily at 23:00')
    expect(timeButton().textContent).toBe('23:00:00')
    expect(zoneButton().textContent).toContain(displayedZone('Asia/Shanghai'))
    // A draft equal to the stored rule stages nothing.
    expect(saveFooter()).toBeNull()
    expect(h.updateTiming).not.toHaveBeenCalled()
  })

  it('keeps the shown choice when the Repeat menu selects it again', () => {
    const h = mount({ records: [daily] })
    fireEvent.click(screen.getByRole('button', { name: 'Daily weather' }))
    chooseRepeat(en['rule.daily'])
    expect(h.updateTiming).not.toHaveBeenCalled()
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('seeds a repeating choice with a whole-hour interval', () => {
    const h = mount({ records: [daily] })
    fireEvent.click(screen.getByRole('button', { name: 'Daily weather' }))
    chooseRepeat(en['rule.everyMinutes'])
    expect(h.updateTiming).not.toHaveBeenCalled()
    clickSave()
    expect(h.updateTiming).toHaveBeenCalledExactlyOnceWith({
      sessionId: daily.sessionId, id: daily.id, expected: timingSnapshot(daily),
      change: { kind: 'every', every_seconds: 3_600 },
    })
  })

  it('seeds a one-shot choice from the committed occurrence in the device zone', () => {
    const h = mount({ records: [daily] })
    fireEvent.click(screen.getByRole('button', { name: 'Daily weather' }))
    chooseRepeat(en['rule.once'])
    expect(h.updateTiming).not.toHaveBeenCalled()
    clickSave()
    expect(h.updateTiming).toHaveBeenCalledExactlyOnceWith({
      sessionId: daily.sessionId, id: daily.id, expected: timingSnapshot(daily),
      change: { kind: 'at', at: { date: '2026-10-01', time: '23:00:00.000', time_zone: DEVICE_ZONE } },
    })
  })

  it('reports a resolved Remote failure as an unconfirmed update', async () => {
    const h = mount({ records: [daily] })
    fireEvent.click(screen.getByRole('button', { name: 'Daily weather' }))
    h.updateTiming.mockResolvedValue({ ok: false, error: new RemoteError('gateway/internal', 'Unavailable', {}) })
    chooseTime('10', '23', '00')
    clickSave()
    await act(async () => { await h.updateTiming.mock.results[0]!.value })
    expect(screen.getByRole('alert').textContent).toBe(en['rule.error.unknown'])
    // The failed save keeps the draft so the user can retry it.
    expect(timeButton().textContent).toBe('10:23:00')
  })

  it('keeps the shared wording for a controlled failure without an override', async () => {
    const h = mount({ records: [daily] })
    fireEvent.click(screen.getByRole('button', { name: 'Daily weather' }))
    h.updateTiming.mockResolvedValue({ ok: true, value: { id: daily.id, updated: false, code: 'schedule_ended' } })
    chooseTime('10', '23', '00')
    clickSave()
    await act(async () => { await h.updateTiming.mock.results[0]!.value })
    expect(screen.getByRole('alert').textContent).toBe(en['timing.inactive'])
    expect(timeButton().textContent).toBe('10:23:00')
  })

  it('submits a Time row edit with the complete expected record', () => {
    const h = mount({ records: [daily] })
    fireEvent.click(screen.getByRole('button', { name: 'Daily weather' }))
    const time = timeButton()
    expect(time.textContent).toBe('23:00:00')
    chooseTime('10', '23', '00')
    expect(h.updateTiming).not.toHaveBeenCalled()
    clickSave()
    expect(h.updateTiming).toHaveBeenCalledExactlyOnceWith({
      sessionId: daily.sessionId, id: daily.id, expected: timingSnapshot(daily),
      change: { kind: 'daily', daily: { time: '10:23:00', time_zone: 'Asia/Shanghai' } },
    })
  })

  it('switches the Repeat choice and seeds the new kind from the committed occurrence', () => {
    const h = mount({ records: [every] })
    fireEvent.click(screen.getByRole('button', { name: 'Check metrics' }))
    const card = screen.getByRole('region', { name: en['rule.title'] })
    fireEvent.click(within(card).getByRole('button', { name: new RegExp(`^${en['rule.repeat']}`) }))
    const menu = screen.getByRole('menu')
    expect(within(menu).getAllByRole('menuitem')).toHaveLength(8)
    fireEvent.click(within(menu).getByRole('menuitem', { name: en['rule.daily'] }))
    expect(h.updateTiming).not.toHaveBeenCalled()
    // The Repeat row shows the staged choice before any save.
    expect(repeatButton().textContent).toContain(en['rule.daily'])
    clickSave()
    expect(h.updateTiming).toHaveBeenCalledExactlyOnceWith({
      sessionId: every.sessionId, id: every.id, expected: timingSnapshot(every),
      change: { kind: 'daily', daily: { time: '17:30:00.000', time_zone: DEVICE_ZONE } },
    })
  })

  it.each([en, zh])('offers the mock recurrence choices in the Repeat menu, in order', (dictionary) => {
    mount({ records: [daily] }, dictionary)
    fireEvent.click(screen.getByRole('button', { name: 'Daily weather' }))
    fireEvent.click(repeatButton(dictionary))
    const menu = screen.getByRole('menu')
    expect(within(menu).getAllByRole('menuitem').map(item => item.textContent)).toEqual([
      dictionary['rule.weekly'], dictionary['rule.weekdays'], dictionary['rule.daily'],
      dictionary['rule.everyHours'], dictionary['rule.everyMinutes'], dictionary['rule.everySeconds'],
      dictionary['rule.once'], dictionary['rule.cron'],
    ])
  })

  it('submits the Monday-to-Friday choice as a weekly rule with that weekday set', () => {
    const h = mount({ records: [daily] })
    fireEvent.click(screen.getByRole('button', { name: 'Daily weather' }))
    chooseRepeat(en['rule.weekdays'])
    // The choice stages the Monday-to-Friday rule; the bar's Save action submits it.
    expect(h.updateTiming).not.toHaveBeenCalled()
    expect(repeatButton().textContent).toContain(en['rule.weekdays'])
    clickSave()
    expect(h.updateTiming).toHaveBeenCalledExactlyOnceWith({
      sessionId: daily.sessionId, id: daily.id, expected: timingSnapshot(daily),
      change: { kind: 'weekly', weekly: { time: '23:00:00.000', time_zone: 'Asia/Shanghai', weekdays: [1, 2, 3, 4, 5] } },
    })
  })

  it('shows a stored Monday-to-Friday weekly rule as the selected weekdays choice without a Weekday row', () => {
    const weekdayRule: ScheduleCatalogEntry = { ...weekly, weekdays: [1, 2, 3, 4, 5] }
    mount({ records: [weekdayRule] })
    fireEvent.click(screen.getByRole('button', { name: weekly.prompt }))
    const t = makeTranslate(en)
    const frequency = formatScheduleFrequency(weekdayRule, t, { system: 'Asia/Shanghai', label: zone => zoneLabel(zone, t) })
    expect(repeatButton().textContent).toContain(frequency)
    const card = screen.getByRole('region', { name: en['rule.title'] })
    expect(within(card).queryByRole('group', { name: en['rule.weekday'] })).toBeNull()
    fireEvent.click(repeatButton())
    expect(within(screen.getByRole('menu')).getByRole('menuitem', { name: en['rule.weekdays'] }).querySelector('svg')).not.toBeNull()
  })

  it('keeps a stored Monday-to-Friday set when the Repeat menu switches to Weekly', () => {
    const weekdayRule: ScheduleCatalogEntry = { ...weekly, weekdays: [1, 2, 3, 4, 5] }
    const h = mount({ records: [weekdayRule] })
    fireEvent.click(screen.getByRole('button', { name: weekly.prompt }))
    // The stored set names the Monday-to-Friday choice, which has no Weekday row.
    expect(within(screen.getByRole('region', { name: en['rule.title'] }))
      .queryByRole('group', { name: en['rule.weekday'] })).toBeNull()
    chooseRepeat(en['rule.weekly'])
    // Both choices describe the same stored weekly rule, so the day set survives
    // instead of collapsing to the one day the occurrence falls on.
    expect(weekdayPressed(weekdayGroup())).toEqual(['true', 'true', 'true', 'true', 'true', 'false', 'false'])
    clickSave()
    expect(h.updateTiming).toHaveBeenCalledExactlyOnceWith({
      sessionId: weekly.sessionId, id: weekly.id, expected: timingSnapshot(weekdayRule),
      change: {
        kind: 'weekly',
        weekly: { time: '09:30:00.000', time_zone: 'Asia/Shanghai', weekdays: [1, 2, 3, 4, 5] },
      },
    })
  })

  it('carries the shown clock into a weekly choice and shows its Weekday row', async () => {
    const h = mount({ records: [daily] })
    const seeded: ScheduleCatalogEntry = {
      id: daily.id, sessionId: daily.sessionId, kind: 'weekly', status: 'active', title: daily.title,
      prompt: daily.prompt, time: '23:00:00.000', timeZone: 'Asia/Shanghai', weekdays: [4], scheduledAt: daily.scheduledAt,
    }
    h.updateTiming.mockResolvedValue({ ok: true, value: { id: daily.id, updated: true, record: seeded } })
    fireEvent.click(screen.getByRole('button', { name: 'Daily weather' }))
    chooseRepeat(en['rule.weekly'])
    expect(h.updateTiming).not.toHaveBeenCalled()
    clickSave()
    expect(h.updateTiming).toHaveBeenCalledExactlyOnceWith({
      sessionId: daily.sessionId, id: daily.id, expected: timingSnapshot(daily),
      change: { kind: 'weekly', weekly: { time: '23:00:00.000', time_zone: 'Asia/Shanghai', weekdays: [4] } },
    })
    // The authoritative refresh delivers the stored weekly rule the update returned.
    h.update({ records: [seeded] })
    await act(async () => { await h.updateTiming.mock.results[0]!.value })
    expect(weekdayPressed(weekdayGroup())).toEqual(['false', 'false', 'false', 'true', 'false', 'false', 'false'])
    expect(timeButton().textContent).toBe('23:00:00')
    expect(zoneButton().textContent).toContain(displayedZone('Asia/Shanghai'))
  })

  it('keeps the shown clock and zone when one clock-time choice switches to another', () => {
    const h = mount({ records: [daily] })
    fireEvent.click(screen.getByRole('button', { name: 'Daily weather' }))
    // Both choices state the rule as one wall clock in one zone, so the switch
    // carries that pair instead of restating the committed instant in UTC.
    chooseRepeat(en['rule.weekly'])
    expect(timeButton().textContent).toBe('23:00:00')
    expect(zoneButton().textContent).toContain(displayedZone('Asia/Shanghai'))
    chooseRepeat(en['rule.daily'])
    expect(timeButton().textContent).toBe('23:00:00')
    expect(zoneButton().textContent).toContain(displayedZone('Asia/Shanghai'))
    // The stored kind is back and the carried pair matches it, so nothing is staged.
    expect(saveFooter()).toBeNull()
    expect(h.updateTiming).not.toHaveBeenCalled()
  })

  it('seeds a weekly choice with the occurrence weekday when both calendars agree', () => {
    // The stored rule fires at 15:00Z, which is 23:00 on the same local day in
    // Asia/Shanghai, so the carried clock and the seeded weekday name that day.
    mount({ records: [daily] })
    fireEvent.click(screen.getByRole('button', { name: 'Daily weather' }))
    chooseRepeat(en['rule.weekly'])
    expect(timeButton().textContent).toBe('23:00:00')
    expect(weekdayPressed(weekdayGroup())).toEqual(['false', 'false', 'false', 'true', 'false', 'false', 'false'])
  })

  it('seeds a weekly choice with the occurrence weekday in the carried zone', () => {
    const eastDaily: ScheduleCatalogEntry = {
      ...daily, id: 'task-daily-east' as ScheduleId, title: 'East daily', prompt: 'East daily',
      time: '01:00:00.000', scheduledAt: '2026-09-30T17:00:00.000Z',
    }
    // That instant is Wednesday in UTC and Thursday 01:00 in Asia/Shanghai, so the
    // weekday row must name the local day the carried clock falls on.
    const h = mount({ records: [eastDaily] })
    fireEvent.click(screen.getByRole('button', { name: eastDaily.title }))
    chooseRepeat(en['rule.weekly'])
    expect(timeButton().textContent).toBe('01:00:00')
    expect(zoneButton().textContent).toContain(displayedZone('Asia/Shanghai'))
    expect(weekdayPressed(weekdayGroup())).toEqual(['false', 'false', 'false', 'true', 'false', 'false', 'false'])
    clickSave()
    expect(h.updateTiming).toHaveBeenCalledExactlyOnceWith({
      sessionId: eastDaily.sessionId, id: eastDaily.id, expected: timingSnapshot(eastDaily),
      change: { kind: 'weekly', weekly: { time: '01:00:00.000', time_zone: 'Asia/Shanghai', weekdays: [4] } },
    })
  })

  it('seeds a weekly choice from the committed occurrence when no clock is carried', () => {
    const h = mount({ records: [every] })
    fireEvent.click(screen.getByRole('button', { name: every.prompt }))
    chooseRepeat(en['rule.weekly'])
    // A choice without a clock row has no pair to carry, so the weekly choice
    // seeds the occurrence's clock in the device zone and its weekday there.
    expect(timeButton().textContent).toBe('17:30:00')
    expect(zoneButton().textContent).toContain(displayedZone(DEVICE_ZONE))
    clickSave()
    expect(h.updateTiming).toHaveBeenCalledExactlyOnceWith({
      sessionId: every.sessionId, id: every.id, expected: timingSnapshot(every),
      change: { kind: 'weekly', weekly: { time: '17:30:00.000', time_zone: DEVICE_ZONE, weekdays: [4] } },
    })
  })

  it('sends the whole weekday set when a day is toggled', async () => {
    const h = mount({ records: [weekly] })
    fireEvent.click(screen.getByRole('button', { name: weekly.prompt }))
    expect(weekdayPressed(weekdayGroup())).toEqual(['true', 'false', 'true', 'false', 'false', 'false', 'false'])
    fireEvent.click(within(weekdayGroup()).getByRole('button', { name: weekdayName('frequency.weekday.5') }))
    expect(h.updateTiming).not.toHaveBeenCalled()
    expect(weekdayPressed(weekdayGroup())).toEqual(['true', 'false', 'true', 'false', 'true', 'false', 'false'])
    clickSave()
    expect(h.updateTiming).toHaveBeenCalledExactlyOnceWith({
      sessionId: weekly.sessionId, id: weekly.id, expected: timingSnapshot(weekly),
      change: { kind: 'weekly', weekly: { time: '09:30:00.000', time_zone: 'Asia/Shanghai', weekdays: [1, 3, 5] } },
    })
    await act(async () => { await h.updateTiming.mock.results[0]!.value })
    fireEvent.click(within(weekdayGroup()).getByRole('button', { name: weekdayName('frequency.weekday.1') }))
    expect(h.updateTiming).toHaveBeenCalledTimes(1)
    clickSave()
    expect(h.updateTiming).toHaveBeenLastCalledWith({
      sessionId: weekly.sessionId, id: weekly.id, expected: timingSnapshot(weekly),
      change: { kind: 'weekly', weekly: { time: '09:30:00.000', time_zone: 'Asia/Shanghai', weekdays: [3] } },
    })
  })

  it('disables the Weekday row while a weekly save is pending and keeps the draft on failure', async () => {
    const h = mount({ records: [weekly] })
    fireEvent.click(screen.getByRole('button', { name: weekly.prompt }))
    const pending = Promise.withResolvers<RemoteResult<ScheduleUpdateResult>>()
    h.updateTiming.mockReturnValue(pending.promise)
    fireEvent.click(within(weekdayGroup()).getByRole('button', { name: weekdayName('frequency.weekday.5') }))
    expect(within(weekdayGroup()).getAllByRole('button').every(day => day.hasAttribute('disabled'))).toBe(false)
    clickSave()
    expect(within(weekdayGroup()).getAllByRole('button').every(day => day.hasAttribute('disabled'))).toBe(true)
    expect(saveFooter()!.textContent).toContain(en['rule.saving'])
    expect(within(saveFooter()!).getByRole('button', { name: en['rule.saving'] }).hasAttribute('disabled')).toBe(true)
    await act(async () => {
      pending.resolve({ ok: true, value: { id: weekly.id, updated: false, code: 'schedule_conflict' } })
      await pending.promise
    })
    expect(weekdayPressed(weekdayGroup())).toEqual(['true', 'false', 'true', 'false', 'true', 'false', 'false'])
    expect(screen.getByRole('alert').textContent).toBe(en['rule.error.conflict'])
  })

  it('keeps the last selected weekday when its toggle is pressed again', () => {
    const single = { ...weekly, weekdays: [2] }
    const h = mount({ records: [single] })
    fireEvent.click(screen.getByRole('button', { name: weekly.prompt }))
    fireEvent.click(within(weekdayGroup()).getByRole('button', { name: weekdayName('frequency.weekday.2') }))
    expect(h.updateTiming).not.toHaveBeenCalled()
    expect(weekdayPressed(weekdayGroup())).toEqual(['false', 'true', 'false', 'false', 'false', 'false', 'false'])
  })

  it.each([en, zh])('renders a catalog weekly rule with its stored weekdays and time, omitting the host zone', (dictionary) => {
    mount({ records: [weekly] }, dictionary)
    fireEvent.click(screen.getByRole('button', { name: weekly.prompt }))
    const card = screen.getByRole('region', { name: dictionary['rule.title'] })
    const t = makeTranslate(dictionary)
    const frequency = formatScheduleFrequency(weekly, t, { system: 'Asia/Shanghai', label: zone => zoneLabel(zone, t) })
    expect(frequency).not.toContain('Asia/Shanghai')
    expect(within(card).getByRole('button', { name: new RegExp(`^${dictionary['rule.repeat']}`) }).textContent)
      .toContain(frequency)
    expect(weekdayPressed(weekdayGroup(dictionary))).toEqual(['true', 'false', 'true', 'false', 'false', 'false', 'false'])
    expect(timeButton(dictionary).textContent).toBe('09:30:00')
    expect(zoneButton(dictionary).textContent).toContain(displayedZone('Asia/Shanghai', dictionary))
  })

  it.each([en, zh])('shows an ended weekly rule as read-only', (dictionary) => {
    mount({ records: [{ ...weekly, status: 'inactive' }] }, dictionary)
    fireEvent.click(screen.getByRole('button', { name: weekly.prompt }))
    const card = screen.getByRole('region', { name: dictionary['rule.title'] })
    expect(within(card).getByRole('button', { name: new RegExp(`^${dictionary['rule.repeat']}`) }).hasAttribute('disabled')).toBe(true)
    expect(timeButton(dictionary).disabled).toBe(true)
    expect(zoneButton(dictionary).hasAttribute('disabled')).toBe(true)
    for (const day of within(weekdayGroup(dictionary)).getAllByRole('button')) {
      expect(day.hasAttribute('disabled')).toBe(true)
    }
    // The disabled rows already read as ended; no standing read-only note.
    expect(within(card).queryByText(dictionary['timing.inactive'])).toBeNull()
    // An ended task cannot become dirty, so no save controls exist.
    expect(saveFooter()).toBeNull()
  })

  it.each([en, zh])('offers a cron Repeat choice that reveals structured rows without a request', (dictionary) => {
    const h = mount({ records: [daily] }, dictionary)
    fireEvent.click(screen.getByRole('button', { name: 'Daily weather' }))
    chooseRepeat(dictionary['rule.cron'], dictionary)
    expect(h.updateTiming).not.toHaveBeenCalled()
    const card = screen.getByRole('region', { name: dictionary['rule.title'] })
    // The seeded expression matches the daily shape, so the builder shows its
    // structured rows and no raw expression input.
    expect(within(card).queryByLabelText(dictionary['rule.cronLabel'])).toBeNull()
    const frequency = cronFrequencyButton(dictionary)
    expect(frequency.textContent).toContain(dictionary['cronForm.daily'])
    // The choice seeds the committed occurrence's clock in the device zone.
    expect(timeButton(dictionary).textContent).toBe('23:00')
    // The described hint carries the sentence the staged expression parses to.
    expect(document.getElementById(frequency.getAttribute('aria-describedby')!)?.textContent)
      .toBe(dictionary === en ? 'Every day at 23:00' : '每天 23:00')
    expect(saveFooter()).not.toBeNull()
  })

  it.each([en, zh])('renders an unrecognized cron expression as a raw row like its neighbours with its sentence in the card hints', (dictionary) => {
    // The two-hour list matches no builder shape, so the raw expression row
    // shows without any raw choice being made.
    mount({ records: [{ ...cron, expression: '30 9,15 * * *' }] }, dictionary)
    fireEvent.click(screen.getByRole('button', { name: cron.prompt }))
    const card = screen.getByRole('region', { name: dictionary['rule.title'] })
    const expression = within(card).getByLabelText<HTMLInputElement>(dictionary['rule.cronLabel'])
    const row = expression.parentElement!
    // The label and the input are the row's only children, so no face wrapper
    // stacks them and the row keeps the shared one-line row metrics.
    expect(row.classList.contains(css.ruleRow!)).toBe(true)
    expect(row.children).toHaveLength(2)
    expect(row.children[0]?.tagName).toBe('LABEL')
    expect(row.children[0]?.getAttribute('for')).toBe(expression.id)
    expect(row.children[1]).toBe(expression)
    const rows = row.parentElement!
    expect(rows.classList.contains(css.ruleRows!)).toBe(true)
    // The sentence is a hint under the bordered rows, in the same element and
    // place as the zone hint, rather than a second line inside the row.
    const hint = document.getElementById(expression.getAttribute('aria-describedby')!)!
    expect(hint.className).toBe(css.ruleHint)
    expect(row.contains(hint)).toBe(false)
    expect(hint.parentElement).toBe(rows.parentElement)
    expect(hint.textContent).toBe(dictionary === en ? 'Every day at 09:30, 15:30' : '每天 09:30、15:30')
    // The zone row keeps no hint of its own: its picker names the zone it states,
    // so the row points at nothing.
    expect(zoneButton(dictionary).getAttribute('aria-describedby')).toBeNull()
  })

  it('submits the staged cron expression with the complete expected record', () => {
    const h = mount({ records: [daily] })
    fireEvent.click(screen.getByRole('button', { name: 'Daily weather' }))
    chooseRepeat(en['rule.cron'])
    expect(h.updateTiming).not.toHaveBeenCalled()
    clickSave()
    expect(h.updateTiming).toHaveBeenCalledExactlyOnceWith({
      sessionId: daily.sessionId, id: daily.id, expected: timingSnapshot(daily),
      change: { kind: 'cron', cron: { expression: '0 23 * * *', time_zone: DEVICE_ZONE } },
    })
  })

  it('seeds the choice a cron rule switches to from the committed occurrence', () => {
    // A cron rule states its clock in its expression and has no time row, so the
    // switch has no pair to carry and seeds the new choice from the occurrence.
    mount({ records: [cron] })
    fireEvent.click(screen.getByRole('button', { name: cron.prompt }))
    chooseRepeat(en['rule.daily'])
    expect(timeButton().textContent).toBe('09:00:00')
    expect(zoneButton().textContent).toContain(displayedZone(DEVICE_ZONE))
  })

  it('rejects an invalid cron expression locally without a request', () => {
    const h = mount({ records: [daily] })
    fireEvent.click(screen.getByRole('button', { name: 'Daily weather' }))
    chooseRepeat(en['rule.cron'])
    // The recognized seed hides the raw input until the raw choice is made,
    // which stages nothing by itself.
    chooseCronShape(en['rule.cronLabel'])
    const expression = screen.getByLabelText<HTMLInputElement>(en['rule.cronLabel'])
    expect(expression.value).toBe('0 23 * * *')
    fireEvent.change(expression, { target: { value: '0 9 * *' } })
    expect(expression.getAttribute('aria-invalid')).toBe('true')
    // The unparsable expression replaces its sentence in the same hint, which
    // stays outside the one-line row and turns into the alert itself.
    const hint = document.getElementById(expression.getAttribute('aria-describedby')!)!
    expect(hint.className).toBe(`${css.ruleHint} ${css.ruleHintError}`)
    expect(hint.textContent).toBe(en['rule.cronInvalid'])
    expect(expression.parentElement?.contains(hint)).toBe(false)
    clickSave()
    expect(h.updateTiming).not.toHaveBeenCalled()
    // The refused save adds no second copy: the hint stays the one alert.
    expect(screen.getAllByRole('alert')).toEqual([hint])
  })

  it('previews a typed cron expression and restores the stored one on Cancel', () => {
    const h = mount({ records: [cron] })
    fireEvent.click(screen.getByRole('button', { name: cron.prompt }))
    chooseCronShape(en['rule.cronLabel'])
    fireEvent.change(screen.getByLabelText<HTMLInputElement>(en['rule.cronLabel']), {
      target: { value: '*/15 * * * *' },
    })
    expect(screen.getByText('Every 15 minutes')).toBeDefined()
    expect(h.updateTiming).not.toHaveBeenCalled()
    clickCancel()
    // The raw choice is sticky, so the restored expression stays editable text.
    expect(screen.getByLabelText<HTMLInputElement>(en['rule.cronLabel']).value).toBe('0 9 * * 1-5')
    const card = screen.getByRole('region', { name: en['rule.title'] })
    expect(within(card).getByText('Mon–Fri at 09:00')).toBeDefined()
    expect(saveFooter()).toBeNull()
  })

  it('submits a cron zone change that keeps the stored expression', () => {
    const h = mount({ records: [cron] })
    fireEvent.click(screen.getByRole('button', { name: cron.prompt }))
    chooseZone('Europe/Berlin')
    expect(h.updateTiming).not.toHaveBeenCalled()
    clickSave()
    expect(h.updateTiming).toHaveBeenCalledExactlyOnceWith({
      sessionId: cron.sessionId, id: cron.id, expected: timingSnapshot(cron),
      change: { kind: 'cron', cron: { expression: '0 9 * * 1-5', time_zone: 'Europe/Berlin' } },
    })
  })

  it('keeps a failed cron save and its draft', async () => {
    const h = mount({ records: [cron] })
    fireEvent.click(screen.getByRole('button', { name: cron.prompt }))
    h.updateTiming.mockResolvedValue({ ok: true, value: { id: cron.id, updated: false, code: 'schedule_conflict' } })
    chooseCronShape(en['rule.cronLabel'])
    fireEvent.change(screen.getByLabelText<HTMLInputElement>(en['rule.cronLabel']), {
      target: { value: '*/15 * * * *' },
    })
    clickSave()
    await act(async () => { await h.updateTiming.mock.results[0]!.value })
    expect(screen.getByLabelText<HTMLInputElement>(en['rule.cronLabel']).value).toBe('*/15 * * * *')
    // The Host failure takes the hint slot in place of the described sentence.
    const alert = screen.getByRole('alert')
    expect(alert.textContent).toBe(en['rule.error.conflict'])
    expect(alert.className).toBe(`${css.ruleHint} ${css.ruleHintError}`)
    expect(screen.queryByText('Every 15 minutes')).toBeNull()
    // Typing again keeps the Host failure until Cancel or the next save.
    fireEvent.change(screen.getByLabelText<HTMLInputElement>(en['rule.cronLabel']), {
      target: { value: '*/20 * * * *' },
    })
    expect(screen.getByRole('alert').textContent).toBe(en['rule.error.conflict'])
  })

  it.each([en, zh])('renders a catalog cron rule with its shape rows, preview, zone, and next run', (dictionary) => {
    mount({ records: [cron] }, dictionary)
    fireEvent.click(screen.getByRole('button', { name: cron.prompt }))
    const card = screen.getByRole('region', { name: dictionary['rule.title'] })
    // The Repeat trigger names the cron choice itself; the rows and the
    // sentence below carry the rule, so no summary repeats there.
    expect(within(card).getByRole('button', { name: new RegExp(`^${dictionary['rule.repeat']}`) }).textContent)
      .toBe(`${dictionary['rule.repeat']}${dictionary['rule.cron']}`)
    // The stored Mon-to-Fri expression matches the weekly shape, so the builder
    // shows its rows instead of the raw expression input.
    expect(within(card).queryByLabelText(dictionary['rule.cronLabel'])).toBeNull()
    expect(cronFrequencyButton(dictionary).textContent).toContain(dictionary['cronForm.weekly'])
    expect(weekdayPressed(weekdayGroup(dictionary))).toEqual(['true', 'true', 'true', 'true', 'true', 'false', 'false'])
    expect(timeButton(dictionary).textContent).toBe('09:00')
    expect(within(card).getByText(dictionary === en ? 'Mon–Fri at 09:00' : '周一至周五 09:00')).toBeDefined()
    expect(zoneButton(dictionary).textContent).toContain(displayedZone('Asia/Shanghai', dictionary))
    const detail = screen.getByRole('complementary', { name: dictionary['detail.label'] })
    expect(nextRunTime(detail)?.textContent).toBe(absoluteNextRun(cron.scheduledAt, dictionary))
    expect(relativeText(detail)).toBe(relativeNextRun(cron.scheduledAt, dictionary))
  })

  it.each([en, zh])('shows an ended cron rule as read-only', (dictionary) => {
    mount({ records: [{ ...cron, status: 'inactive' }] }, dictionary)
    fireEvent.click(screen.getByRole('button', { name: cron.prompt }))
    const card = screen.getByRole('region', { name: dictionary['rule.title'] })
    expect(within(card).getByRole('button', { name: new RegExp(`^${dictionary['rule.repeat']}`) }).hasAttribute('disabled')).toBe(true)
    expect(cronFrequencyButton(dictionary).hasAttribute('disabled')).toBe(true)
    for (const day of within(weekdayGroup(dictionary)).getAllByRole('button')) {
      expect(day.hasAttribute('disabled')).toBe(true)
    }
    expect(timeButton(dictionary).disabled).toBe(true)
    expect(zoneButton(dictionary).hasAttribute('disabled')).toBe(true)
    // The disabled rows already read as ended; no standing read-only note.
    expect(within(card).queryByText(dictionary['timing.inactive'])).toBeNull()
    // An ended task cannot become dirty, so no save controls exist.
    expect(saveFooter()).toBeNull()
  })

  it('regenerates the weekly cron expression from pill toggles and submits it', () => {
    const h = mount({ records: [cron] })
    fireEvent.click(screen.getByRole('button', { name: cron.prompt }))
    fireEvent.click(within(weekdayGroup()).getByRole('button', { name: weekdayName('frequency.weekday.6') }))
    expect(weekdayPressed(weekdayGroup())).toEqual(['true', 'true', 'true', 'true', 'true', 'true', 'false'])
    fireEvent.click(within(weekdayGroup()).getByRole('button', { name: weekdayName('frequency.weekday.1') }))
    expect(screen.getByText('Tue–Sat at 09:00')).toBeDefined()
    clickSave()
    expect(h.updateTiming).toHaveBeenCalledExactlyOnceWith({
      sessionId: cron.sessionId, id: cron.id, expected: timingSnapshot(cron),
      change: { kind: 'cron', cron: { expression: '0 9 * * 2-6', time_zone: 'Asia/Shanghai' } },
    })
  })

  it('keeps the last selected weekday of a weekly cron shape', () => {
    mount({ records: [{ ...cron, expression: '0 9 * * 1' }] })
    fireEvent.click(screen.getByRole('button', { name: cron.prompt }))
    fireEvent.click(within(weekdayGroup()).getByRole('button', { name: weekdayName('frequency.weekday.1') }))
    expect(weekdayPressed(weekdayGroup())).toEqual(['true', 'false', 'false', 'false', 'false', 'false', 'false'])
    // Nothing was staged, so the detail stays clean.
    expect(saveFooter()).toBeNull()
  })

  it('stages a picked clock into the weekly cron expression from its two columns', () => {
    const h = mount({ records: [cron] })
    fireEvent.click(screen.getByRole('button', { name: cron.prompt }))
    // A cron expression has no seconds field, so its panel offers no seconds column.
    expect(chooseTime('10', '45', undefined)).toBe('10:45')
    expect(screen.getByText('Mon–Fri at 10:45')).toBeDefined()
    clickSave()
    expect(h.updateTiming).toHaveBeenCalledExactlyOnceWith({
      sessionId: cron.sessionId, id: cron.id, expected: timingSnapshot(cron),
      change: { kind: 'cron', cron: { expression: '45 10 * * 1-5', time_zone: 'Asia/Shanghai' } },
    })
  })

  it('edits an hourly cron shape through its step and minute steppers', () => {
    const stored = { ...cron, expression: '15 */2 * * *' }
    const h = mount({ records: [stored] })
    fireEvent.click(screen.getByRole('button', { name: cron.prompt }))
    expect(cronFrequencyButton().textContent).toContain(en['rule.everyHours'])
    expect(screen.getByLabelText<HTMLInputElement>(en['timing.interval']).value).toBe('2')
    expect(screen.getByLabelText<HTMLInputElement>(en['cronForm.atMinute']).value).toBe('15')
    // The arrows step within the field's bounds and regenerate the expression.
    fireEvent.click(screen.getByRole('button', { name: en['timing.intervalIncrease'] }))
    expect(screen.getByLabelText<HTMLInputElement>(en['timing.interval']).value).toBe('3')
    fireEvent.click(screen.getByRole('button', { name: en['timing.intervalDecrease'] }))
    expect(screen.getByLabelText<HTMLInputElement>(en['timing.interval']).value).toBe('2')
    // A cleared or fractional entry stages nothing; an out-of-range one clamps.
    fireEvent.change(screen.getByLabelText<HTMLInputElement>(en['cronForm.atMinute']), { target: { value: '' } })
    expect(screen.getByLabelText<HTMLInputElement>(en['cronForm.atMinute']).value).toBe('15')
    fireEvent.change(screen.getByLabelText<HTMLInputElement>(en['cronForm.atMinute']), { target: { value: '2.5' } })
    expect(screen.getByLabelText<HTMLInputElement>(en['cronForm.atMinute']).value).toBe('15')
    fireEvent.change(screen.getByLabelText<HTMLInputElement>(en['cronForm.atMinute']), { target: { value: '99' } })
    expect(screen.getByLabelText<HTMLInputElement>(en['cronForm.atMinute']).value).toBe('59')
    // A value at a bound disables the arrow that would leave it.
    expect(screen.getByRole('button', { name: en['cronForm.minuteIncrease'] }).hasAttribute('disabled')).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: en['cronForm.minuteDecrease'] }))
    clickSave()
    expect(h.updateTiming).toHaveBeenCalledExactlyOnceWith({
      sessionId: cron.sessionId, id: cron.id, expected: timingSnapshot(stored),
      change: { kind: 'cron', cron: { expression: '58 */2 * * *', time_zone: 'Asia/Shanghai' } },
    })
  })

  it('switches a recognized cron shape to minutely from the Frequency menu', () => {
    const h = mount({ records: [cron] })
    fireEvent.click(screen.getByRole('button', { name: cron.prompt }))
    chooseCronShape(en['rule.everyMinutes'])
    expect(screen.getByText('Every 5 minutes')).toBeDefined()
    expect(screen.getByLabelText<HTMLInputElement>(en['timing.interval']).value).toBe('5')
    clickSave()
    expect(h.updateTiming).toHaveBeenCalledExactlyOnceWith({
      sessionId: cron.sessionId, id: cron.id, expected: timingSnapshot(cron),
      change: { kind: 'cron', cron: { expression: '*/5 * * * *', time_zone: 'Asia/Shanghai' } },
    })
  })

  it.each([en, zh])('renders a monthly cron rule as a date grid with its time and preview', (dictionary) => {
    mount({ records: [{ ...cron, expression: '30 8 1,15 * *' }] }, dictionary)
    fireEvent.click(screen.getByRole('button', { name: cron.prompt }))
    const card = screen.getByRole('region', { name: dictionary['rule.title'] })
    expect(within(card).queryByLabelText(dictionary['rule.cronLabel'])).toBeNull()
    expect(cronFrequencyButton(dictionary).textContent).toContain(dictionary['cronForm.monthly'])
    const group = dateGroup(dictionary)
    expect(within(group).getAllByRole('button')).toHaveLength(31)
    expect(datesPressed(group)).toEqual([1, 15])
    expect(within(group).getByRole('button', { name: dateName(15, dictionary) }).getAttribute('aria-pressed')).toBe('true')
    expect(timeButton(dictionary).textContent).toBe('08:30')
    expect(within(card).getByText(dictionary === en ? 'Day 1, 15 of every month at 08:30' : '每月 1、15 日 08:30')).toBeDefined()
  })

  it('regenerates the monthly cron expression from date toggles and submits it', () => {
    const stored = { ...cron, expression: '30 8 1,15 * *' }
    const h = mount({ records: [stored] })
    fireEvent.click(screen.getByRole('button', { name: cron.prompt }))
    fireEvent.click(within(dateGroup()).getByRole('button', { name: dateName(20) }))
    expect(datesPressed(dateGroup())).toEqual([1, 15, 20])
    fireEvent.click(within(dateGroup()).getByRole('button', { name: dateName(1) }))
    expect(datesPressed(dateGroup())).toEqual([15, 20])
    expect(screen.getByText('Day 15, 20 of every month at 08:30')).toBeDefined()
    clickSave()
    expect(h.updateTiming).toHaveBeenCalledExactlyOnceWith({
      sessionId: cron.sessionId, id: cron.id, expected: timingSnapshot(stored),
      change: { kind: 'cron', cron: { expression: '30 8 15,20 * *', time_zone: 'Asia/Shanghai' } },
    })
  })

  it('keeps the last selected date of a monthly cron shape', () => {
    mount({ records: [{ ...cron, expression: '0 9 15 * *' }] })
    fireEvent.click(screen.getByRole('button', { name: cron.prompt }))
    fireEvent.click(within(dateGroup()).getByRole('button', { name: dateName(15) }))
    expect(datesPressed(dateGroup())).toEqual([15])
    // Nothing was staged, so the detail stays clean.
    expect(saveFooter()).toBeNull()
  })

  it('seeds the monthly date from the committed occurrence and submits it', () => {
    const h = mount({ records: [daily] })
    fireEvent.click(screen.getByRole('button', { name: 'Daily weather' }))
    chooseRepeat(en['rule.cron'])
    // The committed occurrence, 2026-10-01T15:00Z, is the 1st at 23:00 in the
    // device zone, so the switch selects that date and keeps the clock.
    chooseCronShape(en['cronForm.monthly'])
    expect(datesPressed(dateGroup())).toEqual([1])
    expect(timeButton().textContent).toBe('23:00')
    clickSave()
    expect(h.updateTiming).toHaveBeenCalledExactlyOnceWith({
      sessionId: daily.sessionId, id: daily.id, expected: timingSnapshot(daily),
      change: { kind: 'cron', cron: { expression: '0 23 1 * *', time_zone: DEVICE_ZONE } },
    })
  })

  it('seeds shape fields the staged expression lacks from the committed occurrence', () => {
    const h = mount({ records: [daily] })
    fireEvent.click(screen.getByRole('button', { name: 'Daily weather' }))
    chooseRepeat(en['rule.cron'])
    // The daily seed keeps its minute across the hourly switch.
    chooseCronShape(en['rule.everyHours'])
    expect(screen.getByLabelText<HTMLInputElement>(en['timing.interval']).value).toBe('1')
    expect(screen.getByLabelText<HTMLInputElement>(en['cronForm.atMinute']).value).toBe('0')
    expect(screen.getByRole('button', { name: en['timing.intervalDecrease'] }).hasAttribute('disabled')).toBe(true)
    // The hourly shape has no hour or weekday: both seed from the committed
    // occurrence, 2026-10-01T15:00Z, a Thursday at 23:00 in the device zone.
    chooseCronShape(en['cronForm.weekly'])
    expect(weekdayPressed(weekdayGroup())).toEqual(['false', 'false', 'false', 'true', 'false', 'false', 'false'])
    expect(timeButton().textContent).toBe('23:00')
    chooseCronShape(en['cronForm.daily'])
    expect(timeButton().textContent).toBe('23:00')
    clickSave()
    expect(h.updateTiming).toHaveBeenCalledExactlyOnceWith({
      sessionId: daily.sessionId, id: daily.id, expected: timingSnapshot(daily),
      change: { kind: 'cron', cron: { expression: '0 23 * * *', time_zone: DEVICE_ZONE } },
    })
  })

  it('keeps the raw expression choice until another shape is chosen', () => {
    mount({ records: [cron] })
    fireEvent.click(screen.getByRole('button', { name: cron.prompt }))
    chooseCronShape(en['rule.cronLabel'])
    expect(screen.getByLabelText<HTMLInputElement>(en['rule.cronLabel']).value).toBe('0 9 * * 1-5')
    expect(cronFrequencyButton().textContent).toContain(en['rule.cronLabel'])
    expect(saveFooter()).toBeNull()
    // Choosing the expression's own recognized shape restores the rows without an edit.
    chooseCronShape(en['cronForm.weekly'])
    expect(screen.queryByLabelText(en['rule.cronLabel'])).toBeNull()
    expect(weekdayGroup()).toBeDefined()
    expect(saveFooter()).toBeNull()
  })

  it('closes the cron Frequency menu with Escape without closing the detail', () => {
    mount({ records: [cron] })
    fireEvent.click(screen.getByRole('button', { name: cron.prompt }))
    const frequency = cronFrequencyButton()
    frequency.focus()
    fireEvent.click(frequency)
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(screen.getByRole('complementary')).toBeDefined()
    expect(document.activeElement).toBe(frequency)
  })

  it('closes the cron clock panel with Escape, keeping the detail and returning focus', () => {
    mount({ records: [cron] })
    fireEvent.click(screen.getByRole('button', { name: cron.prompt }))
    fireEvent.click(timeButton())
    // A cron expression has no seconds field, so its panel offers no seconds column.
    expect(screen.queryByRole('listbox', { name: en['timing.second'] })).toBeNull()
    const option = within(clockColumn('timing.minute')).getByRole('option', { name: '00' })
    option.focus()
    fireEvent.keyDown(option, { key: 'Escape' })
    expect(screen.queryByRole('listbox', { name: en['timing.hour'] })).toBeNull()
    expect(screen.getByRole('complementary')).toBeDefined()
    expect(document.activeElement).toBe(timeButton())
  })

  it('renders the cron time remaining and keeps the stored zone on the rule', () => {
    const stored: ScheduleCatalogEntry = { ...cron, timeZone: taskZone(cron.scheduledAt) }
    mount({ records: [stored] })
    fireEvent.click(screen.getByRole('button', { name: cron.prompt }))
    const detail = screen.getByRole('complementary', { name: en['detail.label'] })
    // The line states the instant in the device zone and the distance beside it.
    expect(nextRunTime(detail)?.textContent).toBe(absoluteNextRun(stored.scheduledAt, en))
    expect(relativeText(detail)).toBe(relativeNextRun(stored.scheduledAt, en))
    // The stored zone stays visible on the rule card's zone row.
    expect(zoneButton().textContent).toContain(displayedZone(stored.timeZone))
  })

  it('disables the run-time rows while a save is pending and keeps the staged choice on failure', async () => {
    const h = mount({ records: [every] })
    fireEvent.click(screen.getByRole('button', { name: 'Check metrics' }))
    const pending = Promise.withResolvers<RemoteResult<ScheduleUpdateResult>>()
    h.updateTiming.mockReturnValue(pending.promise)
    const repeat = within(screen.getByRole('region', { name: en['rule.title'] }))
      .getByRole('button', { name: new RegExp(`^${en['rule.repeat']}`) })
    fireEvent.click(repeat)
    fireEvent.click(screen.getByRole('menuitem', { name: en['rule.daily'] }))
    expect(h.updateTiming).not.toHaveBeenCalled()
    expect(repeat.hasAttribute('disabled')).toBe(false)
    clickSave()
    expect(repeat.hasAttribute('disabled')).toBe(true)
    expect(timeButton().disabled).toBe(true)
    expect(zoneButton().hasAttribute('disabled')).toBe(true)
    await act(async () => {
      pending.resolve({ ok: true, value: { id: every.id, updated: false, code: 'schedule_conflict' } })
      await pending.promise
    })
    // The failed save keeps the staged daily choice and its rows.
    expect(repeat.hasAttribute('disabled')).toBe(false)
    expect(timeButton().textContent).toBe('17:30:00')
    expect(zoneButton().textContent).toContain(displayedZone(DEVICE_ZONE))
    expect(screen.getByRole('alert').textContent).toBe(en['rule.error.conflict'])
  })

  it('disables both rows while a Time zone save is pending', async () => {
    const h = mount({ records: [daily] })
    fireEvent.click(screen.getByRole('button', { name: 'Daily weather' }))
    const pending = Promise.withResolvers<RemoteResult<ScheduleUpdateResult>>()
    h.updateTiming.mockReturnValue(pending.promise)
    chooseZone('Europe/Berlin')
    expect(h.updateTiming).not.toHaveBeenCalled()
    clickSave()
    expect(h.updateTiming).toHaveBeenCalledOnce()
    expect(timeButton().disabled).toBe(true)
    expect(zoneButton().hasAttribute('disabled')).toBe(true)
    await act(async () => {
      pending.resolve({ ok: true, value: { id: daily.id, updated: false, code: 'schedule_conflict' } })
      await pending.promise
    })
    expect(timeButton().disabled).toBe(false)
    expect(zoneButton().hasAttribute('disabled')).toBe(false)
  })

  it.each([en, zh])('keeps both rows and surfaces the localized conflict', async (dictionary) => {
    const h = mount({ records: [daily] }, dictionary)
    fireEvent.click(screen.getByRole('button', { name: 'Daily weather' }))
    h.updateTiming.mockResolvedValue({ ok: true, value: { id: daily.id, updated: false, code: 'schedule_conflict' } })
    chooseZone('Europe/Berlin', dictionary)
    clickSave(dictionary)
    await act(async () => { await h.updateTiming.mock.results[0]!.value })
    // A failed save keeps the draft so the user can retry it.
    expect(zoneButton(dictionary).textContent).toContain(displayedZone('Europe/Berlin', dictionary))
    expect(timeButton(dictionary).textContent).toBe('23:00:00')
    expect(screen.getByRole('alert').textContent).toBe(dictionary['rule.error.conflict'])
  })

  it('keeps a failed Time draft and preserves an untouched stored millisecond value after Cancel', async () => {
    const stored: ScheduleCatalogEntry = { ...daily, time: '23:00:15.500' }
    const h = mount({ records: [stored] })
    fireEvent.click(screen.getByRole('button', { name: 'Daily weather' }))
    h.updateTiming.mockResolvedValue({ ok: true, value: { id: daily.id, updated: false, code: 'schedule_conflict' } })
    chooseTime('10', '23', '00')
    clickSave()
    await act(async () => { await h.updateTiming.mock.results[0]!.value })
    // The failed save keeps the draft and its localized error.
    expect(timeButton().textContent).toBe('10:23:00')
    expect(screen.getByRole('alert').textContent).toBe(en['rule.error.conflict'])
    // Cancel restores the stored rule, whose untouched millisecond value the next save keeps.
    clickCancel()
    expect(timeButton().textContent).toBe('23:00:15')
    expect(saveFooter()).toBeNull()
    chooseZone('Europe/Berlin')
    clickSave()
    expect(h.updateTiming).toHaveBeenLastCalledWith({
      sessionId: stored.sessionId, id: stored.id, expected: timingSnapshot(stored),
      change: { kind: 'daily', daily: { time: '23:00:15.500', time_zone: 'Europe/Berlin' } },
    })
  })

  it('keeps the draft and reports an unconfirmed update', async () => {
    const h = mount({ records: [daily] })
    fireEvent.click(screen.getByRole('button', { name: 'Daily weather' }))
    h.updateTiming.mockRejectedValue(new Error('transport down'))
    chooseTime('10', '23', '00')
    clickSave()
    const attempt = h.updateTiming.mock.results[0]?.value as Promise<unknown> | undefined
    await act(async () => { await attempt?.catch(() => {}) })
    expect(timeButton().textContent).toBe('10:23:00')
    expect(screen.getByRole('alert').textContent).toBe(en['rule.error.unknown'])
  })

  it.each(['success', 'reject'] as const)('ignores a %s rule response that arrives after another task is shown', async (outcome) => {
    const h = mount({ records: [daily, every] })
    fireEvent.click(screen.getByRole('button', { name: 'Daily weather' }))
    const pending = Promise.withResolvers<RemoteResult<ScheduleUpdateResult>>()
    h.updateTiming.mockReturnValue(pending.promise)
    chooseTime('10', '23', '00')
    clickSave()
    fireEvent.click(screen.getByRole('button', { name: 'Check metrics' }))
    await act(async () => {
      if (outcome === 'reject') pending.reject(new Error('late rejection'))
      else pending.resolve({ ok: true, value: { id: daily.id, updated: true, record: {
        id: daily.id, title: daily.title, prompt: daily.prompt, kind: 'daily', time: '10:23:00.000',
        timeZone: 'Asia/Shanghai', scheduledAt: daily.scheduledAt,
      } } })
      await pending.promise.catch(() => {})
    })
    expect(nameField().value).toBe('Check metrics')
    expect(screen.queryByRole('alert')).toBeNull()
    expect(saveFooter()).toBeNull()
    expect(screen.getByLabelText<HTMLInputElement>(en['timing.interval']).value).toBe('301')
  })

  it.each(['success', 'reject'] as const)('ignores a %s save response that arrives after the detail unmounts', async (outcome) => {
    const h = mount({ records: [daily] })
    fireEvent.click(screen.getByRole('button', { name: 'Daily weather' }))
    const pending = Promise.withResolvers<RemoteResult<ScheduleUpdateResult>>()
    h.updateTiming.mockReturnValue(pending.promise)
    chooseTime('10', '23', '00')
    clickSave()
    h.view.unmount()
    await act(async () => {
      if (outcome === 'reject') pending.reject(new Error('late rejection'))
      else pending.resolve({ ok: true, value: { id: daily.id, updated: true, record: {
        id: daily.id, title: daily.title, prompt: daily.prompt, kind: 'daily', time: '10:23:00.000',
        timeZone: 'Asia/Shanghai', scheduledAt: daily.scheduledAt,
      } } })
      await pending.promise.catch(() => {})
    })
    expect(screen.queryByRole('complementary')).toBeNull()
  })

  it.each([en, zh])('shows an ended rule as its ended state with read-only rows', (dictionary) => {
    mount({ records: [{ ...daily, status: 'inactive' }] }, dictionary)
    fireEvent.click(screen.getByRole('button', { name: 'Daily weather' }))
    const detail = screen.getByRole('complementary', { name: dictionary['detail.label'] })
    expect(visibleText(detail, dictionary['status.inactive'])).toHaveLength(1)
    expect(nextRunTime(detail)).toBeNull()
    const card = within(detail).getByRole('region', { name: dictionary['rule.title'] })
    expect(within(card).getByRole('button', { name: new RegExp(`^${dictionary['rule.repeat']}`) }).hasAttribute('disabled')).toBe(true)
    expect(timeButton(dictionary).disabled).toBe(true)
    expect(zoneButton(dictionary).hasAttribute('disabled')).toBe(true)
    // The disabled rows already read as ended; no standing read-only note.
    expect(visibleText(card, dictionary['timing.inactive'])).toHaveLength(0)
    expect(saveFooter()).toBeNull()
  })

  it('renders the daily time remaining and keeps the stored zone on the rule', () => {
    const stored: ScheduleCatalogEntry = { ...daily, timeZone: taskZone(daily.scheduledAt) }
    mount({ records: [stored] })
    fireEvent.click(screen.getByRole('button', { name: 'Daily weather' }))
    const detail = screen.getByRole('complementary', { name: en['detail.label'] })
    // The line states the instant in the device zone and the distance beside it.
    expect(nextRunTime(detail)?.textContent).toBe(absoluteNextRun(stored.scheduledAt, en))
    expect(relativeText(detail)).toBe(relativeNextRun(stored.scheduledAt, en))
    const t = makeTranslate(en)
    expect(within(detail).getByText(formatScheduleFrequency(stored, t, {
      system: 'Asia/Shanghai', label: zone => zoneLabel(zone, t),
    }), { exact: true })).toBeDefined()
  })

  it('renders a saved record time in the task zone rather than the browser zone', async () => {
    const zone = taskZone(delivery.scheduledAt)
    const stored: ScheduleCatalogEntry = { ...daily, timeZone: zone, lastDelivery: delivery }
    mount({ records: [stored] })
    fireEvent.click(screen.getByRole('button', { name: 'Daily weather' }))
    const detail = screen.getByRole('complementary', { name: en['detail.label'] })
    fireEvent.click(within(detail).getByRole('tab', { name: detailViewLabels(en).records }))
    const record = await within(expectDetailView(en, 'records')).findByRole('region', { name: en['delivery.label'] })
    const occurrence = record.querySelector<HTMLTimeElement>(`.${css.deliveryTime}`)
    // Precondition: the two zones hold different offsets at this instant, so the
    // task-zone render cannot coincide with the browser-zone render.
    expect(zoneOffsetMinutes(zone, delivery.scheduledAt))
      .not.toBe(zoneOffsetMinutes(Intl.DateTimeFormat().resolvedOptions().timeZone, delivery.scheduledAt))
    const rendered = formatScheduleNextRun(delivery.scheduledAt, en['time.locale'], zone)
    expect(occurrence?.textContent).toBe(rendered)
    expect(rendered).not.toBe(formatScheduleNextRun(delivery.scheduledAt, en['time.locale']))
  })

  it.each([
    [en, 'Daily at 23:00'],
    [zh, '每天 23:00'],
  ] as const)('omits a stored zone equal to the host zone from the frequency line', (dictionary, expected) => {
    mount({ records: [daily] }, dictionary)
    fireEvent.click(screen.getByRole('button', { name: 'Daily weather' }))
    expect(repeatButton(dictionary).textContent).toContain(expected)
    expect(repeatButton(dictionary).textContent).not.toContain('Asia/Shanghai')
  })

  it.each([en, zh])('names a non-host stored zone with its ICU label in the frequency line', (dictionary) => {
    mount({ records: [{ ...daily, timeZone: 'America/New_York' }] }, dictionary)
    fireEvent.click(screen.getByRole('button', { name: 'Daily weather' }))
    const expected = dictionary === en
      ? `Daily at 23:00 (${displayedZone('America/New_York', dictionary)})`
      : `每天 23:00（${displayedZone('America/New_York', dictionary)}）`
    expect(repeatButton(dictionary).textContent).toContain(expected)
    expect(repeatButton(dictionary).textContent).not.toContain('America/New_York')
  })

  it('localizes a stored zone outside the minimal fallback in the frequency line', () => {
    mount({ records: [{ ...daily, timeZone: 'Europe/Paris' }] })
    fireEvent.click(screen.getByRole('button', { name: 'Daily weather' }))
    expect(repeatButton().textContent).toContain(`Daily at 23:00 (${displayedZone('Europe/Paris')})`)
  })

  it('renders the linked Session control in the strip on Rules only', () => {
    mount({ records: [at] })
    fireEvent.click(screen.getByRole('button', { name: 'Review release' }))
    const detail = screen.getByRole('complementary', { name: en['detail.label'] })
    expect(detailContext(detail)).not.toBeNull()
    fireEvent.click(within(detail).getByRole('tab', { name: detailViewLabels(en).records }))
    expectDetailView(en, 'records')
    expect(detailContext(detail)).toBeNull()
    expect(within(detail).queryByRole('button', { name: en['detail.openSession'] })).toBeNull()
    fireEvent.click(within(detail).getByRole('tab', { name: detailViewLabels(en).rules }))
    expect(detailContext(detail)).not.toBeNull()
    expect(within(detail).getByRole('button', { name: en['detail.openSession'] })).toBeDefined()
  })
})

describe('Task detail name and instruction edits', () => {
  it.each([en, zh])('names both controls through the dictionary and seeds them from the task', (dictionary) => {
    mount({ records: [at] }, dictionary)
    fireEvent.click(screen.getByRole('button', { name: 'Review release' }))
    const detail = screen.getByRole('complementary', { name: dictionary['detail.label'] })
    const name = within(detail).getByRole<HTMLInputElement>('textbox', { name: dictionary['detail.name'] })
    const instruction = within(detail).getByRole<HTMLTextAreaElement>('textbox', { name: dictionary['detail.instruction'] })
    expect(name.tagName).toBe('INPUT')
    expect(name.value).toBe(at.title)
    expect(instruction.tagName).toBe('TEXTAREA')
    expect(instruction.value).toBe(at.prompt)
  })

  it('stages a name edit until Save and then submits it without a timing change', () => {
    const h = mount({ records: [at] })
    fireEvent.click(screen.getByRole('button', { name: 'Review release' }))
    fireEvent.change(nameField(), { target: { value: 'Release audit' } })
    fireEvent.focusOut(nameField())
    expect(h.updateTiming).not.toHaveBeenCalled()
    expect(saveNotice()?.textContent).toBe(en['rule.unsaved'])
    clickSave()
    expect(h.updateTiming).toHaveBeenCalledExactlyOnceWith({
      sessionId: at.sessionId, id: at.id, expected: timingSnapshot(at), title: 'Release audit',
    })
  })

  it('stages an instruction edit until Save and then submits it without a timing change', () => {
    const h = mount({ records: [at] })
    fireEvent.click(screen.getByRole('button', { name: 'Review release' }))
    fireEvent.change(instructionField(), { target: { value: 'Audit every release' } })
    fireEvent.focusOut(instructionField())
    expect(h.updateTiming).not.toHaveBeenCalled()
    clickSave()
    expect(h.updateTiming).toHaveBeenCalledExactlyOnceWith({
      sessionId: at.sessionId, id: at.id, expected: timingSnapshot(at), prompt: 'Audit every release',
    })
  })

  it('submits the edited name and instruction together with the timing change of the same draft', () => {
    const h = mount({ records: [at] })
    fireEvent.click(screen.getByRole('button', { name: 'Review release' }))
    fireEvent.change(nameField(), { target: { value: 'Release audit' } })
    fireEvent.change(instructionField(), { target: { value: 'Audit every release' } })
    chooseTime('10', '25', '30')
    clickSave()
    expect(h.updateTiming).toHaveBeenCalledExactlyOnceWith({
      sessionId: at.sessionId, id: at.id, expected: timingSnapshot(at),
      title: 'Release audit', prompt: 'Audit every release',
      change: { kind: 'at', at: { date: '2026-10-01', time: '10:25:30', time_zone: DEVICE_ZONE } },
    })
  })

  it('refuses a blank name locally and keeps the draft', () => {
    const h = mount({ records: [at] })
    fireEvent.click(screen.getByRole('button', { name: 'Review release' }))
    fireEvent.change(nameField(), { target: { value: '   ' } })
    clickSave()
    expect(h.updateTiming).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toBe(en['rule.invalidTitle'])
    expect(nameField().value).toBe('   ')
  })

  it('refuses a name longer than the Host limit locally and keeps the draft', () => {
    const h = mount({ records: [at] })
    fireEvent.click(screen.getByRole('button', { name: 'Review release' }))
    const overlong = 'x'.repeat(121)
    fireEvent.change(nameField(), { target: { value: overlong } })
    clickSave()
    expect(h.updateTiming).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toBe(en['rule.invalidTitle'])
    expect(nameField().value).toBe(overlong)
  })

  it('accepts a name of exactly the Host limit', () => {
    const h = mount({ records: [at] })
    fireEvent.click(screen.getByRole('button', { name: 'Review release' }))
    const longest = 'x'.repeat(120)
    fireEvent.change(nameField(), { target: { value: longest } })
    clickSave()
    expect(h.updateTiming).toHaveBeenCalledExactlyOnceWith({
      sessionId: at.sessionId, id: at.id, expected: timingSnapshot(at), title: longest,
    })
  })

  it('refuses a blank instruction locally and keeps the draft', () => {
    const h = mount({ records: [at] })
    fireEvent.click(screen.getByRole('button', { name: 'Review release' }))
    fireEvent.change(instructionField(), { target: { value: '\n \n' } })
    clickSave()
    expect(h.updateTiming).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toBe(en['rule.invalidPrompt'])
    expect(instructionField().value).toBe('\n \n')
  })

  it.each([en, zh])('restores the stored name and instruction on Cancel', (dictionary) => {
    mount({ records: [at] }, dictionary)
    fireEvent.click(screen.getByRole('button', { name: 'Review release' }))
    fireEvent.change(nameField(dictionary), { target: { value: 'Draft name' } })
    fireEvent.change(instructionField(dictionary), { target: { value: 'Draft instruction' } })
    expect(saveFooter()).not.toBeNull()
    clickCancel(dictionary)
    expect(nameField(dictionary).value).toBe(at.title)
    expect(instructionField(dictionary).value).toBe(at.prompt)
    expect(saveFooter()).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('keeps the edited name and instruction when the save is rejected', async () => {
    const h = mount({ records: [at] })
    fireEvent.click(screen.getByRole('button', { name: 'Review release' }))
    h.updateTiming.mockResolvedValue({ ok: true, value: { id: at.id, updated: false, code: 'schedule_conflict' } })
    fireEvent.change(nameField(), { target: { value: 'Release audit' } })
    fireEvent.change(instructionField(), { target: { value: 'Audit every release' } })
    clickSave()
    await act(async () => { await h.updateTiming.mock.results[0]!.value })
    expect(screen.getByRole('alert').textContent).toBe(en['rule.error.conflict'])
    expect(nameField().value).toBe('Release audit')
    expect(instructionField().value).toBe('Audit every release')
    expect(saveFooter()).not.toBeNull()
  })

  it('keeps an unsaved name draft across an authoritative refresh and expects the refreshed record', () => {
    const h = mount({ records: [at] })
    fireEvent.click(screen.getByRole('button', { name: 'Review release' }))
    fireEvent.change(nameField(), { target: { value: 'Release audit' } })
    const refreshed = { ...at, title: 'Server rename' }
    h.update({ records: [refreshed] })
    expect(nameField().value).toBe('Release audit')
    clickSave()
    expect(h.updateTiming).toHaveBeenCalledExactlyOnceWith({
      sessionId: at.sessionId, id: at.id, expected: timingSnapshot(refreshed), title: 'Release audit',
    })
  })

  it.each([en, zh])('renders an ended task name and instruction as plain text with no save bar', (dictionary) => {
    mount({ records: [ended] }, dictionary)
    fireEvent.click(screen.getByRole('button', { name: 'Review release' }))
    const detail = screen.getByRole('complementary', { name: dictionary['detail.label'] })
    // An ended task can never be edited again, so no field remains: the stored
    // name and instruction are plain read-only text.
    expect(within(detail).queryByRole('textbox')).toBeNull()
    expect(within(detail).getByRole('heading', { name: ended.title })).toBeDefined()
    expect(detail.querySelector(`.${css.readonlyPrompt}`)?.textContent).toBe(ended.prompt)
    expect(saveFooter()).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('applies the detail metrics to the header, the next-run line, and the instruction box', () => {
    const stylesheet = readFileSync(resolve(import.meta.dirname, '../src/client/TaskManagerPage.module.css'), 'utf8')
    expect(stylesheet).toMatch(/\.editName\s*\{[^}]*font-size:\s*20px;[^}]*font-weight:\s*500;/)
    expect(stylesheet).toMatch(/\.editName:hover\s*\{[^}]*box-shadow:\s*0 1px var\(--dsw-alias-border-l3\);/)
    expect(stylesheet).toMatch(
      /\.editName:focus\s*\{[^}]*box-shadow:\s*0 1px var\(--dsw-focus-ring-color, var\(--dsw-alias-state-business-primary\)\);/,
    )
    // The bar keeps the mock's 44px in the Tasks page's own detail column; the
    // right-panel placement states the cross size that lands its rule on the
    // conversation header's rule, and the actions keep the mock's -8px inset.
    const tabStrip = /^\.detailTabsBar\s*\{([^}]*)\}/m.exec(stylesheet)?.[1] ?? ''
    expect(tabStrip).toMatch(/min-height:\s*44px;/)
    const placement = /^\.tabBody > \.detail \.detailTabsBar\s*\{([^}]*)\}/m.exec(stylesheet)?.[1] ?? ''
    expect(placement).toMatch(/min-height:\s*37px;/)
    expect(tabStrip).toMatch(/padding:\s*0 var\(--detail-gutter\);/)
    expect(stylesheet).toMatch(/\.detailActions\s*\{[^}]*margin-right:\s*-8px;/)
    // The mock's `.detail-heading` is the scrolling rule view's first content:
    // its 4px lead-in meets the next-run line, and it opens no band of its own.
    const header = /\.detailHeader\s*\{([^}]*)\}/.exec(stylesheet)?.[1] ?? ''
    expect(header).toMatch(/margin-bottom:\s*4px;/)
    expect(header).not.toMatch(/padding|min-height|border/)
    // The rule view keeps the scrolling region's full 24px lead-in for the name.
    expect(stylesheet).not.toMatch(/\.detailScroll:has\(/)
    const nextRun = /\.nextRun\s*\{([^}]*)\}/.exec(stylesheet)?.[1] ?? ''
    expect(nextRun).toMatch(/color:\s*var\(--dsw-alias-label-tertiary\);/)
    expect(nextRun).toMatch(/font-size:\s*13px;/)
    expect(nextRun).toMatch(/line-height:\s*20px;/)
    const instruction = /\.instruction\s*\{([^}]*)\}/.exec(stylesheet)?.[1] ?? ''
    expect(instruction).toMatch(/min-height:\s*112px;/)
    // The box grows with its content from the resting height to the 160px cap.
    expect(instruction).toMatch(/max-height:\s*160px;/)
    expect(instruction).toMatch(/field-sizing:\s*content;/)
    expect(instruction).toMatch(/padding:\s*12px;/)
    expect(instruction).toMatch(/border:\s*0\.5px solid var\(--dsw-alias-border-l3\);/)
    expect(instruction).toMatch(/border-radius:\s*16px;/)
    // The mock inherits the instruction's 14px text and pins its own 24px leading.
    expect(instruction).toMatch(/font-size:\s*14px;/)
    expect(instruction).toMatch(/line-height:\s*24px;/)
    expect(stylesheet).toMatch(/\.instruction:hover\s*\{[^}]*border-color:\s*var\(--dsw-alias-border-l2\);/)
    expect(stylesheet).toMatch(/\.instruction:focus\s*\{[^}]*border-color:\s*var\(--dsw-alias-state-business-primary\);/)
    expect(stylesheet).toMatch(/\.ruleRows\s*\{[^}]*border-radius:\s*16px;/)
  })
})

describe('Mock detail metrics shared with the task list', () => {
  const stylesheet = readFileSync(resolve(import.meta.dirname, '../src/client/TaskManagerPage.module.css'), 'utf8')
  // Anchored so a placement-specific selector that ends in the same class name
  // does not shadow the base rule.
  const rule = (selector: string): string =>
    new RegExp(`^\\.${selector}\\s*\\{([^}]*)\\}`, 'm').exec(stylesheet)?.[1] ?? ''

  it('states the mock notice step on the catalog notices', () => {
    // The mock's `.notice` is 12px/20px; without a stated size the text inherits
    // the host's 16px inside the detail pane.
    const notice = rule('notice')
    expect([/font-size:\s*12px;/.test(notice)]).toEqual([true])
    expect([/line-height:\s*20px;/.test(notice)]).toEqual([true])
    // The mock's notice box: its own 12px/14px padding, 9px gap, top
    // alignment, surface fill, 10px radius, and 20px below.
    expect(notice).toMatch(/padding:\s*12px 14px;/)
    expect(notice).toMatch(/gap:\s*9px;/)
    expect(notice).toMatch(/align-items:\s*flex-start;/)
    expect(notice).toMatch(/background:\s*var\(--dsw-specific-sidebar-fill\);/)
    expect(notice).toMatch(/border-radius:\s*10px;/)
    expect(notice).toMatch(/margin:\s*0 0 20px;/)
    // The notice keeps the colour this box had before it took the mock's
    // surface fill; the retired deletion-failure variant leaves no rule behind.
    expect(notice).toMatch(/color:\s*var\(--dsw-alias-label-secondary\);/)
    expect(stylesheet).not.toMatch(/^\.error\s*\{/m)
  })

  it('states the mock empty state and its h3 heading step', () => {
    // The deleted-task state is retired with the detail that now closes on
    // deletion, so its centered rule and the quieter caption step are gone.
    expect(stylesheet).not.toMatch(/\.detailEmpty/)
    expect(stylesheet).not.toMatch(/\.emptyCaption/)
    expect(stylesheet).not.toMatch(/\.detailDeletedNotice/)
    const empty = rule('empty')
    expect(empty).toMatch(/padding:\s*48px 20px;/)
    expect(empty).toMatch(/color:\s*var\(--dsw-alias-label-tertiary\);/)
    expect(empty).toMatch(/font-size:\s*14px;/)
    // The mock spaces the empty state through its children's margins, so the
    // container states no gap that would double them.
    expect(empty).not.toMatch(/gap:/)
    // Every centered state's heading rides one declaration group on the body's
    // own 14px/400 tertiary step, so no centered state reads bolder than another.
    const heading = /\.empty h2,\s*\.empty h3,\s*\.empty \.emptyTitle\s*\{([^}]*)\}/.exec(stylesheet)?.[1] ?? ''
    expect(heading).toMatch(/margin-bottom:\s*8px;/)
    expect(heading).toMatch(/color:\s*var\(--dsw-alias-label-tertiary\);/)
    expect(heading).toMatch(/font-size:\s*14px;/)
    expect(heading).toMatch(/font-weight:\s*400;/)
    expect(rule('emptyGlyph')).toMatch(/margin-bottom:\s*12px;/)
    // The mock's `.empty h3 + .btn`.
    expect(rule('emptyAction')).toMatch(/margin-top:\s*16px;/)
  })

  it('states the Plugins-aligned list-page column, heading, search field, and row metrics', () => {
    // jsdom computes no layout, so the values are read from the applied
    // stylesheet the way the detail-metric assertions above read it.
    expect(rule('pageScroll')).toMatch(/overflow:\s*auto;/)
    expect(rule('pageContent')).toMatch(/max-width:\s*960px;/)
    expect(rule('pageContent')).toMatch(/margin:\s*0 auto;/)
    // The Plugins page's own column inset, shared by both first-level pages:
    // inline and bottom only, because the heading row owns the top inset.
    expect(rule('pageContent')).toMatch(/padding:\s*0 clamp\(24px, 4vw, 48px\) 48px;/)
    const heading = rule('pageHeading')
    expect(heading).toMatch(/align-items:\s*center;/)
    expect(heading).toMatch(/justify-content:\s*space-between;/)
    expect(heading).toMatch(/gap:\s*16px;/)
    // The column's former top inset the row now carries, matching the Plugins head.
    expect(heading).toMatch(/padding-top:\s*28px;/)
    expect(heading).toMatch(/margin-bottom:\s*24px;/)
    // The Plugins page's macOS head clearance above that same row inset, so the
    // heading clears the hiddenInset titlebar and keeps the 76px total offset.
    expect(stylesheet).toMatch(
      /\[data-platform='darwin'\][^{]*\.pageHeading\s*\{[^}]*padding-top:\s*calc\(28px \+ var\(--dsh-frame-top-clearance, 0px\)\);/,
    )
    // The column keeps no top inset of its own, on either platform.
    expect(stylesheet).not.toMatch(
      /\[data-platform='darwin'\][^{]*\.pageContent\s*\{/,
    )
    // The Plugins toolbar's Add-plugin capsule, repeated by the creation action.
    expect(rule('creationActions')).toMatch(/gap:\s*16px;/)
    const newButton = rule('newButton')
    expect(newButton).toMatch(/height:\s*32px;/)
    expect(newButton).toMatch(/font-size:\s*13px;/)
    expect(newButton).toMatch(/padding:\s*0 12px;/)
    expect(newButton).toMatch(/border-radius:\s*16px;/)
    const headingTitle = /\.pageHeading h1\s*\{([^}]*)\}/.exec(stylesheet)?.[1] ?? ''
    // The first-level title step is the Plugins page's `pageTitle`, not the
    // mock's larger page heading; the equality case below pins that pair.
    expect(headingTitle).toMatch(/font-size:\s*20px;/)
    expect(headingTitle).toMatch(/line-height:\s*28px;/)
    // The mock's `.list-tools` and `.tab`.
    expect(rule('filters')).toMatch(/gap:\s*8px 12px;/)
    expect(rule('filters')).toMatch(/margin-bottom:\s*14px;/)
    const tab = rule('filterTab')
    expect(tab).toMatch(/height:\s*28px;/)
    expect(tab).toMatch(/padding:\s*0 10px;/)
    expect(tab).toMatch(/border-radius:\s*14px;/)
    expect(tab).toMatch(/font-size:\s*14px;/)
    // The selected chip keeps the chip's own weight; only the fill marks it.
    expect(rule('filterTabActive')).not.toMatch(/font-weight/)
    // The mock's `.searchbox` keeps its hairline at the repository's 0.5px.
    const field = rule('searchField')
    expect(field).toMatch(/height:\s*36px;/)
    expect(field).toMatch(/padding:\s*0 10px;/)
    expect(field).toMatch(/border:\s*0\.5px solid var\(--dsw-alias-border-l3\);/)
    expect(field).toMatch(/border-radius:\s*12px;/)
    expect(stylesheet).toMatch(/\.searchField:hover\s*\{[^}]*border-color:\s*var\(--dsw-alias-border-l2\);/)
    expect(stylesheet)
      .toMatch(/\.searchField:focus-within\s*\{[^}]*border-color:\s*var\(--dsw-alias-state-business-primary\);/)
    expect(stylesheet).toMatch(/\.searchField > :first-child svg\s*\{[^}]*width:\s*14px;/)
    expect(stylesheet).toMatch(/\.searchField input::placeholder\s*\{[^}]*color:\s*var\(--dsw-alias-label-caption\);/)
    expect(stylesheet).toMatch(/\.searchField input::-webkit-search-cancel-button\s*\{[^}]*display:\s*none;/)
    expect(rule('searchClear')).toMatch(/margin-right:\s*-6px;/)
    expect(rule('searchClear')).toMatch(/color:\s*var\(--dsw-alias-label-tertiary\);/)
    expect(stylesheet).toMatch(/\.searchClear svg\s*\{[^}]*width:\s*14px;/)
    // The 2px column gap, the hover surface flush with the page column, the
    // 8px content inset, and no separator.
    expect(rule('listRows')).toMatch(/gap:\s*2px;/)
    const row = rule('row')
    expect(row).toMatch(/gap:\s*12px;/)
    expect(row).toMatch(/align-items:\s*flex-start;/)
    expect(row).toMatch(/width:\s*100%;/)
    expect(row).not.toMatch(/margin:/)
    expect(row).toMatch(/padding:\s*8px;/)
    expect(row).toMatch(/border-radius:\s*12px;/)
    expect(row).not.toMatch(/border(?:-(?!radius)|:)/)
    expect(stylesheet)
      .toMatch(/\.row:hover\s*\{[^}]*background:\s*var\(--dsw-alias-interactive-bg-hover\);/)
    expect(rule('selectedRow')).toMatch(/background:\s*var\(--dsw-alias-interactive-bg-hover\);/)
    // The inline glyph on the title line, sized to the 20px leading.
    const glyph = rule('rowGlyph')
    expect(glyph).toMatch(/width:\s*16px;/)
    expect(glyph).toMatch(/height:\s*20px;/)
    expect(glyph).toMatch(/margin-top:\s*2px;/)
    expect(glyph).toMatch(/color:\s*var\(--dsw-alias-label-tertiary\);/)
    const title = rule('rowTitle')
    expect(title).toMatch(/font-weight:\s*500;/)
    expect(title).toMatch(/line-height:\s*23px;/)
    const summary = rule('rowSummary')
    expect(summary).toMatch(/margin-top:\s*2px;/)
    expect(summary).toMatch(/font-size:\s*13px;/)
    expect(summary).toMatch(/line-height:\s*21px;/)
    expect(summary).toMatch(/color:\s*var\(--dsw-alias-label-tertiary\);/)
    // The title keeps one step at every width, so no breakpoint raises it past
    // the sibling first-level page's title.
    const narrowStep = /@media \(max-width: 760px\)\s*\{([\s\S]*?)\n\}/.exec(stylesheet)?.[1] ?? ''
    expect(narrowStep).not.toContain('.pageHeading')
    expect(stylesheet.match(/\.pageHeading h1\s*\{/g)).toHaveLength(1)
  })

  it('sizes the page title exactly like the first-level Plugins page title', () => {
    // Both pages are first-level sidebar entries, so their titles must resolve
    // to one step. jsdom loads no CSS, so both sheets are installed under their
    // Vite module names and the computed declarations are compared: the Plugins
    // page owns `pageTitle`, and this page's heading has to keep matching it.
    const ourSheet = readFileSync(resolve(import.meta.dirname, '../src/client/TaskManagerPage.module.css'), 'utf8')
      .replaceAll('.pageHeading', `.${css.pageHeading}`)
    const pluginsSheet = readFileSync(
      resolve(import.meta.dirname, '../../ui-plugin-manager/src/client/PluginManagerPage.module.css'), 'utf8',
    ).replaceAll('.pageTitle', `.${pluginsCss.pageTitle}`)
    const sheet = document.createElement('style')
    sheet.textContent = `${ourSheet}\n${pluginsSheet}`
    document.head.append(sheet)
    const oursWrapper = document.createElement('div')
    oursWrapper.className = css.pageHeading as string
    const ours = document.createElement('h1')
    oursWrapper.append(ours)
    const theirs = document.createElement('h1')
    theirs.className = pluginsCss.pageTitle as string
    document.body.append(oursWrapper, theirs)
    try {
      const oursStyle = getComputedStyle(ours)
      const theirsStyle = getComputedStyle(theirs)
      expect(oursStyle.fontSize).toBe(theirsStyle.fontSize)
      expect(oursStyle.lineHeight).toBe(theirsStyle.lineHeight)
      expect(oursStyle.fontWeight).toBe(theirsStyle.fontWeight)
      expect(oursStyle.fontSize).toBe('20px')
      expect(oursStyle.lineHeight).toBe('28px')
      expect(oursStyle.fontWeight).toBe('500')
    } finally {
      sheet.remove()
      oursWrapper.remove()
      theirs.remove()
    }
  })

  it('states the mock run-time card heading and the l4 panel edge', () => {
    expect(rule('ruleCard h3')).toMatch(/color:\s*var\(--dsw-alias-label-tertiary\);/)
    expect(rule('ruleCard h3')).toMatch(/line-height:\s*20px;/)
    expect(rule('ruleCard h3')).toMatch(/font-weight:\s*400;/)
    expect(rule('detail')).toMatch(/border-left:\s*0\.5px solid var\(--dsw-alias-border-l4\);/)
  })

  it('steps the detail gutter at the mock breakpoints and drops the retired 18px step', () => {
    expect(stylesheet).toMatch(/@media \(max-width: 1100px\)\s*\{\s*\.detail\s*\{[^}]*--detail-gutter:\s*20px;/)
    expect(stylesheet).toMatch(/@media \(max-width: 400px\)\s*\{\s*\.detail\s*\{[^}]*--detail-gutter:\s*16px;/)
    expect(stylesheet).not.toMatch(/--detail-gutter:\s*18px;/)
    // The staged-save bar and its failure line consume the stepped gutter
    // instead of a literal, so the panel edge stays one column.
    expect(rule('saveFooter')).toMatch(/padding:\s*20px var\(--detail-gutter\);/)
    expect(rule('saveFailure')).toMatch(/padding:\s*12px var\(--detail-gutter\) 0;/)
    // The mock's `.automation-detail .detail-titlebar` narrows the strip's gap
    // at this width and closes the actions' group gap, while the strip above
    // the breakpoint keeps its 20px.
    const narrow = /@media \(max-width: 400px\)\s*\{([\s\S]*?)\n\}/.exec(stylesheet)?.[1] ?? ''
    expect(rule('detailTabsBar')).toMatch(/gap:\s*20px;/)
    expect(narrow).toMatch(/\.detailTabsBar\s*\{[^}]*gap:\s*16px;/)
    expect(narrow).toMatch(/\.detailActions\s*\{[^}]*gap:\s*0;/)
  })
})

describe('Task manager deletion', () => {
  it('deletes a retained ended task only after confirmation and authoritative removal', () => {
    const h = mount({ records: [ended] })
    const dialog = openDelete()
    expect(dialog.textContent).toContain(en['delete.description'])
    expect(h.props.onDelete).not.toHaveBeenCalled()
    fireEvent.click(within(dialog).getByRole('button', { name: en['delete.cancel'] }))
    expect(screen.getByRole('complementary')).toBeDefined()
    expect(taskNames()).toEqual(['Review release'])
    expect(h.props.onDelete).not.toHaveBeenCalled()
    chooseDelete()
    fireEvent.click(screen.getByRole('button', { name: en['delete.confirm'] }))
    expect(h.props.onDelete).toHaveBeenCalledExactlyOnceWith(ended.id)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByRole('complementary')).toBeDefined()
    expect(taskNames()).toEqual(['Review release'])
    h.update({ deleting: [ended.id] })
    h.update({ records: [], deleting: [] })
    // The row leaves the list and the detail closes with it.
    expect(screen.queryByRole('complementary')).toBeNull()
    expect(taskNames()).toEqual([])
    expect(screen.getByRole('status').textContent).toContain(en['list.empty'])
  })

  it('bounds long confirmation content separately from the cancel and confirm actions', () => {
    const h = mount()
    const dialog = openDelete()
    const cancel = within(dialog).getByRole('button', { name: en['delete.cancel'] })
    const confirm = within(dialog).getByRole('button', { name: en['delete.confirm'] })
    const content = dialog.querySelector(`.${css.confirmContent}`)!
    expect(dialog.classList.contains(css.confirmDialog!)).toBe(true)
    expect(content.textContent).toContain(at.title)
    expect(content.contains(cancel)).toBe(false)
    expect(content.contains(confirm)).toBe(false)
    expect(confirm.hasAttribute('disabled')).toBe(false)

    // The geometry is observed on the rendered dialog after both stylesheets
    // are applied, as `code-body.client.spec.tsx` does for its own modules:
    // jsdom has no CSS loader, so nothing is computed until the sheets are
    // installed. The dialog's cap must follow the padding of the Modal layer
    // that holds it, and the scrolling content must sit inside that cap instead
    // of pinning a number that a wrong layer padding could not contradict.
    installStyles({ confirmDialog: css.confirmDialog, confirmContent: css.confirmContent })
    expect(getComputedStyle(dialog).maxHeight).toBe(`calc(100dvh - ${MODAL_LAYER_PADDING * 2}px)`)
    expect(getComputedStyle(content).overflowY).toBe('auto')
    const footer = dialog.lastElementChild as HTMLElement
    expect(getComputedStyle(footer).flexShrink).toBe('0')
    fireEvent.click(confirm)
    expect(h.props.onDelete).toHaveBeenCalledExactlyOnceWith(at.id)
  })

  it('requires explicit confirmation, supports Cancel and Escape, and preserves details', () => {
    const h = mount()
    const dialog = openDelete()
    expect(h.props.onDelete).not.toHaveBeenCalled()
    expect(dialog.textContent).toContain(at.title)
    expect(dialog.textContent).not.toContain(at.prompt)
    expect(dialog.textContent).toContain(en['delete.description'])
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: en['delete.cancel'] }))
    fireEvent.click(within(dialog).getByRole('button', { name: en['delete.cancel'] }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: en['detail.more'] }))
    chooseDelete()
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByRole('complementary')).toBeDefined()
    expect(h.props.onDelete).not.toHaveBeenCalled()
    chooseDelete()
    fireEvent.click(screen.getByRole('button', { name: en['delete.confirm'] }))
    expect(h.props.onDelete).toHaveBeenCalledExactlyOnceWith(at.id)
    expect(taskNames()).toContain('Review release')
  })

  it('closes a stale confirmation when an authoritative update removes that task', () => {
    const h = mount()
    openDelete()
    h.update({ records: [every, after] })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.queryByRole('complementary')).toBeNull()
    expect(h.props.onDelete).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1 }))
  })

  it('retains a task whose rule update is pending and disables its deletion', async () => {
    const h = mount({ records: [at] })
    fireEvent.click(screen.getByRole('button', { name: 'Review release' }))
    const pending = Promise.withResolvers<RemoteResult<ScheduleUpdateResult>>()
    h.updateTiming.mockReturnValue(pending.promise)
    fireEvent.click(within(screen.getByRole('region', { name: en['rule.title'] }))
      .getByRole('button', { name: new RegExp(`^${en['rule.repeat']}`) }))
    fireEvent.click(screen.getByRole('menuitem', { name: en['rule.daily'] }))
    clickSave()
    expect(h.updateTiming).toHaveBeenCalledOnce()
    h.update({ records: [every] })
    expect(nameField().value).toBe('Review release')
    openMore()
    const retained = screen.getByRole('menuitem', { name: en['delete.action'] })
    expect(retained.hasAttribute('disabled')).toBe(true)
    fireEvent.click(retained)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(h.props.onDelete).not.toHaveBeenCalled()
    await act(async () => {
      pending.resolve({ ok: true, value: { id: at.id, updated: true, record: {
        id: at.id, title: at.title, prompt: at.prompt, kind: 'daily', time: '09:00:00.000', timeZone: 'UTC',
        scheduledAt: at.scheduledAt,
      } } })
      await pending.promise
    })
    expect(screen.queryByRole('complementary')).toBeNull()
  })

  it('waits for the refreshed list, not just the deletion acknowledgement, before closing the detail', async () => {
    const h = remoteCatalog()
    await screen.findByRole('button', { name: 'Review release' })
    const deletion = Promise.withResolvers<RemoteResult<ScheduleDeleteResult>>()
    const refresh = Promise.withResolvers<RemoteResult<ScheduleCatalogEntry[]>>()
    h.remove.mockReturnValueOnce(deletion.promise)
    h.list.mockReturnValueOnce(refresh.promise)
    openDelete()
    fireEvent.click(screen.getByRole('button', { name: en['delete.confirm'] }))
    expect(h.remove).toHaveBeenCalledExactlyOnceWith(at.id)
    openMore()
    expect(screen.getByRole('menuitem', { name: en['delete.pending'] }).hasAttribute('disabled')).toBe(true)
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
    expect(taskNames()).toEqual(['Review release'])
    await act(async () => { deletion.resolve({ ok: true, value: { id: at.id, deleted: true } }); await deletion.promise })
    // The row and the open detail both stay on screen, so the refresh that
    // answers the deletion shows no spinner of its own.
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.getByRole('list').getAttribute('aria-busy')).toBe('true')
    expect(screen.getByRole('complementary')).toBeDefined()
    expect(taskNames()).toEqual(['Review release'])
    await act(async () => { refresh.resolve({ ok: true, value: [] }); await expect(h.onDelete.mock.results[0]!.value).resolves.toBe('deleted') })
    // The deletion reaches the detail only once the refreshed list reports it:
    // the detail then closes and the page falls back to its empty state.
    expect(screen.queryByRole('complementary')).toBeNull()
    expect(taskNames()).toEqual([])
    expect(screen.getByRole('status').textContent).toContain(en['list.empty'])
    // The deleted row is gone, so the close falls back to the page heading.
    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1 }))
  })

  it('retains failed deletions and permits another confirmed attempt', async () => {
    const h = remoteCatalog()
    await screen.findByRole('button', { name: 'Review release' })
    h.remove.mockResolvedValueOnce({ ok: false, error: new RemoteError('gateway/internal', 'Unavailable', {}) })
    openDelete()
    fireEvent.click(screen.getByRole('button', { name: en['delete.confirm'] }))
    await act(async () => { await expect(h.onDelete.mock.results[0]!.value).resolves.toBe('failed') })
    // The failure raises no in-place alert: the app-wide toast announces it,
    // and the detail stays open for another attempt.
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByRole('complementary')).toBeDefined()
    expect(taskNames()).toEqual(['Review release'])
    openMore()
    expect(screen.getByRole('menuitem', { name: en['delete.action'] }).hasAttribute('disabled')).toBe(false)
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
    h.list.mockResolvedValueOnce({ ok: true, value: [] })
    chooseDelete()
    fireEvent.click(screen.getByRole('button', { name: en['delete.confirm'] }))
    await act(async () => { await expect(h.onDelete.mock.results[1]!.value).resolves.toBe('deleted') })
    expect(h.remove).toHaveBeenCalledTimes(2)
    // The second attempt is applied, so the detail closes with the removed row.
    expect(screen.queryByRole('complementary')).toBeNull()
    expect(taskNames()).toEqual([])
  })

  it('keeps details after a refresh failure and closes them after a successful retry', async () => {
    const h = remoteCatalog()
    await screen.findByRole('button', { name: 'Review release' })
    h.list.mockResolvedValueOnce({ ok: false, error: new RemoteError('gateway/internal', 'Unavailable', {}) })
    openDelete()
    fireEvent.click(screen.getByRole('button', { name: en['delete.confirm'] }))
    await act(async () => { await expect(h.onDelete.mock.results[0]!.value).resolves.toBe('deleted') })
    expect(screen.getByRole('alert').textContent).toBe(en['list.error'])
    expect(screen.getByRole('complementary')).toBeDefined()
    expect(taskNames()).toEqual(['Review release'])
    // The unread list keeps the last known row, so the rule controls stay until
    // a successful read reports the task gone.
    expect(nameField().value).toBe('Review release')
    h.list.mockResolvedValueOnce({ ok: true, value: [] })
    fireEvent.click(screen.getByRole('button', { name: en['list.retry'] }))
    await screen.findByText(en['list.empty'])
    // The successful read reports the row gone, so the detail closes.
    expect(screen.queryByRole('complementary')).toBeNull()
  })

  it('keeps the detail on its rule when the confirmed deletion reaches no authoritative removal', () => {
    const h = mount({ records: [ended] })
    fireEvent.click(screen.getByRole('button', { name: 'Review release' }))
    chooseDelete()
    fireEvent.click(screen.getByRole('button', { name: en['delete.confirm'] }))
    h.update({ deleting: [ended.id] })
    h.update({ deleting: [] })
    // The attempt ended with the list still reporting the row, so nothing was
    // deleted and the detail stays open on the task.
    expect(screen.getByRole('complementary')).toBeDefined()
    expect(screen.getByRole('heading', { name: 'Review release' })).toBeDefined()
    openMore()
    expect(screen.getByRole('menuitem', { name: en['delete.action'] }).hasAttribute('disabled')).toBe(false)
  })
})

describe('timing pickers', () => {
  it('opens the three clock columns, marks the staged value, and stages one pick', () => {
    const h = mount({ records: [daily] })
    fireEvent.click(screen.getByRole('button', { name: 'Daily weather' }))
    fireEvent.click(timeButton())
    // Three columns of the padded clock range, each with one marked option.
    for (const [key, count] of [
      ['timing.hour', 24], ['timing.minute', 60], ['timing.second', 60],
    ] as const) {
      const column = clockColumn(key)
      expect(within(column).getAllByRole('option')).toHaveLength(count)
      expect(within(column).getAllByRole('option', { selected: true })).toHaveLength(1)
    }
    expect(within(clockColumn('timing.hour')).getByRole('option', { selected: true }).textContent).toBe('23')
    expect(within(clockColumn('timing.minute')).getByRole('option', { selected: true }).textContent).toBe('00')
    expect(within(clockColumn('timing.second')).getByRole('option', { selected: true }).textContent).toBe('00')
    // The staged value is brought into view as the panel opens.
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' })

    fireEvent.click(within(clockColumn('timing.second')).getByRole('option', { name: '30' }))
    // A pick stages the clock, marks it, and keeps the keyboard in the panel.
    expect(timeButton().textContent).toBe('23:00:30')
    expect(within(clockColumn('timing.second')).getByRole('option', { name: '30' })).toBe(document.activeElement)
    expect(saveNotice()?.textContent).toBe(en['rule.unsaved'])
    expect(h.updateTiming).not.toHaveBeenCalled()
  })

  it('keeps the untouched columns when one clock column is picked', () => {
    const h = mount({ records: [daily] })
    fireEvent.click(screen.getByRole('button', { name: 'Daily weather' }))
    fireEvent.click(timeButton())
    fireEvent.click(within(clockColumn('timing.minute')).getByRole('option', { name: '05' }))
    expect(timeButton().textContent).toBe('23:05:00')
    clickSave()
    expect(h.updateTiming).toHaveBeenCalledExactlyOnceWith({
      sessionId: daily.sessionId, id: daily.id, expected: timingSnapshot(daily),
      change: { kind: 'daily', daily: { time: '23:05:00', time_zone: 'Asia/Shanghai' } },
    })
  })

  it('walks one clock column with the arrow keys and stages what Enter selects', () => {
    mount({ records: [daily] })
    fireEvent.click(screen.getByRole('button', { name: 'Daily weather' }))
    fireEvent.click(timeButton())
    const hour = clockColumn('timing.hour')
    // Opening leaves the keyboard on the staged hour: the last one here.
    fireEvent.keyDown(within(hour).getByRole('option', { name: '23' }), { key: 'ArrowDown' })
    expect(document.activeElement).toBe(within(hour).getByRole('option', { name: '23' }))
    fireEvent.keyDown(within(hour).getByRole('option', { name: '23' }), { key: 'ArrowUp' })
    const walked = within(hour).getByRole('option', { name: '22' })
    expect(document.activeElement).toBe(walked)
    fireEvent.keyDown(walked, { key: 'Enter' })
    expect(timeButton().textContent).toBe('22:00:00')
    expect(document.activeElement).toBe(within(hour).getByRole('option', { name: '22' }))
  })

  it('scrolls every clock column to its staged value and walks across columns', () => {
    mount({ records: [daily] })
    fireEvent.click(screen.getByRole('button', { name: 'Daily weather' }))
    fireEvent.click(timeButton())
    // One focusable row per column, on the value that column shows, and every
    // column brings its row into view as the panel opens.
    for (const [key, shown] of [
      ['timing.hour', '23'], ['timing.minute', '00'], ['timing.second', '00'],
    ] as const) {
      const tabbable = within(clockColumn(key)).getAllByRole('option')
        .filter(option => option.getAttribute('tabindex') === '0')
      expect(tabbable).toHaveLength(1)
      expect(tabbable[0]?.textContent).toBe(shown)
    }
    expect(scrolledIntoView.map(element => element.textContent)).toEqual(['23', '00', '00'])

    // Right carries the row into the next column.
    fireEvent.keyDown(within(clockColumn('timing.hour')).getByRole('option', { name: '23' }), { key: 'ArrowRight' })
    expect(document.activeElement).toBe(within(clockColumn('timing.minute')).getByRole('option', { name: '23' }))
    // The minute column's last row clamps into the shorter hour column on the way back.
    fireEvent.keyDown(within(clockColumn('timing.minute')).getByRole('option', { name: '23' }), { key: 'End' })
    const lastMinute = within(clockColumn('timing.minute')).getByRole('option', { name: '59' })
    expect(document.activeElement).toBe(lastMinute)
    fireEvent.keyDown(lastMinute, { key: 'ArrowLeft' })
    const lastHour = within(clockColumn('timing.hour')).getByRole('option', { name: '23' })
    expect(document.activeElement).toBe(lastHour)
    // Home returns to the first row; there is no column left of the hour column.
    fireEvent.keyDown(lastHour, { key: 'Home' })
    const firstHour = within(clockColumn('timing.hour')).getByRole('option', { name: '00' })
    expect(document.activeElement).toBe(firstHour)
    fireEvent.keyDown(firstHour, { key: 'ArrowLeft' })
    expect(document.activeElement).toBe(firstHour)
  })

  it('closes the clock panel with Escape, keeping the detail and returning focus', () => {
    mount({ records: [daily] })
    fireEvent.click(screen.getByRole('button', { name: 'Daily weather' }))
    fireEvent.click(timeButton())
    const option = within(clockColumn('timing.second')).getByRole('option', { name: '00' })
    option.focus()
    fireEvent.keyDown(option, { key: 'Escape' })
    expect(screen.queryByRole('listbox', { name: en['timing.hour'] })).toBeNull()
    expect(screen.getByRole('complementary')).toBeDefined()
    expect(document.activeElement).toBe(timeButton())
  })

  it('dismisses the clock panel when the pointer lands outside it', () => {
    mount({ records: [daily] })
    fireEvent.click(screen.getByRole('button', { name: 'Daily weather' }))
    fireEvent.click(timeButton())
    expect(screen.getByRole('listbox', { name: en['timing.hour'] })).toBeDefined()
    fireEvent.pointerDown(screen.getByRole('heading', { name: en['title'] }))
    expect(screen.queryByRole('listbox', { name: en['timing.hour'] })).toBeNull()
  })

  it('submits a stored minute-precision clock as whole seconds', () => {
    const stored: ScheduleCatalogEntry = { ...daily, time: '10:23' }
    const h = mount({ records: [stored] })
    fireEvent.click(screen.getByRole('button', { name: 'Daily weather' }))
    // A stored clock without seconds still reads as a whole-second row, and the
    // untouched value goes back to the Host at that precision.
    expect(timeButton().textContent).toBe('10:23:00')
    chooseZone('Europe/Berlin')
    clickSave()
    expect(h.updateTiming).toHaveBeenCalledExactlyOnceWith({
      sessionId: stored.sessionId, id: stored.id, expected: timingSnapshot(stored),
      change: { kind: 'daily', daily: { time: '10:23:00', time_zone: 'Europe/Berlin' } },
    })
  })

  it('dismisses the calendar when the pointer lands outside it', () => {
    mount({ records: [at] })
    fireEvent.click(screen.getByRole('button', { name: 'Review release' }))
    fireEvent.click(dateButton())
    expect(screen.getByRole('grid')).toBeDefined()
    fireEvent.pointerDown(screen.getByRole('heading', { name: en['title'] }))
    expect(screen.queryByRole('grid')).toBeNull()
  })

  it('keeps both pickers shut while the rule is read-only', () => {
    const h = mount({ records: [{ ...at, status: 'inactive' }] })
    fireEvent.click(screen.getByRole('button', { name: 'Review release' }))
    expect(dateButton().disabled).toBe(true)
    expect(timeButton().disabled).toBe(true)
    fireEvent.click(timeButton())
    expect(screen.queryByRole('listbox', { name: en['timing.hour'] })).toBeNull()
    fireEvent.click(dateButton())
    expect(screen.queryByRole('grid')).toBeNull()

    // A panel that opened while the rule was editable closes when it stops being so.
    h.update({ records: [at] })
    fireEvent.click(timeButton())
    expect(screen.getByRole('listbox', { name: en['timing.hour'] })).toBeDefined()
    h.update({ records: [{ ...at, status: 'inactive' }] })
    expect(screen.queryByRole('listbox', { name: en['timing.hour'] })).toBeNull()
  })

  it('opens the month grid on the stored day, marks today, and stages a picked day', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-14T12:00:00.000Z'))
    try {
      const h = mount({ records: [at] })
      fireEvent.click(screen.getByRole('button', { name: 'Review release' }))
      fireEvent.click(dateButton())
      const grid = screen.getByRole('grid', { name: 'October 2026' })
      expect(within(grid).getAllByRole('columnheader').map(header => header.textContent))
        .toEqual([en['frequency.weekday.1'], en['frequency.weekday.2'], en['frequency.weekday.3'],
          en['frequency.weekday.4'], en['frequency.weekday.5'], en['frequency.weekday.6'], en['frequency.weekday.7']])
      // The stored day is the selected cell and today carries the date marker.
      expect(within(grid).getByRole('gridcell', { selected: true }).textContent).toBe('1')
      expect(within(grid).getByRole('gridcell', { current: 'date' }).textContent).toBe('14')
      expect(document.activeElement).toBe(dayCell(1))

      fireEvent.click(dayCell(15))
      expect(dateButton().textContent).toBe('2026/10/15')
      expect(saveNotice()?.textContent).toBe(en['rule.unsaved'])
      expect(h.updateTiming).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('moves the grid one month at a time and stages a day in the shown month', () => {
    mount({ records: [at] })
    fireEvent.click(screen.getByRole('button', { name: 'Review release' }))
    fireEvent.click(dateButton())
    fireEvent.click(screen.getByRole('button', { name: en['timing.nextMonth'] }))
    expect(screen.getByRole('grid', { name: 'November 2026' })).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: en['timing.prevMonth'] }))
    expect(screen.getByRole('grid', { name: 'October 2026' })).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: en['timing.nextMonth'] }))
    fireEvent.click(dayCell(2))
    expect(dateButton().textContent).toBe('2026/11/02')
  })

  it('walks the month grid with the arrow keys and stages the day Enter selects', () => {
    mount({ records: [at] })
    fireEvent.click(screen.getByRole('button', { name: 'Review release' }))
    fireEvent.click(dateButton())
    expect(document.activeElement).toBe(dayCell(1))
    // The first day clamps an earlier step; the walk then moves by day and by week.
    fireEvent.keyDown(dayCell(1), { key: 'ArrowLeft' })
    expect(document.activeElement).toBe(dayCell(1))
    fireEvent.keyDown(dayCell(1), { key: 'ArrowRight' })
    expect(document.activeElement).toBe(dayCell(2))
    fireEvent.keyDown(dayCell(2), { key: 'ArrowDown' })
    expect(document.activeElement).toBe(dayCell(9))
    fireEvent.keyDown(dayCell(9), { key: 'ArrowUp' })
    expect(document.activeElement).toBe(dayCell(2))
    fireEvent.keyDown(dayCell(2), { key: 'Enter' })
    expect(dateButton().textContent).toBe('2026/10/02')
  })

  it('closes the calendar with Escape, keeping the detail and returning focus', () => {
    mount({ records: [at] })
    fireEvent.click(screen.getByRole('button', { name: 'Review release' }))
    fireEvent.click(dateButton())
    const cell = dayCell(1)
    cell.focus()
    fireEvent.keyDown(cell, { key: 'Escape' })
    expect(screen.queryByRole('grid')).toBeNull()
    expect(screen.getByRole('complementary')).toBeDefined()
    expect(document.activeElement).toBe(dateButton())
  })

  it.each([en, zh])('names every picker part in %s', (dictionary) => {
    mount({ records: [at] }, dictionary)
    fireEvent.click(screen.getByRole('button', { name: 'Review release' }))
    fireEvent.click(timeButton(dictionary))
    expect(screen.getByRole('dialog', { name: dictionary['timing.time'] })).toBeDefined()
    for (const key of ['timing.hour', 'timing.minute', 'timing.second'] as const) {
      expect(screen.getByRole('listbox', { name: dictionary[key] })).toBeDefined()
    }
    fireEvent.keyDown(within(clockColumn('timing.hour', dictionary)).getByRole('option', { name: '09' }), { key: 'Escape' })
    expect(screen.queryByRole('listbox', { name: dictionary['timing.hour'] })).toBeNull()

    fireEvent.click(dateButton(dictionary))
    expect(screen.getByRole('dialog', { name: dictionary['timing.date'] })).toBeDefined()
    expect(screen.getByRole('button', { name: dictionary['timing.prevMonth'] })).toBeDefined()
    expect(screen.getByRole('button', { name: dictionary['timing.nextMonth'] })).toBeDefined()
  })
})
