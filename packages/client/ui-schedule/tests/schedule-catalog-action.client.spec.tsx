// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionSnapshot, UseProjection } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ScheduleRecord } from '@deepseek-ai/dsh-schedule/client'
import { ScheduleId } from '@deepseek-ai/dsh-schedule'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import {
  formatScheduleFrequency,
  formatScheduleLocalTime,
  formatScheduleRelative,
  orderScheduleRecords,
  ScheduleCatalogAction,
  type ScheduleCatalogActionProps,
} from '../src/client/ScheduleCatalogAction.tsx'
import { en, zh } from '../src/client/locales.ts'

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
  options: { prompt?: string; everySeconds?: number } = {},
): ScheduleRecord {
  const common = {
    id: ScheduleId(id),
    kind,
    prompt: options.prompt ?? id,
    scheduledAt: new Date(scheduledAt).toISOString(),
  }
  if (kind === 'after') return { ...common, kind, afterSeconds: 30 }
  if (kind === 'every') return { ...common, kind, everySeconds: options.everySeconds ?? 300 }
  return { ...common, kind }
}

function sessionSnapshot(openState: SessionSnapshot['openState']): SessionSnapshot {
  return {
    sessionId: SESSION,
    queue: [],
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
  const useProjection = ((key: string, select?: (value: unknown) => unknown) => {
    const value = key === 'schedule' ? records : undefined
    return select === undefined ? value : select(value)
  }) as UseProjection
  return {
    sessionId: SESSION,
    useSession,
    useProjection,
    t: makeTranslate(dictionary),
  } as unknown as ScheduleCatalogActionProps
}

function prompts(): string[] {
  return within(screen.getByRole('list', { name: en['list.aria'] }))
    .getAllByRole('listitem')
    .map(item => item.querySelector('[class*="prompt"]')?.textContent ?? '')
}

describe('ScheduleCatalogAction visibility', () => {
  it('renders only for a successfully opened Session with a non-empty projection', () => {
    const active = [record('active', 'after', START + 60_000)]
    const view = render(<ScheduleCatalogAction {...props(undefined)} />)
    expect(view.container.innerHTML).toBe('')

    view.rerender(<ScheduleCatalogAction {...props([], 'open')} />)
    expect(view.container.innerHTML).toBe('')
    for (const state of ['cold', 'loading', 'error'] as const) {
      view.rerender(<ScheduleCatalogAction {...props(active, state)} />)
      expect(view.container.innerHTML).toBe('')
    }

    view.rerender(<ScheduleCatalogAction {...props(active)} />)
    expect(screen.getByRole('button', { name: '1 reminder' })).toBeDefined()
  })

  it('closes and removes the trigger when the last live record disappears', () => {
    const active = [record('active', 'after', START + 60_000)]
    const view = render(<><button type="button">Neighbor</button><ScheduleCatalogAction {...props(active)} /></>)
    const trigger = screen.getByRole('button', { name: '1 reminder' })
    fireEvent.click(trigger)
    trigger.focus()
    expect(screen.getByRole('list', { name: en['list.aria'] })).toBeDefined()

    view.rerender(<><button type="button">Neighbor</button><ScheduleCatalogAction {...props([])} /></>)
    expect(screen.queryByRole('button', { name: '1 reminder' })).toBeNull()
    expect(document.activeElement).toBe(document.body)
    expect(screen.getByRole('button', { name: 'Neighbor' })).not.toBe(document.activeElement)
  })
})

describe('ScheduleCatalogAction positioning', () => {
  it('portals the catalog to the body and left-aligns it when space is available', () => {
    const active = [record('active', 'after', START + 60_000)]
    const view = render(<ScheduleCatalogAction {...props(active)} />)
    const trigger = screen.getByRole('button', { name: '1 reminder' })
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

describe('ScheduleCatalogAction rows', () => {
  it('shows only prompt and the three derived metadata fields, with overdue records first', () => {
    const rawPrompt = '<img src=x onerror=alert(1)> Keep the complete long reminder prompt visible without truncation.'
    const overdue = record('hidden-id', 'after', START - 60_000, { prompt: rawPrompt })
    const every = record('every-id', 'every', START + 300_000, { prompt: 'Check metrics', everySeconds: 300 })
    const at = record('at-id', 'at', START + 3_600_000, { prompt: 'Join meeting' })
    render(<ScheduleCatalogAction {...props([at, every, overdue])} />)
    fireEvent.click(screen.getByRole('button'))

    expect(prompts()).toEqual([rawPrompt, 'Check metrics', 'Join meeting'])
    const rows = screen.getAllByRole('listitem')
    expect(within(rows[0]!).getByText('Overdue', { exact: true })).toBeDefined()
    expect(within(rows[1]!).getByText('Scheduled', { exact: true })).toBeDefined()
    expect(rows[0]?.textContent).toContain('Once')
    expect(rows[0]?.textContent).toContain('1 minute overdue')
    expect(rows[1]?.textContent).toContain('Every 5 minutes')
    expect(rows[1]?.textContent).toContain('in 5 minutes')
    expect(rows[2]?.textContent).toContain('Once')
    expect(rows[2]?.textContent).toContain('in 1 hour')
    expect(rows[2]?.textContent).toContain(formatScheduleLocalTime(at.scheduledAt, 'en'))
    expect(document.querySelector('img')).toBeNull()
    const text = screen.getByRole('list').textContent ?? ''
    expect(text).not.toContain('hidden-id')
    expect(text).not.toContain(overdue.scheduledAt)
    expect(text).not.toMatch(/Delete|Retry|Details/)
    expect(within(screen.getByRole('list')).queryAllByRole('button')).toHaveLength(0)
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
    expect(formatScheduleFrequency(record('once', 'at', START + 1_000), tZh)).toBe('单次')
    expect(tZh('status.scheduled')).toBe('等待中')
    expect(tZh('status.overdue')).toBe('已逾期')
  })

  it('formats absolute time with the active document locale instead of the runtime default', () => {
    document.documentElement.lang = 'de-DE'
    const item = record('localized', 'at', START + 3_600_000)
    const localized = formatScheduleLocalTime(item.scheduledAt, 'de-DE')
    expect(localized).not.toBe(formatScheduleLocalTime(item.scheduledAt))
    render(<ScheduleCatalogAction {...props([item])} />)
    fireEvent.click(screen.getByRole('button'))
    expect(screen.getByRole('listitem').textContent).toContain(localized)
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
    expect(screen.getAllByRole('listitem').every(row => (
      within(row).queryByText('Scheduled', { exact: true }) !== null
    ))).toBe(true)
    act(() => { vi.advanceTimersByTime(1_000) })
    expect(screen.getAllByRole('listitem').every(row => (
      within(row).queryByText('Overdue', { exact: true }) !== null
    ))).toBe(true)
  })
})

describe('ScheduleCatalogAction dismissal', () => {
  const active = [record('active', 'after', START + 60_000)]

  it('closes on Escape inside the catalog and restores trigger focus', () => {
    render(<ScheduleCatalogAction {...props(active)} />)
    const trigger = screen.getByRole('button', { name: '1 reminder' })
    fireEvent.click(trigger)
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    fireEvent.keyDown(screen.getByRole('list', { name: en['list.aria'] }), { key: 'Escape' })
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(trigger)
  })

  it('leaves the catalog open when Escape belongs to a sibling control', () => {
    render(<><ScheduleCatalogAction {...props(active)} /><button type="button">Sibling</button></>)
    const trigger = screen.getByRole('button', { name: '1 reminder' })
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
    const trigger = screen.getByRole('button', { name: '1 reminder' })
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
