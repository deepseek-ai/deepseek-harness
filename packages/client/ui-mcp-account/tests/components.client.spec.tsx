// @vitest-environment jsdom
/** The account surfaces render the Host entry with the connector's text and this package's shared copy. */
import type { ComponentProps } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { McpManagedServerStatus, McpManagedServerView } from '@deepseek-ai/dsh-api-remotes/client'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { PluginPackageRef, PluginsSubject } from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type { McpOAuthAttemptId, McpOAuthAttemptView } from '@deepseek-ai/dsh-mcp-client/types'
import type { LocalizedText } from '@deepseek-ai/dsh-package-manifest'
import { afterEach, expect, it, vi } from 'vitest'
import { McpAccountActivation, McpAccountBadge, McpAccountSection, McpAccountToast } from '../src/client/McpAccount.tsx'
import type { McpAccountSnapshot } from '../src/client/types.ts'
import type { McpAccountCopy } from '../src/types.ts'

afterEach(cleanup)

const MISSING: McpManagedServerStatus = { state: 'waiting-authorization', reason: 'missing', lastError: 'x' }
const CONNECTED: McpManagedServerStatus = { state: 'connected', toolCount: 1, connectedAt: 1 }
const PACKAGE = '@acme/docs'
const zh = (text: string): LocalizedText => ({ en: `en ${text}`, zh: text })

const COPY: McpAccountCopy = {
  title: zh('Docs 账号'), connect: zh('连接 Docs'),
  activation: { title: zh('连接 Docs？'), body: zh('Docs 已开启。') },
  detail: {
    disconnected: zh('尚未连接 Docs。'), waitingBrowser: zh('在浏览器中完成授权。'), authorizing: zh('正在授权。'),
    connecting: zh('正在连接 Docs。'), connected: zh('已连接 Docs。'), rejected: zh('Docs 拒绝了授权。'), scope: zh('Docs 需要更多权限。'),
  },
  signOut: { title: zh('退出 Docs？'), body: zh('将删除授权。') },
  notice: { connected: zh('Docs 已连接'), signedOut: zh('已退出 Docs') },
}

function server(status: McpManagedServerStatus, phase?: McpOAuthAttemptView['phase'], authorizationUrl?: string): McpManagedServerView {
  return {
    name: 'docs', configured: true, status,
    ...phase === undefined ? {} : { authorization: { id: 'a' as McpOAuthAttemptId, phase, ...authorizationUrl === undefined ? {} : { authorizationUrl } } },
  }
}

interface Change extends Partial<Omit<McpAccountSnapshot, 'entry'>> {
  readonly view?: McpManagedServerView | undefined
}

function snapshot({ view, ...change }: Change): McpAccountSnapshot {
  const entry = { server: 'docs', packageName: PACKAGE, copy: COPY, ...view === undefined ? {} : { view } }
  return { entry, linked: true, busy: false, notice: undefined, ...change }
}

function fixture(initial: Change = {}) {
  let current = initial
  const state = createSnapshotStore<McpAccountSnapshot>(snapshot(initial))
  const face = {
    packageName: PACKAGE,
    useMcpAccount: bindSnapshotSelector(state),
    resolveText: (text: LocalizedText) => typeof text === 'string' ? text : text.zh ?? text.en,
    connect: vi.fn(), cancel: vi.fn(), signOut: vi.fn(), retry: vi.fn(), openAuthorization: vi.fn(), dismissNotice: vi.fn(),
    t: makeTranslate(),
  }
  return {
    state, face,
    set(change: Change) {
      current = { ...current, ...change }
      act(() => { state.set(snapshot(current)) })
    },
  }
}

const button = (name: string) => screen.getByRole('button', { name })

