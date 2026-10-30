// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { allowAllAccess, contextMenuHook, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { ScheduleId, ScheduleCatalogEntry, ScheduleRecord } from '@deepseek-ai/dsh-schedule/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceId, WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { TaskManagerPage, type TaskManagerPageProps } from '../src/client/TaskManagerPage.tsx'
import type { HostTaskActions } from '../src/client/TaskDetail.tsx'
import type { TaskCreateOutcome } from '../src/client/TaskCreateDialog.tsx'
import type { CatalogSnapshot } from '../src/client/catalog-source.ts'
import { timingFromRecord } from '../src/client/editor-timing.ts'
import { createRRuleScheduleRecord } from '../../../schedule/schedule/src/domain.ts'
import { ScheduleId as createScheduleId } from '../../../schedule/schedule/src/domain.ts'
import { draftTarget, taskDraft } from '../src/client/TaskEditorFields.tsx'
import { formatAvailableAt, formatScheduleFrequency, orderScheduleRecords, zoneLabel, zoneName } from '../src/client/schedule-format.ts'
import { en, zh } from '../src/client/task-manager-locales.ts'
import { pinSystemZone } from './zone-fixture.ts'

const targetSession = 'existing-session' as SessionId
const task: ScheduleCatalogEntry = { kind: 'rrule',
  id: 'host-task' as ScheduleId, title: 'Daily report', prompt: 'Summarize project activity',
  rrule: 'DTSTART;TZID=UTC:20990101T090000\nRRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,WE',
  scheduledAt: '2099-01-05T09:00:00.000Z', target: { kind: 'new_once', sessionId: targetSession, create: {} },
  involvedSessionIds: [targetSession], status: 'active', createdAt: '2098-12-01T00:00:00.000Z',
  updatedAt: '2098-12-01T00:00:00.000Z',
}
const sessions: SessionListState = {
  ids: [targetSession], phase: 'ready', projectionsBySession: {},
  byId: { [targetSession]: { id: targetSession, displayTitle: 'Report conversation', running: false, blank: false,
    updatedAt: 0, retainedBy: {} } },
}
const workspaces: WorkspaceSnapshot = {
  items: [], archivedSessionIds: [], pinnedSessionIds: [], state: 'idle', phase: 'ready', error: null,
}
function workspace(path: string, title: string): WorkspaceSnapshot['items'][number] {
  return {
    workspaceId: `workspace:${title}` as WorkspaceId, path, title, sessionIds: [], createdAt: task.createdAt ?? '', updatedAt: task.updatedAt ?? '',
  }
}
const registered: WorkspaceSnapshot = {
  ...workspaces, items: [workspace('/work/docs', 'docs'), workspace('/work/default-workspace', 'default-workspace')],
}

const t = makeTranslate(en)
function hostActions(overrides: Partial<HostTaskActions> = {}): HostTaskActions {
  return {
    edit: vi.fn<HostTaskActions['edit']>(async () => 'saved'), run: vi.fn<HostTaskActions['run']>(async () => 'queued'),
    loadNewSessionInterval: vi.fn<HostTaskActions['loadNewSessionInterval']>(async () => 7200), ...overrides,
  }
}

function mount(rows: readonly ScheduleCatalogEntry[] = [task], overrides: Partial<TaskManagerPageProps> = {}) {
  let snapshot: CatalogSnapshot<ScheduleCatalogEntry> = {
    records: rows, status: 'ready', deleting: [], settled: true, readRequest: 1, readSettled: 1,
  }
  const props: TaskManagerPageProps = {
    ...allowAllAccess, useCatalog: select => select(snapshot), useSessions: select => select(sessions),
    useWorkspaces: select => select(workspaces), usePanelInfo: select => select({ activePanelId: null }),
    useSessionStatus: select => select(new Map()), useSessionRetainInfo: () => undefined,
    useResource: () => { throw new Error('Task editor loads no document resources') },
    useContextMenu: contextMenuHook(),
    onNewTask: vi.fn(), onClearEnded: vi.fn(async () => {}),
    onCreateTask: vi.fn<TaskManagerPageProps['onCreateTask']>(async () => ({ created: task })),
    onDelete: vi.fn<TaskManagerPageProps['onDelete']>(async () => 'deleted'), onRetry: vi.fn(async () => {}), onOpenSession: vi.fn(),
    hostActions: hostActions(),
    loadHistory: vi.fn<TaskManagerPageProps['loadHistory']>(async ({ id }) => ({ ok: true, value: { id, records: [], earlierRecordsUnavailable: false,
      earlierRecordsPruned: false, retention: { days: 30, records: 200 } } })),
    t: makeTranslate(en), ...overrides,
  }
  const view = render(<TaskManagerPage {...props} />)
  return { props, view, update(records: readonly ScheduleCatalogEntry[]) {
    snapshot = { ...snapshot, records }; view.rerender(<TaskManagerPage {...props} />)
  } }
}
function openManual(): HTMLElement {
  fireEvent.click(screen.getByRole('button', { name: en['host.createMethod'] }))
  fireEvent.click(screen.getByRole('menuitem', { name: en['host.manualCreate'] }))
  return screen.getByRole('dialog', { name: en['host.manualCreate'] })
}
function openEdit(): HTMLElement {
  fireEvent.click(screen.getByRole('button', { name: task.title }))
  fireEvent.click(screen.getByRole('button', { name: en['host.edit'] }))
  return screen.getByRole('complementary')
}
function chooseRepeat(detail: HTMLElement, label: string): void {
  fireEvent.click(within(detail).getByRole('button', { name: new RegExp('^' + en['rule.repeat'] + ' ') }))
  fireEvent.click(screen.getByRole('menuitem', { name: label }))
}
function stepper(name: string): HTMLElement {
  return screen.getByRole('spinbutton', { name }).parentElement!
}
function weekday(day: string): HTMLElement {
  return screen.getByRole('button', { name: t('rule.weekdayOption', { weekday: day }) })
}
async function save(detail: HTMLElement): Promise<void> {
  await act(async () => { fireEvent.click(within(detail).getByRole('button', { name: en['rule.save'] })) })
}
function expectSavedRule(h: ReturnType<typeof mount>, rrule: string): void {
  expect(h.props.hostActions.edit)
    .toHaveBeenCalledExactlyOnceWith({ id: task.id, action: 'update', expectedUpdatedAt: task.updatedAt, patch: { timing: { kind: 'rrule', rrule: rrule } } })
}
function openZones(detail: HTMLElement): HTMLElement {
  fireEvent.click(within(detail).getByRole('button', { name: new RegExp('^' + en['timing.zone'] + ' ') }))
  return screen.getByRole('menu')
}
function searchZones(query: string): void {
  fireEvent.change(screen.getByRole('searchbox', { name: en['timing.zoneSearch'] }), { target: { value: query } })
}

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn()
  vi.spyOn(Intl, 'supportedValuesOf').mockReturnValue(['UTC'])
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers() })

