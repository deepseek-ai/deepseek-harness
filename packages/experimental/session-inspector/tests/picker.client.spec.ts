// @vitest-environment jsdom
/** The Inspector mask hit-tests underlying Chat identities and owns the selection gesture. */

import { expect, it, onTestFinished, vi } from 'vitest'
import { matchChatElement, matchChatNodeRow } from '../src/client/views/chat-node/pick-match.ts'
import { mainChatRoot } from '../src/client/views/chat-node/dom.ts'
import { InspectorChatPicker } from '../src/client/views/chat-node/picker.ts'
import type { InspectorChatTarget } from '../src/client/views/objects.ts'

function fixture() {
  const container = document.createElement('div')
  const owner = document.createElement('button')
  const main = document.createElement('div')
  main.dataset.slot = 'main.conversation'
  const view = document.createElement('div')
  view.dataset.slot = 'conversation.view'
  const root = document.createElement('div')
  root.dataset.chatFlow = ''
  const group = document.createElement('div')
  group.dataset.chatGroupKey = 'group'
  group.dataset.chatTurn = '3'
  const node = document.createElement('div')
  node.dataset.chatNodeKey = 'node'
  node.dataset.chatGroupPart = 'reasoning'
  node.dataset.chatFlowKind = 'assistant-step'
  const call = document.createElement('div')
  call.dataset.chatCallId = 'call'
  const action = document.createElement('button')
  action.textContent = 'Original action'
  call.append(action); node.append(call); group.append(node); root.append(group)
  view.append(root); main.append(view); container.append(owner, main); document.body.append(container)
  root.getBoundingClientRect = () => new DOMRect(0, 0, 400, 300)
  call.getBoundingClientRect = () => new DOMRect(10, 20, 200, 80)
  const mask = () => document.querySelector<HTMLElement>('[data-session-inspector-picker]')
  let hit: Element = action
  const descriptor = Object.getOwnPropertyDescriptor(document, 'elementsFromPoint')
  Object.defineProperty(document, 'elementsFromPoint', {
    configurable: true,
    value: () => [mask(), hit].filter((element): element is Element => element !== null),
  })
  onTestFinished(() => {
    container.remove()
    if (descriptor === undefined) Reflect.deleteProperty(document, 'elementsFromPoint')
    else Object.defineProperty(document, 'elementsFromPoint', descriptor)
  })
  return { container, owner, main, view, root, group, node, call, action, mask, setHit: (element: Element) => { hit = element } }
}

it('uses existing Slot/Chat markers and excludes hidden, nested, and Sidebar occurrences', () => {
  const { container, root, node, group, call, action } = fixture()
  expect(mainChatRoot()).toBe(root)
  expect(matchChatElement(action, root)).toEqual({ element: call, target: {
    callId: 'call', nodeKey: 'node', groupPart: 'reasoning', nodeKind: 'assistant-step', groupKey: 'group', turn: 3,
  } })
  expect(matchChatElement(group, root)).toEqual({ element: group, target: { groupKey: 'group', turn: 3 } })
  expect(matchChatElement(node, document.createElement('div'))).toBeUndefined()
  container.dataset.sidebarRightSession = 'sidebar'
  expect(mainChatRoot()).toBeUndefined()
  expect(matchChatElement(action, root)).toBeUndefined()
  delete container.dataset.sidebarRightSession
  group.hidden = true
  expect(matchChatElement(action, root)).toBeUndefined()
  group.hidden = false
  const nested = document.createElement('div')
  nested.dataset.slot = 'conversation.view'
  const child = document.createElement('span')
  nested.append(child); node.append(nested)
  expect(matchChatElement(child, root)).toBeUndefined()
  container.style.display = 'none'
  expect(mainChatRoot()).toBeUndefined()
})

