// @vitest-environment jsdom
/** The connection section, title tag, activation guidance, and notices render the Host view the page mirrors. */
import type { ComponentProps } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { PluginPackageRef, PluginsSubject } from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import { afterEach, expect, it, vi } from 'vitest'
import type { ConnectionSnapshot } from '../src/client/connection.ts'
import { en, zh } from '../src/client/locales.ts'
import {
  FeishuConnectionActivation, FeishuConnectionBadge, FeishuConnectionSection, FeishuConnectionToast,
} from '../src/client/FeishuConnection.tsx'
import type { CliOperationId } from '@deepseek-ai/dsh-cli-account/types'
import type { FeishuAppId, FeishuState } from '@deepseek-ai/dsh-feishu-cli/types'

afterEach(cleanup)

const OP = 'op' as CliOperationId
const APP = 'cli_a' as FeishuAppId

function fixture(view?: FeishuState, copy: typeof zh = zh) {
  const state = createSnapshotStore<ConnectionSnapshot>({ view, linked: true, stopped: false, busy: false, notice: undefined })
  const face = {
    useFeishuConnection: bindSnapshotSelector(state),
    check: vi.fn(), linkApp: vi.fn(), signIn: vi.fn(), cancel: vi.fn(), signOut: vi.fn(),
    openAuthorization: vi.fn(), retry: vi.fn(), dismissNotice: vi.fn(),
    t: makeTranslate(copy),
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

  b.set({ view: { account: { state: 'unconfigured' }, operation: { id: OP, kind: 'link-app', phase: 'configuring', cancellable: true } } })
  expect(screen.getByText(zh['step.configuring'])).toBeTruthy()
  expect(screen.queryByRole('button', { name: zh['action.open'] })).toBeNull()
  b.set({ view: { account: { state: 'signed-out', appId: APP } } })
  expect(screen.getByText(zh['detail.signed-out'])).toBeTruthy()
  fireEvent.click(button(zh['action.signIn']))
  expect(b.face.signIn).toHaveBeenCalledOnce()

  b.set({ view: { account: { state: 'signed-out', appId: APP }, operation: { id: OP, kind: 'sign-in', phase: 'authorizing', cancellable: true, authorizationUrl: 'https://x.feishu.cn' } } })
  expect(screen.getByText(zh['detail.authorizing'])).toBeTruthy()
  fireEvent.click(button(zh['action.open']))
  fireEvent.click(button(zh['action.cancel']))
  expect(b.face.openAuthorization).toHaveBeenCalledOnce()
  expect(b.face.cancel).toHaveBeenCalledOnce()

  b.set({ view: { account: { state: 'signed-out', appId: APP }, operation: { id: OP, kind: 'sign-out', phase: 'signing-out', cancellable: false, authorizationUrl: 'https://x.feishu.cn' } } })
  expect(screen.getByText(zh['step.signing-out'])).toBeTruthy()
  expect(screen.queryByRole('button', { name: zh['action.cancel'] })).toBeNull()
  expect(document.querySelector('[data-cli-account="connecting"] p')?.textContent).toBe(zh.hint)

  b.set({ view: { account: { state: 'signed-out', appId: APP }, result: { id: OP, kind: 'sign-in', outcome: 'failed' } } })
  expect(screen.getByRole('alert').textContent).toBe(zh.failed)

  b.set({ view: { account: { state: 'unverified', appId: APP } } })
  expect(screen.getByText(zh['detail.unavailable'])).toBeTruthy()
  fireEvent.click(button(zh['action.retry']))
  expect(b.face.check).toHaveBeenCalledOnce()

  b.set({ view: undefined })
  expect(screen.getByText(zh['status.checking'])).toBeTruthy()
  expect(screen.queryAllByRole('button')).toHaveLength(0)
})

it.each([['zh', zh], ['en', en]] as const)('reports app-link recovery and safe diagnostics in %s', async (locale, copy) => {
  const b = fixture({
    account: { state: 'unconfigured' },
    result: {
      id: OP, kind: 'link-app', outcome: 'failed',
      failure: { command: 'config-init', exitCode: 1, type: 'internal', subtype: 'sdk_error' },
    },
  }, copy)
  render(<FeishuConnectionSection {...b.face} />)
  expect(button(copy['action.linkApp'])).toBeTruthy()
  await expect(`${screen.getByRole('alert').textContent}\n`).toMatchFileSnapshot(`./expected/link-app-failed-${locale}.txt`)

  b.set({ view: { account: { state: 'signed-out', appId: APP }, result: {
    id: OP, kind: 'link-app', outcome: 'failed', failure: { command: 'auth-status', exitCode: null },
  } } })
  expect(button(copy['action.signIn'])).toBeTruthy()
  expect(screen.getByRole('alert').textContent).toBe(`${copy['failed.linkApp']} ${copy['failure.details'].replace('{details}', 'auth-status')}`)

  b.set({ view: { account: { state: 'unconfigured' }, result: { id: OP, kind: 'link-app', outcome: 'failed' } } })
  expect(screen.getByRole('alert').textContent).toBe(copy['failed.linkApp'])
  b.set({ view: { account: { state: 'unconfigured' }, result: { id: OP, kind: 'link-app', outcome: 'cancelled' } } })
  expect(screen.queryByRole('alert')).toBeNull()
})