describe('Host task editor on the existing manager', () => {
  it('closes manual creation on Escape without discarding the edited task', () => {
    mount()
    const detail = openEdit()
    fireEvent.change(within(detail).getByRole('textbox', { name: en['detail.name'] }), { target: { value: 'Unsaved title' } })
    const dialog = openManual()
    fireEvent.keyDown(within(dialog).getByRole('textbox', { name: en['detail.name'] }), { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(within(detail).getByRole('textbox', { name: en['detail.name'] }).getAttribute('value')).toBe('Unsaved title')
  })

  it.each(['altKey', 'ctrlKey', 'metaKey', 'shiftKey'])('preserves modified detail navigation with %s', (modifier) => {
    mount()
    fireEvent.click(screen.getByRole('button', { name: task.title }))
    const rules = screen.getByRole('tab', { name: en['detail.rule'] })
    fireEvent.keyDown(rules, { key: 'ArrowRight', [modifier]: true })
    expect(rules.getAttribute('aria-selected')).toBe('true')
  })

  it('includes current values in rule selector accessible names', () => {
    mount()
    const detail = openEdit()
    expect(within(detail).getByRole('button', { name: `${en['rule.repeat']} ${en['rule.weekly']}` })).toBeDefined()
    expect(within(detail).getByRole('button', { name: `${en['host.target']} ${en['host.targetNewOnce']}` })).toBeDefined()
  })

  it.each([
    { kind: 'after', afterSeconds: 60 },
    { kind: 'at' },
    { kind: 'every', everySeconds: 300 },
    { kind: 'daily', time: '09:00:00.123', timeZone: 'Asia/Tokyo' },
    { kind: 'weekly', time: '09:00:00.123', timeZone: 'Asia/Tokyo', weekdays: [1, 5] },
  ] satisfies Partial<ScheduleRecord>[])('renames a historical $kind task without replacing its authoritative timing', async (timing) => {
    const { rrule: _rrule, kind: _kind, updatedAt: _updatedAt, ...common } = task
    const h = mount([{ ...common, ...timing }])
    const detail = openEdit()
    fireEvent.change(within(detail).getByRole('textbox', { name: en['detail.name'] }), { target: { value: 'Renamed' } })
    await save(detail)
    expect(h.props.hostActions.edit).toHaveBeenCalledExactlyOnceWith({
      id: task.id, action: 'update', expectedUpdatedAt: null, patch: { title: 'Renamed' },
    })
  })

  it('pauses a historical task without a saved revision', async () => {
    const { updatedAt: _updatedAt, ...historical } = task
    const h = mount([historical])
    fireEvent.click(screen.getByRole('button', { name: task.title }))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: en['host.pause'] })) })
    expect(h.props.hostActions.edit).toHaveBeenCalledExactlyOnceWith({
      id: task.id, action: 'update', patch: { active: false }, expectedUpdatedAt: null,
    })
  })

  it.each([en, zh])('offers only new conversation strategies and registered workspaces, starting in the default one', (dictionary) => {
    mount([], { t: makeTranslate(dictionary), useWorkspaces: select => select(registered) })
    fireEvent.click(screen.getByRole('button', { name: dictionary['empty.action'] }))
    const modal = screen.getByRole('dialog')
    expect(within(modal).getByRole('button', { name: new RegExp('^' + dictionary['host.target'] + ' ') }).textContent).toContain(dictionary['host.targetNewOnce'])
    const project = within(modal).getByRole('button', { name: new RegExp('^' + dictionary['host.project'] + ' ') })
    expect(project.textContent).toContain(dictionary['host.defaultProject'])
    fireEvent.click(project)
    // Each workspace states its directory, so the Default workspace title names a folder.
    const items = screen.getAllByRole('menuitem')
    expect(items.map(item => item.textContent))
      .toEqual(['docs/work/docs', `${dictionary['host.defaultProject']}/work/default-workspace`])
    expect(within(items[1]!).getByTitle('/work/default-workspace').textContent).toBe('/work/default-workspace')
    fireEvent.click(screen.getByRole('menuitem', { name: new RegExp(`^${dictionary['host.defaultProject']}`) }))
    fireEvent.click(within(modal).getByRole('button', { name: new RegExp('^' + dictionary['host.target'] + ' ') }))
    expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual([
      dictionary['host.targetNewOnce'] + dictionary['host.targetNewOnceHelp'],
      dictionary['host.targetNew'] + dictionary['host.targetNewHelp'],
    ])
  })

  it.each([
    { choice: 'rule.everyMinutes' as const, interval: '1', next: '2026-10-14T08:08:00.000Z' },
    { choice: 'rule.everyMinutes' as const, interval: '5', next: '2026-10-14T08:12:00.000Z' },
    { choice: 'rule.everyHours' as const, interval: '2', next: '2026-10-14T10:07:00.000Z' },
  ])('starts $choice with interval $interval from saving, not the hidden one-shot anchor', async ({ choice, interval, next }) => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime('2026-10-14T08:00:30.000Z')
    const h = mount([])
    const modal = openManual()
    fireEvent.change(within(modal).getByRole('textbox', { name: en['detail.name'] }), { target: { value: 'Interval task' } })
    fireEvent.change(within(modal).getByRole('textbox', { name: en['detail.instruction'] }), { target: { value: 'Check changes' } })
    fireEvent.click(within(modal).getByRole('button', { name: new RegExp('^' + en['rule.repeat'] + ' ') }))
    fireEvent.click(screen.getByRole('menuitem', { name: en[choice] }))
    fireEvent.change(within(modal).getByRole('spinbutton', { name: en['host.interval'] }), { target: { value: interval } })
    vi.setSystemTime('2026-10-14T08:07:30.000Z')
    await act(async () => { fireEvent.click(within(modal).getByRole('button', { name: en['host.create'] })) })
    const request = vi.mocked(h.props.onCreateTask).mock.calls[0]![0]
    expect(createRRuleScheduleRecord(createScheduleId('saved-interval'), request.title, request.prompt, rruleOf(request.timing), Date.now()).scheduledAt).toBe(next)
  })

  it('preserves the linked conversation and recurrence when editing an existing task', async () => {
    const current = { ...task, target: { kind: 'session' as const, sessionId: targetSession },
      rrule: 'DTSTART;TZID=UTC:20990101T090000\nRRULE:FREQ=MINUTELY;INTERVAL=5' }
    const h = mount([current])
    const detail = openEdit()
    expect(within(detail).getByRole('button', { name: new RegExp('^' + en['host.target'] + ' ') }).textContent).toContain(en['host.currentConversation'])
    expect(within(detail).queryByRole('button', { name: en['detail.session'] })).toBeNull()
    fireEvent.change(within(detail).getByRole('textbox', { name: en['detail.instruction'] }), { target: { value: 'New content' } })
    fireEvent.click(within(detail).getByRole('button', { name: en['rule.save'] }))
    await screen.findByRole('button', { name: en['host.edit'] })
    expect(h.props.hostActions.edit).toHaveBeenCalledWith({ id: task.id, action: 'update', expectedUpdatedAt: task.updatedAt, patch: { prompt: 'New content' } })
  })

  it('keeps a delayed name-only edit of a v1 Cron task free of a timing patch', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime('2026-10-14T08:00:00.000Z')
    const current: ScheduleCatalogEntry = {
      id: task.id, kind: 'cron', title: task.title, prompt: task.prompt,
      expression: '0 9 * * 1-5', timeZone: 'Asia/Shanghai', scheduledAt: task.scheduledAt,
      target: { kind: 'session', sessionId: targetSession }, involvedSessionIds: [targetSession], status: 'active',
    }
    const h = mount([current])
    const detail = openEdit()
    vi.setSystemTime('2026-10-14T08:02:00.000Z')
    fireEvent.change(within(detail).getByRole('textbox', { name: en['detail.name'] }), { target: { value: 'Renamed' } })
    await save(detail)
    expect(h.props.hostActions.edit).toHaveBeenCalledExactlyOnceWith({ id: task.id, action: 'update',
      patch: { title: 'Renamed' }, expectedUpdatedAt: null })
  })

  it('anchors an edited interval at Save while leaving the destination unchanged', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime('2026-10-14T08:07:30.000Z')
    const h = mount([{ ...task, rrule: 'DTSTART;TZID=UTC:20261013T090000\nRRULE:FREQ=MINUTELY;INTERVAL=1' }])
    const detail = openEdit()
    fireEvent.change(within(detail).getByRole('spinbutton', { name: en['host.interval'] }), { target: { value: '5' } })
    await act(async () => { fireEvent.click(within(detail).getByRole('button', { name: en['rule.save'] })) })
    const request = vi.mocked(h.props.hostActions.edit).mock.calls[0]![0]
    if (request.action !== 'update') throw new Error('expected a timing update')
    expect(Object.keys(request.patch)).toEqual(['timing'])
    expect(createRRuleScheduleRecord(createScheduleId('edited-interval'), task.title, task.prompt, rruleOf(request.patch.timing), Date.now()).scheduledAt)
      .toBe('2026-10-14T08:12:00.000Z')
  })

  it('orders a throttled occurrence by its actual next delivery instead of treating it as overdue', () => {
    const limited = { ...task, id: 'limited' as ScheduleId, scheduledAt: '2099-01-05T08:00:00.000Z', deliveryFloorEndsAt: '2099-01-05T10:00:00.000Z' }
    const earlier = { ...task, id: 'earlier' as ScheduleId, scheduledAt: '2099-01-05T09:30:00.000Z', deliveryFloorEndsAt: '2099-01-05T08:00:00.000Z' }
    const overdue = { ...task, id: 'overdue' as ScheduleId, scheduledAt: '2099-01-05T08:30:00.000Z' }
    expect(orderScheduleRecords([limited, earlier, overdue], Date.parse('2099-01-05T09:00:00.000Z')).map(row => row.id))
      .toEqual(['overdue', 'earlier', 'limited'])
  })

  it.each([en, zh])('shows the delivery floor in both list and detail', (dictionary) => {
    const floor = '2099-01-05T10:00:00.000Z'
    const h = mount([{ ...task, target: { kind: 'new', create: {} }, deliveryFloorEndsAt: floor }], { t: makeTranslate(dictionary) })
    const row = within(screen.getByRole('list', { name: dictionary['list.label'] })).getByRole('button', { name: task.title })
    expect(row.querySelector('time')?.dateTime).toBe(floor)
    fireEvent.click(row)
    expect(screen.getByRole('complementary').querySelector('time')?.dateTime).toBe(floor)
    expect(h.props.hostActions.loadNewSessionInterval).not.toHaveBeenCalled()
  })

  it('offers no message-level cancellation for a queued task sharing a batch receipt and points to its conversation', () => {
    const queued = { ...task, executionActive: true as const, lastDelivery: {
      scheduledAt: task.scheduledAt, deliveredAt: task.scheduledAt, targetSessionId: targetSession,
      messageId: 'shared-batch' as NonNullable<ScheduleCatalogEntry['lastDelivery']>['messageId'],
    } }
    const h = mount([queued, { ...queued, id: 'batch-peer' as ScheduleId, title: 'Another queued task' }])
    fireEvent.click(screen.getByRole('button', { name: task.title }))
    const detail = screen.getByRole('complementary')
    expect(within(detail).getByRole('status').textContent).toBe(en['host.executionActive'])
    fireEvent.click(within(detail).getByRole('button', { name: t('detail.openSessionTitle', { title: 'Report conversation' }) }))
    expect(h.props.onOpenSession).toHaveBeenCalledExactlyOnceWith(targetSession)
    fireEvent.click(screen.getByRole('button', { name: en['detail.more'] }))
    expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual([en['host.run'], en['delete.action']])
    expect(screen.getAllByRole('menuitem').every(item => item.hasAttribute('disabled') || item.getAttribute('aria-disabled') === 'true')).toBe(true)
  })

  it.each([
    { name: 'the default workspace', items: registered.items, cwd: '/work/default-workspace' },
    { name: 'the first listed workspace without a default one', cwd: '/work/docs',
      items: [workspace('/work/docs', 'docs'), workspace('/work/notes', 'notes')] },
  ])('creates a manual task in $name', async ({ items, cwd }) => {
    const h = mount([], { useWorkspaces: select => select({ ...workspaces, items }) })
    const modal = openManual()
    fireEvent.change(within(modal).getByRole('textbox', { name: en['detail.name'] }), { target: { value: 'Morning news' } })
    fireEvent.change(within(modal).getByRole('textbox', { name: en['detail.instruction'] }), { target: { value: 'Read news' } })
    await act(async () => { fireEvent.click(within(modal).getByRole('button', { name: en['host.create'] })) })
    expect(vi.mocked(h.props.onCreateTask).mock.calls[0]![0].target).toEqual({ kind: 'new_once', create: { cwd } })
  })

  it('labels a manual draft ungrouped until the workspace list arrives, then starts in the default workspace', () => {
    let current = workspaces
    const h = mount([], { useWorkspaces: select => select(current) })
    const modal = openManual()
    const project = (): HTMLElement => within(modal).getByRole('button', { name: new RegExp('^' + en['host.project'] + ' ') })
    expect(project().textContent).toContain(en['host.ungrouped'])
    fireEvent.click(project())
    const items = screen.getAllByRole('menuitem')
    expect(items.map(item => item.textContent)).toEqual([en['host.ungrouped']])
    expect(items[0]!.hasAttribute('disabled') || items[0]!.getAttribute('aria-disabled') === 'true').toBe(true)
    fireEvent.keyDown(project(), { key: 'Escape' })
    current = registered
    h.view.rerender(<TaskManagerPage {...h.props} />)
    expect(project().textContent).toContain(en['host.defaultProject'])
  })

  it('starts a linked task that switches to a new conversation in the default workspace', async () => {
    const h = mount([{ ...task, target: { kind: 'session', sessionId: targetSession } }], { useWorkspaces: select => select(registered) })
    const detail = openEdit()
    expect(within(detail).queryByRole('button', { name: new RegExp('^' + en['host.project'] + ' ') })).toBeNull()
    fireEvent.click(within(detail).getByRole('button', { name: new RegExp('^' + en['host.target'] + ' ') }))
    fireEvent.click(screen.getByRole('menuitem', { name: new RegExp(`^${en['host.targetNewOnce']}`) }))
    expect(within(detail).getByRole('button', { name: new RegExp('^' + en['host.project'] + ' ') }).textContent).toContain(en['host.defaultProject'])
    await act(async () => { fireEvent.click(within(detail).getByRole('button', { name: en['rule.save'] })) })
    expect(h.props.hostActions.edit).toHaveBeenCalledExactlyOnceWith({ id: task.id, action: 'update', expectedUpdatedAt: task.updatedAt,
      patch: { target: { kind: 'new_once', create: { cwd: '/work/default-workspace' } } } })
  })

  it.each([
    { create: {}, label: en['host.ungrouped'] },
    { create: { cwd: '/elsewhere' }, label: '/elsewhere' },
  ])('shows a stored directory as $label and moves it only to a registered workspace', async ({ create, label }) => {
    const stored = { ...task, target: { kind: 'new_once' as const, sessionId: targetSession, create } }
    const h = mount([stored], { useWorkspaces: select => select(registered) })
    const detail = openEdit()
    const project = within(detail).getByRole('button', { name: new RegExp('^' + en['host.project'] + ' ') })
    expect(project.textContent).toContain(label)
    fireEvent.click(project)
    expect(screen.getAllByRole('menuitem').map(item => item.textContent))
      .toEqual(['docs/work/docs', `${en['host.defaultProject']}/work/default-workspace`])
    fireEvent.click(screen.getByRole('menuitem', { name: /^docs/ }))
    await act(async () => { fireEvent.click(within(detail).getByRole('button', { name: en['rule.save'] })) })
    expect(h.props.hostActions.edit).toHaveBeenCalledExactlyOnceWith({ id: task.id, action: 'update', expectedUpdatedAt: task.updatedAt,
      patch: { target: { kind: 'new_once', create: { cwd: '/work/docs' } } } })
  })

  it('shows the configured interval when selecting a new conversation for every run', async () => {
    mount([])
    const modal = openManual()
    fireEvent.click(within(modal).getByRole('button', { name: new RegExp('^' + en['host.target'] + ' ') }))
    fireEvent.click(screen.getByRole('menuitem', { name: new RegExp(`^${en['host.targetNew']}`) }))
    await within(modal).findByText(makeTranslate(en)('host.newSessionInterval', { interval: '2 hours' }))
  })

  it.each([en, zh])('shows a per-run conversation only after delivery and identifies it as the latest run', async (dictionary) => {
    const eachRun = { ...task, target: { kind: 'new' as const, create: {} } }
    const h = mount([eachRun], { t: makeTranslate(dictionary) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: task.title })) })
    const detail = screen.getByRole('complementary')
    expect(detail.querySelector('footer')).toBeNull()
    h.update([{ ...eachRun, lastDelivery: {
      scheduledAt: task.scheduledAt, deliveredAt: task.scheduledAt, targetSessionId: targetSession,
      messageId: 'delivered-run' as NonNullable<ScheduleCatalogEntry['lastDelivery']>['messageId'],
    } }])
    expect(within(detail).getByText(dictionary['host.latestConversation'])).toBeDefined()
    expect(within(detail).queryByText(dictionary['host.sessionAfterFirstRun'])).toBeNull()
    fireEvent.click(within(detail).getByRole('button', { name: makeTranslate(dictionary)('detail.openSessionTitle', { title: 'Report conversation' }) }))
    expect(h.props.onOpenSession).toHaveBeenCalledExactlyOnceWith(targetSession)
    h.update([task])
    expect(within(detail).getByText(dictionary['detail.session'])).toBeDefined()
    expect(within(detail).queryByText(dictionary['host.latestConversation'])).toBeNull()
  })

  it.each([en, zh])('names an empty status filter and opens the manual form from its action', (dictionary) => {
    const h = mount([], { t: makeTranslate(dictionary) })
    fireEvent.click(screen.getByRole('button', { name: dictionary['status.paused'] }))
    expect(screen.getByRole('status').textContent).toContain(dictionary['list.emptyPaused'])
    expect(screen.getByRole('status').textContent).not.toContain(dictionary['list.noMatches'])
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'news' } })
    expect(screen.getByRole('status').textContent).toContain(dictionary['list.noMatches'])
    fireEvent.click(screen.getByRole('button', { name: dictionary['empty.action'] }))
    expect(screen.getByRole('dialog', { name: dictionary['host.manualCreate'] })).toBeDefined()
    expect(h.props.onNewTask).not.toHaveBeenCalled()
  })

  it('keeps New on the existing conversation path and exposes manual creation separately', () => {
    const h = mount()
    fireEvent.click(screen.getByRole('button', { name: en['new.action'] }))
    expect(h.props.onNewTask).toHaveBeenCalledTimes(1)
    expect(h.props.onCreateTask).not.toHaveBeenCalled()
    const modal = openManual()
    expect(within(modal).getByRole('button', { name: en['host.create'] }).hasAttribute('disabled')).toBe(true)
    expect(within(modal).getByRole('button', { name: new RegExp('^' + en['host.target'] + ' ') }).textContent).toContain(en['host.targetNewOnce'])
  })

  it('retains a rejected manual draft and creates no conversation or sent instruction', async () => {
    const h = mount([], { onCreateTask: vi.fn<TaskManagerPageProps['onCreateTask']>(async () => ({ failed: 'host.notFuture' })) })
    const modal = openManual()
    fireEvent.change(within(modal).getByRole('textbox', { name: en['detail.name'] }), { target: { value: 'Morning news' } })
    fireEvent.change(within(modal).getByRole('textbox', { name: en['detail.instruction'] }), { target: { value: 'Find the latest news' } })
    fireEvent.click(within(modal).getByRole('button', { name: en['host.create'] }))
    await screen.findByText(en['host.notFuture'])
    expect(within(modal).getByRole<HTMLInputElement>('textbox', { name: en['detail.name'] }).value).toBe('Morning news')
    const request = vi.mocked(h.props.onCreateTask).mock.calls[0]![0]
    expect(request).toMatchObject({ title: 'Morning news', prompt: 'Find the latest news', target: { kind: 'new_once', create: {} } })
    expect(rruleOf(request.timing)).toContain('RRULE:FREQ=DAILY;COUNT=1')
    expect(h.props.onNewTask).not.toHaveBeenCalled()
    expect(h.props.onOpenSession).not.toHaveBeenCalled()
  })

  it('consumes picker Escape without discarding the manual form', () => {
    mount([])
    const modal = openManual()
    const label = within(modal).getByText(en['timing.time'])
    const trigger = within(label.parentElement!).getByRole('button')
    fireEvent.click(trigger)
    const clock = screen.getByRole('dialog', { name: en['timing.time'] })
    fireEvent.keyDown(within(clock).getAllByRole('option')[0]!, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: en['timing.time'] })).toBeNull()
    expect(screen.getByRole('dialog', { name: en['host.manualCreate'] })).toBe(modal)
    expect(document.activeElement).toBe(trigger)
  })

  it('dismisses a portaled field menu before the creation modal, even if focus stays elsewhere', () => {
    mount([])
    const modal = openManual()
    const close = within(modal).getByRole('button', { name: en['host.closeCreate'] })
    close.focus()
    fireEvent.click(within(modal).getByRole('button', { name: new RegExp('^' + en['host.target'] + ' ') }))
    expect(screen.getByRole('menu')).toBeDefined()
    fireEvent.keyDown(close, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(screen.getByRole('dialog', { name: en['host.manualCreate'] })).toBe(modal)
  })

  it('saves only changed content with the stored compare timestamp', async () => {
    const h = mount()
    const detail = openEdit()
    fireEvent.change(within(detail).getByRole('textbox', { name: en['detail.instruction'] }), { target: { value: 'Include links' } })
    fireEvent.click(within(detail).getByRole('button', { name: en['rule.save'] }))
    await screen.findByRole('button', { name: en['host.edit'] })
    expect(h.props.hostActions.edit).toHaveBeenCalledExactlyOnceWith({
      id: task.id, action: 'update', expectedUpdatedAt: task.updatedAt, patch: { prompt: 'Include links' },
    })
  })

  it('allows a content edit without reducing a valid large repeat interval', async () => {
    const h = mount([{ ...task, rrule: task.rrule.replace('INTERVAL=1', 'INTERVAL=1000') }])
    const detail = openEdit()
    fireEvent.change(within(detail).getByRole('textbox', { name: en['detail.instruction'] }), { target: { value: 'Include links' } })
    fireEvent.click(within(detail).getByRole('button', { name: en['rule.save'] }))
    await screen.findByRole('button', { name: en['host.edit'] })
    expect(h.props.hostActions.edit).toHaveBeenCalledExactlyOnceWith({
      id: task.id, action: 'update', expectedUpdatedAt: task.updatedAt, patch: { prompt: 'Include links' },
    })
  })

  it('keeps conflicted content visible until the user reloads or cancels', async () => {
    const h = mount([], { hostActions: hostActions({ edit: vi.fn<HostTaskActions['edit']>(async () => ({ failed: 'host.conflict' })) }) })
    h.update([task])
    const detail = openEdit()
    fireEvent.change(within(detail).getByRole('textbox', { name: en['detail.name'] }), { target: { value: 'My draft' } })
    fireEvent.click(within(detail).getByRole('button', { name: en['rule.save'] }))
    await screen.findByText(en['host.conflict'])
    expect(within(detail).getByRole<HTMLInputElement>('textbox', { name: en['detail.name'] }).value).toBe('My draft')
    expect(within(detail).getByRole('button', { name: en['rule.save'] }).hasAttribute('disabled')).toBe(true)
  })

  it('ignores a save acknowledgement after selection moves to another task', async () => {
    const pending = Promise.withResolvers<'saved'>()
    const other = { ...task, id: 'other-task' as ScheduleId, title: 'Other task' }
    const h = mount([task, other], { hostActions: hostActions({ edit: vi.fn<HostTaskActions['edit']>(() => pending.promise) }) })
    const detail = openEdit()
    fireEvent.change(within(detail).getByRole('textbox', { name: en['detail.name'] }), { target: { value: 'My draft' } })
    fireEvent.click(within(detail).getByRole('button', { name: en['rule.save'] }))
    fireEvent.click(screen.getByRole('button', { name: other.title }))
    await act(async () => { pending.resolve('saved'); await pending.promise })
    expect(within(screen.getByRole('complementary')).getByRole('heading', { name: other.title })).toBeDefined()
    expect(h.props.hostActions.edit).toHaveBeenCalledTimes(1)
  })

  it('allows pausing during the delivery interval but offers no queued-message cancellation', () => {
    mount([{ ...task, deliveryFloorEndsAt: '2099-01-05T10:00:00.000Z' }])
    fireEvent.click(screen.getByRole('button', { name: task.title }))
    expect(screen.getByRole('button', { name: en['host.pause'] }).hasAttribute('disabled')).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: en['detail.more'] }))
    expect(screen.getByRole('menuitem', { name: en['host.run'] }).getAttribute('aria-disabled')).toBe('true')
    expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual([en['host.run'], en['delete.action']])
  })

  it.each([en, zh])('names when Run now returns after the minimum run interval, then offers it', async (dictionary) => {
    vi.useFakeTimers()
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })))
    vi.setSystemTime(Date.parse('2099-01-05T09:59:30.000Z'))
    const floor = '2099-01-05T10:00:00.000Z'
    const translate = makeTranslate(dictionary)
    const h = mount([{ ...task, deliveryFloorEndsAt: floor }], { t: translate })
    fireEvent.click(screen.getByRole('button', { name: task.title }))
    const more = screen.getByRole('button', { name: dictionary['detail.more'] })
    // A pointer opens the menu, so the focus that the menu gives Run now raises no tooltip.
    fireEvent.pointerDown(more)
    fireEvent.click(more)
    const run = screen.getByRole('menuitem', { name: dictionary['host.run'] })
    const reason = translate('host.runAfterInterval', {
      time: formatAvailableAt(Date.parse(floor), dictionary['time.locale'], Date.now()),
    })
    expect(run.getAttribute('aria-disabled')).toBe('true')
    expect(screen.getByRole('menuitem', { name: dictionary['host.run'], description: reason })).toBe(run)
    expect(screen.queryByRole('tooltip')).toBeNull()
    fireEvent.click(run)
    expect(h.props.hostActions.run).not.toHaveBeenCalled()
    fireEvent.pointerEnter(run, { pointerType: 'mouse' })
    act(() => { vi.advanceTimersByTime(500) })
    expect(screen.getByRole('tooltip').textContent).toBe(reason)
    // The interval ends between two clock periods; Run now returns at that instant.
    act(() => { vi.advanceTimersByTime(29_499) })
    expect(run.getAttribute('aria-disabled')).toBe('true')
    act(() => { vi.advanceTimersByTime(1) })
    expect(run.hasAttribute('aria-disabled')).toBe(false)
    expect(screen.queryByRole('tooltip')).toBeNull()
    await act(async () => { fireEvent.click(run) })
    expect(h.props.hostActions.run).toHaveBeenCalledExactlyOnceWith(task.id)
  })

  it('leaves Run now unexplained while a cause that the detail states also holds it', () => {
    mount([{ ...task, executionActive: true, deliveryFloorEndsAt: '2099-01-05T10:00:00.000Z' }])
    fireEvent.click(screen.getByRole('button', { name: task.title }))
    fireEvent.click(screen.getByRole('button', { name: en['detail.more'] }))
    const run = screen.getByRole('menuitem', { name: en['host.run'] })
    expect(run.hasAttribute('disabled')).toBe(true)
    expect(run.hasAttribute('aria-describedby')).toBe(false)
  })

  it.each([
    { name: 'disables Run now while the linked conversation it delivers to is archived', disabled: true,
      target: { kind: 'session' as const, sessionId: targetSession } },
    { name: 'disables Run now while its reserved first-run conversation is archived', disabled: true,
      target: { kind: 'new_once' as const, sessionId: targetSession, create: {} } },
    { name: 'keeps Run now for a per-run task whose latest conversation is archived', disabled: false,
      target: { kind: 'new' as const, create: {} } },
  ])('$name', ({ target, disabled }) => {
    const receipt = { targetSessionId: targetSession, scheduledAt: task.scheduledAt, deliveredAt: task.scheduledAt,
      messageId: 'delivery-message' as NonNullable<ScheduleCatalogEntry['lastDelivery']>['messageId'] }
    mount([{ ...task, target, lastDelivery: receipt }],
      { useWorkspaces: select => select({ ...workspaces, archivedSessionIds: [targetSession] }) })
    fireEvent.click(screen.getByRole('button', { name: task.title }))
    fireEvent.click(screen.getByRole('button', { name: en['detail.more'] }))
    expect(screen.getByRole('menuitem', { name: en['host.run'] }).hasAttribute('disabled')).toBe(disabled)
  })

  it('opens the actual destination of a saved delivery', async () => {
    const receipt = { targetSessionId: targetSession, scheduledAt: task.scheduledAt, deliveredAt: task.scheduledAt,
      messageId: 'delivery-message' as NonNullable<ScheduleCatalogEntry['lastDelivery']>['messageId'], prompt: 'Historical prompt' }
    const h = mount([{ ...task, lastDelivery: receipt }], { loadHistory: vi.fn<TaskManagerPageProps['loadHistory']>(async ({ id }) => ({ ok: true,
      value: { id, records: [receipt], earlierRecordsUnavailable: false, earlierRecordsPruned: false,
        retention: { days: 30, records: 200 } } })) })
    fireEvent.click(screen.getByRole('button', { name: task.title }))
    fireEvent.click(screen.getByRole('tab', { name: en['detail.records'] }))
    await screen.findByText('Historical prompt')
    const history = screen.getByRole('tabpanel')
    fireEvent.click(within(history).getByRole('button', { name: 'Report conversation' }))
    expect(h.props.onOpenSession).toHaveBeenCalledWith(targetSession)
  })

  it('closes the creation menu on Escape without opening a form', () => {
    mount([])
    fireEvent.click(screen.getByRole('button', { name: en['host.createMethod'] }))
    fireEvent.keyDown(screen.getByRole('menuitem', { name: en['host.manualCreate'] }), { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('keeps a pending manual form open until the Host answers, then selects the new task', async () => {
    const pending = Promise.withResolvers<TaskCreateOutcome>()
    mount([task], { onCreateTask: vi.fn<TaskManagerPageProps['onCreateTask']>(() => pending.promise) })
    const modal = openManual()
    fireEvent.change(within(modal).getByRole('textbox', { name: en['detail.name'] }), { target: { value: 'Morning news' } })
    fireEvent.change(within(modal).getByRole('textbox', { name: en['detail.instruction'] }), { target: { value: 'Read news' } })
    fireEvent.click(within(modal).getByRole('button', { name: en['host.create'] }))
    fireEvent.click(within(modal).getByRole('button', { name: en['host.closeCreate'] }))
    expect(screen.getByRole('dialog', { name: en['host.manualCreate'] })).toBe(modal)
    await act(async () => { pending.resolve({ created: task }); await pending.promise })
    expect(screen.queryByRole('dialog', { name: en['host.manualCreate'] })).toBeNull()
    expect(within(screen.getByRole('complementary')).getByRole('heading', { name: task.title })).toBeDefined()
  })
})

describe('Host task actions', () => {
  it.each([
    { status: 'active' as const, label: en['host.pause'], active: false },
    { status: 'paused' as const, label: en['host.resume'], active: true },
  ])('$label asks the Host to set active to $active', async ({ status, label, active }) => {
    const h = mount([{ ...task, status }])
    if (status === 'paused') fireEvent.click(screen.getByRole('button', { name: en['status.paused'] }))
    fireEvent.click(screen.getByRole('button', { name: task.title }))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: label })) })
    expect(h.props.hostActions.edit)
      .toHaveBeenCalledExactlyOnceWith({ id: task.id, action: 'update', patch: { active }, expectedUpdatedAt: task.updatedAt })
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('reports a refused pause and offers Pause again', async () => {
    mount([task], { hostActions: hostActions({ edit: vi.fn<HostTaskActions['edit']>(async () => ({ failed: 'host.saveError' })) }) })
    fireEvent.click(screen.getByRole('button', { name: task.title }))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: en['host.pause'] })) })
    expect(screen.getByRole('alert').textContent).toBe(en['host.saveError'])
    expect(screen.getByRole('button', { name: en['host.pause'] }).hasAttribute('disabled')).toBe(false)
  })

  it.each([
    { name: 'queues a run now', outcome: 'queued' as const, alert: null, notice: null },
    { name: 'states a refused run as a wait instead of an error', outcome: { failed: 'host.executionPending' as const },
      alert: null, notice: en['host.executionPending'] },
    { name: 'reports a run that could not be queued', outcome: { failed: 'host.runError' as const }, alert: en['host.runError'], notice: null },
  ])('$name', async ({ outcome, alert, notice }) => {
    const h = mount([task], { hostActions: hostActions({ run: vi.fn<HostTaskActions['run']>(async () => outcome) }) })
    fireEvent.click(screen.getByRole('button', { name: task.title }))
    fireEvent.click(screen.getByRole('button', { name: en['detail.more'] }))
    await act(async () => { fireEvent.click(screen.getByRole('menuitem', { name: en['host.run'] })) })
    expect(h.props.hostActions.run).toHaveBeenCalledExactlyOnceWith(task.id)
    expect(screen.queryByRole('alert')?.textContent ?? null).toBe(alert)
    expect(within(screen.getByRole('complementary')).queryByRole('status')?.textContent ?? null).toBe(notice)
  })

  it('keeps a refused run as the only notice after the catalog marks the task queued', async () => {
    const h = mount([task], { hostActions: hostActions({
      run: vi.fn<HostTaskActions['run']>(async () => ({ failed: 'host.executionPending' as const })),
    }) })
    fireEvent.click(screen.getByRole('button', { name: task.title }))
    fireEvent.click(screen.getByRole('button', { name: en['detail.more'] }))
    await act(async () => { fireEvent.click(screen.getByRole('menuitem', { name: en['host.run'] })) })
    // The Host requeues an undelivered message while it refuses, so the next catalog read reports the execution.
    h.update([{ ...task, executionActive: true }])
    expect(within(screen.getByRole('complementary')).getAllByRole('status').map(node => node.textContent))
      .toEqual([en['host.executionPending']])
  })

  it('ignores pause and run answers after selection moves away', async () => {
    const paused = Promise.withResolvers<{ failed: 'host.saveError' }>()
    const queued = Promise.withResolvers<{ failed: 'host.executionPending' }>()
    const other = { ...task, id: 'other-task' as ScheduleId, title: 'Other task' }
    const h = mount([task, other], { hostActions: hostActions({
      edit: vi.fn<HostTaskActions['edit']>(() => paused.promise), run: vi.fn<HostTaskActions['run']>(() => queued.promise),
    }) })
    fireEvent.click(screen.getByRole('button', { name: task.title }))
    fireEvent.click(screen.getByRole('button', { name: en['host.pause'] }))
    fireEvent.click(screen.getByRole('button', { name: other.title }))
    fireEvent.click(screen.getByRole('button', { name: en['detail.more'] }))
    fireEvent.click(screen.getByRole('menuitem', { name: en['host.run'] }))
    fireEvent.click(screen.getByRole('button', { name: task.title }))
    await act(async () => {
      paused.resolve({ failed: 'host.saveError' })
      queued.resolve({ failed: 'host.executionPending' })
      await Promise.all([paused.promise, queued.promise])
    })
    expect(screen.queryByRole('alert')).toBeNull()
    expect(within(screen.getByRole('complementary')).getByRole('heading', { name: task.title })).toBeDefined()
    expect(h.props.hostActions.edit).toHaveBeenCalledTimes(1)
    expect(h.props.hostActions.run).toHaveBeenCalledExactlyOnceWith(other.id)
  })
})

