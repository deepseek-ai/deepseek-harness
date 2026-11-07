// @vitest-environment jsdom
/** The surfaces render each registrant's display from the Host with the shared copy, and buttons call the Remote directly. */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { PluginsSubject } from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type { LocalizedText } from '@deepseek-ai/dsh-package-manifest'
import { RemoteError, type RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import {
  ConnectorAccountActivation, ConnectorAccountActivationEntry, ConnectorAccountBadgeEntry, ConnectorAccountSection,
  ConnectorAccountSectionEntry, ConnectorAccountToast, ConnectorAccountToastEntry,
} from '../src/client/components.tsx'
import { zh } from '../src/client/locales.ts'
import type { ConnectorAccountsState } from '../src/client/types.ts'
import type { ConnectorAccountDisplay, ConnectorAccountEntry, ConnectorOperationId } from '../src/types.ts'

afterEach(cleanup)

const KEY = '@acme/fixture'
const OP = 'op-1' as ConnectorOperationId
const t = makeTranslate(zh)
const resolveText = (text: LocalizedText): string => typeof text === 'string' ? text : text.zh ?? text.en
const button = (name: string) => screen.getByRole('button', { name })
const disabled = (): boolean[] => screen.getAllByRole('button').map(element => (element as HTMLButtonElement).disabled)

const DISCONNECTED: ConnectorAccountDisplay = {
  phase: 'disconnected', status: { en: 'Not connected', zh: '未连接' }, badge: '未连接',
  buttons: [{ label: '连接演示', command: { kind: 'start', operation: 'connect' }, variant: 'primary' }], notes: [],
}

function entry(display: ConnectorAccountDisplay = DISCONNECTED, extra: Partial<ConnectorAccountEntry> = {}): ConnectorAccountEntry {
  return {
    key: KEY, packageName: KEY, display,
    copy: { title: { en: 'Fixture account', zh: '演示账号' }, hint: '与终端共用。', activation: { title: '连接演示', body: '插件已开启。', connect: '连接演示' } },
    ...extra,
  }
}

function section(change: Partial<{ linked: boolean; stopped: boolean; busy: boolean }> = {}, display?: ConnectorAccountDisplay) {
  const onCommand = vi.fn()
  const onRetry = vi.fn()
  const view = render(
    <ConnectorAccountSection t={t} resolveText={resolveText} entry={entry(display)} linked={change.linked ?? true}
      stopped={change.stopped ?? false} busy={change.busy ?? false} onCommand={onCommand} onRetry={onRetry} />,
  )
  return { ...view, onCommand, onRetry }
}

it('shows the registrant title, status, detail, notes, and hint, and runs each button as its command', () => {
  const display: ConnectorAccountDisplay = {
    ...DISCONNECTED, detail: '先关联一个应用。',
    notes: [{ text: '应用：cli_a', button: { label: '更换', command: { kind: 'start', operation: 'link-app' }, variant: 'ghost' } }, { text: '普通说明' }],
  }
  const { container, onCommand } = section({}, display)
  expect(screen.getByText('演示账号')).toBeTruthy()
  expect(screen.getByText('未连接')).toBeTruthy()
  expect(screen.getByText('先关联一个应用。')).toBeTruthy()
  expect(screen.getByText('普通说明')).toBeTruthy()
  expect(screen.getByText('与终端共用。')).toBeTruthy()
  expect(container.querySelector('[data-connector-account="disconnected"][data-connector-account-key="@acme/fixture"]')).toBeTruthy()
  fireEvent.click(button('连接演示'))
  fireEvent.click(button('更换'))
  expect(onCommand.mock.calls).toEqual([[{ kind: 'start', operation: 'connect' }], [{ kind: 'start', operation: 'link-app' }]])
})

it('disables the buttons while a call is pending or the Host stream is down', () => {
  const { rerender } = section({ busy: true })
  expect(disabled()).toEqual([true])
  rerender(
    <ConnectorAccountSection t={t} resolveText={resolveText} entry={entry()} linked={false} stopped={false} busy={false}
      onCommand={vi.fn()} onRetry={vi.fn()} />,
  )
  expect(disabled()).toEqual([true])
})

it('asks before a button that changes the account outside DSH and runs it only after the user accepts', () => {
  const display: ConnectorAccountDisplay = {
    phase: 'connected', status: '已连接', notes: [],
    buttons: [{ label: '退出登录', command: { kind: 'start', operation: 'sign-out' }, confirm: { title: '退出演示？', body: '终端也会退出。', label: '确认退出' } }],
  }
  const { onCommand } = section({}, display)
  fireEvent.click(button('退出登录'))
  expect(screen.getByRole('dialog', { name: '退出演示？' })).toBeTruthy()
  expect(screen.getByText('终端也会退出。')).toBeTruthy()
  fireEvent.click(button(zh['action.cancel']))
  expect(screen.queryByRole('dialog')).toBeNull()
  fireEvent.click(button('退出登录'))
  fireEvent.click(button('确认退出'))
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(onCommand.mock.calls).toEqual([[{ kind: 'start', operation: 'sign-out' }]])
})

it.each<[string, ConnectorAccountDisplay['failure'], string]>([
  ['the guidance, then its diagnostic items', { text: '失败。', details: ['login', 'exit 3', 'internal'] }, '失败。 排障信息：login · exit 3 · internal'],
  ['the guidance alone without diagnostic items', { text: '失败。' }, '失败。'],
  ['the guidance alone for an empty diagnostic list', { text: '失败。', details: [] }, '失败。'],
])('reports %s', (_name, failure, expected) => {
  section({}, { ...DISCONNECTED, ...failure === undefined ? {} : { failure } })
  expect(screen.getByRole('alert').textContent).toBe(expected)
})

it('explains a stopped stream with the shared copy and reopens it even while offline', () => {
  const { container, onRetry } = section({ stopped: true, linked: false }, { ...DISCONNECTED, failure: { text: '失败。' }, notes: [{ text: '说明' }] })
  expect(screen.getByText(zh['status.stopped'])).toBeTruthy()
  expect(screen.getByText(zh['detail.stopped'])).toBeTruthy()
  expect(screen.queryByRole('alert')).toBeNull()
  expect(screen.queryByText('说明')).toBeNull()
  expect(container.querySelector('[data-connector-account="stopped"]')).toBeTruthy()
  fireEvent.click(button(zh['action.retry']))
  expect(onRetry).toHaveBeenCalledOnce()
})

it('prompts to connect only while disconnected, waits while checking or connecting, and steps aside once settled', () => {
  const onDismiss = vi.fn()
  const onConnect = vi.fn()
  const prompt = (phase: 'checking' | 'connecting' | 'disconnected' | 'connected' | 'unavailable' | 'stopped') =>
    <ConnectorAccountActivation t={t} phase={phase} title="连接演示" body="插件已开启。" connect="立即连接" onDismiss={onDismiss} onConnect={onConnect} />
  const { rerender } = render(prompt('checking'))
  // An account still connecting after the bundle is switched on may end disconnected.
  rerender(prompt('connecting'))
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(onDismiss).not.toHaveBeenCalled()
  rerender(prompt('disconnected'))
  expect(screen.getByRole('dialog', { name: '连接演示' })).toBeTruthy()
  expect(screen.getByText('插件已开启。')).toBeTruthy()
  fireEvent.click(button('立即连接'))
  expect(onConnect).toHaveBeenCalledOnce()
  fireEvent.click(button(zh['activation.later']))
  expect(onDismiss).toHaveBeenCalledOnce()
  rerender(prompt('connected'))
  expect(onDismiss).toHaveBeenCalledTimes(2)
  rerender(prompt('unavailable'))
  rerender(prompt('stopped'))
  expect(onDismiss).toHaveBeenCalledTimes(4)
})

it('shows the latest notice with the registrant text or the shared failure copy', () => {
  const onDone = vi.fn()
  const toast = (notice: ConnectorAccountsState['notice']) =>
    <ConnectorAccountToast t={t} resolveText={resolveText} notice={notice} onDone={onDone} />
  const { rerender } = render(toast(undefined))
  expect(document.body.textContent).toBe('')
  rerender(toast({ seq: 1, kind: 'succeeded', text: { en: 'Connected', zh: '演示已连接' } }))
  expect(screen.getByText('演示已连接')).toBeTruthy()
  rerender(toast({ seq: 2, kind: 'action-failed' }))
  expect(screen.getByText(zh['notice.action-failed'])).toBeTruthy()
})

const ok = <T,>(value: T): RemoteResult<T> => ({ ok: true, value })
const refused = (): RemoteResult<never> => ({ ok: false, error: new RemoteError('gateway/internal', 'offline', {}) }) as never

function face(change: Partial<ConnectorAccountsState> = {}, accounts: readonly ConnectorAccountEntry[] = [entry()]) {
  const current: ConnectorAccountsState = {
    accounts: new Map(accounts.map(item => [item.key, item])), linked: true, stopped: false, notice: undefined, ...change,
  }
  return {
    useConnectorAccounts: <R,>(selector: (value: ConnectorAccountsState) => R): R => selector(current),
    remote: {
      start: vi.fn(async (_key: string, _operation: string) => ok(OP)),
      cancel: vi.fn(async (_key: string, _id: ConnectorOperationId): Promise<RemoteResult<void>> => ok(undefined)),
    },
    account: KEY, resolveText, follow: vi.fn(), failed: vi.fn(), retry: vi.fn(), dismissNotice: vi.fn(), t,
  }
}

it('starts an operation through the Remote, follows it, and stays busy until the call answers', async () => {
  const props = face()
  const answer = Promise.withResolvers<RemoteResult<ConnectorOperationId>>()
  props.remote.start.mockReturnValueOnce(answer.promise)
  render(<ConnectorAccountSectionEntry {...props} />)
  fireEvent.click(button('连接演示'))
  expect(props.remote.start).toHaveBeenCalledWith(KEY, 'connect')
  expect(disabled()).toEqual([true])
  await act(async () => { answer.resolve(ok(OP)) })
  expect(props.follow).toHaveBeenCalledWith(KEY, OP)
  expect(disabled()).toEqual([false])
  expect(props.failed).not.toHaveBeenCalled()
})

it('reports a start the Host refused or that never answered, without following it', async () => {
  const props = face()
  props.remote.start.mockResolvedValueOnce(refused()).mockRejectedValueOnce(new Error('carrier lost'))
  render(<ConnectorAccountSectionEntry {...props} />)
  await act(async () => { fireEvent.click(button('连接演示')) })
  await act(async () => { fireEvent.click(button('连接演示')) })
  expect(props.failed).toHaveBeenCalledTimes(2)
  expect(props.follow).not.toHaveBeenCalled()
})

it('cancels the operation in progress and opens its authorization page again on request', async () => {
  const windowOpen = vi.spyOn(window, 'open').mockReturnValue(null)
  onTestFinished(() => { windowOpen.mockRestore() })
  const display: ConnectorAccountDisplay = {
    phase: 'connecting', status: '等待浏览器', notes: [],
    buttons: [{ label: '打开授权页', command: { kind: 'open' } }, { label: '取消', command: { kind: 'cancel' }, variant: 'ghost' }],
  }
  const props = face({}, [entry(display, { operation: { id: OP, authorizationUrl: 'https://example.com/a' } })])
  render(<ConnectorAccountSectionEntry {...props} />)
  fireEvent.click(button('打开授权页'))
  expect(windowOpen).toHaveBeenCalledWith('https://example.com/a', '_blank', 'noopener,noreferrer')
  await act(async () => { fireEvent.click(button('取消')) })
  expect(props.remote.cancel).toHaveBeenCalledWith(KEY, OP)
  // A cancel button with no operation in progress calls nothing.
  cleanup()
  const idle = face({}, [entry(display)])
  render(<ConnectorAccountSectionEntry {...idle} />)
  await act(async () => { fireEvent.click(button('取消')) })
  expect(idle.remote.cancel).not.toHaveBeenCalled()
})

const prompt = (props: ReturnType<typeof face>, onOpenDetails = vi.fn()) =>
  <ConnectorAccountActivationEntry {...props} onDismiss={vi.fn()} onOpenDetails={onOpenDetails} />

it('renders nothing for a bundle whose account the Host has not listed', () => {
  render(<ConnectorAccountSectionEntry {...face({}, [])} />)
  render(prompt(face({}, [])))
  expect(document.body.textContent).toBe('')
})

it('tags only the enabled bundle that owns an account, with the Host text or the shared copy once the stream stopped', () => {
  const pkg = (name: string, enabled = true) => ({ name, installed: true, availability: 'profile', official: false, enabled, rows: [] } as const)
  const page = (name: string, enabled = true): PluginsSubject => ({ kind: 'bundle', pkg: pkg(name, enabled) })
  const row: PluginsSubject = { kind: 'row', pkg: pkg(KEY), row: { rowId: 'fixture', moduleName: '@acme/fixture-row', enabled: true } }
  const tag = (props: ReturnType<typeof face>, subject: PluginsSubject) => <ConnectorAccountBadgeEntry {...props} subject={subject} />
  const { rerender } = render(tag(face(), page(KEY)))
  expect(screen.getByText('未连接')).toBeTruthy()
  rerender(tag(face(), row))
  expect(screen.getByText('未连接')).toBeTruthy()
  rerender(tag(face({ stopped: true }), page(KEY)))
  expect(screen.getByText(zh['badge.stopped'])).toBeTruthy()
  for (const [props, subject] of [
    [face(), page(KEY, false)], [face(), page('@acme/other')], [face(), { kind: 'item', id: 'fixture-item' }],
    [face({}, [entry({ phase: 'checking', status: '检查中', buttons: [], notes: [] })]), page(KEY)],
  ] as const) {
    rerender(tag(props, subject))
    expect(document.body.textContent).toBe('')
  }
})

it('connects from the prompt through the operation the display names, or only opens the page', async () => {
  const onOpenDetails = vi.fn()
  const named = face({}, [entry({ ...DISCONNECTED, connect: { kind: 'start', operation: 'link-app' } })])
  const { rerender } = render(prompt(named, onOpenDetails))
  await act(async () => { fireEvent.click(button('连接演示')) })
  expect(onOpenDetails).toHaveBeenCalledOnce()
  expect(named.remote.start).toHaveBeenCalledWith(KEY, 'link-app')
  const bare = face()
  rerender(prompt(bare, onOpenDetails))
  fireEvent.click(button('连接演示'))
  expect(onOpenDetails).toHaveBeenCalledTimes(2)
  expect(bare.remote.start).not.toHaveBeenCalled()
})

it('starts once for a second click before the first call answers', async () => {
  const props = face({}, [entry({ ...DISCONNECTED, connect: { kind: 'start', operation: 'connect' } })])
  const answer = Promise.withResolvers<RemoteResult<ConnectorOperationId>>()
  props.remote.start.mockReturnValueOnce(answer.promise)
  render(prompt(props))
  fireEvent.click(button('连接演示'))
  fireEvent.click(button('连接演示'))
  await act(async () => { answer.resolve(ok(OP)) })
  expect(props.remote.start).toHaveBeenCalledOnce()
  expect(props.follow).toHaveBeenCalledOnce()
})

it('shows the account notice through the toast entry', () => {
  render(<ConnectorAccountToastEntry {...face({ notice: { seq: 1, kind: 'succeeded', text: '演示已连接' } })} />)
  expect(screen.getByText('演示已连接')).toBeTruthy()
})
