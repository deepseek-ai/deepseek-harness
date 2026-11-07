// @vitest-environment jsdom
/**
 * The bonus notice card reports display only when the server's copy is
 * actually on screen: it needs a visible sidebar and document, and one presented
 * frame. Closing counts as seen because the user acted on it.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AccountNoticeStack } from '../src/client/AccountNotifications.tsx'
import { notification } from './notification-fixture.ts'

const disconnect = vi.fn()
const observers: VisibilityObserver[] = []
let intersecting = true

class VisibilityObserver implements IntersectionObserver {
  readonly root = null
  readonly rootMargin = '0px'
  readonly scrollMargin = '0px'
  readonly thresholds = [0]
  private target!: Element
  constructor(private readonly callback: IntersectionObserverCallback) { observers.push(this) }
  observe(target: Element): void { this.target = target; this.notify(intersecting) }
  unobserve(): void {}
  disconnect = disconnect
  takeRecords(): IntersectionObserverEntry[] { return [] }
  notify(visible: boolean): void {
    const rect = new DOMRect(0, 0, 260, 100)
    this.callback([{
      target: this.target, isIntersecting: visible, intersectionRatio: visible ? 1 : 0,
      time: 0, boundingClientRect: rect, intersectionRect: rect, rootBounds: null,
    }], this)
  }
}
let visibility: 'visible' | 'hidden' = 'visible'
/** Frame callbacks the card scheduled, in order. */
let frames: (() => void)[] = []
/** @param value - visibility the card observes. */
function setVisibility(value: 'visible' | 'hidden'): void {
  visibility = value
  document.dispatchEvent(new Event('visibilitychange'))
}

beforeEach(() => {
  visibility = 'visible'
  intersecting = true
  observers.length = 0
  frames = []
  vi.stubGlobal('IntersectionObserver', VisibilityObserver)
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility })
  // jsdom drives requestAnimationFrame from its own clock, so the test presents frames explicitly.
  vi.stubGlobal('requestAnimationFrame', (callback: () => void) => { frames.push(callback); return frames.length })
  vi.stubGlobal('cancelAnimationFrame', () => {})
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); vi.restoreAllMocks(); disconnect.mockClear() })

function mount(id: string, onShown = vi.fn(), onDismiss = vi.fn()) {
  const onCtaClicked = vi.fn()
  const view = render(<>
    <AccountNoticeStack key={id} closeLabel="Close" onOpenAccount={() => {}}
      notices={[notification(id, { displayUntil: '2099-01-01T00:00:00Z' })]}
      onShown={onShown} onCtaClicked={onCtaClicked} onDismiss={onDismiss} />
  </>)
  return { view, onShown, onCtaClicked, onDismiss }
}

/**
 * Present every scheduled frame, then run the following task that reports the display.
 * @param after - hook between the frame and its follow-up task.
 */
async function presentFrames(after?: () => void): Promise<void> {
  await act(async () => {
    for (const frame of frames.splice(0)) frame()
    after?.()
    await new Promise((resolve) => { setTimeout(resolve, 0) })
  })
}

it('renders server copy without moving focus and reports display after a presented frame', async () => {
  const initialFocus = document.activeElement
  const { onShown, onDismiss } = mount('order-1')
  expect(screen.getByRole('status').textContent).toBe('Bonus creditedServer copy 5.00')
  expect(document.activeElement).toBe(initialFocus)
  await expect(`${screen.getByRole('status').textContent}\n`).toMatchFileSnapshot('./expected/notice.txt')
  expect(onShown).not.toHaveBeenCalled()
  await presentFrames()
  expect(onShown).toHaveBeenCalledWith('order-1')
  expect(onDismiss).not.toHaveBeenCalled()
})

it('defers the display report until the document is visible', async () => {
  setVisibility('hidden')
  const { onShown } = mount('order-1')
  await presentFrames()
  expect(onShown).not.toHaveBeenCalled()
  setVisibility('visible')
  await presentFrames()
  expect(onShown).toHaveBeenCalledOnce()
})

