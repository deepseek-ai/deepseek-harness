// @vitest-environment jsdom
/**
 * TaskDetail behaviors the Tasks page suite leaves unreached: an authoritative
 * refresh under a staged rule draft, a weekly choice seeded from a Sunday
 * occurrence, each rule Menu's own close path (a pointer press outside the
 * anchor and its portaled list) rather than the page's Escape guard, the day set
 * one task's card remembers across a kind detour, the save response that a task
 * switch retires, both elapsed-interval stepper arrows and their emptied field,
 * a save failure stated on the Delivery records tab, and the cron rows' close
 * paths and occurrence-seeded day shape.
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { ScheduleCatalogEntry, ScheduleId, ScheduleUpdateResult } from '@deepseek-ai/dsh-schedule/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { TaskManagerPage, type TaskManagerPageProps } from '../src/client/TaskManagerPage.tsx'
import { mergeRuleDraft } from '../src/client/TaskDetail.tsx'
import type { CatalogSnapshot } from '../src/client/catalog-source.ts'
import { timingSnapshot } from '../src/client/task-timing.ts'
import { en } from '../src/client/task-manager-locales.ts'
import { zoneOffsetMinutes } from './zone-fixture.ts'
import css from '../src/client/TaskManagerPage.module.css'

const at: ScheduleCatalogEntry = {
  id: 'task-at' as ScheduleId, sessionId: 'session-alpha' as SessionId, kind: 'at', status: 'active',
  title: 'Review release', prompt: 'Review release', scheduledAt: '2026-10-01T09:00:00.000Z',
}

const every: ScheduleCatalogEntry = {
  id: 'task-every' as ScheduleId, sessionId: 'session-beta' as SessionId, kind: 'every', status: 'active',
  title: 'Check metrics', prompt: 'Check metrics', everySeconds: 301, scheduledAt: '2026-10-01T09:30:00.000Z',
}

const daily: ScheduleCatalogEntry = {
  id: 'task-daily' as ScheduleId, sessionId: 'session-gamma' as SessionId, kind: 'daily', status: 'active',
  title: 'Daily weather', prompt: 'Daily weather', time: '23:00:00.000', timeZone: 'Asia/Shanghai',
  scheduledAt: '2026-10-01T15:00:00.000Z',
}

const weeklyMonday: ScheduleCatalogEntry = {
  id: 'task-weekly-monday' as ScheduleId, sessionId: 'session-alpha' as SessionId, kind: 'weekly', status: 'active',
  title: 'Weekly Monday', prompt: 'Weekly Monday', time: '09:30:00.000', timeZone: 'Asia/Shanghai',
  weekdays: [1], scheduledAt: '2026-10-05T01:30:00.000Z',
}

const weekdayRule: ScheduleCatalogEntry = {
  id: 'task-weekday-rule' as ScheduleId, sessionId: 'session-beta' as SessionId, kind: 'weekly', status: 'active',
  title: 'Weekday rule', prompt: 'Weekday rule', time: '09:30:00.000', timeZone: 'Asia/Shanghai',
  weekdays: [1, 2, 3, 4, 5], scheduledAt: '2026-10-05T01:30:00.000Z',
}

const sparseWeekdays: ScheduleCatalogEntry = {
  id: 'task-sparse' as ScheduleId, sessionId: 'session-beta' as SessionId, kind: 'weekly', status: 'active',
  title: 'Sparse weekdays', prompt: 'Sparse weekdays', time: '09:30:00.000', timeZone: 'Asia/Shanghai',
  weekdays: [1, 3], scheduledAt: '2026-10-05T01:30:00.000Z',
}

const cron: ScheduleCatalogEntry = {
  id: 'task-cron' as ScheduleId, sessionId: daily.sessionId, kind: 'cron', status: 'active',
  title: 'Cron report', prompt: 'Cron report', expression: '0 9 * * 1-5', timeZone: 'UTC',
  scheduledAt: '2026-10-05T01:30:00.000Z',
}

/** The same `every` task after another client switched its kind to Every day. */
const movedToDaily: ScheduleCatalogEntry = {
  id: every.id, sessionId: every.sessionId, kind: 'daily', status: 'active',
  title: every.title, prompt: every.prompt, time: '09:30:00.000', timeZone: 'UTC',
  scheduledAt: every.scheduledAt,
}

const sessions: SessionListState = {
  ids: [at.sessionId, every.sessionId, daily.sessionId],
  byId: Object.fromEntries([at, every, daily].map(record => [record.sessionId, {
    id: record.sessionId, displayTitle: record.sessionId, running: false, blank: false, updatedAt: 0, retainedBy: {},
  }] as const)),
  phase: 'ready', projectionsBySession: {},
}

const workspaces: WorkspaceSnapshot = { items: [], archivedSessionIds: [], pinnedSessionIds: [], state: 'idle', phase: 'ready', error: null }

afterEach(cleanup)

// jsdom has no `scrollIntoView`, which an open clock panel calls on the row that
// shows the staged value.
beforeEach(() => { Element.prototype.scrollIntoView = vi.fn() })

/**
 * The Time row's picker trigger, whose text is the staged 24-hour clock.
 * @returns the trigger button.
 */
function timeField(): HTMLButtonElement {
  return within(screen.getByRole('region', { name: en['rule.title'] }))
    .getByLabelText<HTMLButtonElement>(en['timing.time'])
}

/**
 * Render the Tasks page over one catalog snapshot and let a case replace it.
 * @param records - catalog rows the page lists.
 * @param status - initial catalog query state; defaults to a settled read.
 * @returns the update callbacks and the timing-update spy.
 */
