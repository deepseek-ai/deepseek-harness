// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionSnapshot } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ScheduleRecord } from '@deepseek-ai/dsh-schedule/client'
import { ScheduleId } from '@deepseek-ai/dsh-schedule'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import {
  formatScheduleAbsolute,
  formatScheduleFrequency,
  formatScheduleRelative,
  orderScheduleRecords,
  zoneLabel,
  type FrequencyTranslator,
} from '../src/client/schedule-format.ts'
import {
  ScheduleCatalogAction,
  type ScheduleCatalogActionProps,
} from '../src/client/ScheduleCatalogAction.tsx'
import type { CatalogSnapshot } from '../src/client/catalog-source.ts'
import { en, zh } from '../src/client/locales.ts'
import catalogCss from '../src/client/ScheduleCatalogAction.module.css'
import { en as managerEn, zh as managerZh } from '../src/client/task-manager-locales.ts'

const SESSION = 'schedule-session' as SessionId
const START = Date.parse('2026-08-25T12:00:00.000Z')

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(START)
  document.documentElement.lang = 'en'
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

function record(
  id: string,
  kind: ScheduleRecord['kind'],
  scheduledAt: number,
  options: {
    prompt?: string
    title?: string
    everySeconds?: number
    time?: string
    timeZone?: string
    weekdays?: number[]
    expression?: string
  } = {},
): ScheduleRecord {
  const prompt = options.prompt ?? id
  const common = {
    id: ScheduleId(id),
    kind,
    title: options.title ?? prompt,
    prompt,
    scheduledAt: new Date(scheduledAt).toISOString(),
  }
  if (kind === 'after') return { ...common, kind, afterSeconds: 30 }
  if (kind === 'every') return { ...common, kind, everySeconds: options.everySeconds ?? 300 }
  if (kind === 'daily') return { ...common, kind, time: options.time ?? '23:00:00.000', timeZone: options.timeZone ?? 'Asia/Shanghai' }
  if (kind === 'weekly') {
    return {
      ...common, kind, time: options.time ?? '23:00:00.000',
      timeZone: options.timeZone ?? 'Asia/Shanghai', weekdays: options.weekdays ?? [1],
    }
  }
  if (kind === 'cron') {
    return {
      ...common, kind, expression: options.expression ?? '0 9 * * 1-5',
      timeZone: options.timeZone ?? 'Asia/Shanghai',
    }
  }
  return { ...common, kind }
}

/**
 * One Session snapshot for the stub.
 * @param openState - whether the Session is open, cold, or archived.
 * @returns the snapshot the component's selector reads.
 */
function sessionSnapshot(openState: SessionSnapshot['openState']): SessionSnapshot {
  return {
    sessionId: SESSION,
    pendingSubmissions: [],
    running: false,
    subagent: null,
    removed: false,
    openState,
    openError: null,
    hasMore: false,
    loadingOlder: false,
    promptError: null,
    blank: false,
    lastAgentError: null,
    promptAttempted: false,
    awaitingFirstTurn: false,
  }
}

function props(
  records: readonly ScheduleRecord[] | undefined,
  openState: SessionSnapshot['openState'] = 'open',
  dictionary: typeof zh | typeof en = en,
): ScheduleCatalogActionProps {
  const snapshot = sessionSnapshot(openState)
  const useSession = <T,>(select: (value: SessionSnapshot) => T): T => select(snapshot)
  // A settled read reports ordinal 1; a read that has not settled yet reports 0.
  const state: CatalogSnapshot = {
    records: records ?? [], status: records === undefined ? 'loading' : 'ready', deleting: [],
    settled: records !== undefined, readRequest: records === undefined ? 0 : 1, readSettled: records === undefined ? 0 : 1,
  }
  const useCatalog = <T,>(select: (value: CatalogSnapshot) => T): T => select(state)
  return {
    sessionId: SESSION,
    useSession,
    useCatalog,
    onDelete: vi.fn(async () => {}),
    onRetry: vi.fn(async () => {}),
    openTaskDetail: vi.fn(),
    t: makeTranslate(dictionary),
  } as ScheduleCatalogActionProps
}

