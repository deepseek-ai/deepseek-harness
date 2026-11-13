// @vitest-environment jsdom
import { cloneElement } from 'react'
import type { ReactElement } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { formatProgress, Progress } from '../src/client/Progress.tsx'
import { en, dictionaries } from '../src/client/locales.ts'
import { patchSchema } from '../src/records.ts'
import { measureAll, patchTasks } from '../src/tasks.ts'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Tooltip: ({
    children,
    label,
    disabled,
  }: {
    children: ReactElement<{ 'data-tooltip'?: string | undefined }>
    label: string
    disabled?: boolean
  }) => cloneElement(children, { 'data-tooltip': disabled ? undefined : label }),
}))
const labels: Readonly<Record<string, string>> = en
const t: TranslateNS<'timeline'> = (key, params) =>
  (labels[key] ?? key).replace(/\{(\w+)\}/gu, (match: string, name: string) =>
    typeof params?.[name] === 'number' || typeof params?.[name] === 'string' ? `${params[name]}` : match,
  )

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

function activeTasks(count: number) {
  return patchTasks(
    [],
    patchSchema.array().parse(
      Array.from({ length: count }, (_, index) => ({
        id: `work-${index}`,
        title: `Work ${index + 1}`,
        status: 'active',
      })),
    ),
    1,
    20,
  )
}

function segment(bar: HTMLElement, state: string): Element {
  const element = bar.querySelector(`[data-part=${state}]`)
  if (element === null) throw new Error(`Missing ${state} segment`)
  return element
}

