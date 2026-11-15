// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSyncExternalStore } from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { JobsSnapshot, JobView, ObservedJob } from '@deepseek-ai/dsh-api-job-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { JobsRunningIndicator, JobsSection, type JobsRunningIndicatorProps, type JobsSectionProps } from '../src/client/JobsSection.tsx'
import { createJobsSectionStore } from '../src/client/jobs-store.ts'
import { en, zh, ru } from '../src/client/locales.ts'
import type { PanelDetailsProps, PanelFoldProps } from '@deepseek-ai/dsh-client-ui-session-panel/client'

beforeEach(() => {
  class TooltipObserver implements ResizeObserver {
    constructor(private readonly callback: ResizeObserverCallback) {}
    observe(target: Element): void {
      const size = { inlineSize: 160, blockSize: 30 }
      this.callback([{
        target, borderBoxSize: [size], contentBoxSize: [size], devicePixelContentBoxSize: [size], contentRect: new DOMRect(),
      }], this)
    }
    unobserve(): void {}
    disconnect(): void {}
  }
  vi.stubGlobal('ResizeObserver', TooltipObserver)
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })))
})

beforeEach(() => {
  vi.stubGlobal('CSS', { supports: (property: string) => property === '-webkit-backdrop-filter' })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

const SESSION = 'session' as SessionId
const t: JobsSectionProps['t'] = makeTranslate(zh)

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

/** One Session's section store, as the registration mints it. */
type SectionStore = ReturnType<ReturnType<typeof createJobsSectionStore>['create']>

/**
 * The Session panel's Factories as this suite renders them: the fold control as a button with its state, name, and
 * label, and a row's details as one element per part in order. ui-session-panel's own suite owns their markup.
 */
function renderPanelFactory(name: string, input: object) {
  if (name === 'conversation.session.panel.details') {
    const { title, lines = [], status, facts = [] } = input as PanelDetailsProps
    return (
      <div data-session-panel-details="">
        {title !== undefined && <div>{title}</div>}
        {lines.map(line => <div key={line}>{line}</div>)}
        {status !== undefined && <div data-state={status.state}>{status.label}</div>}
        {facts.length > 0 && <div>{facts.map(fact => <span key={fact.kind} data-fact={fact.kind}>{fact.label}</span>)}</div>}
      </div>
    )
  }
  const fold = input as PanelFoldProps
  return <button type="button" data-fold="" aria-expanded={fold.expanded} aria-label={fold.name} onClick={fold.onToggle}>{fold.label}</button>
}

/** Test-local selector hook over a framework-neutral store instance. */
function hookOf<T>(instance: { subscribe: (listener: () => void) => () => void; getSnapshot: () => T }) {
  return function useSelector<S>(select: (state: T) => S): S {
    return select(useSyncExternalStore(instance.subscribe, instance.getSnapshot))
  }
}

function props(
  jobs: readonly JobView[],
  observe: JobsSectionProps['observe'] = () => () => {},
  observed: Readonly<Record<string, ObservedJob>> = {},
  killJob: JobsSectionProps['killJob'] = async () => true,
  watchRows: JobsSectionProps['watchRows'] = () => () => {},
  store: SectionStore = createJobsSectionStore().create(),
  mayKill = true,
): JobsSectionProps {
  const jobsState: JobsSnapshot = { rows: jobs.length > 0 ? { [SESSION]: jobs } : {}, observed }
  function useJobs<T>(select: (value: JobsSnapshot) => T): T {
    return select(jobsState)
  }
  return {
    sessionId: SESSION, useJobs, watchRows, observe, killJob, useStore: hookOf(store), actions: store.actions, t,
    useAccess: () => mayKill, renderFactorySlot: renderPanelFactory,
  } as Pick<JobsSectionProps,
    'sessionId' | 'useJobs' | 'watchRows' | 'observe' | 'killJob' | 'useStore' | 'actions' | 't' | 'useAccess' | 'renderFactorySlot'> as JobsSectionProps
}

describe('JobsRunningIndicator', () => {
  function indicator(jobs: readonly JobView[], panelShown: boolean, watchRows: JobsSectionProps['watchRows'] = () => () => {}) {
    const section = props(jobs, undefined, {}, undefined, watchRows)
    const dotProps = {
      sessionId: section.sessionId, useJobs: section.useJobs, watchRows: section.watchRows, t: section.t, panelShown,
    } as Pick<JobsRunningIndicatorProps, 'sessionId' | 'useJobs' | 'watchRows' | 't' | 'panelShown'> as JobsRunningIndicatorProps
    return render(<JobsRunningIndicator {...dotProps} />)
  }

  it('shows a named dot while jobs run and the panel does not show them, counting stopping jobs', () => {
    const view = indicator([
      job(), job({ id: 'bash-2' as JobView['id'], status: 'stopping' }), job({ id: 'bash-3' as JobView['id'], status: 'completed' }),
    ], false)
    expect(view.container.querySelector('[data-jobs-running]')?.textContent).toBe(zh['indicator.running'].replace('{count}', '2'))
  })

  it('renders nothing while the panel shows, without jobs, and after they settle', () => {
    expect(indicator([job()], true).container.innerHTML).toBe('')
    cleanup()
    expect(indicator([], false).container.innerHTML).toBe('')
    cleanup()
    expect(indicator([job({ status: 'completed' })], false).container.innerHTML).toBe('')
  })

  it('keeps the roster stream open while the toggle is mounted, even while the panel shows', () => {
    const stop = vi.fn()
    const watchRows = vi.fn(() => stop)
    const view = indicator([], true, watchRows)
    expect(watchRows).toHaveBeenCalledWith(SESSION)
    expect(stop).not.toHaveBeenCalled()
    view.unmount()
    expect(stop).toHaveBeenCalledOnce()
  })
})

describe('JobsSection visibility', () => {
  it('renders nothing while the session sees no jobs', () => {
    const { container } = render(<JobsSection {...props([])} />)
    expect(container.innerHTML).toBe('')
  })

  it('watches the session roster while mounted and releases it on unmount', () => {
    const stop = vi.fn()
    const watchRows = vi.fn(() => stop)
    const { unmount } = render(<JobsSection {...props([], undefined, {}, undefined, watchRows)} />)
    expect(watchRows).toHaveBeenCalledWith(SESSION)
    expect(stop).not.toHaveBeenCalled()
    unmount()
    expect(stop).toHaveBeenCalledTimes(1)
  })

})

describe('JobsSection rows', () => {
  it('renders a settled job without retained output as a static row', () => {
    render(<JobsSection {...props([
      job({ id: 'subagent-1' as JobView['id'], kind: 'subagent', label: 'explore the repo', status: 'completed', finishedAt: 1_700_000_003_000 }),
    ])} />)
    // The section heading names the region, so the list carries no name of its own.
    expect(screen.getByRole('list').hasAttribute('aria-label')).toBe(false)
    expect(screen.getByText('explore the repo')).toBeDefined()
    expect(screen.queryByRole('button', { name: zh['row.expandAria'].replace('{label}', 'explore the repo') })).toBeNull()
  })

  it('offers a panel on a live row before any output arrived', () => {
    render(<JobsSection {...props([job({ label: 'warming up' })])} />)
    expect(screen.getByRole('button', { name: zh['row.expandAria'].replace('{label}', 'warming up') })).toBeDefined()
  })

  it('shows the live progress line in place of the status word', () => {
    render(<JobsSection {...props([job({ status: 'stopping', progress: 'winding down' })])} />)
    const list = screen.getByRole('list')
    expect(within(list).getByText('pnpm run build')).toBeDefined()
    expect(within(list).getByText('bash · winding down')).toBeDefined()
  })

  it('folds the settled tail behind its count while live work exists, and clears on demand', () => {
    const settled = [job({ id: 'bash-2' as JobView['id'], label: 'settled work', status: 'completed', finishedAt: 1_700_000_012_000 })]
    render(<JobsSection {...props([job(), ...settled])} />)
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

  it('keeps cleared rows hidden when the section mounts again for the same Session', () => {
    const store = createJobsSectionStore().create()
    const settled = job({ id: 'bash-2' as JobView['id'], label: 'settled work', status: 'completed', finishedAt: 1_700_000_012_000 })
    const first = render(<JobsSection {...props([job(), settled], undefined, {}, undefined, undefined, store)} />)
    fireEvent.click(screen.getByRole('button', { name: zh['section.settledCount'].replace('{count}', '1') }))
    fireEvent.click(screen.getByRole('button', { name: zh['section.clear'] }))
    first.unmount()
    render(<JobsSection {...props([job(), settled], undefined, {}, undefined, undefined, store)} />)
    expect(screen.queryByRole('button', { name: zh['section.settledCount'].replace('{count}', '1') })).toBeNull()
    expect(screen.queryByText('settled work')).toBeNull()
  })

  it('keeps the settled fold the user opened when the section mounts again for the same Session', () => {
    const store = createJobsSectionStore().create()
    const settled = job({ id: 'bash-2' as JobView['id'], label: 'settled work', status: 'completed', finishedAt: 1_700_000_012_000 })
    const toggle = (): HTMLElement => screen.getByRole('button', { name: zh['section.settledCount'].replace('{count}', '1') })
    const first = render(<JobsSection {...props([job(), settled], undefined, {}, undefined, undefined, store)} />)
    fireEvent.click(toggle())
    first.unmount()
    render(<JobsSection {...props([job(), settled], undefined, {}, undefined, undefined, store)} />)
    expect([toggle().getAttribute('aria-expanded'), screen.queryByText('settled work') !== null]).toEqual(['true', true])
  })

  it('opens the settled tail by default when nothing is live', () => {
    render(<JobsSection {...props([
      job({ status: 'completed', finishedAt: 1_700_000_012_000 }),
    ])} />)
    expect(screen.getByText('pnpm run build')).toBeDefined()
    expect(screen.getByRole('button', { name: zh['section.settledCount'].replace('{count}', '1') }).getAttribute('aria-expanded')).toBe('true')
  })

  it('clearing drops an expanded settled panel with its rows', () => {
    const observe = vi.fn(() => () => {})
    render(<JobsSection {...props(
      [outputJob({ id: 'bash-2' as JobView['id'], label: 'settled work', status: 'completed', finishedAt: 1_700_000_012_000 })],
      observe,
    )} />)
    // Nothing live: the tail is open; expand the settled row's output panel.
    fireEvent.click(screen.getByRole('button', { name: zh['row.expandAria'].replace('{label}', 'settled work') }))
    expect(observe).toHaveBeenCalledWith(SESSION, 'bash-2')
    fireEvent.click(screen.getByRole('button', { name: zh['section.clear'] }))
    expect(screen.queryByText('settled work')).toBeNull()
    expect(screen.queryByRole('button', { name: zh['row.collapseAria'].replace('{label}', 'settled work') })).toBeNull()
  })

  it('shows a settled duration and ticks a live one', () => {
    vi.useFakeTimers({ now: 1_700_000_020_000 })
    render(<JobsSection {...props([
      job({ startedAt: 1_700_000_015_000 }),
      job({ id: 'bash-2' as JobView['id'], status: 'completed', startedAt: 1_700_000_000_000, finishedAt: 1_700_000_012_000 }),
      job({ id: 'bash-3' as JobView['id'], status: 'completed', startedAt: 1_699_996_200_000, finishedAt: 1_700_000_000_000 }),
      job({ id: 'bash-4' as JobView['id'], status: 'completed', startedAt: 1_699_999_900_000, finishedAt: 1_699_999_972_000 }),
    ])} />)
    fireEvent.click(screen.getByRole('button', { name: zh['section.settledCount'].replace('{count}', '3') }))
    expect(screen.getByText('5秒')).toBeDefined()
    expect(screen.getByText('12秒')).toBeDefined()
    expect(screen.getByText('1小时3分')).toBeDefined()
    expect(screen.getByText('1分12秒')).toBeDefined()
    act(() => { vi.advanceTimersByTime(1_000) })
    expect(screen.getByText('6秒')).toBeDefined()
  })

  it('lists rows with kind, label, and detail-or-status', () => {
    render(<JobsSection {...props([
      outputJob(),
      outputJob({ id: 'bash-2' as JobView['id'], status: 'failed', detail: 'exit code: 3', finishedAt: 1_700_000_002_000 }),
    ])} />)
    fireEvent.click(screen.getByRole('button', { name: zh['section.settledCount'].replace('{count}', '1') }))
    const list = screen.getByRole('list')
    const items = within(list).getAllByRole('listitem')
    // The section line is a listitem too now: live row, section, settled row.
    expect(items).toHaveLength(3)
    expect(items[0]?.textContent).toContain('pnpm run build')
    // A live row's second line is kind · duration; the status word only
    // appears through a detail (none while running).
    expect(items[0]?.textContent).toMatch(/小时|分|秒/)
    expect(items[2]?.textContent).toContain('exit code: 3')
  })

  it('orders live rows first by latest start and settled rows newest-first with tie-breaks', () => {
    const settled = (id: string, label: string, startedAt: number, finishedAt?: number): JobView =>
      job({
        id: id as JobView['id'],
        label,
        status: 'completed',
        startedAt,
        ...finishedAt !== undefined ? { finishedAt } : {},
      })
    render(<JobsSection {...props([
      settled('bash-a', 'settled-a', 10, 100),
      settled('bash-c', 'settled-c', 80, 100),
      settled('bash-b', 'settled-b', 90),
      settled('bash-e', 'settled-e', 95, 50),
      settled('bash-d', 'settled-d', 10, 200),
      job({ id: 'bash-l1' as JobView['id'], label: 'live-1', startedAt: 5 }),
      job({ id: 'bash-l2' as JobView['id'], label: 'live-2', startedAt: 3 }),
    ])} />)
    fireEvent.click(screen.getByRole('button', { name: zh['section.settledCount'].replace('{count}', '5') }))
    const labels = within(screen.getByRole('list'))
      .getAllByRole('listitem')
      .map(item => item.querySelector('[data-job-label]')?.textContent)
      .filter((label): label is string => label != null)
    expect(labels).toEqual([
      'live-1', 'live-2', 'settled-d', 'settled-a', 'settled-c', 'settled-b', 'settled-e',
    ])
    expect(screen.getAllByText(`bash · ${zh['status.completed']}`).length).toBeGreaterThan(0)
  })

  it('breaks a settled tie on start order so map iteration never decides it', () => {
    render(<JobsSection {...props([
      job({ id: 'bash-2' as JobView['id'], label: 'second', status: 'completed', startedAt: 1_700_000_000_000 + 10, finishedAt: 1_700_000_000_000 + 100 }),
      job({ id: 'bash-1' as JobView['id'], label: 'first', status: 'completed', startedAt: 1_700_000_000_000, finishedAt: 1_700_000_000_000 + 100 }),
    ])} />)
    expect(within(screen.getByRole('list')).getAllByRole('listitem').map(row => row.querySelector('[data-job-label]')?.textContent).filter(label => label !== undefined))
      .toEqual(['first', 'second'])
  })

  it('prefers the producer detail over the generic status word', () => {
    render(<JobsSection {...props([
      job({ status: 'killed', detail: 'signal: SIGTERM', finishedAt: 1_700_000_000_000 + 2_000 }),
    ])} />)
    expect(within(screen.getByRole('list')).getByText('bash · signal: SIGTERM')).toBeDefined()
  })

  it('renders settled status words and every lifecycle indicator', () => {
    render(<JobsSection {...props([
      job({ id: 'bash-1' as JobView['id'], label: 'a', status: 'running' }),
      job({ id: 'bash-2' as JobView['id'], label: 'b', status: 'stopping' }),
      job({ id: 'bash-3' as JobView['id'], label: 'c', status: 'completed', finishedAt: 1_700_000_000_000 }),
      job({ id: 'bash-4' as JobView['id'], label: 'd', status: 'killed', finishedAt: 1_700_000_000_000 }),
      job({ id: 'bash-5' as JobView['id'], label: 'e', status: 'failed', finishedAt: 1_700_000_000_000 }),
    ])} />)
    fireEvent.click(screen.getByRole('button', { name: zh['section.settledCount'].replace('{count}', '3') }))
    for (const word of ['已完成', '已取消', '已失败']) {
      expect(within(screen.getByRole('list')).getByText(`bash · ${word}`)).toBeDefined()
    }
    expect([...screen.getByRole('list').querySelectorAll('li [data-state]')].map(node => node.getAttribute('data-state')))
      .toEqual(['ongoing', 'warning', 'done', 'warning', 'error'])
  })

  it('marks a job that finished with a nonzero exit code with the warning dot', () => {
    render(<JobsSection {...props([
      job({ id: 'bash-1' as JobView['id'], label: 'a', status: 'completed', exitCode: 71, detail: 'exit code: 71', finishedAt: 1_700_000_000_003 }),
      job({ id: 'bash-2' as JobView['id'], label: 'b', status: 'completed', exitCode: 0, detail: 'exit code: 0', finishedAt: 1_700_000_000_002 }),
      job({ id: 'bash-3' as JobView['id'], label: 'c', status: 'completed', finishedAt: 1_700_000_000_001 }),
    ])} />)
    expect([...screen.getByRole('list').querySelectorAll('li [data-state]')].map(node => node.getAttribute('data-state')))
      .toEqual(['warning', 'done', 'done'])
    expect(screen.getByText('bash · exit code: 71')).toBeDefined()
  })

  it('keeps the trailing column on a row without output, with no chevron and no row button', () => {
    const view = render(<JobsSection {...props([job({ status: 'completed', finishedAt: 1_700_000_000_001 })])} />)
    const line = view.container.querySelector('[data-job-row]') as HTMLElement
    expect(within(line).queryByRole('button')).toBeNull()
    expect(line.lastElementChild?.getAttribute('aria-hidden')).toBe('true')
    expect(line.lastElementChild?.childElementCount).toBe(0)
  })

  it('places the fold chevron after the settled count', () => {
    render(<JobsSection {...props([job({ status: 'completed', finishedAt: 1_700_000_000_001 })])} />)
    const toggle = screen.getByRole('button', { name: zh['section.settledCount'].replace('{count}', '1') })
    expect(toggle.lastElementChild?.tagName.toLowerCase()).toBe('svg')
    expect(toggle.firstChild?.nodeType).toBe(Node.TEXT_NODE)
  })
})

describe('JobsSection group folds', () => {
  /** Live jobs named `live-<n>`, a higher n started later. */
  const live = (count: number): JobView[] => Array.from({ length: count }, (_, index) =>
    outputJob({ id: `live-${index}` as JobView['id'], label: `live-${index}`, startedAt: 1_700_000_000_000 + index }))
  /** Settled jobs named `done-<n>`, a higher n finished later. */
  const done = (count: number): JobView[] => Array.from({ length: count }, (_, index) =>
    outputJob({ id: `done-${index}` as JobView['id'], label: `done-${index}`, status: 'completed', finishedAt: 1_700_000_100_000 + index }))
  /** The list's items in order: a job's label, the settled header as `{…}`, a fold control as `[…]`. */
  const items = (): string[] => within(screen.getByRole('list')).getAllByRole('listitem').map((item) => {
    const control = item.querySelector('[data-fold]')
    if (control !== null) return `[${control.textContent}]`
    return item.querySelector('[data-job-label]')?.textContent ?? `{${item.querySelector('button')?.textContent ?? ''}}`
  })
  const folds = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('[data-fold]')]
  const settledToggle = (count: number): HTMLElement => screen.getByRole('button', { name: zh['section.settledCount'].replace('{count}', String(count)) })

  it('shows six live rows in full and holds two back from seven, behind the group fold control before the settled header', () => {
    const six = render(<JobsSection {...props([...live(6), ...done(1)])} />)
    expect(items()).toEqual(['live-5', 'live-4', 'live-3', 'live-2', 'live-1', 'live-0', '{已结束 1}'])
    six.unmount()
    render(<JobsSection {...props([...live(7), ...done(1)])} />)
    // The most recently started rows stay; the control is the group's last row, an item of the list.
    expect(items()).toEqual(['live-6', 'live-5', 'live-4', 'live-3', 'live-2', '[显示其余 2 个运行中]', '{已结束 1}'])
    const control = folds()[0] as HTMLElement
    expect([control.getAttribute('aria-label'), control.getAttribute('aria-expanded')]).toEqual(['显示其余 2 个运行中（运行中的后台任务）', 'false'])
    fireEvent.click(control)
    expect(items()).toEqual(['live-6', 'live-5', 'live-4', 'live-3', 'live-2', 'live-1', 'live-0', '[收起]', '{已结束 1}'])
    expect([folds()[0]?.getAttribute('aria-label'), folds()[0]?.getAttribute('aria-expanded')]).toEqual(['收起（运行中的后台任务）', 'true'])
    fireEvent.click(folds()[0] as HTMLElement)
    expect(items()).toHaveLength(7)
  })

  it('folds the open settled group on its own, and offers no settled control while the group is closed', () => {
    render(<JobsSection {...props([...live(7), ...done(8)])} />)
    // Live work keeps the settled group closed: only the live group has a control.
    expect(folds().map(control => control.textContent)).toEqual(['显示其余 2 个运行中'])
    fireEvent.click(settledToggle(8))
    expect(items().slice(6)).toEqual(['{已结束 8}', 'done-7', 'done-6', 'done-5', 'done-4', 'done-3', '[显示其余 3 个已结束]'])
    const settled = folds()[1] as HTMLElement
    expect(settled.getAttribute('aria-label')).toBe('显示其余 3 个已结束（已结束的后台任务）')
    fireEvent.click(settled)
    // Each control folds only its own group.
    expect(items()).toEqual([
      'live-6', 'live-5', 'live-4', 'live-3', 'live-2', '[显示其余 2 个运行中]',
      '{已结束 8}', 'done-7', 'done-6', 'done-5', 'done-4', 'done-3', 'done-2', 'done-1', 'done-0', '[收起]',
    ])
    expect(folds()[1]?.getAttribute('aria-label')).toBe('收起（已结束的后台任务）')
    fireEvent.click(settledToggle(8))
    expect(folds()).toHaveLength(1)
  })

  it('shows six settled rows in full, and folds the group to its limit again after a clear', () => {
    const store = createJobsSectionStore().create()
    const first = render(<JobsSection {...props(done(6), undefined, {}, undefined, undefined, store)} />)
    expect(items()).toHaveLength(7)
    expect(folds()).toHaveLength(0)
    first.unmount()
    const second = render(<JobsSection {...props(done(9), undefined, {}, undefined, undefined, store)} />)
    fireEvent.click(folds()[0] as HTMLElement)
    expect(store.getSnapshot().unfolded).toEqual({ live: false, settled: true })
    fireEvent.click(screen.getByRole('button', { name: zh['section.clear'] }))
    expect(store.getSnapshot().unfolded).toEqual({ live: false, settled: false })
    second.unmount()
    // Rows that settle after the clear fold at the limit again.
    const later = Array.from({ length: 7 }, (_, index) => outputJob({
      id: `later-${index}` as JobView['id'], label: `later-${index}`, status: 'completed', finishedAt: 1_700_000_200_000 + index,
    }))
    render(<JobsSection {...props([...done(9), ...later], undefined, {}, undefined, undefined, store)} />)
    expect(items()).toEqual(['{已结束 7}', 'later-6', 'later-5', 'later-4', 'later-3', 'later-2', '[显示其余 2 个已结束]'])
  })

  it('keeps a group unfolded when the section mounts again for the same Session', () => {
    const store = createJobsSectionStore().create()
    const first = render(<JobsSection {...props(live(8), undefined, {}, undefined, undefined, store)} />)
    fireEvent.click(folds()[0] as HTMLElement)
    first.unmount()
    render(<JobsSection {...props(live(8), undefined, {}, undefined, undefined, store)} />)
    expect(items()).toHaveLength(9)
    expect(folds()[0]?.getAttribute('aria-expanded')).toBe('true')
  })

  it('stops observing an expanded row that folds out of the list, and observes it again once it shows', () => {
    const stop = vi.fn()
    const observe = vi.fn(() => stop)
    render(<JobsSection {...props(live(7), observe)} />)
    fireEvent.click(folds()[0] as HTMLElement)
    // live-0 started first, so the fold holds it back.
    fireEvent.click(screen.getByRole('button', { name: zh['row.expandAria'].replace('{label}', 'live-0') }))
    expect(observe).toHaveBeenCalledExactlyOnceWith(SESSION, 'live-0')
    fireEvent.click(folds()[0] as HTMLElement)
    expect(stop).toHaveBeenCalledTimes(1)
    expect(screen.queryByText('live-0')).toBeNull()
    fireEvent.click(folds()[0] as HTMLElement)
    expect(observe).toHaveBeenCalledTimes(2)
    expect(screen.getByRole('button', { name: zh['row.collapseAria'].replace('{label}', 'live-0') })).toBeDefined()
  })

  it('stops observing an expanded settled row while its group is closed', () => {
    const stop = vi.fn()
    const observe = vi.fn(() => stop)
    render(<JobsSection {...props(done(2), observe)} />)
    fireEvent.click(screen.getByRole('button', { name: zh['row.expandAria'].replace('{label}', 'done-1') }))
    expect(observe).toHaveBeenCalledExactlyOnceWith(SESSION, 'done-1')
    fireEvent.click(settledToggle(2))
    expect(stop).toHaveBeenCalledTimes(1)
  })

  it.each(Object.entries({ zh, en }))('names each fold control with its visible text first in %s', (_locale, copy) => {
    for (const group of ['live', 'settled'] as const) {
      for (const label of [copy[`${group}.more`].replace('{count}', '3'), copy['fold.less']]) {
        expect(copy[`${group}.foldName`].replace('{label}', label).startsWith(label)).toBe(true)
      }
    }
  })
})

describe('JobsSection observation', () => {
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
    render(<JobsSection {...props(
      [outputJob({ status: 'killed', finishedAt: 1_700_000_001_000 })],
      undefined,
      { 'bash-1': view },
    )} />)
    expect(screen.getByText(`bash · ${zh['status.killed']}`)).toBeDefined()
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

  it('starts observing on expand with the session identity, renders the live text, and stops on collapse', () => {
    const stop = vi.fn()
    const observe = vi.fn(() => stop)
    const view: ObservedJob = {
      jobId: 'bash-1' as JobView['id'],
      text: 'compiling…\n',
      gapBefore: false,
      streaming: true,
    }
    render(<JobsSection {...props([outputJob()], observe, { 'bash-1': view })} />)
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
    render(<JobsSection {...props([job()], undefined, { 'bash-1': view })} />)
    fireEvent.click(screen.getByRole('button', { name: zh['row.expandAria'].replace('{label}', 'pnpm run build') }))
    expect(screen.getByRole('list').querySelector('[data-running]')).not.toBeNull()
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
    render(<JobsSection {...props([outputJob()], undefined, { 'bash-1': view })} />)
    fireEvent.click(screen.getByRole('button', { name: zh['row.expandAria'].replace('{label}', 'pnpm run build') }))
    expect(screen.getByText(zh['output.gap'])).toBeDefined()
    expect(screen.getByText('实时输出流中断：connection lost')).toBeDefined()
  })

  it('folds an expanded panel whose row left the roster', () => {
    const stop = vi.fn()
    // One stable observe identity across renders, as the inject face provides.
    const observe = () => stop
    const { rerender } = render(<JobsSection {...props([outputJob()], observe)} />)
    fireEvent.click(screen.getByRole('button', { name: zh['row.expandAria'].replace('{label}', 'pnpm run build') }))
    rerender(<JobsSection {...props([outputJob({ id: 'bash-2' as JobView['id'], label: 'other' })], observe)} />)
    expect(stop).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('button', { name: zh['row.collapseAria'].replace('{label}', 'other') })).toBeNull()
  })
})

describe('JobsSection human kill', () => {
  const stopTitle = (label: string): string => zh['kill.stopAria'].replace('{label}', label)

  it('offers the stop control only on running rows', () => {
    render(<JobsSection {...props([
      job(),
      job({ id: 'bash-2' as JobView['id'], label: 'done', status: 'completed', finishedAt: 1_700_000_100_000 }),
    ])} />)
    expect(screen.getByRole('button', { name: stopTitle('pnpm run build') })).toBeDefined()
    expect(screen.queryByRole('button', { name: stopTitle('done') })).toBeNull()
  })

  it('arms on the first press and kills on the confirming press', async () => {
    const killJob = vi.fn(async () => true)
    render(<JobsSection {...props([job()], undefined, {}, killJob)} />)
    const stop = screen.getByRole('button', { name: stopTitle('pnpm run build') })
    fireEvent.click(stop)
    expect(killJob).not.toHaveBeenCalled()
    expect(stop.getAttribute('data-kill-state')).toBe('armed')
    expect(screen.getByRole('button', { name: zh['kill.confirm'] })).toBe(stop)
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
    render(<JobsSection {...props([job()], undefined, {}, killJob)} />)
    const stop = screen.getByRole('button', { name: stopTitle('pnpm run build') })
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
    render(<JobsSection {...props([job()], undefined, {}, killJob)} />)
    const stop = screen.getByRole('button', { name: stopTitle('pnpm run build') })
    fireEvent.click(stop)
    await act(async () => { fireEvent.click(stop) })
    expect(stop.getAttribute('data-kill-state')).toBe('failed')
    expect(screen.getByRole('button', { name: zh['kill.failed'] })).toBe(stop)
    act(() => { vi.advanceTimersByTime(4_000) })
    expect(stop.getAttribute('data-kill-state')).toBe('idle')
  })

  it('arming a second row disarms the first', () => {
    render(<JobsSection {...props([
      job(),
      job({ id: 'bash-2' as JobView['id'], label: 'pnpm run watch' }),
    ])} />)
    const first = screen.getByRole('button', { name: stopTitle('pnpm run build') })
    fireEvent.click(first)
    expect(first.getAttribute('data-kill-state')).toBe('armed')
    const second = screen.getByRole('button', { name: stopTitle('pnpm run watch') })
    fireEvent.click(second)
    expect(second.getAttribute('data-kill-state')).toBe('armed')
    expect(first.getAttribute('data-kill-state')).toBe('idle')
  })

  it('a kill resolving after another row armed leaves the newer phase alone', async () => {
    let resolveKill!: (ok: boolean) => void
    const killJob = vi.fn(() => new Promise<boolean>((resolve) => { resolveKill = resolve }))
    render(<JobsSection {...props([
      job(),
      job({ id: 'bash-2' as JobView['id'], label: 'pnpm run watch' }),
    ], undefined, {}, killJob)} />)
    const first = screen.getByRole('button', { name: stopTitle('pnpm run build') })
    fireEvent.click(first)
    fireEvent.click(first)
    expect(killJob).toHaveBeenCalledTimes(1)
    // While the first kill is in flight, the user arms the second row; the
    // late resolution must not clobber that newer phase.
    const second = screen.getByRole('button', { name: stopTitle('pnpm run watch') })
    fireEvent.click(second)
    expect(second.getAttribute('data-kill-state')).toBe('armed')
    await act(async () => { resolveKill(false) })
    expect(second.getAttribute('data-kill-state')).toBe('armed')
    expect(first.getAttribute('data-kill-state')).toBe('idle')
  })

  it('clears an armed phase whose row stopped being killable', () => {
    const { rerender } = render(<JobsSection {...props([job()])} />)
    const stop = screen.getByRole('button', { name: stopTitle('pnpm run build') })
    fireEvent.click(stop)
    expect(stop.getAttribute('data-kill-state')).toBe('armed')
    rerender(<JobsSection {...props([job({ status: 'stopping' })])} />)
    // The stopping row offers no kill control any more, and the stale phase is gone.
    expect(screen.queryByRole('button', { name: stopTitle('pnpm run build') })).toBeNull()
    expect(document.querySelector('[data-kill-state]')).toBeNull()
  })

  it('omits the stop control without job/kill access', () => {
    const view = render(<JobsSection {...props([job({ status: 'running' })], undefined, undefined, undefined, undefined, undefined, false)} />)
    expect(view.getByText('pnpm run build')).toBeTruthy()
    expect(view.container.querySelector('[data-kill-state]')).toBeNull()
  })
})

it('renders the Russian settled-count copy', () => {
  const translate: JobsSectionProps['t'] = makeTranslate(ru)
  render(<JobsSection {...props([job({ status: 'completed', finishedAt: 1_700_000_003_000 })])} t={translate} />)
  expect(screen.getByRole('button', { name: ru['section.settledCount'].replace('{count}', '1') })).toBeDefined()
})

describe('JobsSection hover', () => {
  it('shows the kind, state, and duration without the command in a hover card after 500ms, and the kind and state to assistive technology', () => {
    vi.useFakeTimers({ now: 1_700_000_010_000 })
    vi.stubGlobal('matchMedia', vi.fn((query: string) => ({ matches: query === '(any-hover: hover)' })))
    try {
      const view = render(<JobsSection {...props([outputJob()])} />)
      const row = view.container.querySelector<HTMLElement>('[data-job-row]')!
      const button = within(row).getByRole('button', { name: zh['row.expandAria'].replace('{label}', 'pnpm run build') })
      expect(document.getElementById(button.getAttribute('aria-describedby') ?? '')?.textContent).toBe('bash · 运行中')
      const anchor = row.parentElement as HTMLElement
      fireEvent.pointerEnter(anchor, { pointerType: 'mouse' })
      act(() => { vi.advanceTimersByTime(499) })
      expect(document.querySelector('[data-session-panel-details]')).toBeNull()
      act(() => { vi.advanceTimersByTime(1) })
      const card = document.querySelector('[data-session-panel-details]') as HTMLElement
      expect([...card.children].map(child => child.textContent)).toEqual(['bash', '运行中', '10秒'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the hover card closed while the pointer rests on the stop control, and closes an open one there', () => {
    vi.useFakeTimers({ now: 1_700_000_010_000 })
    vi.stubGlobal('matchMedia', vi.fn((query: string) => ({ matches: query === '(any-hover: hover)' })))
    try {
      const view = render(<JobsSection {...props([job()])} />)
      const anchor = (view.container.querySelector<HTMLElement>('[data-job-row]')!).parentElement as HTMLElement
      const stop = screen.getByRole('button', { name: zh['kill.stopAria'].replace('{label}', 'pnpm run build') })
      // Entering the row at the stop control reaches the anchor first, then the control.
      fireEvent.pointerEnter(anchor, { pointerType: 'mouse' })
      fireEvent.pointerEnter(stop, { pointerType: 'mouse' })
      act(() => { vi.advanceTimersByTime(1000) })
      expect(document.querySelector('[data-session-panel-details]')).toBeNull()
      expect(screen.getByRole('tooltip', { hidden: true }).textContent).toBe(zh['kill.stop'])
      fireEvent.pointerLeave(stop, { pointerType: 'mouse' })
      fireEvent.pointerLeave(anchor, { pointerType: 'mouse' })
      act(() => { vi.advanceTimersByTime(1000) })
      // A card the row opened closes once the pointer reaches the stop control.
      fireEvent.pointerEnter(anchor, { pointerType: 'mouse' })
      act(() => { vi.advanceTimersByTime(500) })
      expect(document.querySelector('[data-session-panel-details]')).not.toBeNull()
      fireEvent.pointerEnter(stop, { pointerType: 'mouse' })
      act(() => { vi.advanceTimersByTime(1000) })
      expect(document.querySelector('[data-session-panel-details]')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('reveals a clipped command on row hover instead of native titles, and names only the stop action in a tooltip after 500ms', () => {
    vi.useFakeTimers()
    try {
      const view = render(<JobsSection {...props([job()])} />)
      expect(view.container.querySelector('[title]')).toBeNull()
      const label = view.container.querySelector<HTMLElement>('[data-job-label]')!
      Object.defineProperty(label, 'scrollWidth', { value: 300, configurable: true })
      Object.defineProperty(label, 'clientWidth', { value: 200, configurable: true })
      const row = label.closest<HTMLElement>('[data-job-row]')!
      fireEvent.pointerEnter(row)
      expect([label.hasAttribute('data-marquee'), label.style.getPropertyValue('--dsh-marquee-range')]).toEqual([true, '100px'])
      fireEvent.pointerLeave(row)
      expect([label.hasAttribute('data-marquee'), label.style.getPropertyValue('--dsh-marquee-range')]).toEqual([false, ''])
      const stop = screen.getByRole('button', { name: zh['kill.stopAria'].replace('{label}', 'pnpm run build') })
      fireEvent.pointerEnter(stop, { pointerType: 'mouse' })
      act(() => { vi.advanceTimersByTime(499) })
      expect(screen.queryByRole('tooltip', { hidden: true })).toBeNull()
      act(() => { vi.advanceTimersByTime(1) })
      expect(screen.getByRole('tooltip', { hidden: true }).textContent).toBe(zh['kill.stop'])
    } finally {
      vi.useRealTimers()
    }
  })
})
