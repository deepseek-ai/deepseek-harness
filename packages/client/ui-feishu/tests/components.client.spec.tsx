// @vitest-environment jsdom
/** The connection section, title tag, activation guidance, and notices render the Host view the page mirrors. */
import type { ComponentProps } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { PluginPackageRef, PluginsSubject } from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import { afterEach, expect, it, vi } from 'vitest'
import type { ConnectionSnapshot } from '../src/client/connection.ts'
import { zh } from '../src/client/locales.ts'
import {
  FeishuConnectionActivation, FeishuConnectionBadge, FeishuConnectionSection, FeishuConnectionToast,
} from '../src/client/FeishuConnection.tsx'
import type { FeishuOperationId, FeishuState } from '@deepseek-ai/dsh-feishu-cli/types'

afterEach(cleanup)

const OP = 'op' as FeishuOperationId

function fixture(feishu?: FeishuState) {
  const state = createSnapshotStore<ConnectionSnapshot>({ feishu, linked: true, stopped: false, busy: false, notice: undefined })
  const face = {
    useFeishuConnection: bindSnapshotSelector(state),
    check: vi.fn(), linkApp: vi.fn(), signIn: vi.fn(), cancel: vi.fn(), signOut: vi.fn(),
    openAuthorization: vi.fn(), retry: vi.fn(), dismissNotice: vi.fn(),
    t: makeTranslate(zh),
  }
  return { face, set: (change: Partial<ConnectionSnapshot>) => { act(() => { state.set({ ...state.getSnapshot(), ...change }) }) } }
}

const button = (name: string) => screen.getByRole('button', { name })
const text = (key: keyof typeof zh, values: Record<string, string> = {}) =>
  Object.entries(values).reduce((value, [name, replacement]) => value.replace(`{${name}}`, replacement), zh[key])

it('offers the next step for each state', () => {
  const b = fixture({ account: { state: 'unconfigured' } })
  render(<FeishuConnectionSection {...b.face} />)
  expect(screen.getByText(zh['detail.no-app'])).toBeTruthy()
  expect(screen.getByText(zh.hint)).toBeTruthy()
  fireEvent.click(button(zh['action.linkApp']))
  expect(b.face.linkApp).toHaveBeenCalledOnce()

  b.set({ feishu: { account: { state: 'unconfigured' }, operation: { id: OP, kind: 'link-app', phase: 'configuring' } } })
  expect(screen.getByText(zh['step.configuring'])).toBeTruthy()
  expect(screen.queryByRole('button', { name: zh['action.open'] })).toBeNull()
  b.set({ feishu: { account: { state: 'signed-out' } } })
  expect(screen.getByText(zh['detail.signed-out'])).toBeTruthy()
  fireEvent.click(button(zh['action.signIn']))
  expect(b.face.signIn).toHaveBeenCalledOnce()

  b.set({ feishu: { account: { state: 'signed-out' }, operation: { id: OP, kind: 'sign-in', phase: 'authorizing', authorizationUrl: 'https://x.feishu.cn' } } })
  expect(screen.getByText(zh['detail.authorizing'])).toBeTruthy()
  fireEvent.click(button(zh['action.open']))
  fireEvent.click(button(zh['action.cancel']))
  expect(b.face.openAuthorization).toHaveBeenCalledOnce()
  expect(b.face.cancel).toHaveBeenCalledOnce()

  b.set({ feishu: { account: { state: 'signed-out' }, operation: { id: OP, kind: 'sign-out', phase: 'signing-out', authorizationUrl: 'https://x.feishu.cn' } } })
  expect(screen.getByText(zh['step.signing-out'])).toBeTruthy()
  expect(screen.queryByRole('button', { name: zh['action.cancel'] })).toBeNull()
  expect(document.querySelector('[data-feishu-connection="connecting"] p')?.textContent).toBe(zh.hint)

  b.set({ feishu: { account: { state: 'signed-out' }, result: { id: OP, kind: 'sign-in', outcome: 'failed' } } })
  expect(screen.getByRole('alert').textContent).toBe(zh.failed)

  b.set({ feishu: { account: { state: 'unverified' } } })
  expect(screen.getByText(zh['detail.unavailable'])).toBeTruthy()
  fireEvent.click(button(zh['action.retry']))
  expect(b.face.check).toHaveBeenCalledOnce()

  b.set({ feishu: undefined })
  expect(screen.getByText(zh['status.checking'])).toBeTruthy()
  expect(screen.queryAllByRole('button')).toHaveLength(0)
})

it('explains a stopped Host component and retries even while the stream is offline', () => {
  const b = fixture(undefined)
  render(<FeishuConnectionSection {...b.face} />)
  b.set({ linked: false, stopped: true })
  expect(screen.getByText(zh['status.stopped'])).toBeTruthy()
  expect(screen.getByText(zh['detail.stopped'])).toBeTruthy()
  fireEvent.click(button(zh['action.retry']))
  expect(b.face.retry).toHaveBeenCalledOnce()
  b.set({ busy: true })
  expect((button(zh['action.retry']) as HTMLButtonElement).disabled).toBe(true)
})

