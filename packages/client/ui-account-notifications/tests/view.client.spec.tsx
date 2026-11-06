// @vitest-environment jsdom
/** The menu extension preserves notifications while onboarding hides their presentation. */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import { AccountNotifications, type AccountNotificationsProps } from '../src/client/AccountNotifications.tsx'
import { notification } from './notification-fixture.ts'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

it('shows retained cards inside the menu and opens account settings without dismissing them', () => {
  vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} })
  const notices = [notification('notice', { actions: [
    { label: 'View account', style: 'primary', target: { type: 'app_route', name: 'account' } },
  ] })]
  const openAccount = vi.fn()
  const dismiss = vi.fn()
  const ctaClicked = vi.fn()
  const props: AccountNotificationsProps = {
    ...({} as GlobalStandardProps), active: false, openAccount, ctaClicked, dismiss, shown: vi.fn(),
    useNotices: select => select(notices), t: () => 'Close',
  }
  const view = render(<AccountNotifications {...props} />)
  expect(screen.queryByRole('status')).toBeNull()
  view.rerender(<AccountNotifications {...props} active />)
  fireEvent.click(screen.getByRole('button', { name: 'View account' }))
  expect(openAccount).toHaveBeenCalledOnce()
  expect(ctaClicked).toHaveBeenCalledExactlyOnceWith('notice')
  expect(screen.getByRole('status')).toBeTruthy()
  expect(dismiss).not.toHaveBeenCalled()
  view.rerender(<AccountNotifications {...props} active={false} />)
  expect(screen.queryByRole('status')).toBeNull()
  expect(dismiss).not.toHaveBeenCalled()
  view.rerender(<AccountNotifications {...props} active />)
  expect(screen.getByRole('button', { name: 'View account' })).toBeTruthy()
})