function mount(
  records: readonly ScheduleCatalogEntry[],
  status: 'loading' | 'ready' | 'error' = 'ready',
) {
  let snapshot: CatalogSnapshot<ScheduleCatalogEntry> = {
    records, status, deleting: [], settled: status === 'ready', readRequest: 0, readSettled: 0,
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
    loadHistory: vi.fn<TaskManagerPageProps['loadHistory']>(async ({ id }) => ({
      ok: true, value: {
        id, records: [], earlierRecordsUnavailable: false,
        earlierRecordsPruned: false, retention: { days: 30, records: 200 },
      },
    })),
    t: makeTranslate(en),
  }
  const view = render(<TaskManagerPage {...props} />)
  return {
    updateTiming: vi.mocked(props.onUpdateTiming),
    /** Publish an authoritative catalog snapshot, as a Host refresh does. */
    update(next: readonly ScheduleCatalogEntry[]) {
      snapshot = { ...snapshot, records: next }
      view.rerender(<TaskManagerPage {...props} />)
    },
    /** Publish one catalog query state, as a refresh or a failure does. */
    setStatus(next: 'loading' | 'ready' | 'error') {
      snapshot = { ...snapshot, status: next }
      view.rerender(<TaskManagerPage {...props} />)
    },
  }
}

/** Select one listed task, opening its detail. */
function selectTask(name: string): void {
  fireEvent.click(screen.getByRole('button', { name }))
}

/** The Repeat selector of the shown rule's Run time card. */
function repeatButton(): HTMLElement {
  return within(screen.getByRole('region', { name: en['rule.title'] }))
    .getByRole('button', { name: new RegExp(`^${en['rule.repeat']}`) })
}

/** The Time zone selector of the shown rule's Run time card. */
function zoneButton(): HTMLElement {
  return within(screen.getByRole('region', { name: en['rule.title'] }))
    .getByRole('button', { name: new RegExp(`^${en['timing.zone']}`) })
}

/** The Weekday toggle group of the shown rule's Run time card. */
function weekdayGroup(): HTMLElement {
  return within(screen.getByRole('region', { name: en['rule.title'] }))
    .getByRole('group', { name: en['rule.weekday'] })
}

/** Pressed state of the Weekday group's seven toggles, Monday through Sunday. */
function weekdayPressed(group: HTMLElement): (string | null)[] {
  return within(group).getAllByRole('button').map(day => day.getAttribute('aria-pressed'))
}

/**
 * The pressed state of one named ISO weekday alone.
 * @param weekday - ISO weekday to read, Monday `1` through Sunday `7`.
 * @returns whether that day's toggle is pressed.
 */
function weekdayOn(weekday: 1 | 2 | 3 | 4 | 5 | 6 | 7): string | null {
  const name = en['rule.weekdayOption'].replace('{weekday}', en[`frequency.weekday.${weekday}`])
  return within(weekdayGroup()).getByRole('button', { name }).getAttribute('aria-pressed')
}

/**
 * Press one named ISO weekday's toggle in the shown rule's Weekday group.
 * @param weekday - ISO weekday to toggle, Monday `1` through Sunday `7`.
 */
function clickWeekday(weekday: 1 | 2 | 3 | 4 | 5 | 6 | 7): void {
  const name = en['rule.weekdayOption'].replace('{weekday}', en[`frequency.weekday.${weekday}`])
  fireEvent.click(within(weekdayGroup()).getByRole('button', { name }))
}

/** Choose one Repeat menu entry in the shown rule's Run time card. */
function clickRepeat(key: 'rule.cron' | 'rule.daily' | 'rule.weekdays' | 'rule.weekly'): void {
  fireEvent.click(repeatButton())
  fireEvent.click(screen.getByRole('menuitem', { name: en[key] }))
}

/**
 * Pin the browser-resolved zone for one case, so menu order and the system
 * suffix do not depend on the host zone.
 * @param timeZone - IANA zone the component must resolve as the system zone.
 * @returns a function that restores the spy when the case ends.
 */
function pinSystemZone(timeZone: string): () => void {
  const options = new Intl.DateTimeFormat().resolvedOptions()
  const spy = vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions')
    .mockReturnValue({ ...options, timeZone })
  return () => { spy.mockRestore() }
}

/** The staged-edit bar's Save changes action. */
function clickSave(): void {
  fireEvent.click(screen.getByRole('button', { name: en['rule.save'] }))
}

/** Press the pointer outside an open Menu's anchor and portaled list. */
function pressOutsideMenus(): void {
  fireEvent.pointerDown(document.body)
}

/** The elapsed-interval quantity input of the shown rule's Run time card. */
function intervalField(): HTMLInputElement {
  return screen.getByLabelText<HTMLInputElement>(en['timing.interval'])
}

/**
 * Press one arrow of the elapsed-interval stepper.
 * @param key - dictionary key of the arrow's accessible name.
 */
function clickIntervalArrow(key: 'timing.intervalIncrease' | 'timing.intervalDecrease'): void {
  fireEvent.click(screen.getByRole('button', { name: en[key] }))
}

/** The Frequency selector of the cron builder's rows. */
function frequencyButton(): HTMLElement {
  return within(screen.getByRole('region', { name: en['rule.title'] }))
    .getByRole('button', { name: new RegExp(`^${en['cronForm.frequency']}`) })
}

/**
 * Open the cron builder's Frequency menu and choose one shape.
 * @param key - dictionary key of the chosen shape's menu label.
 */
function chooseCronShape(key: 'rule.cronLabel' | 'cronForm.daily' | 'cronForm.weekly'): void {
  fireEvent.click(frequencyButton())
  fireEvent.click(screen.getByRole('menuitem', { name: en[key] }))
}

/** The Delivery records tab of the shown detail. */
function recordsTab(): HTMLElement {
  return screen.getByRole('tab', { name: en['detail.records'] })
}

/** The bar-side save failure line, or null while no failure shows. */
function saveFailure(): HTMLElement | null {
  return document.querySelector<HTMLElement>(`.${css.saveFailure}`)
}

