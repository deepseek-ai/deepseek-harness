// @vitest-environment jsdom
/**
 * Component-level behaviour of the kit's React surface, driven by props alone:
 * no cordis, no slot registry, no scaffold. These assert what a user sees and
 * which settled intent each gesture reports — the layout maths itself is covered
 * by the engine suites.
 *
 * jsdom lays nothing out, so the gesture specs hand the surface a layout: panes
 * of one width side by side, each 600px tall with a 36px strip and 100px chips.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import type { DockIntents } from '../src/contract/adapter.ts'
import type { PaneId, TabId } from '../src/contract/types.ts'
import { DockController } from '../src/engine/controller.ts'
import { applyOp } from '../src/engine/operations.ts'
import { FLOAT_DEFAULT_SIZE, FLOAT_MIN_SIZE } from '../src/engine/constraints.ts'
import { floatRectAt } from '../src/engine/geometry.ts'
import { DockSurface, type DockSurfaceProps } from '../src/components/DockSurface.tsx'
import type { TabMenuExtras } from '../src/contract/adapter.ts'
import { FloatLayer, type FloatLayerProps } from '../src/components/FloatLayer.tsx'
import { dockPaneIds, getPane } from '../src/engine/tree.ts'
import { TEST_LABELS, asPane, asTab, fileTab, seededController } from './fixtures.client.ts'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

/** Every intent as a spy, so a spec can assert exactly which one fired. */
function spyIntents(): DockIntents & Record<keyof DockIntents, ReturnType<typeof vi.fn>> {
  return {
    focusTab: vi.fn(),
    focusPane: vi.fn(),
    splitPane: vi.fn(),
    addTab: vi.fn(),
    closeTab: vi.fn(),
    duplicateTab: vi.fn(),
    floatTab: vi.fn(),
    unfloatPane: vi.fn(),
    placeTab: vi.fn(),
    dropTab: vi.fn(),
    moveFloat: vi.fn(),
    resizeFloat: vi.fn(),
    resizeSplit: vi.fn(),
  } as DockIntents & Record<keyof DockIntents, ReturnType<typeof vi.fn>>
}

/** Render the docked surface over a controller's current layout. */
function renderSurface(
  controller: DockController,
  intents: DockIntents,
  canSplit = true,
  renderTabMenuItems?: TabMenuExtras,
  options: Pick<DockSurfaceProps, 'dropZones' | 'minPaneFraction' | 'canCloseTab'> = {},
) {
  const snapshot = controller.getSnapshot()
  return render(
    <DockSurface
      {...options}
      state={snapshot.state}
      canSplit={canSplit}
      intents={intents}
      labels={TEST_LABELS}
      renderTab={tab => <p data-testid="body">{tab.contentId}</p>}
      {...renderTabMenuItems === undefined ? {} : { renderTabMenuItems }}
    />,
  )
}

const box = (x: number, y: number, width: number, height: number): DOMRect =>
  ({ x, y, width, height, top: y, left: x, right: x + width, bottom: y + height, toJSON: () => ({}) })

/** Height every laid-out pane takes. */
const PANE_HEIGHT = 600

/** Width of one laid-out chip. */
const CHIP_WIDTH = 100

/**
 * Lay the surface out: `panes` in visual order, each `paneWidth` wide, side by
 * side from the origin. Every pane's strip is 36px tall inside a 1px border,
 * its chips 100px wide from the strip's left edge, its fixed controls 104px.
 * Dividers are 4px wide; the surface and every split container span every
 * pane, except the split containers `splits` gives their own box.
 */
function layOut(panes: readonly PaneId[], paneWidth: number, splits: Readonly<Record<string, DOMRect>> = {}): void {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.hasAttribute('data-dockkit-split')) {
      return splits[this.getAttribute('data-dockkit-split') ?? ''] ?? box(0, 0, panes.length * paneWidth, PANE_HEIGHT)
    }
    if (this.hasAttribute('data-dockkit-surface')) return box(0, 0, panes.length * paneWidth, PANE_HEIGHT)
    if (this.hasAttribute('data-dockkit-divider')) return box(0, 0, 4, PANE_HEIGHT)
    const pane = this.closest<HTMLElement>('[data-dockkit-pane]')
    const index = pane === null ? -1 : panes.indexOf(asPane(pane.dataset.dockkitPane ?? ''))
    if (pane === null || index < 0) return box(0, 0, 0, 0)
    const left = index * paneWidth
    if (this === pane) return box(left, 0, paneWidth, PANE_HEIGHT)
    const chips = [...pane.querySelectorAll('[data-dockkit-tab]')]
    if (this.hasAttribute('data-dockkit-strip')) return box(left + 1, 1, paneWidth - 2, 36)
    if (this.hasAttribute('data-dockkit-strip-tabs')) return box(left + 1, 1, chips.length * CHIP_WIDTH, 34)
    if (this.hasAttribute('data-dockkit-strip-fill')) {
      return box(left + 1 + chips.length * CHIP_WIDTH + 32, 1, Math.max(0, paneWidth - 2 - chips.length * CHIP_WIDTH - 104), 34)
    }
    if (this.hasAttribute('data-dockkit-tab')) return box(left + 1 + chips.indexOf(this) * CHIP_WIDTH, 1, CHIP_WIDTH, 34)
    return box(0, 0, 0, 0)
  })
}

/** Press `element` at a point and move to another, releasing there unless told not to. */
function drag(element: Element, from: readonly [number, number], to: readonly [number, number], release = true): void {
  fireEvent.pointerDown(element, { clientX: from[0], clientY: from[1], pointerId: 7, button: 0 })
  fireEvent.pointerMove(window, { pointerId: 7, clientX: to[0], clientY: to[1] })
  if (release) fireEvent.pointerUp(window, { pointerId: 7, clientX: to[0], clientY: to[1] })
}

/** Two seeded docked panes, the first also holding a content tab, with the layout state on a spied intent set. */
function twoPanes(
  paneWidth = 420,
  canSplit = true,
  options: Pick<DockSurfaceProps, 'dropZones' | 'minPaneFraction'> = {},
): {
  intents: ReturnType<typeof spyIntents>
  first: PaneId
  second: PaneId
  seedTabId: TabId
  fileTabId: TabId
  chip: (tabId: TabId) => HTMLElement
  unmount: () => void
} {
  const controller = seededController()
  controller.setExpanded(true)
  controller.splitPane()
  const [first, second] = dockPaneIds(controller.getSnapshot().state)
  if (first === undefined || second === undefined) throw new Error('expected two docked panes')
  const fileTabId = controller.openContent({
    contentId: 'dsh-resource://file/session/s/a.txt', title: 'a.txt', kind: 'file', paneId: first,
  })
  const seedTabId = getPane(controller.getSnapshot().state, first).tabs[0]
  if (seedTabId === undefined) throw new Error('expected the seeded tab')
  layOut([first, second], paneWidth)
  const intents = spyIntents()
  const { unmount } = renderSurface(controller, intents, canSplit, undefined, options)
  const chip = (tabId: TabId): HTMLElement => {
    const element = document.querySelector<HTMLElement>(`[data-dockkit-tab="${tabId}"]`)
    if (element === null) throw new Error(`no chip for ${tabId}`)
    return element
  }
  return { intents, first, second, seedTabId, fileTabId, chip, unmount }
}

/** The chip the layout puts second in the first pane: pressed at its centre. */
const FILE_CHIP: readonly [number, number] = [151, 18]

/** Which gesture intents fired, in order. */
function gestureIntents(intents: ReturnType<typeof spyIntents>): string[] {
  return (['placeTab', 'dropTab', 'floatTab', 'resizeSplit'] as const).filter(name => intents[name].mock.calls.length > 0)
}

