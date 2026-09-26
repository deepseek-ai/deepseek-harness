// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { resolve as resolvePath } from 'node:path'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate, RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import type { ScheduleDeliveryRecord, ScheduleId } from '@deepseek-ai/dsh-schedule/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { DeliveryHistory, type DeliveryHistoryInjected } from '../src/client/DeliveryHistory.tsx'
import { formatScheduleNextRun } from '../src/client/schedule-format.ts'
import { zoneDifferingFrom, zoneOffsetMinutes } from './zone-fixture.ts'
import { en, zh } from '../src/client/task-manager-locales.ts'
import css from '../src/client/TaskManagerPage.module.css'

type Result = Awaited<ReturnType<DeliveryHistoryInjected['loadHistory']>>
const id = 'saved-task' as ScheduleId
const sessionId = 'saved-session' as SessionId
const records: ScheduleDeliveryRecord[] = Array.from({ length: 45 }, (_, index) => ({
  messageId: `saved-message-${index}` as ScheduleDeliveryRecord['messageId'],
  scheduledAt: new Date(Date.UTC(2026, 9, 30 - index, 8)).toISOString(),
  deliveredAt: new Date(Date.UTC(2026, 9, 30 - index, 8, 0, 3)).toISOString(),
  prompt: `Saved instruction ${index}\n<img src=x onerror=alert(1)>`,
}))
function result(start = 0, end = 20, legacy = false): Result {
  return { ok: true, value: {
    id, records: records.slice(start, end), earlierRecordsUnavailable: legacy,
    earlierRecordsPruned: false, retention: { days: 30, records: 200 },
    ...(end < records.length ? { nextBefore: records[end - 1]!.messageId } : {}),
  } }
}
function failure(code: 'schedule_not_found' | 'delivery_cursor_not_found'): Result {
  return { ok: true, value: { id, code } }
}
const transportFailure: Result = { ok: false, error: new RemoteError('gateway/internal', 'Private transport detail', {}) }
function mount(dictionary: typeof en | typeof zh = en) {
  const loadHistory = vi.fn<DeliveryHistoryInjected['loadHistory']>().mockResolvedValue(result())
  const props = { id, sessionId, latestMessageId: records[0]!.messageId, loadHistory, t: makeTranslate(dictionary) }
  const view = render(<DeliveryHistory {...props} />)
  return { loadHistory, props, view }
}
async function resolve(pending: ReturnType<typeof Promise.withResolvers<Result>>, value: Result): Promise<void> {
  await act(async () => { pending.resolve(value); await pending.promise })
}
async function reject(pending: ReturnType<typeof Promise.withResolvers<Result>>): Promise<void> {
  await act(async () => { pending.reject(new Error('Private rejected detail')); await pending.promise.catch(() => {}) })
}
function occurrences(dictionary: typeof en | typeof zh = en): string[] {
  return screen.queryAllByRole('region', { name: dictionary['delivery.label'] })
    .map(region => region.querySelector('time')?.dateTime ?? '')
}
/** Whether `later` follows `earlier` in document order. */
function follows(earlier: Element, later: Element): boolean {
  return (earlier.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
}
/** Declarations of one local rule in the module stylesheet, empty when it has none. */
function ruleBlock(stylesheet: string, selector: string): string {
  return new RegExp(`\\.${selector}\\s*\\{([^}]*)\\}`).exec(stylesheet)?.[1] ?? ''
}
/** Value one local rule declares for one property, empty when it declares none. */
function declaration(stylesheet: string, selector: string, property: string): string {
  return new RegExp(`(?:^|[;\\s])${property}:\\s*([^;]+);`).exec(ruleBlock(stylesheet, selector))?.[1]?.trim() ?? ''
}
afterEach(cleanup)

// A task zone whose offset at the sampled instant differs from the runner's own,
// so a task-zone render is distinguishable from a browser-zone render on any
// host. The zone is chosen by that offset rather than by name, because two names
// can hold the same offset at one instant.
const RUNNER_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone
const SAMPLED_INSTANT = records[0]!.scheduledAt
const TASK_ZONE = zoneDifferingFrom(SAMPLED_INSTANT, RUNNER_ZONE)

describe.each([en, zh])('saved delivery records', (dictionary) => {
  it('renders multiple saved instructions and exact times with escaped HTML and no legacy notice', async () => {
    const h = mount(dictionary)
    expect(screen.queryByText(dictionary['delivery.empty'])).toBeNull()
    expect(screen.getByRole('status', { name: dictionary['delivery.loading'] }).textContent).toBe('')
    await screen.findAllByRole('region', { name: dictionary['delivery.label'] })
    expect(h.loadHistory).toHaveBeenCalledExactlyOnceWith({ id, sessionId, limit: 20 })
    const regions = screen.getAllByRole('region', { name: dictionary['delivery.label'] })
    expect(regions).toHaveLength(20)
    for (const [index, region] of regions.entries()) {
      expect(region.querySelector<HTMLElement>(`.${css.savedPrompt}`)!.textContent).toBe(records[index]!.prompt)
      const times = region.querySelectorAll('time')
      expect(Array.from(times, time => time.dateTime)).toEqual([records[index]!.scheduledAt])
      expect(times[0]!.textContent).toBe(formatScheduleNextRun(records[index]!.scheduledAt, dictionary['time.locale']))
      expect(region.querySelector('img')).toBeNull()
      expect(within(region).queryByRole('button')).toBeNull()
      expect(region.textContent).not.toContain(records[index]!.messageId)
    }
    expect(screen.queryByText(dictionary['delivery.empty'])).toBeNull()
  })

  it('indents each saved instruction into the text column beside the clock glyph', async () => {
    mount()
    const region = (await screen.findAllByRole('region', { name: en['delivery.label'] }))[0]!
    const glyph = region.querySelector<SVGElement>(`.${css.deliveryGlyph}`)!
    expect(glyph.tagName.toLowerCase()).toBe('svg')
    expect(region.firstElementChild).toBe(glyph)
    // The instruction shares the text column with the timestamp instead of
    // starting at the row's far left under the glyph.
    const body = region.querySelector<HTMLElement>(`.${css.deliveryBody}`)!
    expect(body.previousElementSibling).toBe(glyph)
    expect(body.parentElement).toBe(region)
    const occurrence = body.querySelector<HTMLTimeElement>(`.${css.deliveryTime}`)!
    expect(occurrence.textContent).toBe(formatScheduleNextRun(records[0]!.scheduledAt, en['time.locale']))
    // The row's time is the locale-owned month name plus the clock field pair,
    // never the retired zero-padded `MM-DD` pair.
    expect(occurrence.textContent).toMatch(/^[A-Za-z]{3,}\s\d{1,2}[, ]/)
    expect(occurrence.textContent).toMatch(/\d{1,2}:\d{2}/)
    expect(occurrence.textContent).not.toMatch(/\d{2}-\d{2}/)
    const prompt = body.querySelector<HTMLElement>(`.${css.savedPrompt}`)!
    expect(prompt.textContent).toBe(records[0]!.prompt)
    expect(prompt.parentElement).toBe(body)
    const head = body.querySelector<HTMLElement>(`.${css.deliveryHead}`)!
    expect(occurrence.parentElement).toBe(head)
    expect(prompt.previousElementSibling).toBe(head)
    expect(follows(occurrence, prompt)).toBe(true)
    const stylesheet = readFileSync(resolvePath(import.meta.dirname, '../src/client/TaskManagerPage.module.css'), 'utf8')
    // The mock's `.history-row` plus `.automation-detail .history-row`: the
    // glyph column's 12px gap, the 14px/8px row box, and the 14px body step
    // the mock inherits from the page base. A timeline hairline between the
    // rows' glyphs replaces the retired per-row bottom separator.
    const rowRule = ruleBlock(stylesheet, 'delivery')
    expect(rowRule).toMatch(/gap:\s*12px;/)
    expect(rowRule).toMatch(/padding:\s*14px 8px;/)
    expect(rowRule).toMatch(/margin:\s*0 -8px;/)
    expect(rowRule).not.toMatch(/border-bottom/)
    expect(rowRule).toMatch(/position:\s*relative;/)
    expect(rowRule).toMatch(/font-size:\s*14px;/)
    expect(rowRule).toMatch(/line-height:\s*22px;/)
    // Timeline segments hang on the glyph centre, skip the edge beyond the
    // first and last glyphs, and stay 6px clear of each glyph.
    const segmentRule = ruleBlock(stylesheet, 'delivery::before,\n.delivery::after')
    expect(segmentRule).toMatch(/left:\s*15\.75px;/)
    expect(segmentRule).toMatch(/width:\s*0\.5px;/)
    expect(segmentRule).toMatch(/background:\s*var\(--dsw-alias-border-l3\);/)
    expect(ruleBlock(stylesheet, 'delivery:not\\(:first-of-type\\)::before')).toMatch(/height:\s*14px;/)
    expect(ruleBlock(stylesheet, 'delivery:not\\(:last-of-type\\)::after')).toMatch(/top:\s*42px;/)
    expect(ruleBlock(stylesheet, 'delivery:first-of-type:not\\(:last-of-type\\)::after')).toMatch(/top:\s*28px;/)
    // The mock's `.automation-detail .history-row > .icon`.
    const glyphRule = ruleBlock(stylesheet, 'deliveryGlyph')
    expect(glyphRule).toMatch(/margin-top:\s*6px;/)
    expect(glyphRule).toMatch(/color:\s*var\(--dsw-alias-label-tertiary\);/)
    // The mock's `.delivery-record-title`: the compact occurrence time.
    const occurrenceRule = ruleBlock(stylesheet, 'deliveryTime')
    expect(occurrenceRule).toMatch(/font-size:\s*14px;/)
    expect(occurrenceRule).toMatch(/line-height:\s*22px;/)
    expect(occurrenceRule).toMatch(/font-weight:\s*500;/)
    expect(occurrenceRule).toMatch(/color:\s*var\(--dsw-alias-label-primary\);/)
    // The mock's `.delivery-record .history-caption`: the saved instruction.
    const instructionRule = ruleBlock(stylesheet, 'savedPrompt')
    expect(instructionRule).toMatch(/margin:\s*6px 0 0;/)
    expect(instructionRule).toMatch(/font-size:\s*13px;/)
    expect(instructionRule).toMatch(/line-height:\s*22px;/)
    expect(instructionRule).toMatch(/color:\s*var\(--dsw-alias-label-tertiary\);/)
    expect(instructionRule).toMatch(/white-space:\s*pre-wrap;/)
    expect(instructionRule).toMatch(/overflow-wrap:\s*anywhere;/)
    // A collapsed instruction shows two lines; the expanded state lifts the clamp.
    expect(instructionRule).toMatch(/display:\s*-webkit-box;/)
    expect(instructionRule).toMatch(/-webkit-box-orient:\s*vertical;/)
    expect(instructionRule).toMatch(/-webkit-line-clamp:\s*2;/)
    expect(instructionRule).toMatch(/[;\s]line-clamp:\s*2;/)
    expect(instructionRule).toMatch(/overflow:\s*hidden;/)
    const expandedRule = ruleBlock(stylesheet, 'savedPrompt\\[data-expanded\\]')
    expect(expandedRule).toMatch(/display:\s*block;/)
    expect(expandedRule).toMatch(/-webkit-line-clamp:\s*none;/)
    expect(expandedRule).toMatch(/[;\s]line-clamp:\s*none;/)
    // The toggle's negative margin cancels its inline padding, so its label
    // starts at the instruction's left edge.
    const toggleRule = ruleBlock(stylesheet, 'savedPromptToggle')
    expect(toggleRule).toMatch(/margin:\s*2px 0 0 -6px;/)
    expect(toggleRule).toMatch(/padding:\s*1px 6px;/)
  })

  it('clamps each overflowing saved instruction behind its own expand toggle', async () => {
    // Two 22px lines are visible of a six-line instruction.
    vi.spyOn(Element.prototype, 'clientHeight', 'get').mockReturnValue(44)
    vi.spyOn(Element.prototype, 'scrollHeight', 'get').mockReturnValue(132)
    try {
      mount(dictionary)
      const [first, second] = await screen.findAllByRole('region', { name: dictionary['delivery.label'] })
      const prompt = first!.querySelector<HTMLElement>(`.${css.savedPrompt}`)!
      const toggle = within(first!).getByRole('button', { name: dictionary['delivery.expand'] })
      expect(toggle.getAttribute('aria-expanded')).toBe('false')
      expect(toggle.getAttribute('aria-controls')).toBe(prompt.id)
      expect(prompt.hasAttribute('data-expanded')).toBe(false)
      expect(prompt.textContent).toBe(records[0]!.prompt)
      fireEvent.click(toggle)
      expect(toggle.getAttribute('aria-expanded')).toBe('true')
      expect(toggle.textContent).toBe(dictionary['delivery.collapse'])
      expect(prompt.hasAttribute('data-expanded')).toBe(true)
      const other = within(second!).getByRole('button', { name: dictionary['delivery.expand'] })
      expect(other.getAttribute('aria-expanded')).toBe('false')
      fireEvent.click(toggle)
      expect(toggle.getAttribute('aria-expanded')).toBe('false')
      expect(toggle.textContent).toBe(dictionary['delivery.expand'])
      expect(prompt.hasAttribute('data-expanded')).toBe(false)
    } finally {
      vi.restoreAllMocks()
    }
  })

  it('reads legacy unavailability without inventing a prompt or a notice', async () => {
    const pending = Promise.withResolvers<Result>()
    const loadHistory = vi.fn<DeliveryHistoryInjected['loadHistory']>(() => pending.promise)
    render(<DeliveryHistory
      id={id} sessionId={sessionId} latestMessageId={undefined} loadHistory={loadHistory} t={makeTranslate(dictionary)}
    />)
    const { prompt: _prompt, ...receipt } = records[0]!
    await resolve(pending, { ok: true, value: {
      id, records: [receipt], earlierRecordsUnavailable: true,
      earlierRecordsPruned: false, retention: { days: 30, records: 200 },
    } })
    const region = screen.getByRole('region', { name: dictionary['delivery.label'] })
    expect(region.querySelector(`.${css.savedPrompt}`)).toBeNull()
    expect(region.querySelectorAll('p')).toHaveLength(0)
    expect(occurrences(dictionary)).toEqual([receipt.scheduledAt])
    expect(screen.queryByRole('button', { name: dictionary['delivery.loadMore'] })).toBeNull()
    expect(screen.queryByText(dictionary['delivery.pruned'])).toBeNull()
  })

  it('shows confirmed pruning after the last saved page and toggles the configured retention rules', async () => {
    const first = result()
    const last = result(20, 45)
    if (!first.ok || !last.ok || 'code' in first.value || 'code' in last.value) throw new Error('Expected saved pages')
    const policy = { earlierRecordsPruned: true, retention: { days: 7, records: 25 } }
    const loadHistory = vi.fn<DeliveryHistoryInjected['loadHistory']>()
      .mockResolvedValueOnce({ ok: true, value: { ...first.value, ...policy } })
      .mockResolvedValueOnce(transportFailure)
      .mockResolvedValueOnce({ ok: true, value: { ...last.value, ...policy } })
    render(<DeliveryHistory
      id={id} sessionId={sessionId} latestMessageId={undefined} loadHistory={loadHistory} t={makeTranslate(dictionary)}
    />)
    await screen.findByRole('button', { name: dictionary['delivery.loadMore'] })
    expect(screen.queryByText(dictionary['delivery.pruned'])).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: dictionary['delivery.loadMore'] }))
    await screen.findByRole('alert')
    expect(screen.queryByText(dictionary['delivery.pruned'])).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: dictionary['delivery.retry'] }))
    await screen.findByText(dictionary['delivery.pruned'])
    const info = screen.getByRole('button', { name: dictionary['delivery.retention'] })
    expect(info.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(info)
    const bounds = dictionary['delivery.retentionBounds'].replace('{days}', '7').replace('{records}', '25')
    expect(screen.getByText(bounds)).toBeDefined()
    expect(info.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(info)
    expect(screen.queryByText(bounds)).toBeNull()
    expect(info.getAttribute('aria-expanded')).toBe('false')
  })

  it.each([false, true])('keeps empty history free of pruning notices with pruned=%s', async (earlierRecordsPruned) => {
    const loadHistory = vi.fn<DeliveryHistoryInjected['loadHistory']>().mockResolvedValue({
      ok: true, value: { id, records: [], earlierRecordsUnavailable: true, earlierRecordsPruned, retention: { days: 30, records: 200 } },
    })
    render(<DeliveryHistory
      id={id} sessionId={sessionId} latestMessageId={undefined} loadHistory={loadHistory} t={makeTranslate(dictionary)}
    />)
    await screen.findByText(dictionary['delivery.empty'])
    expect(screen.queryByText(dictionary['delivery.pruned'])).toBeNull()
  })

  it.each(['remote', 'throw', 'reject', 'missing', 'cursor'] as const)('never treats %s failure as empty and retries the first page', async (mode) => {
    const pending = Promise.withResolvers<Result>()
    const loadHistory = vi.fn<DeliveryHistoryInjected['loadHistory']>(() => pending.promise)
    if (mode === 'throw') loadHistory.mockImplementationOnce(() => { throw new Error('Private thrown detail') })
    render(<DeliveryHistory
      id={id} sessionId={sessionId} latestMessageId={undefined} loadHistory={loadHistory} t={makeTranslate(dictionary)}
    />)
    if (mode === 'reject') await reject(pending)
    else if (mode !== 'throw') await resolve(pending, mode === 'remote' ? transportFailure : failure(mode === 'missing' ? 'schedule_not_found' : 'delivery_cursor_not_found'))
    const key = mode === 'missing' ? 'delivery.notFound' : mode === 'cursor' ? 'delivery.cursorError' : 'delivery.error'
    // Nothing was loaded, so the staleness caveat about shown records is absent.
    expect(screen.getByRole('alert').textContent).toBe(dictionary[key])
    expect(screen.queryByText(dictionary['delivery.empty'])).toBeNull()
    expect(document.body.textContent).not.toContain('Private')
    loadHistory.mockResolvedValueOnce({ ok: true, value: {
      id, records: [], earlierRecordsUnavailable: false,
      earlierRecordsPruned: false, retention: { days: 30, records: 200 },
    } })
    fireEvent.click(screen.getByRole('button', { name: dictionary[mode === 'cursor' ? 'delivery.refresh' : 'delivery.retry'] }))
    await screen.findByText(dictionary['delivery.empty'])
    expect(loadHistory).toHaveBeenLastCalledWith({ id, sessionId, limit: 20 })
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('renders each saved occurrence in the task zone rather than the browser zone', async () => {
    const loadHistory = vi.fn<DeliveryHistoryInjected['loadHistory']>().mockResolvedValue(result())
    render(<DeliveryHistory
      id={id} sessionId={sessionId} latestMessageId={records[0]!.messageId}
      timeZone={TASK_ZONE} loadHistory={loadHistory} t={makeTranslate(dictionary)}
    />)
    const region = (await screen.findAllByRole('region', { name: dictionary['delivery.label'] }))[0]!
    const occurrence = region.querySelector<HTMLTimeElement>(`.${css.deliveryTime}`)!
    // Precondition: the two zones hold different offsets at this instant, so the
    // task-zone render cannot coincide with the browser-zone render.
    expect(zoneOffsetMinutes(TASK_ZONE, SAMPLED_INSTANT))
      .not.toBe(zoneOffsetMinutes(RUNNER_ZONE, SAMPLED_INSTANT))
    const taskZone = formatScheduleNextRun(SAMPLED_INSTANT, dictionary['time.locale'], TASK_ZONE)
    expect(occurrence.textContent).toBe(taskZone)
    // The runner's own zone formats this instant differently.
    expect(taskZone).not.toBe(formatScheduleNextRun(SAMPLED_INSTANT, dictionary['time.locale']))
  })
})

