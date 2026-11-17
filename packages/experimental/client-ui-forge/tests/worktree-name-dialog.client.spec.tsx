// @vitest-environment jsdom
/** Naming dialog of a worktree branch: the starting text, the rules checked while typing, the Host's refusals, and the retry mode. */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { en } from '../src/client/locales.ts'
import { WorktreeNameDialog, type WorktreeNameDialogProps } from '../src/client/WorktreeNameDialog.tsx'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const t = makeTranslate(en)

function mount(props: Partial<WorktreeNameDialogProps> = {}) {
  const submit = vi.fn<WorktreeNameDialogProps['submit']>(async () => 'accepted')
  const close = vi.fn()
  render(<WorktreeNameDialog mode="name" initial="dsh-" prefix="dsh-" from="refs/heads/main" named={false} submit={submit} close={close}
    t={t} {...props} />)
  const dialog = (): HTMLElement => screen.getByRole('dialog')
  const field = (): HTMLInputElement => within(dialog()).getByRole('textbox', { name: en['nameDialog.field'] })
  const confirm = (): HTMLElement => within(dialog()).getByRole('button', { name: props.mode === 'retry' ? en['nameDialog.retry'] : en['nameDialog.confirm'] })
  const type = (value: string): void => { fireEvent.change(field(), { target: { value } }) }
  const message = (): string | null => field().getAttribute('aria-describedby') === null
    ? null : document.getElementById(field().getAttribute('aria-describedby') ?? '')?.textContent ?? null
  return { submit, close, dialog, field, confirm, type, message }
}

describe('WorktreeNameDialog rules', () => {
  it.each([
    ['', en['branchName.empty']],
    ['fix login', en['branchName.space']],
    ['fix~1', en['branchName.character']],
    ['-fix', en['branchName.leading-dash']],
    ['/fix', en['branchName.leading-slash']],
    ['worktree/', en['branchName.trailing-slash']],
    ['fix//login', en['branchName.double-slash']],
    ['fix..login', en['branchName.double-dot']],
    ['fix.', en['branchName.trailing-dot']],
    ['@', en['branchName.at']],
    ['fix@{1}', en['branchName.at-brace']],
    ['fix/.login', en['branchName.dot-segment']],
    ['fix.lock/login', en['branchName.lock-segment']],
  ])('refuses %j while it is typed', (value, reason) => {
    const d = mount()
    d.type(value)
    expect(d.message()).toBe(reason)
    expect(within(d.dialog()).getByRole('alert').textContent).toBe(reason)
    expect(d.field().getAttribute('aria-invalid')).toBe('true')
    expect(d.confirm().hasAttribute('disabled')).toBe(true)
    fireEvent.keyDown(d.field(), { key: 'Enter' })
    expect(d.submit).not.toHaveBeenCalled()
  })

  it('hints at the prefix it starts with, and at the base once a name follows it', () => {
    const d = mount({ prefix: 'agent/', initial: 'agent/' })
    expect(d.message()).toBe(en['nameDialog.prefixOnly'])
    expect(d.field().getAttribute('aria-invalid')).toBe('false')
    expect(d.confirm().hasAttribute('disabled')).toBe(true)
    d.type('agent/fix')
    expect(d.message()).toBe('The first message creates this branch from main; the worktree directory takes its name')
    expect(d.confirm().hasAttribute('disabled')).toBe(false)
  })

  it('without a prefix, starts empty with the base hint, and names the current HEAD for a request without a base', () => {
    const d = mount({ prefix: '', initial: '', from: null })
    expect(d.message()).toBe(en['nameDialog.hintHead'])
    expect(d.confirm().hasAttribute('disabled')).toBe(true)
  })

  it('takes the keyboard with the caret after the starting text', () => {
    const d = mount({ initial: 'dsh-fix', named: true })
    expect(document.activeElement).toBe(d.field())
    expect(d.field().selectionStart).toBe(7)
  })
})

describe('WorktreeNameDialog requests', () => {
  it('requests the name with Enter, ignores Enter while composing, and closes once the request is accepted', async () => {
    const d = mount()
    d.type('dsh-fix')
    fireEvent.keyDown(d.field(), { key: 'Enter', isComposing: true })
    expect(d.submit).not.toHaveBeenCalled()
    fireEvent.keyDown(d.field(), { key: 'a' })
    await act(async () => { fireEvent.keyDown(d.field(), { key: 'Enter' }) })
    expect(d.submit).toHaveBeenCalledWith('dsh-fix')
    expect(d.close).toHaveBeenCalledOnce()
  })

  it('stays busy until the Host answers, then shows its refusal for that name only', async () => {
    let answer: (result: 'branch-exists' | 'invalid-name' | 'failed') => void = () => {}
    const d = mount()
    d.submit.mockImplementation(() => new Promise((resolve) => { answer = resolve }))
    d.type('dsh-taken')
    fireEvent.click(d.confirm())
    expect(d.confirm().hasAttribute('disabled')).toBe(true)
    await act(async () => { answer('branch-exists') })
    expect(d.message()).toBe('A branch named dsh-taken already exists')
    expect(d.confirm().hasAttribute('disabled')).toBe(true)

    d.type('dsh-odd')
    expect(d.confirm().hasAttribute('disabled')).toBe(false)
    fireEvent.click(d.confirm())
    await act(async () => { answer('invalid-name') })
    expect(d.message()).toBe(en['branchName.invalid'])

    d.type('dsh-other')
    fireEvent.click(d.confirm())
    await act(async () => { answer('failed') })
    expect(d.message()).toBe('The first message creates this branch from main; the worktree directory takes its name')
    expect(d.close).not.toHaveBeenCalled()
  })

  it('returns a named request to generated names, ignoring a refusal that names no branch', async () => {
    const d = mount({ initial: 'dsh-fix', named: true })
    d.submit.mockResolvedValueOnce('branch-exists')
    await act(async () => { fireEvent.click(within(d.dialog()).getByRole('button', { name: en['nameDialog.auto'] })) })
    expect(d.submit).toHaveBeenCalledWith(null)
    expect(d.message()).toBe('The first message creates this branch from main; the worktree directory takes its name')
    await act(async () => { fireEvent.click(within(d.dialog()).getByRole('button', { name: en['nameDialog.auto'] })) })
    expect(d.close).toHaveBeenCalledOnce()
  })

  it('renames for another attempt in retry mode, without the return to generated names', async () => {
    const d = mount({ mode: 'retry', initial: 'dsh-fix', named: true })
    expect(screen.getByRole('dialog', { name: en['nameDialog.retryTitle'] })).toBeTruthy()
    expect(within(d.dialog()).queryByRole('button', { name: en['nameDialog.auto'] })).toBeNull()
    d.type('dsh-fix-2')
    await act(async () => { fireEvent.click(d.confirm()) })
    expect(d.submit).toHaveBeenCalledWith('dsh-fix-2')
  })

  it('closes without a request from Cancel and the close button', () => {
    const d = mount()
    fireEvent.click(within(d.dialog()).getByRole('button', { name: en['nameDialog.cancel'] }))
    fireEvent.click(within(d.dialog()).getByRole('button', { name: en['nameDialog.close'] }))
    expect(d.close).toHaveBeenCalledTimes(2)
    expect(d.submit).not.toHaveBeenCalled()
  })
})
