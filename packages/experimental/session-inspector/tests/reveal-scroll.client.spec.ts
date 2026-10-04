// @vitest-environment jsdom
/** Smooth Chat navigation waits for all moving ancestors and releases its callbacks on cancellation. */

import { expect, it, onTestFinished, vi } from 'vitest'
import { InspectorChatRevealer } from '../src/client/views/chat-node/reveal.ts'

function fixture(reducedMotion = false) {
  vi.useFakeTimers()
  const frames = new Map<number, FrameRequestCallback>()
  let nextFrame = 0
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++nextFrame, callback); return nextFrame })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id) })
  vi.stubGlobal('matchMedia', () => ({ matches: reducedMotion }))
  const scroller = document.createElement('div')
  scroller.dataset.conversationScroll = ''
  const root = document.createElement('div')
  root.dataset.chatFlow = ''
  const group = document.createElement('div')
  group.dataset.stepProcessBody = ''
  const row = document.createElement('div')
  row.dataset.chatNodeKey = 'node'
  group.append(row); root.append(group); scroller.append(root); document.body.append(scroller)
  let top = 500
  row.getBoundingClientRect = () => new DOMRect(20, top, 180, 60)
  group.getBoundingClientRect = () => new DOMRect(0, 0, 300, 250)
  scroller.getBoundingClientRect = () => new DOMRect(0, 0, 400, 400)
  Object.defineProperties(scroller, { scrollHeight: { configurable: true, value: 1000 }, clientHeight: { configurable: true, value: 400 } })
  const scrollTo = vi.fn()
  scroller.scrollTo = scrollTo
  const scroll = vi.fn()
  row.scrollIntoView = scroll
  const original = Object.getOwnPropertyDescriptor(Element.prototype, 'animate')
  let finish = (): void => {}
  const animations: { cancel: () => void; onfinish: (() => void) | null }[] = []
  const animate = vi.fn(() => {
    const animation = { cancel: vi.fn(), onfinish: null as (() => void) | null }
    animations.push(animation)
    finish = () => { animation.onfinish?.() }
    return animation
  })
  Object.defineProperty(Element.prototype, 'animate', { configurable: true, value: animate })
  const navigation = vi.fn()
  scroller.addEventListener('beforematch', navigation)
  let current = true
  const locator = new InspectorChatRevealer(() => current ? root : undefined)
  onTestFinished(() => {
    locator.dispose()
    scroller.remove()
    if (original === undefined) Reflect.deleteProperty(Element.prototype, 'animate')
    else Object.defineProperty(Element.prototype, 'animate', original)
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })
  const tick = () => { const pending = [...frames.values()]; frames.clear(); for (const callback of pending) callback(0) }
  const reveal = () => { locator.reveal([{ nodeKey: 'node' }]); tick() }
  return { root, scroller, scrollTo, group, row, locator, scroll, animate, animations, tick, reveal, navigation,
    setCurrent: (value: boolean) => { current = value },
    finish: () => { finish() }, setTop: (value: number) => { top = value } }
}

it('uses native smooth scrolling and flashes only after both main and group scrolling end', () => {
  const { scroller, group, reveal, scroll, animate, tick, setTop, navigation, finish } = fixture()
  const scrollNotice = vi.fn()
  const endNotice = vi.fn()
  scroller.addEventListener('scroll', scrollNotice)
  scroller.addEventListener('scrollend', endNotice)
  reveal()
  expect(navigation).toHaveBeenCalledOnce()
  expect(navigation.mock.invocationCallOrder[0]).toBeLessThan(scroll.mock.invocationCallOrder[0]!)
  expect(scroll).toHaveBeenCalledWith({ behavior: 'smooth', block: 'center', inline: 'nearest' })
  expect(scrollNotice).not.toHaveBeenCalled()
  expect(endNotice).not.toHaveBeenCalled()
  scroller.dispatchEvent(new Event('scroll'))
  group.dispatchEvent(new Event('scroll'))
  setTop(100)
  scroller.dispatchEvent(new Event('scrollend'))
  tick()
  expect(animate).not.toHaveBeenCalled()
  group.dispatchEvent(new Event('scrollend'))
  tick(); tick()
  expect(animate).toHaveBeenCalledOnce()
  expect((document.body.lastElementChild as HTMLElement).style.top).toBe('100px')
  expect(vi.getTimerCount()).toBe(0)
  finish()
})