describe('TaskDetail authoritative refresh', () => {
  it('shows the refreshed stored rule while the draft is clean', () => {
    const h = mount([daily])
    selectTask('Daily weather')
    expect(timeField().textContent).toBe('23:00:00')

    const refreshed: ScheduleCatalogEntry = { ...daily, time: '21:15:00.000' }
    h.update([refreshed])
    expect(timeField().textContent).toBe('21:15:00')
    // The replaced values are the stored ones, so the draft is still clean.
    expect(screen.queryByRole('button', { name: en['rule.save'] })).toBeNull()
  })

  it('keeps a staged interval draft and expects the refreshed record on save', () => {
    const h = mount([every])
    selectTask('Check metrics')
    fireEvent.change(screen.getByLabelText<HTMLInputElement>(en['timing.interval']), { target: { value: '600' } })

    const refreshed: ScheduleCatalogEntry = { ...every, everySeconds: 302 }
    h.update([refreshed])
    expect(screen.getByLabelText<HTMLInputElement>(en['timing.interval']).value).toBe('600')
    clickSave()
    expect(h.updateTiming).toHaveBeenCalledExactlyOnceWith({
      sessionId: every.sessionId, id: every.id, expected: timingSnapshot(refreshed),
      change: { kind: 'every', every_seconds: 600 },
    })
  })

  it('takes a refreshed rule kind while the timing draft is clean', () => {
    const h = mount([every])
    selectTask('Check metrics')
    expect(screen.getByLabelText<HTMLInputElement>(en['timing.interval']).value).toBe('301')

    // Another client switched the rule to Every day. No timing value was staged,
    // so the refreshed record replaces the card as its own clean rule instead of
    // leaving the old interval rule staged against the new kind.
    h.update([movedToDaily])
    expect(timeField().textContent).toBe('09:30:00')
    expect(screen.queryByLabelText(en['timing.interval'])).toBeNull()
    expect(screen.queryByRole('button', { name: en['rule.save'] })).toBeNull()
  })

  it('keeps the staged rule whole when the refreshed record switches kind', () => {
    const h = mount([every])
    selectTask('Check metrics')
    fireEvent.change(screen.getByLabelText<HTMLInputElement>(en['timing.interval']), { target: { value: '7200' } })

    h.update([movedToDaily])
    // The staged interval must not survive as a hidden field of a kind that does
    // not state it: the card keeps the local interval rule whole, so the reader
    // sees what a save would send rather than a mixed rule.
    expect(screen.getByLabelText<HTMLInputElement>(en['timing.interval']).value).toBe('7200')
    expect(screen.queryByLabelText(en['timing.time'])).toBeNull()
    expect(screen.getByRole('button', { name: en['rule.save'] })).toBeDefined()
  })

  it('keeps the card choice agreeing with the weekday set a refresh merges in', () => {
    const h = mount([sparseWeekdays])
    selectTask('Sparse weekdays')
    // The reader adds Friday to the stored Monday-and-Wednesday rule.
    clickWeekday(5)
    expect(weekdayOn(5)).toBe('true')

    // Another client widens the stored rule to Monday to Friday, whose own choice
    // reads as Monday to Friday. The staged set is what the card keeps, so its
    // choice has to stay Weekly: the Weekday row exists only for that choice, and
    // the Repeat value must not read as the choice the kept set does not match.
    h.update([{ ...sparseWeekdays, weekdays: [1, 2, 3, 4, 5] }])
    expect(weekdayPressed(weekdayGroup()))
      .toEqual(['true', 'false', 'true', 'false', 'true', 'false', 'false'])
    expect(repeatButton().textContent).toContain(en['rule.weekly'])
    expect(repeatButton().textContent).not.toContain(en['rule.weekdays'])
  })

  it('keeps an edited name and takes a refreshed time for the untouched field', () => {
    const h = mount([daily])
    selectTask('Daily weather')
    fireEvent.change(screen.getByLabelText<HTMLInputElement>(en['detail.name']), { target: { value: 'Weather check' } })

    const refreshed: ScheduleCatalogEntry = { ...daily, time: '21:15:00.000' }
    h.update([refreshed])
    expect(screen.getByLabelText<HTMLInputElement>(en['detail.name']).value).toBe('Weather check')
    // The concurrent remote edit to another field survives the unsaved name.
    expect(timeField().textContent).toBe('21:15:00')
    expect(screen.getByRole('button', { name: en['rule.save'] })).toBeDefined()
  })

  it('keeps a newer authoritative refresh when an older save response lands', async () => {
    const h = mount([at])
    selectTask('Review release')
    fireEvent.change(screen.getByLabelText<HTMLInputElement>(en['detail.name']), { target: { value: 'Renamed locally' } })
    const pending = Promise.withResolvers<RemoteResult<ScheduleUpdateResult>>()
    h.updateTiming.mockReturnValueOnce(pending.promise)
    clickSave()
    expect(h.updateTiming).toHaveBeenCalledOnce()

    // Another writer's newer record reaches the catalog before this save answers.
    const newer: ScheduleCatalogEntry = { ...at, prompt: 'Prompt changed elsewhere' }
    h.update([newer])

    await act(async () => {
      pending.resolve({ ok: true, value: { id: at.id, updated: true, record: at } })
      await pending.promise
    })
    // The answer describes the record this save submitted, so it must not put the
    // older instruction back over the refresh that already landed; the newer
    // record stays authoritative and the completed save leaves no draft behind.
    expect(screen.getByLabelText<HTMLTextAreaElement>(en['detail.instruction']).value).toBe('Prompt changed elsewhere')
    expect(screen.getByLabelText<HTMLInputElement>(en['detail.name']).value).toBe('Review release')
    expect(screen.queryByRole('button', { name: en['rule.save'] })).toBeNull()
  })

  it('leads the scrolling detail with a failed refresh and its Retry', () => {
    const h = mount([daily])
    selectTask('Daily weather')
    const detail = screen.getByRole('complementary', { name: en['detail.label'] })
    const scroll = detail.querySelector<HTMLElement>(`.${css.detailScroll}`)!

    h.setStatus('error')
    const alert = within(detail).getByRole('alert')
    expect(alert.textContent).toBe(en['list.error'])
    const retry = within(detail).getByRole('button', { name: en['list.retry'] })
    expect(alert.parentElement?.contains(retry)).toBe(true)
    // The feedback leads this region, above the name control and the Run time
    // card, so a long rule form never pushes it out of view; it stays inside
    // the region so a start or settle moves no fixed row above it.
    expect(scroll.firstElementChild?.contains(alert)).toBe(true)
    const rule = within(detail).getByRole('region', { name: en['rule.title'] })
    expect(scroll.contains(rule)).toBe(true)
    expect(alert.compareDocumentPosition(rule) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})

type RuleShown = Parameters<typeof mergeRuleDraft>[1]

/** One complete staged value set, with any field replaced by an override. */
function rule(
  overrides: Omit<Partial<RuleShown>, 'draft'> & { draft?: Partial<RuleShown['draft']> } = {},
): RuleShown {
  const { draft, ...rest } = overrides
  return {
    title: 'Daily weather',
    prompt: 'Daily weather',
    kind: 'daily',
    draft: {
      date: '2026-10-01', time: '23:00:00.000', timeZone: 'Asia/Shanghai',
      seconds: '300', expression: '0 1 * * *', ...draft,
    },
    weekdays: [1, 2, 3, 4, 5],
    ...rest,
  }
}

describe('mergeRuleDraft', () => {
  const stored = rule()

  it('takes every field of the refreshed record while the draft is clean', () => {
    const authoritative = rule({
      title: 'Remote', prompt: 'Remote prompt', kind: 'weekly',
      draft: { date: '2026-11-02', time: '09:00:00.000', timeZone: 'UTC', seconds: '600', expression: '30 8 * * *' },
      weekdays: [6],
    })
    expect(mergeRuleDraft(authoritative, stored, stored)).toEqual(authoritative)
  })

  it('keeps the staged rule whole when the draft switches kind', () => {
    // The draft stages a cron rule against a stored every-day rule, so the
    // refreshed record describes a rule the draft does not: the whole staged rule
    // stays, and no field of it is replaced by the refreshed one.
    const draft = rule({
      title: 'Edited', prompt: 'Edited prompt', kind: 'cron',
      draft: { date: '2026-12-03', time: '08:00:00.000', timeZone: 'Europe/Berlin', seconds: '900', expression: '15 7 * * *' },
      weekdays: [7],
    })
    const authoritative = rule({
      title: 'Remote', prompt: 'Remote prompt', kind: 'every',
      draft: { date: '2027-01-04', time: '07:00:00.000', timeZone: 'UTC', seconds: '1200', expression: '45 6 * * *' },
      weekdays: [3, 5],
    })
    expect(mergeRuleDraft(authoritative, draft, stored)).toEqual(draft)
  })

  it('takes the refreshed timing field the draft left alone', () => {
    const draft = rule({ title: 'Edited', prompt: 'Edited prompt' })
    const authoritative = rule({ title: 'Remote', prompt: 'Remote prompt', draft: { time: '21:15:00.000' } })
    expect(mergeRuleDraft(authoritative, draft, stored))
      .toEqual({ ...draft, draft: { ...draft.draft, time: '21:15:00.000' } })
  })

  it('takes a refreshed timing field while the draft edits another of the same kind', () => {
    // All three value sets state the same kind, so the merge is per field: the
    // weekday set the draft edited stays dropped to four days and the clock the
    // draft never touched takes the refreshed one.
    const storedWeekly = rule({ kind: 'weekly', draft: { time: '09:00:00.000' } })
    const draft = rule({ kind: 'weekly', weekdays: [1, 2, 3, 4], draft: { time: '09:00:00.000' } })
    const authoritative = rule({ kind: 'weekly', draft: { time: '10:00:00.000' } })
    const merged = mergeRuleDraft(authoritative, draft, storedWeekly)
    expect(merged.weekdays).toEqual([1, 2, 3, 4])
    expect(merged.draft.time).toBe('10:00:00.000')
    expect(merged).toEqual({ ...authoritative, weekdays: [1, 2, 3, 4] })
  })

  it("keeps a refreshed weekday set while the draft edits the same weekly rule's clock", () => {
    // Monday-to-Friday and Weekly are the same Host weekly rule, so the refreshed
    // record has not switched kind: the merge stays per field, keeping the clock
    // the draft edited and taking the day set the refreshed record narrowed.
    const storedWeekdays = rule({ kind: 'weekdays', draft: { time: '09:00:00.000' } })
    const draft = rule({ kind: 'weekdays', draft: { time: '11:00:00.000' } })
    const authoritative = rule({ kind: 'weekly', weekdays: [1, 3], draft: { time: '09:00:00.000' } })
    const merged = mergeRuleDraft(authoritative, draft, storedWeekdays)
    expect(merged.draft.time).toBe('11:00:00.000')
    expect(merged.weekdays).toEqual([1, 3])
    // The merged set is not Monday to Friday, so the choice it is shown under must
    // be Weekly: a Monday-to-Friday label beside Monday-and-Wednesday would both
    // misstate the rule and make a save submit the Monday-to-Friday set.
    expect(merged.kind).toBe('weekly')
  })

  it('keeps the merged choice agreeing with the merged weekday set', () => {
    const storedSparse = rule({ kind: 'weekly', weekdays: [1, 3], draft: { time: '09:00:00.000' } })
    const widened = rule({ kind: 'weekdays', weekdays: [1, 2, 3, 4, 5], draft: { time: '09:00:00.000' } })

    // The reader added Friday and changed nothing else: the draft keeps the stored
    // clock, so the day set is the only staged difference the merge weighs. The
    // kept set is no longer Monday to Friday, so the choice follows the kept set
    // rather than the refreshed record's.
    const keptEdit = mergeRuleDraft(
      widened, rule({ kind: 'weekly', weekdays: [1, 3, 5], draft: { time: '09:00:00.000' } }), storedSparse,
    )
    expect(keptEdit.kind).toBe('weekly')
    expect(keptEdit.weekdays).toEqual([1, 3, 5])

    // An untouched set takes the refreshed, wider one, and the choice follows it.
    const takenRefresh = mergeRuleDraft(widened, storedSparse, storedSparse)
    expect(takenRefresh.kind).toBe('weekdays')
    expect(takenRefresh.weekdays).toEqual([1, 2, 3, 4, 5])
  })

  it('keeps the reader’s Weekly choice while they are editing it', () => {
    // Monday-to-Friday and Weekly are one Host rule, so a reader who switched to
    // Weekly while keeping five days has still made a choice: a refresh that only
    // renames the record must not relabel them back and close the Weekday row.
    const storedWeekdays = rule({ kind: 'weekdays', weekdays: [1, 2, 3, 4, 5], draft: { time: '09:00:00.000' } })
    const draft = rule({ kind: 'weekly', weekdays: [1, 2, 3, 4, 5], draft: { time: '09:00:00.000' } })
    const renamed = rule({
      kind: 'weekdays', weekdays: [1, 2, 3, 4, 5], title: 'Renamed', prompt: 'Renamed', draft: { time: '09:00:00.000' },
    })
    const merged = mergeRuleDraft(renamed, draft, storedWeekdays)
    expect(merged.kind).toBe('weekly')
    expect(merged.weekdays).toEqual([1, 2, 3, 4, 5])
    expect(merged.title).toBe('Renamed')
  })

  it('keeps the reader’s Weekly choice while its set is theirs', () => {
    // The reader widened Monday-and-Wednesday to five days while on Weekly, so the
    // choice is theirs even though the merged set now spells Monday to Friday: a
    // relabel would close the row they are editing and submit the other set.
    const storedSparse = rule({ kind: 'weekly', weekdays: [1, 3], draft: { time: '09:00:00.000' } })
    const draft = rule({ kind: 'weekly', weekdays: [1, 2, 3, 4, 5], draft: { time: '09:00:00.000' } })
    const renamed = rule({
      kind: 'weekly', weekdays: [1, 3], title: 'Renamed', prompt: 'Renamed', draft: { time: '09:00:00.000' },
    })
    const merged = mergeRuleDraft(renamed, draft, storedSparse)
    expect(merged.kind).toBe('weekly')
    expect(merged.weekdays).toEqual([1, 2, 3, 4, 5])
  })

  it('keeps a changed weekday set of the same length and of a different length', () => {
    const authoritative = rule({ weekdays: [7] })
    expect(mergeRuleDraft(authoritative, rule({ weekdays: [1, 2, 3, 4, 6] }), stored).weekdays).toEqual([1, 2, 3, 4, 6])
    expect(mergeRuleDraft(authoritative, rule({ weekdays: [1, 2] }), stored).weekdays).toEqual([1, 2])
  })

  it('keeps the staged weekday set while an unsaved rule switch is up', () => {
    // The user just switched the kind to a weekly 23:55 on Monday and has not
    // saved; another writer's refresh then moves the record's own every-rule to
    // Tuesday. The draft stages a kind the refreshed record does not state, so
    // its weekday set describes the staged rule and must not be rewritten.
    const stagedSwitch = rule({ kind: 'weekly', draft: { time: '23:55:00.000' }, weekdays: [1] })
    const storedEvery = rule({ kind: 'every', draft: { seconds: '300' }, weekdays: [1] })
    const remote = rule({ kind: 'every', weekdays: [2] })
    expect(mergeRuleDraft(remote, stagedSwitch, storedEvery).weekdays).toEqual([1])
  })

  it('keeps a remote rename while a rule switch is staged', () => {
    // Another client renames the record and rewrites its instruction while this
    // detail stages an unsaved switch to a weekly 23:55 on Monday. The staged
    // kind is not the record's, so its clock and weekday set stay as staged; the
    // name and the instruction are not staged, so the remote values win.
    const storedRule = rule({ kind: 'every', title: 'Stored title', prompt: 'Stored instruction', weekdays: [1] })
    const stagedSwitch = rule({
      kind: 'weekly', title: 'Stored title', prompt: 'Stored instruction',
      draft: { time: '23:55:00.000' }, weekdays: [1],
    })
    const remote = rule({ kind: 'every', title: 'Remote title', prompt: 'Remote instruction', weekdays: [2] })
    const merged = mergeRuleDraft(remote, stagedSwitch, storedRule)
    expect(merged.title).toBe('Remote title')
    expect(merged.prompt).toBe('Remote instruction')
    expect(merged.kind).toBe('weekly')
    expect(merged.draft.time).toBe('23:55:00.000')
    expect(merged.weekdays).toEqual([1])
  })
})

describe('TaskDetail rule menus', () => {
  it('seeds the weekly choice with Sunday from a committed Sunday occurrence', () => {
    // 2026-10-04 is a Sunday, the only UTC weekday the Monday-first ISO set
    // cannot take from its own index.
    const sunday: ScheduleCatalogEntry = { ...at, id: 'task-sunday' as ScheduleId, scheduledAt: '2026-10-04T09:00:00.000Z' }
    mount([sunday])
    selectTask('Review release')
    fireEvent.click(repeatButton())
    fireEvent.click(screen.getByRole('menuitem', { name: en['rule.weekly'] }))
    expect(weekdayPressed(weekdayGroup())).toEqual(['false', 'false', 'false', 'false', 'false', 'false', 'true'])
  })

  it('closes the overflow menu on an outside pointer press and keeps the detail', () => {
    mount([at])
    selectTask('Review release')
    fireEvent.click(screen.getByRole('button', { name: en['detail.more'] }))
    expect(screen.getByRole('menu')).toBeDefined()
    pressOutsideMenus()
    expect(screen.queryByRole('menu')).toBeNull()
    expect(screen.getByRole('complementary')).toBeDefined()
  })

  it('closes the Repeat menu on an outside pointer press without closing the detail', () => {
    mount([at])
    selectTask('Review release')
    fireEvent.click(repeatButton())
    expect(screen.getByRole('menu')).toBeDefined()
    pressOutsideMenus()
    expect(screen.queryByRole('menu')).toBeNull()
    expect(screen.getByRole('complementary')).toBeDefined()
  })

  it('closes the Time zone menu on an outside pointer press without closing the detail', () => {
    mount([daily])
    selectTask('Daily weather')
    fireEvent.click(zoneButton())
    expect(screen.getByRole('menu')).toBeDefined()
    pressOutsideMenus()
    expect(screen.queryByRole('menu')).toBeNull()
    expect(screen.getByRole('complementary')).toBeDefined()
  })

  it('marks the Time zone search box as the field the menu hands the keyboard to', () => {
    mount([daily])
    selectTask('Daily weather')
    fireEvent.click(zoneButton())
    // The portaled list paints hidden while it is measured, so a mount-time
    // autoFocus on the box cannot take effect; marking it is what makes the menu
    // hand the keyboard over once placement made it focusable (see the primitive
    // case in ui-primitives tests).
    expect(screen.getByRole('searchbox', { name: en['timing.zoneSearch'] })
      .hasAttribute('data-menu-field')).toBe(true)
  })

  it('keeps a shared zone row’s own id when a query names several of its ids', () => {
    // Three zones hold one label at any instant, so they render as one row, and
    // the rule already states one of them, whose id that row preserves.
    const restoreSystemZone = pinSystemZone('Asia/Shanghai')
    const inventory = vi.spyOn(Intl, 'supportedValuesOf')
      .mockReturnValue(['America/Detroit', 'America/New_York', 'America/Toronto'])
    try {
      mount([{ ...daily, timeZone: 'America/Toronto' }])
      selectTask('Daily weather')
      fireEvent.click(zoneButton())
      fireEvent.change(screen.getByRole('searchbox', { name: en['timing.zoneSearch'] }), {
        target: { value: 'america/' },
      })

      // The query matches several ids of that row, including the one the rule
      // states, so the row keeps that preferred id, which is what marks the stored
      // choice as the selected row.
      const row = screen.getByRole('menuitem')
      expect(row.querySelector('svg')).not.toBeNull()
      fireEvent.click(row)
      expect(screen.queryByRole('menu')).toBeNull()
      expect(zoneButton().textContent).toContain(en['timing.zone'])
    } finally {
      inventory.mockRestore()
      restoreSystemZone()
    }
  })

  it('selects the one zone a partial query names inside a shared row', () => {
    // Athens and Cairo hold one offset and one ICU name at the pinned instant, so
    // they render as a single row whose own id is the group's first alias, Cairo.
    const restoreSystemZone = pinSystemZone('UTC')
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-09-20T12:00:00.000Z'))
    const inventory = vi.spyOn(Intl, 'supportedValuesOf').mockReturnValue(['Africa/Cairo', 'Europe/Athens'])
    try {
      const h = mount([{ ...daily, timeZone: 'UTC' }])
      selectTask('Daily weather')
      fireEvent.click(zoneButton())
      fireEvent.change(screen.getByRole('searchbox', { name: en['timing.zoneSearch'] }), {
        target: { value: 'Athens' },
      })

      // The query names exactly one id of that row, so the row adopts that id
      // instead of the alias a bare row would submit.
      fireEvent.click(screen.getByRole('menuitem'))
      clickSave()
      expect(h.updateTiming).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        change: { kind: 'daily', daily: { time: '23:00:00.000', time_zone: 'Europe/Athens' } },
      }))
    } finally {
      inventory.mockRestore()
      clock.mockRestore()
      restoreSystemZone()
    }

    // The two aliases are not interchangeable: their 09:00 on 2026-10-27 falls at
    // 07:00Z in Athens and 06:00Z in Cairo, so the id the row adopted is the one
    // that day's clock reads through.
    expect([
      zoneOffsetMinutes('Europe/Athens', '2026-10-27T07:00:00.000Z'),
      zoneOffsetMinutes('Africa/Cairo', '2026-10-27T07:00:00.000Z'),
    ]).toEqual([120, 180])
  })

  it('selects the first zone a partial query matches when the row’s own id is not one', () => {
    // Cairo, Athens, and Bucharest hold one offset and one ICU name at the pinned
    // instant, so they render as one row whose own id is its first alias, Cairo.
    const restoreSystemZone = pinSystemZone('UTC')
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-09-20T12:00:00.000Z'))
    const inventory = vi.spyOn(Intl, 'supportedValuesOf')
      .mockReturnValue(['Africa/Cairo', 'Europe/Athens', 'Europe/Bucharest'])
    try {
      const h = mount([{ ...daily, timeZone: 'Africa/Cairo' }])
      selectTask('Daily weather')
      fireEvent.click(zoneButton())
      fireEvent.change(screen.getByRole('searchbox', { name: en['timing.zoneSearch'] }), {
        target: { value: 'europe' },
      })

      // The query names two ids of that row and not the row's own: the row adopts
      // the first of them rather than a zone the query never matched.
      fireEvent.click(screen.getByRole('menuitem'))
      clickSave()
      expect(h.updateTiming).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        change: { kind: 'daily', daily: { time: '23:00:00.000', time_zone: 'Europe/Athens' } },
      }))
    } finally {
      inventory.mockRestore()
      clock.mockRestore()
      restoreSystemZone()
    }

    // The adopted id is not interchangeable with the row's own: their 09:00 on
    // 2026-10-27 falls at 07:00Z in Athens and 06:00Z in Cairo.
    expect([
      zoneOffsetMinutes('Europe/Athens', '2026-10-27T07:00:00.000Z'),
      zoneOffsetMinutes('Africa/Cairo', '2026-10-27T07:00:00.000Z'),
    ]).toEqual([120, 180])
  })
})

