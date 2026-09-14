// @vitest-environment jsdom
/** Sidebar presentation and tab subscriptions through the production slot renderer. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent } from '@testing-library/react'
import { useState } from 'react'
import { SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type { PaneId, SplitId, TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import { dockPaneIds, getPane } from '@deepseek-ai/dsh-client-ui-dockkit'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { apply, inject } from '../src/client/index.ts'
import { intentsFor } from '../src/client/shell/SidebarRight.tsx'
import type { SidebarRightTabInfo, SidebarRightTabMenuOwnerProps } from '../src/client/contract/slots.ts'
import type { createSidebarRightStore } from '../src/client/stores.ts'

declare module '../src/client/contract/params.ts' {
  interface SidebarRightResourceParamsMap {
    test: { line?: number; x?: number }
  }
}

const SESSION = 's-test' as SessionId
const OTHER = 's-other' as SessionId
const runtimes: SlotTestRuntime[] = []
let getAnimationsDescriptor: PropertyDescriptor | undefined

beforeEach(() => {
  getAnimationsDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'getAnimations')
  Object.defineProperty(Element.prototype, 'getAnimations', { configurable: true, writable: true, value: () => [] })
})

afterEach(async () => {
  try {
    for (const runtime of runtimes.splice(0)) await runtime.dispose()
  } finally {
    vi.restoreAllMocks()
    if (getAnimationsDescriptor === undefined) Reflect.deleteProperty(Element.prototype, 'getAnimations')
    else Object.defineProperty(Element.prototype, 'getAnimations', getAnimationsDescriptor)
  }
})

/** Browser-owned animation completion controlled independently of the test clock. */
function transition(property = 'transform') {
  const done = Promise.withResolvers<Animation>()
  let state: AnimationPlayState = 'running'
  const animation = {
    transitionProperty: property,
    get playState() { return state },
    finished: done.promise,
  } as CSSTransition
  return {
    animation,
    finish: () => { state = 'finished'; done.resolve(animation) },
    cancel: () => { state = 'idle'; done.reject(new DOMException('Transition canceled', 'AbortError')) },
  }
}

async function mountSeat(viewportWidth = 1440, canShow = true, entryCount = 0) {
  const runtime = await SlotTestRuntime.create()
  runtimes.push(runtime)
  const frame = { openRightbar: vi.fn(), closeRightbar: vi.fn() }
  const pin = vi.fn<(address: string, signal: AbortSignal) => void>()
  runtime.ctx.provide('layout', frame as never)
  runtime.ctx.provide('resources', { pin } as never)
  const locale = new LocaleRuntime(runtime.ctx)
  runtime.ctx.provide('locale', locale)
  runtime.slots.installLocale(locale)
  await runtime.declare({
    'rightbar': { kind: 'single', scope: 'root' },
    'conversation.session.header.corner': { kind: 'single', scope: 'session' },
  })
  await runtime.sessions.add({ id: SESSION })
  const feature = await runtime.mount({ inject: [...inject], apply })
  const bodies = new Map<string, SidebarRightTabInfo>()
  const titles = new Map<string, SidebarRightTabInfo>()
  const hooks = new Map<string, PropsRuntime<'sidebar.right.pane.tab'>['useTabInfo']>()
  let mounts = 0
  function Body(props: PropsRuntime<'sidebar.right.pane.tab'>) {
    const info = props.useTabInfo()
    const [instance] = useState(() => ++mounts)
    bodies.set(info.tab.id, info)
    hooks.set(info.tab.id, props.useTabInfo)
    expect(['tabInfo', 'tab', 'paneId', 'visible', 'navigation', 'signal', 'tabActions'].filter(key => key in props)).toEqual([])
    return <span data-tab-body={info.tab.id} data-instance={instance} data-revision={info.tab.navigation.revision} />
  }
  function Title({ useTabInfo }: PropsRuntime<'sidebar.right.pane.tab.title'>) {
    const info = useTabInfo()
    titles.set(info.tab.id, info)
    return <span data-tab-title={info.tab.id}>{info.tab.title}</span>
  }
  await act(async () => {
    runtime.ctx.sidebarRightTabs.register({
      id: 'test/text', kind: 'text', priority: 'builtin', patterns: ['dsh-resource://file/**'],
      title: address => address.slice(address.lastIndexOf('/') + 1),
      guide: Array.from({ length: entryCount }, (_, order) => ({ order, title: () => 'Test', description: () => 'Test page' })),
    })
    runtime.slots.register({ name: 'sidebar.right.pane.tab', key: 'test/text' }, Body)
    runtime.slots.register({ name: 'sidebar.right.pane.tab.title', key: 'test/text' }, Title)
  })
  const view = runtime.renderSlot('rightbar', { width: 420, viewportWidth, canShow })
  const instance = runtime.storeOf('rightbar.session', SESSION) as ReturnType<ReturnType<typeof createSidebarRightStore>['create']>
  const controller = runtime.ctx.sidebarRight
  const layout = () => instance.getSnapshot().bySession[SESSION]!.layout
  const open = (name = 'a.txt', options?: Parameters<typeof controller.openResource>[1]) => {
    act(() => { controller.openResource(`dsh-resource://file/session/s-test/${name}`, options) })
    return controller.active()!
  }
  return { runtime, feature, controller, instance, actions: instance.actions, layout, open, frame, pin, bodies, titles, hooks, view }
}

