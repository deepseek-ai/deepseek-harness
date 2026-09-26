// @vitest-environment jsdom
import type { ShortcutCatalogEntry, ShortcutCommandId } from '@deepseek-ai/dsh-client-shortcuts/client'
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useEffect, useState } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createSettingsShellStore } from '../src/client/shell-store.ts'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SettingsRootComponentProps } from '../src/client/shell-contract.ts'
import { SettingsRoot } from '../src/client/SettingsRoot.tsx'
import { en, zh } from '../src/client/locales.ts'
import type { DesktopUpdateView } from '../src/types.ts'
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'

// Every fixture carries the resource hook the resources plugin merges into GlobalStandardProps.
const useResource = (() => ({ status: 'none' as const, value: undefined, failure: undefined, reload: () => {} })) as GlobalStandardProps['useResource']
const usePanelInfo: GlobalStandardProps['usePanelInfo'] = selector => selector({ activePanelId: null })

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

type Row = { id: string; order: number; label: string }
type Step = { id: string; order: number }

/** Slot-content stand-ins: the shell renders whatever the seats contribute. */
const SEAT_CONTENT: Record<string, string> = {
  'settings.trigger': 'Settings',
  'settings.header': 'Settings Title',
  'settings.action': 'Open configuration file',
  'settings.close': 'Close',
}

type AttentionSnapshot = Parameters<Parameters<SettingsRootComponentProps['useSessionStatus']>[0]>[0]
type ConnectionSnapshot = Parameters<Parameters<SettingsRootComponentProps['useConnectionState']>[0]>[0]
const noAttention: AttentionSnapshot = new Map()
const useSessionStatus: SettingsRootComponentProps['useSessionStatus'] = selector => selector(noAttention)

function mount({
  shortcuts = [],
  wide = true,
  dictionary = en,
  connectionState = 'connected',
  desktopUpdate = { failed: false, opening: false },
  onboardingActive = true,
  mainView = true,
  rows = [
    { id: 'general', order: 0, label: 'General' },
    { id: 'models', order: 10, label: 'Models' },
    { id: 'agent-presets', order: 20, label: 'Agent presets' },
  ],
  steps = [
    { id: 'welcome', order: -100 },
    { id: 'credential', order: 0 },
  ],
}: {
  shortcuts?: readonly ShortcutCatalogEntry[]
  wide?: boolean
  dictionary?: typeof en | typeof zh
  connectionState?: ConnectionSnapshot
  desktopUpdate?: DesktopUpdateView
  onboardingActive?: boolean
  mainView?: boolean
  rows?: Row[]
  steps?: Step[]
} = {}) {
  // Mutable row source standing in for the bound useSections hook; bump()
  // plays a ledger change through the same observable contract.
  let current = rows
  let currentConnectionState = connectionState
  const listeners = new Set<() => void>()
  const connectionListeners = new Set<() => void>()
  const reconnect = vi.fn()
  const renderSlot = vi.fn(
    ((key: string, _owner: unknown, opts?: { only?: string; fallback?: import('react').ReactNode }) => {
      if (key === 'settings.section') return <div data-testid={`section-${opts?.only ?? 'all'}`} />
      return SEAT_CONTENT[key] ?? opts?.fallback
    }) as SettingsRootComponentProps['renderSlot'],
  )
  const activeId = SessionId('active-session')
  const sessions: SessionListState = {
    ids: [activeId],
    byId: {
      [activeId]: {
        id: activeId,
        displayTitle: 'Active',
        blank: onboardingActive,
        running: false,
        retainedBy: mainView ? { mainView: 1 } : {},
        updatedAt: 0,
      },
    },
    phase: 'ready', projectionsBySession: {},
  }
  const unusedHook = (() => { throw new Error('unused by SettingsRoot') }) as never
  const shell = createSettingsShellStore().create()
  const props: SettingsRootComponentProps = {
    useStore: bindSnapshotSelector(shell), actions: shell.actions,
    useShortcuts: select => select(shortcuts),
    useSessions: select => select(sessions),
    useSessionStatus,
    usePanelInfo, useSessionRetainInfo: () => undefined, useResource,
    useWorkspaces: unusedHook,
    wide,
    reconnect,
    openDesktopUpdate: () => {},
    useDesktopUpdate: select => select(desktopUpdate),
    t: makeTranslate(dictionary),
    useConnectionState: (select) => {
      const [, force] = useState(0)
      useEffect(() => {
        const listener = () => { force(n => n + 1) }
        connectionListeners.add(listener)
        return () => { connectionListeners.delete(listener) }
      }, [])
      return select(currentConnectionState)
    },
    useOnboardingSteps: select => select(steps),
    useSections: (select) => {
      const [, force] = useState(0)
      useEffect(() => {
        const listener = () => { force(n => n + 1) }
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      }, [])
      return select(current)
    },
    renderSlot,
  }
  const view = render(<SettingsRoot {...props} />)
  const bump = (next: Row[]) => {
    act(() => {
      current = next
      for (const fn of [...listeners]) fn()
    })
  }
  const setConnectionState = (next: typeof currentConnectionState) => {
    act(() => {
      currentConnectionState = next
      for (const fn of [...connectionListeners]) fn()
    })
  }
  const setDesktopUpdate = (next: DesktopUpdateView) => {
    desktopUpdate = next
    view.rerender(<SettingsRoot {...props} />)
  }
  const setShortcuts = (next: readonly ShortcutCatalogEntry[]) => {
    shortcuts = next
    view.rerender(<SettingsRoot {...props} />)
  }
  /** Turn the mounted Session blank, which is what makes an onboarding step appear. */
  const setOnboardingActive = (next: boolean) => {
    const session = sessions.byId[activeId]
    if (session === undefined) throw new Error('expected the mounted Session')
    act(() => { sessions.byId[activeId] = { ...session, blank: next } })
    view.rerender(<SettingsRoot {...props} />)
  }
  return { view, renderSlot, bump, listeners, reconnect, setConnectionState, setDesktopUpdate, setShortcuts, setOnboardingActive }
}

