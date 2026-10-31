// @vitest-environment jsdom
/** The surfaces render the plugin's display from the Host with the kit's shared copy, and turn buttons into commands. */
import type { ComponentProps } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { CliAccountDisplay, CliAccountEntry } from '@deepseek-ai/dsh-cli-account/types'
import type { LocalizedText } from '@deepseek-ai/dsh-package-manifest'
import { afterEach, expect, it, vi } from 'vitest'
import {
  CliAccountActivation, CliAccountActivationEntry, CliAccountBadge, CliAccountBadgeEntry, CliAccountSection, CliAccountSectionEntry,
  CliAccountToast, CliAccountToastEntry, type CliAccountBadgeSubject,
} from '../src/client/components.tsx'
import { zh } from '../src/client/locales.ts'
import type { CliAccountSnapshot } from '../src/client/types.ts'

afterEach(cleanup)

const PACKAGE = '@acme/fixture'
const t = makeTranslate(zh)
const resolveText = (text: LocalizedText): string => typeof text === 'string' ? text : text.zh ?? text.en
const button = (name: string) => screen.getByRole('button', { name })

const DISCONNECTED: CliAccountDisplay = {
  phase: 'disconnected', status: { en: 'Not connected', zh: '未连接' }, badge: '未连接',
  buttons: [{ label: '连接演示', command: { kind: 'start', operation: 'connect' }, variant: 'primary' }], notes: [],
}

function entry(display: CliAccountDisplay = DISCONNECTED): CliAccountEntry {
  return {
    packageName: PACKAGE, display,
    copy: { title: { en: 'Fixture account', zh: '演示账号' }, hint: '与终端共用。', activation: { title: '连接演示', body: '插件已开启。', connect: '连接演示' } },
  }
}

function snapshot(change: Partial<CliAccountSnapshot> = {}, display?: CliAccountDisplay): CliAccountSnapshot {
  return { entry: entry(display), linked: true, stopped: false, busy: false, notice: undefined, ...change }
}

function section(change: Partial<CliAccountSnapshot> = {}, display?: CliAccountDisplay) {
  const onCommand = vi.fn()
  const onRetry = vi.fn()
  const view = render(
    <CliAccountSection t={t} resolveText={resolveText} snapshot={snapshot(change, display)} onCommand={onCommand} onRetry={onRetry} />,
  )
  return { ...view, onCommand, onRetry }
}

it('shows the plugin title, status, detail, notes, and hint, and runs each button as its command', () => {
  const display: CliAccountDisplay = {
    ...DISCONNECTED, detail: '先关联一个应用。',
    notes: [{ text: '应用：cli_a', button: { label: '更换', command: { kind: 'start', operation: 'link-app' }, variant: 'ghost' } }, { text: '普通说明' }],
  }
  const { container, onCommand } = section({}, display)
  expect(screen.getByText('演示账号')).toBeTruthy()
  expect(screen.getByText('未连接')).toBeTruthy()
  expect(screen.getByText('先关联一个应用。')).toBeTruthy()
  expect(screen.getByText('普通说明')).toBeTruthy()
  expect(screen.getByText('与终端共用。')).toBeTruthy()
  expect(container.querySelector('[data-cli-account="disconnected"][data-cli-account-package="@acme/fixture"]')).toBeTruthy()
  fireEvent.click(button('连接演示'))
  fireEvent.click(button('更换'))
  expect(onCommand.mock.calls).toEqual([[{ kind: 'start', operation: 'connect' }], [{ kind: 'start', operation: 'link-app' }]])
})

it('disables the buttons while an action is pending or the Host stream is down', () => {
  const disabled = (): boolean[] => screen.getAllByRole('button').map(element => (element as HTMLButtonElement).disabled)
  const { rerender } = section({ busy: true })
  expect(disabled()).toEqual([true])
  rerender(
    <CliAccountSection t={t} resolveText={resolveText} snapshot={snapshot({ linked: false })} onCommand={vi.fn()} onRetry={vi.fn()} />,
  )
  expect(disabled()).toEqual([true])
})