describe('progress display precision', () => {
  it('ignores segment shortcuts for a single bar and starts at the first segment from an unfocused bar', () => {
    const { rerender } = render(<Progress value={0} status="pending" label="Progress" t={t} />)
    fireEvent.focus(screen.getByRole('progressbar'))
    expect(fireEvent.keyDown(screen.getByRole('progressbar'), { key: 'ArrowRight' })).toBe(true)
    const parts = measureAll(activeTasks(1), true).get(null)?.parts
    rerender(<Progress value={0} status="active" label="Progress" parts={parts} t={t} />)
    const bar = screen.getByRole('progressbar')
    fireEvent.keyDown(bar, { key: 'ArrowRight' })
    expect(bar.getAttribute('data-tooltip')).toBe('Active work: 1 (100.00%)')
  })
  it('formats zero to three decimal places and reserves 100 for completion', () => {
    expect(formatProgress(1 / 3)).toBe('33.33')
    expect([0, 1, 2, 3].map(decimals => formatProgress(1 / 3, decimals as 0 | 1 | 2 | 3))).toEqual([
      '33',
      '33.3',
      '33.33',
      '33.333',
    ])
    expect(formatProgress(0.99999, 0)).toBe('99')
    expect(formatProgress(0.99999, 3)).toBe('99.999')
    expect(formatProgress(1)).toBe('100.00')
  })
  it('exposes the configured precision through the accessible progress value', () => {
    render(<Progress value={1 / 3} decimals={3} status="active" label="Review progress" t={t} />)
    expect(screen.getByRole('progressbar').getAttribute('aria-valuetext')).toBe('33.333%')
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('33.333')
  })
  it('keeps all four segments mounted through updates and exposes hover and keyboard details', () => {
    const tasks = patchTasks(
      [],
      patchSchema.array().parse([
        { id: 'done', title: 'Done', status: 'done', timeShare: 1 },
        { id: 'active', title: 'Active', done: [1, 2], timeShare: 2 },
        { id: 'pending', title: 'Pending', timeShare: 1 },
        { id: 'blocked', title: 'Blocked', status: 'blocked', timeShare: 1, note: 'Waiting for access.' },
      ]),
      1,
      10,
    )
    const parts = measureAll(tasks, true).get(null)?.parts
    const { rerender } = render(<Progress value={0.4} status="active" label="Review" parts={parts} t={t} />)
    const bar = screen.getByRole('progressbar')
    const segments = [...bar.querySelectorAll('[data-part]')]
    expect(bar.tabIndex).toBe(0)
    expect(bar.querySelector('[data-tip=true]')?.getAttribute('data-part')).toBe('active')
    expect((bar.querySelector('.timeline-progress-highlight') as HTMLElement).style.width).toBe('60%')
    expect(segments.map(node => node.getAttribute('data-part'))).toEqual([
      'done',
      'active',
      'pending',
      'blocked',
    ])
    expect(segments.map(node => (node as HTMLElement).style.width)).toEqual(['40%', '20%', '20%', '20%'])
    expect(bar.getAttribute('aria-valuetext')).toContain('Completed work: 1 (40.00%)')
    const blocked = segments[3]
    if (blocked === undefined) throw new Error('Missing blocked segment')
    fireEvent.mouseEnter(blocked)
    expect(bar.getAttribute('data-tooltip')).toBe('Blocked work: 1 (20.00%)')
    fireEvent.focus(bar)
    expect(bar.getAttribute('data-tooltip')).toBe('Completed work: 1 (40.00%)')
    const finished = measureAll(
      patchTasks(
        tasks,
        patchSchema.array().parse(tasks.map(task => ({ id: task.id, status: 'done', note: 'Verified.' }))),
        2,
        10,
      ),
      true,
    ).get(null)?.parts
    rerender(<Progress value={1} status="done" label="Review" parts={finished} t={t} />)
    for (const [index, node] of [...bar.querySelectorAll('[data-part]')].entries())
      expect(node).toBe(segments[index])
    expect((segments[0] as HTMLElement).style.width).toBe('100%')
    expect((segments[3] as HTMLElement).style.width).toBe('0%')
    expect(bar.querySelector('[data-tip=true]')?.getAttribute('data-part')).toBe('done')
    expect(bar.querySelector('[data-flow]')).toBeNull()
    rerender(<Progress value={1} status="done" label="Review" t={t} />)
    expect(screen.getByRole('progressbar').hasAttribute('data-segmented')).toBe(false)
    expect(screen.getByRole('progressbar').tabIndex).toBe(-1)
    expect(screen.getByRole('progressbar').children).toHaveLength(1)
  })
  it('keeps an incomplete completed-work tooltip below 100 at low precision', () => {
    const tasks = patchTasks(
      [],
      patchSchema.array().parse([{ id: 'check', title: 'Check', status: 'active', done: [1, 1] }]),
      1,
      10,
    )
    const measure = measureAll(tasks, true).get(null)
    render(
      <Progress
        value={measure?.progress ?? 0}
        status="active"
        label="Review"
        decimals={0}
        parts={measure?.parts}
        t={t}
      />,
    )
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('99')
    expect(screen.getByRole('progressbar').getAttribute('aria-valuetext')).toContain(
      'Completed work: 0 (99%)',
    )
  })

  it('uses the short Chinese count and percentage for each work state', () => {
    const parts = measureAll(activeTasks(2), true).get(null)?.parts
    const chinese: Readonly<Record<string, string>> = dictionaries.zh
    const translate: TranslateNS<'timeline'> = (key, params) =>
      (chinese[key] ?? key).replace(/\{(\w+)\}/gu, (match: string, name: string) =>
        typeof params?.[name] === 'number' || typeof params?.[name] === 'string' ? `${params[name]}` : match,
      )
    render(<Progress value={0} status="active" label="Progress" parts={parts} t={translate} />)
    const bar = screen.getByRole('progressbar')
    expect(bar.getAttribute('aria-valuetext')).toBe(
      '0 项已完成的工作 (0.00%)\n2 项进行中的工作 (100.00%)\n0 项待开始的工作 (0.00%)\n0 项阻塞的工作 (0.00%)',
    )
    fireEvent.mouseEnter(segment(bar, 'active'))
    expect(bar.getAttribute('data-tooltip')).toBe('2 项进行中的工作 (100.00%)')
  })

  it.each([5, 6, 7])('shows a bounded list after 0.5 seconds for %s tasks', (count) => {
    vi.useFakeTimers()
    const parts = measureAll(activeTasks(count), true).get(null)?.parts
    render(<Progress value={0} status="active" label="Progress" parts={parts} t={t} />)
    const bar = screen.getByRole('progressbar')
    fireEvent.mouseEnter(segment(bar, 'active'))
    act(() => {
      vi.advanceTimersByTime(499)
    })
    expect(bar.getAttribute('data-tooltip')).toBe(`Active work: ${count} (100.00%)`)
    act(() => {
      vi.advanceTimersByTime(1)
    })
    const lines = bar.getAttribute('data-tooltip')?.split('\n')
    const visible = count > 6 ? 5 : count
    expect(lines).toEqual([
      `Active work: ${count} (100.00%)`,
      ...Array.from({ length: visible }, (_, index) => `- Work ${index + 1}`),
      ...(count > 6 ? ['- ...'] : []),
    ])
  })

  it('restarts the delay between segments and cancels it on leave, disabling, and unmount', () => {
    vi.useFakeTimers()
    const tasks = patchTasks(
      activeTasks(1),
      patchSchema.array().parse([{ id: 'blocked', title: 'Waiting', status: 'blocked', note: 'No access.' }]),
      2,
      20,
    )
    const parts = measureAll(tasks, true).get(null)?.parts
    const { rerender, unmount } = render(
      <Progress value={0} status="active" label="Progress" parts={parts} t={t} />,
    )
    const bar = screen.getByRole('progressbar')
    fireEvent.mouseEnter(segment(bar, 'active'))
    act(() => {
      vi.advanceTimersByTime(200)
    })
    fireEvent.mouseEnter(segment(bar, 'blocked'))
    act(() => {
      vi.advanceTimersByTime(499)
    })
    expect(bar.getAttribute('data-tooltip')).toBe('Blocked work: 1 (50.00%)')
    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(bar.getAttribute('data-tooltip')).toBe('Blocked work: 1 (50.00%)\n- Waiting')
    fireEvent.mouseLeave(bar)
    fireEvent.mouseEnter(segment(bar, 'active'))
    expect(vi.getTimerCount()).toBe(1)
    rerender(<Progress value={0} status="active" label="Progress" t={t} />)
    expect(vi.getTimerCount()).toBe(0)
    rerender(<Progress value={0} status="active" label="Progress" parts={parts} t={t} />)
    fireEvent.mouseEnter(segment(screen.getByRole('progressbar'), 'active'))
    unmount()
    expect(vi.getTimerCount()).toBe(0)
  })
  it('keeps the new segment collapsed when its selection and the old timer settle together', () => {
    vi.useFakeTimers()
    const parts = measureAll(activeTasks(1), true).get(null)?.parts
    render(<Progress value={0} status="active" label="Progress" parts={parts} t={t} />)
    const bar = screen.getByRole('progressbar')
    fireEvent.mouseEnter(segment(bar, 'active'))
    act(() => {
      segment(bar, 'pending').dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
      vi.advanceTimersByTime(500)
    })
    expect(bar.getAttribute('data-tooltip')).toBe('Work to start: 0 (0.00%)')
  })

  it('keeps each title on one bullet and uses current data without extending the hover delay', () => {
    vi.useFakeTimers()
    const tasks = activeTasks(1)
    const parts = measureAll(tasks, true).get(null)?.parts
    const { rerender } = render(<Progress value={0} status="active" label="Progress" parts={parts} t={t} />)
    const bar = screen.getByRole('progressbar')
    fireEvent.mouseEnter(segment(bar, 'active'))
    act(() => {
      vi.advanceTimersByTime(200)
    })
    const changed = patchTasks(
      tasks,
      patchSchema.array().parse([{ id: 'work-0', title: 'Check\n  saved\tprogress' }]),
      2,
      20,
    )
    rerender(
      <Progress
        value={0}
        status="active"
        label="Progress"
        parts={measureAll(changed, true).get(null)?.parts}
        t={t}
      />,
    )
    act(() => {
      vi.advanceTimersByTime(300)
    })
    expect(bar.getAttribute('data-tooltip')).toBe('Active work: 1 (100.00%)\n- Check saved progress')
  })

  it('allows keyboard users to inspect segments and dismiss the delayed list', () => {
    vi.useFakeTimers()
    const tasks = patchTasks(
      activeTasks(1),
      patchSchema.array().parse([{ id: 'done', title: 'Verified', status: 'done' }]),
      2,
      20,
    )
    const parts = measureAll(tasks, true).get(null)?.parts
    render(<Progress value={0.5} status="active" label="Progress" parts={parts} t={t} />)
    const bar = screen.getByRole('progressbar')
    fireEvent.focus(bar)
    expect(bar.getAttribute('data-tooltip')).toBe('Completed work: 1 (50.00%)')
    fireEvent.keyDown(bar, { key: 'ArrowRight' })
    act(() => {
      vi.advanceTimersByTime(500)
    })
    expect(bar.getAttribute('data-tooltip')).toBe('Active work: 1 (50.00%)\n- Work 1')
    fireEvent.keyDown(bar, { key: 'Escape' })
    expect(bar.hasAttribute('data-tooltip')).toBe(false)
    fireEvent.keyDown(bar, { key: 'ArrowLeft' })
    expect(vi.getTimerCount()).toBe(0)
    fireEvent.blur(bar)
    fireEvent.focus(bar)
    expect(vi.getTimerCount()).toBe(1)
    fireEvent.blur(bar)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps Escape dismissal through the pending deadline and restores a fresh hover', () => {
    vi.useFakeTimers()
    const parts = measureAll(activeTasks(1), true).get(null)?.parts
    const { rerender } = render(<Progress value={0} status="active" label="Progress" parts={parts} t={t} />)
    const bar = screen.getByRole('progressbar')
    fireEvent.mouseEnter(segment(bar, 'active'))
    fireEvent.keyDown(bar, { key: 'Escape' })
    act(() => {
      vi.advanceTimersByTime(500)
    })
    expect(bar.hasAttribute('data-tooltip')).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
    fireEvent.mouseLeave(bar)
    fireEvent.mouseEnter(segment(bar, 'active'))
    expect(bar.getAttribute('data-tooltip')).toBe('Active work: 1 (100.00%)')
    act(() => {
      vi.advanceTimersByTime(500)
    })
    expect(bar.getAttribute('data-tooltip')).toBe('Active work: 1 (100.00%)\n- Work 1')
    fireEvent.keyDown(bar, { key: 'Escape' })
    rerender(<Progress value={0} status="active" label="Progress" t={t} />)
    rerender(<Progress value={0} status="active" label="Progress" parts={parts} t={t} />)
    const restored = screen.getByRole('progressbar')
    fireEvent.mouseEnter(segment(restored, 'active'))
    expect(restored.getAttribute('data-tooltip')).toBe('Active work: 1 (100.00%)')
  })
})
