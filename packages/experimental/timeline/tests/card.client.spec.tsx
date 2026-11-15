// @vitest-environment jsdom
import { useState } from 'react'
import type { ButtonHTMLAttributes, ComponentProps, ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { TaskCard } from '../src/client/TaskCard.tsx'
import { en, dictionaries } from '../src/client/locales.ts'
import type { TimelineKey } from '../src/client/locales.ts'
import { taskReceiptSchema } from '../src/records.ts'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Button: (props: ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props} />,
  Tooltip: ({ children }: { children: ReactNode }) => children,
  IconCheckOutlineRegular: () => <svg />,
  IconChevronRightOutlineRegular: () => <svg />,
  IconClockOutlineRegular: () => <svg />,
  IconRightUpOutlineRegular: () => <svg />,
  DisclosureRow: ({
    title,
    open,
    expandable,
    onToggle,
    children,
    headerAccessory,
    collapsedContent,
  }: {
    title: string
    open: boolean
    expandable: boolean
    onToggle: () => void
    children: ReactNode
    headerAccessory: ReactNode
    collapsedContent: ReactNode
  }) => (
    <div>
      <button disabled={!expandable} aria-expanded={open} onClick={onToggle}>
        {title}
      </button>
      {!open && collapsedContent}
      {headerAccessory}
      {open && children}
    </div>
  ),
}))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})
const receipt = taskReceiptSchema.parse({
  version: 1,
  tree: 'plan',
  title: 'Saved work',
  branch: 'Save and recover',
  at: Date.parse('2026-10-31T00:04:00+08:00'),
  previousAt: Date.parse('2026-10-30T23:58:00+08:00'),
  before: 0.435,
  after: 0.61,
  total: 2,
  tasks: [
    {
      id: 'save',
      title: 'Save changes',
      note: 'Changes survive reopening.',
      status: 'done',
      before: 0.8,
      after: 1,
    },
    {
      id: 'recover',
      title: 'Recover changes',
      note: 'Waiting for an older backup sample.',
      status: 'blocked',
      before: 0,
      after: 0,
    },
  ],
})
const openTask = vi.fn()
function useDisclosure() {
  const [expanded, setExpanded] = useState(false)
  return { expanded, setExpanded, toggle: () => { setExpanded(value => !value) } }
}
const { zh } = dictionaries

function props(meta: unknown = { timeline: receipt }, language: 'en' | 'zh' = 'en') {
  const dict = language === 'zh' ? zh : en
  return {
    phase: 'result',
    block: { isError: false, meta, content: [{ type: 'text', text: '{"tree":"plan"}' }] },
    openTask,
    useDisclosure,
    useLocale: (selector: (value: { active: string }) => unknown) => selector({ active: 'en' }),
    useSettings: (selector: (value: unknown) => unknown) => selector({ value: { progressDecimals: 2 } }),
    t: (key: TimelineKey, params?: Record<string, unknown>) =>
      Object.entries(params ?? {}).reduce(
        (text, [name, value]) => text.replaceAll(`{${name}}`, String(value)),
        dict[key],
      ),
  } as ComponentProps<typeof TaskCard>
}
function expand(label = en.taskUpdate) {
  fireEvent.click(screen.getByRole('button', { name: label }))
}

