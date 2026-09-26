// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useSyncExternalStore } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { DesktopUpdateIndicator } from '../src/client/DesktopUpdateIndicator.tsx'
import type { DesktopUpdateBridge, DesktopUpdatePresentation } from '../src/types.ts'
import { DesktopUpdateSource } from '../src/client/desktop-update-source.ts'
import { en, zh } from '../src/client/locales.ts'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

type SettingsTranslate = PropsLocale<'settings'>['t']

function translate(dictionary: typeof zh | typeof en): SettingsTranslate {
  const messages: Readonly<Record<string, string>> = dictionary
  return (key, params) => Object.entries(params ?? {})
    .reduce((message, [name, value]) => message.replaceAll(`{${name}}`, String(value)),
      messages[key] ?? key)
}

function fixture() {
  let listener: ((state: DesktopUpdatePresentation) => void) | undefined
  const status = Promise.withResolvers<DesktopUpdatePresentation>()
  const unsubscribe = vi.fn()
  const open = vi.fn(async () => {})
  const bridge: DesktopUpdateBridge = {
    status: () => status.promise,
    open,
    subscribe: (next) => { listener = next; return unsubscribe },
  }
  const source = new DesktopUpdateSource(bridge)
  const subscribe = (notify: () => void) => source.store.subscribe(notify)
  const snapshot = () => source.store.getSnapshot()
  function Indicator({ wide = true, hidden = false, dictionary = zh }: {
    wide?: boolean
    hidden?: boolean
    dictionary?: typeof zh | typeof en
  }) {
    const state = useSyncExternalStore(subscribe, snapshot)
    return <DesktopUpdateIndicator wide={wide} hidden={hidden} t={translate(dictionary)} view={state} onOpen={() => { source.open() }} />
  }
  const view = render(<Indicator />)
  const unmount = view.unmount
  view.unmount = () => { source.dispose(); unmount() }
  return { open, status, unsubscribe, view, Indicator, source, emit: async (state: DesktopUpdatePresentation) => {
    await act(async () => { listener?.(state) })
  } }
}

const available = { phase: 'available', version: '1.0.1' } as const

it('renders nothing outside the Desktop carrier', () => {
  const source = new DesktopUpdateSource(undefined)
  const view = render(<DesktopUpdateIndicator wide hidden={false} t={translate(zh)}
    view={source.store.getSnapshot()} onOpen={() => { source.open() }} />)
  source.open()
  source.dispose()
  expect(view.container.innerHTML).toBe('')
})

it('keeps the newest event, hides for connection priority, and invokes only the shell action', async () => {
  const f = fixture()
  try {
    await f.emit(available)
    await act(async () => { f.status.resolve({ phase: 'idle' }) })
    fireEvent.click(screen.getByRole('button', { name: '新版本' }))
    await act(async () => {})
    expect(f.open).toHaveBeenCalledOnce()
    f.view.rerender(<f.Indicator hidden />)
    expect(screen.queryByRole('button')).toBeNull()
    await f.emit({ phase: 'downloading', version: available.version, percent: 58 })
    f.view.rerender(<f.Indicator />)
    fireEvent.click(screen.getByRole('button', { name: '58%' }))
    expect(f.open).toHaveBeenCalledOnce()
    await f.emit({ phase: 'error', version: available.version, failure: 'download' })
    const retry = screen.getByRole('button', { name: '重试更新' })
    fireEvent.focus(retry)
    expect((await screen.findByRole('tooltip')).textContent).toBe('下载更新失败，请重试。')
    f.view.rerender(<f.Indicator wide={false} />)
    expect(screen.queryByRole('button')).toBeNull()
  } finally { f.view.unmount(); f.status.resolve(available) }
  expect(f.unsubscribe).toHaveBeenCalledOnce()
})

it('keeps bridge failures actionable and ignores status completion after unmount', async () => {
  const f = fixture()
  await act(async () => { f.status.reject(new Error('IPC unavailable')) })
  f.open.mockRejectedValueOnce(new Error('IPC unavailable'))
  fireEvent.click(screen.getByRole('button', { name: '重试更新' }))
  await act(async () => {})
  f.view.unmount()
  const late = fixture()
  late.view.unmount()
  await act(async () => { late.status.resolve(available) })
  expect(late.unsubscribe).toHaveBeenCalledOnce()
})