it('waits for another visible frame when the document hides before the follow-up task', async () => {
  const onShown = vi.fn()
  mount('order-1', onShown)
  // The frame presents, then the window hides before the after-paint task runs.
  await presentFrames(() => { setVisibility('hidden') })
  expect(onShown).not.toHaveBeenCalled()
  setVisibility('visible')
  expect(onShown).not.toHaveBeenCalled()
  await presentFrames()
  expect(onShown).toHaveBeenCalledExactlyOnceWith('order-1')
})

it('reports dismissal without a CTA click when the close icon is clicked', async () => {
  const { onShown, onCtaClicked, onDismiss } = mount('order-1')
  await presentFrames()
  fireEvent.click(screen.getByRole('button', { name: 'Close' }))
  expect(onDismiss).toHaveBeenCalledWith('order-1')
  expect(onShown).toHaveBeenCalledOnce()
  expect(onCtaClicked).not.toHaveBeenCalled()
})

it('reports neither display nor dismissal when unmounted before its frame', async () => {
  const onShown = vi.fn()
  const onDismiss = vi.fn()
  const { view } = mount('order-1', onShown, onDismiss)
  view.unmount()
  await presentFrames()
  expect(onShown).not.toHaveBeenCalled()
  expect(onDismiss).not.toHaveBeenCalled()
})

it('does not render an award that expired before the card mounted', async () => {
  const onShown = vi.fn()
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2100-01-01T00:00:00Z'))
  mount('order-1', onShown)
  expect(screen.queryByRole('status')).toBeNull()
  await presentFrames()
  expect(onShown).not.toHaveBeenCalled()
})

it('reports display from the following task when the host has no frame clock', () => {
  vi.useFakeTimers()
  vi.stubGlobal('requestAnimationFrame', undefined)
  const { onShown } = mount('order-1')
  expect(onShown).not.toHaveBeenCalled()
  act(() => { vi.runAllTimers() })
  expect(onShown).toHaveBeenCalledExactlyOnceWith('order-1')
})

it.each([true, false])('cancels the presentation task when the card unmounts first (frame clock: %s)', (frameClock) => {
  vi.useFakeTimers()
  if (frameClock) {
    vi.stubGlobal('requestAnimationFrame', (callback: () => void) => { frames.push(callback); return frames.length })
    vi.stubGlobal('cancelAnimationFrame', () => {})
  } else vi.stubGlobal('requestAnimationFrame', undefined)
  const onShown = vi.fn()
  const { view } = mount('order-1', onShown)
  act(() => { for (const frame of frames.splice(0)) frame() })
  view.unmount()
  act(() => { vi.runAllTimers() })
  expect(onShown).not.toHaveBeenCalled()
})

it('keeps back cards mounted but inaccessible and reports them only after promotion', async () => {
  const onShown = vi.fn()
  const onDismiss = vi.fn()
  const notices = ['first', 'second', 'third'].map(id => notification(id, {
    title: id, body: `${id} copy`, actions: [{ label: 'Dismiss', style: 'secondary', target: { type: 'dismiss' } }],
  }))
  const tree = (remaining: typeof notices) => <>
    <AccountNoticeStack notices={remaining} closeLabel="Close" onOpenAccount={() => {}}
      onShown={onShown} onCtaClicked={vi.fn()} onDismiss={onDismiss} />
  </>
  const view = render(tree(notices))
  const second = screen.getByText('second copy').closest('aside')
  expect(document.querySelectorAll('aside')).toHaveLength(3)
  expect(screen.getAllByRole('status')).toHaveLength(1)
  expect(second?.querySelector('button')?.tabIndex).toBe(-1)
  await presentFrames()
  expect(onShown).toHaveBeenCalledExactlyOnceWith('first')
  fireEvent.click(screen.getByRole('button', { name: 'Close' }))
  expect(onDismiss).toHaveBeenCalledExactlyOnceWith('first')
  view.rerender(tree(notices.slice(1)))
  expect(screen.getByText('second copy').closest('aside')).toBe(second)
  expect(second?.querySelector('button')?.tabIndex).toBe(0)
  expect(onShown).toHaveBeenCalledTimes(1)
  await presentFrames()
  expect(onShown).toHaveBeenLastCalledWith('second')
  expect(onShown).toHaveBeenCalledTimes(2)
})

