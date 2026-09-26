// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { JobsSnapshot, JobView, ObservedJob } from '@deepseek-ai/dsh-api-job-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { JobListAction, type JobListActionProps } from '../src/client/JobListAction.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

const SESSION = 'session' as SessionId
const t: JobListActionProps['t'] = makeTranslate(zh)

/** A running job with nothing retained yet. */
function job(over: Partial<JobView> = {}): JobView {
  return {
    id: 'bash-1' as JobView['id'],
    kind: 'bash',
    label: 'pnpm run build',
    status: 'running',
    startedAt: 1_700_000_000_000,
    output: { total: 0, earliest: 0 },
    ...over,
  }
}

/** A job that left retained output behind, so its row offers a panel even once settled. */
function outputJob(over: Partial<JobView> = {}): JobView {
  return job({ output: { total: 12, earliest: 0 }, ...over })
}

function props(
  jobs: readonly JobView[],
  observe: JobListActionProps['observe'] = () => () => {},
  observed: Readonly<Record<string, ObservedJob>> = {},
  killJob: JobListActionProps['killJob'] = async () => true,
  watchRows: JobListActionProps['watchRows'] = () => () => {},
): JobListActionProps {
  const jobsState: JobsSnapshot = { rows: jobs.length > 0 ? { [SESSION]: jobs } : {}, observed }
  function useJobs<T>(select: (value: JobsSnapshot) => T): T {
    return select(jobsState)
  }
  return { sessionId: SESSION, useJobs, watchRows, observe, killJob, t } as JobListActionProps
}

function openList(): void {
  fireEvent.click(screen.getAllByRole('button')[0]!)
}

describe('JobListAction visibility', () => {
  it('renders nothing while the session sees no jobs', () => {
    const { container } = render(<JobListAction {...props([])} />)
    expect(container.innerHTML).toBe('')
  })

  it('watches the session roster while mounted and releases it on unmount', () => {
    const stop = vi.fn()
    const watchRows = vi.fn(() => stop)
    const { unmount } = render(<JobListAction {...props([], undefined, {}, undefined, watchRows)} />)
    expect(watchRows).toHaveBeenCalledWith(SESSION)
    expect(stop).not.toHaveBeenCalled()
    unmount()
    expect(stop).toHaveBeenCalledTimes(1)
  })

  it('counts live jobs on the trigger', () => {
    render(<JobListAction {...props([
      outputJob(),
      job({ id: 'subagent-1' as JobView['id'], kind: 'subagent', label: 'explore' }),
    ])} />)
    expect(screen.getByRole('button', { name: '2 个后台任务运行中' })).toBeDefined()
  })

  it('falls back to the total when nothing is live', () => {
    render(<JobListAction {...props([
      job({ status: 'completed', finishedAt: 1_700_000_003_000 }),
    ])} />)
    expect(screen.getByRole('button', { name: '1 个后台任务' })).toBeDefined()
  })
})