describe('TaskDetail weekday memory across tasks', () => {
  it('seeds a switched task from its own target day, never from another task set', () => {
    mount([weeklyMonday, daily])
    selectTask('Weekly Monday')
    // The weekly draft starts on its stored Monday; the reader narrows it to Wednesday.
    clickWeekday(3)
    clickWeekday(1)
    expect(weekdayOn(3)).toBe('true')
    expect(weekdayOn(1)).toBe('false')

    // The other task's Daily rule states no weekday set, so its Weekly choice
    // seeds the day its own target falls on (2026-10-01 23:00 in Asia/Shanghai is
    // a Thursday) rather than the set left staged on the first task.
    selectTask('Daily weather')
    clickRepeat('rule.weekly')
    expect(weekdayOn(4)).toBe('true')
    expect(weekdayOn(3)).toBe('false')

    // Leaving the first task drops its unsaved draft, so coming back re-seeds the
    // card from its stored Monday: neither the set abandoned on the first task nor
    // the one staged on the second reaches it.
    selectTask('Weekly Monday')
    expect(weekdayOn(1)).toBe('true')
    expect(weekdayOn(3)).toBe('false')
    expect(weekdayOn(4)).toBe('false')
  })

  it('keeps a stored Monday-to-Friday set through a detour in Every day', () => {
    mount([weekdayRule])
    selectTask('Weekday rule')
    // A stored Monday-to-Friday rule opens on that choice, which lists no Weekday toggles.
    expect(within(screen.getByRole('region', { name: en['rule.title'] }))
      .queryByRole('group', { name: en['rule.weekday'] })).toBeNull()

    // Every day shows no Weekday row either, and no pill was pressed on the way
    // out: the stored rule still states five days, so its Weekly choice keeps all
    // five instead of collapsing to the one day the carried clock falls on.
    clickRepeat('rule.daily')
    clickRepeat('rule.weekly')
    expect(weekdayPressed(weekdayGroup()))
      .toEqual(['true', 'true', 'true', 'true', 'true', 'false', 'false'])
  })

  it('keeps an edited set through detours of one and of two kinds', () => {
    // Short detour: Weekly -> Every day -> Weekly.
    mount([weekdayRule])
    selectTask('Weekday rule')
    clickRepeat('rule.weekly')
    clickWeekday(5)
    expect(weekdayOn(5)).toBe('false')
    clickRepeat('rule.daily')
    clickRepeat('rule.weekly')
    expect(weekdayPressed(weekdayGroup()))
      .toEqual(['true', 'true', 'true', 'true', 'false', 'false', 'false'])

    // The same edit through one more kind must answer the same: the stored
    // Monday-to-Friday set only seeds a memory this task has not got yet, so a
    // longer detour cannot put the dropped Friday back.
    cleanup()
    mount([weekdayRule])
    selectTask('Weekday rule')
    clickRepeat('rule.weekly')
    clickWeekday(5)
    clickRepeat('rule.daily')
    clickRepeat('rule.cron')
    clickRepeat('rule.weekly')
    expect(weekdayPressed(weekdayGroup()))
      .toEqual(['true', 'true', 'true', 'true', 'false', 'false', 'false'])
  })

  it('retires a memory that only mirrors the stored set a refresh replaces', () => {
    const h = mount([weekdayRule])
    selectTask('Weekday rule')
    // Leaving Monday to Friday for Every day seeds this task's memory with the
    // stored set, which is a seed rather than a choice the reader made.
    clickRepeat('rule.daily')

    // Another client narrows the stored rule to Monday while the detour is up.
    h.update([{ ...weekdayRule, weekdays: [1] }])
    clickRepeat('rule.weekly')
    // The refresh retires that seed, so the Weekly choice seeds the refreshed
    // Monday instead of the five days the stored rule held before the refresh.
    expect(weekdayPressed(weekdayGroup()))
      .toEqual(['true', 'false', 'false', 'false', 'false', 'false', 'false'])
  })

  it('keeps an added day through a detour that passes through the cron choice', () => {
    mount([sparseWeekdays])
    selectTask('Sparse weekdays')
    // A stored Monday-and-Wednesday rule opens on Weekly, whose Weekday row shows both days.
    expect(weekdayOn(1)).toBe('true')
    expect(weekdayOn(3)).toBe('true')
    clickWeekday(5)
    expect(weekdayOn(5)).toBe('true')

    clickRepeat('rule.daily')
    clickRepeat('rule.cron')
    clickRepeat('rule.weekly')
    expect(weekdayPressed(weekdayGroup()))
      .toEqual(['true', 'false', 'true', 'false', 'true', 'false', 'false'])
  })

  it('drops a cancelled set so a later Weekly choice seeds the target day again', () => {
    mount([daily])
    selectTask('Daily weather')
    clickRepeat('rule.weekly')
    expect(weekdayOn(4)).toBe('true')

    // The reader replaces the seeded Thursday with Wednesday and then cancels.
    clickWeekday(3)
    clickWeekday(4)
    expect(weekdayOn(3)).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: en['rule.cancel'] }))

    // The cancelled choice leaves with the draft it belonged to, so the next
    // Weekly choice seeds the occurrence's own day instead of restoring it.
    clickRepeat('rule.weekly')
    expect(weekdayOn(4)).toBe('true')
    expect(weekdayOn(3)).toBe('false')
  })
})