it('picks a task zone by the offset it holds at the sampled instant', () => {
  // Two zones that keep one offset year round: naming a "different" zone proves
  // nothing about the wall clock, which is why the fixture compares offsets.
  expect(zoneOffsetMinutes('Asia/Shanghai', SAMPLED_INSTANT))
    .toBe(zoneOffsetMinutes('Asia/Taipei', SAMPLED_INSTANT))
  expect(zoneOffsetMinutes('America/New_York', SAMPLED_INSTANT))
    .toBe(zoneOffsetMinutes('America/Toronto', SAMPLED_INSTANT))

  // A runner holding Asia/Shanghai's offset gets a zone that differs at this
  // instant, and never the same-offset Asia/Taipei that a name check would admit.
  const chosen = zoneDifferingFrom(SAMPLED_INSTANT, 'Asia/Shanghai')
  expect(zoneOffsetMinutes(chosen, SAMPLED_INSTANT))
    .not.toBe(zoneOffsetMinutes('Asia/Shanghai', SAMPLED_INSTANT))
  expect(chosen).not.toBe('Asia/Taipei')
})

it('keeps the Rules and the Delivery records views on one type scale', () => {
  const stylesheet = readFileSync(resolvePath(import.meta.dirname, '../src/client/TaskManagerPage.module.css'), 'utf8')
  const declared = (selector: string, property: string): string => declaration(stylesheet, selector, property)
  // The body step: the rules view's row label and value and the records view's
  // occurrence time and record row all state the mock's 14px.
  expect(declared('ruleValue', 'font-size')).toBe('14px')
  expect(declared('ruleLabel', 'font-size')).toBe('14px')
  expect(declared('deliveryTime', 'font-size')).toBe('14px')
  expect(declared('delivery', 'font-size')).toBe('14px')
  // The secondary step: 13px in the rules view's leading and hint and the
  // records view's saved instruction.
  expect(declared('ruleCard h3', 'font-size')).toBe('13px')
  expect(declared('ruleHint', 'font-size')).toBe('13px')
  expect(declared('savedPrompt', 'font-size')).toBe('13px')
  // The rules view reads its row labels and values in one primary ink and its
  // leading and hint in tertiary; the records view keeps the same hierarchy.
  expect(declared('ruleValue', 'color')).toBe(declared('deliveryTime', 'color'))
  expect(declared('ruleLabel', 'color')).toBe(declared('ruleValue', 'color'))
  expect(declared('ruleHint', 'color')).toBe('var(--dsw-alias-label-tertiary)')
  expect(declared('savedPrompt', 'color')).toBe('var(--dsw-alias-label-tertiary)')
})

