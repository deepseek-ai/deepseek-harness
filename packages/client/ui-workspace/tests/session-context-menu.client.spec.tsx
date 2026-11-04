// @vitest-environment jsdom
/** Existing Session actions receive the captured owner and one dismissal context. */
import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ComponentProps } from 'react'
import { SessionMenu } from '../src/client/session-actions/SessionMenu.tsx'

afterEach(cleanup)
it('ignores other targets and forwards close requests from legacy Session actions', () => {
  const dismiss = vi.fn()
  const slot = vi.fn((_slot: string, _owner: unknown, _options?: { hookContext?: unknown }) => null)
  const renderSlot = slot as ComponentProps<typeof SessionMenu>['renderSlot']
  const view = render(<SessionMenu target={{ kind: 'image', value: { url: 'blob:image' } }} dismiss={dismiss} renderSlot={renderSlot} />)
  expect(slot).not.toHaveBeenCalled()
  view.rerender(<SessionMenu target={{ kind: 'session', value: { sessionId: SessionId('captured'), displayTitle: 'Captured' } }} dismiss={dismiss} renderSlot={renderSlot} />)
  expect(slot.mock.calls[0]?.[1]).toEqual({ sessionId: 'captured', displayTitle: 'Captured' })
  const [open, setOpen] = slot.mock.calls[0]?.[2]?.hookContext as readonly [boolean, (value: boolean) => void]
  expect(open).toBe(true)
  setOpen(true)
  expect(dismiss).not.toHaveBeenCalled()
  setOpen(false)
  expect(dismiss).toHaveBeenCalledOnce()
})
