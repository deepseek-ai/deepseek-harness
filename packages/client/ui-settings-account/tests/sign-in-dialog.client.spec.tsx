// @vitest-environment jsdom
/** Login choices, timeout recovery, and manual cancellation. */
import { cleanup, fireEvent, render, screen, act } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { AccountView, SignInAttemptId } from '@deepseek-ai/dsh-deepseek-account/types'
import { SignInDialog } from '../src/client/SignInDialog.tsx'
import { en, zh } from '../src/client/locales.ts'

afterEach(cleanup)
const id = 'login-attempt' as SignInAttemptId
function dialogProps(attempt: AccountView['attempt'], copy: typeof en | typeof zh = en, colorScheme: 'light' | 'dark' = 'dark') {
  const start = vi.fn(async () => {})
  const cancel = vi.fn(async () => {})
  const close = vi.fn()
  const useApiKey = vi.fn()
  return { start, cancel, close, useApiKey, colorScheme, t: (key: keyof typeof en) => copy[key],
    account: { view: { status: 'signed-out' as const, attempt, links: { usageUrl: 'https://platform.deepseek.com/usage', topUpUrl: 'https://platform.deepseek.com/top_up' } }, details: undefined, failed: false } }
}
function mount(attempt: AccountView['attempt'], copy: typeof en | typeof zh = en, colorScheme: 'light' | 'dark' = 'dark') {
  const props = dialogProps(attempt, copy, colorScheme)
  render(<SignInDialog {...props} />)
  return props
}
it.each([en, zh])('offers sign in or the existing API key editor', async (copy) => {
  const props = mount(null, copy)
  await expect(`${screen.getByRole('dialog').textContent}\n`).toMatchFileSnapshot(`./expected/login-${copy === en ? 'en' : 'zh'}.txt`)
  fireEvent.click(screen.getByRole('button', { name: copy.addApiKey }))
  expect(props.useApiKey).toHaveBeenCalledOnce()
  expect(props.start).not.toHaveBeenCalled()
})
it.each([en, zh])('requires a user action after timeout', async (copy) => {
  const props = mount({ id, phase: 'expired', errorCode: 'expired' }, copy)
  expect(props.start).not.toHaveBeenCalled()
  await expect(`${screen.getByRole('dialog').textContent}\n`).toMatchFileSnapshot(`./expected/login-timeout-${copy === en ? 'en' : 'zh'}.txt`)
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: copy.retry })) })
  expect(props.start).toHaveBeenCalledOnce()
})
it.each([en, zh])('shows waiting actions and cancels before dismissing', async (copy) => {
  const props = mount({ id, phase: 'waiting-browser', authorizeUrl: 'https://platform.deepseek.com/dsh/authorize?state=example' }, copy)
  expect(screen.getByRole('button', { name: copy.waiting }).hasAttribute('disabled')).toBe(true)
  await expect(`${screen.getByRole('dialog').textContent}\n`).toMatchFileSnapshot(`./expected/login-waiting-${copy === en ? 'en' : 'zh'}.txt`)
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: copy.cancel })) })
  expect(props.cancel).toHaveBeenCalledExactlyOnceWith(id)
  expect(props.close).toHaveBeenCalledOnce()
})
it('keeps an admitted credential commit open on Escape and close', () => {
  const props = mount({ id, phase: 'committing' })
  fireEvent.keyDown(document, { key: 'Escape' })
  fireEvent.click(screen.getByRole('button', { name: en.close }))
  expect(props.close).not.toHaveBeenCalled()
  expect(props.cancel).not.toHaveBeenCalled()
})

it.each([en, zh])('restores the copy label two seconds after the latest successful copy', async (copy) => {
  const clipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
  const writeText = vi.fn(async () => {})
  vi.useFakeTimers()
  try {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const authorizeUrl = 'https://platform.deepseek.com/dsh/authorize?state=example'
    mount({ id, phase: 'waiting-browser', authorizeUrl }, copy)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: copy.copyLink })) })
    expect(writeText).toHaveBeenLastCalledWith('https://platform.deepseek.com/dsh/authorize?state=example&theme=dark')
    act(() => { vi.advanceTimersByTime(1000) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: copy.copiedLink })) })
    expect(writeText).toHaveBeenCalledTimes(2)
    act(() => { vi.advanceTimersByTime(1999) })
    expect(screen.getByRole('button', { name: copy.copiedLink })).toBeTruthy()
    act(() => { vi.advanceTimersByTime(1) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: copy.copyLink })) })
    expect(writeText).toHaveBeenCalledTimes(3)
  } finally {
    cleanup()
    vi.useRealTimers()
    if (clipboard) Object.defineProperty(navigator, 'clipboard', clipboard)
    else Reflect.deleteProperty(navigator, 'clipboard')
  }
})