describe('conversation task cards', () => {
  it('shows a whole-hour gap and an active task without an empty description reference', () => {
    const updated = { ...receipt, previousAt: receipt.at - 7200000,
      tasks: receipt.tasks.map(task => ({ ...task, status: 'active', note: '' })) }
    const base = props({ timeline: updated })
    const loading: typeof base.useSettings = selector => selector({
      status: 'loading', value: undefined, writable: false, revision: undefined, base: {}, user: {},
    })
    const { rerender } = render(<TaskCard {...base} useSettings={loading} />)
    expand()
    expect(screen.getByText(/2 hour.*since/)).toBeTruthy()
    expect(screen.getByRole('button', { name: /Save changes · Active/ }).hasAttribute('aria-describedby')).toBe(false)
    const inspect = vi.fn()
    if (base.phase !== 'result') throw new Error('Expected result props')
    rerender(<TaskCard {...base} inspect={inspect} block={{ ...base.block, meta: {} }} />)
    fireEvent.click(screen.getByRole('button', { name: en.details }))
    expect(inspect).toHaveBeenCalledOnce()
    rerender(<TaskCard {...base} phase="start" block={{} as never} />)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: en.taskUpdatePending }).disabled).toBe(true)
  })
  it('uses fixed recorded progress, inline notes, parent context and elapsed time across midnight', () => {
    const { container, rerender } = render(<TaskCard {...props({ timeline: receipt }, 'zh')} />)
    expect(screen.queryByRole('region')).toBeNull()
    expand(zh.taskUpdate)
    expect(screen.getByRole('region', { name: 'Saved work' })).toBeTruthy()
    expect(screen.getByLabelText(`${zh.progress}: 43.50% → 61.00%`)).toBeDefined()
    expect(screen.getByText('Save and recover')).toBeTruthy()
    expect(screen.getByText('Changes survive reopening.')).toBeTruthy()
    expect(screen.getByText('Waiting for an older backup sample.')).toBeTruthy()
    expect(screen.getByText(/距离上次更新任务树 6 分钟/)).toBeTruthy()
    expect(container.querySelectorAll('time')).toHaveLength(1)
    expect(container.querySelector('time')?.dateTime).toBe(new Date(receipt.at).toISOString())
    rerender(<TaskCard {...props({ timeline: receipt }, 'zh')} />)
    expect(container.querySelector('.timeline-card-progress')?.textContent).toBe('43.50%61.00%')
    expect(container.querySelector('.timeline-card-heading strong svg')).toBeTruthy()
  })
  it('opens the correct tree or task, and keeps a larger batch bounded', () => {
    render(<TaskCard {...props({ timeline: { ...receipt, total: 20 } })} />)
    fireEvent.click(screen.getByRole('button', { name: en.openTaskTree }))
    expect(openTask).toHaveBeenLastCalledWith(receipt.tree)
    expand()
    fireEvent.click(screen.getByRole('button', { name: /Save changes · Done/ }))
    expect(openTask).toHaveBeenLastCalledWith(receipt.tree, 'save')
    fireEvent.click(screen.getByRole('button', { name: /18 more changes/ }))
    expect(openTask).toHaveBeenLastCalledWith(receipt.tree)
  })
  it('shows one value when a change is too small to alter the displayed progress', () => {
    const small = props({ timeline: { ...receipt, before: 0.00001, after: 0.00004 } })
    const { container } = render(<TaskCard {...small} />)
    expect(container.querySelector('.timeline-tool-summary')?.textContent).toBe('Saved work0.00%')
    expand()
    expect(screen.getByLabelText(`${en.progress}: 0.00%`)).toBeDefined()
    expect(container.querySelector('.timeline-card-progress')?.textContent).toBe('0.00%')
    expect(screen.getByRole('button', { name: `Recover changes · ${en.blocked} · 0.00%` })).toBeTruthy()
    expect(screen.getByRole('button', { name: `Save changes · ${en.done} · 80.00% → 100.00%` })).toBeTruthy()
    expect([...container.querySelectorAll('.timeline-card-task-progress')].map(item => item.textContent)).toEqual([
      '80.00%100.00%',
      '0.00%',
    ])
  })
  it.each([
    undefined,
    { timeline: null },
    { timeline: { ...receipt, version: 99 } },
    { timeline: { ...receipt, after: 7 } },
  ])('preserves generic details for old, unchanged or unsupported metadata %j', (meta) => {
    const value = props()
    if (value.phase !== 'result') throw new Error('Expected result props')
    render(<TaskCard {...value} block={{ ...value.block, meta }} />)
    expand()
    expect(screen.queryByRole('region')).toBeNull()
    expect(screen.getByText('{"tree":"plan"}')).toBeTruthy()
  })
  it('does not show a success receipt on a rejected call, or while arguments are still preparing', () => {
    const value = props()
    if (value.phase !== 'result') throw new Error('Expected result props')
    const { rerender } = render(<TaskCard {...value} block={{ ...value.block, isError: true }} />)
    expand(en.taskUpdateFailed)
    expect(screen.queryByRole('region')).toBeNull()
    expect(screen.queryByRole('button', { name: en.openTaskTree })).toBeNull()
    const pending = { ...props(), phase: 'preparing', block: {} } as ComponentProps<typeof TaskCard>
    rerender(<TaskCard {...pending} />)
    expect(screen.queryByRole('region')).toBeNull()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: en.taskUpdate }).disabled).toBe(true)
  })
  it('omits a missing or backward-clock interval rather than inventing elapsed work', () => {
    const { rerender } = render(<TaskCard {...props({ timeline: { ...receipt, previousAt: null } })} />)
    expand()
    expect(screen.queryByText(/since the last task tree update/)).toBeNull()
    rerender(<TaskCard {...props({ timeline: { ...receipt, previousAt: receipt.at + 1 } })} />)
    expect(screen.queryByText(/since the last task tree update/)).toBeNull()
  })
})