describe('TaskDetail save identity', () => {
  it('keeps a draft typed after returning to a task whose earlier save is in flight', async () => {
    const h = mount([at, daily])
    selectTask('Review release')
    fireEvent.change(screen.getByLabelText<HTMLInputElement>(en['detail.name']), { target: { value: 'First draft' } })
    const unanswered = Promise.withResolvers<RemoteResult<ScheduleUpdateResult>>()
    h.updateTiming.mockReturnValueOnce(unanswered.promise)
    clickSave()
    expect(h.updateTiming).toHaveBeenCalledOnce()

    // The reader leaves while the save is unanswered, comes back, and types again.
    selectTask('Daily weather')
    selectTask('Review release')
    fireEvent.change(screen.getByLabelText<HTMLInputElement>(en['detail.name']), { target: { value: 'Second draft' } })

    await act(async () => {
      unanswered.resolve({ ok: true, value: { id: at.id, updated: true, record: at } })
      await unanswered.promise
    })
    // The answer describes the record the abandoned save submitted, and the task
    // switch retired it: the draft typed after coming back stays staged.
    expect(screen.getByLabelText<HTMLInputElement>(en['detail.name']).value).toBe('Second draft')
    expect(screen.getByRole('button', { name: en['rule.save'] })).toBeDefined()
    expect(screen.queryByRole('button', { name: en['rule.saving'] })).toBeNull()
  })

  it('does not apply an answered save to the task opened after it', async () => {
    const h = mount([at, daily])
    selectTask('Review release')
    fireEvent.change(screen.getByLabelText<HTMLInputElement>(en['detail.name']), { target: { value: 'First draft' } })
    const unanswered = Promise.withResolvers<RemoteResult<ScheduleUpdateResult>>()
    h.updateTiming.mockReturnValueOnce(unanswered.promise)
    clickSave()

    // Another task is open and holds its own unsaved draft when the answer lands.
    selectTask('Daily weather')
    fireEvent.change(screen.getByLabelText<HTMLInputElement>(en['detail.name']), { target: { value: 'Weather draft' } })

    await act(async () => {
      unanswered.resolve({ ok: true, value: { id: at.id, updated: true, record: at } })
      await unanswered.promise
    })
    // The answer names the task that submitted it, so it must not re-seed the
    // task opened since with that task's record.
    expect(screen.getByLabelText<HTMLInputElement>(en['detail.name']).value).toBe('Weather draft')
    expect(screen.getByRole('button', { name: en['rule.save'] })).toBeDefined()
  })
})