function openPanel() {
  const trigger = screen.getByRole('button', { name: 'Settings' })
  trigger.focus()
  fireEvent.click(trigger)
  return trigger
}

describe('SettingsRoot trigger', () => {
  it('shows installation instead of expected backend reconnection and restores connection feedback after failure', () => {
    const presentation = { phase: 'installing' as const, version: '1.0.1' }
    const f = mount({ dictionary: zh, connectionState: 'connecting',
      desktopUpdate: { failed: false, opening: false, presentation } })
    expect(screen.getByRole('button', { name: '正在准备重启…' })).toBeTruthy()
    expect(screen.queryByText('重新连接中')).toBeNull()
    f.setDesktopUpdate({ failed: false, opening: false,
      presentation: { phase: 'error', version: presentation.version, failure: 'install' } })
    expect(screen.queryByRole('button', { name: '重试更新' })).toBeNull()
    expect(screen.getByText('重新连接中')).toBeTruthy()
  })
  it.each([
    { column: 'expanded English', wide: true, dictionary: en, name: 'Settings' },
    { column: 'collapsed English', wide: false, dictionary: en, name: 'Settings' },
    { column: 'expanded Chinese', wide: true, dictionary: zh, name: '设置' },
    { column: 'collapsed Chinese', wide: false, dictionary: zh, name: '设置' },
  ])('uses the locale name and accepts keyboard-style activation for the $column trigger', ({
    wide, dictionary, name,
  }) => {
    const { renderSlot } = mount({ wide, dictionary })
    const trigger = screen.getByRole('button', { name })
    expect(trigger.getAttribute('aria-label')).toBe(name)
    expect(renderSlot).toHaveBeenCalledWith('settings.trigger', { wide })
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    trigger.focus()
    fireEvent.click(trigger, { detail: 0 })
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(screen.getByRole('button', { name, expanded: true })).toBeTruthy()
  })

  it('shows outage, retry progress, and a two-second recovery confirmation', () => {
    vi.useFakeTimers()
    const mounted = mount()
    expect(screen.queryByRole('button', { name: 'Disconnected, reconnect now' })).toBeNull()

    mounted.setConnectionState('disconnected')
    const indicator = screen.getByRole('button', { name: 'Disconnected, reconnect now' })
    expect(indicator.textContent).toContain('Disconnected')
    expect(indicator.hasAttribute('title')).toBe(false)
    expect(indicator.querySelector('svg')).toBeTruthy()
    fireEvent.click(indicator)
    expect(mounted.reconnect).toHaveBeenCalledOnce()

    mounted.setConnectionState('connecting')
    expect(screen.getByRole('button', { name: 'Reconnecting, reconnect now' }).textContent)
      .toContain('Reconnecting...')

    // An attempt that resolves instantly still shows the connecting pill for
    // its 800ms minimum before the confirmation replaces it.
    mounted.setConnectionState('connected')
    expect(screen.queryByRole('status')).toBeNull()
    act(() => { vi.advanceTimersByTime(800) })
    expect(screen.getByRole('status', { name: 'Connected' })).toBeTruthy()
    // The confirmation window is measured from visibility, not the transition.
    act(() => { vi.advanceTimersByTime(1_999) })
    expect(screen.getByRole('status', { name: 'Connected' })).toBeTruthy()
    // The confirmation window closes at 2s, then the pill fades for 150ms.
    act(() => { vi.advanceTimersByTime(1) })
    act(() => { vi.advanceTimersByTime(150) })
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('keeps the attempt label steady through the hold and confirms for the full window', () => {
    vi.useFakeTimers()
    const mounted = mount({ dictionary: zh })
    mounted.setConnectionState('connecting')
    const attempt = screen.getByRole('button', { name: '连接中断，正在重试，点击立即重连' })
    expect(attempt.textContent).toContain('重新连接中')
    fireEvent.click(attempt)
    expect(mounted.reconnect).toHaveBeenCalledOnce()
    expect(attempt.textContent).toContain('重新连接中')
    // An attempt that resolves mid-hold keeps its label until the hold ends.
    act(() => { vi.advanceTimersByTime(100) })
    mounted.setConnectionState('connected')
    expect(screen.getByRole('button', { name: '连接中断，正在重试，点击立即重连' }).textContent)
      .toContain('重新连接中')
    act(() => { vi.advanceTimersByTime(700) })
    expect(screen.getByRole('status', { name: '连接成功' })).toBeTruthy()
    // The full two-second confirmation follows the delayed appearance.
    act(() => { vi.advanceTimersByTime(1_999) })
    expect(screen.getByRole('status', { name: '连接成功' })).toBeTruthy()
    act(() => { vi.advanceTimersByTime(1) })
    act(() => { vi.advanceTimersByTime(150) })
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('skips the hold when the attempt already stayed visible long enough', () => {
    vi.useFakeTimers()
    const mounted = mount()
    mounted.setConnectionState('connecting')
    act(() => { vi.advanceTimersByTime(800) })
    mounted.setConnectionState('connected')
    expect(screen.getByRole('status', { name: 'Connected' })).toBeTruthy()
    act(() => { vi.advanceTimersByTime(2_000) })
    act(() => { vi.advanceTimersByTime(150) })
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('keeps the reconnect indicator out of the collapsed rail', () => {
    mount({ wide: false, connectionState: 'disconnected' })
    expect(screen.queryByRole('button', { name: 'Disconnected, reconnect now' })).toBeNull()
  })
})

describe('SettingsPanel chrome seats', () => {
  it('names the dialog via aria-labelledby pointing at the header seat node', () => {
    mount()
    openPanel()
    const dialog = screen.getByRole('dialog')
    const titleId = dialog.getAttribute('aria-labelledby')!
    expect(titleId).toBeTruthy()
    const title = document.getElementById(titleId)!
    expect(title.textContent).toBe('Settings Title')
    expect(screen.getByRole('dialog', { name: 'Settings Title' })).toBeTruthy()
  })

  it('names the close button through the visually-hidden close seat text', () => {
    mount()
    openPanel()
    const close = screen.getByRole('button', { name: 'Close' })
    expect(close.hasAttribute('aria-label')).toBe(false)
    expect(close.textContent).toContain('Close')
  })

  it('renders header actions before the shell-owned close control', () => {
    const { renderSlot } = mount()
    openPanel()
    expect(screen.getByText('Open configuration file')).toBeTruthy()
    expect(renderSlot).toHaveBeenCalledWith('settings.action', {})
  })
})

describe('SettingsPanel close paths', () => {
  it('closes via the header button and restores trigger focus', async () => {
    mount()
    const trigger = openPanel()
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    await vi.waitFor(() => { expect(document.activeElement).toBe(trigger) })
  })

  it('closes via a mask click and restores trigger focus', async () => {
    mount()
    const trigger = openPanel()
    const dialog = screen.getByRole('dialog')
    fireEvent.click(dialog.parentElement!.firstElementChild!)
    expect(screen.queryByRole('dialog')).toBeNull()
    await vi.waitFor(() => { expect(document.activeElement).toBe(trigger) })
  })

  it('closes via document-level Escape, restores trigger focus, and unhooks the listener', async () => {
    mount()
    const trigger = openPanel()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    await vi.waitFor(() => { expect(document.activeElement).toBe(trigger) })
    // Ignored while closed (listener removed with the panel) and non-Escape
    // keys are ignored while open.
    fireEvent.keyDown(document, { key: 'Escape' })
    openPanel()
    fireEvent.keyDown(document, { key: 'Enter' })
    expect(screen.getByRole('dialog')).toBeTruthy()
  })

  it('lands focus on the active section when the dialog opens', () => {
    mount()
    openPanel()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'General' }))
  })

  it('opens above an existing body modal and gives the visible settings panel keyboard ownership', () => {
    mount()
    const closeReference = vi.fn()
    render(<Modal open title="Keyboard reference" closeLabel="Close reference" onClose={closeReference}>
      <button data-modal-autofocus>Reference control</button>
    </Modal>)
    const reference = screen.getByRole('dialog', { name: 'Keyboard reference' })
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Reference control' }))
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
    const settings = screen.getByRole('dialog', { name: 'Settings Title' })
    expect(settings.parentElement?.parentElement).toBe(document.body)
    expect(reference.parentElement!.compareDocumentPosition(settings.parentElement!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'General' }))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: 'Settings Title' })).toBeNull()
    expect(closeReference).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Reference control' }))
  })
})