it('accepts initial status, coalesces actions, and ignores late events and action rejection after disposal', async () => {
  const f = fixture()
  const pending = Promise.withResolvers<undefined>()
  try {
    await act(async () => { f.status.resolve(available) })
    expect(screen.getByRole('button', { name: '新版本' })).toBeTruthy()
    await f.emit({ phase: 'verifying', version: available.version })
    f.source.open()
    expect(f.open).not.toHaveBeenCalled()
    await f.emit(available)
    f.open.mockImplementationOnce(() => pending.promise)
    act(() => { f.source.open(); f.source.open() })
    expect(f.open).toHaveBeenCalledOnce()
    const state = f.source.store.getSnapshot()
    f.view.unmount()
    f.source.open()
    await f.emit({ phase: 'error', version: available.version, failure: 'install' })
    await act(async () => { pending.reject(new Error('late IPC failure')) })
    expect(f.source.store.getSnapshot()).toBe(state)
  } finally { pending.resolve(undefined); f.status.resolve(available) }
})

it('keeps an event newer than an initial-status failure', async () => {
  const f = fixture()
  try {
    await f.emit(available)
    await act(async () => { f.status.reject(new Error('stale initial request')) })
    expect(f.source.store.getSnapshot().failed).toBe(false)
  } finally { f.view.unmount(); f.status.resolve(available) }
})

it('renders the same semantic update in the active Web locale', async () => {
  const f = fixture()
  try {
    await f.emit(available)
    expect(screen.getByRole('button', { name: '新版本' })).toBeTruthy()
    f.view.rerender(<f.Indicator dictionary={en} />)
    expect(screen.getByRole('button', { name: 'Update' })).toBeTruthy()
  } finally { f.view.unmount(); f.status.resolve(available) }
})

it('shows fallback progress and error details when the shell omits optional fields', async () => {
  const f = fixture()
  try {
    await f.emit({ phase: 'downloading' })
    const progress = screen.getByRole('button', { name: '0%' })
    fireEvent.focus(progress)
    expect((await screen.findByRole('tooltip')).textContent).toBe('0%')
    await f.emit({ phase: 'downloading', version: '1.0.1' })
    fireEvent.focus(screen.getByRole('button', { name: '0%' }))
    expect((await screen.findByRole('tooltip')).textContent).toContain('1.0.1')
    await f.emit({ phase: 'error' })
    fireEvent.focus(screen.getByRole('button', { name: '重试更新' }))
    expect((await screen.findByRole('tooltip')).textContent).toBe('安装更新失败，请稍后重试。')
  } finally { f.view.unmount(); f.status.resolve({ phase: 'idle' }) }
})

it.each(['checking', 'verifying', 'installing'] as const)('shows only the version during %s in both locales', async (phase) => {
  const f = fixture()
  try {
    await f.emit({ phase, version: '0.1.7-alpha.2' })
    fireEvent.focus(screen.getByRole('button'))
    expect((await screen.findByRole('tooltip')).textContent).toBe('0.1.7-alpha.2')
    f.view.rerender(<f.Indicator dictionary={en} />)
    fireEvent.focus(screen.getByRole('button'))
    expect((await screen.findByRole('tooltip')).textContent).toBe('0.1.7-alpha.2')
  } finally { f.view.unmount(); f.status.resolve({ phase: 'idle' }) }
})

it.each([
  ['checking', '正在检查更新…'],
  ['verifying', '正在校验更新文件…'],
  ['installing', '正在准备重启…'],
] as const)('retains the state label when %s has no version', async (phase, label) => {
  const f = fixture()
  try {
    await f.emit({ phase })
    fireEvent.focus(screen.getByRole('button', { name: label }))
    expect((await screen.findByRole('tooltip')).textContent).toBe(label)
  } finally { f.view.unmount(); f.status.resolve({ phase: 'idle' }) }
})
