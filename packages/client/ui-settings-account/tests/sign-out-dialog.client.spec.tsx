// @vitest-environment jsdom
/** Sign-out impact copy and explicit confirmation. */
import { cleanup, fireEvent, render, screen, act } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { SignOutDialog } from '../src/client/SignOutDialog.tsx'
import { en, zh } from '../src/client/locales.ts'

afterEach(cleanup)
function mount(running: boolean | 'unknown', copy: typeof en | typeof zh = en, signOut = vi.fn(async () => {})) {
  const close = vi.fn()
  render(<SignOutDialog running={running} signOut={signOut} close={close} t={key => copy[key]} />)
  return { signOut, close }
}
it.each([en, zh].flatMap(copy => ([false, true, 'unknown'] as const).map(running => ({ copy, running }))))(
  'confirms sign-out with localized task impact: $running', async ({ copy, running }) => {
    const props = mount(running, copy)
    await expect(`${screen.getByRole('dialog').textContent}\n`)
      .toMatchFileSnapshot(`./expected/sign-out-${running === 'unknown' ? 'unknown' : running ? 'running' : 'idle'}-${copy === en ? 'en' : 'zh'}.txt`)
    expect(props.signOut).not.toHaveBeenCalled()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: copy.signOut })) })
    expect(props.signOut).toHaveBeenCalledOnce()
    expect(props.close).toHaveBeenCalledOnce()
  },
)
it.each(['cancel', 'close', 'escape'] as const)('dismisses with %s without signing out', (action) => {
  const props = mount(true)
  if (action === 'escape') fireEvent.keyDown(document, { key: 'Escape' })
  else fireEvent.click(screen.getByRole('button', { name: en[action] }))
  expect(props.close).toHaveBeenCalledOnce()
  expect(props.signOut).not.toHaveBeenCalled()
})
it('keeps failures open for retry and blocks dismissal during sign-out', async () => {
  const pending = Promise.withResolvers<undefined>()
  const signOut = vi.fn(() => pending.promise).mockRejectedValueOnce(new Error('offline'))
  const props = mount(true, en, signOut)
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.signOut })) })
  expect(screen.getByRole('alert').textContent).toBe(en.failed)
  expect(props.close).not.toHaveBeenCalled()
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.signOut })) })
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(props.close).not.toHaveBeenCalled()
  expect(screen.getByRole('button', { name: en.signOut }).hasAttribute('disabled')).toBe(true)
  await act(async () => { pending.resolve(undefined) })
  expect(props.close).toHaveBeenCalledOnce()
})