describe('SettingsPanel navigation', () => {
  it('projects rows, marks the first active, and renders only that section', () => {
    mount()
    openPanel()
    expect(screen.getByRole('button', { name: 'General' }).getAttribute('aria-current')).toBe('true')
    expect(screen.getByRole('button', { name: 'Models' }).getAttribute('aria-current')).toBeNull()
    expect(screen.getByTestId('section-general')).toBeTruthy()
  })

  it('gives every section a nav glyph, distinct for the ids the shell knows', () => {
    mount({
      rows: [
        { id: 'general', order: 0, label: 'General' },
        { id: 'models', order: 10, label: 'Models' },
        { id: 'agent-presets', order: 20, label: 'Agent presets' },
        { id: 'plugins', order: 30, label: 'Plugins' },
        { id: 'archived-sessions', order: 40, label: 'Archived sessions' },
        { id: 'contributed', order: 50, label: 'Contributed' },
      ],
    })
    openPanel()
    // Glyphs carry no id of their own, so the drawn paths are what tells them apart.
    const glyphs = ['General', 'Models', 'Agent presets', 'Plugins', 'Archived sessions', 'Contributed']
      .map(name => screen.getByRole('button', { name }).querySelector('svg')?.innerHTML)

    expect(glyphs.every(glyph => glyph !== undefined && glyph !== '')).toBe(true)
    // The four ids the shell names get their own glyph; every other section —
    // including one this package never heard of — shares the gear.
    expect(new Set(glyphs.slice(0, 5)).size).toBe(5)
    expect(glyphs[5]).toBe(glyphs[0])
  })

  it('switches the rendered section on nav click', () => {
    mount()
    openPanel()
    fireEvent.click(screen.getByRole('button', { name: 'Models' }))
    expect(screen.getByRole('button', { name: 'Models' }).getAttribute('aria-current')).toBe('true')
    expect(screen.getByTestId('section-models')).toBeTruthy()
    expect(screen.queryByTestId('section-general')).toBeNull()
  })

  it('mounts onboarding steps in order and transfers ownership only on completion', () => {
    const { renderSlot } = mount()
    const first = renderSlot.mock.calls.find(call => call[0] === 'settings.onboarding')
    expect(first?.[1]).toMatchObject({ stepId: 'welcome' })
    expect(first?.[2]).toEqual({ only: 'welcome' })
    act(() => {
      (first?.[1] as { complete: () => void }).complete()
      ;(first?.[1] as { complete: () => void }).complete()
    })
    const onboardingCalls = renderSlot.mock.calls.filter(call => call[0] === 'settings.onboarding')
    const second = onboardingCalls.at(-1)
    expect(second?.[1]).toMatchObject({ stepId: 'credential' })
    expect(second?.[2]).toEqual({ only: 'credential' })

    act(() => {
      (second?.[1] as { openSection: (id: string) => void }).openSection('models')
    })
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(screen.getByTestId('section-models')).toBeTruthy()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Models' }))

    cleanup()
    const inactive = mount({ onboardingActive: false }).renderSlot.mock.calls
      .filter(call => call[0] === 'settings.onboarding')
    expect(inactive).toHaveLength(0)
  })

  it('takes the panel down when an onboarding step appears beneath it', () => {
    const { setOnboardingActive } = mount({ onboardingActive: false })
    openPanel()
    expect(screen.getByRole('dialog')).toBeDefined()

    // The step's overlay marks only #root inert, and the panel is portalled beside it.
    setOnboardingActive(true)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('keeps onboarding active before a main Session is retained', () => {
    const { renderSlot } = mount({ mainView: false })

    expect(renderSlot.mock.calls.some(call => call[0] === 'settings.onboarding')).toBe(true)
  })

  it('paints no takeover chrome of its own around the mounted step', () => {
    // The chrome (mask, opaque stage, #root inert) belongs to the step via
    // the step-owned dialog surface — a mounted-but-deciding step that
    // renders null must show and block nothing (the reload white-flash fix;
    // onboarding-surface.spec.tsx pins the primitive's half).
    const appRoot = document.createElement('div')
    appRoot.id = 'root'
    document.body.append(appRoot)
    const { view } = mount()
    expect(view.container.querySelector('[class*="onboarding"]')).toBeNull()
    expect(document.body.querySelector('[class*="onboarding"]')).toBeNull()
    expect(appRoot.inert).not.toBe(true)
    view.unmount()
    appRoot.remove()
  })

  it('falls back to the first row when the active entry unregisters', () => {
    const { bump } = mount()
    openPanel()
    fireEvent.click(screen.getByRole('button', { name: 'Models' }))
    bump([{ id: 'general', order: 0, label: 'General' }])
    expect(screen.queryByRole('button', { name: 'Models' })).toBeNull()
    expect(screen.getByTestId('section-general')).toBeTruthy()
  })

  it('renders an empty content column and focuses the title when the ledger is empty', () => {
    const { renderSlot } = mount({ rows: [] })
    openPanel()
    expect(document.activeElement).toBe(screen.getByText('Settings Title'))
    expect(screen.getByRole('dialog')).toBeTruthy()
    const sectionCalls = renderSlot.mock.calls.filter(c => c[0] === 'settings.section')
    expect(sectionCalls).toHaveLength(0)
  })

  it('drops the ledger subscription on unmount', () => {
    const { view, listeners } = mount()
    expect(listeners.size).toBe(1)
    view.unmount()
    expect(listeners.size).toBe(0)
  })
})

it('explicitly reopens one onboarding editor during an existing session', () => {
  const { renderSlot } = mount({ onboardingActive: false })
  const launcher = renderSlot.mock.calls.find(call => call[0] === 'settings.launcher')
  act(() => { (launcher?.[1] as { openOnboarding: (id: string) => void }).openOnboarding('credential') })
  const call = renderSlot.mock.calls.filter(call => call[0] === 'settings.onboarding').at(-1)
  expect(call?.[1]).toMatchObject({ stepId: 'credential', explicit: true })
  act(() => { (call?.[1] as { complete: () => void }).complete() })
  renderSlot.mockClear()
  expect(screen.queryByTestId('onboarding')).toBeNull()
})

it('opens Account from the contributed sidebar launcher', () => {
  const { renderSlot } = mount({ rows: [{ id: 'account', order: -10, label: 'Account' }] })
  const launcher = renderSlot.mock.calls.find(call => call[0] === 'settings.launcher')!
  expect(launcher[1]).toMatchObject({ settingsOpen: false })
  act(() => { (launcher[1] as { openSettings: () => void }).openSettings() })
  expect(screen.getByTestId('section-account')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Account' }).querySelector('svg')).not.toBeNull()
  expect(renderSlot.mock.calls.filter(call => call[0] === 'settings.launcher').at(-1)?.[1]).toMatchObject({ settingsOpen: true })
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(renderSlot.mock.calls.filter(call => call[0] === 'settings.launcher').at(-1)?.[1]).toMatchObject({ settingsOpen: false })
})

it('shows the effective settings binding on focus and exposes it to assistive technology', () => {
  mount({ shortcuts: [{ id: 'settings.open' as ShortcutCommandId, label: 'Open settings', aliases: [], keys: ['⌘', ','], aria: 'Meta+,', binding: { code: 'Comma', modifiers: ['meta'] }, modified: false, conflicts: [], issue: null }] })
  const trigger = screen.getByRole('button', { name: 'Settings' })
  expect(trigger.getAttribute('aria-keyshortcuts')).toBe('Meta+,')
  fireEvent.focus(trigger)
  expect(screen.getByRole('tooltip').getAttribute('aria-label')).toBe('Settings ⌘ ,')
})

it('passes current Settings key labels to the launcher and removes them when unbound', () => {
  const row: ShortcutCatalogEntry = { id: 'settings.open' as ShortcutCommandId, label: 'Open settings', aliases: [], keys: ['⌘', ','], aria: 'Meta+,', binding: { code: 'Comma', modifiers: ['meta'] }, modified: false, conflicts: [], issue: null }
  const { renderSlot, setShortcuts } = mount({ shortcuts: [row] })
  const launcher = () => renderSlot.mock.calls.filter(call => call[0] === 'settings.launcher').at(-1)?.[1]
  expect(launcher()).toMatchObject({ settingsShortcut: { keys: ['⌘', ','], aria: 'Meta+,' } })

  setShortcuts([{ ...row, keys: ['Ctrl', 'Shift', 'S'], aria: 'Control+Shift+S', binding: { code: 'KeyS', modifiers: ['control', 'shift'] }, modified: true }])
  expect(launcher()).toMatchObject({ settingsShortcut: { keys: ['Ctrl', 'Shift', 'S'], aria: 'Control+Shift+S' } })

  setShortcuts([{ ...row, keys: [], aria: undefined, binding: null, modified: true }])
  expect(launcher()).not.toHaveProperty('settingsShortcut')
})
