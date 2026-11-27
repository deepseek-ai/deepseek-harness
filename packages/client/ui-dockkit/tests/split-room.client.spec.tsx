// @vitest-environment jsdom
/** Split availability in the horizontal layout used by the right sidebar. */
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { DockLayout } from '../src/client/components/DockSurface.tsx'
import { seededController, TEST_LABELS } from './fixtures.client.ts'

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

/** Deliver only size notifications for the given box, as opposed to a window resize. */
function observeSizes() {
  const observers = new Set<Observer>()
  class Observer {
    readonly boxes = new Set<Element>()
    constructor(readonly notify: () => void) { observers.add(this) }
    observe(box: Element): void { this.boxes.add(box) }
    disconnect(): void { observers.delete(this) }
  }
  vi.stubGlobal('ResizeObserver', Observer)
  return (box: Element) => {
    act(() => {
      for (const observer of observers) if (observer.boxes.has(box)) observer.notify()
    })
  }
}

function panel() {
  const controller = seededController()
  controller.setExpanded(true)
  const onRoom = vi.fn()
  const paneReads = vi.fn()
  let width = 300
  let fixed = 80
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.hasAttribute('data-dockkit-pane')) { paneReads(); return new DOMRect(0, 0, width, 600) }
    if (this.hasAttribute('data-dockkit-strip')) return new DOMRect(0, 0, width, 38)
    if (this.hasAttribute('data-dockkit-strip-tabs')) return new DOMRect(0, 0, 100, 28)
    if (this.hasAttribute('data-dockkit-strip-fill')) return new DOMRect(0, 0, width - fixed - 100, 0)
    return new DOMRect()
  })
  const tree = () => <div style={{ width }}>
    <DockLayout state={controller.getSnapshot().state} intents={controller} labels={TEST_LABELS} canSplit
      renderTab={tab => <div>{tab.title}</div>} renderTabTitle={tab => <span>{tab.title}</span>}
      chrome={<span style={{ width: fixed }} />} onRoom={onRoom} />
  </div>
  const view = render(tree())
  return {
    controller, paneReads, onRoom,
    box: (selector: string) => view.container.querySelector(selector)!,
    blocked: () => view.getByRole('button', { name: TEST_LABELS.splitPane }).hasAttribute('disabled'),
    redraw: (size: number, controls = fixed) => { width = size; fixed = controls; view.rerender(tree()) },
  }
}

it('measures the mounted pane immediately but not on width-only React commits', () => {
  const resized = observeSizes()
  const h = panel()
  expect(h.blocked()).toBe(true)
  h.paneReads.mockClear()
  h.redraw(450)
  h.redraw(500)
  expect(h.paneReads).not.toHaveBeenCalled()
  resized(h.box('[data-dockkit-surface]'))
  expect(h.blocked()).toBe(false)
  expect(h.onRoom).toHaveBeenLastCalledWith(new Map([[h.controller.getSnapshot().state.rootId, { row: true, column: true }]]))
})

it('tracks changing strip controls at fixed pane width, including after the selected tab replaces its strip', () => {
  const resized = observeSizes()
  const h = panel()
  h.redraw(500)
  resized(h.box('[data-dockkit-surface]'))
  expect(h.blocked()).toBe(false)
  const oldFill = h.box('[data-dockkit-strip-fill]')
  h.controller.openContent({ kind: 'file', contentId: 'file:a', title: 'A' })
  h.redraw(500, 180)
  expect(h.blocked()).toBe(true)
  const fill = h.box('[data-dockkit-strip-fill]')
  expect(fill).not.toBe(oldFill)
  h.redraw(500, 80)
  resized(fill)
  expect(h.blocked()).toBe(false)
})

it('keeps commit-time measurements when size observation is unavailable', () => {
  vi.stubGlobal('ResizeObserver', undefined)
  const h = panel()
  expect(h.blocked()).toBe(true)
  h.redraw(500)
  expect(h.blocked()).toBe(false)
  h.redraw(500, 180)
  expect(h.blocked()).toBe(true)
})