describe('TaskDetail interval stepper', () => {
  it('moves the staged interval one whole unit and stops at the Host floor', () => {
    mount([{ ...every, everySeconds: 61 }])
    selectTask('Check metrics')
    expect(intervalField().value).toBe('61')

    // The decrease moves the staged quantity down one second to the Host's
    // 60-second floor, which is the lowest the arrow offers.
    clickIntervalArrow('timing.intervalDecrease')
    expect(intervalField().value).toBe('60')
    expect(screen.getByRole('button', { name: en['timing.intervalDecrease'] }).hasAttribute('disabled')).toBe(true)

    clickIntervalArrow('timing.intervalIncrease')
    expect(intervalField().value).toBe('61')
  })

  it('starts an emptied interval field from the Host floor', () => {
    mount([every])
    selectTask('Check metrics')
    fireEvent.change(intervalField(), { target: { value: '' } })
    expect(intervalField().value).toBe('')

    // An emptied field states no quantity, so the increase stages the floor
    // rather than a value derived from the removed one.
    clickIntervalArrow('timing.intervalIncrease')
    expect(intervalField().value).toBe('60')
  })
})

describe('TaskDetail records-tab save failure', () => {
  it('states the refused interval in the row unit while the records tab shows', () => {
    mount([every])
    selectTask('Check metrics')
    fireEvent.change(intervalField(), { target: { value: '59' } })
    fireEvent.click(recordsTab())
    clickSave()

    const bar = saveFailure()
    expect(bar?.textContent).toBe(en['timing.invalidInterval.second'])
    expect(bar?.getAttribute('role')).toBe('alert')
  })

  it('states a save the Host did not answer while the records tab shows', async () => {
    const h = mount([every])
    selectTask('Check metrics')
    fireEvent.change(intervalField(), { target: { value: '600' } })
    fireEvent.click(recordsTab())
    h.updateTiming.mockRejectedValueOnce(new Error('save response disconnected'))
    await act(async () => { clickSave() })

    expect(saveFailure()?.textContent).toBe(en['rule.error.unknown'])
  })
})

