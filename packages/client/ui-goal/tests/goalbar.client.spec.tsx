// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GoalSnapshot } from '@deepseek-ai/dsh-goal/client'
import { makeTranslate, RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { GoalBar } from '../src/client/GoalBar.tsx'
import type { GoalActionResult, GoalBarActions } from '../src/client/slots.ts'
import { zh } from '../src/client/locales.ts'

const t: Parameters<typeof GoalBar>[0]['t'] = makeTranslate(zh, commonZh)

afterEach(cleanup)

function makeGoal(over: Partial<GoalSnapshot> = {}): GoalSnapshot {
  return {
    id: 'g1' as GoalSnapshot['id'],
    revision: 1,
    objective: 'Ship the redesign',
    phase: 'active',
    maxGoalRounds: 4,
    ...over,
  }
}

function makeActions() {
  return {
    onEdit: vi.fn<GoalBarActions['onEdit']>(() => Promise.resolve({ ok: true, value: undefined })),
    onPause: vi.fn<GoalBarActions['onPause']>(() => Promise.resolve({ ok: true, value: undefined })),
    onResume: vi.fn<GoalBarActions['onResume']>(() => Promise.resolve({ ok: true, value: undefined })),
    onClear: vi.fn<GoalBarActions['onClear']>(() => Promise.resolve({ ok: true, value: undefined })),
  } satisfies GoalBarActions
}

describe('GoalBar', () => {
  it('renders nothing while loading, absent, or when the goal is complete', () => {
    const actions = makeActions()
    const loading = render(<GoalBar goal={undefined} {...actions} t={t} />)
    expect(loading.container.firstChild).toBeNull()
    cleanup()

    const absent = render(<GoalBar goal={null} {...actions} t={t} />)
    expect(absent.container.firstChild).toBeNull()
    cleanup()

    const complete = render(<GoalBar goal={makeGoal({ phase: 'complete' })} {...actions} t={t} />)
    expect(complete.container.firstChild).toBeNull()
  })

  it('active goal: goal glyph, "进行中的目标", truncated objective, edit and clear actions', () => {
    const actions = makeActions()
    render(<GoalBar goal={makeGoal()} {...actions} t={t} />)
    expect(screen.getByText('进行中的目标')).toBeTruthy()
    expect(screen.getByText('Ship the redesign')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '清除目标' }))
    expect(actions.onClear).toHaveBeenCalledTimes(1)
  })

  it('single-flights rapid clear clicks and hides the committed goal before its projection catches up', async () => {
    const actions = makeActions()
    let resolveClear!: (result: GoalActionResult) => void
    actions.onClear.mockImplementation(() => new Promise((resolve) => { resolveClear = resolve }))
    const { container, rerender } = render(<GoalBar goal={makeGoal()} {...actions} t={t} />)
    const clear = screen.getByRole<HTMLButtonElement>('button', { name: '清除目标' })

    act(() => {
      clear.click()
      clear.click()
    })
    expect(actions.onClear).toHaveBeenCalledTimes(1)
    expect(clear.disabled).toBe(true)

    await act(async () => { resolveClear({ ok: true, value: undefined }) })
    expect(container.firstChild).toBeNull()

    rerender(<GoalBar goal={makeGoal({ id: 'g2' as GoalSnapshot['id'], objective: 'Next goal' })} {...actions} t={t} />)
    expect(screen.getByText('Next goal')).toBeTruthy()
  })

  it('edit swaps the strip for a prefilled form; Enter saves, empty stays disabled', async () => {
    const actions = makeActions()
    render(<GoalBar goal={makeGoal()} {...actions} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: '编辑目标' }))
    const box = screen.getByRole('textbox', { name: '目标内容' })
    expect(box).toHaveProperty('value', 'Ship the redesign')

    fireEvent.change(box, { target: { value: '   ' } })
    expect(screen.getByRole('button', { name: '保存目标' })).toHaveProperty('disabled', true)

    fireEvent.change(box, { target: { value: 'Ship v2' } })
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(actions.onEdit).toHaveBeenCalledWith('Ship v2')
    await waitFor(() => { expect(screen.getByText('进行中的目标')).toBeTruthy() })
  })

  it('Esc cancels the edit without calling onEdit', () => {
    const actions = makeActions()
    render(<GoalBar goal={makeGoal()} {...actions} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: '编辑目标' }))
    fireEvent.keyDown(screen.getByRole('textbox', { name: '目标内容' }), { key: 'Escape' })
    expect(actions.onEdit).not.toHaveBeenCalled()
    expect(screen.getByText('进行中的目标')).toBeTruthy()
  })

  it('the cancel button exits the form and drops the draft (re-edit starts from the objective)', () => {
    const actions = makeActions()
    render(<GoalBar goal={makeGoal()} {...actions} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: '编辑目标' }))
    fireEvent.change(screen.getByRole('textbox', { name: '目标内容' }), { target: { value: 'abandoned draft' } })
    fireEvent.click(screen.getByRole('button', { name: '取消编辑' }))
    expect(actions.onEdit).not.toHaveBeenCalled()
    expect(screen.getByText('进行中的目标')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '编辑目标' }))
    expect(screen.getByRole('textbox', { name: '目标内容' })).toHaveProperty('value', 'Ship the redesign')
  })

  it('Enter with a blank draft neither saves nor closes the form', () => {
    const actions = makeActions()
    render(<GoalBar goal={makeGoal()} {...actions} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: '编辑目标' }))
    const box = screen.getByRole('textbox', { name: '目标内容' })
    fireEvent.change(box, { target: { value: '   ' } })
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(actions.onEdit).not.toHaveBeenCalled()
    expect(screen.getByRole('textbox', { name: '目标内容' })).toBeTruthy()
  })

  it('active goal: the pause action pauses', () => {
    const actions = makeActions()
    render(<GoalBar goal={makeGoal()} activation="armed" {...actions} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: '暂停目标' }))
    expect(actions.onPause).toHaveBeenCalledTimes(1)
  })

  it('active disarmed goal: "未运行的目标" with a resume action instead of pause', () => {
    const actions = makeActions()
    render(<GoalBar goal={makeGoal()} activation="disarmed" {...actions} t={t} />)
    expect(screen.getByText('未运行的目标')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '恢复目标' }))
    expect(actions.onResume).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('button', { name: '暂停目标' })).toBeNull()
  })

  it('paused goal: "已暂停的目标" with a resume action before edit', () => {
    const actions = makeActions()
    render(<GoalBar goal={makeGoal({ phase: 'paused' })} {...actions} t={t} />)
    expect(screen.getByText('已暂停的目标')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '恢复目标' }))
    expect(actions.onResume).toHaveBeenCalledTimes(1)
  })

  it('a new goal identity drops the edit form (no stale draft over the new goal)', () => {
    const actions = makeActions()
    const { rerender } = render(<GoalBar goal={makeGoal()} {...actions} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: '编辑目标' }))
    fireEvent.change(screen.getByRole('textbox', { name: '目标内容' }), { target: { value: 'stale draft' } })

    rerender(<GoalBar goal={makeGoal({ id: 'g2' as GoalSnapshot['id'], objective: 'New goal' })} {...actions} t={t} />)
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.getByText('进行中的目标')).toBeTruthy()
    expect(screen.getByText('New goal')).toBeTruthy()

    rerender(<GoalBar goal={null} {...actions} t={t} />)
    expect(screen.queryByText('进行中的目标')).toBeNull()
  })

  it('blocked goal: "受阻的目标" with the block reason as the strip tooltip', () => {
    const actions = makeActions()
    const goal = makeGoal({ phase: 'blocked', blockedReason: { code: 'stalled', message: 'No progress in 3 rounds' } })
    render(<GoalBar goal={goal} {...actions} t={t} />)
    expect(screen.getByText('受阻的目标')).toBeTruthy()
    expect(screen.getByText('受阻的目标').closest('[title]')?.getAttribute('title')).toBe('No progress in 3 rounds')
  })

  it('blocked goal without a reason carries no tooltip', () => {
    const actions = makeActions()
    render(<GoalBar goal={makeGoal({ phase: 'blocked' })} {...actions} t={t} />)
    expect(screen.getByText('受阻的目标')).toBeTruthy()
    expect(screen.getByText('受阻的目标').closest('[title]')).toBeNull()
  })

  it('keeps the edit draft open and reports a failed save', async () => {
    const actions = makeActions()
    actions.onEdit.mockResolvedValue({
      ok: false, error: new RemoteError('session/agent-busy', 'stale revision', { reason: 'stale revision' }),
    })
    render(<GoalBar goal={makeGoal()} {...actions} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: '编辑目标' }))
    const box = screen.getByRole('textbox', { name: '目标内容' })
    fireEvent.change(box, { target: { value: 'retry this draft' } })
    fireEvent.click(screen.getByRole('button', { name: '保存目标' }))

    expect((await screen.findByRole('alert')).textContent).toBe('stale revision (session/agent-busy)')
    expect(screen.getByRole('textbox', { name: '目标内容' })).toHaveProperty('value', 'retry this draft')
  })

  it('reports resume and clear failures without hiding the goal', async () => {
    const actions = makeActions()
    actions.onResume.mockResolvedValue({ ok: false, error: new RemoteError('gateway/internal', 'resume failed', {}) })
    const { rerender } = render(<GoalBar goal={makeGoal({ phase: 'paused' })} {...actions} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: '恢复目标' }))
    expect((await screen.findByRole('alert')).textContent).toBe('resume failed (gateway/internal)')

    actions.onClear.mockResolvedValue({
      ok: false, error: new RemoteError('session/agent-busy', 'clear failed', { reason: 'clear failed' }),
    })
    rerender(<GoalBar goal={makeGoal()} {...actions} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: '清除目标' }))
    expect((await screen.findByRole('alert')).textContent).toBe('clear failed (session/agent-busy)')
    expect(screen.getByText('Ship the redesign')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '清除目标' }))
    await waitFor(() => { expect(actions.onClear).toHaveBeenCalledTimes(2) })
  })
})