function titles(): string[] {
  return within(screen.getByRole('list', { name: en['list.aria'] }))
    .getAllByRole('listitem')
    .map(item => item.querySelector('[class*="title"]')?.textContent ?? '')
}

/** Metadata line element of every rendered row. */
function metadataLines(): Element[] {
  return screen.getAllByRole('listitem').map(row => row.querySelector('[class*="metadata"]')!)
}

describe('ScheduleCatalogAction visibility', () => {
  it('hides the entry once a successful read proves there are no active reminders', () => {
    const active = [record('active', 'after', START + 60_000)]
    const view = render(<ScheduleCatalogAction {...props(active, 'cold')} />)
    expect(view.container.innerHTML).toBe('')

    view.rerender(<ScheduleCatalogAction {...props(active)} />)
    expect(screen.getByRole('button', { name: '1 reminder' })).toBeDefined()
    view.rerender(<ScheduleCatalogAction {...props([])} />)
    expect(view.container.innerHTML).toBe('')
  })

  it('hides the entry and its open list when the last record disappears', () => {
    const active = [record('active', 'after', START + 60_000), record('next', 'after', START + 120_000)]
    const view = render(<ScheduleCatalogAction {...props(active)} />)
    fireEvent.click(screen.getByRole('button', { name: '2 reminders' }))
    expect(screen.getByRole('list', { name: en['list.aria'] })).toBeDefined()
    view.rerender(<ScheduleCatalogAction {...props([])} />)
    expect(view.container.innerHTML).toBe('')
  })

  it('renders nothing until a read answers, then distinguishes loading and failure', () => {
    // The first read must not mount a chip that an empty answer then removes.
    const first = render(<ScheduleCatalogAction {...props(undefined)} />)
    expect(first.container.innerHTML).toBe('')

    // A refresh retains the known reminders, so the entry keeps its count and
    // its loading row stays visible.
    const known = record('known', 'after', START + 60_000)
    const p = props([known])
    const view = render(<ScheduleCatalogAction {...p} useCatalog={
      select => select({ records: [known], status: 'loading', deleting: [], settled: true, readRequest: 0, readSettled: 0 })} />)
    fireEvent.click(screen.getByRole('button', { name: '1 reminder' }))
    expect(screen.getByRole('status').textContent).toBe(en['list.loading'])

    // A failed read with nothing known keeps the entry, and the open popover
    // replaces its loading row with the retry.
    view.rerender(<ScheduleCatalogAction {...p} useCatalog={
      select => select({ records: [], status: 'error', deleting: [], settled: false, readRequest: 0, readSettled: 0 })} />)
    expect(screen.getByRole('alert').textContent).toBe(en['list.error'])
    fireEvent.click(screen.getByRole('button', { name: en['list.retry'] }))
    expect(p.onRetry).toHaveBeenCalledOnce()
  })

  it('keeps the known count and the loading row while a refresh is in flight', () => {
    // A `schedule/changed` refresh republishes `loading` while retaining the
    // rows, so the entry must keep naming the count it still lists instead of
    // falling back to the generic label for the length of the read.
    const only = record('only', 'after', START + 60_000)
    const state: CatalogSnapshot = { records: [only], status: 'ready', deleting: [], settled: true, readRequest: 0, readSettled: 0 }
    const p = props(undefined)
    const view = render(<ScheduleCatalogAction {...p} useCatalog={select => select(state)} />)
    expect(screen.getByRole('button', { name: '1 reminder' })).toBeDefined()

    view.rerender(<ScheduleCatalogAction {...p} useCatalog={
      select => select({ ...state, status: 'loading' })} />)
    const trigger = screen.getByRole('button', { name: '1 reminder' })
    expect(screen.queryByRole('button', { name: en['trigger.label'] })).toBeNull()
    fireEvent.click(trigger)
    expect(screen.getByRole('status').textContent).toBe(en['list.loading'])
    expect(within(screen.getByRole('list', { name: en['list.aria'] })).getAllByRole('listitem')).toHaveLength(1)

    // Two known records keep their plural count through the same refresh.
    const second = record('second', 'after', START + 120_000)
    view.rerender(<ScheduleCatalogAction {...p} useCatalog={
      select => select({ records: [only, second], status: 'loading', deleting: [], settled: true, readRequest: 0, readSettled: 0 })} />)
    expect(screen.getByRole('button', { name: '2 reminders' })).toBeDefined()
  })

  it('deletes only the selected reminder and marks the pending row', () => {
    const row = record('selected', 'at', START + 60_000)
    const other = record('other', 'at', START + 120_000)
    const p = props([row, other])
    const view = render(<ScheduleCatalogAction {...p} />)
    fireEvent.click(screen.getByRole('button', { name: '2 reminders' }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete reminder: selected' }))
    expect(p.onDelete).toHaveBeenCalledWith(row.id)
    // A failed deletion keeps the row; the app-wide toast, not this popover, announces it.
    view.rerender(<ScheduleCatalogAction {...p} useCatalog={select => select({ records: [row], status: 'ready', deleting: [], settled: true, readRequest: 0, readSettled: 0 })} />)
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByText('selected')).toBeDefined()
    view.rerender(<ScheduleCatalogAction {...p} useCatalog={select => select({ records: [row], status: 'ready', deleting: [row.id], settled: true, readRequest: 0, readSettled: 0 })} />)
    const pending = screen.getByRole('button', { name: 'Delete reminder: selected' })
    expect(pending.hasAttribute('disabled')).toBe(true)
    // The icon-only delete button keeps its action copy as the tooltip.
    expect(pending.getAttribute('title')).toBe(en['delete.pending'])
    view.rerender(<ScheduleCatalogAction {...props([row], 'error')} />)
    expect(screen.queryByRole('list')).toBeNull()
  })
})

describe('ScheduleCatalogAction positioning', () => {
  it('portals the catalog to the body and left-aligns it when space is available', () => {
    const active = [record('active', 'after', START + 60_000), record('next', 'after', START + 120_000)]
    const view = render(<ScheduleCatalogAction {...props(active)} />)
    const trigger = screen.getByRole('button', { name: '2 reminders' })
    vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue({
      x: 240,
      y: 20,
      left: 240,
      right: 320,
      top: 20,
      bottom: 48,
      width: 80,
      height: 28,
      toJSON: () => ({}),
    })

    fireEvent.click(trigger)

    const catalog = screen.getByRole('list', { name: en['list.aria'] })
    expect(view.container.contains(catalog)).toBe(false)
    expect(catalog.parentElement).toBe(document.body)
    expect(catalog.style.left).toBe('240px')
    expect(catalog.style.top).toBe('53px')
    expect(catalog.style.visibility).toBe('')
  })
})

describe('ScheduleCatalogAction task reveal', () => {
  it('opens the sole reminder detail directly without rendering the list', () => {
    const only = record('only', 'after', START + 60_000)
    const p = props([only])
    render(<ScheduleCatalogAction {...p} />)

    const trigger = screen.getByRole('button', { name: '1 reminder' })
    // A sole reminder has no list to choose from, so the trigger keeps only the clock glyph
    // and states no disclosure: the press opens the detail instead of expanding a list.
    expect(trigger.getAttribute('data-schedule-reminder-entry')).toBe('')
    expect(trigger.querySelectorAll('svg')).toHaveLength(1)
    expect(trigger.textContent).toBe('')
    expect(trigger.hasAttribute('aria-expanded')).toBe(false)

    fireEvent.click(trigger)

    expect(p.openTaskDetail).toHaveBeenCalledExactlyOnceWith(only.id)
    expect(screen.queryByRole('list')).toBeNull()
    expect(trigger.hasAttribute('aria-expanded')).toBe(false)
  })

  it('renders the list for two or more reminders and nothing for none', () => {
    const empty = render(<ScheduleCatalogAction {...props([])} />)
    expect(empty.container.innerHTML).toBe('')

    const many = [record('first', 'after', START + 60_000), record('second', 'after', START + 120_000)]
    empty.rerender(<ScheduleCatalogAction {...props(many)} />)
    // Icon-only: one clock glyph, no count chip, and no chevron.
    const trigger = screen.getByRole('button', { name: '2 reminders' })
    expect(trigger.querySelectorAll('svg')).toHaveLength(1)
    expect(trigger.textContent).toBe('')
    fireEvent.click(trigger)
    expect(screen.getAllByRole('listitem')).toHaveLength(2)
  })

  it('keeps the known count while a read is unresolved and names the entry with it', () => {
    const known = record('known', 'after', START + 60_000)
    const p = props([known])
    render(<ScheduleCatalogAction {...p} useCatalog={
      select => select({ records: [known], status: 'loading', deleting: [], settled: true, readRequest: 0, readSettled: 0 })} />)

    // The retained record supplies the count, so the icon-only entry names it
    // instead of falling back to the catalog label.
    const trigger = screen.getByRole('button', { name: '1 reminder' })
    expect(trigger.textContent).toBe('')
    fireEvent.click(trigger)
    expect(screen.getByRole('status').textContent).toBe(en['list.loading'])
    expect(within(screen.getByRole('list', { name: en['list.aria'] })).getAllByRole('listitem')).toHaveLength(1)
  })

  it('opens one row task from its prompt button and closes the list', () => {
    const first = record('first', 'at', START + 60_000, { prompt: 'First reminder' })
    const second = record('second', 'at', START + 120_000, { prompt: 'Second reminder' })
    const p = props([first, second])
    render(<ScheduleCatalogAction {...p} />)
    fireEvent.click(screen.getByRole('button', { name: '2 reminders' }))

    const list = screen.getByRole('list', { name: en['list.aria'] })
    fireEvent.click(within(list).getByRole('button', { name: 'Open reminder details: Second reminder' }))

    expect(p.openTaskDetail).toHaveBeenCalledExactlyOnceWith(second.id)
    expect(screen.queryByRole('list')).toBeNull()
  })
})

describe('ScheduleCatalogAction rows', () => {
  it('shows the stored title, a frequency line above its own next-run line, and deletion with overdue records first', () => {
    const rawPrompt = '<img src=x onerror=alert(1)> Keep the complete long reminder prompt visible without truncation.'
    const storedTitle = '<img src=x onerror=alert(1)> Review the rollout'
    const overdue = record('hidden-id', 'after', START - 60_000, { prompt: rawPrompt, title: storedTitle })
    const every = record('every-id', 'every', START + 300_000, { prompt: 'Check metrics', everySeconds: 300 })
    const at = record('at-id', 'at', START + 3_600_000, { prompt: 'Join meeting' })
    render(<ScheduleCatalogAction {...props([at, every, overdue])} />)
    fireEvent.click(screen.getByRole('button'))

    expect(titles()).toEqual([storedTitle, 'Check metrics', 'Join meeting'])
    const rows = screen.getAllByRole('listitem')
    // The row anatomy: the stored title as the only primary line, exactly one
    // metadata line, and the trash action's glyph as the row's only svg.
    expect(rows.every(row => row.querySelectorAll('svg').length === 1)).toBe(true)
    const frequencyLines = metadataLines()
    const lines = screen.getAllByRole('listitem')
      .map(row => row.querySelector<HTMLElement>(`.${catalogCss.nextRun}`)!)
    // The frequency keeps its own line, and the next target states a second one:
    // the label, the absolute stamp, and the parenthesized distance.
    expect(frequencyLines.every(line => line.children.length === 1)).toBe(true)
    expect(lines.every(line => line.children.length === 3)).toBe(true)
    expect(screen.getByRole('list').textContent).not.toContain('·')
    expect(rows[0]?.textContent).toContain('Once')
    expect(rows[1]?.textContent).toContain('Every 5 minutes')
    expect(rows[2]?.textContent).toContain('Once')
    // The metadata line states how long remains, not a clock time: the fake
    // clock in this suite fixes the distance from each stored instant.
    expect(lines[0]?.textContent).toContain(en['list.nextRun'])
    expect(lines[0]?.textContent).toContain('1 minute overdue')
    expect(lines[1]?.textContent).toContain(en['list.nextRun'])
    expect(lines[1]?.textContent).toContain('in 5 minutes')
    expect(lines[2]?.textContent).toContain(formatScheduleRelative(at.scheduledAt, START, makeTranslate(en)))
    expect(lines[2]?.textContent).toContain('in 1 hour')
    // The line states the local stamp now, and the distance sits in parentheses
    // beside it.
    expect(lines.every(line => /\d{1,2}:\d{2}/.test(line.textContent ?? ''))).toBe(true)
    for (const [line, task] of [[lines[0]!, overdue], [lines[1]!, every], [lines[2]!, at]] as const) {
      const stamp = line.querySelector('time')
      expect(stamp?.dateTime).toBe(task.scheduledAt)
      expect(stamp?.textContent).toBe(formatScheduleAbsolute(task.scheduledAt, en['time.locale']))
      const relative = line.querySelector<HTMLElement>(`.${catalogCss.nextRunRelative}`)
      expect(relative?.textContent)
        .toBe(`(${formatScheduleRelative(task.scheduledAt, START, makeTranslate(en))})`)
    }
    // Both surfaces read the whole next-run line in one color: the popover's
    // countdown declares no ink of its own and the Tasks page row inherits.
    const declared = (source: string): string =>
      /\.nextRunRelative\s*\{([^}]*)\}/.exec(source)?.[1] ?? ''
    const popoverCss = readFileSync(resolve(import.meta.dirname, '../src/client/ScheduleCatalogAction.module.css'), 'utf8')
    const listCss = readFileSync(resolve(import.meta.dirname, '../src/client/TaskManagerPage.module.css'), 'utf8')
    expect(declared(popoverCss)).not.toMatch(/color:/)
    expect(declared(listCss)).toMatch(/color:\s*inherit;/)
    // The retired status row is gone: its words no longer render anywhere.
    const text = screen.getByRole('list').textContent ?? ''
    expect(text).not.toContain('Scheduled')
    expect(text).not.toContain('Overdue')
    // The row is named by the stored title, never by the instruction.
    expect(text).not.toContain(rawPrompt)
    // Overdue stays distinguishable, now through the metadata line rather than
    // a status word.
    expect(metadataLines()[0]?.className).toContain('metadataOverdue')
    expect(metadataLines()[1]?.className).not.toContain('metadataOverdue')
    expect(metadataLines()[2]?.className).not.toContain('metadataOverdue')
    expect(document.querySelector('img')).toBeNull()
    expect(text).not.toContain('hidden-id')
    expect(text).not.toContain(overdue.scheduledAt)
    expect(text).not.toMatch(/Retry|Details/)
    // Each row carries its detail opener and the delete action.
    expect(within(screen.getByRole('list')).queryAllByRole('button')).toHaveLength(6)
    expect(rows.every(row => row.tabIndex === -1)).toBe(true)
  })

  it('renders exact recurring units without rounding and localizes both dictionaries', () => {
    const tEn = makeTranslate(en)
    const tZh = makeTranslate(zh)
    const samples = [
      [86_400, 'Every 1 day', '1天一次'],
      [172_800, 'Every 2 days', '2天一次'],
      [3_600, 'Every 1 hour', '1小时一次'],
      [7_200, 'Every 2 hours', '2小时一次'],
      [300, 'Every 5 minutes', '5分钟一次'],
      [301, 'Every 301 seconds', '301秒一次'],
    ] as const
    for (const [seconds, english, chinese] of samples) {
      const item = record(String(seconds), 'every', START + 1_000, { everySeconds: seconds })
      expect(formatScheduleFrequency(item, tEn)).toBe(english)
      expect(formatScheduleFrequency(item, tZh)).toBe(chinese)
    }
    const frequency: FrequencyTranslator = tEn
    for (const kind of ['at', 'after'] as const) {
      const once = record(`once-${kind}`, kind, START + 1_000)
      expect(formatScheduleFrequency(once, frequency)).toBe('Once')
      expect(formatScheduleFrequency(once, tZh)).toBe('单次')
    }
    expect(tZh('list.nextRun')).toBe('下次运行')
  })

  it.each([
    ['23:00:00.000', '23:00'],
    ['23:00:15.000', '23:00:15'],
    ['23:00:00.125', '23:00'],
    ['23:00:15.500', '23:00:15'],
  ])('trims fractional and zero seconds off a daily rule clock: %s', (time, displayed) => {
    const item = record('daily-clock', 'daily', START + 3_600_000, { time, timeZone: 'America/New_York' })
    expect(formatScheduleFrequency(item, makeTranslate(en)))
      .toBe(`Daily at ${displayed} (${zoneLabel('America/New_York', makeTranslate(managerEn))})`)
    expect(formatScheduleFrequency(item, makeTranslate(zh)))
      .toBe(`每天 ${displayed}（${zoneLabel('America/New_York', makeTranslate(managerZh))}）`)
  })

  it('labels a weekly rule with its localized weekday set, clock, and zone', () => {
    const item = record('weekly-clock', 'weekly', START + 3_600_000, {
      time: '09:00:00.000', timeZone: 'Asia/Shanghai', weekdays: [1, 3],
    })
    expect(formatScheduleFrequency(item, makeTranslate(en)))
      .toBe(`Weekly on Mon, Wed at 09:00 (${zoneLabel('Asia/Shanghai', makeTranslate(managerEn))})`)
    expect(formatScheduleFrequency(item, makeTranslate(zh)))
      .toBe(`每周一、三 09:00（${zoneLabel('Asia/Shanghai', makeTranslate(managerZh))}）`)
  })

  it('labels a weekly rule with whole seconds and for a single weekday', () => {
    const seconds = record('weekly-seconds', 'weekly', START + 3_600_000, {
      time: '09:00:15.000', timeZone: 'UTC', weekdays: [7],
    })
    expect(formatScheduleFrequency(seconds, makeTranslate(en))).toBe('Weekly on Sun at 09:00:15 (UTC+00:00)')
    expect(formatScheduleFrequency(seconds, makeTranslate(zh))).toBe('每周日 09:00:15（UTC+00:00）')
    const milliseconds = record('weekly-milliseconds', 'weekly', START + 3_600_000, {
      time: '09:00:00.125', timeZone: 'UTC', weekdays: [1, 2, 3, 4, 5, 6, 7],
    })
    expect(formatScheduleFrequency(milliseconds, makeTranslate(en)))
      .toBe('Weekly on Mon, Tue, Wed, Thu, Fri, Sat, Sun at 09:00 (UTC+00:00)')
    expect(formatScheduleFrequency(milliseconds, makeTranslate(zh)))
      .toBe('每周一、二、三、四、五、六、日 09:00（UTC+00:00）')
  })

  it('labels a cron rule with its described sentence and zone', () => {
    const item = record('cron-clock', 'cron', START + 3_600_000, {
      expression: '0 9 * * 1-5', timeZone: 'America/New_York',
    })
    expect(formatScheduleFrequency(item, makeTranslate(en)))
      .toBe(`Mon–Fri at 09:00 (${zoneLabel('America/New_York', makeTranslate(managerEn))})`)
    expect(formatScheduleFrequency(item, makeTranslate(zh)))
      .toBe(`周一至周五 09:00（${zoneLabel('America/New_York', makeTranslate(managerZh))}）`)
  })

  it('omits a cron rule zone equal to the host zone and names another zone', () => {
    const item = record('cron-zone', 'cron', START + 3_600_000, {
      expression: '*/15 * * * *', timeZone: 'Asia/Shanghai',
    })
    const t = makeTranslate(en)
    const named = makeTranslate(managerEn)
    expect(formatScheduleFrequency(item, t, { system: 'Asia/Shanghai', label: zone => zoneLabel(zone, named) }))
      .toBe('Every 15 minutes')
    expect(formatScheduleFrequency(item, t, { system: 'UTC', label: zone => zoneLabel(zone, named) }))
      .toBe(`Every 15 minutes (${zoneLabel('Asia/Shanghai', named)})`)
    expect(formatScheduleFrequency(item, makeTranslate(zh), { system: 'UTC', label: zone => zoneLabel(zone, makeTranslate(managerZh)) }))
      .toBe(`每 15 分钟（${zoneLabel('Asia/Shanghai', makeTranslate(managerZh))}）`)
  })

  it('keeps the raw expression of a cron rule this parser cannot read', () => {
    const item = record('cron-raw', 'cron', START + 3_600_000, {
      expression: '0 9 * * MON', timeZone: 'Asia/Shanghai',
    })
    const t = makeTranslate(en)
    const named = makeTranslate(managerEn)
    expect(formatScheduleFrequency(item, t)).toBe(`Cron 0 9 * * MON (${zoneLabel('Asia/Shanghai', named)})`)
    expect(formatScheduleFrequency(item, t, { system: 'Asia/Shanghai', label: zone => zoneLabel(zone, named) }))
      .toBe('Cron 0 9 * * MON')
    expect(formatScheduleFrequency(item, t, { system: 'UTC', label: zone => zoneLabel(zone, named) }))
      .toBe(`Cron 0 9 * * MON (${zoneLabel('Asia/Shanghai', named)})`)
  })

  it('shows daily recurrence in the Session catalog rather than a one-shot label', () => {
    const item = record('daily-clock', 'daily', START + 3_600_000)
    const other = record('daily-other', 'daily', START + 7_200_000, { time: '08:30:00.000', timeZone: 'UTC' })
    render(<ScheduleCatalogAction {...props([item, other])} />)
    fireEvent.click(screen.getByRole('button', { name: '2 reminders' }))
    const list = screen.getByRole('list', { name: en['list.aria'] })
    expect(within(list).getByText(`Daily at 23:00 (${zoneLabel('Asia/Shanghai', makeTranslate(managerEn))})`, { exact: true })).toBeDefined()
    expect(within(list).queryByText(en['frequency.once'], { exact: true })).toBeNull()
  })

  it('renders the time until the next run in the injected locale and updates when it changes', () => {
    document.documentElement.lang = 'de-DE'
    const item = record('localized', 'at', START + 3_600_000)
    const other = record('localized-other', 'at', START + 7_200_000)
    const expected = formatScheduleRelative(item.scheduledAt, START, makeTranslate(en))
    expect(expected).toBe('in 1 hour')
    const view = render(<ScheduleCatalogAction {...props([item, other])} />)
    fireEvent.click(screen.getByRole('button', { name: '2 reminders' }))
    expect(screen.getAllByRole('listitem')[0]!.textContent).toContain(expected)
    view.rerender(<ScheduleCatalogAction {...props([item, other], 'open', zh)} />)
    expect(screen.getAllByRole('listitem')[0]!.textContent).toContain('1小时后')
    expect(document.documentElement.lang).toBe('de-DE')
  })

  it('derives relative seconds, minutes, hours, days, and the exact due boundary', () => {
    const t = makeTranslate(en)
    expect(formatScheduleRelative(new Date(START).toISOString(), START, t)).toBe('Due now')
    expect(formatScheduleRelative(new Date(START + 500).toISOString(), START, t)).toBe('in 1 second')
    expect(formatScheduleRelative(new Date(START + 61_000).toISOString(), START, t)).toBe('in 2 minutes')
    expect(formatScheduleRelative(new Date(START - 3_600_000).toISOString(), START, t)).toBe('1 hour overdue')
    expect(formatScheduleRelative(new Date(START - 172_800_000).toISOString(), START, t)).toBe('2 days overdue')
  })

  it('keeps equal targets stable and updates overdue status as the browser clock advances', () => {
    const first = record('first', 'at', START + 500)
    const second = record('second', 'at', START + 500)
    expect(orderScheduleRecords([first, second], START).map(item => item.id)).toEqual(['first', 'second'])
    expect(orderScheduleRecords([
      record('future', 'at', START + 1_000),
      record('overdue', 'at', START - 1_000),
    ], START).map(item => item.id)).toEqual(['overdue', 'future'])

    render(<ScheduleCatalogAction {...props([first, second])} />)
    fireEvent.click(screen.getByRole('button'))
    expect(metadataLines().every(line => !line.className.includes('metadataOverdue'))).toBe(true)
    act(() => { vi.advanceTimersByTime(1_000) })
    expect(metadataLines().every(line => line.className.includes('metadataOverdue'))).toBe(true)
  })
})

