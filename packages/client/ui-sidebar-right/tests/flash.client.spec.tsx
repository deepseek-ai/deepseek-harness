// @vitest-environment jsdom
/** The glow a reveal draws on the revealed tab's pane. */
import { afterEach, expect, it } from 'vitest'
import { act } from '@testing-library/react'
import type { PaneId } from '@deepseek-ai/dsh-client-ui-dockkit'
import { flashPane } from '../src/client/shell/flash.ts'

afterEach(() => { document.body.replaceChildren() })

/** jsdom has no AnimationEvent, so the event carries its name as a plain property. */
function animation(target: Element, type: 'animationstart' | 'animationend' | 'animationcancel', animationName: string): void {
  act(() => { target.dispatchEvent(Object.assign(new Event(type, { bubbles: true }), { animationName })) })
}

it('marks the named docked or floating pane until its own animation ends', () => {
  document.body.innerHTML = '<div id="root"><section data-dockkit-pane="pane1"><p></p></section><section data-dockkit-float="pane2"></section></div>'
  const root = document.getElementById('root')!
  const docked = root.querySelector<HTMLElement>('[data-dockkit-pane]')!
  flashPane(root, { paneId: 'pane1' as PaneId, serial: 1 })
  expect(docked.dataset.sidebarRightFlash).toBe('odd')
  animation(docked, 'animationstart', 'flashOdd')
  // A child's animation is not the glow's.
  animation(docked.querySelector('p')!, 'animationstart', 'spin')
  animation(docked.querySelector('p')!, 'animationend', 'flashOdd')
  expect(docked.dataset.sidebarRightFlash).toBe('odd')
  animation(docked, 'animationend', 'flashOdd')
  expect(docked.dataset.sidebarRightFlash).toBeUndefined()
  const floating = root.querySelector<HTMLElement>('[data-dockkit-float]')!
  flashPane(root, { paneId: 'pane2' as PaneId, serial: 2 })
  expect(floating.dataset.sidebarRightFlash).toBe('even')
  animation(floating, 'animationstart', 'flashEven')
  animation(floating, 'animationcancel', 'flashEven')
  expect(floating.dataset.sidebarRightFlash).toBeUndefined()
  // The cleanup removes the mark at once, as the seat does before the next request.
  const clear = flashPane(root, { paneId: 'pane2' as PaneId, serial: 3 })!
  expect(floating.dataset.sidebarRightFlash).toBe('odd')
  clear()
  expect(floating.dataset.sidebarRightFlash).toBeUndefined()
})

it('keeps a repeated glow on the same pane through the cancellation of the previous one', () => {
  document.body.innerHTML = '<div id="root"><section data-dockkit-pane="pane1"></section></div>'
  const root = document.getElementById('root')!
  const pane = root.querySelector<HTMLElement>('[data-dockkit-pane]')!
  const clear = flashPane(root, { paneId: 'pane1' as PaneId, serial: 1 })!
  animation(pane, 'animationstart', 'flashOdd')
  clear()
  flashPane(root, { paneId: 'pane1' as PaneId, serial: 2 })
  // The browser cancels the replaced keyframes before the new ones start.
  animation(pane, 'animationcancel', 'flashOdd')
  expect(pane.dataset.sidebarRightFlash).toBe('even')
  animation(pane, 'animationstart', 'flashEven')
  animation(pane, 'animationend', 'flashOdd')
  expect(pane.dataset.sidebarRightFlash).toBe('even')
  animation(pane, 'animationend', 'flashEven')
  expect(pane.dataset.sidebarRightFlash).toBeUndefined()
})

it('marks nothing without a panel, a request, or the named pane', () => {
  document.body.innerHTML = '<div id="root"></div>'
  const root = document.getElementById('root')!
  expect(flashPane(null, { paneId: 'pane1' as PaneId, serial: 1 })).toBeUndefined()
  expect(flashPane(root, undefined)).toBeUndefined()
  expect(flashPane(root, { paneId: 'pane1' as PaneId, serial: 1 })).toBeUndefined()
})
