// @vitest-environment jsdom
import { cleanup, createEvent, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { PaneId } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { trackSessionDrags } from '../src/client/sidebar-chat/index.tsx'
import { SessionDropZone, type SessionDrag, type SessionDropZoneProps } from '../src/client/sidebar-chat/SessionDropZone.tsx'
import { createDocumentPortal } from '@deepseek-ai/dsh-client-ui-renderer/src/client/document-portal.tsx'

/** The renderer's portal into this test document, as a mounted Slot receives it. */
const Portal = createDocumentPortal(document)


const MAIN = 'main' as SessionId
const OTHER = 'other' as SessionId

afterEach(() => {
  cleanup()
})

/** jsdom lacks DragEvent; attach the transfer a browser would supply. */
function dispatchDrag(type: string, data: Record<string, string> = {}, target: EventTarget = document.body): void {
  const event = new Event(type, { bubbles: true })
  Object.defineProperty(event, 'dataTransfer', { value: { getData: (format: string) => data[format] ?? '' } })
  target.dispatchEvent(event)
}

const outside = { sessionId: OTHER, targets: [{ left: 0, top: 0, width: 0, height: 0 }] }

describe('Session drag tracking', () => {
  it('publishes a dragged list Session that another on-screen Session can open', () => {
    let mounted: SessionId | undefined = MAIN
    const drags = trackSessionDrags(document, () => mounted)
    const listener = vi.fn()
    const unsubscribe = drags.source.subscribe(listener)
    expect(drags.source.getSnapshot()).toBeUndefined()

    dispatchDrag('dragstart', { 'application/x-dsh-session': OTHER })
    expect(drags.source.getSnapshot()).toEqual(outside)
    dispatchDrag('dragend')
    expect(drags.source.getSnapshot()).toBeUndefined()
    expect(listener).toHaveBeenCalledTimes(2)

    dispatchDrag('dragstart', { 'application/x-dsh-session': OTHER })
    dispatchDrag('drop')
    expect(drags.source.getSnapshot()).toBeUndefined()

    // A row unmounted mid-drag never delivers dragend; the next button-free mouse move clears the drag.
    dispatchDrag('dragstart', { 'application/x-dsh-session': OTHER })
    document.body.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, buttons: 1 }))
    expect(drags.source.getSnapshot()).toEqual(outside)
    document.body.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, buttons: 0 }))
    expect(drags.source.getSnapshot()).toBeUndefined()

    // The on-screen Session itself, a drag without Session data, and no on-screen Session publish nothing.
    dispatchDrag('dragstart', { 'application/x-dsh-session': MAIN })
    dispatchDrag('dragstart', { 'text/plain': OTHER })
    mounted = undefined
    dispatchDrag('dragstart', { 'application/x-dsh-session': OTHER })
    expect(drags.source.getSnapshot()).toBeUndefined()
    expect(listener).toHaveBeenCalledTimes(6)

    unsubscribe()
    mounted = MAIN
    dispatchDrag('dragstart', { 'application/x-dsh-session': OTHER })
    expect(listener).toHaveBeenCalledTimes(6)
    drags.dispose()
    dispatchDrag('dragend')
    expect(drags.source.getSnapshot()).toEqual(outside)
  })

  it('measures the on-screen Sidebar: its docked panes while open, else the area it would open in', () => {
    const frame = document.createElement('div')
    const column = document.createElement('nav')
    const row = document.createElement('div')
    const overlay = document.createElement('div')
    overlay.setAttribute('data-shell-overlay', '')
    column.append(row)
    frame.append(column, overlay)
    document.body.append(frame)
    column.getBoundingClientRect = () => ({ right: 279.6, top: 0 }) as DOMRect
    const width = vi.spyOn(document.documentElement, 'clientWidth', 'get').mockReturnValue(1440)
    const height = vi.spyOn(document.documentElement, 'clientHeight', 'get').mockReturnValue(800)
    // Another Session's panel is ignored.
    const panel = document.createElement('div')
    panel.setAttribute('data-sidebar-right-panel', 'push')
    panel.setAttribute('data-sidebar-right-session', MAIN)
    panel.getBoundingClientRect = () => ({ width: 520.2 }) as DOMRect
    const otherPanel = document.createElement('div')
    otherPanel.setAttribute('data-sidebar-right-panel', 'push')
    otherPanel.setAttribute('data-sidebar-right-session', OTHER)
    otherPanel.getBoundingClientRect = () => ({ width: 900 }) as DOMRect
    frame.append(otherPanel, panel)
    const drags = trackSessionDrags(document, () => MAIN)
    // Collapsed: the area the Sidebar would open in, never left of the navigation column.
    dispatchDrag('dragstart', { 'application/x-dsh-session': OTHER }, row)
    expect(drags.source.getSnapshot()).toEqual({ sessionId: OTHER, targets: [{ left: 920, top: 0, width: 520, height: 800 }] })
    dispatchDrag('dragend')
    panel.getBoundingClientRect = () => ({ width: 1300 }) as DOMRect
    dispatchDrag('dragstart', { 'application/x-dsh-session': OTHER }, row)
    expect(drags.source.getSnapshot()).toEqual({ sessionId: OTHER, targets: [{ left: 280, top: 0, width: 1160, height: 800 }] })
    dispatchDrag('dragend')

    // Open: one target per visible docked pane, so the divider between panes and the chat area stay uncovered.
    panel.setAttribute('data-sidebar-right-open', '')
    const pane = (id: string, rect: Partial<DOMRect>): HTMLElement => {
      const element = document.createElement('section')
      element.setAttribute('data-dockkit-pane', id)
      element.getBoundingClientRect = () => rect as DOMRect
      panel.append(element)
      return element
    }
    const left = pane('p1', { left: 920.4, top: 0, width: 259.5, height: 800 })
    pane('p2', { left: 1181, top: 0, width: 259, height: 800 })
    pane('hidden', { left: 0, top: 0, width: 0, height: 0 })
    dispatchDrag('dragstart', { 'application/x-dsh-session': OTHER }, row)
    expect(drags.source.getSnapshot()).toEqual({ sessionId: OTHER, targets: [
      { paneId: 'p1', left: 920, top: 0, width: 260, height: 800 },
      { paneId: 'p2', left: 1181, top: 0, width: 259, height: 800 },
    ] })
    dispatchDrag('dragend')
    // An open panel without a measured pane falls back to the panel area.
    for (const element of panel.querySelectorAll('[data-dockkit-pane]')) element.remove()
    left.remove()
    dispatchDrag('dragstart', { 'application/x-dsh-session': OTHER }, row)
    expect(drags.source.getSnapshot()).toEqual({ sessionId: OTHER, targets: [{ left: 280, top: 0, width: 1160, height: 800 }] })
    dispatchDrag('dragend')
    // A drag whose target is not an element starts at the window edge.
    panel.remove()
    otherPanel.remove()
    dispatchDrag('dragstart', { 'application/x-dsh-session': OTHER }, document)
    expect(drags.source.getSnapshot()).toEqual({ sessionId: OTHER, targets: [{ left: 0, top: 0, width: 1440, height: 800 }] })
    drags.dispose()
    width.mockRestore()
    height.mockRestore()
    frame.remove()
  })
})

