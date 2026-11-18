// @vitest-environment jsdom

import type { ComponentProps } from 'react'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { TeamDisableConfirmation, type TeamDisableConfirmationProps } from '../src/client/TeamDisableConfirmation.tsx'
import { zh } from '../src/client/locales.ts'
import { brandString } from '@deepseek-ai/dsh-brand'

vi.mock('../src/client/TeamDisableConfirmation.module.css', () => ({ default: {} }))
vi.mock('@deepseek-ai/dsh-client-ui-primitives', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@deepseek-ai/dsh-client-ui-primitives')>()
  return {
    ...actual,
    // Deliver repeated activations to the form even while its native button would suppress them.
    Button: (props: ComponentProps<typeof Button>) => <actual.Button {...props} disabled={false} aria-disabled={props.disabled} />,
  }
})

afterEach(cleanup)

it('keeps one disable operation pending despite repeated callbacks without optional stylesheet classes', async () => {
  const pending = Promise.withResolvers<string | null>()
  onTestFinished(async () => { await act(async () => { pending.resolve(null) }) })
  const sessionId = brandString<SessionId>('pending-disable-session')
  const disableTeam = vi.fn<TeamDisableConfirmationProps['disableTeam']>(() => pending.promise)
  const cancelDisable = vi.fn<TeamDisableConfirmationProps['cancelDisable']>()
  const useDisableRequest: TeamDisableConfirmationProps['useDisableRequest'] = select => select({ sessionId })
  const props = { useDisableRequest, disableTeam, cancelDisable, t: makeTranslate(zh) } as TeamDisableConfirmationProps
  render(<TeamDisableConfirmation {...props} />)
  const confirm = screen.getByRole('button', { name: zh['disable.confirm'] })
  fireEvent.click(confirm)
  expect(confirm.getAttribute('aria-disabled')).toBe('true')
  fireEvent.click(confirm)
  fireEvent.click(screen.getByRole('button', { name: zh['disable.cancel'] }))
  expect(disableTeam).toHaveBeenCalledExactlyOnceWith(sessionId)
  expect(cancelDisable).not.toHaveBeenCalled()
  expect(screen.getByRole('dialog', { name: zh['disable.title'] })).toBeTruthy()
  await act(async () => { pending.resolve(null) })
  expect(cancelDisable).toHaveBeenCalledExactlyOnceWith(sessionId)
})
