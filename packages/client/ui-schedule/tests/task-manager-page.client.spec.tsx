// @vitest-environment jsdom
import { contextMenuHook } from '@deepseek-ai/dsh-client-test-runtime'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { act, cleanup, fireEvent, isInaccessible, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { allowAllAccess, bindSnapshotSelector, makeTranslate, RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type {
  ScheduleDeleteResult, ScheduleId, ScheduleCatalogEntry, ScheduleDeliveryReceipt,
} from '@deepseek-ai/dsh-schedule/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { TaskManagerPage, type TaskManagerPageProps } from '../src/client/TaskManagerPage.tsx'
import { TaskManagerIcon } from '../src/client/TaskManagerIcon.tsx'
import type { HostTaskActions } from '../src/client/TaskDetail.tsx'
import { createCatalogSource, type CatalogDeleteOutcome, type CatalogSnapshot } from '../src/client/catalog-source.ts'
import {
  formatScheduleAbsolute, formatScheduleFrequency, formatScheduleNextRun, formatScheduleRelative, zoneLabel,
} from '../src/client/schedule-format.ts'
import { en, zh } from '../src/client/task-manager-locales.ts'
import css from '../src/client/TaskManagerPage.module.css'
import modalCss from '../../ui-primitives/src/Modal.module.css'
import pluginsCss from '../../ui-plugin-manager/src/client/PluginManagerPage.module.css'
import { pinSystemZone } from './zone-fixture.ts'

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

type Entry = ScheduleCatalogEntry
type Dictionary = typeof en | typeof zh

const alpha = 'session-alpha' as SessionId
const beta = 'session-beta' as SessionId
const gamma = 'session-gamma' as SessionId
const weather = 'session-weather' as SessionId
const stamps = {
  createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
}
const at: Entry = { kind: 'rrule',
  id: 'task-at' as ScheduleId, title: 'Review release', prompt: 'Review release\nCheck risks and <img src=x onerror=alert(1)>',
  rrule: 'DTSTART;TZID=UTC:20261001T090000\nRRULE:FREQ=DAILY;COUNT=1', scheduledAt: '2026-10-01T09:00:00.000Z',
  target: { kind: 'session', sessionId: alpha }, involvedSessionIds: [alpha], status: 'active', ...stamps,
}
const after: Entry = { ...at, id: 'task-after' as ScheduleId, title: 'Send summary', prompt: 'Send summary',
  rrule: 'DTSTART;TZID=UTC:20261001T080000\nRRULE:FREQ=DAILY;COUNT=1', scheduledAt: '2026-10-01T08:00:00.000Z',
  target: { kind: 'new_once', sessionId: beta, create: {} }, involvedSessionIds: [beta],
}
const every: Entry = { ...at, id: 'task-every' as ScheduleId, title: 'Check metrics', prompt: 'Check metrics',
  rrule: 'DTSTART;TZID=UTC:20261001T093000\nRRULE:FREQ=MINUTELY;INTERVAL=5', scheduledAt: '2026-10-01T09:30:00.000Z',
  target: { kind: 'session', sessionId: gamma }, involvedSessionIds: [gamma],
}
const daily: Entry = { ...at, id: 'task-daily' as ScheduleId, title: 'Daily weather', prompt: 'Daily weather',
  rrule: 'DTSTART;TZID=Asia/Shanghai:20261001T230000\nRRULE:FREQ=DAILY', scheduledAt: '2026-10-01T15:00:00.000Z',
  target: { kind: 'session', sessionId: weather }, involvedSessionIds: [weather],
}
const fresh: Entry = { ...at, id: 'task-fresh' as ScheduleId, title: 'Fresh run', prompt: 'Fresh run', scheduledAt: '2026-10-01T10:00:00.000Z',
  rrule: 'DTSTART;TZID=UTC:20261001T100000\nRRULE:FREQ=DAILY;COUNT=1', target: { kind: 'new', create: {} }, involvedSessionIds: [],
}
const paused: Entry = {
  ...every, id: 'task-paused' as ScheduleId, title: 'Paused digest', prompt: 'Paused digest', status: 'paused',
  scheduledAt: '2026-10-01T10:30:00.000Z',
}
const delivery: ScheduleDeliveryReceipt = {
  scheduledAt: at.scheduledAt, deliveredAt: '2026-10-01T09:00:03.000Z', targetSessionId: alpha,
  messageId: 'message-release-delivery' as ScheduleDeliveryReceipt['messageId'],
}
const ended: Entry = { ...at, status: 'ended', lastDelivery: delivery }
const records = [at, every, after]
const sessions: SessionListState = {
  ids: [alpha, beta, gamma, weather],
  byId: Object.fromEntries([alpha, beta, gamma, weather].map(id => [id, {
    id, displayTitle: id, running: false, blank: false, updatedAt: 0, retainedBy: {},
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
      return [id, title === undefined ? summary : { ...summary, title, displayTitle: title }] as const
    })),
  }
}

afterEach(() => {
  try {
    cleanup()
    localStorage.clear()
  } finally {
    vi.restoreAllMocks()
    vi.useRealTimers()
    installedStyles?.remove()
    installedStyles = undefined
  }
})

/** Device zone the cases pin. */
const DEVICE_ZONE = 'Asia/Shanghai'
/** Reference instant for static schedule assertions; timers retain their real scheduling. */
const FIXTURE_NOW = Date.parse('2026-09-18T12:00:00.000Z')
/** Elements whose `scrollIntoView` the open pickers called, in call order. */
const scrolledIntoView: Element[] = []
// jsdom has no `scrollIntoView`, which the open clock panel calls to bring the
// staged value into view.
const scrollIntoView = vi.fn(function (this: Element) { scrolledIntoView.push(this) })
beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(FIXTURE_NOW)
  pinSystemZone(DEVICE_ZONE)
  Element.prototype.scrollIntoView = scrollIntoView
  scrollIntoView.mockClear()
  scrolledIntoView.length = 0
})