describe('JobListAction rows', () => {
  it('renders a settled job without retained output as a static row', () => {
    render(<JobListAction {...props([
      job({ id: 'subagent-1' as JobView['id'], kind: 'subagent', label: 'explore the repo', status: 'completed', finishedAt: 1_700_000_003_000 }),
    ])} />)
    expect(screen.getByRole('button', { name: '1 个后台任务' })).toBeDefined()
    openList()
    expect(screen.getByText('explore the repo')).toBeDefined()
    expect(screen.queryByRole('button', { name: zh['row.expandAria'].replace('{label}', 'explore the repo') })).toBeNull()
  })

  it('offers a panel on a live row before any output arrived', () => {
    render(<JobListAction {...props([job({ label: 'warming up' })])} />)
    openList()
    expect(screen.getByRole('button', { name: zh['row.expandAria'].replace('{label}', 'warming up') })).toBeDefined()
  })

  it('shows the live progress line in place of the status word', () => {
    render(<JobListAction {...props([job({ status: 'stopping', progress: 'winding down' })])} />)
    openList()
    const list = screen.getByRole('list', { name: zh['list.aria'] })
    expect(within(list).getByText('pnpm run build')).toBeDefined()
    expect(within(list).getByText('winding down')).toBeDefined()
  })

  it('folds the settled tail behind its count while live work exists, and clears on demand', () => {
    const settled = [job({ id: 'bash-2' as JobView['id'], label: 'settled work', status: 'completed', finishedAt: 1_700_000_012_000 })]
    render(<JobListAction {...props([job(), ...settled])} />)
    openList()
    expect(screen.getByText(zh['section.live'])).toBeDefined()
    const toggle = screen.getByRole('button', { name: zh['section.settledCount'].replace('{count}', '1') })
    // Folded by default while something runs; the toggle expands it.
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByText('settled work')).toBeNull()
    fireEvent.click(toggle)
    expect(screen.getByText('settled work')).toBeDefined()
    // Clearing hides the tail client-side and drops the whole section line.
    fireEvent.click(screen.getByRole('button', { name: zh['section.clear'] }))
    expect(screen.queryByText('settled work')).toBeNull()
    expect(screen.queryByRole('button', { name: zh['section.clear'] })).toBeNull()
  })

  it('opens the settled tail by default when nothing is live', () => {
    render(<JobListAction {...props([
      job({ status: 'completed', finishedAt: 1_700_000_012_000 }),
    ])} />)
    openList()
    expect(screen.getByText('pnpm run build')).toBeDefined()
    expect(screen.getByRole('button', { name: zh['section.settledCount'].replace('{count}', '1') }).getAttribute('aria-expanded')).toBe('true')
  })

  it('clearing drops an expanded settled panel with its rows', () => {
    const observe = vi.fn(() => () => {})
    render(<JobListAction {...props(
      [outputJob({ id: 'bash-2' as JobView['id'], label: 'settled work', status: 'completed', finishedAt: 1_700_000_012_000 })],
      observe,
    )} />)
    openList()
    // Nothing live: the tail is open; expand the settled row's output panel.
    fireEvent.click(screen.getByRole('button', { name: zh['row.expandAria'].replace('{label}', 'settled work') }))
    expect(observe).toHaveBeenCalledWith(SESSION, 'bash-2')
    fireEvent.click(screen.getByRole('button', { name: zh['section.clear'] }))
    expect(screen.queryByText('settled work')).toBeNull()
    expect(screen.queryByRole('button', { name: zh['row.collapseAria'].replace('{label}', 'settled work') })).toBeNull()
  })

  it('shows a settled duration and ticks a live one', () => {
    vi.useFakeTimers({ now: 1_700_000_020_000 })
    render(<JobListAction {...props([
      job({ startedAt: 1_700_000_015_000 }),
      job({ id: 'bash-2' as JobView['id'], status: 'completed', startedAt: 1_700_000_000_000, finishedAt: 1_700_000_012_000 }),
      job({ id: 'bash-3' as JobView['id'], status: 'completed', startedAt: 1_699_996_200_000, finishedAt: 1_700_000_000_000 }),
      job({ id: 'bash-4' as JobView['id'], status: 'completed', startedAt: 1_699_999_900_000, finishedAt: 1_699_999_972_000 }),
    ])} />)
    openList()
    fireEvent.click(screen.getByRole('button', { name: zh['section.settledCount'].replace('{count}', '3') }))
    expect(screen.getByText('5秒')).toBeDefined()
    expect(screen.getByText('12秒')).toBeDefined()
    expect(screen.getByText('1小时3分')).toBeDefined()
    expect(screen.getByText('1分12秒')).toBeDefined()
    act(() => { vi.advanceTimersByTime(1_000) })
    expect(screen.getByText('6秒')).toBeDefined()
  })

  it('lists rows with kind, label, and detail-or-status', () => {
    render(<JobListAction {...props([
      outputJob(),
      outputJob({ id: 'bash-2' as JobView['id'], status: 'failed', detail: 'exit code: 3', finishedAt: 1_700_000_002_000 }),
    ])} />)
    openList()
    fireEvent.click(screen.getByRole('button', { name: zh['section.settledCount'].replace('{count}', '1') }))
    const list = screen.getByRole('list', { name: zh['list.aria'] })
    const items = within(list).getAllByRole('listitem')
    // The section line is a listitem too now: live row, section, settled row.
    expect(items).toHaveLength(3)
    expect(items[0]?.textContent).toContain('pnpm run build')
    // A live row's second line is kind · duration; the status word only
    // appears through a detail (none while running).
    expect(items[0]?.textContent).toMatch(/小时|分|秒/)
    expect(items[2]?.textContent).toContain('exit code: 3')
  })

  it('orders live rows first by start and settled rows newest-first with tie-breaks', () => {
    const settled = (id: string, label: string, startedAt: number, finishedAt?: number): JobView =>
      job({
        id: id as JobView['id'],
        label,
        status: 'completed',
        startedAt,
        ...finishedAt !== undefined ? { finishedAt } : {},
      })
    render(<JobListAction {...props([
      settled('bash-a', 'settled-a', 10, 100),
      settled('bash-c', 'settled-c', 80, 100),
      settled('bash-b', 'settled-b', 90),
      settled('bash-e', 'settled-e', 95, 50),
      settled('bash-d', 'settled-d', 10, 200),
      job({ id: 'bash-l1' as JobView['id'], label: 'live-1', startedAt: 5 }),
      job({ id: 'bash-l2' as JobView['id'], label: 'live-2', startedAt: 3 }),
    ])} />)
    openList()
    fireEvent.click(screen.getByRole('button', { name: zh['section.settledCount'].replace('{count}', '5') }))
    const labels = within(screen.getByRole('list', { name: zh['list.aria'] }))
      .getAllByRole('listitem')
      .map(item => item.querySelector('[title]')?.getAttribute('title'))
      .filter((title): title is string => title != null && !title.startsWith('已运行') && !title.startsWith('耗时'))
    expect(labels).toEqual([
      'live-2', 'live-1', 'settled-d', 'settled-a', 'settled-c', 'settled-b', 'settled-e',
    ])
    expect(screen.getAllByText(zh['status.completed']).length).toBeGreaterThan(0)
  })

  it('breaks a settled tie on start order so map iteration never decides it', () => {
    render(<JobListAction {...props([
      job({ id: 'bash-2' as JobView['id'], label: 'second', status: 'completed', startedAt: 1_700_000_000_000 + 10, finishedAt: 1_700_000_000_000 + 100 }),
      job({ id: 'bash-1' as JobView['id'], label: 'first', status: 'completed', startedAt: 1_700_000_000_000, finishedAt: 1_700_000_000_000 + 100 }),
    ])} />)
    openList()
    expect(within(screen.getByRole('list')).getAllByRole('listitem').map(row => row.querySelector('[title]')?.getAttribute('title')).filter(title => title !== undefined))
      .toEqual(['first', 'second'])
  })

  it('prefers the producer detail over the generic status word', () => {
    render(<JobListAction {...props([
      job({ status: 'killed', detail: 'signal: SIGTERM', finishedAt: 1_700_000_000_000 + 2_000 }),
    ])} />)
    openList()
    expect(within(screen.getByRole('list')).getByText('signal: SIGTERM')).toBeDefined()
  })

  it('renders settled status words and every lifecycle indicator', () => {
    render(<JobListAction {...props([
      job({ id: 'bash-1' as JobView['id'], label: 'a', status: 'running' }),
      job({ id: 'bash-2' as JobView['id'], label: 'b', status: 'stopping' }),
      job({ id: 'bash-3' as JobView['id'], label: 'c', status: 'completed', finishedAt: 1_700_000_000_000 }),
      job({ id: 'bash-4' as JobView['id'], label: 'd', status: 'killed', finishedAt: 1_700_000_000_000 }),
      job({ id: 'bash-5' as JobView['id'], label: 'e', status: 'failed', finishedAt: 1_700_000_000_000 }),
    ])} />)
    openList()
    fireEvent.click(screen.getByRole('button', { name: zh['section.settledCount'].replace('{count}', '3') }))
    for (const word of ['已完成', '已取消', '已失败']) {
      expect(within(screen.getByRole('list')).getByText(word)).toBeDefined()
    }
    expect([...screen.getByRole('list').querySelectorAll('li [data-state]')].map(node => node.getAttribute('data-state')))
      .toEqual(['ongoing', 'warning', 'done', 'warning', 'error'])
  })
})