it('offers the instruction toggle only while the collapsed instruction overflows at the current width', async () => {
  class FakeResizeObserver implements ResizeObserver {
    static readonly made: FakeResizeObserver[] = []
    readonly observe = vi.fn()
    readonly unobserve = vi.fn()
    readonly disconnect = vi.fn()
    constructor(private readonly callback: ResizeObserverCallback) {
      FakeResizeObserver.made.push(this)
    }

    fire(): void {
      this.callback([], this)
    }
  }
  vi.stubGlobal('ResizeObserver', FakeResizeObserver)
  let lines = 2
  vi.spyOn(Element.prototype, 'clientHeight', 'get').mockReturnValue(44)
  vi.spyOn(Element.prototype, 'scrollHeight', 'get').mockImplementation(() => lines * 22)
  try {
    const loadHistory = vi.fn<DeliveryHistoryInjected['loadHistory']>().mockResolvedValue(result(0, 1))
    const view = render(<DeliveryHistory
      id={id} sessionId={sessionId} latestMessageId={undefined} loadHistory={loadHistory} t={makeTranslate(en)}
    />)
    const region = await screen.findByRole('region', { name: en['delivery.label'] })
    const prompt = region.querySelector<HTMLElement>(`.${css.savedPrompt}`)!
    expect(within(region).queryByRole('button')).toBeNull()
    const collapsed = FakeResizeObserver.made.at(-1)!
    expect(collapsed.observe).toHaveBeenCalledWith(prompt)
    // A narrower panel wraps the instruction onto a third line.
    lines = 3
    act(() => { collapsed.fire() })
    fireEvent.click(within(region).getByRole('button', { name: en['delivery.expand'] }))
    // The expanded instruction is not measured; its toggle stays until collapsed.
    expect(collapsed.disconnect).toHaveBeenCalledTimes(1)
    lines = 2
    fireEvent.click(within(region).getByRole('button', { name: en['delivery.collapse'] }))
    expect(within(region).queryByRole('button')).toBeNull()
    const remeasured = FakeResizeObserver.made.at(-1)!
    expect(remeasured).not.toBe(collapsed)
    view.unmount()
    expect(remeasured.disconnect).toHaveBeenCalledTimes(1)
  } finally {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  }
})

