// @vitest-environment jsdom
/** The connection section, title tag, activation guidance, and notices render the Host entry the page mirrors. */
import type { ComponentProps } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { McpManagedServerStatus, McpManagedServerView } from '@deepseek-ai/dsh-api-remotes/client'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { PluginPackageRef, PluginsSubject } from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type { McpOAuthAttemptId, McpOAuthAttemptView } from '@deepseek-ai/dsh-mcp-client/types'
import { afterEach, expect, it, vi } from 'vitest'
import type { ConnectionSnapshot } from '../src/client/connection.ts'
import { zh } from '../src/client/locales.ts'
import {
  NotionConnectionActivation, NotionConnectionBadge, NotionConnectionSection, NotionConnectionToast,
} from '../src/client/NotionConnection.tsx'

afterEach(cleanup)

const MISSING: McpManagedServerStatus = { state: 'waiting-authorization', reason: 'missing', lastError: 'x' }
const CONNECTED: McpManagedServerStatus = { state: 'connected', toolCount: 1, connectedAt: 1 }

function server(status: McpManagedServerStatus, phase?: McpOAuthAttemptView['phase'], authorizationUrl?: string): McpManagedServerView {
  return {
    name: 'notion', configured: true, status,
    ...phase === undefined ? {} : { authorization: { id: 'a' as McpOAuthAttemptId, phase, ...authorizationUrl === undefined ? {} : { authorizationUrl } } },
  }
}

function fixture(initial: Partial<ConnectionSnapshot> = {}) {
  const state = createSnapshotStore<ConnectionSnapshot>({ server: undefined, linked: true, busy: false, notice: undefined, ...initial })
  const face = {
    useNotionConnection: bindSnapshotSelector(state),
    connect: vi.fn(), cancel: vi.fn(), signOut: vi.fn(), retry: vi.fn(), openAuthorization: vi.fn(), dismissNotice: vi.fn(),
    t: makeTranslate(zh),
  }
  return { state, face, set: (change: Partial<ConnectionSnapshot>) => { act(() => { state.set({ ...state.getSnapshot(), ...change }) }) } }
}

const button = (name: string) => screen.getByRole('button', { name })

it('offers the next step for each connection state', () => {
  const b = fixture({ server: server(MISSING) })
  render(<NotionConnectionSection {...b.face} />)
  expect(screen.getByText(zh['status.disconnected'])).toBeTruthy()
  expect(screen.getByText(zh.hostBrowser)).toBeTruthy()
  fireEvent.click(button(zh['action.connect']))
  expect(b.face.connect).toHaveBeenCalledOnce()

  b.set({ server: server(MISSING, 'waiting-browser', 'https://notion.test') })
  expect(screen.getByText(zh['detail.waiting-browser'])).toBeTruthy()
  fireEvent.click(button(zh['action.open']))
  fireEvent.click(button(zh['action.cancel']))
  expect(b.face.openAuthorization).toHaveBeenCalledOnce()
  expect(b.face.cancel).toHaveBeenCalledOnce()

  b.set({ server: server(MISSING, 'exchanging') })
  expect(screen.queryByRole('button', { name: zh['action.open'] })).toBeNull()
  fireEvent.click(button(zh['action.cancel']))
  expect(b.face.cancel).toHaveBeenCalledTimes(2)

  b.set({ server: server(MISSING, 'failed') })
  expect(screen.getByRole('alert').textContent).toBe(zh.failed)

  b.set({ server: server({ state: 'waiting-authorization', reason: 'scope', lastError: 'x' }) })
  expect(screen.getByText(zh['detail.reconnect.scope'])).toBeTruthy()
  fireEvent.click(button(zh['action.reconnect']))
  expect(b.face.connect).toHaveBeenCalledTimes(2)

  b.set({ server: server({ state: 'failed', reason: 'gave-up' }) })
  fireEvent.click(button(zh['action.retry']))
  expect(b.face.retry).toHaveBeenCalledOnce()

  b.set({ server: server({ state: 'connecting', attempt: 0 }) })
  expect(screen.queryAllByRole('button')).toHaveLength(0)

  b.set({ server: undefined })
  expect(screen.getByText(zh['status.checking'])).toBeTruthy()
  expect(document.querySelector('[data-notion-connection="checking"] p')?.textContent).toBe(zh.hostBrowser)
})

