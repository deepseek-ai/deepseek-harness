// @vitest-environment jsdom
/** Terminal views, copy, and tab retention follow the plugin lifetime. */
import { createElement } from 'react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { renderToStaticMarkup } from 'react-dom/server'
import { cleanup, render, waitFor } from '@testing-library/react'
import { Context } from '@deepseek-ai/cordis'
import type { ShortcutCommand } from '@deepseek-ai/dsh-client-shortcuts/client'
import { afterEach, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WebTerminalId, WebTerminalInfo } from '@deepseek-ai/dsh-api-terminal-controller/types'
import { SidebarRightTabRegistry } from '@deepseek-ai/dsh-client-ui-sidebar-right/src/client/tab-registry.ts'
import type { SidebarRightCloseHandler } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { SidebarRightOpenTab } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { apply, inject } from '../src/client/index.ts'
import { apply as hostApply } from '../src/index.ts'
import { TerminalGuide, type TerminalGuideInjected } from '../src/client/TerminalGuide.tsx'
import { LazyTerminalBody } from '../src/client/LazyTerminalBody.tsx'
import { TerminalTitle } from '../src/client/TerminalTitle.tsx'
import type { TerminalBodyInjected } from '../src/client/face.ts'
import { en, zh } from '../src/client/locales.ts'

vi.mock('@xterm/xterm', () => ({ Terminal: vi.fn() }))
const SHORTCUT_CATALOG: readonly never[] = []

const renderedTerminal = vi.hoisted(() => vi.fn(() => null))
vi.mock('../src/client/terminal.tsx', () => ({ TerminalBody: renderedTerminal }))

afterEach(() => { cleanup(); renderedTerminal.mockClear() })

async function mountPlugin() {
  const ctx = new Context()
  const tabs = new SidebarRightTabRegistry(ctx)
  ctx.provide('sidebarRightTabs', tabs)
  const entries: {
    name: string
    key?: string
    id?: string
    locale: string
    component: unknown
    inject: (id: SessionId) => unknown
  }[] = []
  const dictionaries = new Map<string, unknown>()
  let closeHandler: SidebarRightCloseHandler | undefined
  const model = { state: {} }
  const terminals = {
    retainTabs: vi.fn(), view: vi.fn(() => model), close: vi.fn(), closeFailures: {}, retryClose: vi.fn(),
    launchShells: vi.fn(async () => ({ shells: [], selectedShell: undefined })), selectShell: vi.fn(),
    recover: vi.fn(async (_sessionId: SessionId): Promise<WebTerminalInfo[]> => []),
  }
  let params: { terminalId: WebTerminalId } | { shellPath: string } | undefined
  const occurrence = vi.fn(() => ({ navigation: { getSnapshot: () => ({ params, address: 'sidebar://terminal/content' }) } }))
  const openTabIn = vi.fn()
  const tabsIn = vi.fn(() => [] as { id: string; kind: string }[])
  const openTabs = createSnapshotStore<readonly SidebarRightOpenTab[]>([])
  const commandTarget = vi.fn(), openTabFromTarget = vi.fn()
  const commands: ShortcutCommand[] = []
  ctx.provide('webTerminals', terminals as never)
  ctx.provide('sidebarRight', {
    tabDomain: { occurrence }, openTabIn, tabsIn, openTabs, commandTarget, openTabFromTarget,
    registerCloseHandler: (kind: string, handler: SidebarRightCloseHandler) => { expect(kind).toBe('terminal'); closeHandler = handler; return () => { closeHandler = undefined } },
  } as never)
  ctx.provide('slots', {
    inject: (_name: string, register: () => () => void) => register(),
    register: (options: Omit<typeof entries[number], 'component'>, component: unknown) => { const entry = { ...options, component }; entries.push(entry); return () => { entries.splice(entries.indexOf(entry), 1) } },
  } as never)
  ctx.provide('shortcuts', { register: (command: ShortcutCommand) => {
    commands.push(command)
    return () => { commands.splice(commands.indexOf(command), 1) }
  }, catalog: { getSnapshot: () => SHORTCUT_CATALOG, subscribe: () => () => {} } } as never)
  ctx.provide('locale', {
    bind: () => (key: string) => key,
    register: (name: string, values: unknown) => { dictionaries.set(name, values); return () => { dictionaries.delete(name) } },
  } as never)
  const theme = { preference: 'light' as const, fontSize: 14, active: { id: 'light', colorScheme: 'light' as const, tokens: {} }, themes: [], revision: 0 }
  ctx.provide('theme', { getTheme: () => theme } as never)
  const fiber = await ctx.plugin({ inject, apply })
  return {
    tabs, entries, dictionaries, terminals, model, occurrence, openTabIn, tabsIn, openTabs, theme,
    commandTarget, openTabFromTarget, commands,
    emitTheme() { ctx.emit('theme/change', theme) },
    get closeHandler() { return closeHandler },
    setParams(next: typeof params) { params = next },
    async dispose() { await fiber.dispose(); await ctx.fiber.dispose() },
  }
}