describe('DockSurface', () => {
  it('renders each pane with its tabs and the active tab body', () => {
    const controller = seededController()
    controller.openContent({ contentId: 'dsh-resource://file/session/s/a.txt', title: 'a.txt', kind: 'file' })
    renderSurface(controller, spyIntents())

    // The chip's text is its title alone: the close control is an icon.
    expect(screen.getAllByRole('tab').map(tab => tab.textContent)).toEqual(['Start', 'a.txt'])
    expect(screen.getByTestId('body').textContent).toBe('dsh-resource://file/session/s/a.txt')
    expect(screen.getByRole('tab', { name: /a\.txt/u }).getAttribute('aria-selected')).toBe('true')
  })

  it('shows the empty-pane label when a pane holds nothing', () => {
    const controller = new DockController()
    renderSurface(controller, spyIntents())
    expect(screen.getByText(TEST_LABELS.emptyPane)).toBeDefined()
  })

  it('reports one focus intent when a tab is clicked, not when it is pressed, and none for the pane', () => {
    const controller = seededController()
    controller.openContent({ contentId: 'dsh-resource://file/session/s/a.txt', title: 'a.txt', kind: 'file' })
    const intents = spyIntents()
    renderSurface(controller, intents)
    const tab = screen.getByRole('tab', { name: /Start/u })

    fireEvent.pointerDown(tab)
    expect(intents.focusTab).not.toHaveBeenCalled()
    fireEvent.click(tab)
    const seeded = Object.values(controller.getSnapshot().state.tabs)[0]
    expect(intents.focusTab).toHaveBeenCalledTimes(1)
    expect(intents.focusTab).toHaveBeenCalledWith(seeded?.id)
    // The tab's own operation decides the active pane; the pane records nothing of its own.
    expect(intents.focusPane).not.toHaveBeenCalled()
  })

  it('records nothing for a click on the active pane\'s selected chip, but selects that chip in another pane', () => {
    const controller = seededController()
    controller.setExpanded(true)
    controller.splitPane()
    const state = controller.getSnapshot().state
    const [first, second] = dockPaneIds(state)
    if (first === undefined || second === undefined) throw new Error('expected two docked panes')
    expect(state.activePaneId).toBe(second)
    const intents = spyIntents()
    renderSurface(controller, intents)
    const selectedChip = (paneId: PaneId): Element => {
      const chip = document.querySelector(`[data-dockkit-pane="${paneId}"] [data-dockkit-tab][aria-selected="true"]`)
      if (chip === null) throw new Error(`expected a selected chip in ${paneId}`)
      return chip
    }
    fireEvent.click(selectedChip(second))
    expect(intents.focusTab).not.toHaveBeenCalled()
    fireEvent.click(selectedChip(first))
    expect(intents.focusTab).toHaveBeenCalledWith(getPane(state, first).activeTabId)
    expect(intents.focusPane).not.toHaveBeenCalled()
  })

  it('focuses a pane when its body or strip is clicked, unless it is the active pane already', () => {
    const controller = seededController()
    controller.setExpanded(true)
    controller.splitPane()
    const state = controller.getSnapshot().state
    const [first, second] = dockPaneIds(state)
    if (first === undefined || second === undefined) throw new Error('expected two docked panes')
    expect(state.activePaneId).toBe(second)
    const intents = spyIntents()
    renderSurface(controller, intents)
    const body = (paneId: PaneId): Element => {
      const element = document.querySelector(`[data-dockkit-pane="${paneId}"] [data-testid="body"]`)
      if (element === null) throw new Error(`expected a body in ${paneId}`)
      return element
    }
    // The active pane: nothing would change, so nothing is recorded.
    fireEvent.click(body(second))
    fireEvent.click(document.querySelector(`[data-dockkit-strip="${second}"]`) ?? body(second))
    expect(intents.focusPane).not.toHaveBeenCalled()
    // The other pane: its body and its strip's blank area both focus it.
    fireEvent.click(body(first))
    fireEvent.click(document.querySelector(`[data-dockkit-strip="${first}"]`) ?? body(first))
    expect(intents.focusPane).toHaveBeenCalledTimes(2)
    expect(intents.focusPane).toHaveBeenCalledWith(first)
    expect(intents.focusTab).not.toHaveBeenCalled()
  })

  it('reports a split intent from the pane control, and disables it when the budget is spent', () => {
    const controller = seededController()
    const intents = spyIntents()
    const { unmount } = renderSurface(controller, intents)
    fireEvent.click(screen.getByRole('button', { name: TEST_LABELS.splitPane }))
    expect(intents.splitPane).toHaveBeenCalledWith(controller.getSnapshot().state.rootId)
    expect(intents.focusPane).not.toHaveBeenCalled()
    unmount()

    renderSurface(controller, intents, false)
    const disabled = screen.getByRole('button', { name: TEST_LABELS.splitPane })
    expect(disabled.hasAttribute('disabled')).toBe(true)
    expect(disabled.getAttribute('title')).toBe(TEST_LABELS.splitPaneDisabled)
    expect(disabled.getAttribute('data-dockkit-split-blocked')).toBe('budget')
  })

  it('names the enabled split control through the shared tooltip, not a native title', () => {
    vi.useFakeTimers()
    try {
      renderSurface(seededController(), spyIntents())
      const button = screen.getByRole('button', { name: TEST_LABELS.splitPane })
      expect(button.hasAttribute('title')).toBe(false)
      fireEvent.mouseEnter(button)
      act(() => { vi.advanceTimersByTime(500) })
      expect(screen.getByRole('tooltip').textContent).toBe(TEST_LABELS.splitPane)
      fireEvent.mouseLeave(button)
      expect(screen.queryByRole('tooltip')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('hides blocked split controls when opted in and restores them when capacity returns', () => {
    const controller = seededController()
    controller.splitPane()
    const state = controller.getSnapshot().state
    layOut(dockPaneIds(state), 520)
    const intents = spyIntents()
    const props: DockSurfaceProps = {
      state, canSplit: false, hideSplitWhenBlocked: true, intents, labels: TEST_LABELS, renderTab: tab => <p>{tab.title}</p>,
    }
    const view = render(<DockSurface {...props} />)
    expect(screen.queryByRole('button', { name: TEST_LABELS.splitPane })).toBeNull()
    expect(view.container.querySelectorAll('[data-dockkit-split-button]')).toHaveLength(0)
    expect(view.container.querySelectorAll('[data-dockkit-pane]')).toHaveLength(2)

    view.rerender(<DockSurface {...props} canSplit />)
    const buttons = screen.getAllByRole('button', { name: TEST_LABELS.splitPane })
    expect(buttons).toHaveLength(2)
    expect(buttons.every(button => !button.hasAttribute('disabled'))).toBe(true)
    fireEvent.click(buttons[0]!)
    expect(intents.splitPane).toHaveBeenCalledExactlyOnceWith(dockPaneIds(state)[0])
  })

  // jsdom lays nothing out, so the room rule reads the rectangles this spec
  // hands it: two panes, one wide enough for two halves and one not. The
  // strip's fixed part is 104px in both (the chrome pane's controls), the chip
  // minimum falls back to the stylesheet's 100px.
  it.each([false, true])('disables or hides the width-blocked split control with hideSplitWhenBlocked=%s', (hideSplitWhenBlocked) => {
    const controller = seededController()
    controller.setExpanded(true)
    controller.splitPane()
    const snapshot = controller.getSnapshot()
    const [wide, narrow] = dockPaneIds(snapshot.state)
    if (wide === undefined || narrow === undefined) throw new Error('expected two docked panes')
    const widths: Record<string, number> = { [wide]: 520, [narrow]: 208 }
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const paneWidth = widths[this.closest<HTMLElement>('[data-dockkit-pane]')?.dataset.dockkitPane ?? ''] ?? 0
      if (this.hasAttribute('data-dockkit-pane')) return box(0, 0, paneWidth, 600)
      if (this.hasAttribute('data-dockkit-strip')) return box(0, 0, paneWidth - 2, 36)
      if (this.hasAttribute('data-dockkit-strip-tabs')) return box(0, 0, 60, 24)
      if (this.hasAttribute('data-dockkit-strip-fill')) return box(0, 0, Math.max(0, paneWidth - 2 - 60 - 104), 24)
      return box(0, 0, 0, 0)
    })
    render(
      <DockSurface
        state={snapshot.state}
        canSplit
        hideSplitWhenBlocked={hideSplitWhenBlocked}
        intents={controller}
        labels={TEST_LABELS}
        renderTab={tab => <p>{tab.contentId}</p>}
      />,
    )
    const wideButton = document.querySelector(`[data-dockkit-split-button="${wide}"]`)
    const narrowButton = document.querySelector(`[data-dockkit-split-button="${narrow}"]`)
    expect(wideButton?.hasAttribute('disabled')).toBe(false)
    expect(wideButton?.hasAttribute('title')).toBe(false)
    if (hideSplitWhenBlocked) {
      expect(narrowButton).toBeNull()
    } else {
      expect(narrowButton?.hasAttribute('disabled')).toBe(true)
      expect(narrowButton?.getAttribute('title')).toBe(TEST_LABELS.splitPaneNarrow)
      expect(narrowButton?.getAttribute('data-dockkit-split-blocked')).toBe('width')
    }
  })

  it('reports the room readings through onRoom, and re-reads them when the surface resizes', () => {
    class FakeResizeObserver implements ResizeObserver {
      static latest: FakeResizeObserver | undefined
      readonly observe = vi.fn()
      readonly unobserve = vi.fn()
      readonly disconnect = vi.fn()
      constructor(private readonly callback: ResizeObserverCallback) {
        FakeResizeObserver.latest = this
      }

      /** What the platform does when the observed element's size changes. */
      fire(): void {
        this.callback([], this)
      }
    }
    vi.stubGlobal('ResizeObserver', FakeResizeObserver)
    const controller = seededController()
    controller.setExpanded(true)
    controller.splitPane()
    const snapshot = controller.getSnapshot()
    const panes = dockPaneIds(snapshot.state)
    let paneWidth = 520
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.hasAttribute('data-dockkit-pane')) return box(0, 0, paneWidth, 600)
      if (this.hasAttribute('data-dockkit-strip')) return box(0, 0, paneWidth - 2, 36)
      if (this.hasAttribute('data-dockkit-strip-tabs')) return box(0, 0, 60, 24)
      if (this.hasAttribute('data-dockkit-strip-fill')) return box(0, 0, Math.max(0, paneWidth - 2 - 60 - 104), 24)
      return box(0, 0, 0, 0)
    })
    const onRoom = vi.fn()
    const { unmount } = render(
      <DockSurface
        state={snapshot.state}
        canSplit
        intents={controller}
        labels={TEST_LABELS}
        renderTab={tab => <p>{tab.contentId}</p>}
        onRoom={onRoom}
      />,
    )
    const observer = FakeResizeObserver.latest
    if (observer === undefined) throw new Error('expected the surface to observe its own size')
    expect(observer.observe).toHaveBeenCalledWith(document.querySelector('[data-dockkit-surface]'))
    expect(onRoom).toHaveBeenLastCalledWith(new Map(panes.map(id => [id, { row: true, column: true }])))
    const readings = onRoom.mock.calls.length

    // The same reading again renders nothing new.
    act(() => { observer.fire() })
    expect(onRoom).toHaveBeenCalledTimes(readings)

    // The column narrowed: every pane loses the room for a row split.
    paneWidth = 208
    act(() => { observer.fire() })
    expect(onRoom).toHaveBeenLastCalledWith(new Map(panes.map(id => [id, { row: false, column: true }])))
    unmount()
    expect(observer.disconnect).toHaveBeenCalledTimes(1)
  })

  // The room reading must not flip with the hidden control's own footprint:
  // hiding the width-blocked control widens the fill by the control plus the
  // strip's gap, and a reading that counted the control would fit again, show
  // it, and re-render forever (React's update-depth limit, which crashed the
  // surface). The rule leaves the footprint out, so the fill the fake hands
  // back here depends on whether the control is in the DOM — exactly the
  // feedback the fix breaks.
  it('reads the same room whether hideSplitWhenBlocked has hidden the split control or not', () => {
    class FakeResizeObserver implements ResizeObserver {
      static latest: FakeResizeObserver | undefined
      readonly observe = vi.fn()
      readonly unobserve = vi.fn()
      readonly disconnect = vi.fn()
      constructor(private readonly callback: ResizeObserverCallback) {
        FakeResizeObserver.latest = this
      }

      /** What the platform does when the observed element's size changes. */
      fire(): void {
        this.callback([], this)
      }
    }
    vi.stubGlobal('ResizeObserver', FakeResizeObserver)
    const controller = seededController()
    controller.setExpanded(true)
    const snapshot = controller.getSnapshot()
    // In the band where only the control's 28px footprint decides the fit:
    // half 188px against 76px of other fixed controls plus the 100px chip.
    let paneWidth = 380
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const pane = this.closest<HTMLElement>('[data-dockkit-pane]')
      if (this.hasAttribute('data-dockkit-pane')) return box(0, 0, paneWidth, 600)
      if (this.hasAttribute('data-dockkit-strip')) return box(0, 0, paneWidth - 2, 36)
      if (this.hasAttribute('data-dockkit-strip-tabs')) return box(0, 0, 60, 24)
      if (this.hasAttribute('data-dockkit-split-button')) return box(0, 0, 28, 28)
      if (this.hasAttribute('data-dockkit-strip-fill')) {
        const fixed = pane?.querySelector('[data-dockkit-split-button]') === null ? 76 : 104
        return box(0, 0, Math.max(0, paneWidth - 2 - 60 - fixed), 24)
      }
      return box(0, 0, 0, 0)
    })
    render(
      <DockSurface
        state={snapshot.state}
        canSplit
        hideSplitWhenBlocked
        intents={controller}
        labels={TEST_LABELS}
        renderTab={tab => <p>{tab.contentId}</p>}
      />,
    )
    // Settled with the control shown: the discounted reading fits either way.
    expect(document.querySelector('[data-dockkit-split-button]')).not.toBeNull()

    // Narrowed under the discounted minimum: hidden, and the reading without
    // the control settles hidden.
    const observer = FakeResizeObserver.latest
    if (observer === undefined) throw new Error('expected the surface to observe its own size')
    paneWidth = 300
    act(() => { observer.fire() })
    expect(document.querySelector('[data-dockkit-split-button]')).toBeNull()
  })

  it('names the chip box\'s hidden sides in data-dockkit-strip-scroll as it scrolls', () => {
    let scrollLeft = 0
    const descriptors = ['scrollLeft', 'scrollWidth', 'clientWidth'].map(name =>
      [name, Object.getOwnPropertyDescriptor(Element.prototype, name)] as const)
    const strip = (element: Element): boolean => element.hasAttribute('data-dockkit-strip-tabs')
    Object.defineProperty(Element.prototype, 'scrollLeft', { configurable: true, get(this: Element) { return strip(this) ? scrollLeft : 0 } })
    Object.defineProperty(Element.prototype, 'scrollWidth', { configurable: true, get(this: Element) { return strip(this) ? 400 : 0 } })
    Object.defineProperty(Element.prototype, 'clientWidth', { configurable: true, get(this: Element) { return strip(this) ? 200 : 0 } })
    try {
      const controller = seededController()
      renderSurface(controller, spyIntents())
      const box = document.querySelector<HTMLElement>('[data-dockkit-strip-tabs]')
      if (box === null) throw new Error('expected the chip box')
      expect(box.getAttribute('data-dockkit-strip-scroll')).toBe('end')
      scrollLeft = 100
      fireEvent.scroll(box)
      expect(box.getAttribute('data-dockkit-strip-scroll')).toBe('start end')
      scrollLeft = 200
      fireEvent.scroll(box)
      expect(box.getAttribute('data-dockkit-strip-scroll')).toBe('start')
    } finally {
      for (const [name, descriptor] of descriptors) {
        if (descriptor === undefined) Reflect.deleteProperty(Element.prototype, name)
        else Object.defineProperty(Element.prototype, name, descriptor)
      }
    }
  })

  it('scrolls the chip box to the active chip when it lies past either edge, clearing the fade band', () => {
    let scrollLeft = 0
    const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollLeft')
    Object.defineProperty(Element.prototype, 'scrollLeft', {
      configurable: true,
      get() { return scrollLeft },
      set(value: number) { scrollLeft = value },
    })
    // The box spans 0..200; the seeded chip sits at 40..130 and the opened one where `openedAt` says.
    let openedTab: TabId | undefined
    let openedAt = 250
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.hasAttribute('data-dockkit-strip-tabs')) return box(0, 0, 200, 28)
      if (this.getAttribute('data-dockkit-tab') === openedTab) return box(openedAt, 0, 90, 28)
      if (this.hasAttribute('data-dockkit-tab')) return box(40, 0, 90, 28)
      return box(0, 0, 0, 0)
    })
    const surface = (controller: DockController) => (
      <DockSurface
        state={controller.getSnapshot().state}
        canSplit
        intents={controller}
        labels={TEST_LABELS}
        renderTab={tab => <p>{tab.contentId}</p>}
      />
    )
    try {
      const controller = seededController()
      const seededTab = getPane(controller.getSnapshot().state, controller.getSnapshot().state.activePaneId).activeTabId
      if (seededTab === undefined) throw new Error('expected the seeded tab')
      const { rerender } = render(surface(controller))
      // The seeded chip is in view: nothing moves.
      expect(scrollLeft).toBe(0)
      openedTab = controller.openContent({ contentId: 'dsh-resource://file/session/s/b.txt', title: 'b.txt', kind: 'file' })
      rerender(surface(controller))
      // Past the right edge by 140, plus the 24px fade.
      expect(scrollLeft).toBe(164)
      // Selected again once it lies 30 past the left edge: back by 30 plus the fade.
      openedAt = -30
      controller.focusTab(seededTab)
      rerender(surface(controller))
      controller.focusTab(openedTab)
      rerender(surface(controller))
      expect(scrollLeft).toBe(164 - 30 - 24)
    } finally {
      if (descriptor === undefined) Reflect.deleteProperty(Element.prototype, 'scrollLeft')
      else Object.defineProperty(Element.prototype, 'scrollLeft', descriptor)
    }
  })

  it('marks a chip title clipped while its text is wider than its box, re-reading on resize', () => {
    class FakeResizeObserver implements ResizeObserver {
      static readonly all: FakeResizeObserver[] = []
      readonly observe = vi.fn()
      readonly unobserve = vi.fn()
      readonly disconnect = vi.fn()
      constructor(private readonly callback: ResizeObserverCallback) {
        FakeResizeObserver.all.push(this)
      }

      fire(): void {
        this.callback([], this)
      }
    }
    vi.stubGlobal('ResizeObserver', FakeResizeObserver)
    let clientWidth = 200
    const descriptors = ['scrollWidth', 'clientWidth'].map(name =>
      [name, Object.getOwnPropertyDescriptor(Element.prototype, name)] as const)
    const title = (element: Element): boolean => element.hasAttribute('data-dockkit-tab-title')
    Object.defineProperty(Element.prototype, 'scrollWidth', { configurable: true, get(this: Element) { return title(this) ? 120 : 0 } })
    Object.defineProperty(Element.prototype, 'clientWidth', { configurable: true, get(this: Element) { return title(this) ? clientWidth : 0 } })
    try {
      const controller = seededController()
      const { unmount } = renderSurface(controller, spyIntents())
      const span = document.querySelector<HTMLElement>('[data-dockkit-tab-title]')
      if (span === null) throw new Error('expected a chip title')
      const observer = FakeResizeObserver.all.find(candidate => candidate.observe.mock.calls.some(([target]) => target === span))
      if (observer === undefined) throw new Error('expected the title to observe its own size')
      expect(span.hasAttribute('data-dockkit-tab-clipped')).toBe(false)
      // The chip narrowed under the text.
      clientWidth = 80
      act(() => { observer.fire() })
      expect(span.hasAttribute('data-dockkit-tab-clipped')).toBe(true)
      clientWidth = 200
      act(() => { observer.fire() })
      expect(span.hasAttribute('data-dockkit-tab-clipped')).toBe(false)
      unmount()
      expect(observer.disconnect).toHaveBeenCalledTimes(1)
    } finally {
      for (const [name, descriptor] of descriptors) {
        if (descriptor === undefined) Reflect.deleteProperty(Element.prototype, name)
        else Object.defineProperty(Element.prototype, name, descriptor)
      }
      vi.unstubAllGlobals()
    }
  })

  it('asks for the seeded tab from the strip\'s add control, naming the pane and nothing else', () => {
    const controller = seededController()
    const intents = spyIntents()
    renderSurface(controller, intents)
    fireEvent.click(screen.getByRole('button', { name: TEST_LABELS.addTab }))
    expect(intents.addTab).toHaveBeenCalledWith(controller.getSnapshot().state.rootId)
    expect(intents.focusPane).not.toHaveBeenCalled()
  })

  it('draws the add control only where the embedder\'s canAddTab allows, pane by pane', () => {
    const controller = seededController()
    controller.setExpanded(true)
    controller.splitPane()
    const snapshot = controller.getSnapshot()
    const [first, second] = dockPaneIds(snapshot.state)
    if (first === undefined || second === undefined) throw new Error('expected two docked panes')
    render(
      <DockSurface
        state={snapshot.state}
        canSplit
        canAddTab={paneId => paneId === second}
        intents={controller}
        labels={TEST_LABELS}
        renderTab={tab => <p>{tab.contentId}</p>}
        chrome={<button type="button">chrome</button>}
      />,
    )
    expect(document.querySelector(`[data-dockkit-pane="${first}"] [data-dockkit-add-tab]`)).toBeNull()
    expect(document.querySelector(`[data-dockkit-pane="${second}"] [data-dockkit-add-tab]`)).not.toBeNull()
    // The strip's end controls stay: only the add control is missing.
    const strip = document.querySelector(`[data-dockkit-pane="${first}"] [data-dockkit-strip]`)
    expect(strip?.querySelector('[data-dockkit-split-button]')).not.toBeNull()
    expect(strip?.querySelector('[data-dockkit-strip-tabs]')).not.toBeNull()
  })

  it('withholds a tab\'s close control and menu close item where the embedder\'s canCloseTab denies, tab by tab', () => {
    const controller = seededController()
    controller.openContent({ contentId: 'dsh-resource://file/session/s/a.txt', title: 'a.txt', kind: 'file' })
    const snapshot = controller.getSnapshot()
    const seedTabId = getPane(snapshot.state, snapshot.state.activePaneId).tabs[0]
    if (seedTabId === undefined) throw new Error('expected seeded tab')
    render(
      <DockSurface
        state={snapshot.state}
        canSplit
        canCloseTab={tabId => tabId !== seedTabId}
        intents={controller}
        labels={TEST_LABELS}
        renderTab={tab => <p>{tab.contentId}</p>}
        renderTabMenuItems={(_, dismiss) => <button type="button" role="menuitem" onClick={dismiss}>embedder item</button>}
      />,
    )
    const [seedChip, fileChip] = screen.getAllByRole('tab')
    if (seedChip === undefined || fileChip === undefined) throw new Error('expected two chips')
    expect(seedChip.querySelector('[data-dockkit-tab-close]')).toBeNull()
    expect(fileChip.querySelector('[data-dockkit-tab-close]')).not.toBeNull()

    // The menu still opens on the withheld chip: the embedder's items remain reachable.
    fireEvent.contextMenu(seedChip)
    expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual(['embedder item'])
    fireEvent.pointerDown(document.body)

    fireEvent.contextMenu(fileChip)
    expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual([TEST_LABELS.closeTab, 'embedder item'])
  })

  it('draws a lone unclosable chip quiet, and shows no menu on it when the embedder renders no item', () => {
    const controller = seededController()
    render(
      <DockSurface
        state={controller.getSnapshot().state}
        canSplit
        canCloseTab={() => false}
        intents={controller}
        labels={TEST_LABELS}
        renderTab={tab => <p>{tab.contentId}</p>}
        renderTabMenuItems={() => undefined}
      />,
    )
    const [chip] = screen.getAllByRole('tab')
    if (chip === undefined) throw new Error('expected the seeded chip')
    // The lone unclosable chip draws quiet: no capsule, no hover fill.
    expect(chip.getAttribute('data-dockkit-tab-quiet')).toBe('true')
    // The menu would hold nothing, so it dismisses itself before painting.
    fireEvent.contextMenu(chip)
    expect(document.querySelector('[data-dockkit-tab-menu]')).toBeNull()
  })

  it('lets the embedder render a chip\'s title, and shows the record\'s text when it does not', () => {
    const controller = seededController()
    controller.openContent({ contentId: 'dsh-resource://file/session/s/a.txt', title: 'a.txt', kind: 'file' })
    const snapshot = controller.getSnapshot()
    render(
      <DockSurface
        state={snapshot.state}
        canSplit
        intents={controller}
        labels={TEST_LABELS}
        renderTab={tab => <p>{tab.contentId}</p>}
        renderTabTitle={tab => tab.kind === 'file' ? <em data-testid="rich-title">{tab.title.toUpperCase()}</em> : undefined}
      />,
    )
    const titles = [...document.querySelectorAll('[data-dockkit-tab-title]')].map(el => el.textContent)
    expect(titles).toEqual(['Start', 'A.TXT'])
    expect(screen.getByTestId('rich-title').tagName).toBe('EM')
  })

  it('closes a tab from the chip\'s own control, without starting a drag', () => {
    const controller = seededController()
    const intents = spyIntents()
    renderSurface(controller, intents)
    const close = screen.getByRole('button', { name: TEST_LABELS.closeTab })
    // A press on the nested control must not reach the chip's gesture handler;
    // if it did, the pointer would be captured and this click would never land.
    fireEvent.pointerDown(close)
    fireEvent.click(close)
    expect(intents.closeTab).toHaveBeenCalledTimes(1)
    expect(intents.focusTab).not.toHaveBeenCalled()
  })

  it('opens the context menu on a secondary press, offering close and closing after acting', () => {
    const controller = seededController()
    const intents = spyIntents()
    renderSurface(controller, intents)
    expect(screen.queryByRole('menu')).toBeNull()
    fireEvent.contextMenu(screen.getByRole('tab'))
    expect(screen.getByRole('menu')).toBeDefined()
    fireEvent.click(screen.getByRole('menuitem', { name: TEST_LABELS.closeTab }))
    expect(intents.closeTab).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('offers close only for tabs the embedder allows', () => {
    const controller = seededController()
    const allowed = controller.openContent({ contentId: 'resource:a', title: 'A', kind: 'test' })
    const intents = spyIntents()
    renderSurface(controller, intents, true, undefined, { canCloseTab: tabId => tabId === allowed })
    expect(screen.getByRole('button', { name: TEST_LABELS.closeTab }).getAttribute('data-dockkit-tab-close')).toBe(allowed)
    fireEvent.contextMenu(screen.getByRole('tab', { name: 'Start' }))
    expect(screen.queryByRole('menu')).toBeNull()
    fireEvent.contextMenu(screen.getByRole('tab', { name: /A/u }))
    fireEvent.click(screen.getByRole('menuitem', { name: TEST_LABELS.closeTab }))
    expect(intents.closeTab).toHaveBeenCalledExactlyOnceWith(allowed)
  })

  it.each([
    ['absent', undefined],
    ['null', null],
    ['conditional', false],
    ['empty array', []],
    ['empty text', ''],
  ])('hides close and creates no popup when extras are %s', (_, extras) => {
    const controller = seededController()
    const intents = spyIntents()
    renderSurface(controller, intents, true, extras === undefined ? undefined : () => extras, { canCloseTab: () => false })
    expect(screen.queryByRole('button', { name: TEST_LABELS.closeTab })).toBeNull()
    fireEvent.contextMenu(screen.getByRole('tab'))
    expect(screen.queryByRole('menuitem', { name: TEST_LABELS.closeTab })).toBeNull()
    expect(screen.queryByRole('menu')).toBeNull()
    expect(intents.closeTab).not.toHaveBeenCalled()
  })

  it('updates chip and open-menu close controls when eligibility props change', () => {
    const controller = seededController()
    const intents = spyIntents()
    const props: DockSurfaceProps = {
      state: controller.getSnapshot().state,
      canSplit: true,
      intents,
      labels: TEST_LABELS,
      renderTab: () => null,
      canCloseTab: () => false,
    }
    const { rerender } = render(<DockSurface {...props} />)
    expect(screen.queryByRole('button', { name: TEST_LABELS.closeTab })).toBeNull()
    rerender(<DockSurface {...props} canCloseTab={() => true} />)
    expect(screen.getByRole('button', { name: TEST_LABELS.closeTab })).toBeDefined()
    fireEvent.contextMenu(screen.getByRole('tab'))
    expect(screen.getByRole('menuitem', { name: TEST_LABELS.closeTab })).toBeDefined()
    rerender(<DockSurface {...props} />)
    expect(screen.queryByRole('button', { name: TEST_LABELS.closeTab })).toBeNull()
    expect(screen.queryByRole('menu')).toBeNull()
    rerender(<DockSurface {...props} canCloseTab={() => true} />)
    fireEvent.click(screen.getByRole('menuitem', { name: TEST_LABELS.closeTab }))
    expect(intents.closeTab).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('menu')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: TEST_LABELS.closeTab }))
    expect(intents.closeTab).toHaveBeenCalledTimes(2)
  })

  it.each([false, true])('hides the popup when an extras component renders no content inside a wrapper: %s', (wrapped) => {
    const EmptyExtras = () => null
    renderSurface(seededController(), spyIntents(), true,
      () => wrapped ? <div style={{ display: 'contents' }}><EmptyExtras /></div> : <EmptyExtras />,
      { canCloseTab: () => false })
    fireEvent.contextMenu(screen.getByRole('tab'))
    const menu = document.querySelector<HTMLElement>('[data-dockkit-tab-menu]')
    if (menu === null) throw new Error('expected the extras component menu')
    // Vitest stubs CSS Modules; bind the real stylesheet's menu selector to its generated class.
    const style = document.createElement('style')
    style.textContent = readFileSync(resolve(import.meta.dirname, '../src/components/dockkit.module.css'), 'utf8')
      .replaceAll(/\.menu(?=[:\s{])/g, `.${menu.className}`)
    document.head.append(style)
    onTestFinished(() => { style.remove() })
    expect(menu.querySelectorAll('[role^="menuitem"]')).toHaveLength(0)
    expect(getComputedStyle(menu).display).toBe('none')
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('toggles the menu closed on a second secondary press, and dismisses it on a press anywhere else', () => {
    const controller = seededController()
    renderSurface(controller, spyIntents())
    const tab = screen.getByRole('tab')
    fireEvent.contextMenu(tab)
    fireEvent.contextMenu(tab)
    expect(screen.queryByRole('menu')).toBeNull()

    fireEvent.contextMenu(tab)
    expect(screen.getByRole('menu')).toBeDefined()
    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('menu')).toBeNull()

    // A press with no element target, dispatched to the window itself, counts as outside.
    fireEvent.contextMenu(tab)
    fireEvent.pointerDown(window)
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('hangs the menu below the chip\'s left edge, or from its right edge when it would run off the viewport', () => {
    const controller = seededController()
    let left = 10
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return this.hasAttribute('data-dockkit-tab') ? box(left, 4, 60, 26) : box(0, 0, 0, 0)
    })
    const { unmount } = renderSurface(controller, spyIntents())
    fireEvent.contextMenu(screen.getByRole('tab'))
    expect(screen.getByRole('menu').style.top).toBe('34px')
    expect(screen.getByRole('menu').style.left).toBe('10px')
    unmount()

    left = window.innerWidth + 100
    renderSurface(controller, spyIntents())
    fireEvent.contextMenu(screen.getByRole('tab'))
    expect(screen.getByRole('menu').style.left).toBe(`${left + 60}px`)
  })

  it('offers no copy or float item: those gestures are the embedder\'s API and the drag', () => {
    const controller = seededController()
    renderSurface(controller, spyIntents())
    fireEvent.contextMenu(screen.getByRole('tab'))
    expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual([TEST_LABELS.closeTab])
    expect(document.querySelector('[data-dockkit-tab-more]')).toBeNull()
  })

  it.each([true, false])('keeps embedder menu items and their tab and dismiss when close is allowed: %s', (canClose) => {
    const controller = seededController()
    const acted = vi.fn<(contentId: string) => void>()
    const extras: TabMenuExtras = (tab, dismiss) => (
      <button
        type="button"
        role="menuitem"
        data-testid="extra"
        onClick={() => { acted(tab.contentId); dismiss() }}
      >
        embedder item
      </button>
    )
    const intents = spyIntents()
    renderSurface(controller, intents, true, extras, { canCloseTab: () => canClose })
    fireEvent.contextMenu(screen.getByRole('tab'))

    // Order is contract: the kit's own item stays in the same place in every
    // menu, so an embedder item cannot displace it.
    expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual(
      canClose ? [TEST_LABELS.closeTab, 'embedder item'] : ['embedder item'],
    )
    expect(screen.queryByRole('button', { name: TEST_LABELS.closeTab }) !== null).toBe(canClose)

    fireEvent.click(screen.getByTestId('extra'))
    expect(acted).toHaveBeenCalledWith('seed:start')
    expect(intents.closeTab).not.toHaveBeenCalled()
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('keeps a menu press from starting a tab drag', () => {
    const controller = seededController()
    const intents = spyIntents()
    renderSurface(controller, intents)
    fireEvent.contextMenu(screen.getByRole('tab'))
    const item = screen.getByRole('menuitem', { name: TEST_LABELS.closeTab })

    // A press inside the menu must not reach the chip's gesture handler; if it
    // did, the pointer would be captured and this click would never land.
    fireEvent.pointerDown(item)
    fireEvent.click(item)
    expect(intents.closeTab).toHaveBeenCalledTimes(1)
  })
})

describe('tab drags', () => {
  it('previews a caret at the slot under the pointer and reports that slot on release', () => {
    const { intents, first, fileTabId, chip } = twoPanes()
    // Left of the first chip's midpoint: slot 0.
    drag(chip(fileTabId), FILE_CHIP, [30, 18], false)
    expect(document.querySelector('[data-dockkit-caret]')?.getAttribute('data-dockkit-caret')).toBe('0')
    // Past both chips: the slot after the last one, drawn at the strip's end.
    fireEvent.pointerMove(window, { pointerId: 7, clientX: 300, clientY: 18 })
    expect(document.querySelector('[data-dockkit-caret]')?.getAttribute('data-dockkit-caret')).toBe('2')
    fireEvent.pointerUp(window, { pointerId: 7, clientX: 300, clientY: 18 })
    // The slot counts the dragged chip itself; the planner turns it into a reorder.
    expect(intents.placeTab).toHaveBeenCalledWith(fileTabId, first, 2)
    expect(gestureIntents(intents)).toEqual(['placeTab'])
    expect(document.querySelector('[data-dockkit-caret]')).toBeNull()
  })

  it('reports a slot in another pane\'s strip as a placement there', () => {
    const { intents, second, fileTabId, chip } = twoPanes()
    drag(chip(fileTabId), FILE_CHIP, [420 + 30, 18])
    expect(intents.placeTab).toHaveBeenCalledWith(fileTabId, second, 0)
  })

  it('shows the dock hint on the pane under the pointer and reports the zone on release', () => {
    const { intents, second, fileTabId, chip } = twoPanes(520)
    drag(chip(fileTabId), FILE_CHIP, [520 + 260, 300], false)
    const hint = document.querySelector(`[data-dockkit-pane="${second}"] [data-dockkit-dock-zone]`)
    expect(hint?.getAttribute('data-dockkit-dock-zone')).toBe('center')
    fireEvent.pointerMove(window, { pointerId: 7, clientX: 520 + 510, clientY: 300 })
    expect(document.querySelector('[data-dockkit-dock-zone]')?.getAttribute('data-dockkit-dock-zone')).toBe('right')
    fireEvent.pointerUp(window, { pointerId: 7, clientX: 520 + 510, clientY: 300 })
    expect(intents.dropTab).toHaveBeenCalledWith(fileTabId, second, 'right')
    expect(document.querySelector('[data-dockkit-dock-zone]')).toBeNull()
  })

  it('offers no edge zone once the pane budget is spent: a release there moves nothing', () => {
    const { intents, fileTabId, chip } = twoPanes(420, false)
    drag(chip(fileTabId), FILE_CHIP, [420 + 410, 300], false)
    expect(document.querySelector('[data-dockkit-dock-zone]')).toBeNull()
    fireEvent.pointerUp(window, { pointerId: 7, clientX: 420 + 410, clientY: 300 })
    expect(gestureIntents(intents)).toEqual([])
  })

  // 208px panes: room for a column split (600px tall) but not for a row split.
  it('offers an edge zone only on the axis the pane has room to split on', () => {
    const { intents, second, fileTabId, chip } = twoPanes(208)
    drag(chip(fileTabId), FILE_CHIP, [208 + 200, 300], false)
    expect(document.querySelector('[data-dockkit-dock-zone]')).toBeNull()
    fireEvent.pointerMove(window, { pointerId: 7, clientX: 208 + 104, clientY: 500 })
    expect(document.querySelector('[data-dockkit-dock-zone]')?.getAttribute('data-dockkit-dock-zone')).toBe('bottom')
    fireEvent.pointerMove(window, { pointerId: 7, clientX: 208 + 104, clientY: 100 })
    expect(document.querySelector('[data-dockkit-dock-zone]')?.getAttribute('data-dockkit-dock-zone')).toBe('top')
    fireEvent.pointerUp(window, { pointerId: 7, clientX: 208 + 104, clientY: 100 })
    expect(intents.dropTab).toHaveBeenCalledWith(fileTabId, second, 'top')
  })

  it('floats a tab released clear of the surface, with the panel under the drop point', () => {
    const { intents, fileTabId, chip } = twoPanes()
    drag(chip(fileTabId), FILE_CHIP, [2000, 900])
    expect(intents.floatTab).toHaveBeenCalledWith(fileTabId, floatRectAt(2000, 900, FLOAT_DEFAULT_SIZE))
    expect(gestureIntents(intents)).toEqual(['floatTab'])
  })

  it('treats a press that never travels the threshold as no drag at all', () => {
    const { intents, fileTabId, chip } = twoPanes()
    drag(chip(fileTabId), FILE_CHIP, [FILE_CHIP[0] + 2, FILE_CHIP[1] + 1], false)
    expect(document.querySelector('[data-dockkit-caret]')).toBeNull()
    fireEvent.pointerUp(window, { pointerId: 7, clientX: 2000, clientY: 900 })
    expect(gestureIntents(intents)).toEqual([])
  })

  it('ignores a secondary press: that is the menu, never a drag', () => {
    const { intents, fileTabId, chip } = twoPanes()
    fireEvent.pointerDown(chip(fileTabId), { clientX: FILE_CHIP[0], clientY: FILE_CHIP[1], pointerId: 7, button: 2 })
    fireEvent.pointerMove(window, { pointerId: 7, clientX: 2000, clientY: 900 })
    fireEvent.pointerUp(window, { pointerId: 7, clientX: 2000, clientY: 900 })
    expect(gestureIntents(intents)).toEqual([])
  })

  it('drops the preview and reports nothing when the platform cancels the pointer', () => {
    const { intents, fileTabId, chip } = twoPanes()
    drag(chip(fileTabId), FILE_CHIP, [30, 18], false)
    expect(document.querySelector('[data-dockkit-caret]')).not.toBeNull()
    fireEvent.pointerCancel(window, { pointerId: 7 })
    expect(document.querySelector('[data-dockkit-caret]')).toBeNull()
    fireEvent.pointerUp(window, { pointerId: 7, clientX: 30, clientY: 18 })
    expect(gestureIntents(intents)).toEqual([])
  })

  it('lets a new press take over from a gesture still in flight', () => {
    const { intents, first, seedTabId, fileTabId, chip } = twoPanes()
    drag(chip(fileTabId), FILE_CHIP, [30, 18], false)
    expect(document.querySelector('[data-dockkit-caret]')).not.toBeNull()
    // The second press ends the first gesture: its preview clears and its release never reports.
    fireEvent.pointerDown(chip(seedTabId), { clientX: 51, clientY: 18, pointerId: 8, button: 0 })
    expect(document.querySelector('[data-dockkit-caret]')).toBeNull()
    fireEvent.pointerMove(window, { pointerId: 8, clientX: 300, clientY: 18 })
    fireEvent.pointerUp(window, { pointerId: 8, clientX: 300, clientY: 18 })
    expect(intents.placeTab).toHaveBeenCalledTimes(1)
    expect(intents.placeTab).toHaveBeenCalledWith(seedTabId, first, 2)
  })

  it('stops following the pointer when unmounted mid-gesture', () => {
    const { intents, fileTabId, chip, unmount } = twoPanes()
    drag(chip(fileTabId), FILE_CHIP, [30, 18], false)
    unmount()
    fireEvent.pointerMove(window, { pointerId: 7, clientX: 300, clientY: 18 })
    fireEvent.pointerUp(window, { pointerId: 7, clientX: 300, clientY: 18 })
    expect(gestureIntents(intents)).toEqual([])
  })

  it('follows only its own pointer: another pointer neither moves, releases, nor cancels the gesture', () => {
    const { intents, first, fileTabId, chip } = twoPanes()
    fireEvent.pointerDown(chip(fileTabId), { clientX: FILE_CHIP[0], clientY: FILE_CHIP[1], pointerId: 7, button: 0 })
    fireEvent.pointerMove(window, { pointerId: 9, clientX: 30, clientY: 18 })
    expect(document.querySelector('[data-dockkit-caret]')).toBeNull()
    fireEvent.pointerUp(window, { pointerId: 9, clientX: 30, clientY: 18 })
    fireEvent.pointerCancel(window, { pointerId: 9 })
    expect(gestureIntents(intents)).toEqual([])
    // The gesture is still alive for its own pointer.
    fireEvent.pointerMove(window, { pointerId: 7, clientX: 30, clientY: 18 })
    expect(document.querySelector('[data-dockkit-caret]')?.getAttribute('data-dockkit-caret')).toBe('0')
    fireEvent.pointerUp(window, { pointerId: 7, clientX: 30, clientY: 18 })
    expect(intents.placeTab).toHaveBeenCalledWith(fileTabId, first, 0)
    expect(intents.placeTab).toHaveBeenCalledTimes(1)
  })

  it('captures the pointer on the pressed chip where the platform offers capture', () => {
    const capture = vi.fn<(pointerId: number) => void>()
    Object.defineProperty(HTMLElement.prototype, 'setPointerCapture', { value: capture, configurable: true, writable: true })
    try {
      const { fileTabId, chip } = twoPanes()
      fireEvent.pointerDown(chip(fileTabId), { clientX: FILE_CHIP[0], clientY: FILE_CHIP[1], pointerId: 7, button: 0 })
      expect(capture).toHaveBeenCalledWith(7)
    } finally {
      Reflect.deleteProperty(HTMLElement.prototype, 'setPointerCapture')
    }
  })
})

describe('horizontal workbench drops', () => {
  it.each([
    { x: 550, y: 300, zone: 'left' },
    { x: 1010, y: 590, zone: 'right' },
  ] as const)('offers both halves and targets $zone at ($x, $y)', ({ x, y, zone }) => {
    const { intents, second, fileTabId, chip } = twoPanes(520, true, { dropZones: 'horizontal' })
    drag(chip(fileTabId), FILE_CHIP, [x, y], false)
    const hints = document.querySelectorAll('[data-dockkit-dock-zone]')
    expect([...hints].map(hint => hint.getAttribute('data-dockkit-dock-zone'))).toEqual(['left', 'right'])
    expect(document.querySelector('[data-dockkit-drop-active]')?.getAttribute('data-dockkit-dock-zone')).toBe(zone)
    fireEvent.pointerUp(window, { pointerId: 7, clientX: x, clientY: y })
    expect(intents.dropTab).toHaveBeenCalledExactlyOnceWith(fileTabId, second, zone)
  })

  it('uses the entire other pane for moving once the split budget is spent', () => {
    const { intents, second, fileTabId, chip } = twoPanes(420, false, { dropZones: 'horizontal' })
    drag(chip(fileTabId), FILE_CHIP, [425, 590])
    expect(intents.dropTab).toHaveBeenCalledExactlyOnceWith(fileTabId, second, 'center')
  })

  it('does not offer a new split when a pane cannot fit two halves', () => {
    const { intents, second, fileTabId, chip } = twoPanes(300, true, { dropZones: 'horizontal' })
    drag(chip(fileTabId), FILE_CHIP, [450, 300], false)
    expect(document.querySelectorAll('[data-dockkit-dock-zone]')).toHaveLength(1)
    expect(document.querySelector('[data-dockkit-dock-zone]')?.getAttribute('data-dockkit-dock-zone')).toBe('center')
    fireEvent.pointerUp(window, { pointerId: 7, clientX: 450, clientY: 300 })
    expect(intents.dropTab).toHaveBeenCalledExactlyOnceWith(fileTabId, second, 'center')
  })

  it('clamps the live divider preview and committed sizes to the requested minimum', () => {
    const { intents } = twoPanes(420, false, { minPaneFraction: 0.2 })
    const divider = document.querySelector('[data-dockkit-divider]')
    if (divider === null) throw new Error('expected a divider')
    drag(divider, [420, 300], [0, 300], false)
    const cells = document.querySelectorAll<HTMLElement>('[data-dockkit-cell]')
    expect(Number(cells[0]?.style.flexGrow)).toBeCloseTo(0.2)
    expect(Number(cells[1]?.style.flexGrow)).toBeCloseTo(0.8)
    fireEvent.pointerUp(window, { pointerId: 7, clientX: 0, clientY: 300 })
    expect(intents.resizeSplit.mock.calls[0]?.[1]).toEqual([0.2, 0.8])
  })
})

describe('keyboard tabs', () => {
  /** One pane holding the seed and two files, the last opened selected, with the chips by title. */
  function threeChips(): { intents: ReturnType<typeof spyIntents>; chip: (title: string) => HTMLElement; ids: Record<string, TabId> } {
    const controller = seededController()
    const a = controller.openContent({ contentId: 'dsh-resource://file/session/s/a.txt', title: 'a.txt', kind: 'file' })
    const b = controller.openContent({ contentId: 'dsh-resource://file/session/s/b.txt', title: 'b.txt', kind: 'file' })
    const seed = getPane(controller.getSnapshot().state, controller.getSnapshot().state.rootId).tabs[0]
    if (seed === undefined) throw new Error('expected the seeded tab')
    const intents = spyIntents()
    renderSurface(controller, intents)
    const chip = (title: string): HTMLElement => screen.getByRole('tab', { name: new RegExp(title.replace('.', '\\.'), 'u') })
    return { intents, chip, ids: { Start: seed, 'a.txt': a, 'b.txt': b } }
  }

  it('puts only the selected chip in the tab order', () => {
    const { chip } = threeChips()
    expect(chip('b.txt').tabIndex).toBe(0)
    expect(chip('a.txt').tabIndex).toBe(-1)
    expect(chip('Start').tabIndex).toBe(-1)
  })

  it('moves focus with Left and Right, wrapping, and with Home and End, without selecting', () => {
    const { intents, chip } = threeChips()
    chip('b.txt').focus()
    fireEvent.keyDown(chip('b.txt'), { key: 'ArrowRight' })
    expect(document.activeElement).toBe(chip('Start'))
    fireEvent.keyDown(chip('Start'), { key: 'ArrowLeft' })
    expect(document.activeElement).toBe(chip('b.txt'))
    fireEvent.keyDown(chip('b.txt'), { key: 'ArrowLeft' })
    expect(document.activeElement).toBe(chip('a.txt'))
    fireEvent.keyDown(chip('a.txt'), { key: 'Home' })
    expect(document.activeElement).toBe(chip('Start'))
    fireEvent.keyDown(chip('Start'), { key: 'End' })
    expect(document.activeElement).toBe(chip('b.txt'))
    expect(intents.focusTab).not.toHaveBeenCalled()
  })

  it('selects the focused chip with Enter or Space, once each, and ignores other keys', () => {
    const { intents, chip, ids } = threeChips()
    chip('b.txt').focus()
    fireEvent.keyDown(chip('b.txt'), { key: 'ArrowLeft' })
    fireEvent.keyDown(chip('a.txt'), { key: 'Enter' })
    expect(intents.focusTab).toHaveBeenCalledWith(ids['a.txt'])
    fireEvent.keyDown(chip('a.txt'), { key: 'Home' })
    fireEvent.keyDown(chip('Start'), { key: ' ' })
    expect(intents.focusTab).toHaveBeenCalledWith(ids.Start)
    fireEvent.keyDown(chip('Start'), { key: 'a' })
    fireEvent.keyDown(chip('Start'), { key: 'Escape' })
    expect(intents.focusTab).toHaveBeenCalledTimes(2)
  })

  it('records nothing for Enter on the active pane\'s selected chip, and leaves keys on the close control alone', () => {
    const { intents, chip } = threeChips()
    fireEvent.keyDown(chip('b.txt'), { key: 'Enter' })
    fireEvent.keyDown(chip('b.txt'), { key: ' ' })
    const close = chip('a.txt').querySelector('[data-dockkit-tab-close]')
    if (close === null) throw new Error('expected the close control')
    fireEvent.keyDown(close, { key: 'Enter' })
    fireEvent.keyDown(close, { key: 'ArrowLeft' })
    expect(intents.focusTab).not.toHaveBeenCalled()
    expect(intents.closeTab).not.toHaveBeenCalled()
  })
})

describe('divider drags', () => {
  /** A row split whose second pane is itself split into a column: the column split's id and a spied intent set. */
  function withColumn(columnBox: DOMRect): { intents: ReturnType<typeof spyIntents>; columnId: string } {
    const controller = seededController()
    controller.setExpanded(true)
    controller.splitPane()
    const [first, second] = dockPaneIds(controller.getSnapshot().state)
    if (first === undefined || second === undefined) throw new Error('expected two docked panes')
    const opened = controller.openContent({ contentId: 'dsh-resource://file/session/s/a.txt', title: 'a.txt', kind: 'file', paneId: second })
    controller.dropTab(opened, second, 'bottom')
    const state = controller.getSnapshot().state
    const root = state.nodes[state.rootId]
    const columnId = root?.kind === 'split' ? root.children[1] : undefined
    if (columnId === undefined || state.nodes[columnId]?.kind !== 'split') throw new Error('expected a column split')
    layOut(dockPaneIds(state), 420, { [columnId]: columnBox })
    const intents = spyIntents()
    renderSurface(controller, intents)
    return { intents, columnId }
  }

  it('moves a column split\'s divider along the vertical axis', () => {
    const { intents, columnId } = withColumn(box(420, 0, 420, 600))
    const divider = document.querySelector(`[data-dockkit-divider="${columnId}:0"]`)
    if (divider === null) throw new Error('expected the column divider')
    drag(divider, [630, 300], [630, 360])
    const [reportedSplit, sizes] = intents.resizeSplit.mock.calls[0] as [string, readonly number[]]
    expect(reportedSplit).toBe(columnId)
    expect(sizes[0]).toBeCloseTo(0.6)
    expect(sizes[1]).toBeCloseTo(0.4)
  })

  it('reports nothing for a release that left the fractions where they were', () => {
    const { intents } = twoPanes()
    const divider = document.querySelector('[data-dockkit-divider]')
    if (divider === null) throw new Error('expected a divider between the two panes')
    // A click on the divider.
    drag(divider, [420, 300], [420, 300])
    // A drag returned to where it began.
    drag(divider, [420, 300], [504, 300], false)
    fireEvent.pointerMove(window, { pointerId: 7, clientX: 420, clientY: 300 })
    fireEvent.pointerUp(window, { pointerId: 7, clientX: 420, clientY: 300 })
    expect(intents.resizeSplit).not.toHaveBeenCalled()
    // A real move still reports, once.
    drag(divider, [420, 300], [504, 300])
    expect(intents.resizeSplit).toHaveBeenCalledTimes(1)
  })

  it('reports nothing along a split that has no measured extent', () => {
    const { intents, columnId } = withColumn(box(420, 0, 420, 0))
    const divider = document.querySelector(`[data-dockkit-divider="${columnId}:0"]`)
    if (divider === null) throw new Error('expected the column divider')
    drag(divider, [630, 300], [630, 360])
    expect(intents.resizeSplit).not.toHaveBeenCalled()
  })

  it('previews the fractions while the divider moves and reports the net result once', () => {
    const { intents, first, second } = twoPanes()
    const divider = document.querySelector('[data-dockkit-divider]')
    if (divider === null) throw new Error('expected a divider between the two panes')
    const splitId = divider.getAttribute('data-dockkit-divider')?.split(':')[0]
    // The split spans 840px, so 84px of travel is a tenth of it.
    drag(divider, [420, 300], [504, 300], false)
    const cell = (index: number): number =>
      Number(document.querySelector<HTMLElement>(`[data-dockkit-cell="${splitId}:${index}"]`)?.style.flexGrow)
    expect(cell(0)).toBeCloseTo(0.6)
    expect(cell(1)).toBeCloseTo(0.4)
    fireEvent.pointerUp(window, { pointerId: 7, clientX: 504, clientY: 300 })
    expect(intents.resizeSplit).toHaveBeenCalledTimes(1)
    const [reportedSplit, sizes] = intents.resizeSplit.mock.calls[0] as [string, readonly number[]]
    expect(reportedSplit).toBe(splitId)
    expect(sizes[0]).toBeCloseTo(0.6)
    expect(sizes[1]).toBeCloseTo(0.4)
    // The recorded fractions come back through the state; the preview is gone.
    expect(cell(0)).toBeCloseTo(0.5)
    expect(intents.placeTab).not.toHaveBeenCalled()
    expect([first, second]).toHaveLength(2)
  })
})

describe('FloatLayer', () => {
  /** Two floating panels, `lower` under `upper`, with `upper` active. */
  function twoFloats(): {
    intents: ReturnType<typeof spyIntents>
    lower: PaneId
    upper: PaneId
    panel: (paneId: PaneId) => HTMLElement
    part: (attribute: string, paneId: PaneId) => Element
  } {
    const controller = seededController()
    const first = controller.openContent({ contentId: 'dsh-resource://file/session/s/a.txt', title: 'a.txt', kind: 'file' })
    const second = controller.openContent({ contentId: 'dsh-resource://file/session/s/b.txt', title: 'b.txt', kind: 'file' })
    const lower = controller.floatTab(first, { x: 100, y: 80, width: 300, height: 200 })
    const upper = controller.floatTab(second, { x: 500, y: 80, width: 300, height: 200 })
    const intents = spyIntents()
    render(<FloatLayer state={controller.getSnapshot().state} intents={intents} labels={TEST_LABELS} renderTab={() => null} />)
    const part = (attribute: string, paneId: PaneId): Element => {
      const element = document.querySelector(`[${attribute}="${paneId}"]`)
      if (element === null) throw new Error(`expected ${attribute} of ${paneId}`)
      return element
    }
    const panel = (paneId: PaneId): HTMLElement => {
      const element = document.querySelector<HTMLElement>(`[data-dockkit-float="${paneId}"]`)
      if (element === null) throw new Error(`expected the panel ${paneId}`)
      return element
    }
    return { intents, lower, upper, panel, part }
  }

  /** One floating panel over a spied intent set. */
  function floating(canCloseTab?: FloatLayerProps['canCloseTab']): {
    intents: ReturnType<typeof spyIntents>
    paneId: PaneId
    tabId: TabId
    panel: HTMLElement
  } {
    const controller = seededController()
    const tabId = controller.openContent({ contentId: 'dsh-resource://file/session/s/a.txt', title: 'a.txt', kind: 'file' })
    const paneId = controller.floatTab(tabId, { x: 100, y: 80, width: 300, height: 200 })
    const intents = spyIntents()
    render(
      <FloatLayer
        state={controller.getSnapshot().state}
        intents={intents}
        labels={TEST_LABELS}
        renderTab={tab => <p data-testid="float-body">{tab.title}</p>}
        {...canCloseTab === undefined ? {} : { canCloseTab }}
      />,
    )
    const panel = document.querySelector<HTMLElement>(`[data-dockkit-float="${paneId}"]`)
    if (panel === null) throw new Error('expected a floating panel')
    return { intents, paneId, tabId, panel }
  }

  it('draws one panel per floating pane, without a tab strip', () => {
    const { intents } = floating()
    expect(screen.getByTestId('float-body').textContent).toBe('a.txt')
    expect(screen.queryByRole('tablist')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: TEST_LABELS.dockFloat }))
    expect(intents.unfloatPane).toHaveBeenCalledTimes(1)
  })

  it('closes a floating panel through its own control', () => {
    const { intents, tabId } = floating()
    fireEvent.click(screen.getByRole('button', { name: TEST_LABELS.closeFloat }))
    expect(intents.closeTab).toHaveBeenCalledWith(tabId)
  })

  it('hides a floating tab close control when the embedder disallows it', () => {
    const canCloseTab = vi.fn(() => false)
    const { intents, tabId } = floating(canCloseTab)
    expect(canCloseTab).toHaveBeenCalledWith(tabId)
    expect(screen.queryByRole('button', { name: TEST_LABELS.closeFloat })).toBeNull()
    expect(screen.getByTestId('float-body').textContent).toBe('a.txt')
    fireEvent.click(screen.getByRole('button', { name: TEST_LABELS.dockFloat }))
    expect(intents.unfloatPane).toHaveBeenCalledTimes(1)
    expect(intents.closeTab).not.toHaveBeenCalled()
  })

  it('raises a panel on a press on its body, but not from a press on its controls, grip, or corner', () => {
    const { intents, lower, panel, part } = twoFloats()
    fireEvent.pointerDown(panel(lower))
    expect(intents.focusPane).toHaveBeenCalledWith(lower)
    fireEvent.pointerDown(part('data-dockkit-float-dock', lower))
    fireEvent.pointerDown(part('data-dockkit-float-close', lower))
    fireEvent.pointerDown(part('data-dockkit-float-grip', lower), { clientX: 150, clientY: 90, pointerId: 7, button: 0 })
    fireEvent.pointerDown(part('data-dockkit-float-resize', lower), { clientX: 400, clientY: 280, pointerId: 8, button: 0 })
    expect(intents.focusPane).toHaveBeenCalledTimes(1)
  })

  it('records nothing for a press on the panel that is active and on top already', () => {
    const { intents, upper, panel, part } = twoFloats()
    fireEvent.pointerDown(panel(upper))
    // A grip or corner press released in place is a click on the same panel.
    drag(part('data-dockkit-float-grip', upper), [550, 90], [550, 90])
    drag(part('data-dockkit-float-resize', upper), [800, 280], [800, 280])
    expect(intents.focusPane).not.toHaveBeenCalled()
    expect(intents.moveFloat).not.toHaveBeenCalled()
    expect(intents.resizeFloat).not.toHaveBeenCalled()
  })

  it('raises the active panel when another has been drawn over it', () => {
    const controller = seededController()
    const first = controller.openContent({ contentId: 'dsh-resource://file/session/s/a.txt', title: 'a.txt', kind: 'file' })
    const second = controller.openContent({ contentId: 'dsh-resource://file/session/s/b.txt', title: 'b.txt', kind: 'file' })
    const lower = controller.floatTab(first, { x: 100, y: 80, width: 300, height: 200 })
    const upper = controller.floatTab(second, { x: 500, y: 80, width: 300, height: 200 })
    // Focus on the lower panel while the upper stays on top: only a recorded
    // focus snapshot puts the layout there, as an undo does.
    const buried = applyOp(controller.getSnapshot().state, {
      type: 'restoreFocus', activePaneId: lower, floats: [lower, upper], paneActiveTabs: {},
    }).state
    const intents = spyIntents()
    render(<FloatLayer state={buried} intents={intents} labels={TEST_LABELS} renderTab={() => null} />)
    const panel = document.querySelector(`[data-dockkit-float="${lower}"]`)
    if (panel === null) throw new Error('expected the lower panel')
    fireEvent.pointerDown(panel)
    expect(intents.focusPane).toHaveBeenCalledWith(lower)
  })

  it('moves a panel by its grip as one intent, previewing the position and the panel on top', () => {
    const controller = seededController()
    const first = controller.openContent({ contentId: 'dsh-resource://file/session/s/a.txt', title: 'a.txt', kind: 'file' })
    const second = controller.openContent({ contentId: 'dsh-resource://file/session/s/b.txt', title: 'b.txt', kind: 'file' })
    const lower = controller.floatTab(first, { x: 100, y: 80, width: 300, height: 200 })
    controller.floatTab(second, { x: 500, y: 80, width: 300, height: 200 })
    const intents = spyIntents()
    render(<FloatLayer state={controller.getSnapshot().state} intents={intents} labels={TEST_LABELS} renderTab={() => null} />)
    const panel = document.querySelector<HTMLElement>(`[data-dockkit-float="${lower}"]`)
    const grip = document.querySelector(`[data-dockkit-float-grip="${lower}"]`)
    if (panel === null || grip === null) throw new Error('expected the lower panel')
    expect(panel.style.zIndex).toBe('1')

    drag(grip, [150, 90], [180, 110], false)
    expect(panel.style.left).toBe('130px')
    expect(panel.style.top).toBe('100px')
    // Mid-gesture the panel draws on top, as the move it records will leave it.
    expect(panel.style.zIndex).toBe('3')
    fireEvent.pointerUp(window, { pointerId: 7, clientX: 180, clientY: 110 })
    expect(intents.moveFloat).toHaveBeenCalledWith(lower, 130, 100)
    expect(intents.moveFloat).toHaveBeenCalledTimes(1)
    expect(intents.focusPane).not.toHaveBeenCalled()
    // The recorded rectangle and depth are drawn again once the preview clears.
    expect(panel.style.left).toBe('100px')
    expect(panel.style.zIndex).toBe('1')
  })

  it('treats a press on the grip or corner released where it began as a click that raises the panel', () => {
    const { intents, lower, part } = twoFloats()
    drag(part('data-dockkit-float-grip', lower), [150, 90], [150, 90])
    drag(part('data-dockkit-float-resize', lower), [400, 280], [400, 280])
    expect(intents.focusPane).toHaveBeenCalledTimes(2)
    expect(intents.focusPane).toHaveBeenCalledWith(lower)
    expect(intents.moveFloat).not.toHaveBeenCalled()
    expect(intents.resizeFloat).not.toHaveBeenCalled()
  })

  it('resizes from the corner as one intent, holding the minimum size', () => {
    const { intents, paneId, panel } = floating()
    const corner = document.querySelector(`[data-dockkit-float-resize="${paneId}"]`)
    if (corner === null) throw new Error('expected a resize corner')
    drag(corner, [400, 280], [440, 310], false)
    expect(panel.style.width).toBe('340px')
    expect(panel.style.height).toBe('230px')
    fireEvent.pointerMove(window, { pointerId: 7, clientX: -1000, clientY: -1000 })
    expect(panel.style.width).toBe(`${FLOAT_MIN_SIZE.width}px`)
    fireEvent.pointerUp(window, { pointerId: 7, clientX: -1000, clientY: -1000 })
    expect(intents.resizeFloat).toHaveBeenCalledWith(paneId, { x: 100, y: 80, ...FLOAT_MIN_SIZE })
    expect(intents.resizeFloat).toHaveBeenCalledTimes(1)
    expect(intents.focusPane).not.toHaveBeenCalled()
  })

  it('stacks panels in the model z order', () => {
    const controller = seededController()
    const first = controller.openContent({ contentId: 'dsh-resource://file/session/s/a.txt', title: 'a.txt', kind: 'file' })
    const second = controller.openContent({ contentId: 'dsh-resource://file/session/s/b.txt', title: 'b.txt', kind: 'file' })
    controller.floatTab(first)
    controller.floatTab(second)
    render(
      <FloatLayer
        state={controller.getSnapshot().state}
        intents={spyIntents()}
        labels={TEST_LABELS}
        renderTab={() => null}
      />,
    )
    const zIndexes = screen.getAllByRole('banner').map(header => header.parentElement?.style.zIndex)
    expect(zIndexes).toEqual(['1', '2'])
  })
})

