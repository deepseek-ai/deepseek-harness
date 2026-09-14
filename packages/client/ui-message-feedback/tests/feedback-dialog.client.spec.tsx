// @vitest-environment jsdom
/**
 * FeedbackDialog rendering: the modal shows the seven category chips, the
 * detail box, and the hint while a target is open; a chip toggles the
 * category through the injected verb; Submit routes to the controller and
 * stays enabled with an empty draft; a failure code renders a warning toast;
 * and the acknowledgement toast mounts from the toast sequence and retires
 * through dismissToast once its fade completes.
 */
import { useSyncExternalStore } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { FEEDBACK_CATEGORIES } from '@deepseek-ai/dsh-command-feedback'
import { FeedbackDialog } from '../src/client/FeedbackDialog.tsx'
import type { FeedbackDialogState } from '../src/client/dialog.ts'
import { en, zh } from '../src/client/locales.ts'

afterEach(cleanup)

const t = makeTranslate(zh, commonZh)

/** Render the entry over a fixed state and recording verbs. */
function mount(overrides: Partial<FeedbackDialogState> = {}) {
  const state: FeedbackDialogState = {
    target: { kind: 'session' }, category: null, text: '', submitting: false, failure: null, toast: 0,
    ...overrides,
  }
  const verbs = {
    edit: vi.fn(),
    submit: vi.fn(() => Promise.resolve()),
    dismiss: vi.fn(),
    dismissFailure: vi.fn(),
    dismissToast: vi.fn(),
  }
  const useDialog = (<T,>(select: (v: FeedbackDialogState) => T): T =>
    useSyncExternalStore(() => () => {}, () => select(state))) as never
  const props = { useDialog, ...verbs, t } as unknown as Parameters<typeof FeedbackDialog>[0]
  return { ...render(<FeedbackDialog {...props} />), ...verbs }
}

describe('FeedbackDialog', () => {
  it('owns the conversation-log disclosure and stability category in both supported locales', () => {
    expect(zh['dialog.hint']).toBe('填写详情以帮助我们改进体验，提交内容会包括当前对话的日志')
    expect(en['dialog.hint']).toBe('Add details to help us improve. Your submission will include the current conversation log.')
    expect(zh['category.service-stability']).toBe('稳定性和速度')
    expect(en['category.service-stability']).toBe('Stability and speed')
  })

  it('renders nothing but the probe while closed with no toast', () => {
    const ui = mount({ target: null })

    expect(ui.queryByRole('dialog')).toBeNull()
    expect(ui.queryByRole('alert')).toBeNull()
  })

  it('shows every category, the detail box with the hint, and an enabled Submit for an empty draft', () => {
    const ui = mount()

    const dialog = ui.getByRole('dialog', { name: zh['dialog.title'] })
    expect(dialog).toBeTruthy()
    const chips = ui.getByRole('group', { name: zh['dialog.categories'] }).querySelectorAll('button')
    expect([...chips].map(chip => chip.textContent)).toEqual(
      FEEDBACK_CATEGORIES.map(category => zh[`category.${category}`]),
    )
    expect(ui.getByLabelText(zh['dialog.detail']).getAttribute('placeholder')).toBe(zh['dialog.hint'])
    expect(ui.getByRole('button', { name: commonZh.submit }).hasAttribute('disabled')).toBe(false)
  })

  it('selects a chip, and clears it when the selected chip is clicked again', () => {
    const ui = mount({ category: 'task-result' })

    const chips = ui.getByRole('group', { name: zh['dialog.categories'] }).querySelectorAll('button')
    expect(chips[0]?.getAttribute('aria-pressed')).toBe('true')
    expect(chips[1]?.getAttribute('aria-pressed')).toBe('false')

    fireEvent.click(chips[1]!)
    expect(ui.edit).toHaveBeenLastCalledWith({ category: 'instruction-following' })
    fireEvent.click(chips[0]!)
    expect(ui.edit).toHaveBeenLastCalledWith({ category: null })
  })

  it('forwards typing, submits, and closes through the injected verbs', () => {
    const ui = mount({ text: 'draft' })

    fireEvent.change(ui.getByLabelText(zh['dialog.detail']), { target: { value: 'draft more' } })
    expect(ui.edit).toHaveBeenCalledWith({ text: 'draft more' })

    fireEvent.click(ui.getByRole('button', { name: commonZh.submit }))
    expect(ui.submit).toHaveBeenCalledTimes(1)

    fireEvent.click(ui.getByRole('button', { name: commonZh.close }))
    expect(ui.dismiss).toHaveBeenCalledTimes(1)
  })

  it('disables Submit and the chips while a submission is in flight', () => {
    const ui = mount({ submitting: true })

    expect(ui.getByRole('button', { name: commonZh.submitting }).hasAttribute('disabled')).toBe(true)
    const chips = ui.getByRole('group', { name: zh['dialog.categories'] }).querySelectorAll('button')
    expect([...chips].every(chip => chip.hasAttribute('disabled'))).toBe(true)
  })

  it('renders submission failures as toasts outside the dialog', () => {
    const conflict = mount({ failure: 'version-conflict' })
    const conflictToast = conflict.getByRole('alert')
    expect(conflictToast.textContent).toBe(zh['error.conflict'])
    expect(conflict.getByRole('dialog').contains(conflictToast)).toBe(false)
    cleanup()

    const oversized = mount({ failure: 'note-too-large' })
    expect(oversized.getByRole('alert').textContent).toBe(zh['error.noteTooLarge'])
    cleanup()

    const other = mount({ failure: 'session-not-found' })
    expect(other.getByRole('alert').textContent).toBe(zh['error.generic'])
  })

  it('retires a submission-failure toast after its extended hold', () => {
    vi.useFakeTimers()
    try {
      const ui = mount({ failure: 'version-conflict' })

      act(() => { vi.advanceTimersByTime(7000) })

      expect(ui.dismissFailure).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('retires the toast when the entry unmounts, so a Session switch does not replay it', () => {
    const ui = mount({ target: null, toast: 3 })

    ui.unmount()

    expect(ui.dismissToast).toHaveBeenCalledWith(3)
  })

  it('shows the acknowledgement toast and retires it after the fade', () => {
    vi.useFakeTimers()
    try {
      const ui = mount({ target: null, toast: 3 })

      expect(ui.getByRole('alert').textContent).toBe(zh['toast.recorded'])
      act(() => { vi.advanceTimersByTime(4000) })
      expect(ui.dismissToast).toHaveBeenCalledWith(3)
    } finally {
      vi.useRealTimers()
    }
  })
})