it('copies the authorization link with the palette of the current render', async () => {
  const clipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
  const writeText = vi.fn(async () => {})
  try {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const attempt = { id, phase: 'waiting-browser' as const, authorizeUrl: 'https://platform.deepseek.com/dsh/authorize?state=example' }
    const props = dialogProps(attempt, en, 'dark')
    const view = render(<SignInDialog {...props} />)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.copyLink })) })
    expect(writeText).toHaveBeenLastCalledWith('https://platform.deepseek.com/dsh/authorize?state=example&theme=dark')
    view.rerender(<SignInDialog {...props} colorScheme="light" />)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.copiedLink })) })
    expect(writeText).toHaveBeenLastCalledWith('https://platform.deepseek.com/dsh/authorize?state=example&theme=light')
  } finally {
    if (clipboard) Object.defineProperty(navigator, 'clipboard', clipboard)
    else Reflect.deleteProperty(navigator, 'clipboard')
  }
})

it.each([en, zh])('shows a temporary copy failure without interrupting sign-in', async (copy) => {
  const clipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
  vi.useFakeTimers()
  try {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText: vi.fn(async () => { throw new Error('Clipboard denied') }),
    } })
    const props = mount({ id, phase: 'waiting-browser', authorizeUrl: 'https://platform.deepseek.com/dsh/authorize?state=example' }, copy)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: copy.copyLink })) })
    expect(screen.getByRole('dialog', { name: copy.browserTitle })).toBeTruthy()
    expect(screen.getByRole('button', { name: copy.copyFailed })).toBeTruthy()
    await expect(`${screen.getByRole('dialog').textContent}\n`).toMatchFileSnapshot(`./expected/login-copy-failed-${copy === en ? 'en' : 'zh'}.txt`)
    act(() => { vi.advanceTimersByTime(1000) })
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: copy.copyFailed })) })
    act(() => { vi.advanceTimersByTime(1999) })
    expect(screen.getByRole('button', { name: copy.copyFailed })).toBeTruthy()
    act(() => { vi.advanceTimersByTime(1) })
    expect(screen.getByRole('button', { name: copy.copyLink })).toBeTruthy()
    expect(props.cancel).not.toHaveBeenCalled()
    expect(props.start).not.toHaveBeenCalled()
  } finally {
    cleanup()
    vi.useRealTimers()
    if (clipboard) Object.defineProperty(navigator, 'clipboard', clipboard)
    else Reflect.deleteProperty(navigator, 'clipboard')
  }
})

it.each([en, zh])('shows an error during an active attempt and waits for cancellation before retrying', async (copy) => {
  const props = mount({ id, phase: 'waiting-browser' }, copy)
  cleanup()
  props.account.failed = true
  render(<SignInDialog {...props} />)
  expect(screen.getByRole('dialog', { name: copy.failureTitle })).toBeTruthy()
  expect(screen.queryByRole('button', { name: copy.waiting })).toBeNull()
  await expect(`${screen.getByRole('dialog').textContent}\n`).toMatchFileSnapshot(`./expected/login-active-error-${copy === en ? 'en' : 'zh'}.txt`)
  const cancelled = Promise.withResolvers<undefined>()
  props.cancel.mockReturnValueOnce(cancelled.promise)
  fireEvent.click(screen.getByRole('button', { name: copy.retry }))
  expect(props.cancel).toHaveBeenCalledExactlyOnceWith(id)
  expect(props.start).not.toHaveBeenCalled()
  expect(screen.getByRole('button', { name: copy.retry }).hasAttribute('disabled')).toBe(true)
  await act(async () => { cancelled.resolve(undefined); await cancelled.promise })
  expect(props.start).toHaveBeenCalledOnce()
})

it('does not start another attempt when cancellation fails', async () => {
  const props = mount({ id, phase: 'waiting-browser' })
  cleanup()
  props.account.failed = true
  props.cancel.mockRejectedValueOnce(new Error('cancel unavailable'))
  render(<SignInDialog {...props} />)
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.retry })) })
  expect(props.start).not.toHaveBeenCalled()
  expect(screen.getByRole('dialog', { name: en.failureTitle })).toBeTruthy()
  expect(screen.getByRole('button', { name: en.retry }).hasAttribute('disabled')).toBe(false)
})

it('dismisses an idle dialog and closes after the account becomes signed in', () => {
  const props = mount(null)
  fireEvent.keyDown(document, { key: 'Enter' })
  expect(props.close).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: en.close }))
  expect(props.close).toHaveBeenCalledOnce()
  cleanup()
  render(<SignInDialog {...props} account={{ ...props.account, view: { ...props.account.view, status: 'credential-stored' } }} />)
  expect(props.close).toHaveBeenCalledTimes(2)
})

it('keeps an outstanding start open until the request settles', async () => {
  const props = mount(null)
  cleanup()
  const pending = Promise.withResolvers<undefined>()
  props.start.mockReturnValueOnce(pending.promise)
  render(<SignInDialog {...props} />)
  fireEvent.click(screen.getByRole('button', { name: en.signIn }))
  fireEvent.click(screen.getByRole('button', { name: en.close }))
  expect(props.close).not.toHaveBeenCalled()
  await act(async () => { pending.resolve(undefined); await pending.promise })
  expect(screen.getByRole('button', { name: en.signIn }).hasAttribute('disabled')).toBe(false)
})