it('disables actions while one is pending or the Host stream is offline', () => {
  const b = fixture({ server: server(MISSING), busy: true })
  render(<NotionConnectionSection {...b.face} />)
  expect(button(zh['action.connect']).hasAttribute('disabled')).toBe(true)
  b.set({ busy: false, linked: false })
  expect(button(zh['action.connect']).hasAttribute('disabled')).toBe(true)
  b.set({ linked: true })
  expect(button(zh['action.connect']).hasAttribute('disabled')).toBe(false)
})

it('signs out only after confirmation', () => {
  const b = fixture({ server: server(CONNECTED) })
  render(<NotionConnectionSection {...b.face} />)
  expect(screen.getByText(zh['detail.connected'])).toBeTruthy()
  fireEvent.click(button(zh['action.signOut']))
  expect(screen.getByText(zh['signOut.body'])).toBeTruthy()
  fireEvent.click(button(zh['action.cancel']))
  expect(b.face.signOut).not.toHaveBeenCalled()
  fireEvent.click(button(zh['action.signOut']))
  fireEvent.click(button(zh.close))
  expect(screen.queryByText(zh['signOut.body'])).toBeNull()
  fireEvent.click(button(zh['action.signOut']))
  fireEvent.click(screen.getAllByRole('button', { name: zh['action.signOut'] }).at(-1)!)
  expect(b.face.signOut).toHaveBeenCalledOnce()
})

it('tags only the enabled Notion bundle', () => {
  const b = fixture({ server: server(CONNECTED) })
  const pkg = (name: string, enabled = true): PluginPackageRef => ({ name, installed: true, availability: 'profile', official: false, enabled, rows: [] })
  const badge = (subject: PluginsSubject) =>
    <NotionConnectionBadge {...{ ...b.face, subject } as ComponentProps<typeof NotionConnectionBadge>} />
  const { rerender } = render(badge({ kind: 'bundle', pkg: pkg('@deepseek-ai/dsh-notion') }))
  expect(screen.getByText(zh['badge.connected'])).toBeTruthy()
  b.set({ server: server(MISSING, 'waiting-browser') })
  expect(screen.getByText(zh['badge.connecting'])).toBeTruthy()
  b.set({ server: undefined })
  expect(document.body.textContent).toBe('')
  b.set({ server: server(MISSING) })
  rerender(badge({ kind: 'bundle', pkg: pkg('@deepseek-ai/dsh-notion', false) }))
  expect(document.body.textContent).toBe('')
  rerender(badge({ kind: 'bundle', pkg: pkg('@acme/other') }))
  expect(document.body.textContent).toBe('')
  rerender(badge({ kind: 'item', id: 'shell' }))
  expect(document.body.textContent).toBe('')
})

it('guides a newly enabled bundle to connect, and steps aside once connected', () => {
  const b = fixture()
  const onDismiss = vi.fn(), onOpenDetails = vi.fn()
  const props = { ...b.face, packageName: '@deepseek-ai/dsh-notion', onDismiss, onOpenDetails } as ComponentProps<typeof NotionConnectionActivation>
  render(<NotionConnectionActivation {...props} />)
  expect(screen.queryByText(zh['activation.body'])).toBeNull()
  expect(onDismiss).not.toHaveBeenCalled()
  b.set({ server: server(MISSING) })
  fireEvent.click(button(zh['action.connect']))
  expect(onOpenDetails).toHaveBeenCalledOnce()
  expect(b.face.connect).toHaveBeenCalledOnce()
  b.set({ server: server(CONNECTED) })
  expect(onDismiss).toHaveBeenCalledOnce()
})

it('reports the latest notice and leaves dismissal to the toast', () => {
  const b = fixture()
  render(<NotionConnectionToast {...b.face} />)
  expect(document.body.textContent).toBe('')
  b.set({ notice: { seq: 1, kind: 'connected' } })
  expect(screen.getByText(zh['notice.connected'])).toBeTruthy()
  b.set({ notice: { seq: 2, kind: 'action-failed' } })
  expect(screen.getByText(zh['notice.action-failed'])).toBeTruthy()
})
