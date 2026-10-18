// @vitest-environment jsdom
/** The account section, title tag, activation guidance, and notices render the Host view the page mirrors. */
import type { ComponentProps } from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { CliOperationId } from '@deepseek-ai/dsh-cli-account/types'
import type { PluginPackageRef, PluginsSubject } from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type { DingtalkState } from '@deepseek-ai/dsh-dingtalk-cli/types'
import { afterEach, expect, it, vi } from 'vitest'
import type { ConnectionSnapshot } from '../src/client/connection.ts'
import { en, zh } from '../src/client/locales.ts'
import {
  DingtalkConnectionActivation, DingtalkConnectionBadge, DingtalkConnectionSection, DingtalkConnectionToast,
} from '../src/client/DingtalkConnection.tsx'

afterEach(cleanup)

const OP = 'op' as CliOperationId
const LINK = 'https://login.dingtalk.com/oauth2/auth?client_id=fixture&state=fixture'
const SIGNED_OUT: DingtalkState = { account: { state: 'signed-out' } }
const CONNECTED: DingtalkState = { account: { state: 'connected', userName: '测试用户', corpName: '测试组织' } }

function fixture(view?: DingtalkState, copy: typeof zh = zh) {
  const state = createSnapshotStore<ConnectionSnapshot>({ view, linked: true, stopped: false, busy: false, notice: undefined })
  const face = {
    useDingtalkConnection: bindSnapshotSelector(state),
    check: vi.fn(), signIn: vi.fn(), signOut: vi.fn(), cancel: vi.fn(),
    openAuthorization: vi.fn(), retry: vi.fn(), dismissNotice: vi.fn(),
    t: makeTranslate(copy),
  }
  return { face, set: (change: Partial<ConnectionSnapshot>) => { act(() => { state.set({ ...state.getSnapshot(), ...change }) }) } }
}

const button = (name: string) => screen.getByRole('button', { name })

it('shows the dws download, then offers the next step while signing in', () => {
  const b = fixture({ account: { state: 'unchecked' }, operation: { id: OP, kind: 'check', phase: 'downloading', cancellable: false } })
  render(<DingtalkConnectionSection {...b.face} />)
  expect(screen.getByText(zh['step.downloading'])).toBeTruthy()
  expect(screen.queryAllByRole('button')).toHaveLength(0)

  b.set({ view: SIGNED_OUT })
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

it.each<[string, DingtalkState['account'], string]>([
  ['the user and organization', CONNECTED.account, zh['detail.connectedIn'].replace('{name}', '测试用户').replace('{org}', '测试组织')],
  ['the user', { state: 'connected', userName: '测试用户' }, zh['detail.connectedAs'].replace('{name}', '测试用户')],
  ['no name', { state: 'connected' }, zh['detail.connected']],
])('names %s that dws reports', (_name, account, detail) => {
  const b = fixture({ account })
  render(<DingtalkConnectionSection {...b.face} />)
  expect(screen.getByText(detail)).toBeTruthy()
})

it('signs out only after confirmation', () => {
  const b = fixture(CONNECTED)
  render(<DingtalkConnectionSection {...b.face} />)
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

it.each([['zh', zh], ['en', en]] as const)('reports a failed sign-in with the CLI access hint, its command, and exit code in %s', (_locale, copy) => {
  const b = fixture({ ...SIGNED_OUT, result: { id: OP, kind: 'sign-in', outcome: 'failed', failure: { command: 'auth-login', exitCode: 2 } } }, copy)
  render(<DingtalkConnectionSection {...b.face} />)
  const details = copy['failure.details'].replace('{details}', `auth-login · ${copy['failure.exitCode'].replace('{code}', '2')}`)
  expect(screen.getByRole('alert').textContent).toBe(`${copy['failed.signIn']} ${details}`)
  expect(button(copy['action.connect'])).toBeTruthy()

  b.set({ view: { ...SIGNED_OUT, result: { id: OP, kind: 'sign-in', outcome: 'cancelled' } } })
  expect(screen.queryByRole('alert')).toBeNull()
})

it.each<[string, DingtalkState, string]>([
  ['a sign-in dws cannot judge', { account: { state: 'unverified' } }, zh['detail.unavailable']],
  ['a dws download that did not finish', { account: { state: 'not-installed' }, result: { id: OP, kind: 'check', outcome: 'failed' } }, zh['detail.missing']],
])('retries %s by checking again', (_name, view, detail) => {
  const b = fixture(view)
  render(<DingtalkConnectionSection {...b.face} />)
  expect(screen.getByText(detail)).toBeTruthy()
  fireEvent.click(button(zh['action.retry']))
  expect(b.face.check).toHaveBeenCalledOnce()
})

it('reports a failed check with the generic guidance', () => {
  const b = fixture({ account: { state: 'unchecked' }, result: { id: OP, kind: 'check', outcome: 'failed', failure: { command: 'auth-status', exitCode: 1 } } })
  render(<DingtalkConnectionSection {...b.face} />)
  expect(screen.getByRole('alert').textContent).toContain(zh.failed)
})

it('explains a stopped Host component and retries even while the stream is offline', () => {
  const b = fixture(undefined)
  render(<DingtalkConnectionSection {...b.face} />)
  b.set({ linked: false, stopped: true })
  expect(screen.getByText(zh['status.stopped'])).toBeTruthy()
  expect(screen.getByText(zh['detail.stopped'])).toBeTruthy()
  fireEvent.click(button(zh['action.retry']))
  expect(b.face.retry).toHaveBeenCalledOnce()
})

it('tags only the enabled DingTalk bundle', () => {
  const b = fixture(CONNECTED)
  const pkg = (name: string, enabled = true): PluginPackageRef => ({ name, installed: true, availability: 'profile', official: false, enabled, rows: [] })
  const badge = (subject: PluginsSubject) =>
    <DingtalkConnectionBadge {...{ ...b.face, subject } as ComponentProps<typeof DingtalkConnectionBadge>} />
  const { rerender } = render(badge({ kind: 'bundle', pkg: pkg('@deepseek-ai/dsh-dingtalk') }))
  expect(screen.getByText(zh['badge.connected'])).toBeTruthy()
  b.set({ view: SIGNED_OUT })
  expect(screen.getByText(zh['badge.disconnected'])).toBeTruthy()
  rerender(badge({ kind: 'bundle', pkg: pkg('@acme/other') }))
  expect(document.body.textContent).toBe('')
})

it('guides a newly enabled bundle to sign in, and steps aside once connected', () => {
  const b = fixture()
  const onDismiss = vi.fn(), onOpenDetails = vi.fn()
  const props = { ...b.face, packageName: '@deepseek-ai/dsh-dingtalk', onDismiss, onOpenDetails } as ComponentProps<typeof DingtalkConnectionActivation>
  render(<DingtalkConnectionActivation {...props} />)
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
  render(<DingtalkConnectionToast {...b.face} />)
  expect(document.body.textContent).toBe('')
  b.set({ notice: { seq: 1, kind: 'signed-out' } })
  expect(screen.getByText(zh['notice.signed-out'])).toBeTruthy()
})
