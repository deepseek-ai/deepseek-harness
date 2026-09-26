// @vitest-environment jsdom
/** The credential onboarding step owns login until dismissal or completion. */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import type { ThemeSnapshot } from '@deepseek-ai/dsh-client-ui-theme/client'
import { AccountOnboarding } from '../src/client/AccountOnboarding.tsx'
import type { AccountSnapshot } from '../src/client/AccountSection.tsx'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const theme: ThemeSnapshot = {
  preference: 'light', fontSize: 14,
  active: { id: 'light', colorScheme: 'light', tokens: {} }, themes: [], revision: 0,
}

it('claims onboarding while loading, offers API key fallback, and completes after login', () => {
  let account: AccountSnapshot = { view: undefined, details: undefined, failed: false }
  const unused = (): never => { throw new Error('AccountOnboarding does not consume global hooks') }
  const globals: GlobalStandardProps = {
    usePanelInfo: unused, useSessions: unused, useSessionStatus: unused,
    useSessionRetainInfo: unused, useResource: unused, useWorkspaces: unused,
  }
  const props = {
    ...globals,
    hasRunningAccountTasks: vi.fn(async () => false),
    complete: vi.fn(), useApiKey: vi.fn(), setOnboarding: vi.fn(), showLogin: vi.fn(),
    useAccount: <T,>(select: (snapshot: AccountSnapshot) => T) => select(account),
    useTheme: <T,>(select: (snapshot: ThemeSnapshot) => T) => select(theme),
    start: vi.fn(async () => {}), cancel: vi.fn(async () => {}), signOut: vi.fn(async () => {}),
    contactUs: vi.fn(), t: makeTranslate(en),
    refreshAccount: vi.fn(async () => {}), bonusNoticeShown: vi.fn(), bonusNoticeDismissed: vi.fn(),
  }
  const view = render(<AccountOnboarding {...props} />)
  expect(props.setOnboarding).toHaveBeenCalledExactlyOnceWith(true)
  expect(screen.queryByRole('dialog')).toBeNull()
  account = { ...account, view: { status: 'signed-out', attempt: null, links: { usageUrl: '', topUpUrl: '' } } }
  view.rerender(<AccountOnboarding {...props} />)
  fireEvent.click(screen.getByRole('button', { name: en.addApiKey }))
  expect(props.showLogin).toHaveBeenLastCalledWith(false)
  expect(props.useApiKey).toHaveBeenCalledOnce()
  fireEvent.click(screen.getByRole('button', { name: en.close }))
  expect(props.complete).toHaveBeenCalledOnce()
  account = { ...account, view: { ...account.view!, status: 'credential-stored' } }
  view.rerender(<AccountOnboarding {...props} />)
  expect(props.complete).toHaveBeenCalledTimes(2)
  expect(screen.queryByRole('dialog')).toBeNull()
  view.unmount()
  expect(props.setOnboarding).toHaveBeenLastCalledWith(false)
})