it('appends real-sized pages stably without duplicate IDs and contains overlapping older-page requests', async () => {
  const h = mount()
  await screen.findByText(formatScheduleNextRun(records[0]!.scheduledAt, en['time.locale']))
  const pending = Promise.withResolvers<Result>()
  h.loadHistory.mockReturnValueOnce(pending.promise)
  const more = screen.getByRole('button', { name: en['delivery.loadMore'] })
  act(() => { more.click(); more.click() })
  expect(h.loadHistory).toHaveBeenCalledTimes(2)
  expect(h.loadHistory).toHaveBeenLastCalledWith({ id, sessionId, limit: 20, before: records[19]!.messageId })
  expect(more.hasAttribute('disabled')).toBe(true)
  const overlapping = result(19, 39)
  await resolve(pending, overlapping)
  expect(occurrences()).toEqual(records.slice(0, 39).map(record => record.scheduledAt))
  h.loadHistory.mockResolvedValueOnce(result(39, 45))
  fireEvent.click(screen.getByRole('button', { name: en['delivery.loadMore'] }))
  await screen.findByText(formatScheduleNextRun(records[44]!.scheduledAt, en['time.locale']))
  expect(occurrences()).toEqual(records.map(record => record.scheduledAt))
  expect(screen.queryByRole('button', { name: en['delivery.loadMore'] })).toBeNull()
})