it('asks before a button that changes the account outside DSH and runs it only after the user accepts', () => {
  const display: CliAccountDisplay = {
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

it.each<[string, CliAccountDisplay['failure'], string]>([
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
  expect(container.querySelector('[data-cli-account="stopped"]')).toBeTruthy()
  fireEvent.click(button(zh['action.retry']))
  expect(onRetry).toHaveBeenCalledOnce()
})

it('tags only the enabled bundle of the package once its text settles', () => {
  const pkg = (name: string, enabled = true) => ({ name, enabled })
  const badge = (subject: CliAccountBadgeSubject, text: string | undefined) =>
    <CliAccountBadge subject={subject} packageName={PACKAGE} phase="connected" text={text} />
  const { rerender } = render(badge({ kind: 'bundle', pkg: pkg(PACKAGE) }, '已连接'))
  expect(screen.getByText('已连接')).toBeTruthy()
  rerender(badge({ kind: 'row', pkg: pkg(PACKAGE) }, '已连接'))
  expect(screen.getByText('已连接')).toBeTruthy()
  const hidden: CliAccountBadgeSubject[] = [{ kind: 'bundle', pkg: pkg(PACKAGE, false) }, { kind: 'bundle', pkg: pkg('@acme/other') }, { kind: 'item' }]
  for (const subject of hidden) {
    rerender(badge(subject, '已连接'))
    expect(document.body.textContent).toBe('')
  }
  rerender(badge({ kind: 'bundle', pkg: pkg(PACKAGE) }, undefined))
  expect(document.body.textContent).toBe('')
})

it('prompts to connect only while disconnected and steps aside once the phase settles elsewhere', () => {
  const onDismiss = vi.fn()
  const onConnect = vi.fn()
  const prompt = (phase: 'checking' | 'disconnected' | 'connected') =>
    <CliAccountActivation t={t} phase={phase} title="连接演示" body="插件已开启。" connect="立即连接" onDismiss={onDismiss} onConnect={onConnect} />
  const { rerender } = render(prompt('checking'))
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
})

it('shows the latest notice with the plugin text or the shared failure copy', () => {
  const onDone = vi.fn()
  const toast = (notice: CliAccountSnapshot['notice']) => <CliAccountToast t={t} resolveText={resolveText} notice={notice} onDone={onDone} />
  const { rerender } = render(toast(undefined))
  expect(document.body.textContent).toBe('')
  rerender(toast({ seq: 1, kind: 'succeeded', text: { en: 'Connected', zh: '演示已连接' } }))
  expect(screen.getByText('演示已连接')).toBeTruthy()
  rerender(toast({ seq: 2, kind: 'action-failed' }))
  expect(screen.getByText(zh['notice.action-failed'])).toBeTruthy()
})

function face(change: Partial<CliAccountSnapshot> = {}, display?: CliAccountDisplay) {
  const current = snapshot(change, display)
  return {
    useCliAccount: <R,>(selector: (value: CliAccountSnapshot) => R): R => selector(current),
    packageName: PACKAGE, resolveText, run: vi.fn(), retry: vi.fn(), dismissNotice: vi.fn(), t,
  }
}

it('renders the section entry from the account face and runs its commands', () => {
  const props = face({ busy: false })
  render(<CliAccountSectionEntry {...props} />)
  fireEvent.click(button('连接演示'))
  expect(props.run).toHaveBeenCalledWith({ kind: 'start', operation: 'connect' })
})

it('tags the bundle with the Host text, or with the shared copy once the stream stopped', () => {
  const subject = { kind: 'bundle', pkg: { name: PACKAGE, installed: true, availability: 'profile', official: false, enabled: true, rows: [] } } as const
  const tag = (props: ReturnType<typeof face>) =>
    <CliAccountBadgeEntry {...{ ...props, subject } as ComponentProps<typeof CliAccountBadgeEntry>} />
  const { rerender } = render(tag(face()))
  expect(screen.getByText('未连接')).toBeTruthy()
  rerender(tag(face({ stopped: true })))
  expect(screen.getByText(zh['badge.stopped'])).toBeTruthy()
  rerender(tag(face({}, { phase: 'checking', status: '检查中', buttons: [], notes: [] })))
  expect(document.body.textContent).toBe('')
})

it('connects from the prompt through the operation the display names, or only opens the page', () => {
  const onOpenDetails = vi.fn()
  const prompt = (props: ReturnType<typeof face>) =>
    <CliAccountActivationEntry {...{ ...props, onDismiss: vi.fn(), onOpenDetails } as ComponentProps<typeof CliAccountActivationEntry>} />
  const named = face({}, { ...DISCONNECTED, connect: { kind: 'start', operation: 'link-app' } })
  const { rerender } = render(prompt(named))
  fireEvent.click(button('连接演示'))
  expect(onOpenDetails).toHaveBeenCalledOnce()
  expect(named.run.mock.calls).toEqual([[{ kind: 'start', operation: 'link-app' }]])
  const bare = face()
  rerender(prompt(bare))
  fireEvent.click(button('连接演示'))
  expect(onOpenDetails).toHaveBeenCalledTimes(2)
  expect(bare.run).not.toHaveBeenCalled()
})

it('shows the account notice through the toast entry', () => {
  render(<CliAccountToastEntry {...face({ notice: { seq: 1, kind: 'succeeded', text: '演示已连接' } })} />)
  expect(screen.getByText('演示已连接')).toBeTruthy()
})