it.each(['sign-in', 'sign-out', 'check'] as const)('keeps the generic notice for a failed %s', (kind) => {
  const b = fixture({ account: { state: 'signed-out', appId: APP }, result: { id: OP, kind, outcome: 'failed' } })
  render(<FeishuConnectionSection {...b.face} />)
  expect(screen.getByRole('alert').textContent).toBe(zh.failed)
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
  const b = fixture({ account: { state: 'connected', appId: APP, userName: '张三' } })
  render(<FeishuConnectionSection {...b.face} />)
  expect(screen.getByText(text('detail.connectedAs', { name: '张三' }))).toBeTruthy()
  b.set({ view: { account: { state: 'connected', appId: APP } } })
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

it('shows the linked app and changes it only after confirmation', () => {
  const b = fixture({ account: { state: 'unconfigured' } })
  render(<FeishuConnectionSection {...b.face} />)
  expect(screen.queryByRole('button', { name: zh['action.replaceApp'] })).toBeNull()
  b.set({ view: { account: { state: 'signed-out', appId: APP } } })
  expect(screen.getByText(text('app.linked', { id: 'cli_a' }))).toBeTruthy()
  fireEvent.click(button(zh['action.replaceApp']))
  expect(screen.getByText(zh['replaceApp.body'])).toBeTruthy()
  fireEvent.click(button(zh['action.cancel']))
  fireEvent.click(button(zh['action.replaceApp']))
  fireEvent.click(button(zh.close))
  expect(b.face.linkApp).not.toHaveBeenCalled()
  fireEvent.click(button(zh['action.replaceApp']))
  fireEvent.click(screen.getAllByRole('button', { name: zh['action.replaceApp'] }).at(-1)!)
  expect(b.face.linkApp).toHaveBeenCalledOnce()
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
  const b = fixture({ account: { state: 'connected', appId: APP } })
  const pkg = (name: string, enabled = true): PluginPackageRef => ({ name, installed: true, availability: 'profile', official: false, enabled, rows: [] })
  const badge = (subject: PluginsSubject) =>
    <FeishuConnectionBadge {...{ ...b.face, subject } as ComponentProps<typeof FeishuConnectionBadge>} />
  const { rerender } = render(badge({ kind: 'bundle', pkg: pkg('@deepseek-ai/dsh-feishu') }))
  expect(screen.getByText(zh['badge.connected'])).toBeTruthy()
  b.set({ view: { account: { state: 'unverified', appId: APP } } })
  expect(screen.getByText(zh['badge.unavailable'])).toBeTruthy()
  b.set({ view: undefined })
  expect(document.body.textContent).toBe('')
  b.set({ view: { account: { state: 'signed-out', appId: APP } } })
  rerender(badge({ kind: 'bundle', pkg: pkg('@deepseek-ai/dsh-feishu', false) }))
  expect(document.body.textContent).toBe('')
  rerender(badge({ kind: 'bundle', pkg: pkg('@acme/other') }))
  expect(document.body.textContent).toBe('')
  rerender(badge({ kind: 'item', id: 'shell' }))
  expect(document.body.textContent).toBe('')
})

it.each<[string, FeishuState, 'linkApp' | 'signIn']>([
  ['links an app first', { account: { state: 'unconfigured' } }, 'linkApp'],
  ['signs in to a linked app', { account: { state: 'signed-out', appId: APP } }, 'signIn'],
])('guides a newly enabled bundle to its next step: %s, and steps aside once connected', (_name, state, step) => {
  const b = fixture()
  const onDismiss = vi.fn(), onOpenDetails = vi.fn()
  const props = { ...b.face, packageName: '@deepseek-ai/dsh-feishu', onDismiss, onOpenDetails } as ComponentProps<typeof FeishuConnectionActivation>
  render(<FeishuConnectionActivation {...props} />)
  expect(screen.queryByText(zh['activation.body'])).toBeNull()
  b.set({ view: state })
  fireEvent.click(button(zh['action.connect']))
  expect(onOpenDetails).toHaveBeenCalledOnce()
  expect(b.face[step]).toHaveBeenCalledOnce()
  expect(onDismiss).not.toHaveBeenCalled()
  b.set({ view: { account: { state: 'connected', appId: APP } } })
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
})