it.each(['remote', 'reject', 'cursor', 'missing'] as const)('preserves records on an older-page %s failure with the correct retry cursor', async (mode) => {
  const h = mount()
  await screen.findByText(formatScheduleNextRun(records[0]!.scheduledAt, en['time.locale']))
  const pending = Promise.withResolvers<Result>()
  h.loadHistory.mockReturnValueOnce(pending.promise)
  fireEvent.click(screen.getByRole('button', { name: en['delivery.loadMore'] }))
  if (mode === 'reject') await reject(pending)
  else await resolve(pending, mode === 'remote' ? transportFailure : failure(mode === 'cursor' ? 'delivery_cursor_not_found' : 'schedule_not_found'))
  expect(occurrences()).toEqual(records.slice(0, 20).map(record => record.scheduledAt))
  expect(screen.getByRole('alert').textContent).toBe(en[mode === 'cursor' ? 'delivery.cursorError' : mode === 'missing' ? 'delivery.notFound' : 'delivery.error'])
  expect(screen.queryByText(en['delivery.empty'])).toBeNull()
  h.loadHistory.mockResolvedValueOnce(mode === 'remote' || mode === 'reject' ? result(20, 40) : result(0, 20))
  fireEvent.click(screen.getByRole('button', { name: en[mode === 'cursor' ? 'delivery.refresh' : 'delivery.retry'] }))
  await act(async () => { await h.loadHistory.mock.results[2]!.value })
  expect(h.loadHistory).toHaveBeenLastCalledWith({ id, sessionId, limit: 20, ...(mode === 'remote' || mode === 'reject' ? { before: records[19]!.messageId } : {}) })
  expect(occurrences()).toHaveLength(mode === 'remote' || mode === 'reject' ? 40 : 20)
  expect(screen.queryByRole('alert')).toBeNull()
})