it('selects the exact group part before broader Node, Group, Step, and Turn matches', () => {
  const rows = new Map<string, InspectorChatTarget>([
    ['group-row', { groupKey: 'group' }],
    ['answer-row', { nodeKey: 'node', groupPart: 'response', turn: 3, step: 1 }],
    ['reasoning-row', { nodeKey: 'node', groupPart: 'reasoning', turn: 3, step: 1 }],
    ['next-step', { nodeKey: 'next', turn: 3, step: 2 }],
  ])
  expect(matchChatNodeRow({ nodeKey: 'node', groupPart: 'reasoning', groupKey: 'group' }, rows)).toBe('reasoning-row')
  expect(matchChatNodeRow({ nodeKey: 'node' }, rows)).toBe('answer-row')
  expect(matchChatNodeRow({ groupKey: 'group' }, rows)).toBe('group-row')
  expect(matchChatNodeRow({ turn: 3, step: 2 }, rows)).toBe('next-step')
  expect(matchChatNodeRow({ turn: 3 }, rows)).toBe('answer-row')
  expect(matchChatNodeRow({ turn: 4 }, rows)).toBeUndefined()
})

it('hit-tests below the mask, keeps the hover preview, and consumes selection once', async () => {
  const { container, owner, action, mask } = fixture()
  const picked = vi.fn(() => true)
  const cancelled = vi.fn()
  const picker = new InspectorChatPicker(mainChatRoot, owner, picked, cancelled, vi.fn())
  onTestFinished(() => { picker.dispose() })
  const activated = vi.fn()
  action.addEventListener('click', activated)
  expect(picker.start()).toBe(true)
  expect(mask()?.parentElement).toBe(document.body)
  mask()!.dispatchEvent(new MouseEvent('pointermove', { clientX: 30, clientY: 40 }))
  const overlay = document.querySelector<HTMLElement>('[data-session-inspector-highlight="pick"]')!
  expect(overlay).not.toBe(container)
  expect(overlay.getAttribute('aria-hidden')).toBe('true')
  expect(overlay.style.left).toBe('10px')
  await Promise.resolve()
  expect(overlay.isConnected).toBe(true)
  const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
  mask()!.dispatchEvent(down)
  expect(down.defaultPrevented).toBe(true)
  const click = new MouseEvent('click', { bubbles: true, cancelable: true, clientX: 30, clientY: 40 })
  mask()!.dispatchEvent(click)
  expect(click.defaultPrevented).toBe(true)
  expect(picked).toHaveBeenCalledWith(expect.objectContaining({ nodeKey: 'node', callId: 'call' }))
  expect(activated).not.toHaveBeenCalled()
  expect(mask()).toBeNull()
  expect(overlay.isConnected).toBe(false)
  expect(cancelled).not.toHaveBeenCalled()
  action.click()
  expect(activated).toHaveBeenCalledOnce()
})

it('keeps unmatched picks active, cancels with Escape, and leaves outside controls untouched', () => {
  const { owner, action, mask, setHit } = fixture()
  const picked = vi.fn(() => false)
  const cancelled = vi.fn()
  const picker = new InspectorChatPicker(mainChatRoot, owner, picked, cancelled, vi.fn())
  onTestFinished(() => { picker.dispose() })
  picker.start()
  const outside = vi.fn()
  owner.addEventListener('click', outside)
  owner.click()
  expect(outside).toHaveBeenCalledOnce()
  setHit(owner)
  mask()!.click()
  expect(picked).not.toHaveBeenCalled()
  setHit(action)
  mask()!.click(); mask()!.click()
  expect(picked).toHaveBeenCalledTimes(2)
  document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
  expect(cancelled).toHaveBeenCalledOnce()
  expect(mask()).toBeNull()
  action.click()
  expect(picked).toHaveBeenCalledTimes(2)
})

it('forwards wheel movement to the underlying Chat scrollport', () => {
  const { owner, view, root, mask } = fixture()
  const scroller = document.createElement('div')
  scroller.dataset.conversationScroll = ''
  scroller.getBoundingClientRect = () => new DOMRect(0, 0, 400, 300)
  view.replaceChild(scroller, root); scroller.append(root)
  Object.defineProperties(scroller, { clientHeight: { value: 300 }, scrollHeight: { value: 1000 } })
  const scrollBy = vi.fn()
  scroller.scrollBy = scrollBy
  const picker = new InspectorChatPicker(mainChatRoot, owner, () => false, vi.fn(), vi.fn())
  onTestFinished(() => { picker.dispose() })
  picker.start()
  mask()!.dispatchEvent(new WheelEvent('wheel', { deltaY: 50, cancelable: true }))
  expect(scrollBy).toHaveBeenCalledWith({ top: 50, left: 0, behavior: 'instant' })
})