describe('TaskDetail cron rows', () => {
  it('closes the Frequency menu on an outside pointer press without closing the detail', () => {
    mount([cron])
    selectTask('Cron report')
    fireEvent.click(frequencyButton())
    expect(screen.getByRole('menu')).toBeDefined()

    pressOutsideMenus()
    expect(screen.queryByRole('menu')).toBeNull()
    expect(screen.getByRole('complementary')).toBeDefined()
  })

  it('closes the Time panel on an outside pointer press without closing the detail', () => {
    mount([cron])
    selectTask('Cron report')
    fireEvent.click(timeField())
    expect(screen.getByRole('dialog', { name: en['timing.time'] })).toBeDefined()

    pressOutsideMenus()
    expect(screen.queryByRole('dialog', { name: en['timing.time'] })).toBeNull()
    expect(screen.getByRole('complementary')).toBeDefined()
  })

  it('seeds a day shape from the committed occurrence when the staged expression states minutes alone', () => {
    const minutely: ScheduleCatalogEntry = { ...cron, expression: '* * * * *' }
    const h = mount([minutely])
    selectTask('Cron report')

    // `* * * * *` states neither an hour nor a minute of its own, so both come
    // from the committed occurrence in the staged zone.
    chooseCronShape('cronForm.daily')
    expect(timeField().textContent).toBe('01:30')
    clickSave()
    expect(h.updateTiming).toHaveBeenCalledExactlyOnceWith({
      sessionId: minutely.sessionId, id: minutely.id, expected: timingSnapshot(minutely),
      change: { kind: 'cron', cron: { expression: '30 1 * * *', time_zone: 'UTC' } },
    })
  })

  it('stages nothing when the Frequency menu names the shape the expression already has', () => {
    mount([cron])
    selectTask('Cron report')
    chooseCronShape('rule.cronLabel')
    expect(screen.getByLabelText<HTMLInputElement>(en['rule.cronLabel']).value).toBe('0 9 * * 1-5')

    // The staged expression recognizes the weekly shape, so naming that shape
    // restores the rows without staging an edit.
    chooseCronShape('cronForm.weekly')
    expect(screen.queryByLabelText(en['rule.cronLabel'])).toBeNull()
    expect(screen.queryByRole('button', { name: en['rule.save'] })).toBeNull()
  })
})
