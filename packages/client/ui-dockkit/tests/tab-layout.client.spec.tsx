// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { TabLayout } from '../src/components/TabLayout.tsx'
import { DockController } from '../src/engine/controller.ts'
import { getNode, getPane } from '../src/engine/tree.ts'
import type { PaneCallbacks } from '../src/components/render.ts'
import type { TabId } from '../src/contract/types.ts'
import { followPointer } from '../src/components/pointer.ts'
import { seededController, TEST_LABELS } from './fixtures.client.ts'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

function mounted(controller = seededController(), options: Partial<ComponentProps<typeof TabLayout>> = {}) {
  const callbacks: PaneCallbacks = {
    onFocusTab: (id) => { controller.focusTab(id); redraw() },
    onFocusPane: (id) => { controller.focusPane(id); redraw() },
    onSplitPane: vi.fn(), onAddTab: vi.fn(), onCloseTab: vi.fn(), onTabPressed: vi.fn(), onDividerPressed: vi.fn(),
    splitBlock: () => undefined, canAddTab: () => true, canCloseTab: () => true,
    dropTarget: undefined, draggingTabId: undefined, labels: TEST_LABELS,
    renderTab: tab => <input data-body={tab.id} defaultValue={tab.title} />,
    renderTabTitle: undefined, renderTabMenuItems: undefined,
    chromePaneId: getPane(controller.getSnapshot().state, controller.getSnapshot().state.rootId).id,
    chrome: undefined,
  }
  const props = () => ({ state: controller.getSnapshot().state, callbacks, intents: controller, preview: undefined, ...options })
  const view = render(<TabLayout {...props()} />)
  function redraw(next: typeof options = {}) {
    options = { ...options, ...next }
    view.rerender(<TabLayout {...props()} />)
  }
  const node = (selector: string): HTMLElement => {
    const element = view.container.querySelector<HTMLElement>(selector)
    if (element === null) throw new Error(`missing ${selector}`)
    return element
  }
  return { controller, view, redraw, callbacks, node, body: (id: TabId) => node(`[data-body="${id}"]`) }
}

it('retains visited bodies and hands keyboard focus to the newly selected strip', () => {
  const controller = seededController()
  controller.setExpanded(true)
  const first = getPane(controller.getSnapshot().state, controller.getSnapshot().state.rootId).tabs[0]!
  const second = controller.openContent({ kind: 'file', contentId: 'file:b', title: 'B' })
  controller.focusTab(first)
  const h = mounted(controller, { keepMounted: () => true })
  const original = h.body(first)
  expect(h.view.container.querySelector(`[data-body="${second}"]`)).toBeNull()
  const chip = h.node(`[data-dockkit-tab="${second}"]`)
  chip.focus()
  fireEvent.click(chip)
  expect(document.activeElement).toBe(h.node(`[data-dockkit-content="${second}"] [data-dockkit-tab="${second}"]`))
  expect(h.body(first)).toBe(original)
  expect(original.closest('[data-dockkit-host]')).toHaveProperty('hidden', true)
  fireEvent.click(h.node(`[data-dockkit-content="${second}"] [data-dockkit-tab="${second}"]`))
  const body = h.body(second)
  body.focus()
  h.redraw({ active: false })
  expect(body.closest('[data-dockkit-content]')).toHaveProperty('inert', true)
  expect(document.activeElement).not.toBe(body)
  fireEvent.focus(body)
  h.redraw({ active: true })
  expect(h.body(second)).toBe(body)
  expect(body.closest('[data-dockkit-content]')).toHaveProperty('inert', false)
  act(() => { controller.setExpanded(false); h.redraw() })
  expect(h.body(second)).toBe(body)
})

it('keeps body ancestors through pane moves, floating, raising and docking', () => {
  const controller = seededController()
  controller.setExpanded(true)
  const tab = controller.openContent({ kind: 'file', contentId: 'file:a', title: 'A' })
  const h = mounted(controller, { keepMounted: () => true })
  const body = h.body(tab)
  const host = body.closest('[data-dockkit-host]')!
  act(() => { controller.splitPane(); h.redraw() })
  expect(h.view.container.querySelectorAll('[data-dockkit-pane]')).toHaveLength(2)
  const state = controller.getSnapshot().state
  const split = getNode(state, state.rootId)
  if (split.kind !== 'split') throw new Error('expected a split')
  h.redraw({ preview: { splitId: split.id, sizes: [0.3, 0.7] } })
  expect(h.node('[data-dockkit-split]').style.gridTemplateColumns).toContain('0.3fr')
  fireEvent.pointerDown(h.node('[data-dockkit-divider]'), { button: 0, pointerId: 1 })
  expect(h.callbacks.onDividerPressed).toHaveBeenCalledOnce()
  h.redraw({ preview: undefined })
  const secondPane = getPane(state, split.children[1]!).id
  fireEvent.click(h.node(`[data-dockkit-content="${tab}"] [data-dockkit-tab="${tab}"]`))
  expect(controller.getSnapshot().state.activePaneId).toBe(split.children[0])
  act(() => { controller.focusPane(secondPane); h.redraw() })
  fireEvent.focus(body)
  expect(controller.getSnapshot().state.activePaneId).toBe(split.children[0])
  act(() => { controller.focusPane(secondPane); h.redraw() })
  fireEvent.pointerDown(h.node(`[data-dockkit-content="${tab}"]`), { button: 0, pointerId: 1 })
  fireEvent.click(body)
  fireEvent.focus(body)
  expect(controller.getSnapshot().state.activePaneId).toBe(getPane(state, split.children[0]!).id)
  act(() => { controller.placeTab(tab, secondPane, 0); h.redraw() })
  expect(h.body(tab)).toBe(body)
  expect(body.closest('[data-dockkit-host]')).toBe(host)
  act(() => { controller.floatTab(tab); h.redraw() })
  const floating = controller.getSnapshot().state.floats[0]!
  expect(body.closest('[data-dockkit-host]')).toBe(host)
  expect(host.getAttribute('data-dockkit-host')).toBe('float')
  act(() => { controller.setExpanded(false); h.redraw() })
  expect(body.closest('[data-dockkit-content]')?.getAttribute('aria-hidden')).toBeNull()
  fireEvent.pointerDown(h.node(`[data-dockkit-float="${floating}"]`), { pointerId: 1, button: 0 })
  fireEvent.click(h.node(`[data-dockkit-float="${floating}"]`))
  fireEvent.focus(body)
  const resize = h.node('[data-dockkit-float-resize]')
  fireEvent.pointerDown(resize, { pointerId: 2, button: 0, clientX: 500, clientY: 400 })
  fireEvent.pointerMove(window, { pointerId: 2, clientX: 540, clientY: 440 })
  fireEvent.pointerUp(window, { pointerId: 2, clientX: 540, clientY: 440 })
  act(() => { h.redraw(); controller.unfloatPane(floating); h.redraw() })
  expect(h.body(tab)).toBe(body)
  expect(body.closest('[data-dockkit-host]')).toBe(host)
})

