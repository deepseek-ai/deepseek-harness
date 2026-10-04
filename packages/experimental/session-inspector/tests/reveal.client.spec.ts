// @vitest-environment jsdom
/** Inspector opens existing searchable folds and draws only a body-level overlay. */

import { expect, it, onTestFinished, vi } from 'vitest'
import { InspectorChatRevealer } from '../src/client/views/chat-node/reveal.ts'

it('reveals nested folds in order, selects the exact group part, and cancels its overlay resources', () => {
  const frames = new Map<number, FrameRequestCallback>()
  let nextFrame = 0
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++nextFrame, callback); return nextFrame })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id) })
  vi.stubGlobal('matchMedia', () => ({ matches: false }))
  onTestFinished(() => { vi.unstubAllGlobals() })
  const tick = () => { const pending = [...frames]; frames.clear(); for (const [, callback] of pending) callback(0) }
  const scroller = document.createElement('div')
  scroller.dataset.conversationScroll = ''
  const root = document.createElement('div')
  root.dataset.chatFlow = ''
  const outer = document.createElement('div')
  const inner = document.createElement('div')
  const row = document.createElement('div')
  row.dataset.chatNodeKey = 'node'
  row.dataset.chatGroupPart = 'reasoning'
  const otherPart = document.createElement('div')
  otherPart.dataset.chatNodeKey = 'node'
  otherPart.dataset.chatGroupPart = 'response'
  outer.setAttribute('hidden', 'until-found')
  inner.setAttribute('hidden', 'until-found')
  const order: string[] = []
  outer.addEventListener('beforematch', () => { order.push('turn'); outer.removeAttribute('hidden') })
  inner.addEventListener('beforematch', () => { order.push('group'); inner.removeAttribute('hidden') })
  inner.append(row); outer.append(inner); root.append(otherPart, outer); scroller.append(root); document.body.append(scroller)
  onTestFinished(() => { scroller.remove() })
  const scroll = vi.fn()
  row.scrollIntoView = scroll
  let rowTop = 30
  row.getBoundingClientRect = () => new DOMRect(20, rowTop, 200, 60)
  scroller.getBoundingClientRect = () => new DOMRect(0, 0, 400, 400)
  const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'animate')
  const animation = { cancel: vi.fn(), onfinish: null as (() => void) | null }
  Object.defineProperty(Element.prototype, 'animate', { configurable: true, value: () => animation })
  onTestFinished(() => {
    if (descriptor === undefined) Reflect.deleteProperty(Element.prototype, 'animate')
    else Object.defineProperty(Element.prototype, 'animate', descriptor)
  })
  const locator = new InspectorChatRevealer(() => root)
  onTestFinished(() => { locator.dispose() })
  const scrollEnd = vi.fn()
  scroller.addEventListener('scrollend', scrollEnd)
  locator.reveal([{ nodeKey: 'node', groupPart: 'reasoning' }])
  tick()
  expect(order).toEqual(['turn', 'group'])
  expect(scroll).not.toHaveBeenCalled()
  expect(scrollEnd).not.toHaveBeenCalled()
  tick()
  const overlay = document.body.lastElementChild as HTMLElement
  expect(overlay).not.toBe(scroller)
  expect(overlay.style.top).toBe('30px')
  expect(overlay.getAttribute('aria-hidden')).toBe('true')
  expect(row.childNodes).toHaveLength(0)
  expect(row.getAttribute('style')).toBeNull()
  locator.dispose()
  expect(overlay.isConnected).toBe(false)
  expect(animation.cancel).toHaveBeenCalledOnce()
  const call = document.createElement('div')
  call.dataset.chatCallId = 'nested-call'
  row.append(call)
  const callScroll = vi.fn()
  call.scrollIntoView = callScroll
  call.getBoundingClientRect = () => new DOMRect(20, 500, 200, 60)
  locator.reveal([{ nodeKey: 'node', callId: 'nested-call' }])
  tick()
  expect(callScroll).toHaveBeenCalledOnce()
  expect(callScroll).toHaveBeenCalledWith({ behavior: 'smooth', block: 'center', inline: 'nearest' })
  locator.dispose()
  row.removeAttribute('data-chat-group-part')
  otherPart.remove()
  scroll.mockClear()
  rowTop = 500
  locator.reveal([{ nodeKey: 'node', groupPart: 'reasoning' }])
  tick()
  expect(scroll).toHaveBeenCalledOnce()
  locator.dispose()
  rowTop = 350
  scroll.mockClear()
  locator.reveal([{ nodeKey: 'node' }])
  tick()
  expect(scroll).not.toHaveBeenCalled()
  tick()
  expect((document.body.lastElementChild as HTMLElement).style.height).toBe('50px')
  locator.dispose()
  locator.reveal([{ nodeKey: 'node' }])
  locator.dispose()
  expect(frames.size).toBe(0)
})