function element(container: HTMLElement, selector: string): HTMLElement {
  const node = container.querySelector<HTMLElement>(selector)
  if (node === null) throw new Error(`expected ${selector}`)
  return node
}

describe('RightbarSeat presentation', () => {
  it('hides for a global main panel and retains the Session sidebar state', async () => {
    const h = await mountSeat()
    h.open('retained.txt')
    const retained = h.layout()
    act(() => { h.runtime.panelInfo.set({ activePanelId: 'other-panel' as MainPanelId }) })
    expect(h.view.container.querySelector('[data-sidebar-right-panel]')).toBeNull()
    expect(h.frame.closeRightbar).toHaveBeenCalled()
    expect(h.layout()).toBe(retained)
    act(() => { h.runtime.panelInfo.set({ activePanelId: null }) })
    expect(h.view.container.querySelector('[data-sidebar-right-panel]')).not.toBeNull()
    expect(h.layout()).toBe(retained)
  })

  it.each([0, 1, 2])('selects the default from %i guide entries and protects only a sole guide', async (entryCount) => {
    const h = await mountSeat(1440, true, entryCount)
    act(() => { h.controller.toggleExpanded() })
    const initial = Object.values(h.layout().tabs)[0]!
    expect(initial.kind).toBe(entryCount === 1 ? 'text' : 'guide')
    if (entryCount !== 1) {
      expect(h.view.container.querySelectorAll('[data-dockkit-tab-close]')).toHaveLength(0)
      const before = h.layout()
      act(() => { h.controller.close(initial.id) })
      expect(h.layout()).toBe(before)
      fireEvent.contextMenu(element(h.view.container, '[data-dockkit-tab]'))
      expect(document.querySelector('[data-dockkit-tab-menu] [role^="menuitem"]')).toBeNull()
      expect(h.view.container.querySelector('[data-dockkit-add-tab]')).toBeNull()
      return
    }
    expect(h.view.container.querySelector(`[data-dockkit-tab-close="${initial.id}"]`)).not.toBeNull()
    act(() => { h.controller.close(initial.id) })
    expect(h.layout().expanded).toBe(false)
    // The close leaves the layout empty; the next expansion reseeds.
    expect(Object.keys(h.layout().tabs)).toHaveLength(0)
    act(() => { h.controller.toggleExpanded() })
    const reseeded = Object.values(h.layout().tabs)[0]!
    expect(reseeded.kind).toBe('text')
    expect(reseeded.id).not.toBe(initial.id)
    fireEvent.click(element(h.view.container, '[data-dockkit-add-tab]'))
    const guide = Object.values(h.layout().tabs).find(tab => tab.kind === 'guide')!
    expect(h.view.container.querySelector('[data-dockkit-add-tab]')).toBeNull()
    expect(h.view.container.querySelector(`[data-dockkit-tab-close="${reseeded.id}"]`)).not.toBeNull()
    expect(h.view.container.querySelector(`[data-dockkit-tab-close="${guide.id}"]`)).not.toBeNull()
    act(() => { h.controller.close(reseeded.id) })
    expect(h.layout().tabs[reseeded.id]).toBeUndefined()
    expect(h.view.container.querySelector(`[data-dockkit-tab-close="${guide.id}"]`)).toBeNull()
    const preview = h.open('ordinary.txt')
    expect(h.view.container.querySelector(`[data-dockkit-tab-close="${preview.id}"]`)).not.toBeNull()
    act(() => { h.controller.close(preview.id) })
    expect(h.layout().tabs[preview.id]).toBeUndefined()
    expect(Object.keys(h.layout().tabs)).toEqual([guide.id])
    expect(h.view.container.querySelectorAll('[data-dockkit-tab-close]')).toHaveLength(0)
    act(() => { h.controller.split() })
    expect(Object.values(h.layout().tabs).map(tab => tab.kind)).toEqual(['guide', 'text'])
  })

  it('offers close for a floating tab while the docked pane keeps its sole tab', async () => {
    const h = await mountSeat()
    const floating = h.open('floating.txt')
    act(() => { h.controller.float(floating.id) })
    const paneId = getPane(h.layout(), h.layout().floats[0]!).id
    expect(h.view.container.querySelector('[data-dockkit-tab-close]')).toBeNull()
    const close = document.querySelector<HTMLButtonElement>(`[data-dockkit-float-close="${paneId}"]`)
    expect(close).not.toBeNull()

    fireEvent.click(close!)

    expect(h.layout().tabs[floating.id]).toBeUndefined()
    expect(h.layout().floats).toHaveLength(0)
    expect(getPane(h.layout(), h.layout().rootId).tabs).toHaveLength(1)
  })

  it('keeps the panel mounted while collapsed and releases the frame on unmount', async () => {
    const h = await mountSeat()
    const panel = element(h.view.container, '[data-sidebar-right-panel]')
    expect(panel.getAttribute('aria-hidden')).toBe('true')
    expect(h.frame.closeRightbar).toHaveBeenCalled()
    h.open()
    expect(element(h.view.container, '[data-sidebar-right-panel]')).toBe(panel)
    expect(panel.hasAttribute('data-sidebar-right-open')).toBe(true)
    expect(h.frame.openRightbar).toHaveBeenLastCalledWith(true, false)
    await h.runtime.dispose()
    expect(h.frame.closeRightbar).toHaveBeenCalled()
  })

  it('fills the viewport without replacing the content tree or releasing the wide track', async () => {
    const h = await mountSeat()
    const tab = h.open()
    const panel = element(h.view.container, '[data-sidebar-right-panel]')
    const body = element(h.view.container, '[data-tab-body]')
    expect(panel.style.width).toBe('420px')
    fireEvent.click(element(h.view.container, '[data-sidebar-right-mode]'))
    expect(h.layout().mode).toBe('fullscreen')
    expect(panel.style.width).toBe('100%')
    expect(panel.dataset['sidebarRightPanel']).toBe('fullscreen')
    expect(element(h.view.container, '[data-tab-body]')).toBe(body)
    expect(h.frame.openRightbar).toHaveBeenLastCalledWith(true, true)
    expect(h.bodies.get(tab.id)?.sidebar).toEqual({ expanded: true, fullscreen: true })
    fireEvent.click(element(h.view.container, '[data-sidebar-right-mode]'))
    expect(panel.style.width).toBe('420px')
    expect(element(h.view.container, '[data-tab-body]')).toBe(body)
    expect(h.frame.openRightbar).toHaveBeenLastCalledWith(true, false)
    fireEvent.click(element(h.view.container, '[data-sidebar-right-toggle]'))
    expect(h.layout().expanded).toBe(false)
    expect(h.frame.closeRightbar).toHaveBeenCalled()
  })

  it('derives narrow fullscreen without recording mode and returns to normal when widened', async () => {
    const h = await mountSeat(767, false)
    h.open()
    expect(h.layout().mode).toBe('push')
    expect(h.frame.openRightbar).toHaveBeenLastCalledWith(false, true)
    const stored = h.instance.getSnapshot()
    const body = element(h.view.container, '[data-tab-body]')
    h.view.update({ width: 420, viewportWidth: 768, canShow: true })
    expect(h.instance.getSnapshot()).toBe(stored)
    expect(element(h.view.container, '[data-tab-body]')).toBe(body)
    expect(h.frame.openRightbar).toHaveBeenLastCalledWith(true, false)
  })

  it('closes on automatic fullscreen exit and stays closed after widening', async () => {
    const h = await mountSeat(500, false)
    const tab = h.open()
    const signal = h.bodies.get(tab.id)!.tab.signal
    fireEvent.click(element(h.view.container, '[data-sidebar-right-mode]'))
    expect(h.layout().expanded).toBe(false)
    expect(h.layout().mode).toBe('push')
    const stored = h.instance.getSnapshot()
    h.view.update({ width: 420, viewportWidth: 1440, canShow: true })
    expect(h.instance.getSnapshot()).toBe(stored)
    expect(h.layout().tabs[tab.id]).toBeDefined()
    expect(signal.aborted).toBe(false)
    expect(h.layout().expanded).toBe(false)
  })

  it('preserves manual fullscreen through narrow and wide viewport changes', async () => {
    const h = await mountSeat()
    h.open()
    fireEvent.click(element(h.view.container, '[data-sidebar-right-mode]'))
    const stored = h.instance.getSnapshot()
    h.view.update({ width: 420, viewportWidth: 500, canShow: false })
    expect(h.frame.openRightbar).toHaveBeenLastCalledWith(false, true)
    h.view.update({ width: 420, viewportWidth: 1440, canShow: true })
    expect(h.frame.openRightbar).toHaveBeenLastCalledWith(true, true)
    expect(h.instance.getSnapshot()).toBe(stored)
  })

  it('collapses a normal panel that cannot fit without clearing records or reopening on growth', async () => {
    const h = await mountSeat()
    const tab = h.open()
    const signal = h.bodies.get(tab.id)!.tab.signal
    h.view.update({ width: 420, viewportWidth: 900, canShow: false })
    expect(h.layout().expanded).toBe(false)
    expect(h.layout().tabs[tab.id]).toBeDefined()
    expect(signal.aborted).toBe(false)
    const stored = h.instance.getSnapshot()
    h.view.update({ width: 420, viewportWidth: 1440, canShow: true })
    expect(h.instance.getSnapshot()).toBe(stored)
    expect(h.layout().expanded).toBe(false)
  })
})