it('releases its mask when the Inspector is hidden', async () => {
  const { container, owner, mask } = fixture()
  const cancelled = vi.fn()
  const picker = new InspectorChatPicker(mainChatRoot, owner, () => true, cancelled, vi.fn())
  onTestFinished(() => { picker.dispose() })
  picker.start()
  const mounted = mask()!
  container.hidden = true
  await Promise.resolve()
  expect(cancelled).toHaveBeenCalledOnce()
  expect(mounted.isConnected).toBe(false)
})

it('refuses a missing Chat and cancels when the current Session no longer owns it', () => {
  const { owner, mask } = fixture()
  let current = false
  const cancelled = vi.fn()
  const picker = new InspectorChatPicker(() => current ? mainChatRoot() : undefined, owner, () => true, cancelled, vi.fn())
  onTestFinished(() => { picker.dispose() })
  expect(picker.start()).toBe(false)
  expect(mask()).toBeNull()
  current = true
  expect(picker.start()).toBe(true)
  current = false
  mask()!.dispatchEvent(new MouseEvent('pointermove'))
  expect(cancelled).toHaveBeenCalledOnce()
  expect(mask()).toBeNull()
})

it('reuses hover previews, ignores non-primary clicks, and cancels when the Chat is outside the viewport', () => {
  const { root, call, owner, mask, setHit } = fixture()
  const picked = vi.fn(() => false)
  const cancelled = vi.fn()
  const picker = new InspectorChatPicker(mainChatRoot, owner, picked, cancelled, vi.fn())
  onTestFinished(() => { picker.dispose() })
  root.getBoundingClientRect = () => new DOMRect(0, 2000, 400, 300)
  expect(picker.start()).toBe(false)
  root.getBoundingClientRect = () => new DOMRect(0, 0, 400, 300)
  expect(picker.start()).toBe(true)
  mask()!.dispatchEvent(new MouseEvent('pointermove'))
  const preview = document.querySelector('[data-session-inspector-highlight="pick"]')
  mask()!.dispatchEvent(new MouseEvent('pointermove'))
  expect(document.querySelector('[data-session-inspector-highlight="pick"]')).toBe(preview)
  mask()!.dispatchEvent(new MouseEvent('click', { button: 1 }))
  expect(picked).not.toHaveBeenCalled()
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
  expect(mask()).not.toBeNull()
  setHit(root)
  mask()!.dispatchEvent(new MouseEvent('pointermove'))
  expect(document.querySelector('[data-session-inspector-highlight="pick"]')).toBeNull()
  setHit(call)
  call.getBoundingClientRect = () => new DOMRect(0, 2000, 200, 80)
  mask()!.dispatchEvent(new MouseEvent('pointermove'))
  expect(document.querySelector('[data-session-inspector-highlight="pick"]')).toBeNull()
  root.getBoundingClientRect = () => new DOMRect(0, 2000, 400, 300)
  window.dispatchEvent(new Event('resize'))
  expect(cancelled).toHaveBeenCalledOnce()
  expect(mask()).toBeNull()
})