describe('ScheduleCatalogAction dismissal', () => {
  const active = [record('active', 'after', START + 60_000), record('next', 'after', START + 120_000)]

  it('closes on Escape inside the catalog and restores trigger focus', () => {
    render(<ScheduleCatalogAction {...props(active)} />)
    const trigger = screen.getByRole('button', { name: '2 reminders' })
    fireEvent.click(trigger)
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    fireEvent.keyDown(screen.getByRole('list', { name: en['list.aria'] }), { key: 'Escape' })
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(trigger)
  })

  it('leaves the catalog open when Escape belongs to a sibling control', () => {
    render(<><ScheduleCatalogAction {...props(active)} /><button type="button">Sibling</button></>)
    const trigger = screen.getByRole('button', { name: '2 reminders' })
    const sibling = screen.getByRole('button', { name: 'Sibling' })
    fireEvent.click(trigger)
    sibling.focus()
    fireEvent.keyDown(sibling, { key: 'Escape' })
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    expect(document.activeElement).toBe(sibling)
  })

  it('keeps a pointer press inside the portaled catalog open and dismisses outside', () => {
    render(<ScheduleCatalogAction {...props(active)} />)
    const trigger = screen.getByRole('button')
    fireEvent.click(trigger)
    const catalog = screen.getByRole('list', { name: en['list.aria'] })
    expect(catalog.parentElement).toBe(document.body)
    fireEvent.pointerDown(catalog)
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    fireEvent.pointerDown(document.body)
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(trigger)
    fireEvent.click(trigger)
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
  })

  it('uses native Tab navigation and Enter or Space activation', () => {
    render(
      <>
        <button type="button">Before</button>
        <ScheduleCatalogAction {...props(active)} />
        <button type="button">After</button>
      </>,
    )
    const trigger = screen.getByRole('button', { name: '2 reminders' })
    const before = screen.getByRole('button', { name: 'Before' })
    const after = screen.getByRole('button', { name: 'After' })

    trigger.focus()
    expect(trigger.tabIndex).toBe(0)
    expect(fireEvent.keyDown(trigger, { key: 'Tab' })).toBe(true)
    after.focus()
    expect(document.activeElement).toBe(after)
    trigger.focus()
    expect(fireEvent.keyDown(trigger, { key: 'Tab', shiftKey: true })).toBe(true)
    before.focus()
    expect(document.activeElement).toBe(before)

    trigger.focus()
    expect(fireEvent.keyDown(trigger, { key: 'Enter' })).toBe(true)
    fireEvent.click(trigger, { detail: 0 })
    expect(trigger.getAttribute('aria-expanded')).toBe('true')

    expect(fireEvent.keyDown(trigger, { key: ' ', code: 'Space' })).toBe(true)
    fireEvent.click(trigger, { detail: 0 })
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
  })

  it('stops the clock while closed or unmounted and restarts it when reopened', () => {
    const view = render(<ScheduleCatalogAction {...props(active)} />)
    const trigger = screen.getByRole('button')

    expect(vi.getTimerCount()).toBe(0)
    fireEvent.click(trigger)
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    expect(vi.getTimerCount()).toBe(1)
    fireEvent.click(trigger)
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(vi.getTimerCount()).toBe(0)
    fireEvent.click(trigger)
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    expect(vi.getTimerCount()).toBe(1)

    view.unmount()
    expect(vi.getTimerCount()).toBe(0)
  })
})