it('shows who is signed in and signs out only after confirmation', () => {
  const b = fixture({ account: { state: 'connected', userName: '张三' } })
  render(<FeishuConnectionSection {...b.face} />)
  expect(screen.getByText(text('detail.connectedAs', { name: '张三' }))).toBeTruthy()
  b.set({ feishu: { account: { state: 'connected' } } })
  expect(screen.getByText(zh['detail.connected'])).toBeTruthy()
  fireEvent.click(button(zh['action.signOut']))
  expect(screen.getByText(zh['signOut.body'])).toBeTruthy()
  fireEvent.click(button(zh['action.cancel']))
  fireEvent.click(button(zh['action.signOut']))
  fireEvent.click(button(zh.close))
  expect(b.face.signOut).not.toHaveBeenCalled()
  fireEvent.click(button(zh['action.signOut']))
  fireEvent.click(screen.getAllByRole('button', { name: zh['action.signOut'] }).at(-1)!)
  expect(b.face.signOut).toHaveBeenCalledOnce()
})

it('explains ungranted permissions and grants more through another sign-in', () => {
  const b = fixture({ account: { state: 'connected', userName: '张三', ungrantedPermissions: 4 } })
  render(<FeishuConnectionSection {...b.face} />)
  expect(screen.getByText(text('detail.ungranted', { count: '4' }))).toBeTruthy()
  fireEvent.click(button(zh['action.grantMore']))
  expect(b.face.signIn).toHaveBeenCalledOnce()
  b.set({ feishu: { account: { state: 'connected', userName: '张三' } } })
  expect(screen.queryByRole('button', { name: zh['action.grantMore'] })).toBeNull()
})

it('disables actions while one is pending or the Host stream is offline', () => {
  const b = fixture({ account: { state: 'unconfigured' } })
  render(<FeishuConnectionSection {...b.face} />)
  b.set({ busy: true })
  expect(button(zh['action.linkApp']).hasAttribute('disabled')).toBe(true)
  b.set({ busy: false, linked: false })
  expect(button(zh['action.linkApp']).hasAttribute('disabled')).toBe(true)
})

it('tags only the enabled Feishu bundle', () => {
  const b = fixture({ account: { state: 'connected' } })
  const pkg = (name: string, enabled = true): PluginPackageRef => ({ name, installed: true, availability: 'profile', official: false, enabled, rows: [] })
  const badge = (subject: PluginsSubject) =>
    <FeishuConnectionBadge {...{ ...b.face, subject } as ComponentProps<typeof FeishuConnectionBadge>} />
  const { rerender } = render(badge({ kind: 'bundle', pkg: pkg('@deepseek-ai/dsh-feishu') }))
  expect(screen.getByText(zh['badge.connected'])).toBeTruthy()
  b.set({ feishu: { account: { state: 'unverified' } } })
  expect(screen.getByText(zh['badge.unavailable'])).toBeTruthy()
  b.set({ feishu: undefined })
  expect(document.body.textContent).toBe('')
  b.set({ feishu: { account: { state: 'signed-out' } } })
  rerender(badge({ kind: 'bundle', pkg: pkg('@deepseek-ai/dsh-feishu', false) }))
  expect(document.body.textContent).toBe('')
  rerender(badge({ kind: 'bundle', pkg: pkg('@acme/other') }))
  expect(document.body.textContent).toBe('')
  rerender(badge({ kind: 'item', id: 'shell' }))
  expect(document.body.textContent).toBe('')
})

it.each<[string, FeishuState, 'linkApp' | 'signIn']>([
  ['links an app first', { account: { state: 'unconfigured' } }, 'linkApp'],
  ['signs in to a linked app', { account: { state: 'signed-out' } }, 'signIn'],
])('guides a newly enabled bundle to its next step: %s, and steps aside once connected', (_name, state, step) => {
  const b = fixture()
  const onDismiss = vi.fn(), onOpenDetails = vi.fn()
  const props = { ...b.face, packageName: '@deepseek-ai/dsh-feishu', onDismiss, onOpenDetails } as ComponentProps<typeof FeishuConnectionActivation>
  render(<FeishuConnectionActivation {...props} />)
  expect(screen.queryByText(zh['activation.body'])).toBeNull()
  b.set({ feishu: state })
  fireEvent.click(button(zh['action.connect']))
  expect(onOpenDetails).toHaveBeenCalledOnce()
  expect(b.face[step]).toHaveBeenCalledOnce()
  expect(onDismiss).not.toHaveBeenCalled()
  b.set({ feishu: { account: { state: 'connected' } } })
  expect(onDismiss).toHaveBeenCalledOnce()
})

it('reports the latest notice', () => {
  const b = fixture()
  render(<FeishuConnectionToast {...b.face} />)
  expect(document.body.textContent).toBe('')
  b.set({ notice: { seq: 1, kind: 'signed-out' } })
  expect(screen.getByText(zh['notice.signed-out'])).toBeTruthy()
  b.set({ notice: { seq: 2, kind: 'action-failed' } })
  expect(screen.getByText(zh['notice.action-failed'])).toBeTruthy()
  b.set({ notice: { seq: 3, kind: 'connected-partially' } })
  expect(screen.getByText(zh['notice.connected-partially'])).toBeTruthy()
})
