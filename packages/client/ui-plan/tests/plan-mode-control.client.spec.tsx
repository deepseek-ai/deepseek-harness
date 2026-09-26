// @vitest-environment jsdom
/**
 * PlanChip over the `plan` projection: nothing renders while the capability
 * is absent or the effective target is the default mode; while plan mode is
 * the target, the chip executes /plan off and remains visible through failures
 * until the projection confirms the exit.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { PlanProjection } from '@deepseek-ai/dsh-plan-mode/client'
import { PlanChip, type PlanChipProps } from '../src/client/PlanModeControl.tsx'
import css from '../src/client/PlanModeControl.module.css'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

// The framework-injected t seat, stubbed over the zh dictionaries (the default locale).
const t: PlanChipProps['t'] = makeTranslate(zh, commonZh)

function setup(
  plan: PlanProjection | undefined,
  exitPlanMode = vi.fn(() => Promise.resolve<string | null>(null)),
  locked = false,
) {
  const store = createSnapshotStore<{ value: PlanProjection | undefined }>({ value: plan })
  const useProjection = (_key: string, selector?: (v: unknown) => unknown) =>
    bindSnapshotSelector(store)(s => (selector ?? (v => v))(s.value))
  const props = { useProjection, locked, exitPlanMode, t } as unknown as PlanChipProps
  const view = render(<PlanChip {...props} />)
  return { store, exitPlanMode, view }
}

const chip = () => screen.getByRole('button', { name: '计划模式已开启，按下关闭' })

describe('PlanChip', () => {
  it('renders nothing for an absent capability or a default-mode target', () => {
    const absent = setup(undefined)
    expect(absent.view.container.innerHTML).toBe('')
    cleanup()
    const inactive = setup({ active: false, pending: false })
    expect(inactive.view.container.innerHTML).toBe('')
    cleanup()
    const leaving = setup({ active: true, pending: true })
    expect(leaving.view.container.innerHTML).toBe('')
  })

  it('renders the Plan status for active and pending-entry targets', () => {
    setup({ active: true, pending: false })
    expect(chip().textContent).toBe('计划')
    cleanup()
    setup({ active: false, pending: true })
    expect(chip().textContent).toBe('计划')
  })

  it('leads with the plan glyph and swaps in the circled close only while hovered', () => {
    setup({ active: true, pending: false })
    // Glyph-then-label like the sibling access-mode trigger; the two glyphs
    // share one slot and CSS shows exactly one of them, so no trailing cross.
    const glyphs = chip().querySelectorAll('svg')
    expect(glyphs).toHaveLength(2)
    const slot = glyphs[0]!.parentElement!
    expect(slot).toBe(chip().firstElementChild)
    expect(slot.getAttribute('aria-hidden')).toBe('true')
    expect(glyphs[0]!.classList.contains(css.restGlyph!)).toBe(true)
    expect(glyphs[1]!.classList.contains(css.hoverGlyph!)).toBe(true)
    expect(glyphs[1]!.parentElement).toBe(slot)
    expect(chip().lastChild?.textContent).toBe('计划')
  })

  it('executes /plan off once and follows the projection down', async () => {
    let resolve!: (value: string | null) => void
    const exitPlanMode = vi.fn(() => new Promise<string | null>((done) => { resolve = done }))
    const { store } = setup({ active: true, pending: false }, exitPlanMode)
    fireEvent.click(chip())
    expect(exitPlanMode).toHaveBeenCalledTimes(1)
    fireEvent.click(chip())
    expect(exitPlanMode).toHaveBeenCalledTimes(1)
    resolve(null)
    store.set({ value: { active: true, pending: true } })
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: '计划模式已开启，按下关闭' })).toBeNull()
    })
  })

  it('disables under the locked owner prop', () => {
    setup({ active: true, pending: false }, vi.fn(), true)
    expect((chip() as HTMLButtonElement).disabled).toBe(true)
  })

  it('surfaces admission and transport failures while staying visible', async () => {
    const exitPlanMode = vi.fn()
      .mockResolvedValueOnce('host said no')
      .mockRejectedValueOnce(new Error('network down'))
      .mockRejectedValueOnce('socket closed')
    setup({ active: true, pending: false }, exitPlanMode)
    fireEvent.click(chip())
    expect((await screen.findByText('退出计划模式失败')).getAttribute('title')).toBe('host said no')
    expect(chip()).toBeTruthy()

    fireEvent.click(chip())
    expect(await screen.findByTitle('network down')).toBeTruthy()

    fireEvent.click(chip())
    expect(await screen.findByTitle('socket closed')).toBeTruthy()
  })

  it('ignores in-flight fulfillment and rejection after unmount', () => {
    let resolve!: (value: string | null) => void
    const successful = setup(
      { active: true, pending: false },
      vi.fn(() => new Promise<string | null>((done) => { resolve = done })),
    )
    fireEvent.click(chip())
    successful.view.unmount()
    expect(() => { resolve(null) }).not.toThrow()

    let reject!: (reason: unknown) => void
    const exitPlanMode = vi.fn(() => new Promise<string | null>((_done, fail) => { reject = fail }))
    const { view } = setup({ active: true, pending: false }, exitPlanMode)
    fireEvent.click(chip())
    view.unmount()
    expect(() => { reject(new Error('late')) }).not.toThrow()
  })
})