describe('surface chrome', () => {
  it('renders the embedder\'s controls once, at the end of the top-right pane\'s strip', () => {
    const controller = seededController()
    controller.setExpanded(true)
    // A row split puts the new pane to the right; a bottom drop under it puts a
    // pane below that. The top-right pane is the right column's upper one.
    controller.splitPane()
    const right = controller.getSnapshot().state
    const root = right.nodes[right.rootId]
    const rightPaneId = root?.kind === 'split' ? root.children[1] : undefined
    if (rightPaneId === undefined) throw new Error('expected a row split')
    const seeded = controller.getSnapshot().state.nodes[rightPaneId]
    if (seeded === undefined || seeded.kind !== 'pane' || seeded.tabs[0] === undefined) throw new Error('expected a seeded pane')
    const opened = controller.openContent({ contentId: 'dsh-resource://file/session/s/b.txt', title: 'b.txt', kind: 'file', paneId: seeded.id })
    controller.dropTab(opened, seeded.id, 'bottom')

    const snapshot = controller.getSnapshot()
    render(
      <DockSurface
        state={snapshot.state}
        canSplit
        intents={controller}
        labels={TEST_LABELS}
        renderTab={tab => <p>{tab.contentId}</p>}
        chrome={<button type="button">chrome</button>}
      />,
    )
    const hosts = screen.getAllByRole('button', { name: 'chrome' })
    expect(hosts).toHaveLength(1)
    const pane = hosts[0]?.closest('[data-dockkit-pane]')
    // The upper of the two right-hand panes, not the lower one the drop created.
    expect(pane?.getAttribute('data-dockkit-pane')).toBe(rightPaneId)
    // At the strip's end: after the split control.
    const strip = pane?.querySelector('[data-dockkit-strip]')
    const children = [...(strip?.children ?? [])]
    expect(children.at(-1)?.hasAttribute('data-dockkit-strip-chrome')).toBe(true)
  })

  it('keeps a click on the chrome from focusing the pane: the embedder\'s controls report their own intents', () => {
    const controller = seededController()
    const intents = spyIntents()
    render(
      <DockSurface
        state={controller.getSnapshot().state}
        canSplit
        intents={intents}
        labels={TEST_LABELS}
        renderTab={tab => <p>{tab.contentId}</p>}
        chrome={<button type="button">chrome</button>}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'chrome' }))
    expect(intents.focusPane).not.toHaveBeenCalled()
  })

  it('renders no chrome host when the embedder supplies none', () => {
    const controller = seededController()
    renderSurface(controller, spyIntents())
    expect(document.querySelector('[data-dockkit-strip-chrome]')).toBeNull()
  })

  // Layout itself is the stylesheet's; what the DOM promises is that every
  // chip and drop caret sits inside the strip's one shrinking box, and that the
  // controls after it are the strip's own children, in this order.
  it('keeps the chips in their own box ahead of the add, split, and chrome controls', () => {
    const controller = seededController()
    controller.openContent({ contentId: 'dsh-resource://file/session/s/a.txt', title: 'a.txt', kind: 'file' })
    const snapshot = controller.getSnapshot()
    render(
      <DockSurface
        state={snapshot.state}
        canSplit
        intents={controller}
        labels={TEST_LABELS}
        renderTab={tab => <p>{tab.contentId}</p>}
        chrome={<button type="button">chrome</button>}
      />,
    )
    const strip = document.querySelector('[data-dockkit-strip]')
    const role = (child: Element): string => {
      if (child.hasAttribute('data-dockkit-strip-tabs')) return 'tabs'
      if (child.hasAttribute('data-dockkit-add-tab')) return 'add'
      if (child.hasAttribute('data-dockkit-split-button')) return 'split'
      if (child.hasAttribute('data-dockkit-strip-chrome')) return 'chrome'
      return 'fill'
    }
    expect([...(strip?.children ?? [])].map(role)).toEqual(['tabs', 'add', 'fill', 'split', 'chrome'])
    expect(strip?.querySelectorAll('[data-dockkit-strip-tabs] [data-dockkit-tab]')).toHaveLength(2)
    expect(strip?.querySelectorAll(':scope > [data-dockkit-tab]')).toHaveLength(0)
  })
})

describe('a controller satisfies the intent contract', () => {
  it('accepts a DockController wherever DockIntents is required', () => {
    const controller = seededController()
    const intents: DockIntents = controller
    renderSurface(controller, intents)
    fireEvent.click(screen.getByRole('button', { name: TEST_LABELS.splitPane }))
    // One click, one entry: the split seeded its new pane, and that seating is
    // what decides the active pane — the control's click reports nothing else.
    expect(controller.ops.map(op => op.type)).toEqual(['split', 'openTab'])
  })
})

describe('fileTab', () => {
  it('builds a content tab the kit treats as opaque', () => {
    expect(fileTab(asTab('t1'), 'dsh-resource://file/session/s/x', 'x').kind).toBe('file')
  })
})