describe('JobListAction observation', () => {
  it('marks killed rows, renders every output line unfolded, and copies the command', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const lines = Array.from({ length: 24 }, (_value, index) => `line ${index + 1}`).join('\n')
    const view: ObservedJob = {
      jobId: 'bash-1' as JobView['id'],
      text: lines,
      gapBefore: false,
      streaming: false,
    }
    render(<JobListAction {...props(
      [outputJob({ status: 'killed', finishedAt: 1_700_000_001_000 })],
      undefined,
      { 'bash-1': view },
    )} />)
    openList()
    expect(screen.getByText(zh['status.killed'])).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: zh['row.expandAria'].replace('{label}', 'pnpm run build') }))
    // The panel scrolls instead of folding: every line renders, no fold control.
    expect(screen.getByText('line 1')).toBeDefined()
    expect(screen.getByText('line 24')).toBeDefined()
    expect(screen.queryByRole('button', { name: zh['terminal.expandAria'].replace('{n}', '8') })).toBeNull()
    // The panel draws no state dot or label of its own — the row carries it.
    expect(screen.queryByText(zh['terminal.done'])).toBeNull()
    // The copy control carries the command, not the output.
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh['terminal.copy'] })) })
    expect(writeText).toHaveBeenCalledWith('pnpm run build')
  })

  it('shifts an overflowing popover back inside the viewport and follows resizes', () => {
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(440)
    vi.spyOn(HTMLDivElement.prototype, 'getBoundingClientRect').mockReturnValue({ left: 344 } as DOMRect)
    const originalWidth = window.innerWidth
    Object.defineProperty(window, 'innerWidth', { value: 700, configurable: true, writable: true })
    try {
      render(<JobListAction {...props([outputJob()])} />)
      openList()
      const menu = screen.getByRole('list', { name: zh['list.aria'] })
      // 700 - 12 - 440 - 344 = -96: the popover moves left to keep the margin.
      expect(menu.style.left).toBe('-96px')

      window.innerWidth = 900
      fireEvent(window, new Event('resize'))
      // 900 - 12 - 440 - 344 = 104 > 0: the anchored position fits again.
      expect(menu.style.left).toBe('0px')
    } finally {
      Object.defineProperty(window, 'innerWidth', { value: originalWidth, configurable: true, writable: true })
    }
  })

  it('never crosses the left viewport margin for an oversized popover', () => {
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(800)
    vi.spyOn(HTMLDivElement.prototype, 'getBoundingClientRect').mockReturnValue({ left: 4 } as DOMRect)
    const originalWidth = window.innerWidth
    Object.defineProperty(window, 'innerWidth', { value: 700, configurable: true, writable: true })
    try {
      render(<JobListAction {...props([outputJob()])} />)
      openList()
      const menu = screen.getByRole('list', { name: zh['list.aria'] })
      // max(12 - 4, min(0, 700 - 12 - 800 - 4)) = 8: clamped at the left margin.
      expect(menu.style.left).toBe('8px')
    } finally {
      Object.defineProperty(window, 'innerWidth', { value: originalWidth, configurable: true, writable: true })
    }
  })

  it('ignores other keys while open and closes once the roster empties', () => {
    const settledPair = [
      outputJob({ id: 'bash-1' as JobView['id'], status: 'completed', finishedAt: 2 }),
      outputJob({ id: 'bash-2' as JobView['id'], status: 'completed', finishedAt: 3 }),
    ]
    const { rerender } = render(<JobListAction {...props(settledPair)} />)
    expect(screen.getByRole('button', { name: '2 个后台任务' })).toBeDefined()
    openList()
    const list = screen.getByRole('list', { name: zh['list.aria'] })
    fireEvent.keyDown(list, { key: 'a' })
    expect(screen.getByRole('list', { name: zh['list.aria'] })).toBeDefined()
    // The roster emptying unmounts the control entirely; the open flag resets first.
    rerender(<JobListAction {...props([])} />)
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('starts observing on expand with the session identity, renders the live text, and stops on collapse', () => {
    const stop = vi.fn()
    const observe = vi.fn(() => stop)
    const view: ObservedJob = {
      jobId: 'bash-1' as JobView['id'],
      text: 'compiling…\n',
      gapBefore: false,
      streaming: true,
    }
    render(<JobListAction {...props([outputJob()], observe, { 'bash-1': view })} />)
    openList()
    fireEvent.click(screen.getByRole('button', { name: zh['row.expandAria'].replace('{label}', 'pnpm run build') }))
    expect(observe).toHaveBeenCalledWith(SESSION, 'bash-1')
    expect(screen.getByText('compiling…')).toBeDefined()

    fireEvent.click(screen.getByRole('button', { name: zh['row.collapseAria'].replace('{label}', 'pnpm run build') }))
    expect(stop).toHaveBeenCalledTimes(1)
  })

  it('renders a running panel with the prompt alone for a live row whose output has not arrived', () => {
    const view: ObservedJob = {
      jobId: 'bash-1' as JobView['id'],
      text: '',
      gapBefore: false,
      streaming: true,
    }
    const { container } = render(<JobListAction {...props([job()], undefined, { 'bash-1': view })} />)
    openList()
    fireEvent.click(screen.getByRole('button', { name: zh['row.expandAria'].replace('{label}', 'pnpm run build') }))
    expect(container.querySelector('[data-running]')).not.toBeNull()
    expect(screen.queryByText(zh['terminal.noOutput'])).toBeNull()
  })

  it('surfaces retention gaps and stream failures above the panel', () => {
    const view: ObservedJob = {
      jobId: 'bash-1' as JobView['id'],
      text: 'tail only',
      gapBefore: true,
      streaming: false,
      error: 'connection lost',
    }
    render(<JobListAction {...props([outputJob()], undefined, { 'bash-1': view })} />)
    openList()
    fireEvent.click(screen.getByRole('button', { name: zh['row.expandAria'].replace('{label}', 'pnpm run build') }))
    expect(screen.getByText(zh['output.gap'])).toBeDefined()
    expect(screen.getByText('实时输出流中断：connection lost')).toBeDefined()
  })

  it('stops observation when the popover closes via Escape', () => {
    const stop = vi.fn()
    render(<JobListAction {...props([outputJob()], () => stop)} />)
    openList()
    fireEvent.click(screen.getByRole('button', { name: zh['row.expandAria'].replace('{label}', 'pnpm run build') }))
    fireEvent.keyDown(screen.getByRole('list', { name: zh['list.aria'] }), { key: 'Escape' })
    expect(stop).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('list', { name: zh['list.aria'] })).toBeNull()
  })

  it('folds an expanded panel whose row left the roster', () => {
    const stop = vi.fn()
    // One stable observe identity across renders, as the inject face provides.
    const observe = () => stop
    const { rerender } = render(<JobListAction {...props([outputJob()], observe)} />)
    openList()
    fireEvent.click(screen.getByRole('button', { name: zh['row.expandAria'].replace('{label}', 'pnpm run build') }))
    rerender(<JobListAction {...props([outputJob({ id: 'bash-2' as JobView['id'], label: 'other' })], observe)} />)
    expect(stop).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('button', { name: zh['row.collapseAria'].replace('{label}', 'other') })).toBeNull()
  })
})

