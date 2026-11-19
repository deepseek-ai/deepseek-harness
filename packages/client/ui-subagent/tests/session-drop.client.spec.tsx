// @vitest-environment jsdom
import { cleanup, createEvent, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { trackSessionDrags } from '../src/client/sidebar-chat/index.tsx'
import { SessionDropZone, type SessionDropZoneProps } from '../src/client/sidebar-chat/SessionDropZone.tsx'

const MAIN = 'main' as SessionId
const OTHER = 'other' as SessionId

afterEach(() => {
  cleanup()
})

/** jsdom lacks DragEvent; attach the transfer a browser would supply. */
function dispatchDrag(type: string, data: Record<string, string> = {}): void {
  const event = new Event(type, { bubbles: true })
  Object.defineProperty(event, 'dataTransfer', { value: { getData: (format: string) => data[format] ?? '' } })
  document.body.dispatchEvent(event)
}

describe('Session drag tracking', () => {
  it('publishes a dragged list Session that another on-screen Session can open', () => {
    let mounted: SessionId | undefined = MAIN
    const drags = trackSessionDrags(document, () => mounted)
    const listener = vi.fn()
    const unsubscribe = drags.source.subscribe(listener)
    expect(drags.source.getSnapshot()).toBeUndefined()

    dispatchDrag('dragstart', { 'application/x-dsh-session': OTHER })
    expect(drags.source.getSnapshot()).toBe(OTHER)
    dispatchDrag('dragend')
    expect(drags.source.getSnapshot()).toBeUndefined()
    expect(listener).toHaveBeenCalledTimes(2)

    dispatchDrag('dragstart', { 'application/x-dsh-session': OTHER })
    dispatchDrag('drop')
    expect(drags.source.getSnapshot()).toBeUndefined()

    // A row unmounted mid-drag never delivers dragend; the next button-free mouse move clears the drag.
    dispatchDrag('dragstart', { 'application/x-dsh-session': OTHER })
    document.body.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, buttons: 1 }))
    expect(drags.source.getSnapshot()).toBe(OTHER)
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
    expect(drags.source.getSnapshot()).toBe(OTHER)
  })
})

describe('Session drop zone', () => {
  function mount(initial: SessionId | undefined) {
    let current = initial
    const openAside = vi.fn()
    const source: HostObservable<SessionId | undefined> = { getSnapshot: () => current, subscribe: () => () => {} }
    const props = {
      useSessionDrag: <T,>(select: (value: SessionId | undefined) => T) => select(source.getSnapshot()),
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
    expect(view.container.innerHTML).toBe('')
    view.set(OTHER)
    const label = screen.getByText('Open in sidebar')
    const zone = view.container.querySelector('[data-session-drop-zone]') as HTMLElement
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

    view.set(undefined)
    expect(view.container.innerHTML).toBe('')
  })
})