describe('Session drop zone', () => {
  function mount(initial: SessionId | undefined) {
    let current = initial
    const openAside = vi.fn()
    const source: HostObservable<SessionDrag | undefined> = {
      getSnapshot: () => current === undefined ? undefined : {
        sessionId: current,
        targets: current === OTHER
          ? [{ left: 924, top: 0, width: 516, height: 800 }]
          : [{ paneId: 'p1' as PaneId, left: 920, top: 0, width: 260, height: 800 }, { paneId: 'p2' as PaneId, left: 1181, top: 0, width: 259, height: 800 }],
      },
      subscribe: () => () => {},
    }
    const props = {
      useSessionDrag: <T,>(select: (value: SessionDrag | undefined) => T) => select(source.getSnapshot()),
      openAside,
      t: (key: string) => key === 'open.sidebar' ? 'Open in sidebar' : key,
      useDocumentPortal: () => Portal,
    } as Partial<SessionDropZoneProps> as SessionDropZoneProps
    const view = render(<SessionDropZone {...props} />)
    return {
      ...view,
      openAside,
      set: (next: SessionId | undefined) => {
        current = next
        view.rerender(<SessionDropZone {...props} />)
      },
    }
  }

  function fire(target: Element, kind: 'dragEnter' | 'dragOver' | 'dragLeave' | 'drop', relatedTarget?: Node | null) {
    const event = createEvent[kind](target)
    const transfer = { dropEffect: 'none' }
    Object.defineProperties(event, { dataTransfer: { value: transfer }, relatedTarget: { value: relatedTarget ?? null } })
    fireEvent(target, event)
    return { event, transfer }
  }

  it('renders only during a Session drag and opens the dropped Session aside', () => {
    const view = mount(undefined)
    expect(document.querySelector('[data-session-drop-zone]')).toBeNull()
    view.set(OTHER)
    const label = screen.getByText('Open in sidebar')
    // The zone portals to the body so it stacks above the narrow-window drawer mask.
    const zone = document.querySelector<HTMLElement>('[data-session-drop-zone]')!
    expect(document.body.contains(zone)).toBe(true)
    expect([zone.style.left, zone.style.top, zone.style.width, zone.style.height]).toEqual(['924px', '0px', '516px', '800px'])
    expect(view.container.contains(zone)).toBe(false)
    expect(zone.hasAttribute('data-active')).toBe(false)

    const over = fire(zone, 'dragOver')
    expect(over.event.defaultPrevented).toBe(true)
    expect(over.transfer.dropEffect).toBe('copy')
    expect(zone.hasAttribute('data-active')).toBe(true)
    // Moving between the zone's own children keeps the highlight; leaving the zone clears it.
    fire(zone, 'dragLeave', label)
    expect(zone.hasAttribute('data-active')).toBe(true)
    fire(zone, 'dragLeave', null)
    expect(zone.hasAttribute('data-active')).toBe(false)
    fire(zone, 'dragEnter')
    expect(zone.hasAttribute('data-active')).toBe(true)

    const documentDrop = vi.fn()
    document.addEventListener('drop', documentDrop)
    const drop = fire(zone, 'drop')
    document.removeEventListener('drop', documentDrop)
    expect(drop.event.defaultPrevented).toBe(true)
    expect(documentDrop).not.toHaveBeenCalled()
    expect(view.openAside).toHaveBeenCalledExactlyOnceWith(OTHER, undefined)
    expect(zone.hasAttribute('data-active')).toBe(false)

    // A split Sidebar shows one target per pane, and a drop opens the Session in that pane.
    view.set(MAIN)
    const panes = document.querySelectorAll<HTMLElement>('[data-session-drop-zone]')
    expect([...panes].map(element => element.dataset.sessionDropZone)).toEqual(['p1', 'p2'])
    // With several panes, each target keeps its card hidden until the pointer is over it.
    expect([...panes].every(element => element.hasAttribute('data-quiet'))).toBe(true)
    expect(zone.hasAttribute('data-quiet')).toBe(false)
    fire(panes[1]!, 'drop')
    expect(view.openAside).toHaveBeenLastCalledWith(MAIN, 'p2')

    view.set(undefined)
    expect(document.querySelector('[data-session-drop-zone]')).toBeNull()
  })
})