describe('JobListAction human kill', () => {
  const stopTitle = (label: string): string => zh['kill.stop'].replace('{label}', label)

  it('offers the stop control only on running rows', () => {
    render(<JobListAction {...props([
      job(),
      job({ id: 'bash-2' as JobView['id'], label: 'done', status: 'completed', finishedAt: 1_700_000_100_000 }),
    ])} />)
    openList()
    expect(screen.getByTitle(stopTitle('pnpm run build'))).toBeDefined()
    expect(screen.queryByTitle(stopTitle('done'))).toBeNull()
  })

  it('arms on the first press and kills on the confirming press', async () => {
    const killJob = vi.fn(async () => true)
    render(<JobListAction {...props([job()], undefined, {}, killJob)} />)
    openList()
    const stop = screen.getByTitle(stopTitle('pnpm run build'))
    fireEvent.click(stop)
    expect(killJob).not.toHaveBeenCalled()
    expect(stop.getAttribute('data-kill-state')).toBe('armed')
    expect(screen.getByTitle(zh['kill.confirm'])).toBe(stop)
    // The armed step is legible without hover: the button carries the label.
    expect(stop.textContent).toBe(zh['kill.confirmAction'])
    await act(async () => { fireEvent.click(stop) })
    expect(killJob).toHaveBeenCalledWith(SESSION, 'bash-1')
    // An admitted kill stays pending: the unary response and the jobs frames
    // have no cross-carrier ordering, so only the authoritative frame (the row
    // leaving the killable set) releases the control — never the response.
    expect(stop.getAttribute('data-kill-state')).toBe('pending')
    expect(stop.hasAttribute('disabled')).toBe(true)
  })

  it('an armed press disarms after the confirmation window', () => {
    vi.useFakeTimers()
    const killJob = vi.fn(async () => true)
    render(<JobListAction {...props([job()], undefined, {}, killJob)} />)
    openList()
    const stop = screen.getByTitle(stopTitle('pnpm run build'))
    fireEvent.click(stop)
    expect(stop.getAttribute('data-kill-state')).toBe('armed')
    act(() => { vi.advanceTimersByTime(3_000) })
    expect(stop.getAttribute('data-kill-state')).toBe('idle')
    expect(killJob).not.toHaveBeenCalled()
  })

  it('a rejected kill shows its hint and then resets', async () => {
    // Fake timers from the start so the failed-hint reset arms on the fake clock.
    vi.useFakeTimers()
    const killJob = vi.fn(async () => false)
    render(<JobListAction {...props([job()], undefined, {}, killJob)} />)
    openList()
    const stop = screen.getByTitle(stopTitle('pnpm run build'))
    fireEvent.click(stop)
    await act(async () => { fireEvent.click(stop) })
    expect(stop.getAttribute('data-kill-state')).toBe('failed')
    expect(screen.getByTitle(zh['kill.failed'])).toBe(stop)
    act(() => { vi.advanceTimersByTime(4_000) })
    expect(stop.getAttribute('data-kill-state')).toBe('idle')
  })

  it('arming a second row disarms the first', () => {
    render(<JobListAction {...props([
      job(),
      job({ id: 'bash-2' as JobView['id'], label: 'pnpm run watch' }),
    ])} />)
    openList()
    const first = screen.getByTitle(stopTitle('pnpm run build'))
    fireEvent.click(first)
    expect(first.getAttribute('data-kill-state')).toBe('armed')
    const second = screen.getByTitle(stopTitle('pnpm run watch'))
    fireEvent.click(second)
    expect(second.getAttribute('data-kill-state')).toBe('armed')
    expect(first.getAttribute('data-kill-state')).toBe('idle')
  })

  it('a kill resolving after another row armed leaves the newer phase alone', async () => {
    let resolveKill!: (ok: boolean) => void
    const killJob = vi.fn(() => new Promise<boolean>((resolve) => { resolveKill = resolve }))
    render(<JobListAction {...props([
      job(),
      job({ id: 'bash-2' as JobView['id'], label: 'pnpm run watch' }),
    ], undefined, {}, killJob)} />)
    openList()
    const first = screen.getByTitle(stopTitle('pnpm run build'))
    fireEvent.click(first)
    fireEvent.click(first)
    expect(killJob).toHaveBeenCalledTimes(1)
    // While the first kill is in flight, the user arms the second row; the
    // late resolution must not clobber that newer phase.
    const second = screen.getByTitle(stopTitle('pnpm run watch'))
    fireEvent.click(second)
    expect(second.getAttribute('data-kill-state')).toBe('armed')
    await act(async () => { resolveKill(false) })
    expect(second.getAttribute('data-kill-state')).toBe('armed')
    expect(first.getAttribute('data-kill-state')).toBe('idle')
  })

  it('clears an armed phase whose row stopped being killable', () => {
    const { rerender } = render(<JobListAction {...props([job()])} />)
    openList()
    const stop = screen.getByTitle(stopTitle('pnpm run build'))
    fireEvent.click(stop)
    expect(stop.getAttribute('data-kill-state')).toBe('armed')
    rerender(<JobListAction {...props([job({ status: 'stopping' })])} />)
    // The stopping row offers no kill control any more, and the stale phase is gone.
    expect(screen.queryByTitle(stopTitle('pnpm run build'))).toBeNull()
    expect(document.querySelector('[data-kill-state]')).toBeNull()
  })
})
