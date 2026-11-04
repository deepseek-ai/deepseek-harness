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
import { AgentTerminalOpener, type AgentTerminalOpenerInjected } from '../src/client/AgentTerminalOpener.tsx'
import type { TerminalBodyInjected } from '../src/client/face.ts'
import { en, ja, zh, es, fr, de, ru, pt } from '../src/client/locales.ts'

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
  const represented = new Set<WebTerminalId>()
  const bound = new Map<string, WebTerminalId>()
  const rosterListeners = new Map<SessionId, (terminals: readonly WebTerminalInfo[]) => void>()
  const releaseRoster = vi.fn()
  const terminals = {
    retainTabs: vi.fn(), view: vi.fn(() => model), close: vi.fn(), closeFailures: {}, retryClose: vi.fn(),
    launchShells: vi.fn(async () => ({ shells: [], selectedShell: undefined })), selectShell: vi.fn(),
    recover: vi.fn(async (_sessionId: SessionId): Promise<WebTerminalInfo[]> => []),
    watch: vi.fn((sessionId: SessionId, listener: (terminals: readonly WebTerminalInfo[]) => void) => {
      rosterListeners.set(sessionId, listener)
      return releaseRoster
    }),
    isRepresented: vi.fn((_sessionId: SessionId, id: WebTerminalId) => represented.has(id)),
    bind: vi.fn((_sessionId: SessionId, contentId: string, id: WebTerminalId) => { represented.add(id); bound.set(contentId, id) }),
    boundTerminal: vi.fn((_sessionId: SessionId, contentId: string) => bound.get(contentId)),
  }
  let params: { terminalId: WebTerminalId } | { shellPath: string } | undefined
  const occurrence = vi.fn(() => ({ navigation: { getSnapshot: () => ({ params, address: 'sidebar://terminal/content' }) } }))
  const sidebarTabs: { id: string; kind: string; contentId: string }[] = []
  let adopted = true
  const openTabIn = vi.fn(() => {
    if (adopted) sidebarTabs.push({ id: `tab-${sidebarTabs.length + 1}`, kind: 'terminal', contentId: `sidebar://terminal/${sidebarTabs.length + 1}` })
  })
  const tabsIn = vi.fn(() => [...sidebarTabs])
  const closeIn = vi.fn((_sessionId: SessionId, tabId: string) => { sidebarTabs.splice(sidebarTabs.findIndex(tab => tab.id === tabId), 1) })
  const openTabs = createSnapshotStore<readonly SidebarRightOpenTab[]>([])
  const commandTarget = vi.fn(), openTabFromTarget = vi.fn()
  const commands: ShortcutCommand[] = []
  ctx.provide('webTerminals', terminals as never)
  ctx.provide('sidebarRight', {
    tabDomain: { occurrence }, openTabIn, tabsIn, closeIn, openTabs, commandTarget, openTabFromTarget,
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
  const theme = { preference: 'light' as const, fontSizes: { text: 14, code: 11, terminal: 13 }, fontFamilies: { text: '', code: '', terminal: '' }, active: { id: 'light', colorScheme: 'light' as const, tokens: {} }, themes: [], revision: 0 }
  ctx.provide('theme', { getTheme: () => theme } as never)
  const fiber = await ctx.plugin({ inject, apply })
  return {
    tabs, entries, dictionaries, terminals, model, occurrence, openTabIn, tabsIn, closeIn, sidebarTabs, openTabs, theme,
    commandTarget, openTabFromTarget, commands, represented, rosterListeners, releaseRoster,
    setAdopted(next: boolean) { adopted = next },
    emitTheme() { ctx.emit('theme/change', theme) },
    get closeHandler() { return closeHandler },
    setParams(next: typeof params) { params = next },
    async dispose() { await fiber.dispose(); await ctx.fiber.dispose() },
  }
}

it('registers terminal views and the agent terminal opener without recovery or cleanup slots, then releases contributions on unload', async () => {
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
    expect(h.dictionaries.get('sidebarTerminal')).toEqual({ en, zh, ja, es, fr, de, ru, pt })
    expect(h.entries.map(entry => [entry.name, entry.component, entry.locale])).toEqual([
      ['sidebar.right.tab.guide.entry', TerminalGuide, 'sidebarTerminal'],
      ['sidebar.right.pane.tab', LazyTerminalBody, 'sidebarTerminal'],
      ['sidebar.right.pane.tab.title', TerminalTitle, 'sidebarTerminal'],
      ['conversation.session.header.actions', AgentTerminalOpener, 'sidebarTerminal'],
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
    expect(command.label()).toBe('new')
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

it('opens each running agent terminal once, binds its new tab and skips other terminals', async () => {
  const h = await mountPlugin()
  try {
    const sessionId = 'session' as SessionId
    const entry = h.entries.find(item => item.name === 'conversation.session.header.actions')!
    expect(entry.id).toBe('agent-terminals')
    const opener = entry.inject(sessionId) as AgentTerminalOpenerInjected
    expect(entry.inject(sessionId)).toBe(opener)
    const release = opener.watchAgentTerminals()
    expect(release).toBe(h.releaseRoster)
    const listener = h.rosterListeners.get(sessionId)!
    const base: WebTerminalInfo = {
      id: 'user' as WebTerminalId, title: 'zsh', shell: { path: '/bin/zsh', name: 'zsh', args: ['-i'] }, cwd: '/workspace',
      cols: 80, rows: 24, state: 'running', exitCode: null, origin: 'user', control: 'user',
    }
    const agent: WebTerminalInfo = { ...base, id: 'agent' as WebTerminalId, origin: 'agent', control: 'agent', sandboxMode: 'workspace-write' }
    const exited: WebTerminalInfo = { ...agent, id: 'exited' as WebTerminalId, state: 'exited', exitCode: 0 }
    h.represented.add('shown' as WebTerminalId)
    listener([base, exited, { ...agent, id: 'shown' as WebTerminalId }, agent])
    expect(h.openTabIn).toHaveBeenCalledExactlyOnceWith(sessionId, 'terminal', { params: { terminalId: 'agent' } })
    expect(h.terminals.bind).toHaveBeenCalledExactlyOnceWith(sessionId, 'sidebar://terminal/1', 'agent')
    listener([agent])
    expect(h.openTabIn).toHaveBeenCalledOnce()
    h.setAdopted(false)
    const pending: WebTerminalInfo = { ...agent, id: 'pending' as WebTerminalId }
    listener([pending])
    expect(h.openTabIn).toHaveBeenCalledTimes(2)
    expect(h.terminals.bind).toHaveBeenCalledOnce()
    const props = { watchAgentTerminals: opener.watchAgentTerminals } as Parameters<typeof AgentTerminalOpener>[0]
    const view = render(createElement(AgentTerminalOpener, props))
    expect(view.container.innerHTML).toBe('')
    view.unmount()
    await waitFor(() => { expect(h.releaseRoster).toHaveBeenCalledOnce() })
  } finally {
    await h.dispose()
  }
})

it('closes the tabs of a terminal that leaves the roster in Agent control and keeps taken-over and user tabs', async () => {
  const h = await mountPlugin()
  try {
    const sessionId = 'session' as SessionId
    const entry = h.entries.find(item => item.name === 'conversation.session.header.actions')!
    ;(entry.inject(sessionId) as AgentTerminalOpenerInjected).watchAgentTerminals()
    const listener = h.rosterListeners.get(sessionId)!
    const agent: WebTerminalInfo = {
      id: 'agent' as WebTerminalId, title: 'dev server', shell: { path: '/bin/zsh', name: 'zsh', args: ['-i'] }, cwd: '/workspace',
      cols: 80, rows: 24, state: 'running', exitCode: null, origin: 'agent', control: 'agent', sandboxMode: 'workspace-write',
    }
    const takenOver: WebTerminalInfo = { ...agent, id: 'taken-over' as WebTerminalId }
    listener([agent, takenOver])
    expect(h.sidebarTabs.map(tab => h.terminals.boundTerminal(sessionId, tab.contentId))).toEqual(['agent', 'taken-over'])
    h.sidebarTabs.push({ id: 'guide', kind: 'guide', contentId: 'sidebar://guide' })
    listener([agent, { ...takenOver, control: 'user' }])
    expect(h.closeIn).not.toHaveBeenCalled()
    listener([])
    expect(h.closeIn).toHaveBeenCalledExactlyOnceWith(sessionId, 'tab-1')
    expect(h.sidebarTabs.map(tab => tab.id)).toEqual(['tab-2', 'guide'])
    listener([])
    expect(h.closeIn).toHaveBeenCalledOnce()
  } finally {
    await h.dispose()
  }
})