it('offers the next step for each connection state with the connector\'s text', () => {
  const b = fixture({ view: server(MISSING) })
  const { container } = render(<McpAccountSection {...b.face} />)
  expect(screen.getByText('Docs 账号')).toBeTruthy()
  expect(screen.getByText('status.disconnected')).toBeTruthy()
  expect(screen.getByText('尚未连接 Docs。')).toBeTruthy()
  expect(screen.getByText('hostBrowser')).toBeTruthy()
  expect(container.querySelector('[data-mcp-account="disconnected"][data-mcp-account-package="@acme/docs"]')).toBeTruthy()
  fireEvent.click(button('连接 Docs'))
  expect(b.face.connect).toHaveBeenCalledOnce()

  b.set({ view: server(MISSING, 'waiting-browser', 'https://docs.test') })
  expect(screen.getByText('在浏览器中完成授权。')).toBeTruthy()
  fireEvent.click(button('action.open'))
  fireEvent.click(button('action.cancel'))
  expect(b.face.openAuthorization).toHaveBeenCalledOnce()
  expect(b.face.cancel).toHaveBeenCalledOnce()

  b.set({ view: server(MISSING, 'exchanging') })
  expect(screen.getByText('正在授权。')).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'action.open' })).toBeNull()
  fireEvent.click(button('action.cancel'))
  expect(b.face.cancel).toHaveBeenCalledTimes(2)

  b.set({ view: server(MISSING, 'failed') })
  expect(screen.getByRole('alert').textContent).toBe('failed')

  b.set({ view: server({ state: 'waiting-authorization', reason: 'scope', lastError: 'x' }) })
  expect(screen.getByText('Docs 需要更多权限。')).toBeTruthy()
  fireEvent.click(button('action.reconnect'))
  expect(b.face.connect).toHaveBeenCalledTimes(2)
  b.set({ view: server({ state: 'waiting-authorization', reason: 'rejected', lastError: 'x' }) })
  expect(screen.getByText('Docs 拒绝了授权。')).toBeTruthy()
  b.set({ view: server({ state: 'waiting-authorization', reason: 'expired', lastError: 'x' }) })
  expect(screen.getByText('detail.reconnect.expired')).toBeTruthy()

  b.set({ view: server({ state: 'failed', reason: 'gave-up' }) })
  expect(screen.getByText('detail.unavailable')).toBeTruthy()
  fireEvent.click(button('action.retry'))
  expect(b.face.retry).toHaveBeenCalledOnce()

  // Only a Host restart recovers incomplete cleanup, so the page offers no retry.
  b.set({ view: server({ state: 'failed', reason: 'cleanup', result: { closeConfirmed: false } }) })
  expect(screen.queryAllByRole('button')).toHaveLength(0)

  b.set({ view: server({ state: 'connecting', attempt: 0 }) })
  expect(screen.getByText('正在连接 Docs。')).toBeTruthy()
  expect(screen.queryAllByRole('button')).toHaveLength(0)

  b.set({ view: undefined })
  expect(screen.getByText('status.checking')).toBeTruthy()
  expect(document.querySelector('[data-mcp-account="checking"] p')?.textContent).toBe('hostBrowser')
})

it('disables actions while one is pending or the Host stream is offline', () => {
  const b = fixture({ view: server(MISSING), busy: true })
  render(<McpAccountSection {...b.face} />)
  expect(button('连接 Docs').hasAttribute('disabled')).toBe(true)
  b.set({ busy: false, linked: false })
  expect(button('连接 Docs').hasAttribute('disabled')).toBe(true)
  b.set({ linked: true })
  expect(button('连接 Docs').hasAttribute('disabled')).toBe(false)
})

