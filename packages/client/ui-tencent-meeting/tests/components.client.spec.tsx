// @vitest-environment jsdom
/** The account section, title tag, activation guidance, and notices render the Host view the page mirrors. */
import type { ComponentProps } from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { CliOperationId } from '@deepseek-ai/dsh-cli-account/types'
import type { PluginPackageRef, PluginsSubject } from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type { TencentMeetingState } from '@deepseek-ai/dsh-tencent-meeting-cli/types'
import { afterEach, expect, it, vi } from 'vitest'
import type { ConnectionSnapshot } from '../src/client/connection.ts'
import { en, zh } from '../src/client/locales.ts'
import {
  TencentMeetingConnectionActivation, TencentMeetingConnectionBadge, TencentMeetingConnectionSection, TencentMeetingConnectionToast,
} from '../src/client/TencentMeetingConnection.tsx'

afterEach(cleanup)

const OP = 'op' as CliOperationId
const LINK = 'https://meeting.tencent.com/marketplace/tencentmeeting-cli-auth.html?code=fixture'
const SIGNED_OUT: TencentMeetingState = { account: { state: 'signed-out' } }
const CONNECTED: TencentMeetingState = { account: { state: 'connected', userName: '测试用户' } }

function fixture(view?: TencentMeetingState, copy: typeof zh = zh) {
  const state = createSnapshotStore<ConnectionSnapshot>({ view, linked: true, stopped: false, busy: false, notice: undefined })
  const face = {
    useTencentMeetingConnection: bindSnapshotSelector(state),
    check: vi.fn(), signIn: vi.fn(), signOut: vi.fn(), cancel: vi.fn(),
    openAuthorization: vi.fn(), retry: vi.fn(), dismissNotice: vi.fn(),
    t: makeTranslate(copy),
  }
  return { face, set: (change: Partial<ConnectionSnapshot>) => { act(() => { state.set({ ...state.getSnapshot(), ...change }) }) } }
}

const button = (name: string) => screen.getByRole('button', { name })

it('offers the next step while signing in', () => {
  const b = fixture(SIGNED_OUT)
  render(<TencentMeetingConnectionSection {...b.face} />)
  expect(screen.getByText(zh['detail.disconnected'])).toBeTruthy()
  expect(screen.getByText(zh.hint)).toBeTruthy()
  fireEvent.click(button(zh['action.connect']))
  expect(b.face.signIn).toHaveBeenCalledOnce()

  b.set({ view: { ...SIGNED_OUT, operation: { id: OP, kind: 'sign-in', phase: 'authorizing', cancellable: true } } })
  expect(screen.getByText(zh['step.authorizing'])).toBeTruthy()
  expect(screen.queryByRole('button', { name: zh['action.open'] })).toBeNull()
  b.set({ view: { ...SIGNED_OUT, operation: { id: OP, kind: 'sign-in', phase: 'authorizing', cancellable: true, authorizationUrl: LINK } } })
  expect(screen.getByText(zh['detail.authorizing'])).toBeTruthy()
  fireEvent.click(button(zh['action.open']))
  fireEvent.click(button(zh['action.cancel']))
  expect(b.face.openAuthorization).toHaveBeenCalledOnce()
  expect(b.face.cancel).toHaveBeenCalledOnce()

  b.set({ view: { ...SIGNED_OUT, operation: { id: OP, kind: 'sign-in', phase: 'checking', cancellable: false } } })
  expect(screen.getByText(zh['step.connecting'])).toBeTruthy()
  expect(screen.queryAllByRole('button')).toHaveLength(0)

  b.set({ view: undefined })
  expect(screen.getByText(zh['status.checking'])).toBeTruthy()
  expect(screen.queryAllByRole('button')).toHaveLength(0)
})

it('names the signed-in user and signs out only after confirmation', () => {
  const b = fixture(CONNECTED)
  render(<TencentMeetingConnectionSection {...b.face} />)
  expect(screen.getByText(zh['detail.connected'].replace('{name}', '测试用户'))).toBeTruthy()

  fireEvent.click(button(zh['action.signOut']))
  const dialog = screen.getByRole('dialog')
  expect(within(dialog).getByText(zh['signOut.body'])).toBeTruthy()
  fireEvent.click(within(dialog).getByRole('button', { name: zh['action.cancel'] }))
  expect(b.face.signOut).not.toHaveBeenCalled()

  fireEvent.click(button(zh['action.signOut']))
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: zh['action.signOut'] }))
  expect(b.face.signOut).toHaveBeenCalledOnce()

  b.set({ view: { ...CONNECTED, operation: { id: OP, kind: 'sign-out', phase: 'signing-out', cancellable: false } } })
  expect(screen.getByText(zh['step.signing-out'])).toBeTruthy()
  expect(screen.queryAllByRole('button')).toHaveLength(0)
})