it.each(['success', 'rejection'] as const)('refreshes the newest page while ignoring an older-page late %s', async (outcome) => {
  const h = mount()
  await screen.findByText(formatScheduleNextRun(records[0]!.scheduledAt, en['time.locale']))
  const older = Promise.withResolvers<Result>()
  const newest = Promise.withResolvers<Result>()
  h.loadHistory.mockReturnValueOnce(older.promise).mockReturnValueOnce(newest.promise)
  fireEvent.click(screen.getByRole('button', { name: en['delivery.loadMore'] }))
  h.view.rerender(<DeliveryHistory {...h.props} latestMessageId={'new-receipt' as ScheduleDeliveryRecord['messageId']} />)
  expect(h.loadHistory).toHaveBeenCalledTimes(3)
  expect(h.loadHistory).toHaveBeenLastCalledWith({ id, sessionId, limit: 20 })
  if (outcome === 'success') await resolve(older, result(20, 40))
  else await reject(older)
  expect(occurrences()).toHaveLength(20)
  // A refresh over records already on screen shows no spinner; the container
  // only marks itself busy until the newest page answers.
  expect(screen.queryByRole('status')).toBeNull()
  expect(document.querySelector('[aria-busy="true"]')).not.toBeNull()
  expect(screen.queryByRole('alert')).toBeNull()
  await resolve(newest, result(40, 45))
  expect(occurrences()).toEqual(records.slice(40).map(record => record.scheduledAt))
})