it('signs out only after the connector\'s confirmation', () => {
  const b = fixture({ view: server(CONNECTED) })
  render(<McpAccountSection {...b.face} />)
  expect(screen.getByText('已连接 Docs。')).toBeTruthy()
  fireEvent.click(button('action.signOut'))
  expect(screen.getByText('退出 Docs？')).toBeTruthy()
  expect(screen.getByText('将删除授权。')).toBeTruthy()
  fireEvent.click(button('action.cancel'))
  expect(b.face.signOut).not.toHaveBeenCalled()
  fireEvent.click(button('action.signOut'))
  fireEvent.click(button('close'))
  expect(screen.queryByText('将删除授权。')).toBeNull()
  fireEvent.click(button('action.signOut'))
  fireEvent.click(screen.getAllByRole('button', { name: 'action.signOut' }).at(-1)!)
  expect(b.face.signOut).toHaveBeenCalledOnce()
})

it('tags only the enabled bundle of its package', () => {
  const b = fixture({ view: server(CONNECTED) })
  const pkg = (name: string, enabled = true): PluginPackageRef => ({ name, installed: true, availability: 'profile', official: false, enabled, rows: [] })
  const badge = (subject: PluginsSubject) =>
    <McpAccountBadge {...{ ...b.face, subject } as ComponentProps<typeof McpAccountBadge>} />
  const { rerender } = render(badge({ kind: 'bundle', pkg: pkg(PACKAGE) }))
  expect(screen.getByText('badge.connected')).toBeTruthy()
  b.set({ view: server(MISSING, 'waiting-browser') })
  expect(screen.getByText('badge.connecting')).toBeTruthy()
  b.set({ view: undefined })
  expect(document.body.textContent).toBe('')
  b.set({ view: server(MISSING) })
  rerender(badge({ kind: 'bundle', pkg: pkg(PACKAGE, false) }))
  expect(document.body.textContent).toBe('')
  rerender(badge({ kind: 'bundle', pkg: pkg('@acme/other') }))
  expect(document.body.textContent).toBe('')
  rerender(badge({ kind: 'item', id: 'shell' }))
  expect(document.body.textContent).toBe('')
  rerender(badge({ kind: 'row', pkg: pkg(PACKAGE), row: { rowId: 'docs', moduleName: PACKAGE, enabled: true } }))
  expect(document.body.textContent).toBe('')
})

it('guides a newly enabled bundle to connect with the connector\'s prompt, and steps aside once connected', () => {
  const b = fixture()
  const onDismiss = vi.fn(), onOpenDetails = vi.fn()
  const props = { ...b.face, onDismiss, onOpenDetails } as ComponentProps<typeof McpAccountActivation>
  render(<McpAccountActivation {...props} />)
  expect(screen.queryByText('Docs 已开启。')).toBeNull()
  expect(onDismiss).not.toHaveBeenCalled()
  // A first connection attempt is still settling; the guidance waits for its outcome.
  b.set({ view: server({ state: 'connecting', attempt: 0 }) })
  expect(onDismiss).not.toHaveBeenCalled()
  b.set({ view: server(MISSING) })
  expect(screen.getByText('连接 Docs？')).toBeTruthy()
  expect(screen.getByText('Docs 已开启。')).toBeTruthy()
  fireEvent.click(button('activation.later'))
  expect(onDismiss).toHaveBeenCalledOnce()
  fireEvent.click(button('连接 Docs'))
  expect(onOpenDetails).toHaveBeenCalledOnce()
  expect(b.face.connect).toHaveBeenCalledOnce()
  b.set({ view: server(CONNECTED) })
  expect(onDismiss).toHaveBeenCalledTimes(2)
})

it('reports the latest notice with the connector\'s text and leaves dismissal to the toast', () => {
  const b = fixture()
  render(<McpAccountToast {...b.face} />)
  expect(document.body.textContent).toBe('')
  b.set({ notice: { seq: 1, kind: 'connected' } })
  expect(screen.getByText('Docs 已连接')).toBeTruthy()
  b.set({ notice: { seq: 2, kind: 'signed-out' } })
  expect(screen.getByText('已退出 Docs')).toBeTruthy()
  b.set({ notice: { seq: 3, kind: 'action-failed' } })
  expect(screen.getByText('notice.action-failed')).toBeTruthy()
})