it('only flashes an already visible target without releasing its Chat scroll policy', () => {
  const { reveal, scroll, animate, tick, setTop, navigation } = fixture()
  setTop(100)
  reveal(); tick()
  expect(navigation).not.toHaveBeenCalled()
  expect(scroll).not.toHaveBeenCalled()
  expect(animate).toHaveBeenCalledOnce()
})

it.each(['hidden', 'empty'])('continues past %s exact content to a visible Turn occurrence', (kind) => {
  const { root, row, locator, tick, animate, scroll } = fixture()
  if (kind === 'hidden') row.hidden = true
  else row.getBoundingClientRect = () => new DOMRect(20, 100, 180, 0)
  const nearby = document.createElement('div')
  nearby.dataset.chatTurn = '1'
  nearby.getBoundingClientRect = () => new DOMRect(20, 120, 180, 60)
  root.append(nearby)
  locator.reveal([{ nodeKey: 'node', turn: 1 }])
  tick(); tick()
  expect(animate).toHaveBeenCalledOnce()
  expect(scroll).not.toHaveBeenCalled()
  expect((document.body.lastElementChild as HTMLElement).style.top).toBe('120px')
})

it('uses the next ranked Node when the exact identity cannot be displayed', () => {
  const { root, row, locator, tick, animate } = fixture()
  row.hidden = true
  const nearby = document.createElement('div')
  nearby.dataset.chatNodeKey = 'nearby'
  nearby.getBoundingClientRect = () => new DOMRect(20, 80, 180, 60)
  root.append(nearby)
  locator.reveal([{ nodeKey: 'node' }, { nodeKey: 'nearby' }])
  tick(); tick()
  expect(animate).toHaveBeenCalledOnce()
  expect((document.body.lastElementChild as HTMLElement).style.top).toBe('80px')
})

it('highlights the displayed Chat column when no candidate has a rendered box', () => {
  const { root, row, locator, tick, animate } = fixture()
  row.hidden = true
  root.getBoundingClientRect = () => new DOMRect(10, 40, 240, 200)
  locator.reveal([{ nodeKey: 'node' }])
  tick(); tick()
  expect(animate).toHaveBeenCalledOnce()
  expect((document.body.lastElementChild as HTMLElement).style.height).toBe('200px')
  locator.dispose()
  animate.mockClear()
  root.remove()
  locator.reveal([{ nodeKey: 'node' }])
  tick(); tick()
  expect(animate).not.toHaveBeenCalled()
})

it('finds a replacement Node after revealing its folded ancestor', () => {
  const { scroller, row, locator, tick, animate } = fixture()
  const replacement = document.createElement('div')
  replacement.dataset.chatNodeKey = 'node'
  replacement.getBoundingClientRect = () => new DOMRect(20, 70, 180, 60)
  scroller.addEventListener('beforematch', () => { row.replaceWith(replacement) }, { once: true })
  locator.reveal([{ nodeKey: 'node' }])
  tick(); tick()
  expect(animate).toHaveBeenCalledOnce()
  expect((document.body.lastElementChild as HTMLElement).style.top).toBe('70px')
})

it('uses a visible fallback when the selected Node disappears before its queued flash', () => {
  const { root, row, locator, tick, animate, setTop } = fixture()
  setTop(100)
  const nearby = document.createElement('div')
  nearby.dataset.chatNodeKey = 'nearby'
  nearby.getBoundingClientRect = () => new DOMRect(20, 80, 180, 60)
  root.append(nearby)
  locator.reveal([{ nodeKey: 'node' }, { nodeKey: 'nearby' }])
  tick()
  row.remove()
  tick()
  expect(animate).toHaveBeenCalledOnce()
  expect((document.body.lastElementChild as HTMLElement).style.top).toBe('80px')
})

