// @vitest-environment jsdom
/** The authorization section, title tag, activation guidance, and notices render the Host view the page mirrors. */
import type { ComponentProps } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { CliOperationId } from '@deepseek-ai/dsh-cli-account/types'
import type { PluginPackageRef, PluginsSubject } from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type { WecomState } from '@deepseek-ai/dsh-wecom-cli/types'
import { afterEach, expect, it, vi } from 'vitest'
import type { ConnectionSnapshot } from '../src/client/connection.ts'
import { en, zh } from '../src/client/locales.ts'
import {
  WecomConnectionActivation, WecomConnectionBadge, WecomConnectionSection, WecomConnectionToast,
} from '../src/client/WecomConnection.tsx'

afterEach(cleanup)

const OP = 'op' as CliOperationId
const QR = 'https://work.weixin.qq.com/qr'

function fixture(view?: WecomState, copy: typeof zh = zh) {
  const state = createSnapshotStore<ConnectionSnapshot>({ view, linked: true, stopped: false, busy: false, notice: undefined })
  const face = {
    useWecomConnection: bindSnapshotSelector(state),
    check: vi.fn(), connect: vi.fn(), cancel: vi.fn(),
    openAuthorization: vi.fn(), retry: vi.fn(), dismissNotice: vi.fn(),
    t: makeTranslate(copy),
  }
  return { face, set: (change: Partial<ConnectionSnapshot>) => { act(() => { state.set({ ...state.getSnapshot(), ...change }) }) } }
}

const button = (name: string) => screen.getByRole('button', { name })

it('offers the next step for each state', () => {
  const b = fixture({ account: { state: 'unauthorized' } })
  render(<WecomConnectionSection {...b.face} />)
  expect(screen.getByText(zh['detail.disconnected'])).toBeTruthy()
  expect(screen.getByText(zh.hint)).toBeTruthy()
  fireEvent.click(button(zh['action.connect']))
  expect(b.face.connect).toHaveBeenCalledOnce()

  b.set({ view: { account: { state: 'unauthorized' }, operation: { id: OP, kind: 'connect', phase: 'authorizing', cancellable: true } } })
  expect(screen.getByText(zh['step.authorizing'])).toBeTruthy()
  expect(screen.queryByRole('button', { name: zh['action.open'] })).toBeNull()
  b.set({ view: { account: { state: 'unauthorized' }, operation: { id: OP, kind: 'connect', phase: 'authorizing', cancellable: true, authorizationUrl: QR } } })
  expect(screen.getByText(zh['detail.authorizing'])).toBeTruthy()
  fireEvent.click(button(zh['action.open']))
  fireEvent.click(button(zh['action.cancel']))
  expect(b.face.openAuthorization).toHaveBeenCalledOnce()
  expect(b.face.cancel).toHaveBeenCalledOnce()

  b.set({ view: { account: { state: 'unauthorized' }, operation: { id: OP, kind: 'connect', phase: 'checking', cancellable: false } } })
  expect(screen.getByText(zh['step.connecting'])).toBeTruthy()
  expect(screen.queryAllByRole('button')).toHaveLength(0)

  b.set({ view: { account: { state: 'authorized' } } })
  expect(screen.getByText(zh['detail.connected'])).toBeTruthy()
  expect(screen.queryAllByRole('button')).toHaveLength(0)

  b.set({ view: undefined })
  expect(screen.getByText(zh['status.checking'])).toBeTruthy()
  expect(screen.queryAllByRole('button')).toHaveLength(0)
})

it.each([['zh', zh], ['en', en]] as const)('reports a failed connection with its command and exit code in %s', (_locale, copy) => {
  const b = fixture({ account: { state: 'unauthorized' }, result: { id: OP, kind: 'connect', outcome: 'failed', failure: { command: 'auth-init', exitCode: 2 } } }, copy)
  render(<WecomConnectionSection {...b.face} />)
  const details = copy['failure.details'].replace('{details}', `auth-init · ${copy['failure.exitCode'].replace('{code}', '2')}`)
  expect(screen.getByRole('alert').textContent).toBe(`${copy.failed} ${details}`)
  expect(button(copy['action.connect'])).toBeTruthy()

  b.set({ view: { account: { state: 'unauthorized' }, result: { id: OP, kind: 'connect', outcome: 'cancelled' } } })
  expect(screen.queryByRole('alert')).toBeNull()
})

it('retries an unreadable authorization by checking again', () => {
  const b = fixture({ account: { state: 'unchecked' }, result: { id: OP, kind: 'check', outcome: 'failed', failure: { command: 'auth-status', exitCode: 1 } } })
  render(<WecomConnectionSection {...b.face} />)
  expect(screen.getByText(zh['detail.unavailable'])).toBeTruthy()
  fireEvent.click(button(zh['action.retry']))
  expect(b.face.check).toHaveBeenCalledOnce()
})

it('explains a stopped Host component and retries even while the stream is offline', () => {
  const b = fixture(undefined)
  render(<WecomConnectionSection {...b.face} />)
  b.set({ linked: false, stopped: true })
  expect(screen.getByText(zh['status.stopped'])).toBeTruthy()
  expect(screen.getByText(zh['detail.stopped'])).toBeTruthy()
  fireEvent.click(button(zh['action.retry']))
  expect(b.face.retry).toHaveBeenCalledOnce()
})

it('tags only the enabled WeCom bundle', () => {
  const b = fixture({ account: { state: 'authorized' } })
  const pkg = (name: string, enabled = true): PluginPackageRef => ({ name, installed: true, availability: 'profile', official: false, enabled, rows: [] })
  const badge = (subject: PluginsSubject) =>
    <WecomConnectionBadge {...{ ...b.face, subject } as ComponentProps<typeof WecomConnectionBadge>} />
  const { rerender } = render(badge({ kind: 'bundle', pkg: pkg('@deepseek-ai/dsh-wecom') }))
  expect(screen.getByText(zh['badge.connected'])).toBeTruthy()
  b.set({ view: { account: { state: 'unauthorized' } } })
  expect(screen.getByText(zh['badge.disconnected'])).toBeTruthy()
  rerender(badge({ kind: 'bundle', pkg: pkg('@acme/other') }))
  expect(document.body.textContent).toBe('')
})

it('guides a newly enabled bundle to connect, and steps aside once authorized', () => {
  const b = fixture()
  const onDismiss = vi.fn(), onOpenDetails = vi.fn()
  const props = { ...b.face, packageName: '@deepseek-ai/dsh-wecom', onDismiss, onOpenDetails } as ComponentProps<typeof WecomConnectionActivation>
  render(<WecomConnectionActivation {...props} />)
  expect(screen.queryByText(zh['activation.body'])).toBeNull()
  b.set({ view: { account: { state: 'unauthorized' } } })
  fireEvent.click(button(zh['action.connect']))
  expect(onOpenDetails).toHaveBeenCalledOnce()
  expect(b.face.connect).toHaveBeenCalledOnce()
  b.set({ view: { account: { state: 'authorized' } } })
  expect(onDismiss).toHaveBeenCalledOnce()
})

it('reports the latest notice', () => {
  const b = fixture()
  render(<WecomConnectionToast {...b.face} />)
  expect(document.body.textContent).toBe('')
  b.set({ notice: { seq: 1, kind: 'connected' } })
  expect(screen.getByText(zh['notice.connected'])).toBeTruthy()
})
