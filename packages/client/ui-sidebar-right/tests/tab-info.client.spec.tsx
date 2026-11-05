// @vitest-environment jsdom
/** Tab information refuses readers whose committed record and navigation binding disagree. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { keyedObservableHook } from '@deepseek-ai/dsh-client-ui-renderer/src/client/bindings.tsx'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { findTabPane, type TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import type { UseSidebarRightTabInfo } from '../src/client/contract/slots.ts'
import { createSidebarRightStore } from '../src/client/stores.ts'
import { TabDomain, type TabOccurrence } from '../src/client/tab-domain.ts'
import { tabInfoFactory, type TabHookContext } from '../src/client/tab-info.ts'

const SESSION = 's-info' as SessionId
const ADDRESS = 'dsh-resource://file/session/s-info/a.txt'
const domains: TabDomain[] = []

afterEach(() => {
  cleanup()
  for (const domain of domains.splice(0)) domain.dispose()
})

function harness() {
  const instance = createSidebarRightStore(() => ({ kind: 'guide', title: 'Start' })).create()
  const domain = new TabDomain({ openResourceIn: vi.fn(), openTabIn: vi.fn(), closeIn: vi.fn() }, vi.fn())
  domains.push(domain)
  const navigationSources = new Map<string, TabOccurrence['navigation']>()
  const useStore = bindSnapshotSelector(instance)
  // The renderer erases the keyed snapshot type; this family contains only tab navigation sources.
  const useTabNavigation = keyedObservableHook(key => navigationSources.get(key)) as TabHookContext['useTabNavigation']
  // Only sessionId is read from the standard share by this internal factory.
  const standard = { sessionId: SESSION } as Parameters<typeof tabInfoFactory>[0]
  const layout = () => instance.getSnapshot().bySession[SESSION]?.layout
  const sync = (): void => {
    const committed = layout()
    if (committed === undefined) throw new Error('expected the layout to commit')
    domain.sync(SESSION, committed)
  }
  const bind = (tabId: TabId): UseSidebarRightTabInfo => {
    const occurrence = domain.occurrence(SESSION, { id: tabId })
    navigationSources.set(tabId, occurrence.navigation)
    return tabInfoFactory(standard, {
      tabId, title: false, fullscreen: false, active: true, shortcuts: [],
      signal: occurrence.signal, actions: occurrence.tabActions, useStore, useTabNavigation,
    })
  }
  const open = (beforeCommit?: (tabId: TabId) => void, address = ADDRESS): TabId => {
    let opened: TabId | undefined
    instance.actions.openContent(SESSION, { kind: 'text', contentId: address, title: 'a' }, (tabId) => {
      opened = tabId
      domain.navigate(SESSION, tabId, { address, params: undefined })
      beforeCommit?.(tabId)
    })
    if (opened === undefined) throw new Error('expected the tab to open')
    sync()
    return opened
  }
  return { instance, domain, navigationSources, layout, sync, bind, open }
}

function expectUncommitted(useTabInfo: UseSidebarRightTabInfo, tabId: TabId): void {
  const message = `sidebarRight: tab "${tabId}" is not committed in session "${SESSION}"`
  const suppressExpected = (event: ErrorEvent): void => {
    if (event.error instanceof Error && event.error.message === message) event.preventDefault()
  }
  const report = vi.spyOn(console, 'error').mockImplementation(() => {})
  window.addEventListener('error', suppressExpected)
  try {
    expect(() => renderHook(useTabInfo)).toThrow(message)
  } finally {
    window.removeEventListener('error', suppressExpected)
    report.mockRestore()
  }
}

describe('tabInfoFactory committed-record relation', () => {
  it('rejects a navigation before the first layout commit and reads the same record after commit', () => {
    const h = harness()
    const tabId = h.open((opened) => {
      expect(h.layout()).toBeUndefined()
      expectUncommitted(h.bind(opened), opened)
    })
    const view = renderHook(h.bind(tabId))
    expect(view.result.current.tab).toMatchObject({ id: tabId, contentId: ADDRESS })
    expect(view.result.current.tab.signal.aborted).toBe(false)
    expect(view.result.current.tab.navigation.revision).toBe(1)
  })

  it('rejects a retained reader after its record closes, even while its navigation snapshot is held', () => {
    const h = harness()
    const tabId = h.open()
    const useTabInfo = h.bind(tabId)
    const view = renderHook(useTabInfo)
    const { signal, navigation } = view.result.current.tab
    view.unmount()

    h.instance.actions.closeTab(SESSION, tabId)
    h.sync()

    expect(signal.aborted).toBe(true)
    expect(h.layout()?.tabs[tabId]).toBeUndefined()
    expect(h.navigationSources.get(tabId)?.getSnapshot()).toBe(navigation)
    expectUncommitted(useTabInfo, tabId)
  })

  it('rejects a retained record after its keyed navigation binding is released', () => {
    const h = harness()
    const tabId = h.open()
    const useTabInfo = h.bind(tabId)
    const view = renderHook(useTabInfo)
    expect(view.result.current.tab.id).toBe(tabId)
    view.unmount()
    const committed = h.layout()

    h.domain.dispose()
    h.navigationSources.clear()

    expect(h.layout()).toBe(committed)
    expect(h.layout()?.tabs[tabId]).toBeDefined()
    expectUncommitted(useTabInfo, tabId)
  })

  it('keeps the tab identity while its panel follows docking and floating', () => {
    const h = harness()
    const tabId = h.open()
    const view = renderHook(h.bind(tabId))
    const docked = findTabPane(h.layout()!, tabId).id
    expect(view.result.current.tab.id).toBe(tabId)
    expect(view.result.current.panel).toEqual({ id: docked, isFloating: false })

    act(() => { h.instance.actions.floatTab(SESSION, tabId) })
    const floating = findTabPane(h.layout()!, tabId)
    expect(floating.host).toBe('float')
    expect(floating.id).not.toBe(docked)
    expect(view.result.current.tab.id).toBe(tabId)
    expect(view.result.current.panel).toEqual({ id: floating.id, isFloating: true })

    act(() => { h.instance.actions.unfloatPane(SESSION, floating.id) })
    expect(findTabPane(h.layout()!, tabId).host).toBe('dock')
    expect(view.result.current.tab.id).toBe(tabId)
    expect(view.result.current.panel).toEqual({ id: docked, isFloating: false })
  })

  it('keeps floating panel ids and host changes independent across tabs', () => {
    const h = harness()
    const firstId = h.open()
    const secondId = h.open(undefined, 'dsh-resource://file/session/s-info/b.txt')
    const first = renderHook(h.bind(firstId))
    const second = renderHook(h.bind(secondId))
    const docked = first.result.current.panel.id
    expect(second.result.current.panel).toEqual({ id: docked, isFloating: false })

    act(() => { h.instance.actions.floatTab(SESSION, firstId) })
    const firstPane = findTabPane(h.layout()!, firstId).id
    expect(first.result.current.panel).toEqual({ id: firstPane, isFloating: true })
    expect(second.result.current.panel).toEqual({ id: docked, isFloating: false })

    act(() => { h.instance.actions.floatTab(SESSION, secondId) })
    const secondPane = findTabPane(h.layout()!, secondId).id
    expect(new Set([docked, firstPane, secondPane]).size).toBe(3)
    expect(first.result.current.panel).toEqual({ id: firstPane, isFloating: true })
    expect(second.result.current.panel).toEqual({ id: secondPane, isFloating: true })
    expect(first.result.current.tab.id).toBe(firstId)
    expect(second.result.current.tab.id).toBe(secondId)

    act(() => { h.instance.actions.unfloatPane(SESSION, firstPane) })
    expect(first.result.current.panel).toEqual({ id: docked, isFloating: false })
    expect(second.result.current.panel).toEqual({ id: secondPane, isFloating: true })
    expect(first.result.current.tab.id).toBe(firstId)
    expect(second.result.current.tab.id).toBe(secondId)
  })
})