it('keeps sidebar cards mounted without reporting until they enter the viewport', async () => {
  intersecting = false
  const { view, onShown, onDismiss } = mount('notice')
  const card = view.container.querySelector('aside')
  expect(card).not.toBeNull()
  expect(view.container.contains(screen.getByRole('status'))).toBe(true)
  await presentFrames()
  expect(onShown).not.toHaveBeenCalled()
  act(() => { observers[0]!.notify(true) })
  await presentFrames()
  expect(onShown).toHaveBeenCalledExactlyOnceWith('notice')
  act(() => { observers[0]!.notify(false); observers[0]!.notify(true) })
  await presentFrames()
  expect(view.container.querySelector('aside')).toBe(card)
  expect(onShown).toHaveBeenCalledOnce()
  expect(onDismiss).not.toHaveBeenCalled()
})

it.each(['hidden', 'inert'])('does not report when its sidebar becomes %s before the presentation task', async (attribute) => {
  const { view, onShown } = mount('notice')
  await presentFrames(() => { view.container.setAttribute(attribute, '') })
  expect(onShown).not.toHaveBeenCalled()
  view.container.removeAttribute(attribute)
  act(() => { observers[0]!.notify(true) })
  await presentFrames()
  expect(onShown).toHaveBeenCalledExactlyOnceWith('notice')
})

it('does not report when the card leaves the viewport before the presentation task', async () => {
  const { onShown } = mount('notice')
  await presentFrames(() => { observers[0]!.notify(false) })
  expect(onShown).not.toHaveBeenCalled()
})

it.each(['primary', 'secondary'] as const)('reports non-dismiss %s actions and keeps focus while localized content changes', async (style) => {
  const onShown = vi.fn()
  const onDismiss = vi.fn()
  const onOpenAccount = vi.fn()
  const onCtaClicked = vi.fn()
  const content = (chinese: boolean) => notification('notice', {
    title: chinese ? '产品公告' : 'Product news', body: chinese ? '新功能已上线' : 'New features',
    actions: [
      { label: chinese ? '查看余额' : 'View balance', style, target: { type: 'app_route', name: 'account' } },
      { label: chinese ? '知道了' : 'Got it', style, target: { type: 'dismiss' } },
    ],
  })
  const tree = (chinese: boolean) => <>
    <AccountNoticeStack closeLabel="Close" notices={[content(chinese)]}
      onShown={onShown} onCtaClicked={onCtaClicked} onDismiss={onDismiss} onOpenAccount={onOpenAccount} />
  </>
  const view = render(tree(false))
  await presentFrames()
  const button = screen.getByRole('button', { name: 'View balance' })
  button.focus()
  fireEvent.click(button)
  expect(onOpenAccount).toHaveBeenCalledOnce()
  expect(onCtaClicked).toHaveBeenCalledExactlyOnceWith('notice')
  expect(onDismiss).not.toHaveBeenCalled()
  view.rerender(tree(true))
  expect(screen.getByRole('button', { name: '查看余额' })).toBe(button)
  expect(document.activeElement).toBe(button)
  await presentFrames()
  expect(onShown).toHaveBeenCalledExactlyOnceWith('notice')
  fireEvent.click(screen.getByRole('button', { name: '知道了' }))
  expect(onDismiss).toHaveBeenCalledExactlyOnceWith('notice')
  expect(onCtaClicked).toHaveBeenCalledOnce()
})

it('renders separate buttons for repeated action targets', () => {
  const output = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  render(<>
    <AccountNoticeStack closeLabel="Close" onOpenAccount={() => {}}
      onShown={vi.fn()} onCtaClicked={vi.fn()} onDismiss={vi.fn()} notices={[notification('notice', { actions: [
        { label: 'Got it', style: 'primary', target: { type: 'dismiss' } },
        { label: 'Later', style: 'secondary', target: { type: 'dismiss' } },
      ] })]} />
  </>)
  expect(screen.getByRole('button', { name: 'Got it' })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Later' })).toBeTruthy()
  expect(output).not.toHaveBeenCalled()
})