it('preserves loaded records on failed receipt refresh and retries newest rather than the old cursor', async () => {
  const h = mount()
  await screen.findByText(formatScheduleNextRun(records[0]!.scheduledAt, en['time.locale']))
  h.loadHistory.mockResolvedValueOnce(transportFailure)
  h.view.rerender(<DeliveryHistory {...h.props} latestMessageId={'new-receipt' as ScheduleDeliveryRecord['messageId']} />)
  await screen.findByRole('alert')
  expect(occurrences()).toHaveLength(20)
  h.loadHistory.mockResolvedValueOnce(result(40, 45))
  fireEvent.click(screen.getByRole('button', { name: en['delivery.retry'] }))
  await screen.findByText(formatScheduleNextRun(records[44]!.scheduledAt, en['time.locale']))
  expect(h.loadHistory).toHaveBeenLastCalledWith({ id, sessionId, limit: 20 })
  expect(occurrences()).toHaveLength(5)
})

it.each(['success', 'rejection'] as const)('ignores a late %s after view unmount', async (outcome) => {
  const pending = Promise.withResolvers<Result>()
  const loadHistory = vi.fn<DeliveryHistoryInjected['loadHistory']>(() => pending.promise)
  const view = render(<DeliveryHistory
    id={id} sessionId={sessionId} latestMessageId={undefined} loadHistory={loadHistory} t={makeTranslate(en)}
  />)
  view.unmount()
  if (outcome === 'success') await resolve(pending, result())
  else await reject(pending)
  expect(document.body.textContent).toBe('')
})
