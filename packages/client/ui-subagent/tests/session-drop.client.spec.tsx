// @vitest-environment jsdom
import { cleanup, createEvent, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { trackSessionDrags } from '../src/client/sidebar-chat/index.tsx'
import { SessionDropZone, type SessionDrag, type SessionDropZoneProps } from '../src/client/sidebar-chat/SessionDropZone.tsx'

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

const outside = { sessionId: OTHER, inset: 0, width: 0 }

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

  it('starts the target at the right edge of the frame column the row left', () => {
    const frame = document.createElement('div')
    const column = document.createElement('nav')
    const row = document.createElement('div')
    const overlay = document.createElement('div')
    overlay.setAttribute('data-shell-overlay', '')
    column.append(row)
    frame.append(column, overlay)
    document.body.append(frame)
    column.getBoundingClientRect = () => ({ right: 279.6 }) as DOMRect
    // The on-screen Session's right Sidebar panel sets the highlighted card's width; another Session's is ignored.
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
    dispatchDrag('dragstart', { 'application/x-dsh-session': OTHER }, row)
    expect(drags.source.getSnapshot()).toEqual({ sessionId: OTHER, inset: 280, width: 520 })
    // A drag whose target is not an element starts at the window edge.
    dispatchDrag('dragend')
    dispatchDrag('dragstart', { 'application/x-dsh-session': OTHER }, document)
    expect(drags.source.getSnapshot()).toEqual({ ...outside, width: 520 })
    drags.dispose()
    frame.remove()
  })
})

describe('Session drop zone', () => {
  function mount(initial: SessionId | undefined) {
    let current = initial
    const openAside = vi.fn()
    const source: HostObservable<SessionDrag | undefined> = {
      getSnapshot: () => current === undefined ? undefined : { sessionId: current, inset: 280, width: current === OTHER ? 516 : 0 },
      subscribe: () => () => {},
    }
    const props = {
      useSessionDrag: <T,>(select: (value: SessionDrag | undefined) => T) => select(source.getSnapshot()),
      openAside,
      t: (key: string) => key === 'open.sidebar' ? 'Open in sidebar' : key,
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
    expect(zone.parentElement).toBe(document.body)
    expect(zone.style.left).toBe('280px')
    // The highlighted card is as wide as the Sidebar would open, inside the 8px inset.
    expect((zone.firstElementChild as HTMLElement).style.flex).toBe('0 1 500px')
    expect(view.container.innerHTML).toBe('')
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
    expect(view.openAside).toHaveBeenCalledExactlyOnceWith(OTHER)
    expect(zone.hasAttribute('data-active')).toBe(false)

    // Without a known Sidebar width the card spans the whole target.
    view.set(MAIN)
    expect((document.querySelector('[data-session-drop-zone]')!.firstElementChild as HTMLElement).style.flex).toBe('')

    view.set(undefined)
    expect(document.querySelector('[data-session-drop-zone]')).toBeNull()
  })
})
