// @vitest-environment jsdom
/**
 * The navigator beside a file preview: hidden until the pane asks for it, one
 * tree per pane that a remount or a hide finds as it was, a listing that lives
 * only while the tree is drawn, the current file located, clicks that open or
 * reveal tabs, keyboard focus carried to the pane's next drawing of the tree,
 * the card that sits beside the preview in a row at least 560px wide, floats
 * over it in a row at least 400px wide, and fills a narrower row or a phone's,
 * and its resize bounds.
 */
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { act, cleanup, fireEvent, within } from '@testing-library/react'
import { Context } from '@deepseek-ai/cordis'
import { createSidebarRightController } from '@deepseek-ai/dsh-client-ui-sidebar-right/src/client/service.ts'
import { SidebarRightTabRegistry } from '@deepseek-ai/dsh-client-ui-sidebar-right/src/client/tab-registry.ts'
import { createSidebarRightStore } from '@deepseek-ai/dsh-client-ui-sidebar-right/src/client/stores.ts'
import { sessionFileAddress } from '@deepseek-ai/dsh-util-workspace-path'
import { RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import { DEFAULT_NAVIGATOR_WIDTH } from '../src/client/store.ts'
import type { DirLevel, FilesTreeState } from '../src/client/store.ts'
import { locateFile, navigatorGeometry, relativeFileOf } from '../src/client/store.ts'
import { zh } from '../src/client/locales.ts'
import { mountNavigator, PANE, ROOT, SESSION, TAB } from './mount.client.tsx'
import type { Mounted } from './mount.client.tsx'

const ROOT_LEVEL: DirLevel = {
  entries: [{ name: 'src', type: 'directory' }, { name: 'README.md', type: 'file', size: 1 }],
  truncated: false,
}
const SRC_LEVEL: DirLevel = { entries: [{ name: 'a.ts', type: 'file', size: 1 }, { name: 'b.ts', type: 'file', size: 1 }], truncated: false }
const A = sessionFileAddress(SESSION, 'src/a.ts')
const B = sessionFileAddress(SESSION, 'src/b.ts')

// jsdom lays nothing out and has no scrolling into view; the spec records the request.
beforeEach(() => { Element.prototype.scrollIntoView = vi.fn() })
afterEach(() => {
  cleanup()
  Reflect.deleteProperty(Element.prototype, 'scrollIntoView')
})

/** Show the navigator and answer the root and `src` listings, as revealing `src/…` asks for them. */
async function revealSrc(h: Mounted): Promise<void> {
  act(() => { fireEvent.click(h.view.getByRole('button', { name: zh['navigator.show'] })) })
  await act(() => h.script.watches.ready(ROOT))
  await act(() => h.script.settle({ ok: true, value: ROOT_LEVEL }))
  await act(() => h.script.watches.ready(`${ROOT}/src`))
  await act(() => h.script.settle({ ok: true, value: SRC_LEVEL }))
}

/** Let the task end, and with it what a drawing that went away left for the same task. */
async function endTask(): Promise<void> {
  await act(async () => { await Promise.resolve() })
}

/** The path of the row holding keyboard focus. */
function focusedPath(): string | null | undefined {
  return document.activeElement?.closest('[data-files-path]')?.getAttribute('data-files-path')
}

describe('FileNavigator beside a preview', () => {
  it('stays hidden and lists nothing until the toggle shows it', async () => {
    const h = mountNavigator(A)
    expect(h.view.container.querySelector('[data-files-navigator]')).toBeNull()
    const toggle = h.view.getByRole('button', { name: zh['navigator.show'] })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(h.script.watches.opened).toEqual([])
    act(() => { fireEvent.click(toggle) })
    expect(h.instance.getSnapshot().byPane[PANE]?.open).toBe(true)
    expect(h.view.getByRole('button', { name: zh['navigator.hide'] }).getAttribute('aria-expanded')).toBe('true')
    await act(() => h.script.watches.ready(ROOT))
    expect(h.view.container.querySelector('[data-files-navigator]')).not.toBeNull()
  })

  it('reveals the previewed file once, marks its row, and scrolls it into view', async () => {
    const scrolled = vi.fn()
    Element.prototype.scrollIntoView = scrolled
    const h = mountNavigator(A)
    await revealSrc(h)
    const current = h.view.container.querySelector('[aria-current="true"]')
    expect(current?.closest('[data-files-path]')?.getAttribute('data-files-path')).toBe(`${ROOT}/src/a.ts`)
    expect(scrolled).toHaveBeenCalledTimes(1)
    expect(scrolled.mock.contexts[0]).toBe(current)
    // The reader collapses the directory; a remount of the same file does not reopen it.
    act(() => { fireEvent.click(within(h.view.container.querySelector<HTMLElement>(`[data-files-path="${ROOT}/src"]`)!).getByRole('button', { name: 'src' })) })
    h.view.unmount()
    const back = h.remount()
    expect(within(back.container.querySelector<HTMLElement>(`[data-files-path="${ROOT}/src"]`)!).getByRole('button', { name: 'src' })?.getAttribute('aria-expanded')).toBe('false')
    expect(scrolled).toHaveBeenCalledTimes(1)
  })

  it('keeps the tree, its width and its scroll when another file\'s tab of the pane remounts it', async () => {
    const h = mountNavigator(A)
    await revealSrc(h)
    act(() => { h.instance.actions.resized(PANE, 300) })
    fireEvent.scroll(h.view.container.querySelector('[data-files-body]')!, { target: { scrollTop: 64 } })
    h.view.unmount()
    h.placement.contentId = B
    const back = h.remount()
    expect(back.container.querySelector<HTMLElement>('[data-files-navigator]')?.style.getPropertyValue('--files-navigator-width')).toBe('300px')
    expect(back.container.querySelector('[data-files-body]')?.scrollTop).toBe(64)
    expect(back.container.querySelector('[aria-current="true"]')?.closest('[data-files-path]')?.getAttribute('data-files-path'))
      .toBe(`${ROOT}/src/b.ts`)
    expect(h.script.list).toHaveBeenCalledTimes(2)
    expect(h.script.watches.opened.map(stream => stream.path)).toEqual([ROOT, `${ROOT}/src`])
  })

  it('locates the file of the tab switched to: expands its collapsed ancestors, marks its row, and scrolls it into view', async () => {
    const scrolled = vi.fn()
    Element.prototype.scrollIntoView = scrolled
    const h = mountNavigator(A)
    await revealSrc(h)
    const src = (view: typeof h.view): Element | null | undefined => within(view.container.querySelector<HTMLElement>(`[data-files-path="${ROOT}/src"]`)!).getByRole('button', { name: 'src' })
    act(() => { fireEvent.click(src(h.view)!) })
    expect(src(h.view)?.getAttribute('aria-expanded')).toBe('false')
    h.view.unmount()
    h.placement.contentId = B
    const back = h.remount()
    expect(src(back)?.getAttribute('aria-expanded')).toBe('true')
    const current = back.container.querySelector('[aria-current="true"]')
    expect(current?.closest('[data-files-path]')?.getAttribute('data-files-path')).toBe(`${ROOT}/src/b.ts`)
    expect(scrolled.mock.contexts.at(-1)).toBe(current)
    // A tab outside the workspace marks nothing and leaves the tree as it is.
    back.unmount()
    h.placement.contentId = sessionFileAddress(SESSION, '/elsewhere/c.ts')
    const outside = h.remount()
    expect(outside.container.querySelector('[aria-current]')).toBeNull()
    expect(src(outside)?.getAttribute('aria-expanded')).toBe('true')
  })

  it('keeps the scroll offset when the tree is hidden and shown again', async () => {
    const h = mountNavigator(A)
    await revealSrc(h)
    fireEvent.scroll(h.view.container.querySelector('[data-files-body]')!, { target: { scrollTop: 64 } })
    act(() => { fireEvent.click(h.view.getByRole('button', { name: zh['navigator.hide'] })) })
    act(() => { fireEvent.click(h.view.getByRole('button', { name: zh['navigator.show'] })) })
    expect(h.view.container.querySelector('[data-files-body]')?.scrollTop).toBe(64)
  })

  it('closes the listing while no tab draws the tree, and lists the kept tree again in place', async () => {
    const h = mountNavigator(A)
    await revealSrc(h)
    const streams = [...h.script.watches.opened]
    act(() => { fireEvent.click(h.view.getByRole('button', { name: zh['navigator.hide'] })) })
    await endTask()
    expect(streams.every(stream => stream.signal.aborted)).toBe(true)
    act(() => { fireEvent.click(h.view.getByRole('button', { name: zh['navigator.show'] })) })
    // The kept rows draw at once while the listing reopens.
    expect(h.view.container.querySelector(`[data-files-path="${ROOT}/src/b.ts"]`)).not.toBeNull()
    await act(() => h.script.watches.ready(ROOT, 1))
    await act(() => h.script.settle({ ok: true, value: ROOT_LEVEL }))
    await act(() => h.script.watches.ready(`${ROOT}/src`, 1))
    await act(() => h.script.settle({ ok: true, value: SRC_LEVEL }))
    expect(h.script.list).toHaveBeenCalledTimes(4)
    expect(h.view.container.querySelector('[aria-current="true"]')?.closest('[data-files-path]')?.getAttribute('data-files-path'))
      .toBe(`${ROOT}/src/a.ts`)
  })

  it('forwards only the clicked address to its owner and offers no separate new-tab command', async () => {
    const h = mountNavigator(A)
    await revealSrc(h)
    const row = within(h.view.container.querySelector<HTMLElement>(`[data-files-path="${ROOT}/src/b.ts"]`)!).getByRole('button', { name: 'b.ts' })
    fireEvent.click(row)
    expect(h.onOpen).toHaveBeenCalledExactlyOnceWith(B)
    expect(h.tabActions.openResource).not.toHaveBeenCalled()
    fireEvent.contextMenu(row)
    expect(h.view.queryByRole('menuitem')).toBeNull()
    expect(h.onOpen).toHaveBeenCalledTimes(1)
  })

  it.each([false, true])('replaces the preview with a file not yet open, in its strip slot or its floating panel (floating: %s)', async (floating) => {
    const h = mountNavigator(A)
    await revealSrc(h)
    const registry = new SidebarRightTabRegistry(new Context())
    registry.register({ id: 'text', kind: 'text', patterns: ['dsh-resource://file/**'], title: address => address })
    const sidebar = createSidebarRightController(registry, () => {}, {
      autoFullscreen: () => false,
      openWithFocus: (_session, open) => { open() },
      closeWithFocus: (_session, _pane, close) => { close() },
    })
    const store = createSidebarRightStore(() => ({ kind: 'guide', title: 'Start' })).create()
    onTestFinished(sidebar.adopt(SESSION, store))
    sidebar.show(SESSION)
    sidebar.controller.openResource(sessionFileAddress(SESSION, 'other.ts'))
    sidebar.controller.openResource(A)
    const layout = () => store.getSnapshot().bySession[SESSION]!.layout
    const from = Object.values(layout().tabs).find(tab => tab.contentId === A)!
    if (floating) sidebar.controller.float(from.id)
    const paneOf = (tabId: string) => Object.values(layout().nodes).find(node => node.kind === 'pane' && node.tabs.includes(tabId as never))
    const host = paneOf(from.id)!
    const before = floating ? undefined : host
    const tabActions = sidebar.controller.tabDomain.occurrence(SESSION, { id: from.id }).tabActions
    h.onOpen.mockImplementation((address) => { tabActions.openResource(address, { replaceTab: true }) })
    fireEvent.click(within(h.view.container.querySelector<HTMLElement>(`[data-files-path="${ROOT}/src/b.ts"]`)!).getByRole('button', { name: 'b.ts' }))
    expect(h.onOpen).toHaveBeenLastCalledWith(B)
    expect(layout().tabs[from.id]).toBeUndefined()
    const replaced = Object.values(layout().tabs).find(tab => tab.contentId === B)!
    const landed = paneOf(replaced.id)!
    expect(landed.id).toBe(host.id)
    if (before?.kind === 'pane') expect(landed.kind === 'pane' && landed.tabs.indexOf(replaced.id)).toBe(before.tabs.indexOf(from.id))
    expect(Object.keys(layout().tabs)).toHaveLength(2)
  })

  it.each([
    ['a narrow row', 399, false],
    ['a wide row', 900, false],
    ['a fullscreen viewport', 400, true],
  ] as const)('keeps the source tree unchanged when requesting an open from %s', async (_label, width, fullscreen) => {
    const h = mountNavigator(A)
    h.row.width = width
    await revealSrc(h)
    if (fullscreen) act(() => { h.viewport.report(true) })
    const file = within(h.view.container.querySelector<HTMLElement>(`[data-files-path="${ROOT}/src/b.ts"]`)!).getByRole('button', { name: 'b.ts' })
    file.focus()
    fireEvent.click(file)
    expect(h.onOpen).toHaveBeenLastCalledWith(B)
    expect(h.instance.getSnapshot().byPane[PANE]?.open).toBe(true)
    expect(document.activeElement).toBe(file)
  })

  it('locates nothing for a file outside the workspace', async () => {
    const scrolled = vi.fn()
    Element.prototype.scrollIntoView = scrolled
    const outside = sessionFileAddress(SESSION, '/elsewhere/a.ts')
    const h = mountNavigator(outside)
    act(() => { fireEvent.click(h.view.getByRole('button', { name: zh['navigator.show'] })) })
    await act(() => h.script.watches.ready(ROOT))
    await act(() => h.script.settle({ ok: true, value: ROOT_LEVEL }))
    expect(h.view.container.querySelector('[aria-current]')).toBeNull()
    expect(scrolled).not.toHaveBeenCalled()
    expect(h.script.watches.opened).toHaveLength(1)
  })

  it('sits beside the preview from a 560px row, floats over it from a 400px row, and Escape anywhere in the row closes it, handing focus to the toggle', async () => {
    const aside = (): HTMLElement | null => h.view.container.querySelector<HTMLElement>('[data-files-navigator]')
    const h = mountNavigator(A)
    // A 560px row leaves room for a 224px card beside a 320px body.
    for (const [width, mode, drawn] of [[900, 'push', 260], [560, 'push', 224], [559, 'overlay', 260], [400, 'overlay', 260]] as const) {
      h.row.width = width
      act(() => { h.instance.actions.shown(PANE, true) })
      await act(() => h.script.watches.ready(ROOT))
      expect(aside()?.getAttribute('data-files-navigator-mode')).toBe(mode)
      expect(aside()?.className).toMatch(mode)
      expect(h.view.getByRole('separator', { name: zh['navigator.resize'] })).not.toBeNull()
      expect(aside()?.style.getPropertyValue('--files-navigator-width')).toBe(`${drawn}px`)
      // A modified Escape belongs to someone else.
      fireEvent.keyDown(aside()!, { key: 'Escape', shiftKey: true })
      expect(aside()).not.toBeNull()
      // The preview's part of the row closes it as well.
      act(() => { fireEvent.keyDown(h.view.container.querySelector('[data-test-row]')!, { key: 'Escape' }) })
      expect(aside()).toBeNull()
      expect(h.instance.getSnapshot().byPane[PANE]?.open).toBe(false)
      expect(document.activeElement?.hasAttribute('data-files-navigator-toggle')).toBe(true)
    }
  })

  it('stays shown after a click outside it and after a file opened from it', async () => {
    const h = mountNavigator(A)
    await revealSrc(h)
    fireEvent.pointerDown(h.view.container.querySelector('[data-test-row]')!)
    fireEvent.click(document.body)
    fireEvent.click(within(h.view.container.querySelector<HTMLElement>(`[data-files-path="${ROOT}/src/b.ts"]`)!).getByRole('button', { name: 'b.ts' }))
    expect(h.onOpen).toHaveBeenLastCalledWith(B)
    expect(h.instance.getSnapshot().byPane[PANE]?.open).toBe(true)
    expect(h.view.container.querySelector('[data-files-navigator]')).not.toBeNull()
  })

  it('fills a narrow row without the resize edge, and uses an overlay at 400px', async () => {
    const h = mountNavigator(A)
    h.row.width = 399
    await revealSrc(h)
    const aside = (): HTMLElement | null => h.view.container.querySelector<HTMLElement>('[data-files-navigator]')
    expect(aside()?.getAttribute('data-files-navigator-mode')).toBe('fill')
    expect(h.view.queryByRole('separator')).toBeNull()
    act(() => { fireEvent.click(h.view.getByRole('button', { name: zh['navigator.hide'] })) })
    h.row.width = 400
    act(() => { fireEvent.click(h.view.getByRole('button', { name: zh['navigator.show'] })) })
    expect(aside()?.getAttribute('data-files-navigator-mode')).toBe('overlay')
    expect(h.view.getByRole('separator', { name: zh['navigator.resize'] })).not.toBeNull()
  })

  it.each(['row', 'viewport'] as const)('hands covered content focus to the open tree only when the %s starts filling', async (source) => {
    const h = mountNavigator(A)
    const removed = vi.spyOn(h.viewport, 'removeEventListener')
    onTestFinished(() => { removed.mockRestore() })
    await revealSrc(h)
    const row = h.view.container.querySelector('[data-test-row]')!
    const content = document.createElement('div')
    const button = document.createElement('button')
    const frame = document.createElement('iframe')
    content.append(button, frame)
    row.prepend(content)
    const resize = async (fills: boolean): Promise<void> => {
      act(() => {
        if (source === 'row') {
          h.row.report(fills ? 399 : 900)
        } else {
          h.viewport.report(fills)
        }
      })
      await endTask()
    }
    const navigator = h.view.container.querySelector<HTMLElement>('[data-files-navigator]')!
    const current = navigator.querySelector<HTMLElement>('[aria-current="true"]')!
    const focused = vi.spyOn(current, 'focus')
    for (const focus of [button, frame]) {
      act(() => { focus.focus() })
      focused.mockClear()
      await resize(true)
      expect(h.instance.getSnapshot().byPane[PANE]?.open).toBe(true)
      expect(navigator.contains(document.activeElement)).toBe(true)
      expect(focused).toHaveBeenCalledTimes(1)
      // jsdom permits focus in covered content; another measurement is not a new transition.
      act(() => { focus.focus() })
      await resize(true)
      expect(document.activeElement).toBe(focus)
      expect(focused).toHaveBeenCalledTimes(1)
      await resize(false)
    }
    const outside = document.createElement('button')
    document.body.append(outside)
    onTestFinished(() => { outside.remove() })
    for (const focus of [navigator.querySelector<HTMLElement>('[data-files-body]')!, outside, document.body]) {
      act(() => {
        if (focus === document.body) outside.blur()
        else focus.focus()
      })
      await resize(true)
      expect(h.instance.getSnapshot().byPane[PANE]?.open).toBe(true)
      expect(document.activeElement).toBe(focus)
      await resize(false)
    }
    h.view.unmount()
    expect(removed).toHaveBeenCalledWith('change', expect.any(Function))
    expect(h.row.observers.size).toBe(0)
  })

  it.each(['row', 'viewport'] as const)('hands covered content that the fill blurred before the %s reported it to the open tree, and nothing the reader moved since', async (source) => {
    const h = mountNavigator(A)
    await revealSrc(h)
    const row = h.view.container.querySelector('[data-test-row]')!
    const content = document.createElement('div')
    const button = document.createElement('button')
    const frame = document.createElement('iframe')
    content.append(button, frame)
    row.prepend(content)
    const outside = document.createElement('button')
    document.body.append(outside)
    onTestFinished(() => { outside.remove() })
    const report = (fills: boolean): void => {
      if (source === 'row') {
        h.row.report(fills ? 399 : 900)
      } else {
        h.viewport.report(fills)
      }
    }
    const resize = async (fills: boolean): Promise<void> => {
      act(() => { report(fills) })
      await endTask()
    }
    // The browser applies the fill's `visibility: hidden` and blurs the focused
    // content, which leaves the keyboard on the body, before the observer or
    // the media query reports the new width. jsdom applies neither, so the
    // spec does both in that order.
    const coverAndBlur = (focus: HTMLElement): void => {
      act(() => { focus.focus() })
      content.style.visibility = 'hidden'
      act(() => { focus.blur() })
      expect(document.activeElement).toBe(document.body)
    }
    const uncover = async (): Promise<void> => {
      content.style.visibility = ''
      await resize(false)
    }
    const navigator = h.view.container.querySelector<HTMLElement>('[data-files-navigator]')!
    const current = navigator.querySelector<HTMLElement>('[aria-current="true"]')!
    const focused = vi.spyOn(current, 'focus')
    for (const focus of [frame, button]) {
      coverAndBlur(focus)
      focused.mockClear()
      await resize(true)
      expect(document.activeElement).toBe(current)
      expect(focused).toHaveBeenCalledTimes(1)
      // Another measurement at the same width is not a new transition.
      act(() => { current.blur() })
      await resize(true)
      expect(document.activeElement).toBe(document.body)
      expect(focused).toHaveBeenCalledTimes(1)
      await uncover()
    }
    // Keyboard the reader moved after the fill blurred the content stays where it went.
    const moves: ReadonlyArray<readonly [string, () => void, Element]> = [
      ['another control', () => { outside.focus() }, outside],
      ['a click on nothing focusable', () => { fireEvent.pointerDown(document.body) }, document.body],
      ['the window losing focus', () => { fireEvent.blur(window) }, document.body],
    ]
    for (const [, move, expected] of moves) {
      coverAndBlur(frame)
      act(move)
      focused.mockClear()
      await resize(true)
      expect(document.activeElement).toBe(expected)
      expect(focused).not.toHaveBeenCalled()
      act(() => { outside.blur() })
      await uncover()
    }
    // A blur while the content was still shown is the reader's, not the fill's.
    act(() => { button.focus() })
    act(() => { button.blur() })
    content.style.visibility = 'hidden'
    await resize(true)
    expect(document.activeElement).toBe(document.body)
    expect(focused).not.toHaveBeenCalled()
    await uncover()
    // A measurement that is not a fill ends the blurred content's claim.
    coverAndBlur(frame)
    await resize(false)
    await resize(true)
    expect(document.activeElement).toBe(document.body)
    expect(focused).not.toHaveBeenCalled()
    await uncover()
    // A reader who closes the tree before the fill is reported keeps it closed.
    coverAndBlur(frame)
    act(() => {
      h.instance.actions.shown(PANE, false)
      report(true)
    })
    await endTask()
    expect(h.instance.getSnapshot().byPane[PANE]?.open).toBe(false)
    expect(focused).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(document.body)
  })

  it('releases the listeners it adds for covered content with its drawing', async () => {
    // A spy on EventTarget.prototype does not see jsdom's window listeners.
    const spies = [EventTarget.prototype, window].map(target => ({
      add: vi.spyOn(target, 'addEventListener'),
      remove: vi.spyOn(target, 'removeEventListener'),
    }))
    onTestFinished(() => {
      for (const spy of spies) {
        spy.add.mockRestore()
        spy.remove.mockRestore()
      }
    })
    const calls = (which: 'add' | 'remove') => spies.flatMap(spy => spy[which].mock.calls.map(([type, listener], index) => [spy[which].mock.contexts[index], type, listener] as const))
    const h = mountNavigator(A)
    act(() => { h.instance.actions.shown(PANE, true) })
    await act(() => h.script.watches.ready(ROOT))
    const row = h.view.container.querySelector('[data-test-row]')!
    const added = calls('add')
    const watched = (target: EventTarget, type: string) => {
      const listeners = added.filter(([at, name]) => at === target && name === type).map(([, , listener]) => listener)
      return [...new Set(listeners)].map(listener => [target, type, listener] as const)
    }
    const covering = [...watched(row, 'focusout'), ...watched(document, 'focusin'), ...watched(document, 'pointerdown'), ...watched(window, 'blur')]
    expect(covering).toHaveLength(4)
    h.view.unmount()
    const removed = calls('remove')
    for (const [target, type, listener] of covering) {
      expect(removed.some(([at, name, gone]) => at === target && name === type && gone === listener)).toBe(true)
    }
  })

  it.each(['show', 'shortcut'] as const)('hands body focus to the tree once on its first narrow drawing through %s', async (source) => {
    const h = mountNavigator(A)
    h.row.width = 399
    const row = h.view.container.querySelector<HTMLElement>('[data-test-row]')!
    const button = document.createElement('button')
    row.prepend(button)
    act(() => { button.focus() })
    // A layout read can blur a now-hidden body before returning its new width.
    const measure = vi.spyOn(row, 'getBoundingClientRect').mockImplementation(() => {
      button.blur()
      return { x: 0, y: 0, top: 0, left: 0, bottom: 0, right: 399, width: 399, height: 0, toJSON: () => ({}) }
    })
    onTestFinished(() => { measure.mockRestore() })
    act(() => {
      if (source === 'shortcut') h.face.focus(PANE)
      else h.instance.actions.shown(PANE, true)
    })
    const tree = h.view.container.querySelector<HTMLElement>('[data-files-body]')!
    const focused = vi.spyOn(tree, 'focus')
    await endTask()
    expect(h.instance.getSnapshot().byPane[PANE]?.open).toBe(true)
    expect(document.activeElement).toBe(tree)
    expect(focused).toHaveBeenCalledTimes(1)
  })

  it('moves the keyboard from the resize edge to the tree when a new row width removes or hides the edge', async () => {
    const h = mountNavigator(A)
    await revealSrc(h)
    const resized = async (width: number): Promise<void> => {
      act(() => { h.row.report(width) })
      await endTask()
    }
    // Queried by attribute: the accessibility query skips the edge while it is hidden.
    const edge = (): HTMLElement => h.view.container.querySelector<HTMLElement>('[data-files-navigator-resize]')!
    // A width that keeps the edge drawn leaves the keyboard on it.
    act(() => { edge().focus() })
    await resized(800)
    expect(document.activeElement).toBe(edge())
    // A width at which the tree fills the row removes the edge.
    await resized(399)
    expect(h.view.queryByRole('separator')).toBeNull()
    expect(focusedPath()).toBe(`${ROOT}/src/a.ts`)
    // The fullscreen viewport hides the edge with CSS; jsdom applies no media query, so the style stands in.
    await resized(900)
    act(() => { edge().focus() })
    edge().style.display = 'none'
    await resized(900)
    expect(focusedPath()).toBe(`${ROOT}/src/a.ts`)
    // A browser blurs an edge that CSS hides before the row reports a new width.
    act(() => { edge().focus() })
    edge().style.display = 'none'
    act(() => { edge().blur() })
    await endTask()
    expect(focusedPath()).toBe(`${ROOT}/src/a.ts`)
    // A blur that leaves the edge drawn leaves the keyboard where it went.
    edge().style.display = ''
    act(() => { edge().focus() })
    act(() => { edge().blur() })
    await endTask()
    expect(document.activeElement).toBe(document.body)
    // That blur ends the edge's hold, so a later width that removes the edge leaves the keyboard alone.
    await resized(399)
    expect(document.activeElement).toBe(document.body)
    await resized(900)
    // Keyboard moved elsewhere in the meantime stays there.
    edge().style.display = ''
    act(() => { edge().focus() })
    act(() => { h.row.report(399) })
    act(() => { h.view.getByRole('button', { name: zh['navigator.hide'] }).focus() })
    await endTask()
    expect(document.activeElement?.hasAttribute('data-files-navigator-toggle')).toBe(true)
  })

  it('keeps the face beside its tab while any of the tab\'s drawings remains, and focuses the drawing that replaced another', async () => {
    const h = mountNavigator(A)
    await revealSrc(h)
    expect(h.beside(TAB)).toBe(true)
    // A loading drawing and its loaded successor each place the face; the first going leaves it placed.
    h.remount().unmount()
    expect(h.beside(TAB)).toBe(true)
    h.view.unmount()
    const next = h.remount()
    act(() => { h.face.focus(PANE) })
    await endTask()
    expect(next.container.contains(document.activeElement)).toBe(true)
    next.unmount()
    expect(h.beside(TAB)).toBe(false)
  })

  it('resizes from its left edge by keyboard and primary-button pointer, leaving the 900px row\'s body at least 320px', async () => {
    const h = mountNavigator(A)
    act(() => { h.instance.actions.shown(PANE, true) })
    await act(() => h.script.watches.ready(ROOT))
    const edge = h.view.getByRole('separator', { name: zh['navigator.resize'] })
    const width = (): number | undefined => h.instance.getSnapshot().byPane[PANE]?.width
    expect(edge.getAttribute('aria-valuenow')).toBe(String(DEFAULT_NAVIGATOR_WIDTH))
    expect(edge.getAttribute('aria-valuemin')).toBe('180')
    expect(edge.getAttribute('aria-valuemax')).toBe('564')
    fireEvent.keyDown(edge, { key: 'ArrowLeft' })
    expect(width()).toBe(DEFAULT_NAVIGATOR_WIDTH + 20)
    fireEvent.keyDown(edge, { key: 'ArrowRight' })
    fireEvent.keyDown(edge, { key: 'Enter' })
    expect(width()).toBe(DEFAULT_NAVIGATOR_WIDTH)
    fireEvent.keyDown(edge, { key: 'End' })
    expect(width()).toBe(564)
    fireEvent.keyDown(edge, { key: 'Home' })
    expect(width()).toBe(180)
    act(() => { h.instance.actions.resized(PANE, DEFAULT_NAVIGATOR_WIDTH) })

    const capture = vi.fn()
    const release = vi.fn()
    edge.setPointerCapture = capture
    edge.releasePointerCapture = release
    fireEvent.pointerMove(edge, { clientX: 0 })
    expect(width()).toBe(DEFAULT_NAVIGATOR_WIDTH)
    // A secondary press does not start a drag.
    fireEvent.pointerDown(edge, { clientX: 500, pointerId: 1, button: 2 })
    fireEvent.pointerMove(edge, { clientX: 400 })
    expect(capture).not.toHaveBeenCalled()
    expect(width()).toBe(DEFAULT_NAVIGATOR_WIDTH)
    fireEvent.pointerDown(edge, { clientX: 500, pointerId: 1, button: 0 })
    expect(h.view.container.querySelector('[data-files-navigator]')?.className).toMatch(/dragging/)
    fireEvent.pointerMove(edge, { clientX: 400 })
    expect(width()).toBe(DEFAULT_NAVIGATOR_WIDTH + 100)
    fireEvent.pointerMove(edge, { clientX: -1000 })
    expect(width()).toBe(564)
    fireEvent.pointerUp(edge, { pointerId: 1 })
    expect(release).toHaveBeenCalledWith(1)
    fireEvent(edge, new Event('lostpointercapture', { bubbles: true }))
    expect(h.view.container.querySelector('[data-files-navigator]')?.className).not.toMatch(/dragging/)
  })

  it('carries the tree\'s keyboard focus to the pane\'s next drawing of it in the same task only', async () => {
    const h = mountNavigator(A)
    await revealSrc(h)
    act(() => { within(h.view.container.querySelector<HTMLElement>(`[data-files-path="${ROOT}/src/b.ts"]`)!).getByRole('button', { name: 'b.ts' }).focus() })
    h.view.unmount()
    h.placement.contentId = B
    const back = h.remount()
    await endTask()
    expect(focusedPath()).toBe(`${ROOT}/src/b.ts`)
    // A drawing that comes back after the task ended, as after a tab without the tree, leaves the keyboard alone.
    back.unmount()
    await endTask()
    h.remount()
    await endTask()
    expect(document.activeElement).toBe(document.body)
  })

  it('gives the carried focus to the drawing in place when the task ends, after the tab draws the tree again', async () => {
    const h = mountNavigator(A)
    await revealSrc(h)
    act(() => { within(h.view.container.querySelector<HTMLElement>(`[data-files-path="${ROOT}/src/a.ts"]`)!).getByRole('button', { name: 'a.ts' }).focus() })
    h.view.unmount()
    // A loading preview draws the tree, and its loaded state draws it again in the same task.
    h.remount().unmount()
    const loaded = h.remount()
    await endTask()
    expect(focusedPath()).toBe(`${ROOT}/src/a.ts`)
    expect(loaded.container.contains(document.activeElement)).toBe(true)
    // A drawing gone before the task ends takes nothing.
    act(() => { (document.activeElement as HTMLElement).blur() })
    act(() => { h.face.focus(PANE) })
    loaded.unmount()
    await endTask()
    expect(document.activeElement).toBe(document.body)
  })

  it('takes keyboard focus when asked, at its next drawing or at once', async () => {
    const h = mountNavigator('sidebar://files')
    act(() => { h.face.focus(PANE) })
    await act(() => h.script.watches.ready(ROOT))
    expect(document.activeElement?.hasAttribute('data-files-body')).toBe(true)
    act(() => { (document.activeElement as HTMLElement).blur() })
    act(() => { h.face.focus(PANE) })
    await endTask()
    expect(document.activeElement?.hasAttribute('data-files-body')).toBe(true)
  })

  it('keeps the pane\'s tree when a preview is replaced in place by the file it opened', async () => {
    const h = mountNavigator(A)
    await revealSrc(h)
    expect(h.beside(TAB)).toBe(true)
    act(() => { h.instance.actions.resized(PANE, 300) })
    fireEvent.scroll(h.view.container.querySelector('[data-files-body]')!, { target: { scrollTop: 64 } })
    fireEvent.click(within(h.view.container.querySelector<HTMLElement>(`[data-files-path="${ROOT}/src/b.ts"]`)!).getByRole('button', { name: 'b.ts' }))
    expect(h.onOpen).toHaveBeenLastCalledWith(B)
    // The new tab draws in the same pane, in the task the opener's tab closes in.
    const next = new AbortController()
    onTestFinished(() => { next.abort() })
    h.view.unmount()
    h.controller.abort()
    Object.assign(h.placement, { tabId: 'tab-2', signal: next.signal, contentId: B })
    const back = h.remount()
    await endTask()
    expect(back.container.querySelector<HTMLElement>('[data-files-navigator]')?.style.getPropertyValue('--files-navigator-width')).toBe('300px')
    expect(back.container.querySelector('[data-files-body]')?.scrollTop).toBe(64)
    expect(back.container.querySelector('[aria-current="true"]')?.closest('[data-files-path]')?.getAttribute('data-files-path'))
      .toBe(`${ROOT}/src/b.ts`)
    expect(h.script.list).toHaveBeenCalledTimes(2)
    expect(h.beside(TAB)).toBe(false)
  })

  it('leaves an Escape to a handler in the row that kept it, and to anything outside the row', async () => {
    const h = mountNavigator(A)
    act(() => { h.instance.actions.shown(PANE, true) })
    await act(() => h.script.watches.ready(ROOT))
    const aside = h.view.container.querySelector<HTMLElement>('[data-files-navigator]')!
    const keep = (event: KeyboardEvent): void => { event.preventDefault() }
    aside.addEventListener('keydown', keep)
    fireEvent.keyDown(aside, { key: 'Escape' })
    aside.removeEventListener('keydown', keep)
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(h.view.container.querySelector('[data-files-navigator]')).not.toBeNull()
    expect(h.instance.getSnapshot().byPane[PANE]?.open).toBe(true)
  })

  it('lists files no tab type can open without opening them, and opens them once one can', async () => {
    const h = mountNavigator(A)
    await revealSrc(h)
    act(() => { h.viewers.set(false) })
    const row = (): HTMLElement => h.view.container.querySelector<HTMLElement>(`[data-files-path="${ROOT}/src/b.ts"]`)!
    expect(row().querySelector('button')).toBeNull()
    expect(row().querySelector('[aria-disabled="true"]')?.getAttribute('title')).toBe(zh['entry.noViewer'])
    // Directories still open.
    expect(within(h.view.container.querySelector<HTMLElement>(`[data-files-path="${ROOT}/src"]`)!).getByRole('button', { name: 'src' })).not.toBeNull()
    act(() => { h.viewers.set(true) })
    fireEvent.click(row().querySelector('button')!)
    expect(h.onOpen).toHaveBeenLastCalledWith(B)
  })

  it('waits for a kept tree\'s fresh listing before finishing a reveal, so a directory created while the tree was hidden opens to the file', async () => {
    const scrolled = vi.fn()
    Element.prototype.scrollIntoView = scrolled
    const h = mountNavigator(A)
    await revealSrc(h)
    act(() => { fireEvent.click(h.view.getByRole('button', { name: zh['navigator.hide'] })) })
    await endTask()
    h.view.unmount()
    h.placement.contentId = sessionFileAddress(SESSION, 'lib/c.ts')
    const back = h.remount()
    act(() => { fireEvent.click(back.getByRole('button', { name: zh['navigator.show'] })) })
    // The kept root level lacks `lib` until it is listed again.
    expect(h.instance.getSnapshot().byPane[PANE]?.tree?.levels[ROOT]).toMatchObject({ kind: 'ready', refreshing: true })
    expect(back.container.querySelector(`[data-files-path="${ROOT}/lib"]`)).toBeNull()
    await act(() => h.script.watches.ready(ROOT, 1))
    await act(() => h.script.settle({ ok: true, value: { entries: [{ name: 'lib', type: 'directory' }, ...ROOT_LEVEL.entries], truncated: false } }))
    expect(within(back.container.querySelector<HTMLElement>(`[data-files-path="${ROOT}/lib"]`)!).getByRole('button', { name: 'lib' })?.getAttribute('aria-expanded')).toBe('true')
    await act(() => h.script.watches.ready(`${ROOT}/lib`))
    await act(() => h.script.settle({ ok: true, value: { entries: [{ name: 'c.ts', type: 'file', size: 1 }], truncated: false } }))
    const current = back.container.querySelector('[aria-current="true"]')
    expect(current?.closest('[data-files-path]')?.getAttribute('data-files-path')).toBe(`${ROOT}/lib/c.ts`)
    expect(scrolled.mock.contexts.at(-1)).toBe(current)
    await act(() => h.script.watches.ready(`${ROOT}/src`, 1))
    await act(() => h.script.settle({ ok: true, value: SRC_LEVEL }))
    expect(h.instance.getSnapshot().byPane[PANE]?.tree?.levels[`${ROOT}/src`]).toEqual({ kind: 'ready', level: SRC_LEVEL })
  })

  it('finishes a reveal on the kept listings below a directory that fails to list again, so its ancestors stay collapsible', async () => {
    const h = mountNavigator(A)
    await revealSrc(h)
    act(() => { fireEvent.click(h.view.getByRole('button', { name: zh['navigator.hide'] })) })
    await endTask()
    h.view.unmount()
    h.placement.contentId = sessionFileAddress(SESSION, 'src/new.ts')
    const back = h.remount()
    act(() => { fireEvent.click(back.getByRole('button', { name: zh['navigator.show'] })) })
    expect(h.instance.getSnapshot().byPane[PANE]?.tree?.levels[`${ROOT}/src`]).toMatchObject({ refreshing: true })
    await act(() => h.script.watches.ready(ROOT, 1))
    await act(() => h.script.settle({ ok: false, error: new RemoteError('workspace-file/not-found', 'gone', { path: ROOT }) }))
    expect(h.instance.getSnapshot().byPane[PANE]?.tree?.levels[`${ROOT}/src`]).toEqual({ kind: 'ready', level: SRC_LEVEL })
    const src = (): HTMLElement => within(back.container.querySelector<HTMLElement>(`[data-files-path="${ROOT}/src"]`)!).getByRole('button', { name: 'src' })
    act(() => { fireEvent.click(src()) })
    expect(src().getAttribute('aria-expanded')).toBe('false')
    expect(back.container.querySelector('[aria-current="true"]')).toBeNull()
  })

  it('places the face beside its tab only with a workspace, and a tree shown once one appears takes no focus', async () => {
    const h = mountNavigator(A, {}, null)
    expect(h.beside(TAB)).toBe(false)
    h.placement.cwd = ROOT
    h.rerender()
    expect(h.beside(TAB)).toBe(true)
    act(() => { h.instance.actions.shown(PANE, true) })
    await act(() => h.script.watches.ready(ROOT))
    await endTask()
    expect(h.view.container.querySelector('[data-files-navigator]')).not.toBeNull()
    expect(document.activeElement).toBe(document.body)
    h.placement.cwd = null
    h.rerender()
    expect(h.beside(TAB)).toBe(false)
    expect(h.instance.getSnapshot().byPane[PANE]?.open).toBe(true)
  })

  it('draws neither control without a workspace', () => {
    const h = mountNavigator(A, {}, null)
    act(() => { h.instance.actions.shown(PANE, true) })
    expect(h.view.container.querySelector('[data-files-navigator-toggle]')).toBeNull()
    expect(h.view.container.querySelector('[data-files-navigator]')).toBeNull()
    expect(h.script.watches.opened).toEqual([])
  })
})

describe('navigatorGeometry', () => {
  it('beside the body from a 560px row, leaves its 16px of card margins and 320px of body', () => {
    expect(navigatorGeometry(560, 260)).toEqual({ minimum: 180, maximum: 224, width: 224 })
    expect(navigatorGeometry(800, 260)).toEqual({ minimum: 180, maximum: 464, width: 260 })
    expect(navigatorGeometry(1200, 260)).toEqual({ minimum: 180, maximum: 864, width: 260 })
    expect(navigatorGeometry(900, 100)).toMatchObject({ width: 180 })
    // A preference wider than the row allows draws at the bound, so dragging never narrows the body past 320px.
    for (const row of [560, 800, 1200]) expect(row - 16 - navigatorGeometry(row, 10_000).width).toBe(320)
  })

  it('floating over the body below a 560px row, leaves 120px of it uncovered', () => {
    expect(navigatorGeometry(559, 600)).toEqual({ minimum: 180, maximum: 439, width: 439 })
    expect(navigatorGeometry(400, 260)).toEqual({ minimum: 180, maximum: 280, width: 260 })
    expect(navigatorGeometry(399, 260)).toEqual({ minimum: 180, maximum: 279, width: 260 })
    expect(navigatorGeometry(391, 260)).toEqual({ minimum: 180, maximum: 271, width: 260 })
    expect(navigatorGeometry(250, 260)).toEqual({ minimum: 130, maximum: 130, width: 130 })
    expect(navigatorGeometry(100, 260)).toEqual({ minimum: 0, maximum: 0, width: 0 })
  })

  it('draws the preference beside an unmeasured row', () => {
    expect(navigatorGeometry(undefined, 260)).toEqual({ minimum: 180, maximum: 260, width: 260 })
    expect(navigatorGeometry(undefined, 100)).toEqual({ minimum: 180, maximum: 180, width: 180 })
  })
})

describe('relativeFileOf', () => {
  it('reads this Session\'s files under the root, by relative or contained absolute path', () => {
    expect(relativeFileOf(sessionFileAddress(SESSION, 'src/a.ts'), SESSION, ROOT)).toBe('src/a.ts')
    expect(relativeFileOf(sessionFileAddress(SESSION, `${ROOT}/src/a.ts`), SESSION, ROOT)).toBe('src/a.ts')
    expect(relativeFileOf(sessionFileAddress(SESSION, 'C:/work/app/src/a.ts'), SESSION, 'C:\\work\\app')).toBe('src/a.ts')
  })

  it('contains a Windows drive or UNC path regardless of case and separators, and a POSIX path only in the root\'s case', () => {
    expect(relativeFileOf(sessionFileAddress(SESSION, 'c:/work/app/src/a.ts'), SESSION, 'C:\\Work\\App')).toBe('src/a.ts')
    expect(relativeFileOf(sessionFileAddress(SESSION, 'C:\\WORK\\APP\\src\\a.ts'), SESSION, 'c:/work/app/')).toBe('src/a.ts')
    expect(relativeFileOf(sessionFileAddress(SESSION, '\\\\Host\\Share\\src\\a.ts'), SESSION, '\\\\host\\share')).toBe('src/a.ts')
    expect(relativeFileOf(sessionFileAddress(SESSION, '//host/share/src/a.ts'), SESSION, '\\\\HOST\\SHARE')).toBe('src/a.ts')
    expect(relativeFileOf(sessionFileAddress(SESSION, '/Work/App/src/a.ts'), SESSION, '/work/app')).toBeUndefined()
  })

  it('reads nothing for another Session, another scope, a path outside the root, or dot segments', () => {
    expect(relativeFileOf(sessionFileAddress('s-other', 'src/a.ts'), SESSION, ROOT)).toBeUndefined()
    expect(relativeFileOf('sidebar://files', SESSION, ROOT)).toBeUndefined()
    expect(relativeFileOf(sessionFileAddress(SESSION, '/elsewhere/a.ts'), SESSION, ROOT)).toBeUndefined()
    expect(relativeFileOf(sessionFileAddress(SESSION, ''), SESSION, ROOT)).toBeUndefined()
    expect(relativeFileOf(sessionFileAddress(SESSION, 'src/../a.ts'), SESSION, ROOT)).toBeUndefined()
  })
})

describe('locateFile', () => {
  const tree = (root: string, levels: FilesTreeState['levels']): FilesTreeState => ({ root, levels, expanded: [root], autoRefresh: true })

  it('walks listed levels to the file and waits on a level still listing', () => {
    expect(locateFile(tree(ROOT, {}), 'src/a.ts')).toEqual({ ancestors: [], current: undefined, pending: true })
    const listed = tree(ROOT, { [ROOT]: { kind: 'ready', level: ROOT_LEVEL }, [`${ROOT}/src`]: { kind: 'loading' } })
    expect(locateFile(listed, 'src/a.ts')).toEqual({ ancestors: [{ parent: ROOT, path: `${ROOT}/src` }], current: undefined, pending: true })
    const full = tree(ROOT, { [ROOT]: { kind: 'ready', level: ROOT_LEVEL }, [`${ROOT}/src`]: { kind: 'ready', level: SRC_LEVEL } })
    expect(locateFile(full, 'src/a.ts')).toEqual({ ancestors: [{ parent: ROOT, path: `${ROOT}/src` }], current: `${ROOT}/src/a.ts`, pending: false })
  })

  it('stops at a failed level or a missing name, and matches case only under a Windows root', () => {
    const failed = tree(ROOT, { [ROOT]: { kind: 'failed', failure: { code: 'workspace-file/not-found', message: 'gone' } as never } })
    expect(locateFile(failed, 'src/a.ts')).toEqual({ ancestors: [], current: undefined, pending: false })
    const listed = tree(ROOT, { [ROOT]: { kind: 'ready', level: ROOT_LEVEL } })
    expect(locateFile(listed, 'readme.md')).toEqual({ ancestors: [], current: undefined, pending: false })
    // A level listed again may still gain the name.
    const refreshing = tree(ROOT, { [ROOT]: { kind: 'ready', level: ROOT_LEVEL, refreshing: true } })
    expect(locateFile(refreshing, 'readme.md')).toEqual({ ancestors: [], current: undefined, pending: true })
    expect(locateFile(refreshing, 'README.md')).toEqual({ ancestors: [], current: `${ROOT}/README.md`, pending: false })
    const windows = tree('C:\\work', { 'C:\\work': { kind: 'ready', level: ROOT_LEVEL } })
    expect(locateFile(windows, 'readme.md').current).toBe('C:\\work/README.md')
    const unc = tree('\\\\host\\share', { '\\\\host\\share': { kind: 'ready', level: ROOT_LEVEL } })
    expect(locateFile(unc, 'readme.md').current).toBe('\\\\host\\share/README.md')
    // A UNC root spelled with forward slashes is a Windows root too, as containment reads it.
    const slashed = tree('//host/share', { '//host/share': { kind: 'ready', level: ROOT_LEVEL } })
    expect(locateFile(slashed, 'readme.md').current).toBe('//host/share/README.md')
    const drive = tree('c:/work', { 'c:/work': { kind: 'ready', level: ROOT_LEVEL } })
    expect(locateFile(drive, 'readme.md').current).toBe('c:/work/README.md')
  })
})