describe('RightbarSeat fullscreen entry', () => {
  it('retains the previous report until its transform finishes, then leaves the track in place on exit', async () => {
    const h = await mountSeat()
    act(() => { h.actions.setMode(SESSION, 'fullscreen') })
    const panel = element(h.view.container, '[data-sidebar-right-panel]')
    const slide = transition()
    const unrelated = transition('opacity')
    vi.spyOn(panel, 'getAnimations').mockReturnValue([slide.animation, unrelated.animation])
    h.frame.closeRightbar.mockClear()
    h.open()
    expect(panel.hasAttribute('data-sidebar-right-open')).toBe(true)
    expect(panel.dataset['sidebarRightPanel']).toBe('fullscreen')
    expect(h.frame.openRightbar).not.toHaveBeenCalled()
    expect(h.frame.closeRightbar).not.toHaveBeenCalled()
    await act(async () => { slide.finish(); await slide.animation.finished })
    expect(h.frame.openRightbar).toHaveBeenCalledExactlyOnceWith(true, true)
    fireEvent.click(element(h.view.container, '[data-sidebar-right-mode]'))
    expect(h.frame.openRightbar).toHaveBeenLastCalledWith(true, false)
    unrelated.finish()
  })

  it('reports immediately without a transform transition, including zero-duration and reduced-motion entry', async () => {
    const h = await mountSeat()
    act(() => { h.actions.setMode(SESSION, 'fullscreen') })
    const unrelated = transition('opacity')
    const ended = transition()
    ended.finish()
    vi.spyOn(element(h.view.container, '[data-sidebar-right-panel]'), 'getAnimations')
      .mockReturnValue([unrelated.animation, ended.animation])
    h.open()
    expect(h.frame.openRightbar).toHaveBeenCalledExactlyOnceWith(true, true)
    unrelated.finish()
  })

  it('reports when reduced motion cancels the entering transition', async () => {
    const h = await mountSeat(767, false)
    const slide = transition()
    vi.spyOn(element(h.view.container, '[data-sidebar-right-panel]'), 'getAnimations').mockReturnValue([slide.animation])
    h.open()
    expect(h.frame.openRightbar).not.toHaveBeenCalled()
    await act(async () => { slide.cancel(); await Promise.allSettled([slide.animation.finished]) })
    expect(h.frame.openRightbar).toHaveBeenCalledExactlyOnceWith(false, true)
  })

  it('waits for a replacement transform after cancellation', async () => {
    const h = await mountSeat(767, false)
    const first = transition()
    const replacement = transition()
    const animations = vi.spyOn(element(h.view.container, '[data-sidebar-right-panel]'), 'getAnimations')
      .mockReturnValue([first.animation])
    h.open()
    animations.mockReturnValue([replacement.animation])
    await act(async () => { first.cancel(); await Promise.allSettled([first.animation.finished]) })
    expect(h.frame.openRightbar).not.toHaveBeenCalled()
    await act(async () => { replacement.finish(); await replacement.animation.finished })
    expect(h.frame.openRightbar).toHaveBeenCalledExactlyOnceWith(false, true)
  })

  it.each(['close', 'push', 'session', 'unmount'])('ignores a late completion after %s', async (change) => {
    const h = await mountSeat()
    act(() => { h.actions.setMode(SESSION, 'fullscreen') })
    const slide = transition()
    vi.spyOn(element(h.view.container, '[data-sidebar-right-panel]'), 'getAnimations').mockReturnValue([slide.animation])
    h.open()
    expect(h.frame.openRightbar).not.toHaveBeenCalled()
    if (change === 'close') fireEvent.click(element(h.view.container, '[data-sidebar-right-toggle]'))
    else if (change === 'push') fireEvent.click(element(h.view.container, '[data-sidebar-right-mode]'))
    else if (change === 'session') {
      await h.runtime.sessions.add({ id: OTHER })
      act(() => { h.controller.openResource('dsh-resource://file/session/s-other/b.txt') })
    } else await h.runtime.dispose()
    const openCalls = [...h.frame.openRightbar.mock.calls]
    const closeCalls = h.frame.closeRightbar.mock.calls.length
    await act(async () => { slide.finish(); await slide.animation.finished })
    expect(h.frame.openRightbar.mock.calls).toEqual(openCalls)
    expect(h.frame.closeRightbar).toHaveBeenCalledTimes(closeCalls)
  })

  it('uses the current viewport report when entry crosses the fullscreen breakpoint', async () => {
    const h = await mountSeat()
    act(() => { h.actions.setMode(SESSION, 'fullscreen') })
    const slide = transition()
    vi.spyOn(element(h.view.container, '[data-sidebar-right-panel]'), 'getAnimations').mockReturnValue([slide.animation])
    h.open()
    h.view.update({ width: 420, viewportWidth: 500, canShow: false })
    expect(h.frame.openRightbar).not.toHaveBeenCalled()
    await act(async () => { slide.finish(); await slide.animation.finished })
    expect(h.frame.openRightbar).toHaveBeenCalledExactlyOnceWith(false, true)
  })

  it('does not delay normal presentation behind its slide', async () => {
    const h = await mountSeat()
    const slide = transition()
    const animations = vi.spyOn(element(h.view.container, '[data-sidebar-right-panel]'), 'getAnimations')
      .mockReturnValue([slide.animation])
    h.open()
    expect(h.frame.openRightbar).toHaveBeenCalledExactlyOnceWith(true, false)
    expect(animations).not.toHaveBeenCalled()
    slide.finish()
  })
})

