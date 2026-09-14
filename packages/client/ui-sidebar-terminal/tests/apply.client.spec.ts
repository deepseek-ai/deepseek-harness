// @vitest-environment jsdom
/** Terminal type, copy, seats and explicit cleanup follow the plugin lifetime. */
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Context } from '@deepseek-ai/cordis'
import { expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WebTerminalId, WebTerminalInfo } from '@deepseek-ai/dsh-api-terminal-controller/types'
import { SidebarRightTabRegistry } from '@deepseek-ai/dsh-client-ui-sidebar-right/src/client/tab-registry.ts'
import type { SidebarRightCloseHandler } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { apply, inject } from '../src/client/index.ts'
import { apply as hostApply } from '../src/index.ts'
import { TerminalBody } from '../src/client/TerminalBody.tsx'
import { TerminalTitle } from '../src/client/TerminalTitle.tsx'
import { TerminalRecovery, type TerminalRecoveryInjected } from '../src/client/TerminalRecovery.tsx'
import { TerminalCleanup, type TerminalCleanupInjected } from '../src/client/TerminalCleanup.tsx'
import type { TerminalBodyInjected } from '../src/client/face.ts'
import { en, zh } from '../src/client/locales.ts'

vi.mock('@xterm/xterm', () => ({ Terminal: vi.fn() }))

const terminalInfo = (id: string): WebTerminalInfo => ({ id: id as WebTerminalId, title: id, shell: { path: '/bin/sh', name: 'sh', args: ['-i'] }, cwd: '/workspace', cols: 80, rows: 24, state: 'running', exitCode: null })

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
    view: vi.fn(() => model), close: vi.fn(), closeFailures: {}, retryClose: vi.fn(),
    recover: vi.fn(async (_sessionId: SessionId): Promise<WebTerminalInfo[]> => []),
  }
  let params: { terminalId: WebTerminalId } | undefined
  const occurrence = vi.fn(() => ({ navigation: { getSnapshot: () => ({ params }) } }))
  const openTabIn = vi.fn()
  ctx.provide('webTerminals', terminals as never)
  ctx.provide('sidebarRight', {
    tabDomain: { occurrence }, openTabIn,
    registerCloseHandler: (kind: string, handler: SidebarRightCloseHandler) => { expect(kind).toBe('terminal'); closeHandler = handler; return () => { closeHandler = undefined } },
  } as never)
  ctx.provide('slots', {
    inject: (_name: string, register: () => () => void) => register(),
    register: (options: Omit<typeof entries[number], 'component'>, component: unknown) => { const entry = { ...options, component }; entries.push(entry); return () => { entries.splice(entries.indexOf(entry), 1) } },
  } as never)
  ctx.provide('locale', {
    bind: () => (key: string) => key,
    register: (name: string, values: unknown) => { dictionaries.set(name, values); return () => { dictionaries.delete(name) } },
  } as never)
  const theme = { preference: 'light' as const, fontSize: 14, active: { id: 'light', colorScheme: 'light' as const, tokens: {} }, themes: [], revision: 0 }
  ctx.provide('theme', { getTheme: () => theme } as never)
  const fiber = await ctx.plugin({ inject, apply })
  return {
    tabs, entries, dictionaries, terminals, model, occurrence, openTabIn, theme,
    emitTheme() { ctx.emit('theme/change', theme) },
    get closeHandler() { return closeHandler },
    setParams(next: typeof params) { params = next },
    async dispose() { await fiber.dispose(); await ctx.fiber.dispose() },
  }
}