it('unmounts unretained bodies and restores focus to their replacement strip', () => {
  const controller = seededController()
  controller.setExpanded(true)
  const first = getPane(controller.getSnapshot().state, controller.getSnapshot().state.rootId).tabs[0]!
  const second = controller.openContent({ kind: 'file', contentId: 'file:b', title: 'B' })
  controller.focusTab(first)
  const h = mounted(controller)
  const original = h.body(first)
  fireEvent.click(h.node(`[data-dockkit-tab="${second}"]`))
  expect(original.isConnected).toBe(false)
  h.redraw({ active: false })
  expect(h.view.container.querySelector('[data-body]')).toBeNull()
  h.redraw({ active: true })
  const focus = vi.spyOn(HTMLElement.prototype, 'focus')
  fireEvent.click(h.node(`[data-dockkit-tab="${first}"]`))
  expect(focus).toHaveBeenCalled()
})

it.for(['new-control', 'origin-control', 'document', 'no-focus'] as const)('transfers tab focus without overriding a new owner: %s', (kind, test) => {
  const controller = seededController()
  controller.setExpanded(true)
  const first = getPane(controller.getSnapshot().state, controller.getSnapshot().state.rootId).tabs[0]!
  const second = controller.openContent({ kind: 'file', contentId: 'file:b', title: 'B' })
  controller.focusTab(first)
  const h = mounted(controller)
  const control = document.createElement('button')
  document.body.append(control)
  test.onTestFinished(() => { control.remove() })
  if (kind === 'origin-control') control.focus()
  vi.spyOn(h.callbacks, 'onFocusTab').mockImplementation((id) => {
    if (kind === 'new-control') control.focus()
    if (kind === 'document' || kind === 'no-focus') {
      vi.spyOn(document, 'activeElement', 'get').mockReturnValue(kind === 'document' ? document.documentElement : null)
    }
    controller.focusTab(id)
    h.redraw()
  })
  const focus = vi.spyOn(HTMLElement.prototype, 'focus')
  fireEvent.click(h.node(`[data-dockkit-tab="${second}"]`))
  if (kind === 'new-control') expect(document.activeElement).toBe(control)
  else expect(focus).toHaveBeenCalledWith({ preventScroll: true })
})

it('does not require a docked strip when a selected tab becomes floating in the same update', () => {
  const controller = seededController()
  controller.setExpanded(true)
  const first = getPane(controller.getSnapshot().state, controller.getSnapshot().state.rootId).tabs[0]!
  const second = controller.openContent({ kind: 'file', contentId: 'file:b', title: 'B' })
  controller.focusTab(first)
  const h = mounted(controller)
  vi.spyOn(h.callbacks, 'onFocusTab').mockImplementation((id) => {
    controller.focusTab(id)
    controller.floatTab(id)
    h.redraw()
  })
  fireEvent.click(h.node(`[data-dockkit-tab="${second}"]`))
  expect(h.node(`[data-dockkit-content="${second}"]`).hasAttribute('data-dockkit-float')).toBe(true)
})

it('renders an empty pane and rejects unsupported docked trees', () => {
  const controller = new DockController()
  controller.setExpanded(true)
  const h = mounted(controller)
  expect(h.node('[data-dockkit-empty]')).toBeDefined()
  controller.openContent({ kind: 'file', contentId: 'file:a', title: 'A' })
  controller.splitPane()
  const state = controller.getSnapshot().state
  const root = getNode(state, state.rootId)
  if (root.kind !== 'split') throw new Error('expected a split')
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const suppress = (event: ErrorEvent): void => {
    if (event.error instanceof Error && event.error.message === 'DockLayout requires one pane or two horizontally split panes') {
      event.preventDefault()
    }
  }
  window.addEventListener('error', suppress)
  try {
    expect(() =>{  h.redraw({ state: { ...state, nodes: { ...state.nodes, [root.id]: { ...root, axis: 'column' } } } }) })
      .toThrow('two horizontally split panes')
  } finally {
    window.removeEventListener('error', suppress)
  }
})

it('keeps a superseding gesture marker when an older follower detaches', () => {
  const element = document.createElement('div')
  const followers = { move: vi.fn(), up: vi.fn(), cancel: vi.fn() }
  const first = followPointer(element, 1, followers)
  const second = followPointer(element, 2, followers)
  first()
  expect(element.dataset.dockkitPointer).toBe('2')
  second()
  expect(element.dataset.dockkitPointer).toBeUndefined()
})
