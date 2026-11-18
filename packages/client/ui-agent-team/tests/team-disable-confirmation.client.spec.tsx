// @vitest-environment jsdom

import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import {
  TeamDisableConfirmation, type TeamDisableConfirmationProps, type TeamDisableRequest,
} from '../src/client/TeamDisableConfirmation.tsx'
import { zh } from '../src/client/locales.ts'
import { brandString } from '@deepseek-ai/dsh-brand'

afterEach(cleanup)

const ORIGINAL = brandString<SessionId>('original-session')
const REPLACEMENT = brandString<SessionId>('replacement-session')

function props(
  request: TeamDisableRequest | null = { sessionId: ORIGINAL },
  disableTeam = vi.fn<TeamDisableConfirmationProps['disableTeam']>(async () => null),
) {
  const useDisableRequest: TeamDisableConfirmationProps['useDisableRequest'] = select => select(request)
  const cancelDisable = vi.fn<TeamDisableConfirmationProps['cancelDisable']>()
  return {
    props: { useDisableRequest, cancelDisable, disableTeam, t: makeTranslate(zh) } as TeamDisableConfirmationProps,
    cancelDisable,
    disableTeam,
  }
}

function pendingDisable() {
  const result = Promise.withResolvers<string | null>()
  onTestFinished(async () => {
    await act(async () => { result.resolve(null) })
  })
  return result
}

it('renders nothing when no disable request exists', () => {
  const input = props(null)
  const view = render(<TeamDisableConfirmation {...input.props} />)
  expect(view.container.childElementCount).toBe(0)
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(screen.queryByRole('button')).toBeNull()
  expect(input.disableTeam).not.toHaveBeenCalled()
  expect(input.cancelDisable).not.toHaveBeenCalled()
})

it('shows the localized title, two paragraphs, and actions without a checkbox', () => {
  const input = props()
  render(<TeamDisableConfirmation {...input.props} />)
  const dialog = within(screen.getByRole('dialog', { name: '确认关闭智能体团队协作？' }))
  expect(dialog.getByRole('heading', { name: '确认关闭智能体团队协作？' })).toBeTruthy()
  expect(dialog.getByText(zh['disable.description'], { selector: 'p' })).toBeTruthy()
  expect(dialog.getByText(zh['disable.warning'], { selector: 'p' })).toBeTruthy()
  expect(dialog.getAllByRole('paragraph')).toHaveLength(2)
  const cancel = dialog.getByRole('button', { name: zh['disable.cancel'] })
  expect(cancel.hasAttribute('disabled')).toBe(false)
  expect(document.activeElement).toBe(cancel)
  expect(dialog.getByRole('button', { name: zh['disable.confirm'] }).hasAttribute('disabled')).toBe(false)
  expect(dialog.getByRole('button', { name: zh['disable.close'] })).toBeTruthy()
  expect(dialog.queryByRole('checkbox')).toBeNull()
  expect(dialog.queryByRole('alert')).toBeNull()
  expect(input.disableTeam).not.toHaveBeenCalled()
})

it.each(['cancel', 'close', 'Escape'] as const)('dismisses through %s without disabling Team', (action) => {
  const input = props()
  const view = render(<TeamDisableConfirmation {...input.props} />)
  if (action === 'Escape') fireEvent.keyDown(document, { key: 'Escape' })
  else fireEvent.click(screen.getByRole('button', { name: zh[`disable.${action}`] }))
  expect(input.cancelDisable).toHaveBeenCalledExactlyOnceWith(ORIGINAL)
  expect(input.disableTeam).not.toHaveBeenCalled()
  view.rerender(<TeamDisableConfirmation {...input.props} useDisableRequest={select => select(null)} />)
  expect(screen.queryByRole('dialog')).toBeNull()
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(input.cancelDisable).toHaveBeenCalledTimes(1)
})

it('disables the originating Session once and blocks cancellation until success', async () => {
  const result = pendingDisable()
  const input = props({ sessionId: ORIGINAL }, vi.fn(() => result.promise))
  const view = render(<TeamDisableConfirmation {...input.props} />)
  const confirm = screen.getByRole('button', { name: zh['disable.confirm'] })
  fireEvent.click(confirm)
  expect(input.disableTeam).toHaveBeenCalledExactlyOnceWith(ORIGINAL)
  expect(confirm.hasAttribute('disabled')).toBe(true)
  const cancel = screen.getByRole('button', { name: zh['disable.cancel'] })
  expect(cancel.hasAttribute('disabled')).toBe(true)
  fireEvent.click(confirm)
  fireEvent.click(cancel)
  fireEvent.click(screen.getByRole('button', { name: zh['disable.close'] }))
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(input.disableTeam).toHaveBeenCalledTimes(1)
  expect(input.cancelDisable).not.toHaveBeenCalled()
  expect(screen.getByRole('dialog')).toBeTruthy()
  await act(async () => { result.resolve(null) })
  expect(input.cancelDisable).toHaveBeenCalledExactlyOnceWith(ORIGINAL)
  view.rerender(<TeamDisableConfirmation {...input.props} useDisableRequest={select => select(null)} />)
  expect(screen.queryByRole('dialog')).toBeNull()
})