it('registers terminal views, recovery and cleanup, then releases every contribution on unload', async () => {
  expect(hostApply).not.toThrow()
  const h = await mountPlugin()
  try {
    const definition = h.tabs.get('terminal')!
    expect(definition.title('sidebar://terminal')).toBe('title')
    expect(definition.guide?.map(entry => [entry.order, entry.title(), entry.description?.()])).toEqual([[20, 'new', 'description']])
    const Icon = definition.guide?.[0]?.icon
    if (Icon === undefined) throw new Error('Terminal guide icon was not registered')
    expect(renderToStaticMarkup(createElement(Icon, { size: 22 }))).toContain('width="22"')
    expect(renderToStaticMarkup(createElement(Icon))).toContain('width="26"')
    expect(definition.multiple).toBe(true)
    expect(h.dictionaries.get('sidebarTerminal')).toEqual({ en, zh })
    expect(h.entries.map(entry => [entry.name, entry.component, entry.locale])).toEqual([
      ['sidebar.right.pane.tab', TerminalBody, 'sidebarTerminal'],
      ['sidebar.right.pane.tab.title', TerminalTitle, 'sidebarTerminal'],
      ['conversation.session.header.actions', TerminalRecovery, 'sidebarTerminal'],
      ['shell.overlay', TerminalCleanup, 'sidebarTerminal'],
    ])
    const sessionId = 'session' as SessionId
    const face = h.entries[0]!.inject(sessionId) as TerminalBodyInjected
    expect(face.hooks.theme.getSnapshot()).toBe(h.theme)
    const changed = vi.fn()
    const unsubscribe = face.hooks.theme.subscribe(changed)
    h.emitTheme()
    expect(changed).toHaveBeenCalledOnce()
    unsubscribe()
    h.emitTheme()
    expect(changed).toHaveBeenCalledOnce()
    expect(face.view('tab')).toBe(h.model)
    expect(h.terminals.view).toHaveBeenLastCalledWith(sessionId, 'tab', undefined)
    const terminalId = 'retained' as WebTerminalId
    h.setParams({ terminalId })
    expect(face.keyedHooks.terminal('tab')).toBe(h.model.state)
    expect(h.terminals.view).toHaveBeenLastCalledWith(sessionId, 'tab', terminalId)
    expect(h.occurrence).toHaveBeenLastCalledWith(sessionId, { id: 'tab' })
    if (h.closeHandler === undefined) throw new Error('Terminal close handler was not registered')
    h.closeHandler(sessionId, { id: 'tab' } as Parameters<SidebarRightCloseHandler>[1])
    expect(h.terminals.close).toHaveBeenLastCalledWith(sessionId, 'tab', terminalId)
    h.setParams(undefined)
    h.closeHandler(sessionId, { id: 'new-tab' } as Parameters<SidebarRightCloseHandler>[1])
    expect(h.terminals.close).toHaveBeenLastCalledWith(sessionId, 'new-tab', undefined)
    const cleanupFace = h.entries[3]!.inject(sessionId) as TerminalCleanupInjected
    expect(cleanupFace.hooks.closeFailures).toBe(h.terminals.closeFailures)
    cleanupFace.retryClose('terminal' as Parameters<TerminalCleanupInjected['retryClose']>[0])
    expect(h.terminals.retryClose).toHaveBeenCalledWith('terminal')
  } finally {
    await h.dispose()
  }
  expect(h.closeHandler).toBeUndefined()
  expect(h.tabs.get('terminal')).toBeUndefined()
  expect(h.entries).toEqual([])
  expect(h.dictionaries.size).toBe(0)
})

it('shares pending and completed recovery across Session headers and opens each returned terminal once', async () => {
  const h = await mountPlugin()
  const pending = Promise.withResolvers<WebTerminalInfo[]>()
  h.terminals.recover.mockImplementationOnce(() => pending.promise)
  const sessionId = 'session' as SessionId
  const recovery = h.entries[2]!.inject(sessionId) as TerminalRecoveryInjected
  const remounted = h.entries[2]!.inject(sessionId) as TerminalRecoveryInjected
  const completion = recovery.restore()
  try {
    expect(remounted.restore()).toBe(completion)
    expect(h.terminals.recover).toHaveBeenCalledExactlyOnceWith(sessionId)
    expect(h.openTabIn).not.toHaveBeenCalled()
    pending.resolve([terminalInfo('build'), terminalInfo('tests')])
    await completion
    expect(h.openTabIn.mock.calls).toEqual([
      [sessionId, 'terminal', { params: { terminalId: 'build' } }],
      [sessionId, 'terminal', { params: { terminalId: 'tests' } }],
    ])
    await remounted.restore()
    expect(h.terminals.recover).toHaveBeenCalledTimes(1)
    expect(h.openTabIn).toHaveBeenCalledTimes(2)
    const otherSession = 'other-session' as SessionId
    await (h.entries[2]!.inject(otherSession) as TerminalRecoveryInjected).restore()
    expect(h.terminals.recover).toHaveBeenLastCalledWith(otherSession)
    expect(h.terminals.recover).toHaveBeenCalledTimes(2)
    expect(h.openTabIn).toHaveBeenCalledTimes(2)
  } finally {
    pending.resolve([])
    await completion
    await h.dispose()
  }
})

it('allows a failed Host lookup to be retried without marking the Session recovered', async () => {
  const h = await mountPlugin()
  const unavailable = new Error('Host unavailable')
  h.terminals.recover.mockRejectedValueOnce(unavailable)
  const sessionId = 'session' as SessionId
  const recovery = h.entries[2]!.inject(sessionId) as TerminalRecoveryInjected
  try {
    await expect(recovery.restore()).rejects.toBe(unavailable)
    expect(h.openTabIn).not.toHaveBeenCalled()
    await recovery.restore()
    await recovery.restore()
    expect(h.terminals.recover).toHaveBeenCalledTimes(2)
  } finally {
    await h.dispose()
  }
})

it('does not open retained terminals when their lookup completes after plugin unload', async () => {
  const h = await mountPlugin()
  const pending = Promise.withResolvers<WebTerminalInfo[]>()
  h.terminals.recover.mockImplementationOnce(() => pending.promise)
  const recovery = h.entries[2]!.inject('session' as SessionId) as TerminalRecoveryInjected
  const completion = recovery.restore()
  try {
    expect(h.terminals.recover).toHaveBeenCalledOnce()
    await h.dispose()
    pending.resolve([terminalInfo('build')])
    await completion
    expect(h.openTabIn).not.toHaveBeenCalled()
  } finally {
    pending.resolve([])
    await completion
    await h.dispose()
  }
})