it('highlights the visible Chat column if the scrolled target becomes hidden', () => {
  const { root, row, locator, tick, animate, scroller } = fixture()
  root.getBoundingClientRect = () => new DOMRect(10, 40, 240, 200)
  locator.reveal([{ nodeKey: 'node' }])
  tick()
  scroller.dispatchEvent(new Event('scroll'))
  row.hidden = true
  scroller.dispatchEvent(new Event('scrollend'))
  tick(); tick()
  expect(animate).toHaveBeenCalledOnce()
  expect((document.body.lastElementChild as HTMLElement).style.height).toBe('200px')
})

it('does not visit a fallback removed while an earlier candidate is being revealed', () => {
  const { root, row, locator, tick, animate, scroller } = fixture()
  row.hidden = true
  const nearby = document.createElement('div')
  nearby.dataset.chatNodeKey = 'nearby'
  nearby.getBoundingClientRect = () => new DOMRect(20, 80, 180, 60)
  root.append(nearby)
  scroller.addEventListener('beforematch', () => { nearby.remove() }, { once: true })
  locator.reveal([{ nodeKey: 'node' }, { nodeKey: 'nearby' }])
  tick(); tick()
  expect(animate).not.toHaveBeenCalled()
})

it('cancels the queued highlight when the inspected Session leaves the main area', () => {
  const { reveal, tick, animate, setTop, setCurrent } = fixture()
  setTop(100)
  reveal()
  setCurrent(false)
  tick()
  expect(animate).not.toHaveBeenCalled()
})

it('smoothly reveals an earlier row above the loaded viewport', () => {
  const { scroller, reveal, scroll, animate, tick, setTop } = fixture()
  setTop(-800)
  reveal()
  expect(scroll).toHaveBeenCalledExactlyOnceWith({ behavior: 'smooth', block: 'center', inline: 'nearest' })
  scroller.dispatchEvent(new Event('scroll'))
  setTop(60)
  scroller.dispatchEvent(new Event('scrollend'))
  tick(); tick()
  expect(animate).toHaveBeenCalledOnce()
  expect((document.body.lastElementChild as HTMLElement).style.top).toBe('60px')
})

it('settles from quiet native scrolling when scrollend is unavailable', () => {
  const { scroller, reveal, animate, tick, setTop } = fixture()
  reveal()
  scroller.dispatchEvent(new Event('scroll'))
  vi.advanceTimersByTime(100)
  scroller.dispatchEvent(new Event('scroll'))
  setTop(100)
  vi.advanceTimersByTime(100)
  tick()
  expect(animate).not.toHaveBeenCalled()
  vi.advanceTimersByTime(50)
  tick()
  expect(animate).toHaveBeenCalledOnce()
})

it('stops a pending native scroll on user input and discards an older request on replacement', () => {
  const { scroller, scrollTo, locator, reveal, animate, tick } = fixture()
  reveal()
  scroller.scrollTop = 80
  scroller.dispatchEvent(new Event('scroll'))
  window.dispatchEvent(new WheelEvent('wheel'))
  expect(scrollTo).toHaveBeenCalledWith({ top: 80, left: 0, behavior: 'instant' })
  expect(vi.getTimerCount()).toBe(0)
  reveal()
  locator.reveal([{ nodeKey: 'missing' }])
  tick()
  vi.runAllTimers()
  tick()
  expect(animate).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
})

it('keeps reduced-motion navigation immediate and does not flash', () => {
  const { reveal, scroll, animate, tick, setTop } = fixture(true)
  scroll.mockImplementation(() => { setTop(100) })
  reveal()
  expect(scroll).toHaveBeenCalledWith({ behavior: 'instant', block: 'center', inline: 'nearest' })
  tick()
  expect(animate).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
})