it.each(['returned', 'error', 'string'] as const)('keeps a %s failure visible and allows retry', async (failure) => {
  const result = pendingDisable()
  const disableTeam = vi.fn<TeamDisableConfirmationProps['disableTeam']>()
    .mockImplementationOnce(async () => {
      if (failure === 'error') throw new Error('offline')
      if (failure === 'string') throw 'offline'
      return 'offline'
    })
    .mockImplementationOnce(() => result.promise)
  const input = props({ sessionId: ORIGINAL }, disableTeam)
  const view = render(<TeamDisableConfirmation {...input.props} />)
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh['disable.confirm'] })) })
  expect(screen.getByRole('alert').textContent).toBe(input.props.t('mode.failed', { message: 'offline' }))
  expect(input.cancelDisable).not.toHaveBeenCalled()
  expect(screen.getByRole('button', { name: zh['disable.cancel'] }).hasAttribute('disabled')).toBe(false)
  expect(screen.getByRole('button', { name: zh['disable.confirm'] }).hasAttribute('disabled')).toBe(false)
  view.rerender(<TeamDisableConfirmation {...input.props} useDisableRequest={select => select({ sessionId: ORIGINAL })} />)
  expect(screen.getByRole('alert').textContent).toContain('offline')
  fireEvent.click(screen.getByRole('button', { name: zh['disable.confirm'] }))
  expect(disableTeam.mock.calls).toEqual([[ORIGINAL], [ORIGINAL]])
  expect(screen.queryByRole('alert')).toBeNull()
  expect(screen.getByRole('button', { name: zh['disable.confirm'] }).hasAttribute('disabled')).toBe(true)
  await act(async () => { result.resolve(null) })
  expect(input.cancelDisable).toHaveBeenCalledExactlyOnceWith(ORIGINAL)
})

it('clears the previous failure when the request targets a different Session', async () => {
  const input = props({ sessionId: ORIGINAL }, vi.fn<TeamDisableConfirmationProps['disableTeam']>()
    .mockResolvedValueOnce('old failure').mockResolvedValueOnce(null))
  const view = render(<TeamDisableConfirmation {...input.props} />)
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh['disable.confirm'] })) })
  expect(screen.getByRole('alert').textContent).toContain('old failure')
  view.rerender(<TeamDisableConfirmation {...input.props} useDisableRequest={select => select({ sessionId: REPLACEMENT })} />)
  expect(screen.queryByRole('alert')).toBeNull()
  expect(screen.getByRole('button', { name: zh['disable.confirm'] }).hasAttribute('disabled')).toBe(false)
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh['disable.confirm'] })) })
  expect(input.disableTeam.mock.calls).toEqual([[ORIGINAL], [REPLACEMENT]])
  expect(input.cancelDisable).toHaveBeenCalledExactlyOnceWith(REPLACEMENT)
})

it.each(['success', 'returned', 'error'] as const)('isolates a replacement request from the old pending %s', async (outcome) => {
  const original = pendingDisable()
  const replacement = pendingDisable()
  const input = props({ sessionId: ORIGINAL }, vi.fn<TeamDisableConfirmationProps['disableTeam']>()
    .mockImplementationOnce(() => original.promise).mockImplementationOnce(() => replacement.promise))
  const view = render(<TeamDisableConfirmation {...input.props} />)
  fireEvent.click(screen.getByRole('button', { name: zh['disable.confirm'] }))
  expect(screen.getByRole('button', { name: zh['disable.confirm'] }).hasAttribute('disabled')).toBe(true)
  view.rerender(<TeamDisableConfirmation {...input.props} useDisableRequest={select => select({ sessionId: REPLACEMENT })} />)
  const confirm = screen.getByRole('button', { name: zh['disable.confirm'] })
  expect(confirm.hasAttribute('disabled')).toBe(false)
  expect(screen.getByRole('button', { name: zh['disable.cancel'] }).hasAttribute('disabled')).toBe(false)
  expect(screen.queryByRole('alert')).toBeNull()
  fireEvent.click(confirm)
  expect(input.disableTeam.mock.calls).toEqual([[ORIGINAL], [REPLACEMENT]])
  await act(async () => {
    if (outcome === 'error') original.reject(new Error('old failure'))
    else original.resolve(outcome === 'success' ? null : 'old failure')
  })
  expect(screen.getByRole('dialog', { name: zh['disable.title'] })).toBeTruthy()
  expect(screen.queryByRole('alert')).toBeNull()
  expect(confirm.hasAttribute('disabled')).toBe(true)
  if (outcome === 'success') expect(input.cancelDisable).toHaveBeenCalledExactlyOnceWith(ORIGINAL)
  else expect(input.cancelDisable).not.toHaveBeenCalled()
  fireEvent.click(confirm)
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(input.disableTeam).toHaveBeenCalledTimes(2)
  expect(input.cancelDisable).not.toHaveBeenCalledWith(REPLACEMENT)
  await act(async () => { replacement.resolve(null) })
  expect(input.cancelDisable.mock.calls).toEqual(outcome === 'success' ? [[ORIGINAL], [REPLACEMENT]] : [[REPLACEMENT]])
})