describe('rule editing', () => {
  it('saves an unchanged row so the Host can normalize its stored shape', async () => {
    const h = mount()
    const detail = openEdit()
    await save(detail)
    expect(within(detail).getByRole('button', { name: en['host.edit'] })).toBeDefined()
    expect(h.props.hostActions.edit).toHaveBeenCalledWith({ id: task.id, action: 'update', expectedUpdatedAt: task.updatedAt, patch: { title: task.title } })
  })

  it('discards a staged change on Cancel', () => {
    const h = mount()
    const detail = openEdit()
    fireEvent.change(within(detail).getByRole('textbox', { name: en['detail.name'] }), { target: { value: 'Renamed' } })
    fireEvent.click(within(detail).getByRole('button', { name: en['rule.cancel'] }))
    expect(within(detail).getByRole('heading', { name: task.title })).toBeDefined()
    fireEvent.click(within(detail).getByRole('button', { name: en['host.edit'] }))
    expect(within(detail).getByRole<HTMLInputElement>('textbox', { name: en['detail.name'] }).value).toBe(task.title)
    expect(h.props.hostActions.edit).not.toHaveBeenCalled()
  })

  it('shows the configured interval while editing a task that starts a new conversation for every run', async () => {
    mount([{ ...task, target: { kind: 'new', create: {} } }])
    const detail = openEdit()
    await within(detail).findByText(t('host.newSessionInterval', { interval: '2 hours' }))
  })

  it('saves the weekdays that a weekly rule toggles', async () => {
    const h = mount()
    const detail = openEdit()
    fireEvent.click(weekday(en['frequency.weekday.2']))
    fireEvent.click(weekday(en['frequency.weekday.1']))
    const pressed = [en['frequency.weekday.1'], en['frequency.weekday.2'], en['frequency.weekday.3']]
      .map(day => weekday(day).getAttribute('aria-pressed'))
    expect(pressed).toEqual(['false', 'true', 'true'])
    await save(detail)
    expectSavedRule(h, 'DTSTART;TZID=UTC:20990101T090000\nRRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=TU,WE')
  })

  it('saves Monday to Friday as a weekly rule', async () => {
    const h = mount()
    const detail = openEdit()
    chooseRepeat(detail, en['rule.weekdays'])
    expect(within(detail).getByRole('button', { name: new RegExp('^' + en['rule.repeat'] + ' ') }).textContent).toContain(en['rule.weekdays'])
    await save(detail)
    expectSavedRule(h, 'DTSTART;TZID=UTC:20990101T090000\nRRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,TU,WE,TH,FR')
  })

  it('steps the repeat interval with its arrows, never below 1', async () => {
    const h = mount()
    const detail = openEdit()
    const interval = within(stepper(en['host.interval']))
    expect(interval.getByRole('button', { name: en['timing.intervalDecrease'] }).hasAttribute('disabled')).toBe(true)
    fireEvent.click(interval.getByRole('button', { name: en['timing.intervalIncrease'] }))
    fireEvent.click(interval.getByRole('button', { name: en['timing.intervalIncrease'] }))
    fireEvent.click(interval.getByRole('button', { name: en['timing.intervalDecrease'] }))
    expect(interval.getByRole<HTMLInputElement>('spinbutton').value).toBe('2')
    await save(detail)
    expectSavedRule(h, 'DTSTART;TZID=UTC:20990101T090000\nRRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE')
  })

  it('keeps the day of the month within 1 to 31 and ignores a blank or fractional entry', async () => {
    const h = mount()
    const detail = openEdit()
    chooseRepeat(detail, en['host.frequency.monthly'])
    const day = within(stepper(en['host.monthDay']))
    const input = day.getByRole<HTMLInputElement>('spinbutton')
    expect(input.value).toBe('1')
    expect(day.getByRole('button', { name: en['timing.intervalDecrease'] }).hasAttribute('disabled')).toBe(true)
    fireEvent.click(day.getByRole('button', { name: en['timing.intervalIncrease'] }))
    expect(input.value).toBe('2')
    fireEvent.change(input, { target: { value: '40' } })
    expect(input.value).toBe('31')
    expect(day.getByRole('button', { name: en['timing.intervalIncrease'] }).hasAttribute('disabled')).toBe(true)
    for (const value of ['', '2.5']) {
      fireEvent.change(input, { target: { value } })
      expect(input.value).toBe('31')
    }
    fireEvent.change(input, { target: { value: '15' } })
    fireEvent.click(day.getByRole('button', { name: en['timing.intervalDecrease'] }))
    expect(input.value).toBe('14')
    await save(detail)
    expectSavedRule(h, 'DTSTART;TZID=UTC:20990101T090000\nRRULE:FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=14,-1;BYSETPOS=1')
  })

  it('opens a stored monthly rule on its day of the month', () => {
    mount([{ ...task, rrule: 'DTSTART;TZID=UTC:20990101T090000\nRRULE:FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=15,-1;BYSETPOS=1' }])
    const detail = openEdit()
    expect(within(detail).getByRole('button', { name: new RegExp('^' + en['rule.repeat'] + ' ') }).textContent).toContain(en['host.frequency.monthly'])
    expect(within(detail).getByRole<HTMLInputElement>('spinbutton', { name: en['host.monthDay'] }).value).toBe('15')
  })

  it('keeps an empty Custom draft editable after Save reports its validation error', async () => {
    const custom = 'DTSTART;TZID=UTC:20990101T090000\nRRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=3'
    const h = mount([{ ...task, rrule: custom }])
    vi.mocked(h.props.hostActions.edit).mockResolvedValueOnce({ failed: 'host.invalidRule' })
    const detail = openEdit()
    const rule = within(detail).getByRole<HTMLTextAreaElement>('textbox', { name: en['host.customRule'] })
    expect(rule.value).toBe(custom)
    fireEvent.change(rule, { target: { value: ' ' } })
    expect(within(detail).getByRole('button', { name: en['rule.save'] }).hasAttribute('disabled')).toBe(false)
    await save(detail)
    expect(within(detail).getByRole('alert').textContent).toBe(en['host.invalidRule'])
    expect(rule.value).toBe(' ')
    fireEvent.change(rule, { target: { value: custom.replace('COUNT=3', 'COUNT=5') } })
    await save(detail)
    expect(h.props.hostActions.edit).toHaveBeenLastCalledWith({ id: task.id, action: 'update', expectedUpdatedAt: task.updatedAt,
      patch: { timing: { kind: 'rrule', rrule: custom.replace('COUNT=3', 'COUNT=5') } } })
  })

  it('turns a guided rule into editable text when Custom is chosen', () => {
    mount()
    const detail = openEdit()
    chooseRepeat(detail, en['host.frequency.advanced'])
    expect(within(detail).getByRole<HTMLTextAreaElement>('textbox', { name: en['host.customRule'] }).value).toBe(task.rrule)
    expect(within(detail).queryByRole('spinbutton', { name: en['host.interval'] })).toBeNull()
  })

  it('keeps an existing daily rule readable and permits replacing it through Custom', async () => {
    pinSystemZone('UTC')
    const h = mount([{ ...task, kind: 'daily', time: '09:00:00.125', timeZone: 'Asia/Shanghai' }])
    const detail = openEdit()
    expect(within(detail).getByText(t('frequency.daily', { time: '09:00', timeZone: zoneLabel('Asia/Shanghai', t) }))).toBeDefined()
    const input = within(detail).getByRole<HTMLTextAreaElement>('textbox', { name: en['host.customRule'] })
    expect(input.value).toBe('')
    fireEvent.change(input, { target: { value: '0 9 * * 1-5' } })
    await save(detail)
    expect(h.props.hostActions.edit).toHaveBeenCalledWith({ id: task.id, action: 'update', expectedUpdatedAt: task.updatedAt,
      patch: { timing: { kind: 'cron', cron: { expression: '0 9 * * 1-5', time_zone: 'Asia/Shanghai' } } } })
  })

  it('creates Custom Cron using its explicit selected zone', async () => {
    pinSystemZone('UTC')
    const h = mount([])
    const modal = openManual()
    fireEvent.change(within(modal).getByRole('textbox', { name: en['detail.name'] }), { target: { value: 'Cron task' } })
    fireEvent.change(within(modal).getByRole('textbox', { name: en['detail.instruction'] }), { target: { value: 'Report' } })
    chooseRepeat(modal, en['host.frequency.advanced'])
    expect(within(modal).getByRole('textbox', { name: 'Customize' })).toBeDefined()
    expect(within(modal).queryByText(/Enter DTSTART|five-field Cron/)).toBeNull()
    fireEvent.change(within(modal).getByRole('textbox', { name: en['host.customRule'] }), { target: { value: '*/5 * * * *' } })
    expect(within(modal).getByRole('button', { name: new RegExp('^' + en['timing.zone'] + ' ') })).toBeDefined()
    fireEvent.click(within(modal).getByRole('button', { name: en['host.create'] }))
    await waitFor(() => { expect(h.props.onCreateTask).toHaveBeenCalledOnce() })
    expect(vi.mocked(h.props.onCreateTask).mock.calls[0]?.[0]).toMatchObject({ timing: { kind: 'cron', cron: { expression: '*/5 * * * *', time_zone: 'UTC' } } })
  })

  it('edits Cron text without converting the expression or its zone into RRULE', async () => {
    const cron = { ...task, kind: 'cron' as const, expression: '0 9 * * 1-5', timeZone: 'Asia/Shanghai' }
    const h = mount([cron])
    vi.mocked(h.props.hostActions.edit).mockResolvedValueOnce({ failed: 'host.invalidRule' })
    const detail = openEdit()
    const text = within(detail).getByRole<HTMLTextAreaElement>('textbox', { name: en['host.customRule'] })
    expect(text.value).toBe(cron.expression)
    fireEvent.change(text, { target: { value: ' ' } })
    expect(within(detail).getByRole('button', { name: en['rule.save'] }).hasAttribute('disabled')).toBe(false)
    await save(detail)
    expect(within(detail).getByRole('alert').textContent).toBe(en['host.invalidRule'])
    expect(text.value).toBe(' ')
    fireEvent.change(text, { target: { value: '0 10 * * 1-5' } })
    await save(detail)
    expect(h.props.hostActions.edit).toHaveBeenCalledWith({ id: task.id, action: 'update', expectedUpdatedAt: task.updatedAt,
      patch: { timing: { kind: 'cron', cron: { expression: '0 10 * * 1-5', time_zone: 'Asia/Shanghai' } } } })
  })

  it('closes a rule menu on Escape and keeps the edit open', () => {
    mount()
    const detail = openEdit()
    const repeat = within(detail).getByRole('button', { name: new RegExp('^' + en['rule.repeat'] + ' ') })
    fireEvent.click(repeat)
    const daily = screen.getByRole('menuitem', { name: en['rule.daily'] })
    daily.focus()
    fireEvent.keyDown(daily, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(repeat)
    expect(within(detail).getByRole('button', { name: en['rule.save'] })).toBeDefined()
  })
})

describe('stored timing preservation', () => {
  it.each([
    'FREQ=DAILY;BYHOUR=9,15;BYMINUTE=0;BYSETPOS=1,2',
    'FREQ=MONTHLY;BYMONTHDAY=1,15,-1;BYSETPOS=1,2',
    'FREQ=WEEKLY;BYDAY=MO;COUNT=3',
    'FREQ=DAILY;BYSECOND=30',
    'FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYSETPOS=2',
    'FREQ=DAILY;BYSETPOS=1',
    'FREQ=DAILY;BYHOUR=9',
    'FREQ=WEEKLY;INTERVAL=1',
    'FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=15,-1',
    'FREQ=MONTHLY;INTERVAL=1;BYSETPOS=1',
  ])('keeps unsupported timing verbatim: %s', (rule) => {
    const record = { ...task, rrule: `DTSTART;TZID=UTC:20990101T090000\nRRULE:${rule}` }
    expect(timingFromRecord(record)).toMatchObject({ frequency: 'advanced', rrule: record.rrule })
  })

  it('preserves a task preset when its default project has not changed', () => {
    const original = { ...task, target: { ...task.target, kind: 'new_once' as const, sessionId: targetSession,
      create: { agentPreset: 'default' as NonNullable<Extract<typeof task.target, { kind: 'new_once' }>['create']['agentPreset']> } } }
    expect(draftTarget(taskDraft(original), original)).toMatchObject({ create: { agentPreset: 'default' } })
  })

  it('describes RRULE intervals and Cron timing in the authoritative zone', () => {
    const translate = makeTranslate(en)
    expect(formatScheduleFrequency({ ...task, rrule: task.rrule.replace('INTERVAL=1', 'INTERVAL=2') }, translate))
      .toContain('Every 2 weeks')
    const cron = {
      ...task, kind: 'cron', expression: '0 9 * * 1-5', timeZone: 'UTC',
    } as const
    expect(formatScheduleFrequency(cron, translate, { system: 'UTC', label: zone => zone })).toBe('Mon–Fri at 09:00')
    expect(formatScheduleFrequency(cron, translate, { system: 'Asia/Shanghai', label: zone => zone }))
      .toBe('Mon–Fri at 09:00 (UTC)')
  })

  it.each([
    { name: 'a weekly rule anchored in UTC', rrule: 'DTSTART:20990101T090000Z\nRRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=MO',
      timing: { frequency: 'weekly', timeZone: 'UTC', weekdays: [1] } },
    { name: 'a daily rule at its first position', timing: { frequency: 'daily', dailyTime: '09:00' },
      rrule: 'DTSTART;TZID=UTC:20990101T090000\nRRULE:FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYSETPOS=1' },
    { name: 'a monthly rule with its last-day fallback', timing: { frequency: 'monthly', monthDay: 15 },
      rrule: 'DTSTART;TZID=UTC:20990101T090000\nRRULE:FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=15,-1;BYSETPOS=1' },
    { name: 'a rule without DTSTART', rrule: 'RRULE:FREQ=DAILY;INTERVAL=1', timing: { frequency: 'advanced', timeZone: 'UTC' } },
    { name: 'a DTSTART without RRULE', rrule: 'DTSTART;TZID=UTC:20990101T090000', timing: { frequency: 'advanced', timeZone: 'UTC' } },
  ])('reads $name as $timing.frequency', ({ rrule, timing }) => {
    expect(timingFromRecord({ ...task, rrule })).toMatchObject(timing)
  })
})

describe('time zone menu', () => {
  const RECENT = 'dsh.schedule.recent-time-zones.v1'
  beforeEach(() => { localStorage.clear() })

  it('lists zones that share a name once and keeps the stored zone when that name is chosen', async () => {
    pinSystemZone('Asia/Shanghai')
    vi.mocked(Intl.supportedValuesOf).mockReturnValue(['America/Detroit', 'America/New_York', 'America/Toronto'])
    const h = mount([{ ...task, rrule: task.rrule.replace('TZID=UTC', 'TZID=America/Toronto') }])
    const detail = openEdit()
    const menu = openZones(detail)
    searchZones('america/')
    expect(within(menu).getAllByRole('menuitem').map(item => item.textContent))
      .toEqual([zoneName('America/Toronto', 'Asia/Shanghai', t)])
    fireEvent.click(within(menu).getByRole('menuitem'))
    expect(JSON.parse(localStorage.getItem(RECENT)!)).toEqual(['America/Toronto', 'Asia/Shanghai', 'UTC'])
    await save(detail)
    expect(h.props.hostActions.edit).toHaveBeenCalledWith({ id: task.id, action: 'update', expectedUpdatedAt: task.updatedAt, patch: { title: task.title } })
  })

  it('saves the zone whose id the search names exactly', async () => {
    pinSystemZone('UTC')
    vi.mocked(Intl.supportedValuesOf).mockReturnValue(['Europe/Athens', 'Europe/Bucharest'])
    const h = mount()
    const detail = openEdit()
    openZones(detail)
    searchZones('europe/bucharest')
    fireEvent.click(screen.getByRole('menuitem', { name: zoneName('Europe/Bucharest', 'UTC', t) }))
    await save(detail)
    expectSavedRule(h, 'DTSTART;TZID=Europe/Bucharest:20990101T090000\nRRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,WE')
  })

  it('offers the system zone alone without a separator and says when no zone matches', () => {
    pinSystemZone('UTC')
    mount()
    const menu = openZones(openEdit())
    expect(within(menu).getAllByRole('menuitem').map(item => item.textContent)).toEqual([zoneName('UTC', 'UTC', t)])
    expect(menu.querySelector('[role="separator"]')).toBeNull()
    searchZones('zzz')
    expect(screen.getByRole('menuitem', { name: en['timing.zoneNoResults'] }).hasAttribute('disabled')).toBe(true)
  })

  it('lists recent zones first, once per name, then the other zones', () => {
    pinSystemZone('UTC')
    vi.mocked(Intl.supportedValuesOf).mockReturnValue(['America/New_York', 'America/Toronto', 'Asia/Tokyo', 'Europe/Berlin'])
    localStorage.setItem(RECENT, JSON.stringify(['Europe/Paris', 'Asia/Tokyo', 'America/Toronto', 'America/New_York']))
    mount()
    const menu = openZones(openEdit())
    expect(Array.from(menu.querySelectorAll('[role="menuitem"], [role="separator"]'), row => row.getAttribute('role')))
      .toEqual(['menuitem', 'menuitem', 'separator', 'menuitem', 'menuitem'])
    expect(within(menu).getAllByRole('menuitem').map(item => item.textContent))
      .toEqual(['Asia/Tokyo', 'America/Toronto', 'UTC', 'Europe/Berlin'].map(zone => zoneName(zone, 'UTC', t)))
  })

  it('closes on its trigger and clears the search', () => {
    mount()
    const detail = openEdit()
    openZones(detail)
    searchZones('zzz')
    fireEvent.click(within(detail).getByRole('button', { name: new RegExp('^' + en['timing.zone'] + ' ') }))
    expect(screen.queryByRole('menu')).toBeNull()
    openZones(detail)
    expect(screen.getByRole<HTMLInputElement>('searchbox', { name: en['timing.zoneSearch'] }).value).toBe('')
  })
})

/** Read the authoritative RRULE selected by a form submission. */
function rruleOf(timing: import('@deepseek-ai/dsh-schedule/client').ScheduleTiming | undefined): string {
  if (timing?.kind !== 'rrule') throw new Error('expected RRULE timing')
  return timing.rrule
}