it('drops a missing or changed Session and removed targets during disclosure', () => {
  const { scroller, row, locator, tick, scroll, animate, setCurrent } = fixture()
  setCurrent(false)
  locator.reveal([{ nodeKey: 'node' }]); tick()
  expect(scroll).not.toHaveBeenCalled()
  setCurrent(true)
  scroller.addEventListener('beforematch', () => { setCurrent(false) }, { once: true })
  locator.reveal([{ nodeKey: 'node' }]); tick()
  expect(scroll).not.toHaveBeenCalled()
  setCurrent(true)
  scroller.addEventListener('beforematch', () => { row.remove() }, { once: true })
  locator.reveal([{ nodeKey: 'node' }]); tick()
  expect(scroll).not.toHaveBeenCalled()
  expect(animate).not.toHaveBeenCalled()
})

it('discards a queued flash when the row becomes hidden or leaves the viewport', () => {
  const { row, reveal, tick, animate, setTop } = fixture()
  setTop(100)
  reveal()
  row.hidden = true
  tick()
  expect(animate).not.toHaveBeenCalled()
  row.hidden = false
  reveal()
  setTop(1500)
  tick()
  expect(animate).not.toHaveBeenCalled()
})

it('ignores unrelated scrolls and restarts settlement when movement resumes before its frame', () => {
  const { scroller, reveal, tick, animate, setTop } = fixture()
  const scrolling = Object.getOwnPropertyDescriptor(document, 'scrollingElement')
  Object.defineProperty(document, 'scrollingElement', { configurable: true, value: document.documentElement })
  onTestFinished(() => {
    if (scrolling === undefined) Reflect.deleteProperty(document, 'scrollingElement')
    else Object.defineProperty(document, 'scrollingElement', scrolling)
  })
  reveal()
  window.dispatchEvent(new Event('scroll'))
  window.dispatchEvent(new Event('scrollend'))
  scroller.dispatchEvent(new Event('scrollend'))
  document.dispatchEvent(new Event('scroll'))
  document.dispatchEvent(new Event('scrollend'))
  scroller.dispatchEvent(new Event('scroll'))
  tick()
  expect(animate).not.toHaveBeenCalled()
  scroller.dispatchEvent(new Event('scrollend'))
  scroller.dispatchEvent(new Event('scroll'))
  scroller.dispatchEvent(new Event('scrollend'))
  setTop(100)
  tick(); tick()
  expect(animate).toHaveBeenCalledOnce()
})

it('contains late quiet and interruption callbacks after cancelling a pending settlement frame', () => {
  const { scroller, reveal, tick, animate } = fixture()
  const timers = vi.spyOn(window, 'setTimeout')
  const listeners = vi.spyOn(window, 'addEventListener')
  onTestFinished(() => { timers.mockRestore(); listeners.mockRestore() })
  reveal()
  const quiet = timers.mock.calls[0]![0]
  const interrupt = listeners.mock.calls.find(([type]) => type === 'wheel')![1] as EventListener
  scroller.dispatchEvent(new Event('scroll'))
  scroller.dispatchEvent(new Event('scrollend'))
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }))
  expect(vi.getTimerCount()).toBeGreaterThan(0)
  interrupt(new WheelEvent('wheel'))
  interrupt(new WheelEvent('wheel'))
  quiet()
  tick()
  expect(vi.getTimerCount()).toBe(0)
  expect(animate).not.toHaveBeenCalled()
})

it('does not let a replaced animation remove the new highlight', () => {
  const { reveal, tick, animate, animations, setTop } = fixture()
  setTop(100)
  reveal(); tick()
  const oldFinish = animations[0]!.onfinish!
  reveal(); tick()
  expect(animate).toHaveBeenCalledTimes(2)
  oldFinish()
  expect(document.querySelector('[data-session-inspector-highlight="reveal"]')).not.toBeNull()
})