describe('slot-owned useTabInfo', () => {
  it('updates body and title navigation with no layout commit and retains the bound hook', async () => {
    const h = await mountSeat()
    const tab = h.open('a.txt', { params: { line: 3 } })
    const stored = h.instance.getSnapshot()
    const hook = h.hooks.get(tab.id)
    const signal = h.bodies.get(tab.id)!.tab.signal
    act(() => { h.controller.tabDomain.navigate(SESSION, tab.id, { address: tab.contentId, params: { line: 7 } }) })
    expect(h.instance.getSnapshot()).toBe(stored)
    expect(h.hooks.get(tab.id)).toBe(hook)
    expect(h.bodies.get(tab.id)?.tab.navigation).toEqual({ address: tab.contentId, params: { line: 7 }, revision: 2 })
    expect(h.titles.get(tab.id)?.tab.navigation).toBe(h.bodies.get(tab.id)?.tab.navigation)
    expect(h.bodies.get(tab.id)?.tab.signal).toBe(signal)
    expect(element(h.view.container, '[data-tab-body]').dataset['revision']).toBe('2')
  })

  it('isolates same-kind record state and reports inactive titles, hiding, floating and docking', async () => {
    const h = await mountSeat()
    const a = h.open('a.txt')
    const b = h.open('b.txt')
    const bodyB = element(h.view.container, '[data-tab-body]')
    expect(h.titles.get(a.id)?.tab.visible).toBe(true)
    act(() => { h.actions.focusTab(SESSION, a.id) })
    const bodyA = element(h.view.container, '[data-tab-body]')
    expect(bodyA.dataset['instance']).not.toBe(bodyB.dataset['instance'])
    expect(bodyA.dataset['tabBody']).toBe(a.id)
    const signal = h.bodies.get(a.id)!.tab.signal
    act(() => { h.actions.setExpanded(SESSION, false) })
    expect(h.bodies.get(a.id)?.tab.visible).toBe(false)
    expect(h.titles.get(a.id)?.tab.visible).toBe(false)
    expect(h.titles.get(b.id)?.tab.visible).toBe(false)
    expect(element(h.view.container, '[data-tab-body]')).toBe(bodyA)
    expect(signal.aborted).toBe(false)
    act(() => { h.controller.float(a.id) })
    expect(h.bodies.get(a.id)?.tab.visible).toBe(true)
    const paneId = h.bodies.get(a.id)!.panel.id
    expect(h.layout().floats).toContain(paneId)
    act(() => { h.controller.dock(paneId) })
    expect(h.layout().floats).toHaveLength(0)
    expect(h.bodies.get(a.id)?.tab.signal).toBe(signal)
  })

  it('keeps session records and navigation while unmounted, aborting only removal and plugin unload', async () => {
    const h = await mountSeat()
    const own = h.open()
    const info = h.bodies.get(own.id)!
    const stored = h.instance.getSnapshot()
    await h.runtime.sessions.add({ id: OTHER })
    expect(h.instance.getSnapshot()).toBe(stored)
    expect(info.tab.signal.aborted).toBe(false)
    act(() => { h.controller.openResource('dsh-resource://file/session/s-other/other.txt', { params: { line: 9 } }) })
    const otherTab = h.controller.active()!
    expect(otherTab.id).toBe(own.id)
    const otherInfo = h.bodies.get(otherTab.id)!
    expect(otherInfo.tab.signal).not.toBe(info.tab.signal)
    act(() => { info.tab.actions.openResource('dsh-resource://file/session/s-test/b.txt') })
    expect(Object.values(h.layout().tabs).map(tab => tab.title)).toContain('b.txt')
    expect(h.controller.active()?.contentId).toBe(otherTab.contentId)
    expect(h.bodies.get(otherTab.id)?.tab.navigation.params).toEqual({ line: 9 })
    act(() => { info.tab.actions.close() })
    expect(info.tab.signal.aborted).toBe(true)
    expect(otherInfo.tab.signal.aborted).toBe(false)
    await h.runtime.sessions.setCurrent(SESSION)
    const remaining = h.bodies.get(h.controller.active()!.id)!
    expect(remaining.tab.navigation.revision).toBe(1)
    await h.feature.dispose()
    expect(remaining.tab.signal.aborted).toBe(true)
    expect(otherInfo.tab.signal.aborted).toBe(true)
    expect(h.runtime.ctx.get('sidebarRight')).toBeUndefined()
  })

  it('updates guide replacements through the same hook and guide boxes through framework injection', async () => {
    const h = await mountSeat()
    // The first expansion seeds the guide the replacement renders over.
    act(() => { h.controller.toggleExpanded() })
    let captured: SidebarRightTabInfo | undefined
    await act(async () => {
      h.runtime.ctx.sidebarRightTabs.register({
        id: 'test/files', kind: 'files', title: () => 'Files',
        guide: [{ order: 1, title: () => 'Files' }],
      })
    })
    expect(h.view.container.querySelector('[data-sidebar-right-guide-entry="files"]')).not.toBeNull()
    await act(async () => {
      h.runtime.slots.register({ name: 'sidebar.right.tab.guide', select: () => true },
        ({ useTabInfo }: PropsRuntime<'sidebar.right.tab.guide'>) => {
          captured = useTabInfo()
          return <span data-guide-replacement={captured.tab.navigation.revision} />
        })
    })
    expect(h.view.container.querySelector('[data-sidebar-right-guide]')).toBeNull()
    expect(captured?.tab.kind).toBe('guide')
    act(() => { h.controller.openTab('guide') })
    const stored = h.instance.getSnapshot()
    const guide = h.controller.active()!
    act(() => { h.controller.tabDomain.navigate(SESSION, guide.id, { address: guide.contentId, params: undefined }) })
    expect(h.instance.getSnapshot()).toBe(stored)
    expect(captured?.tab.navigation.revision).toBe(2)
    expect(element(h.view.container, '[data-guide-replacement]').dataset['guideReplacement']).toBe('2')
    expect(captured?.sidebar.expanded).toBe(true)
  })

  it('follows type replacement and returns to the builtin when it leaves', async () => {
    const h = await mountSeat()
    h.open()
    let release = () => {}
    await act(async () => {
      release = h.runtime.ctx.sidebarRightTabs.register({ id: 'extension/text', kind: 'text', title: () => 'Extension' })
      h.runtime.slots.register({ name: 'sidebar.right.pane.tab', key: 'extension/text' },
        ({ useTabInfo }: PropsRuntime<'sidebar.right.pane.tab'>) => <b data-extension>{useTabInfo().tab.title}</b>)
    })
    expect(element(h.view.container, '[data-extension]').textContent).toBe('a.txt')
    await act(async () => { release() })
    expect(h.view.container.querySelector('[data-extension]')).toBeNull()
    expect(h.view.container.querySelector('[data-tab-body]')).not.toBeNull()
  })

  it('renders unavailable kinds and keeps menu tab/dismiss arguments', async () => {
    const h = await mountSeat()
    let menu: SidebarRightTabMenuOwnerProps | undefined
    await act(async () => {
      h.runtime.slots.register({ name: 'sidebar.right.tab.menu.item', id: 'test' },
        (props: PropsRuntime<'sidebar.right.tab.menu.item'>) => { menu = props; return null })
      h.actions.openContent(SESSION, { kind: 'missing', contentId: 'missing://content', title: 'Missing' }, () => {})
    })
    expect(h.view.container.querySelector('[data-sidebar-right-unavailable]')).not.toBeNull()
    const chip = element(h.view.container, '[data-dockkit-tab]')
    fireEvent.contextMenu(chip)
    expect(menu?.tab.id).toBe(chip.getAttribute('data-dockkit-tab'))
    act(() => { menu?.dismiss() })
    expect(document.querySelector('[data-dockkit-tab-menu]')).toBeNull()
  })

  it('hides split controls at two panes and adds a guide only to a pane without one', async () => {
    const h = await mountSeat()
    // Expanding first seeds the left pane's guide; only the right pane will lack one.
    act(() => { h.controller.toggleExpanded() })
    h.open()
    const splitButtons = () => h.view.container.querySelectorAll<HTMLButtonElement>('[data-dockkit-split-button]')
    expect(splitButtons()).toHaveLength(1)
    act(() => { h.controller.split() })
    expect(dockPaneIds(h.layout())).toHaveLength(2)
    const stored = h.instance.getSnapshot()
    act(() => { expect(h.controller.split()).toBeUndefined() })
    expect(h.instance.getSnapshot()).toBe(stored)
    expect(splitButtons()).toHaveLength(0)
    const right = dockPaneIds(h.layout())[1]!
    h.open('right.txt', { paneId: right })
    const guide = getPane(h.layout(), right).tabs.find(id => h.layout().tabs[id]?.kind === 'guide')!
    act(() => { h.actions.closeTab(SESSION, guide) })
    const add = element(h.view.container, '[data-dockkit-add-tab]')
    expect(add.closest('[data-dockkit-pane]')?.getAttribute('data-dockkit-pane')).toBe(right)
    fireEvent.click(add)
    expect(getPane(h.layout(), right).tabs.filter(id => h.layout().tabs[id]?.kind === 'guide')).toHaveLength(1)
    const closing = [...getPane(h.layout(), right).tabs]
    act(() => { for (const tabId of closing) h.actions.closeTab(SESSION, tabId) })
    expect(dockPaneIds(h.layout())).toHaveLength(1)
    expect(splitButtons()).toHaveLength(1)
    expect(splitButtons()[0]?.disabled).toBe(false)
  })
})