it('registers terminal views without recovery or cleanup slots, then releases contributions on unload', async () => {
  expect(hostApply).not.toThrow()
  const h = await mountPlugin()
  try {
    const definition = h.tabs.get('terminal')!
    expect(definition.title('sidebar://terminal')).toBe('title')
    expect(definition.guide?.map(entry => [entry.order, entry.title(), entry.description?.()])).toEqual([[20, 'new', 'description']])
    const Icon = definition.guide?.[0]?.icon
    if (Icon === undefined) throw new Error('Terminal guide icon was not registered')
    expect(renderToStaticMarkup(createElement(Icon, { size: 22 }))).toContain('width="22"')
    expect(renderToStaticMarkup(createElement(Icon))).toContain('width="36"')
    expect(definition.multiple).toBe(true)
    expect(h.dictionaries.get('sidebarTerminal')).toEqual({ en, zh })
    expect(h.entries.map(entry => [entry.name, entry.component, entry.locale])).toEqual([
      ['sidebar.right.tab.guide.entry', TerminalGuide, 'sidebarTerminal'],
      ['sidebar.right.pane.tab', LazyTerminalBody, 'sidebarTerminal'],
      ['sidebar.right.pane.tab.title', TerminalTitle, 'sidebarTerminal'],
    ])
    const sessionId = 'session' as SessionId
    const launcher = h.entries[0]!.inject(sessionId) as TerminalGuideInjected
    const signal = new AbortController().signal
    await launcher.loadShells(signal)
    expect(h.terminals.launchShells).toHaveBeenCalledWith(sessionId, signal)
    launcher.selectShell('/bin/bash')
    expect(h.terminals.selectShell).toHaveBeenCalledWith('/bin/bash')
    const face = h.entries[1]!.inject(sessionId) as TerminalBodyInjected
    expect(face.hooks.theme.getSnapshot()).toBe(h.theme)
    const changed = vi.fn()
    const unsubscribe = face.hooks.theme.subscribe(changed)
    h.emitTheme()
    expect(changed).toHaveBeenCalledOnce()
    unsubscribe()
    h.emitTheme()
    expect(changed).toHaveBeenCalledOnce()
    expect(face.view('tab')).toBe(h.model)
    expect(h.terminals.view).toHaveBeenLastCalledWith(sessionId, 'tab', 'sidebar://terminal/content', undefined, undefined)
    const terminalId = 'retained' as WebTerminalId
    h.setParams({ terminalId })
    h.setParams({ shellPath: '/bin/bash' })
    face.view('tab')
    expect(h.terminals.view).toHaveBeenLastCalledWith(sessionId, 'tab', 'sidebar://terminal/content', undefined, '/bin/bash')
    h.setParams({ terminalId })
    expect(face.keyedHooks.terminal('tab')).toBe(h.model.state)
    expect(h.terminals.view).toHaveBeenLastCalledWith(sessionId, 'tab', 'sidebar://terminal/content', terminalId, undefined)
    expect(h.occurrence).toHaveBeenLastCalledWith(sessionId, { id: 'tab' })
    if (h.closeHandler === undefined) throw new Error('Terminal close handler was not registered')
    h.closeHandler(sessionId, { id: 'tab', contentId: 'sidebar://terminal/content' } as Parameters<SidebarRightCloseHandler>[1])
    expect(h.terminals.close).toHaveBeenLastCalledWith(sessionId, 'tab', 'sidebar://terminal/content', terminalId)
    h.setParams(undefined)
    h.closeHandler(sessionId, { id: 'new-tab', contentId: 'sidebar://terminal/new' } as Parameters<SidebarRightCloseHandler>[1])
    expect(h.terminals.close).toHaveBeenLastCalledWith(sessionId, 'new-tab', 'sidebar://terminal/new', undefined)
    expect(h.terminals.recover).not.toHaveBeenCalled()
    expect(h.terminals.retryClose).not.toHaveBeenCalled()
    expect(h.openTabIn).not.toHaveBeenCalled()
  } finally {
    await h.dispose()
  }
  expect(h.closeHandler).toBeUndefined()
  expect(h.tabs.get('terminal')).toBeUndefined()
  expect(h.entries).toEqual([])
  expect(h.dictionaries.size).toBe(0)
})

it('opens a terminal for the command target and refuses without a selected Session', async () => {
  const h = await mountPlugin()
  try {
    const command = h.commands[0]!
    const input = { region: 'page', modal: null, target: null } as const
    expect(command.resolve(input)).toEqual({ status: 'blocked', reason: 'shortcut.noSession' })
    const target = { sessionId: 'terminal-session' }
    h.commandTarget.mockReturnValue(target)
    const result = command.resolve(input)
    if (result.status !== 'handled') throw new Error('Expected terminal command to be available')
    result.run()
    expect(h.openTabFromTarget).toHaveBeenCalledWith('terminal', target)
  } finally { await h.dispose() }
  expect(h.commands).toEqual([])
})

it('loads the terminal body implementation when its registered wrapper mounts', async () => {
  render(createElement(LazyTerminalBody, {} as never))
  await waitFor(() => { expect(renderedTerminal).toHaveBeenCalledOnce() })
})

it('retains terminal metadata from dormant layouts and releases its inventory subscription on unload', async () => {
  const h = await mountPlugin()
  const terminal = { sessionId: 'inactive' as SessionId, tabId: 't', kind: 'terminal', contentId: 'terminal' } as SidebarRightOpenTab
  h.openTabs.set([terminal, { ...terminal, kind: 'documentPreview', contentId: 'file' }])
  await expect.poll(() => h.terminals.retainTabs).toHaveBeenLastCalledWith([terminal])
  await h.dispose()
  expect(h.terminals.retainTabs).toHaveBeenLastCalledWith([])
  const calls = h.terminals.retainTabs.mock.calls.length
  h.openTabs.set([terminal])
  await Promise.resolve()
  expect(h.terminals.retainTabs).toHaveBeenCalledTimes(calls)
})