it.each([['zh', zh], ['en', en]] as const)('reports a failed sign-in with its command and exit code in %s', (_locale, copy) => {
  const b = fixture({ ...SIGNED_OUT, result: { id: OP, kind: 'sign-in', outcome: 'failed', failure: { command: 'auth-login', exitCode: 1 } } }, copy)
  render(<TencentMeetingConnectionSection {...b.face} />)
  const details = copy['failure.details'].replace('{details}', `auth-login · ${copy['failure.exitCode'].replace('{code}', '1')}`)
  expect(screen.getByRole('alert').textContent).toBe(`${copy.failed} ${details}`)
  expect(button(copy['action.connect'])).toBeTruthy()

  b.set({ view: { ...SIGNED_OUT, result: { id: OP, kind: 'sign-in', outcome: 'cancelled' } } })
  expect(screen.queryByRole('alert')).toBeNull()
})

it('retries an unconfirmed sign-in by checking again', () => {
  const b = fixture({ account: { state: 'unverified' } })
  render(<TencentMeetingConnectionSection {...b.face} />)
  expect(screen.getByText(zh['detail.unavailable'])).toBeTruthy()
  fireEvent.click(button(zh['action.retry']))
  expect(b.face.check).toHaveBeenCalledOnce()
})

it('explains a stopped Host component and retries even while the stream is offline', () => {
  const b = fixture(undefined)
  render(<TencentMeetingConnectionSection {...b.face} />)
  b.set({ linked: false, stopped: true })
  expect(screen.getByText(zh['status.stopped'])).toBeTruthy()
  expect(screen.getByText(zh['detail.stopped'])).toBeTruthy()
  fireEvent.click(button(zh['action.retry']))
  expect(b.face.retry).toHaveBeenCalledOnce()
})

it('tags only the enabled Tencent Meeting bundle', () => {
  const b = fixture(CONNECTED)
  const pkg = (name: string, enabled = true): PluginPackageRef => ({ name, installed: true, availability: 'profile', official: false, enabled, rows: [] })
  const badge = (subject: PluginsSubject) =>
    <TencentMeetingConnectionBadge {...{ ...b.face, subject } as ComponentProps<typeof TencentMeetingConnectionBadge>} />
  const { rerender } = render(badge({ kind: 'bundle', pkg: pkg('@deepseek-ai/dsh-tencent-meeting') }))
  expect(screen.getByText(zh['badge.connected'])).toBeTruthy()
  b.set({ view: SIGNED_OUT })
  expect(screen.getByText(zh['badge.disconnected'])).toBeTruthy()
  rerender(badge({ kind: 'bundle', pkg: pkg('@acme/other') }))
  expect(document.body.textContent).toBe('')
})

it('guides a newly enabled bundle to sign in, and steps aside once connected', () => {
  const b = fixture()
  const onDismiss = vi.fn(), onOpenDetails = vi.fn()
  const props = { ...b.face, packageName: '@deepseek-ai/dsh-tencent-meeting', onDismiss, onOpenDetails } as ComponentProps<typeof TencentMeetingConnectionActivation>
  render(<TencentMeetingConnectionActivation {...props} />)
  expect(screen.queryByText(zh['activation.body'])).toBeNull()
  b.set({ view: SIGNED_OUT })
  fireEvent.click(button(zh['action.connect']))
  expect(onOpenDetails).toHaveBeenCalledOnce()
  expect(b.face.signIn).toHaveBeenCalledOnce()
  b.set({ view: CONNECTED })
  expect(onDismiss).toHaveBeenCalledOnce()
})

it('reports the latest notice', () => {
  const b = fixture()
  render(<TencentMeetingConnectionToast {...b.face} />)
  expect(document.body.textContent).toBe('')
  b.set({ notice: { seq: 1, kind: 'signed-out' } })
  expect(screen.getByText(zh['notice.signed-out'])).toBeTruthy()
})