function mount(
  initial: Partial<CatalogSnapshot<Entry>> = {},
  dictionary: Dictionary = en,
  overrides: Partial<TaskManagerPageProps> = {},
  options: { startAtAll?: boolean } = {},
) {
  let snapshot: CatalogSnapshot<Entry> = {
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
    ...allowAllAccess,
    useContextMenu: contextMenuHook(),
    onDelete: vi.fn<TaskManagerPageProps['onDelete']>(async () => 'deleted'),
    onRetry: vi.fn(async () => {}),
    onNewTask: vi.fn(),
    onClearEnded: vi.fn(async () => {}),
    onCreateTask: vi.fn<TaskManagerPageProps['onCreateTask']>(async () => ({ created: at })),
    onOpenSession: vi.fn(),
    loadHistory: vi.fn<TaskManagerPageProps['loadHistory']>(async ({ id }) => {
      const receipt = snapshot.records.find(record => record.id === id)?.lastDelivery
      return { ok: true, value: {
        id, records: receipt === undefined ? [] : [receipt], earlierRecordsUnavailable: true,
        earlierRecordsPruned: false, retention: { days: 30, records: 200 },
      } }
    }),
    hostActions: {
      edit: vi.fn<HostTaskActions['edit']>(async () => 'saved'),
      run: vi.fn<HostTaskActions['run']>(async () => 'queued'),
      loadNewSessionInterval: vi.fn<HostTaskActions['loadNewSessionInterval']>(async () => 7200),
    },
    t: makeTranslate(dictionary),
    ...overrides,
  }
  const view = render(<TaskManagerPage {...props} />)
  // The page starts on Active; cases about the full list select All first. The
  // default filter itself is covered by its own case below.
  if (options.startAtAll !== false) {
    fireEvent.click(screen.getByRole('button', { name: dictionary['statusFilter.all'] }))
  }
  return {
    props, view,
    update(next: Partial<CatalogSnapshot<Entry>>) {
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

/** The empty state's action, which opens the manual creation dialog. */
function emptyNewTaskButton(dictionary: Dictionary = en): HTMLElement {
  return within(screen.getByRole('status')).getByRole('button', { name: dictionary['empty.action'] })
}

function detailViewLabels(dictionary: Dictionary) {
  return dictionary === en
    ? {
      tablist: 'Task detail views', rules: 'Rules', records: 'Records',
      empty: 'No delivery record available',
    }
    : {
      tablist: '任务详情视图', rules: '规则', records: '任务运行记录',
      empty: '暂无任务运行记录',
    }
}

function expectDetailView(dictionary: Dictionary, active: 'rules' | 'records'): HTMLElement {
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

/** The next-run `<time>` the detail's next-run line shows, or null for an ended rule. */
function nextRunTime(root: HTMLElement): HTMLTimeElement | null {
  return root.querySelector<HTMLTimeElement>(`.${css.nextRun} time`)
}

/**
 * The absolute next-run text the row and detail state for one instant, in the
 * device zone the cases pin.
 */
function absoluteNextRun(scheduledAt: string, dictionary: Dictionary): string {
  return formatScheduleAbsolute(scheduledAt, dictionary['time.locale'])
}

/** The parenthesized distance the row and detail keep beside that absolute time. */
function relativeNextRun(scheduledAt: string, dictionary: Dictionary): string {
  return `(${remainingUntil(scheduledAt, dictionary)})`
}

/** One element's parenthesized distance, or null when it states none. */
function relativeText(root: HTMLElement): string | null {
  return root.querySelector<HTMLElement>(`.${css.nextRunRelative}`)?.textContent ?? null
}

/**
 * The relative next-run text both the row and the detail render for one instant.
 *
 * Expected durations use the same pinned clock as component renders.
 * @param scheduledAt - stored target instant.
 * @param dictionary - active locale dictionary.
 * @returns the localized time remaining, or overdue text.
 */
function remainingUntil(scheduledAt: string, dictionary: Dictionary): string {
  return formatScheduleRelative(scheduledAt, Date.now(), makeTranslate(dictionary))
}

/** Whether `later` follows `earlier` in document order. */
function follows(earlier: Element, later: Element): boolean {
  return (earlier.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
}

/** The frequency text the list and the detail state for one rule in the pinned device zone. */
function frequencyText(record: Entry, dictionary: Dictionary): string {
  const t = makeTranslate(dictionary)
  return formatScheduleFrequency(record, t, { system: DEVICE_ZONE, label: zone => zoneLabel(zone, t) })
}

/** The occurrence text a saved delivery states, in the UTC zone the fixtures' rules name. */
function deliveryText(scheduledAt: string, dictionary: Dictionary): string {
  return formatScheduleNextRun(scheduledAt, dictionary['time.locale'], 'UTC')
}

/** The detail's read-only instruction text, or undefined when the view shows none. */
function readonlyPrompt(root: HTMLElement): string | null | undefined {
  return root.querySelector<HTMLElement>(`.${css.readonlyPrompt}`)?.textContent
}

/**
 * Assert the vertical structure the mock fixes for Rules: the detail views at
 * the top of the panel, the task name leading the scrolling area, the next-run
 * line directly under it, and the instruction under that.
 */
function expectDetailOrder(detail: HTMLElement, dictionary: Dictionary, name: string): void {
  const tabs = within(detail).getByRole('tablist', { name: detailViewLabels(dictionary).tablist })
  const body = detail.querySelector<HTMLElement>(`.${css.detailScroll}`)!
  const heading = body.querySelector<HTMLElement>(`.${css.detailHeader}`)
  const title = within(body).getByRole('heading', { level: 2 })
  const nextRun = body.querySelector<HTMLElement>(`.${css.nextRun}`)!
  expect(title.textContent).toBe(name)
  expect(follows(tabs, title)).toBe(true)
  // The mock nests `.detail-heading` as the scrolling rule view's first content,
  // so the task name sits inside `.detail-scroll`, not in a bar above it.
  expect(heading).not.toBeNull()
  expect(heading?.parentElement).toBe(body)
  expect(body.firstElementChild).toBe(heading)
  expect(heading?.contains(title)).toBe(true)
  expect(follows(title, nextRun)).toBe(true)
  expect(follows(nextRun, body.querySelector(`.${css.readonlyPrompt}`)!)).toBe(true)
}

/** Open the detail's overflow menu and return it. */
function openMore(dictionary: Dictionary = en): HTMLElement {
  fireEvent.click(screen.getByRole('button', { name: dictionary['detail.more'] }))
  return screen.getByRole('menu')
}

/** Choose the overflow menu's delete row, opening the menu first. */
function chooseDelete(dictionary: Dictionary = en): void {
  fireEvent.click(screen.getByRole('button', { name: dictionary['detail.more'] }))
  fireEvent.click(screen.getByRole('menuitem', { name: dictionary['delete.action'] }))
}

function openDelete(dictionary: Dictionary = en): HTMLElement {
  fireEvent.click(screen.getByRole('button', { name: 'Review release' }))
  chooseDelete(dictionary)
  return screen.getByRole('dialog', { name: dictionary['delete.title'] })
}

/** Open one task's detail and enter its edit form. */
function openEditor(name: string, dictionary: Dictionary = en): void {
  fireEvent.click(screen.getByRole('button', { name }))
  fireEvent.click(screen.getByRole('button', { name: dictionary['host.edit'] }))
}

// The triggers are scoped to the rule card: an open panel carries the row's own
// label and is portaled outside the card.
/** The edit form's start date trigger. */
function dateButton(dictionary: Dictionary = en): HTMLButtonElement {
  return within(screen.getByRole('region', { name: dictionary['rule.title'] }))
    .getByRole<HTMLButtonElement>('button', { name: dictionary['timing.date'] })
}

/** The edit form's clock trigger. */
function timeButton(dictionary: Dictionary = en): HTMLButtonElement {
  return within(screen.getByRole('region', { name: dictionary['rule.title'] }))
    .getByRole<HTMLButtonElement>('button', { name: dictionary['timing.time'] })
}

/** One column of the open clock panel. */
function clockColumn(key: 'timing.hour' | 'timing.minute' | 'timing.second', dictionary: Dictionary = en): HTMLElement {
  return screen.getByRole('listbox', { name: dictionary[key] })
}

/** The open calendar's cell for one day of the shown month. */
function dayCell(day: number): HTMLElement {
  return screen.getAllByRole('gridcell', { name: String(day) })[0]!
}

/** Click the edit bar's Save action. */
function clickSave(dictionary: Dictionary = en): void {
  fireEvent.click(screen.getByRole('button', { name: dictionary['rule.save'] }))
}

function remoteCatalog() {
  const list = vi.fn<() => Promise<RemoteResult<Entry[]>>>()
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
    ['Session list pending', { ...sessions, phase: 'pending' as const }, workspaces, 'Loading linked session information.', '正在加载关联会话信息'],
    ['Workspace list pending', sessions, { ...workspaces, phase: 'pending' as const }, 'Loading linked session information.', '正在加载关联会话信息'],
    ['archived', sessions, { ...workspaces, archivedSessionIds: [alpha] }, 'The linked session is archived.', '关联会话已归档'],
    ['missing', { ...sessions, ids: [], byId: {} }, workspaces, 'The linked session is unavailable.', '关联会话当前不可用'],
    ['archive read failed', sessions, { ...workspaces, state: 'error' as const, error: new RemoteError('gateway/internal', 'Archive unavailable', {}) }, 'The linked session is unavailable.', '关联会话当前不可用'],
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
    expect(within(link).getByText(alpha)).toBeDefined()
    openMore(dictionary)
    expect(screen.getByRole('menuitem', { name: dictionary['delete.action'] }).hasAttribute('disabled')).toBe(false)
  })

  it('states that a reused conversation starts with the first run until that Session exists', () => {
    mount({ records: [after] }, dictionary, { useSessions: select => select({ ...sessions, ids: [], byId: {} }) })
    fireEvent.click(screen.getByRole('button', { name: 'Send summary' }))
    const detail = screen.getByRole('complementary', { name: dictionary['detail.label'] })
    const footer = detail.querySelector('footer')!
    expect(footer.textContent).toBe(`${dictionary['detail.session']}${dictionary['host.sessionAfterFirstRun']}`)
    expect(within(footer).queryByRole('button')).toBeNull()
    expect(within(detail).queryByRole('status')).toBeNull()
  })

  it('opens the reused conversation once that Session exists', () => {
    const { props } = mount({ records: [after] }, dictionary)
    fireEvent.click(screen.getByRole('button', { name: 'Send summary' }))
    fireEvent.click(screen.getByRole('button', { name: dictionary['detail.openSession'] }))
    expect(props.onOpenSession).toHaveBeenCalledExactlyOnceWith(beta)
  })
})

describe.each([['English', en], ['Chinese', zh]] as const)('linked-Session control naming in %s', (_name, dictionary) => {
  it('names the control by the catalog title after the visible Linked session label', () => {
    mount({ records: [ended] }, dictionary, {
      useSessions: select => select(sessionsWithTitles({ [alpha]: 'Planning chat' })),
    })
    fireEvent.click(screen.getByRole('button', { name: 'Review release' }))
    const link = screen.getByRole('button', {
      name: dictionary['detail.openSessionTitle'].replace('{title}', 'Planning chat'),
    })
    const label = within(link.closest('footer')!).getByText(dictionary['detail.session'])
    expect(follows(label, link)).toBe(true)
    expect(link.textContent).toContain('Planning chat')
    expect(link.getAttribute('aria-label')).toContain(dictionary['detail.session'])
  })

  it('names the control by the visible Linked session label without a catalog title', () => {
    mount({ records: [ended] }, dictionary)
    fireEvent.click(screen.getByRole('button', { name: 'Review release' }))
    const link = screen.getByRole('button', { name: dictionary['detail.openSession'] })
    expect(within(link.closest('footer')!).getByText(dictionary['detail.session'])).toBeDefined()
    expect(link.textContent).toContain(alpha)
    expect(link.getAttribute('aria-label')).toContain(dictionary['detail.session'])
  })
})

it('updates original Session navigation as metadata arrives and archive state changes', () => {
  let state: WorkspaceSnapshot = { ...workspaces, phase: 'pending' }
  const mounted = mount({ records: [ended] }, en, { useWorkspaces: select => select(state) })
  fireEvent.click(screen.getByRole('button', { name: 'Review release' }))
  const link = () => screen.getByRole('button', { name: en['detail.openSession'] })
  expect(link().hasAttribute('disabled')).toBe(true)
  state = { ...workspaces, archivedSessionIds: [alpha] }
  mounted.update({})
  expect(screen.getByText(en['detail.sessionArchived'])).toBeDefined()
  state = workspaces
  mounted.update({})
  expect(link().hasAttribute('disabled')).toBe(false)
  expect(screen.queryByText(en['detail.sessionArchived'])).toBeNull()
  fireEvent.click(link())
  expect(mounted.props.onOpenSession).toHaveBeenCalledWith(alpha)
  openMore()
  expect(screen.getByRole('menuitem', { name: en['delete.action'] })).toBeDefined()
})

describe('Task manager catalog', () => {
  it('starts a new Session from the heading and offers manual creation from its method menu', () => {
    const h = mount({ records: [at] })
    // The heading's compact action and the empty state's named action are the
    // mock's two creation entries; only the heading's shows while a row exists.
    const group = screen.getByRole('group', { name: en['host.create'] })
    fireEvent.click(within(group).getByRole('button', { name: en['new.action'] }))
    expect(h.props.onNewTask).toHaveBeenCalledOnce()
    expect(screen.queryByRole('button', { name: en['empty.action'] })).toBeNull()
    const method = within(group).getByRole('button', { name: en['host.createMethod'] })
    expect(method.getAttribute('aria-haspopup')).toBe('menu')
    fireEvent.click(method)
    expect(method.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual([en['host.chatCreate'], en['host.manualCreate']])
    fireEvent.click(screen.getByRole('menuitem', { name: en['host.chatCreate'] }))
    expect(h.props.onNewTask).toHaveBeenCalledTimes(2)
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(method)
    fireEvent.click(screen.getByRole('menuitem', { name: en['host.manualCreate'] }))
    const dialog = screen.getByRole('dialog', { name: en['host.manualCreate'] })
    expect(h.props.onNewTask).toHaveBeenCalledTimes(2)
    fireEvent.click(within(dialog).getByRole('button', { name: en['host.closeCreate'] }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(h.props.onCreateTask).not.toHaveBeenCalled()
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
    expect(within(statuses).getAllByRole('button')[0]?.textContent).toBe(en['status.active'])
    // The mock's `.searchbox`: the same field carries the leading glyph, the
    // placeholder, and — once a value exists — the inline clear control.
    const searchTools = page.querySelector<HTMLElement>(`.${css.searchTools!}`)!
    expect(searchTools.contains(page.querySelector(`.${css.searchField!}`))).toBe(true)
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
    expect(screen.queryByText(alpha)).toBeNull()
    expect(screen.queryByText(beta)).toBeNull()
    expect(screen.queryByText(gamma)).toBeNull()
    expect(screen.getAllByText('Once')).toHaveLength(2)
    expect(screen.getByText('Every 5 minutes')).toBeDefined()
    expect(screen.queryByRole('button', { name: /new task|resume|edit|run now|history/i })).toBeNull()
    expect(screen.queryByRole('complementary')).toBeNull()
    fireEvent.keyDown(screen.getByRole('searchbox'), { key: 'Escape' })
    expect(taskNames()).toHaveLength(3)
  })

  it('names every list row and the selected detail from the stored title', () => {
    const named = { ...at, title: 'Release review' }
    mount({ records: [named, after] })
    expect(taskNames()).toEqual(['Send summary', 'Release review'])
    fireEvent.click(screen.getByRole('button', { name: 'Release review' }))
    const detail = screen.getByRole('complementary')
    // The detail names the task in its own heading, not through the list row's label.
    expect(within(detail).getByRole('heading', { level: 2 }).textContent).toBe('Release review')
    // The read-only view still shows the complete stored instruction.
    expect(readonlyPrompt(detail)).toBe(named.prompt)
  })

  it('uses shared exact frequency units in the list and selected detail', () => {
    const hourly = { ...every, rrule: 'DTSTART;TZID=UTC:20261001T093000\nRRULE:FREQ=HOURLY;INTERVAL=1' }
    const h = mount({ records: [hourly] })
    expect(screen.getByText('Every 1 hour')).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: 'Check metrics' }))
    expect(within(screen.getByRole('complementary')).getByText('Every 1 hour')).toBeDefined()
    h.view.rerender(<TaskManagerPage {...h.props} t={makeTranslate(zh)} />)
    expect(within(screen.getByRole('complementary')).getByText('每 1 小时')).toBeDefined()
  })

  it('describes row frequency and next time without exposing its Session', () => {
    const h = mount({ records: [every] })
    const row = screen.getByRole('button', {
      name: 'Check metrics', description: /^Every 5 minutes.*Next scheduled time:/,
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
    expect(metadata.textContent).not.toContain(gamma)
    // Rows carry no Enabled word: every listed task is running unless the line
    // says otherwise, so only the paused and ended states are named.
    expect(metadata.textContent).not.toContain(en['status.active'])
    row.focus()
    expect(document.activeElement).toBe(row)
    h.view.rerender(<TaskManagerPage {...h.props} t={makeTranslate(zh)} />)
    expect(screen.getByRole('button', {
      name: 'Check metrics', description: /^每 5 分钟.*下次计划时间：/,
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
      const soon: Entry = {
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
    // and en reads `in 2 hours`, and neither renders a clock time for it.
    const soon: Entry = {
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
    mount({ records: [...records, fresh] })
    const input = screen.getByRole('searchbox', { name: en['search.label'] })
    fireEvent.change(input, { target: { value: '  RISKS  ' } })
    expect(taskNames()).toEqual(['Review release'])
    fireEvent.change(input, { target: { value: 'SESSION-GAMMA' } })
    expect(taskNames()).toEqual(['Check metrics'])
    // A task that opens a new conversation for each run has no Session to match
    // until its first delivery, so only its own text selects it.
    fireEvent.change(input, { target: { value: 'session-' } })
    expect(taskNames()).toEqual(['Send summary', 'Review release', 'Check metrics'])
    fireEvent.change(input, { target: { value: 'FRESH' } })
    expect(taskNames()).toEqual(['Fresh run'])
    fireEvent.click(screen.getByRole('button', { name: en['search.clear'] }))
    expect((input as HTMLInputElement).value).toBe('')
    expect(taskNames()).toHaveLength(4)
    expect(screen.queryByRole('button', { name: en['search.clear'] })).toBeNull()
  })

  it('matches the stored task name and instruction without exposing the Session label', () => {
    const renamed: Entry = { ...at, title: 'Quarterly report', prompt: 'Send the numbers' }
    mount({ records: [renamed, every] }, en, {
      useSessions: select => select(sessionsWithTitles({ [alpha]: 'Planning chat' })),
    })
    const input = screen.getByRole('searchbox', { name: en['search.label'] })
    fireEvent.change(input, { target: { value: 'quarterly' } })
    expect(taskNames()).toEqual(['Quarterly report'])
    fireEvent.change(input, { target: { value: 'planning' } })
    expect(taskNames()).toEqual([])
    fireEvent.change(input, { target: { value: 'numbers' } })
    expect(taskNames()).toEqual(['Quarterly report'])
  })

  it('combines search with the status filter and keeps both behind the empty state action', () => {
    const h = mount()
    const statuses = screen.getByRole('group', { name: en['statusFilter.label'] })
    const chooseStatus = (name: string) => fireEvent.click(within(statuses).getByRole('button', { name }))
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'release' } })
    expect(taskNames()).toEqual(['Review release'])
    chooseStatus(en['status.ended'])
    expect(taskNames()).toEqual([])
    expect(screen.getByRole('status').textContent).toContain(en['list.noMatches'])
    expect(screen.queryByText(en['list.empty'])).toBeNull()
    // The empty state's action opens manual creation instead of resetting the
    // filters the reader chose; closing the form leaves both in place.
    fireEvent.click(emptyNewTaskButton())
    const dialog = screen.getByRole('dialog', { name: en['host.manualCreate'] })
    expect(h.props.onNewTask).not.toHaveBeenCalled()
    fireEvent.click(within(dialog).getByRole('button', { name: en['host.closeCreate'] }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(taskNames()).toEqual([])
    expect(screen.getByRole<HTMLInputElement>('searchbox').value).toBe('release')
    expect(within(statuses).getByRole('button', { name: en['status.ended'] }).getAttribute('aria-pressed')).toBe('true')
    // The status filter is the one excluding every row the search selects.
    chooseStatus(en['statusFilter.all'])
    expect(taskNames()).toEqual(['Review release'])
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: '' } })
    expect(taskNames()).toEqual(['Send summary', 'Review release', 'Check metrics'])
  })

  it.each([en, zh])('starts on the active status filter', (dictionary) => {
    mount({ records: [ended, every, after] }, dictionary, {}, { startAtAll: false })
    const list = screen.getByRole('list', { name: dictionary['list.label'] })
    const names = within(list).queryAllByRole('button')
      .filter(button => button.closest('li') !== null)
      .map(button => button.getAttribute('aria-label'))
    const statuses = screen.getByRole('group', { name: dictionary['statusFilter.label'] })
    expect(within(statuses).getByRole('button', { name: dictionary['status.active'] }).getAttribute('aria-pressed')).toBe('true')
    expect(within(statuses).getByRole('button', { name: dictionary['statusFilter.all'] }).getAttribute('aria-pressed')).toBe('false')
    expect(names).toEqual(['Send summary', 'Check metrics'])
  })

  it.each([en, zh])('combines all, enabled, paused, and ended status filters with search', (dictionary) => {
    mount({ records: [ended, every, after, paused] }, dictionary)
    const list = screen.getByRole('list', { name: dictionary['list.label'] })
    const names = () => within(list).queryAllByRole('button')
      .filter(button => button.closest('li') !== null)
      .map(button => button.getAttribute('aria-label'))
    const statuses = screen.getByRole('group', { name: dictionary['statusFilter.label'] })
    const chooseStatus = (name: string) => fireEvent.click(within(statuses).getByRole('button', { name }))
    expect(names()).toEqual(['Send summary', 'Review release', 'Check metrics', 'Paused digest'])
    expect(within(statuses).getByRole('button', { name: dictionary['statusFilter.all'] }).getAttribute('aria-pressed')).toBe('true')
    // A paused row names its state in place of the next scheduled time.
    const pausedSummary = within(list).getByRole('button', { name: 'Paused digest' }).querySelector(`.${css.rowSummary!}`)!
    expect(pausedSummary.textContent).toContain(dictionary['status.paused'])
    expect(pausedSummary.textContent).not.toContain(dictionary['list.nextPrefix'])
    chooseStatus(dictionary['status.active'])
    expect(names()).toEqual(['Send summary', 'Check metrics'])
    chooseStatus(dictionary['status.paused'])
    expect(names()).toEqual(['Paused digest'])
    chooseStatus(dictionary['status.ended'])
    expect(names()).toEqual(['Review release'])
    expect(within(statuses).getByRole('button', { name: dictionary['status.ended'] }).getAttribute('aria-pressed')).toBe('true')
    chooseStatus(dictionary['statusFilter.all'])
    expect(names()).toHaveLength(4)
    chooseStatus(dictionary['status.ended'])
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'SESSION-ALPHA' } })
    expect(names()).toEqual(['Review release'])
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'nothing matches' } })
    expect(names()).toEqual([])
    expect(screen.getByRole('status').textContent).toContain(dictionary['list.noMatches'])
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: '' } })
    expect(names()).toEqual(['Review release'])
    chooseStatus(dictionary['statusFilter.all'])
    expect(names()).toHaveLength(4)
    expect(screen.getByRole<HTMLInputElement>('searchbox').value).toBe('')
    expect(within(statuses).getByRole('button', { name: dictionary['statusFilter.all'] }).getAttribute('aria-pressed')).toBe('true')
  })

  it.each([
    { dictionary: en, frequency: 'Daily at 23:00' },
    { dictionary: zh, frequency: '每天 23:00' },
  ])('classifies daily wall-clock rules as repeating and omits the device zone: $frequency', ({ dictionary, frequency }) => {
    mount({ records: [...records, daily] }, dictionary)
    const list = screen.getByRole('list', { name: dictionary['list.label'] })
    const dailyRow = within(list).getByRole('button', { name: daily.title })
    expect(dailyRow.textContent).toContain(frequency)
    fireEvent.click(dailyRow)
    const detail = screen.getByRole('complementary', { name: dictionary['detail.label'] })
    expect(within(detail).getByText(frequency, { exact: true })).toBeDefined()
    expect(within(detail).queryByText(dictionary['frequency.once'], { exact: true })).toBeNull()
  })

  it.each([
    ['paused', records, 'list.emptyPaused'],
    ['ended', records, 'list.emptyInactive'],
    ['active', [paused], 'list.emptyActive'],
  ] as const)('clears a status-only exclusion from its own filter group: %s', (status, rows, title) => {
    mount({ records: rows })
    const statuses = screen.getByRole('group', { name: en['statusFilter.label'] })
    fireEvent.click(within(statuses).getByRole('button', { name: en[`status.${status}`] }))
    expect(taskNames()).toEqual([])
    const empty = screen.getByRole('status')
    expect(empty.textContent).toContain(en[title])
    expect(empty.textContent).not.toContain(en['list.noMatches'])
    fireEvent.click(within(statuses).getByRole('button', { name: en['statusFilter.all'] }))
    expect(taskNames()).toHaveLength(rows.length)
    expect(within(statuses).getByRole('button', { name: en['statusFilter.all'] }).getAttribute('aria-pressed')).toBe('true')
  })

  it('renders a decorative document-and-clock illustration in an empty catalog', () => {
    mount({ records: [], status: 'ready' })
    const illustration = screen.getByRole('status').querySelector('svg')
    expect(illustration?.getAttribute('aria-hidden')).toBe('true')
    expect(illustration?.getAttribute('focusable')).toBe('false')
    expect(illustration?.getAttribute('viewBox')).toBe('0 0 170 170')
    const paths = illustration?.querySelectorAll('path')
    expect(paths).toHaveLength(20)
    // Roles follow the approved artwork's paint order, including overlapping paper and clock layers.
    expect(paths?.[0]?.getAttribute('fill')).toBe('var(--dsw-alias-illustration-background)')
    expect(paths?.[2]?.getAttribute('fill')).toBe('var(--dsw-alias-illustration-backing)')
    expect(paths?.[3]?.getAttribute('fill')).toBe('var(--dsw-alias-illustration-surface)')
    expect(paths?.[10]?.getAttribute('fill')).toBe('var(--dsw-alias-illustration-shadow)')
    expect(paths?.[17]?.getAttribute('fill')).toBe('var(--dsw-alias-illustration-detail)')
    expect(paths?.[18]?.getAttribute('fill')).toBe('var(--dsw-alias-illustration-inset)')
    expect(emptyNewTaskButton().textContent).toBe(en['empty.action'])
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
    expect(screen.getByRole('status').textContent).toContain(en['list.noMatches'])
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

describe('clearing inactive tasks', () => {
  // A distinct identity: the module's `ended` case reuses the active row's id.
  const endedTask: ScheduleCatalogEntry = {
    ...ended, id: 'task-ended' as ScheduleId, title: 'Ended summary', prompt: 'Ended summary',
  }
  const anotherEnded: ScheduleCatalogEntry = {
    ...ended, id: 'task-ended-two' as ScheduleId, title: 'Ended report', prompt: 'Ended report',
  }

  /** The heading's actions; only the primary New control remains there. */
  function creationActions(): HTMLElement {
    return document.querySelector<HTMLElement>(`.${css.creationActions!}`)!
  }

  /** The search row's 36px More trigger. */
  function moreTrigger(dictionary: typeof en | typeof zh = en): HTMLElement {
    return screen.getByRole('button', { name: dictionary['list.more'] })
  }

  /**
   * Open the cleanup confirmation through the More menu.
   * @param dictionary - locale under test.
   * @param count - ended rows the page's complete catalog holds.
   * @returns the confirmation dialog.
   */
  function openClear(dictionary: typeof en | typeof zh = en, count = 1): HTMLElement {
    fireEvent.click(moreTrigger(dictionary))
    fireEvent.click(screen.getByRole('menuitem', { name: dictionary['clear.action'] }))
    return screen.getByRole('dialog', {
      name: dictionary['clear.title'].replace('{count}', String(count)),
    })
  }

  it('offers the cleanup in the search row only while an ended task is visible', () => {
    const h = mount()
    expect(creationActions().textContent).toBe(en['new.action'])
    expect(screen.queryByRole('button', { name: en['list.more'] })).toBeNull()
    h.update({ records: [...records, endedTask] })
    // The cleanup is the search row's More menu, not a second heading action.
    expect(document.querySelector(`.${css.searchTools!}`)?.contains(moreTrigger())).toBe(true)
    expect(within(creationActions()).getAllByRole('button')).toHaveLength(2)
    // The Active view hides the cleanup even though the catalog holds ended rows.
    fireEvent.click(screen.getByRole('button', { name: en['status.active'] }))
    expect(screen.queryByRole('button', { name: en['list.more'] })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en['statusFilter.all'] }))
    expect(moreTrigger()).toBeDefined()
  })

  it('states the complete ended set in the confirmation, not the filtered rows', () => {
    mount({ records: [...records, endedTask, anotherEnded] })
    fireEvent.change(screen.getByRole('searchbox', { name: en['search.label'] }), {
      target: { value: 'Send summary' },
    })
    expect(taskNames()).toEqual(['Send summary'])
    const dialog = openClear(en, 2)
    expect(within(dialog).getByText(en['clear.description'])).toBeDefined()
  })

  it('closes the cleanup menu without opening the confirmation', () => {
    mount({ records: [at, endedTask] })
    fireEvent.click(moreTrigger())
    expect(screen.getByRole('menuitem', { name: en['clear.action'] })).toBeDefined()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('menuitem', { name: en['clear.action'] })).toBeNull()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('removes nothing when the confirmation is dismissed', () => {
    const h = mount({ records: [at, endedTask] })
    openClear()
    fireEvent.click(screen.getByRole('button', { name: en['delete.cancel'] }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(h.props.onClearEnded).not.toHaveBeenCalled()
  })

  it('keeps the confirmation open until the settled removal, then returns focus', async () => {
    const pending = Promise.withResolvers<undefined>()
    const onClearEnded = vi.fn(() => pending.promise)
    mount({ records: [at, endedTask] }, en, { onClearEnded })
    const trigger = moreTrigger()
    trigger.focus()
    const dialog = openClear()
    const confirm = within(dialog).getByRole('button', { name: en['clear.confirm'] })
    confirm.focus()
    fireEvent.click(confirm)
    expect(onClearEnded).toHaveBeenCalledOnce()

    const running = screen.getByRole('dialog')
    const runningButton = within(running).getByRole('button', { name: en['clear.pending'] })
    // The pressed control keeps the focus and reads as busy; disabling it would
    // hand focus to the document body mid-removal.
    expect(runningButton.getAttribute('aria-disabled')).toBe('true')
    expect(document.activeElement).toBe(runningButton)
    expect(within(running).getByRole('button', { name: en['delete.cancel'] }).hasAttribute('disabled')).toBe(true)
    // A second press while the removal runs must not start another request.
    fireEvent.click(runningButton)
    expect(onClearEnded).toHaveBeenCalledOnce()
    // The confirmation is the only place that states the removal still runs, so
    // the Escape that would close it waits for the outcome.
    fireEvent.keyDown(running, { key: 'Escape' })
    expect(screen.getByRole('dialog')).toBe(running)

    await act(async () => { pending.resolve(undefined) })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it('falls back to the page heading when the settled cleanup hides its trigger', async () => {
    const pending = Promise.withResolvers<undefined>()
    const onClearEnded = vi.fn(() => pending.promise)
    const h = mount({ records: [at, endedTask] }, en, { onClearEnded })
    const trigger = moreTrigger()
    trigger.focus()
    const dialog = openClear()
    fireEvent.click(within(dialog).getByRole('button', { name: en['clear.confirm'] }))
    // The acknowledged removal's readback drops the ended rows, and with them the
    // trigger the Modal captured when it opened.
    act(() => { h.update({ records: [at] }) })
    expect(screen.queryByRole('button', { name: en['list.more'] })).toBeNull()
    await act(async () => { pending.resolve(undefined) })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1 }))
  })

  it('keeps focus in the confirmation when the selected task disappears behind it', () => {
    const h = mount({ records: [at, endedTask] })
    fireEvent.click(screen.getByRole('button', { name: 'Ended summary' }))
    expect(screen.getByRole('complementary', { name: en['detail.label'] })).toBeDefined()
    const dialog = openClear()
    // A refresh drops the selected task while the confirmation is open; closing
    // the detail must not take the focus out of the dialog.
    act(() => { h.update({ records: [at] }) })
    expect(screen.queryByRole('complementary', { name: en['detail.label'] })).toBeNull()
    expect(dialog.contains(document.activeElement)).toBe(true)
    fireEvent.keyDown(dialog, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    // The row that held the focus is gone with the detail, so the heading takes it.
    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1 }))
  })

  it('falls back to the page heading when another cleanup removes the trigger', () => {
    const h = mount({ records: [at, endedTask] })
    const trigger = moreTrigger()
    trigger.focus()
    const dialog = openClear()
    // Another client's cleanup removes the ended rows while this confirmation
    // is open, so the control the Modal captured is unmounted too.
    act(() => { h.update({ records: [at] }) })
    expect(screen.queryByRole('button', { name: en['list.more'] })).toBeNull()
    fireEvent.keyDown(dialog, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1 }))
  })

  it('focuses the rebuilt trigger when the dialog closes', () => {
    const h = mount({ records: [at, endedTask] })
    const dialog = openClear()
    // Another client clears the ended rows, then a delivery ends one more while
    // the confirmation stays open: the trigger unmounts and a new one mounts.
    act(() => { h.update({ records: [at] }) })
    act(() => { h.update({ records: [at, anotherEnded] }) })
    const rebuilt = moreTrigger()
    fireEvent.keyDown(dialog, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(rebuilt)
  })

  it('moves focus to the heading when a late readback removes the trigger', async () => {
    const pending = Promise.withResolvers<undefined>()
    const onClearEnded = vi.fn(() => pending.promise)
    const h = mount({ records: [at, endedTask] }, en, { onClearEnded })
    const trigger = moreTrigger()
    trigger.focus()
    const dialog = openClear()
    fireEvent.click(within(dialog).getByRole('button', { name: en['clear.confirm'] }))
    // The removal settles while the catalog still lists the ended row: the
    // dialog closes and focus returns to the trigger.
    await act(async () => { pending.resolve(undefined) })
    expect(document.activeElement).toBe(trigger)
    // A readback superseded by `schedule/changed` publishes afterwards and takes
    // the trigger with its row; focus must not stay on the document body.
    act(() => { h.update({ records: [at] }) })
    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1 }))
  })

  it('closes only the confirmation on Escape while a task detail is open', () => {
    mount({ records: [at, endedTask] })
    fireEvent.click(screen.getByRole('button', { name: 'Review release' }))
    const detail = screen.getByRole('complementary', { name: en['detail.label'] })
    const dialog = openClear()
    fireEvent.keyDown(dialog, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByRole('complementary', { name: en['detail.label'] })).toBe(detail)
  })

  it('states the cleanup and its confirmation in Chinese', () => {
    mount({ records: [at, endedTask] }, zh)
    const dialog = openClear(zh, 1)
    expect(within(dialog).getByText(zh['clear.description'])).toBeDefined()
    expect(within(dialog).getByRole('button', { name: zh['clear.confirm'] })).toBeDefined()
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
    expect(readonlyPrompt(rules)).toBe(at.prompt)
    // One compact next-run line leads the scrolling area under the task name.
    expect(nextRunTime(detail)?.dateTime).toBe(at.scheduledAt)
    expect(nextRunTime(detail)?.textContent).toBe(absoluteNextRun(at.scheduledAt, dictionary))
    expect(relativeText(detail)).toBe(relativeNextRun(at.scheduledAt, dictionary))
    // The rule card names the recurrence and the conversation each run uses;
    // the status and the task ID stay out of the detail.
    const card = rules.querySelector<HTMLElement>(`.${css.ruleCard}`)!
    const ruleTexts = [dictionary['rule.repeat'], dictionary['frequency.once'], dictionary['host.target'], dictionary['host.currentConversation']]
    for (const text of ruleTexts) {
      expect(visibleText(card, text)).toHaveLength(1)
    }
    expect(visibleText(detail, dictionary['status.active'])).toHaveLength(0)
    expect(visibleText(detail, at.id)).toHaveLength(0)
    const menu = openMore(dictionary)
    expect(within(menu).getAllByRole('menuitem').map(item => item.textContent))
      .toEqual([dictionary['host.run'], dictionary['delete.action']])
    fireEvent.keyDown(menu, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(within(detail).queryByRole('region', { name: dictionary['delivery.label'] })).toBeNull()
    expect(visibleText(detail, delivery.messageId)).toHaveLength(0)
    // The linked-Session footer closes the detail outside the scroll region.
    const footer = (): HTMLElement => detail.querySelector('footer')!
    const link = within(footer()).getByRole('button', { name: dictionary['detail.openSession'] })
    expect(rules.contains(footer())).toBe(false)
    expect(isInaccessible(link)).toBe(false)
    fireEvent.click(link)
    expect(h.props.onOpenSession).toHaveBeenCalledExactlyOnceWith(alpha)

    fireEvent.click(within(detail).getByRole('tab', { name: labels.records }))
    const recordPanel = expectDetailView(dictionary, 'records')
    const receipt = await within(recordPanel).findByRole('region', { name: dictionary['delivery.label'] })
    expect(h.props.loadHistory).toHaveBeenCalledExactlyOnceWith({ id: at.id, limit: 20 })
    expect(within(recordPanel).getAllByRole('region', { name: dictionary['delivery.label'] })).toHaveLength(1)
    expect(receipt.querySelector<HTMLTimeElement>(`.${css.deliveryTime}`)?.dateTime).toBe(delivery.scheduledAt)
    expect(receipt.querySelector('details')).toBeNull()
    // The saved delivery opens the Session that accepted it.
    expect(within(receipt).getAllByRole('button').map(button => button.textContent)).toEqual([alpha])
    expect(visibleText(recordPanel, labels.empty)).toHaveLength(0)
    for (const text of [dictionary['rule.repeat'], dictionary['host.target'], at.id]) {
      expect(visibleText(detail, text)).toHaveLength(0)
    }
    // Records replaces the task name, the next-run line, and the instruction.
    expect(visibleText(detail, dictionary['detail.nextRun'])).toHaveLength(0)
    expect(detail.querySelector(`.${css.readonlyName}`)).toBeNull()
    expect(detail.querySelector(`.${css.nextRun}`)).toBeNull()
    expect(readonlyPrompt(detail)).toBeUndefined()
    expect(recordPanel.textContent).not.toContain(at.prompt)
    expect(recordPanel.querySelectorAll('time')).toHaveLength(1)
    // The linked-Session footer stays under both views.
    expect(recordPanel.contains(footer())).toBe(false)
    expect(within(footer()).getByRole('button', { name: dictionary['detail.openSession'] })).toBeDefined()

    fireEvent.click(within(detail).getByRole('tab', { name: labels.rules }))
    expectDetailView(dictionary, 'rules')
    expect(within(detail).queryByRole('region', { name: dictionary['delivery.label'] })).toBeNull()
    expect(visibleText(detail, delivery.messageId)).toHaveLength(0)
    expect(readonlyPrompt(detail)).toBe(at.prompt)
  })

  it('drops the task name and next-run line on Records and restores them on Rules', async () => {
    const labels = detailViewLabels(dictionary)
    mount({ records: [{ ...at, lastDelivery: delivery }] }, dictionary)
    fireEvent.click(screen.getByRole('button', { name: 'Review release' }))
    const detail = screen.getByRole('complementary', { name: dictionary['detail.label'] })
    const name = (): string | null | undefined => detail.querySelector<HTMLElement>(`.${css.readonlyName}`)?.textContent
    expect(name()).toBe('Review release')
    expect(nextRunTime(detail)?.dateTime).toBe(at.scheduledAt)
    fireEvent.click(within(detail).getByRole('tab', { name: labels.records }))
    const panel = expectDetailView(dictionary, 'records')
    await within(panel).findByRole('region', { name: dictionary['delivery.label'] })
    expect(name()).toBeUndefined()
    expect(detail.querySelector(`.${css.nextRun}`)).toBeNull()
    expect(visibleText(detail, dictionary['detail.nextRun'])).toHaveLength(0)
    fireEvent.click(within(detail).getByRole('tab', { name: labels.rules }))
    expectDetailView(dictionary, 'rules')
    expect(name()).toBe('Review release')
    expect(nextRunTime(detail)?.dateTime).toBe(at.scheduledAt)
  })

  it.each(['active', 'ended'] as const)('shows the no-record message for a successful empty history of an %s task', async (status) => {
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

  it('resets to Rules when selecting another task or reopening closed details', () => {
    const labels = detailViewLabels(dictionary)
    mount({ records: [ended, every] }, dictionary)
    fireEvent.click(screen.getByRole('button', { name: 'Review release' }))
    fireEvent.click(screen.getByRole('tab', { name: labels.records }))
    expectDetailView(dictionary, 'records')
    fireEvent.click(screen.getByRole('button', { name: 'Check metrics' }))
    expect(readonlyPrompt(expectDetailView(dictionary, 'rules'))).toBe(every.prompt)
    fireEvent.click(screen.getByRole('tab', { name: labels.records }))
    fireEvent.click(screen.getByRole('button', { name: 'Review release' }))
    expect(readonlyPrompt(expectDetailView(dictionary, 'rules'))).toBe(at.prompt)
    for (const close of ['button', 'Escape'] as const) {
      fireEvent.click(screen.getByRole('tab', { name: labels.records }))
      if (close === 'button') fireEvent.click(screen.getByRole('button', { name: dictionary['detail.close'] }))
      else fireEvent.keyDown(screen.getByRole('tab', { name: labels.records }), { key: 'Escape' })
      expect(screen.queryByRole('complementary')).toBeNull()
      fireEvent.click(screen.getByRole('button', { name: 'Review release' }))
      expectDetailView(dictionary, 'rules')
    }
  })

  it('keeps the unavailable original Session in the footer and deletion available in Records', async () => {
    const labels = detailViewLabels(dictionary)
    const pending = Promise.withResolvers<CatalogDeleteOutcome>()
    const h = mount({ records: [ended] }, dictionary, {
      useSessions: select => select({ ...sessions, ids: [], byId: {} }),
      onDelete: vi.fn<TaskManagerPageProps['onDelete']>(() => pending.promise),
    })
    fireEvent.click(screen.getByRole('button', { name: 'Review release' }))
    const detail = screen.getByRole('complementary', { name: dictionary['detail.label'] })
    const link = (): HTMLElement => within(detail.querySelector('footer')!)
      .getByRole('button', { name: dictionary['detail.openSession'] })
    expect(link().hasAttribute('disabled')).toBe(true)
    // Rules states why the control is unavailable inside its scrolling view.
    const rules = expectDetailView(dictionary, 'rules')
    expect(within(rules).getByText(dictionary['detail.sessionUnavailable']).getAttribute('role')).toBe('status')
    fireEvent.click(link())
    expect(h.props.onOpenSession).not.toHaveBeenCalled()
    fireEvent.click(within(detail).getByRole('tab', { name: labels.records }))
    const panel = expectDetailView(dictionary, 'records')
    await within(panel).findByRole('region', { name: dictionary['delivery.label'] })
    // Records keeps the footer control, but the notice belongs to Rules.
    expect(link().hasAttribute('disabled')).toBe(true)
    expect(visibleText(detail, dictionary['detail.sessionUnavailable'])).toHaveLength(0)
    const more = within(detail).getByRole('button', { name: dictionary['detail.more'] })
    chooseDelete(dictionary)
    const dialog = screen.getByRole('dialog', { name: dictionary['delete.title'] })
    // The dialog quotes the stored instruction as plain text before the reader confirms.
    expect(dialog.textContent).toContain(at.prompt)
    expect(dialog.querySelector('img')).toBeNull()
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
    expect(screen.getByRole('menuitem', { name: dictionary['delete.action'] }).hasAttribute('disabled')).toBe(true)
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
    h.update({ records: [], deleting: [] })
    // The refresh after the deletion drops the row, and the detail keeps the task until the Host answers.
    expectDetailView(dictionary, 'records')
    await act(async () => {
      pending.resolve('deleted')
      await pending.promise
    })
    // The applied deletion closes the detail; the app-wide toast, not the panel, announces the outcome.
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
    // The record's only control opens the Session that accepted it.
    expect(within(record).getAllByRole('button').map(button => button.textContent)).toEqual([alpha])
  })

  it.each(['success', 'rejection'] as const)('ignores old-task late %s and never displays its records in another task', async (outcome) => {
    const pending = Promise.withResolvers<Awaited<ReturnType<TaskManagerPageProps['loadHistory']>>>()
    const secondMessage = 'other-session-message' as typeof delivery.messageId
    const loadHistory = vi.fn<TaskManagerPageProps['loadHistory']>().mockReturnValueOnce(pending.promise)
      .mockResolvedValue({ ok: true, value: {
        id: every.id, records: [{ ...delivery, messageId: secondMessage, scheduledAt: every.scheduledAt, targetSessionId: gamma }],
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
    await screen.findByText(deliveryText(every.scheduledAt, en))
    expect(loadHistory).toHaveBeenLastCalledWith({ id: every.id, limit: 20 })
    await act(async () => {
      if (outcome === 'success') pending.resolve({ ok: true, value: {
        id: ended.id, records: [delivery], earlierRecordsUnavailable: true,
        earlierRecordsPruned: false, retention: { days: 30, records: 200 },
      } })
      else pending.reject(new Error('Old task query failed'))
      await pending.promise.catch(() => {})
    })
    const panel = expectDetailView(en, 'records')
    expect(within(panel).getByText(deliveryText(every.scheduledAt, en))).toBeDefined()
    expect(within(panel).queryByText(deliveryText(delivery.scheduledAt, en))).toBeNull()
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
    expect(document.getElementById(row.getAttribute('aria-describedby')!)?.textContent).toContain(dictionary['status.ended'])
    expect(within(detail).getByText(dictionary['status.ended'])).toBeDefined()
    expect(visibleText(detail, dictionary['detail.nextRun'])).toHaveLength(0)
    expect(nextRunTime(detail)).toBeNull()
    expect(row.textContent).not.toContain(dictionary['list.nextPrefix'])
    expect(detail.textContent).not.toMatch(/execution completed|completed successfully|execution succeeded|执行已完成|执行成功/i)
    const link = within(detail.querySelector('footer')!).getByRole('button', { name: dictionary['detail.openSession'] })
    fireEvent.click(link)
    expect(h.props.onOpenSession).toHaveBeenCalledExactlyOnceWith(alpha)
    fireEvent.click(within(detail).getByRole('tab', { name: detailViewLabels(dictionary).records }))
    const receipt = await within(expectDetailView(dictionary, 'records')).findByRole('region', { name: dictionary['delivery.label'] })
    const occurrence = receipt.querySelector<HTMLTimeElement>(`.${css.deliveryTime}`)
    expect(occurrence?.dateTime).toBe(delivery.scheduledAt)
    expect(occurrence?.textContent).toBe(deliveryText(delivery.scheduledAt, dictionary))
    // The occurrence names its month in the active locale and never shows the
    // retired zero-padded `MM-DD` pair.
    expect(occurrence?.textContent ?? '').toMatch(/[A-Za-z]{3,}|月/)
    expect(occurrence?.textContent ?? '').not.toMatch(/\d{2}-\d{2}/)
    expect(receipt.querySelector('details')).toBeNull()
    expect(within(receipt).getAllByRole('button').map(button => button.textContent)).toEqual([alpha])
    expect(receipt.querySelectorAll('time')).toHaveLength(1)
    expect(within(detail).queryByRole('region', { name: /history|历史/i })).toBeNull()
    // The linked-Session footer stays under Records.
    expect(within(detail.querySelector('footer')!).getByRole('button', { name: dictionary['detail.openSession'] })).toBeDefined()
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
    expect(within(detail).getByText(en['status.ended'])).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: en['statusFilter.all'] }))
    expect(screen.getByRole('button', { name: 'Review release' }).getAttribute('aria-expanded')).toBe('true')
  })

  it('does not invent receipt fields or a next scheduled time for ended tasks without receipts', async () => {
    mount({ records: [{ ...at, status: 'ended' }] })
    fireEvent.click(screen.getByRole('button', { name: 'Review release' }))
    const detail = screen.getByRole('complementary')
    expect(within(detail).getByText(en['status.ended'])).toBeDefined()
    expect(visibleText(detail, en['detail.nextRun'])).toHaveLength(0)
    expect(screen.getByRole('list').querySelector('time')).toBeNull()
    expect(detail.querySelector('time')).toBeNull()
    fireEvent.click(within(detail).getByRole('tab', { name: detailViewLabels(en).records }))
    const panel = expectDetailView(en, 'records')
    await within(panel).findByText(detailViewLabels(en).empty)
    expect(within(panel).queryByRole('region', { name: en['delivery.label'] })).toBeNull()
    expect(panel.querySelector('time')).toBeNull()
  })

  it.each([en, zh])('preserves Delivery records on same-task refresh and replaces the actual latest receipt separately from the next target', async (dictionary) => {
    const labels = detailViewLabels(dictionary)
    const h = mount({ records: [{ ...every, lastDelivery: delivery }] }, dictionary)
    fireEvent.click(screen.getByRole('button', { name: 'Check metrics' }))
    const detail = screen.getByRole('complementary')
    const rules = expectDetailView(dictionary, 'rules')
    const ruleCard = (root: HTMLElement): HTMLElement => root.querySelector<HTMLElement>(`.${css.ruleCard}`)!
    expect(nextRunTime(detail)?.dateTime).toBe(every.scheduledAt)
    expect(visibleText(ruleCard(rules), dictionary['rule.repeat'])).toHaveLength(1)
    fireEvent.click(within(detail).getByRole('tab', { name: labels.records }))
    const firstPanel = expectDetailView(dictionary, 'records')
    await within(firstPanel).findByRole('region', { name: dictionary['delivery.label'] })
    const nextDelivery: ScheduleDeliveryReceipt = {
      scheduledAt: every.scheduledAt,
      deliveredAt: '2026-10-01T09:30:04.000Z',
      messageId: 'message-metrics-delivery' as typeof delivery.messageId,
      targetSessionId: gamma,
    }
    h.update({ status: 'loading' })
    expectDetailView(dictionary, 'records')
    h.update({ status: 'ready', records: [{ ...every, scheduledAt: '2026-10-01T09:35:01.000Z', lastDelivery: nextDelivery }] })
    expect(screen.getByRole('complementary')).toBe(detail)
    const panel = expectDetailView(dictionary, 'records')
    await within(panel).findByText(deliveryText(nextDelivery.scheduledAt, dictionary))
    const receipt = within(panel).getByRole('region', { name: dictionary['delivery.label'] })
    expect(within(panel).queryByText(deliveryText(delivery.scheduledAt, dictionary))).toBeNull()
    expect(within(panel).getAllByRole('region', { name: dictionary['delivery.label'] })).toHaveLength(1)
    expect(receipt.querySelector<HTMLTimeElement>(`.${css.deliveryTime}`)?.dateTime).toBe(nextDelivery.scheduledAt)
    // Records shows no next-run line; the line returns with Rules.
    expect(visibleText(detail, dictionary['detail.nextRun'])).toHaveLength(0)
    expect(nextRunTime(detail)).toBeNull()
    fireEvent.click(within(detail).getByRole('tab', { name: labels.rules }))
    const refreshedRules = expectDetailView(dictionary, 'rules')
    expect(visibleText(refreshedRules, dictionary['status.active'])).toHaveLength(0)
    expect(visibleText(ruleCard(refreshedRules), dictionary['rule.repeat'])).toHaveLength(1)
    expect(nextRunTime(detail)?.dateTime).toBe('2026-10-01T09:35:01.000Z')
  })

  it.each([en, zh])('keeps the linked Session entry separate from scrolling details and destructive actions', (dictionary) => {
    const h = mount({ records: [at] }, dictionary)
    fireEvent.click(screen.getByRole('button', { name: 'Review release' }))
    const detail = screen.getByRole('complementary', { name: dictionary['detail.label'] })
    const footer = detail.querySelector<HTMLElement>('footer')!
    const link = within(footer).getByRole('button', { name: dictionary['detail.openSession'] })
    expect(within(footer).getAllByRole('button')).toEqual([link])
    expect(within(footer).getByText(dictionary['detail.session'])).toBeDefined()
    expect(detail.querySelector(`.${css.detailScroll}`)?.contains(footer)).toBe(false)
    // The overflow menu and the close control sit in the top strip, not in the heading row.
    const strip = detail.querySelector(`.${css.detailTabsBar}`)!
    expect(strip.contains(within(detail).getByRole('button', { name: dictionary['detail.more'] }))).toBe(true)
    expect(strip.contains(within(detail).getByRole('button', { name: dictionary['detail.close'] }))).toBe(true)
    expect(detail.querySelector('header')?.contains(strip)).toBe(false)
    const menu = openMore(dictionary)
    expect(within(menu).getByRole('menuitem', { name: dictionary['delete.action'] })).toBeDefined()
    fireEvent.keyDown(menu, { key: 'Escape' })
    fireEvent.click(link)
    expect(h.props.onOpenSession).toHaveBeenCalledExactlyOnceWith(alpha)
    expect(h.props.onDelete).not.toHaveBeenCalled()
  })

  it('names the linked Session only in the detail and opens its id', () => {
    const title = 'Release review'
    const h = mount({ records: [at] }, en, {
      useSessions: select => select(sessionsWithTitles({ [alpha]: title })),
    })
    const row = screen.getByRole('button', { name: 'Review release' })
    const metadata = document.getElementById(row.getAttribute('aria-describedby')!)!
    expect(metadata.textContent).not.toContain(title)
    expect(metadata.textContent).not.toContain(alpha)
    fireEvent.click(row)
    const detail = screen.getByRole('complementary', { name: en['detail.label'] })
    const link = within(detail).getByRole('button', {
      name: en['detail.openSessionTitle'].replace('{title}', title),
    })
    expect(link.textContent).toContain(title)
    expect(within(detail).queryByText(alpha)).toBeNull()
    fireEvent.click(link)
    expect(h.props.onOpenSession).toHaveBeenCalledExactlyOnceWith(alpha)
  })

  it('keeps the Session id as the label without a catalog title', () => {
    mount({ records: [at] })
    const row = screen.getByRole('button', { name: 'Review release' })
    expect(document.getElementById(row.getAttribute('aria-describedby')!)?.textContent).not.toContain(alpha)
    fireEvent.click(row)
    const detail = screen.getByRole('complementary', { name: en['detail.label'] })
    const link = within(detail).getByRole('button', { name: en['detail.openSession'] })
    expect(link.textContent).toContain(alpha)
  })

  it('keeps the Session id as the label while the catalog holds no such Session', () => {
    mount({ records: [at] }, en, {
      useSessions: select => select({ ...sessions, ids: [], byId: {} }),
    })
    const row = screen.getByRole('button', { name: 'Review release' })
    expect(document.getElementById(row.getAttribute('aria-describedby')!)?.textContent).not.toContain(alpha)
    fireEvent.click(row)
    const detail = screen.getByRole('complementary', { name: en['detail.label'] })
    const link = within(detail).getByRole('button', { name: en['detail.openSession'] })
    expect(link.textContent).toContain(alpha)
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
    // The panel takes focus so the keyboard lands inside it.
    expect(document.activeElement).toBe(detail)
    expect(readonlyPrompt(detail)).toBe(at.prompt)
    const link = within(detail).getByRole('button', { name: en['detail.openSession'] })
    expect(link.textContent).toContain(alpha)
    expect(nextRunTime(detail)?.dateTime).toBe(at.scheduledAt)
    expect(nextRunTime(detail)?.textContent).toBe(absoluteNextRun(at.scheduledAt, en))
    expect(relativeText(detail)).toBe(relativeNextRun(at.scheduledAt, en))
    const menu = openMore()
    expect(within(menu).getAllByRole('menuitem')).toHaveLength(2)
    expect(within(menu).getByRole('menuitem', { name: en['delete.action'] })).toBeDefined()
    fireEvent.keyDown(menu, { key: 'Escape' })
    expect(detail.querySelector('img')).toBeNull()
    fireEvent.keyDown(detail, { key: 'ArrowDown' })
    expect(screen.getByRole('complementary')).toBe(detail)
    fireEvent.click(link)
    expect(h.props.onOpenSession).toHaveBeenCalledWith(alpha)
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
    expect(readonlyPrompt(screen.getByRole('complementary'))).toBe(at.prompt)
    fireEvent.click(screen.getByRole('button', { name: en['detail.close'] }))
    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1 }))
  })

  it('renders Chinese labels and local time without translating stored user data', () => {
    mount({}, zh)
    expect(screen.getByRole('heading', { level: 1, name: '自动化任务' })).toBeDefined()
    expect(screen.getByRole('searchbox', { name: '搜索任务' })).toBeDefined()
    const statuses = screen.getByRole('group', { name: '任务状态' })
    expect(within(statuses).getAllByRole('button')[0]?.textContent).toBe('已开启')
    fireEvent.click(screen.getByRole('button', { name: 'Check metrics' }))
    const detail = screen.getByRole('complementary', { name: '任务详情' })
    expect(within(detail).getByText(frequencyText(every, zh))).toBeDefined()
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
    const stored: Entry = { ...daily, rrule: 'DTSTART;TZID=America/New_York:20261001T230000\nRRULE:FREQ=DAILY' }
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
    fireEvent.click(screen.getByRole('button', { name: daily.title }))
    const detail = screen.getByRole('complementary', { name: en['detail.label'] })
    expect(nextRunTime(detail)?.textContent).toBe(device)
    // The rule keeps stating its own zone where the zone belongs.
    const frequency = frequencyText(stored, en)
    expect(frequency).toContain(zoneLabel('America/New_York', makeTranslate(en)))
    expect(visibleText(detail, frequency)).toHaveLength(1)
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
      useContextMenu={contextMenuHook()} useResource={unread}
      useSessionStatus={unread}
      useSessionRetainInfo={unread}
      {...allowAllAccess}
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

describe('Task detail metrics', () => {
  it('applies the detail metrics to the header, the next-run line, and the instruction box', () => {
    const stylesheet = readFileSync(resolve(import.meta.dirname, '../src/client/TaskManagerPage.module.css'), 'utf8')
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
    expect(rule('emptyIllustration')).toMatch(/width:\s*110px;/)
    expect(rule('emptyIllustration')).toMatch(/max-width:\s*100%;/)
    expect(rule('emptyIllustration')).toMatch(/height:\s*auto;/)
    expect(rule('emptyIllustration')).toMatch(/margin-bottom:\s*12px;/)
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
    // The New action and the bulk cleanup share this capsule geometry.
    const headerAction = rule('headerAction')
    expect(headerAction).toMatch(/height:\s*32px;/)
    expect(headerAction).toMatch(/font-size:\s*13px;/)
    expect(headerAction).toMatch(/padding:\s*0 12px;/)
    expect(headerAction).toMatch(/border-radius:\s*16px;/)
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
    // The search row fixes the mock's 36px control height for the field and the
    // square More trigger, and keeps the hairline at the repository's 0.5px.
    expect(rule('searchTools')).toMatch(/--task-search-height:\s*36px;/)
    expect(rule('catalogMore')).toMatch(/width:\s*var\(--task-search-height\);/)
    expect(rule('catalogMore')).toMatch(/height:\s*var\(--task-search-height\);/)
    expect(rule('catalogMore')).toMatch(/padding:\s*0;/)
    const field = rule('searchField')
    expect(field).toMatch(/height:\s*var\(--task-search-height\);/)
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

  it('styles the run-time heading as an editor field label and states the l4 panel edge', () => {
    expect(rule('editorField > h3')).toMatch(/margin:\s*0;/)
    expect(rule('editorField > h3')).toMatch(/font:\s*inherit;/)
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
  it('deletes a retained ended task only after confirmation and authoritative removal', async () => {
    const pending = Promise.withResolvers<CatalogDeleteOutcome>()
    const h = mount({ records: [ended] }, en, { onDelete: vi.fn<TaskManagerPageProps['onDelete']>(() => pending.promise) })
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
    // The row leaves the list, and the detail keeps the task until the Host answers.
    expect(taskNames()).toEqual([])
    expect(screen.getByRole('status').textContent).toContain(en['list.empty'])
    expect(screen.getByRole('heading', { level: 2, name: 'Review release' })).toBeDefined()
    await act(async () => {
      pending.resolve('deleted')
      await pending.promise
    })
    expect(screen.queryByRole('complementary')).toBeNull()
  })

  it('bounds long confirmation content separately from the cancel and confirm actions', async () => {
    const h = mount()
    const dialog = openDelete()
    const cancel = within(dialog).getByRole('button', { name: en['delete.cancel'] })
    const confirm = within(dialog).getByRole('button', { name: en['delete.confirm'] })
    const content = dialog.querySelector(`.${css.confirmContent}`)!
    expect(dialog.classList.contains(css.confirmDialog!)).toBe(true)
    expect(content.textContent).toContain(at.prompt)
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
    await act(async () => {})
    // The applied deletion closes the detail.
    expect(screen.queryByRole('complementary')).toBeNull()
  })

  it('requires explicit confirmation and keeps details open through Cancel and Escape', async () => {
    const h = mount()
    const dialog = openDelete()
    expect(h.props.onDelete).not.toHaveBeenCalled()
    expect(dialog.textContent).toContain(at.prompt)
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
    await act(async () => {})
    expect(screen.queryByRole('complementary')).toBeNull()
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
    const pending = Promise.withResolvers<Awaited<ReturnType<HostTaskActions['edit']>>>()
    const h = mount({ records: [at] })
    vi.mocked(h.props.hostActions.edit).mockReturnValueOnce(pending.promise)
    openEditor('Review release')
    const name = (): HTMLInputElement => screen.getByRole<HTMLInputElement>('textbox', { name: en['detail.name'] })
    fireEvent.change(name(), { target: { value: 'Renamed' } })
    clickSave()
    expect(h.props.hostActions.edit).toHaveBeenCalledOnce()
    h.update({ records: [every] })
    // The edit keeps its task on screen while the Host answers the save.
    expect(name().value).toBe('Renamed')
    openMore()
    const retained = screen.getByRole('menuitem', { name: en['delete.action'] })
    expect(retained.hasAttribute('disabled')).toBe(true)
    fireEvent.click(retained)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(h.props.onDelete).not.toHaveBeenCalled()
    await act(async () => {
      pending.resolve('saved')
      await pending.promise
    })
    expect(screen.queryByRole('complementary')).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1 }))
  })

  it('waits for the refreshed list, not just the deletion acknowledgement, before closing the detail', async () => {
    const h = remoteCatalog()
    await screen.findByRole('button', { name: 'Review release' })
    const deletion = Promise.withResolvers<RemoteResult<ScheduleDeleteResult>>()
    const refresh = Promise.withResolvers<RemoteResult<Entry[]>>()
    h.remove.mockReturnValueOnce(deletion.promise)
    h.list.mockReturnValueOnce(refresh.promise)
    openDelete()
    fireEvent.click(screen.getByRole('button', { name: en['delete.confirm'] }))
    expect(h.remove).toHaveBeenCalledExactlyOnceWith(at.id)
    openMore()
    expect(screen.getByRole('menuitem', { name: en['delete.action'] }).hasAttribute('disabled')).toBe(true)
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

  it('closes the detail on an applied deletion and keeps the stale row until a refresh succeeds', async () => {
    const h = remoteCatalog()
    await screen.findByRole('button', { name: 'Review release' })
    h.list.mockResolvedValueOnce({ ok: false, error: new RemoteError('gateway/internal', 'Unavailable', {}) })
    openDelete()
    fireEvent.click(screen.getByRole('button', { name: en['delete.confirm'] }))
    await act(async () => { await expect(h.onDelete.mock.results[0]!.value).resolves.toBe('deleted') })
    // The Host applied the deletion, so the detail closes although the list read
    // after it failed; the list keeps its last known row until a read succeeds.
    expect(screen.queryByRole('complementary')).toBeNull()
    expect(screen.getByRole('alert').textContent).toBe(en['list.error'])
    expect(taskNames()).toEqual(['Review release'])
    h.list.mockResolvedValueOnce({ ok: true, value: [] })
    fireEvent.click(screen.getByRole('button', { name: en['list.retry'] }))
    await screen.findByText(en['list.empty'])
    expect(taskNames()).toEqual([])
  })

  it('keeps the detail on its rule when the confirmed deletion reaches no authoritative removal', async () => {
    const h = mount({ records: [ended] }, en, { onDelete: vi.fn<TaskManagerPageProps['onDelete']>(async () => 'failed') })
    fireEvent.click(screen.getByRole('button', { name: 'Review release' }))
    chooseDelete()
    fireEvent.click(screen.getByRole('button', { name: en['delete.confirm'] }))
    h.update({ deleting: [ended.id] })
    h.update({ deleting: [] })
    await act(async () => {})
    expect(h.props.onDelete).toHaveBeenCalledExactlyOnceWith(ended.id)
    // The attempt ended with the list still reporting the row, so nothing was
    // deleted and the detail stays open on the task.
    expect(screen.getByRole('complementary')).toBeDefined()
    expect(screen.getByRole('heading', { level: 2, name: 'Review release' })).toBeDefined()
    openMore()
    expect(screen.getByRole('menuitem', { name: en['delete.action'] }).hasAttribute('disabled')).toBe(false)
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
    // The refused attempt released the task, so a later read without the row closes the detail.
    h.update({ records: [] })
    expect(screen.queryByRole('complementary')).toBeNull()
  })

  it('keeps another task open when a deletion settles after its detail closed', async () => {
    const pending = Promise.withResolvers<CatalogDeleteOutcome>()
    const h = mount({}, en, { onDelete: vi.fn<TaskManagerPageProps['onDelete']>(() => pending.promise) })
    openDelete()
    fireEvent.click(screen.getByRole('button', { name: en['delete.confirm'] }))
    expect(h.props.onDelete).toHaveBeenCalledExactlyOnceWith(at.id)
    fireEvent.click(screen.getByRole('button', { name: en['detail.close'] }))
    fireEvent.click(screen.getByRole('button', { name: 'Check metrics' }))
    await act(async () => {
      pending.resolve('deleted')
      await pending.promise
    })
    // The outcome answers a detail that is gone, so the detail of the other task stays open.
    expect(screen.getByRole('heading', { level: 2, name: 'Check metrics' })).toBeDefined()
  })
})

describe('timing pickers', () => {
  it('opens the three clock columns, marks the staged value, and saves one pick', async () => {
    const h = mount({ records: [at] })
    openEditor('Review release')
    fireEvent.click(timeButton())
    // Three columns of the padded clock range, each with one marked option.
    for (const [key, count] of [
      ['timing.hour', 24], ['timing.minute', 60], ['timing.second', 60],
    ] as const) {
      const column = clockColumn(key)
      expect(within(column).getAllByRole('option')).toHaveLength(count)
      expect(within(column).getAllByRole('option', { selected: true })).toHaveLength(1)
    }
    expect(within(clockColumn('timing.hour')).getByRole('option', { selected: true }).textContent).toBe('09')
    expect(within(clockColumn('timing.minute')).getByRole('option', { selected: true }).textContent).toBe('00')
    expect(within(clockColumn('timing.second')).getByRole('option', { selected: true }).textContent).toBe('00')
    // The staged value is brought into view as the panel opens.
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' })

    fireEvent.click(within(clockColumn('timing.second')).getByRole('option', { name: '30' }))
    // A pick stages the clock, marks it, and keeps the keyboard in the panel.
    expect(timeButton().textContent).toBe('09:00:30')
    expect(within(clockColumn('timing.second')).getByRole('option', { name: '30' })).toBe(document.activeElement)
    expect(h.props.hostActions.edit).not.toHaveBeenCalled()
    clickSave()
    expect(h.props.hostActions.edit).toHaveBeenCalledExactlyOnceWith({
      id: at.id, action: 'update', expectedUpdatedAt: at.updatedAt,
      patch: { timing: { kind: 'rrule', rrule: 'DTSTART;TZID=UTC:20261001T090030\nRRULE:FREQ=DAILY;COUNT=1' } },
    })
    await act(async () => {})
    // The saved form gives way to the read-only view, and its Edit button takes the focus back.
    expect(screen.queryByRole('region', { name: en['rule.title'] })).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: en['host.edit'] }))
  })

  it('offers hours and minutes only for a daily rule and saves the picked minute', async () => {
    const h = mount({ records: [daily] })
    openEditor('Daily weather')
    fireEvent.click(timeButton())
    // A daily rule names its hour and minute, so the panel has no seconds column.
    expect(clockColumn('timing.hour')).toBeDefined()
    expect(screen.queryByRole('listbox', { name: en['timing.second'] })).toBeNull()
    fireEvent.click(within(clockColumn('timing.minute')).getByRole('option', { name: '05' }))
    expect(timeButton().textContent).toBe('23:05:00')
    clickSave()
    expect(h.props.hostActions.edit).toHaveBeenCalledExactlyOnceWith({
      id: daily.id, action: 'update', expectedUpdatedAt: daily.updatedAt,
      patch: { timing: { kind: 'rrule', rrule: 'DTSTART;TZID=Asia/Shanghai:20261001T230500\nRRULE:FREQ=DAILY;INTERVAL=1;BYHOUR=23;BYMINUTE=5' } },
    })
    await act(async () => {})
  })

  it('walks one clock column with the arrow keys and stages what Enter selects', () => {
    mount({ records: [daily] })
    openEditor('Daily weather')
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
    mount({ records: [at] })
    openEditor('Review release')
    fireEvent.click(timeButton())
    // One focusable row per column, on the value that column shows, and every
    // column brings its row into view as the panel opens.
    for (const [key, shown] of [
      ['timing.hour', '09'], ['timing.minute', '00'], ['timing.second', '00'],
    ] as const) {
      const tabbable = within(clockColumn(key)).getAllByRole('option')
        .filter(option => option.getAttribute('tabindex') === '0')
      expect(tabbable).toHaveLength(1)
      expect(tabbable[0]?.textContent).toBe(shown)
    }
    expect(scrolledIntoView.map(element => element.textContent)).toEqual(['09', '00', '00'])

    // Right carries the row into the next column.
    fireEvent.keyDown(within(clockColumn('timing.hour')).getByRole('option', { name: '09' }), { key: 'ArrowRight' })
    expect(document.activeElement).toBe(within(clockColumn('timing.minute')).getByRole('option', { name: '09' }))
    // The minute column's last row clamps into the shorter hour column on the way back.
    fireEvent.keyDown(within(clockColumn('timing.minute')).getByRole('option', { name: '09' }), { key: 'End' })
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
    mount({ records: [at] })
    openEditor('Review release')
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
    openEditor('Daily weather')
    fireEvent.click(timeButton())
    expect(screen.getByRole('listbox', { name: en['timing.hour'] })).toBeDefined()
    fireEvent.pointerDown(screen.getByRole('heading', { name: en['title'] }))
    expect(screen.queryByRole('listbox', { name: en['timing.hour'] })).toBeNull()
  })

  it('dismisses the calendar when the pointer lands outside it', () => {
    mount({ records: [at] })
    openEditor('Review release')
    fireEvent.click(dateButton())
    expect(screen.getByRole('grid')).toBeDefined()
    fireEvent.pointerDown(screen.getByRole('heading', { name: en['title'] }))
    expect(screen.queryByRole('grid')).toBeNull()
  })

  it('closes an open picker and keeps both pickers shut while a save is pending', async () => {
    const pending = Promise.withResolvers<Awaited<ReturnType<HostTaskActions['edit']>>>()
    const h = mount({ records: [at] })
    vi.mocked(h.props.hostActions.edit).mockReturnValueOnce(pending.promise)
    openEditor('Review release')
    fireEvent.click(timeButton())
    fireEvent.click(within(clockColumn('timing.second')).getByRole('option', { name: '30' }))
    clickSave()
    expect(h.props.hostActions.edit).toHaveBeenCalledOnce()
    // The pending save locks the form, and the open clock closes with it.
    expect(screen.queryByRole('listbox', { name: en['timing.hour'] })).toBeNull()
    expect(timeButton().disabled).toBe(true)
    expect(dateButton().disabled).toBe(true)
    fireEvent.click(timeButton())
    expect(screen.queryByRole('listbox', { name: en['timing.hour'] })).toBeNull()
    fireEvent.click(dateButton())
    expect(screen.queryByRole('grid')).toBeNull()
    await act(async () => {
      pending.resolve('saved')
      await pending.promise
    })
    expect(screen.queryByRole('region', { name: en['rule.title'] })).toBeNull()
  })

  it('opens the month grid on the stored day, marks today, and stages a picked day', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-14T12:00:00.000Z'))
    try {
      const h = mount({ records: [at] })
      openEditor('Review release')
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
      // A picked day stages the date and closes the calendar.
      expect(dateButton().textContent).toBe('2026/10/15')
      expect(screen.queryByRole('grid')).toBeNull()
      expect(h.props.hostActions.edit).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('moves the grid one month at a time and stages a day in the shown month', () => {
    mount({ records: [at] })
    openEditor('Review release')
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
    openEditor('Review release')
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
    openEditor('Review release')
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
    openEditor('Review release', dictionary)
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