it.each(['cancel', 'dispose'] as const)('ignores saved pointer and observer callbacks after %s', (ending) => {
  const { owner, mask } = fixture()
  const registrations = vi.spyOn(EventTarget.prototype, 'addEventListener')
  const windowRegistrations = vi.spyOn(window, 'addEventListener')
  const mutations: MutationCallback[] = []
  vi.stubGlobal('ResizeObserver', undefined)
  vi.stubGlobal('MutationObserver', class {
    constructor(callback: MutationCallback) { mutations.push(callback) }
    observe() {}
    disconnect() {}
  })
  const cancelled = vi.fn()
  const picked = vi.fn(() => true)
  const picker = new InspectorChatPicker(mainChatRoot, owner, picked, cancelled, vi.fn())
  onTestFinished(() => { picker.dispose(); windowRegistrations.mockRestore(); registrations.mockRestore(); vi.unstubAllGlobals() })
  picker.start()
  const mounted = mask()!
  const callbacks = [...registrations.mock.calls, ...windowRegistrations.mock.calls].map(([type, callback]) => ({ type, callback }))
  if (ending === 'cancel') window.dispatchEvent(new Event('blur'))
  else picker.dispose()
  for (const { type, callback } of callbacks) {
    if (!['pointermove', 'click', 'wheel', 'blur', 'resize'].includes(type)) continue
    const event = type === 'wheel' ? new WheelEvent(type) : new MouseEvent(type)
    if (typeof callback === 'function') callback.call(mounted, event)
    else callback?.handleEvent(event)
  }
  for (const callback of mutations) callback([], {} as MutationObserver)
  expect(mask()).toBeNull()
  expect(picked).not.toHaveBeenCalled()
  expect(cancelled).toHaveBeenCalledTimes(ending === 'cancel' ? 1 : 0)
})

it.each([
  { deltaX: 0, deltaY: 2, mode: 1, lineHeight: '20px', fontSize: '10px', top: 10, left: 10, expected: { top: 40, left: 0 } },
  { deltaX: 0, deltaY: -2, mode: 1, lineHeight: 'normal', fontSize: '10px', top: 10, left: 10, expected: { top: -20, left: 0 } },
  { deltaX: 0, deltaY: 1, mode: 1, lineHeight: '', fontSize: '', top: 10, left: 10, expected: { top: 1, left: 0 } },
  { deltaX: 0, deltaY: 1, mode: 2, lineHeight: '', fontSize: '', top: 10, left: 10, expected: { top: 300, left: 0 } },
  { deltaX: -10, deltaY: 0, mode: 0, lineHeight: '', fontSize: '', top: 10, left: 10, expected: { top: 0, left: -10 } },
  { deltaX: 10, deltaY: 0, mode: 0, lineHeight: '', fontSize: '', top: 10, left: 0, expected: { top: 0, left: 10 } },
  { deltaX: 0, deltaY: 10, mode: 0, lineHeight: '', fontSize: '', top: 700, left: 0, expected: undefined },
  { deltaX: 0, deltaY: -10, mode: 0, lineHeight: '', fontSize: '', top: 0, left: 0, expected: undefined },
  { deltaX: -10, deltaY: 0, mode: 0, lineHeight: '', fontSize: '', top: 0, left: 0, expected: undefined },
])('forwards wheel units and available directions: %j', ({ deltaX, deltaY, mode, lineHeight, fontSize, top, left, expected }) => {
  const { owner, view, root, mask } = fixture()
  const scroller = document.createElement('div')
  scroller.dataset.conversationScroll = ''
  scroller.getBoundingClientRect = () => new DOMRect(0, 0, 400, 300)
  view.replaceChild(scroller, root); scroller.append(root)
  Object.defineProperties(scroller, { clientHeight: { value: 300 }, scrollHeight: { value: 1000 },
    clientWidth: { value: 400 }, scrollWidth: { value: 800 } })
  scroller.scrollTop = top
  scroller.scrollLeft = left
  scroller.style.lineHeight = lineHeight
  scroller.style.fontSize = fontSize
  const scroll = vi.fn()
  scroller.scrollBy = scroll
  const picker = new InspectorChatPicker(mainChatRoot, owner, () => false, vi.fn(), vi.fn())
  onTestFinished(() => { picker.dispose() })
  picker.start()
  mask()!.dispatchEvent(new WheelEvent('wheel', { deltaX, deltaY, deltaMode: mode, cancelable: true }))
  if (expected === undefined) expect(scroll).not.toHaveBeenCalled()
  else expect(scroll).toHaveBeenCalledWith({ ...expected, behavior: 'instant' })
})