describe('intentsFor — the kit\'s gestures as one session\'s store actions', () => {
  it('binds every intent to the session, and asks the navigation face for a guide on add', () => {
    const actions = {
      focusTab: vi.fn(), focusPane: vi.fn(), splitPane: vi.fn(), closeTab: vi.fn(), duplicateTab: vi.fn(),
      floatTab: vi.fn(), unfloatPane: vi.fn(), placeTab: vi.fn(), dropTab: vi.fn(), moveFloat: vi.fn(),
      resizeFloat: vi.fn(), resizeSplit: vi.fn(),
    }
    const openTab = vi.fn()
    const intents = intentsFor(SESSION, actions as unknown as Parameters<typeof intentsFor>[1], openTab)
    const rect = { x: 1, y: 2, width: 300, height: 200 }
    const TAB_1 = 'tab-1' as TabId
    const PANE_1 = 'pane-1' as PaneId
    const PANE_2 = 'pane-2' as PaneId
    const SPLIT_1 = 'split-1' as SplitId
    intents.focusTab(TAB_1)
    intents.focusPane(PANE_1)
    intents.splitPane(PANE_1)
    intents.closeTab(TAB_1)
    intents.duplicateTab(TAB_1)
    intents.floatTab(TAB_1, rect)
    intents.unfloatPane(PANE_2)
    intents.placeTab(TAB_1, PANE_1, 0)
    intents.dropTab(TAB_1, PANE_1, 'right')
    intents.moveFloat(PANE_2, 30, 40)
    intents.resizeFloat(PANE_2, rect)
    intents.resizeSplit(SPLIT_1, [0.3, 0.7])
    expect(actions.focusTab).toHaveBeenCalledWith(SESSION, TAB_1)
    expect(actions.focusPane).toHaveBeenCalledWith(SESSION, PANE_1)
    expect(actions.splitPane).toHaveBeenCalledWith(SESSION, PANE_1)
    expect(actions.closeTab).toHaveBeenCalledWith(SESSION, TAB_1)
    expect(actions.duplicateTab).toHaveBeenCalledWith(SESSION, TAB_1)
    expect(actions.floatTab).toHaveBeenCalledWith(SESSION, TAB_1, rect)
    expect(actions.unfloatPane).toHaveBeenCalledWith(SESSION, PANE_2)
    expect(actions.placeTab).toHaveBeenCalledWith(SESSION, TAB_1, PANE_1, 0)
    expect(actions.dropTab).toHaveBeenCalledWith(SESSION, TAB_1, PANE_1, 'right')
    expect(actions.moveFloat).toHaveBeenCalledWith(SESSION, PANE_2, 30, 40)
    expect(actions.resizeFloat).toHaveBeenCalledWith(SESSION, PANE_2, rect)
    expect(actions.resizeSplit).toHaveBeenCalledWith(SESSION, SPLIT_1, [0.3, 0.7])
    // The add control is the guide opened by kind, in that pane, beside any guide elsewhere.
    intents.addTab(PANE_1)
    expect(openTab).toHaveBeenCalledWith('guide', { paneId: PANE_1, revealIfOpened: false })
  })
})

it('keeps a resource tab and reports a synchronous cleanup failure from its close button', async () => {
  const h = await mountSeat()
  const tab = h.open('terminal')
  const failure = new Error('process still running')
  const release = h.controller.registerCloseHandler('text', () => { throw failure })
  const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    fireEvent.click(element(h.view.container, `[data-dockkit-tab-close="${tab.id}"]`))
    await expect.poll(() => logged.mock.calls).toEqual([['Sidebar tab close failed:', failure]])
    expect(h.layout().tabs[tab.id]).toBeDefined()
    release()
    fireEvent.click(element(h.view.container, `[data-dockkit-tab-close="${tab.id}"]`))
    expect(h.layout().tabs[tab.id]).toBeUndefined()
  } finally {
    logged.mockRestore()
    release()
  }
})
