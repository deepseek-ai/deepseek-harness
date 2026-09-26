// @vitest-environment jsdom

import { expect, it, onTestFinished, vi } from 'vitest'
import { ChatViewport } from '../src/client/chat/use-chat-viewport.ts'
import { ScrollFollow, scrollMetrics } from '../src/client/chat/use-scroll-follow.ts'

function fixture() {
  const column = document.createElement('div')
  column.dataset.chatFlow = ''
  document.body.append(column)
  const viewport = new ChatViewport()
  const hitTest = Object.getOwnPropertyDescriptor(document, 'elementsFromPoint')
  Object.defineProperty(document, 'elementsFromPoint', { configurable: true, value: undefined })
  onTestFinished(() => {
    viewport.detach()
    column.remove()
    if (hitTest === undefined) Reflect.deleteProperty(document, 'elementsFromPoint')
    else Object.defineProperty(document, 'elementsFromPoint', hitTest)
    vi.restoreAllMocks()
  })
  Object.defineProperties(column, {
    clientHeight: { configurable: true, value: 300 },
    scrollHeight: { configurable: true, value: 2_000 },
  })
  vi.spyOn(column, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 500, 300))
  viewport.attach(column, column)
  let prependedHeight = 0
  const group = () => {
    const element = document.createElement('div')
    element.dataset.chatGroupKey = 'group'
    element.style.display = 'contents'
    column.append(element)
    return element
  }
  const row = (parent: HTMLElement, nodeKey: string, top: number, part?: string) => {
    const element = document.createElement('div')
    element.textContent = nodeKey
    element.dataset.chatNodeKey = nodeKey
    element.dataset.chatAnchorKey = part === undefined || part === 'response' ? nodeKey : JSON.stringify([nodeKey, part])
    element.dataset.chatFlowKey = element.dataset.chatAnchorKey
    element.dataset.chatPagingAnchor = ''
    element.dataset.chatTurn = '1'
    parent.append(element)
    vi.spyOn(element, 'getBoundingClientRect').mockImplementation(() =>
      new DOMRect(0, top + prependedHeight - column.scrollTop, 500, 60))
    return element
  }
  return { column, viewport, group, row, prepend: (height: number) => { prependedHeight += height } }
}

it.each([64, 4096])('locates the reading Turn with logarithmic outer-row measurements (%s rows)', (count) => {
  const h = fixture()
  const rows = Array.from({ length: count }, (_, index) => {
    const row = h.row(h.column, `turn-${index + 1}`, index * 100)
    row.dataset.chatTurn = String(index + 1)
    return row
  })
  h.viewport.updateTurns(rows.map((row, index) => ({
    turn: index + 1, anchorKey: row.dataset.chatAnchorKey!, prompt: '', response: '',
  })))
  const selected = Math.floor(count * 0.73)
  h.column.scrollTop = selected * 100 + 10
  const hitTest = vi.fn(() => [])
  Object.defineProperty(document, 'elementsFromPoint', { configurable: true, value: hitTest })
  const query = vi.spyOn(h.column, 'querySelectorAll')

  expect(h.viewport.readVisibleTurn()).toBe(selected + 1)
  expect(hitTest).not.toHaveBeenCalled()
  expect(query).not.toHaveBeenCalled()
  const measurements = rows.reduce((sum, row) => sum + vi.spyOn(row, 'getBoundingClientRect').mock.calls.length, 0)
  expect(measurements).toBeLessThanOrEqual(Math.ceil(Math.log2(count)) + 1)
})

it('uses outer group geometry and keeps the preceding Turn in a gap', () => {
  const h = fixture()
  h.row(h.column, 'first', 0)
  const group = h.row(h.column, 'group', 100)
  group.dataset.chatGroupKey = 'group'
  group.dataset.chatTurn = '2'
  const body = document.createElement('div')
  group.append(body)
  const member = h.row(body, 'member', -500)
  vi.spyOn(member, 'getBoundingClientRect').mockImplementation(() => { throw new Error('measured inside a group') })
  const empty = h.row(h.column, 'empty', 180)
  empty.textContent = ''
  empty.dataset.chatTurn = '2'
  vi.spyOn(empty, 'getBoundingClientRect').mockImplementation(() => new DOMRect(0, 180 - h.column.scrollTop, 500, 0))
  const hidden = h.row(h.column, 'hidden-control', 180)
  hidden.dataset.chatTurn = '2'
  hidden.setAttribute('hidden', 'until-found')
  vi.spyOn(hidden, 'getBoundingClientRect').mockImplementation(() => new DOMRect(0, 180 - h.column.scrollTop, 500, 0))
  const next = h.row(h.column, 'next', 300)
  next.dataset.chatTurn = '3'
  h.viewport.updateTurns([1, 2, 3].map(turn => ({ turn, anchorKey: String(turn), prompt: '', response: '' })))

  for (const collapsed of [false, true]) {
    body.toggleAttribute('hidden', collapsed)
    h.column.scrollTop = 80
    expect(h.viewport.readVisibleTurn()).toBe(2)
    h.column.scrollTop = 160
    expect(h.viewport.readVisibleTurn()).toBe(2)
    h.column.scrollTop = 240
    expect(h.viewport.readVisibleTurn()).toBe(3)
  }
  expect(vi.spyOn(member, 'getBoundingClientRect')).not.toHaveBeenCalled()
  const inserted = h.row(h.column, 'prepended', -100)
  inserted.dataset.chatTurn = '0'
  h.column.prepend(inserted)
  h.column.scrollTop = 160
  expect(h.viewport.readVisibleTurn()).toBe(2)
})

it('reads only the supplied column and reuses a known Turn landing', () => {
  const h = fixture()
  const list = document.createElement('div')
  h.column.replaceWith(list)
  list.append(h.column)
  onTestFinished(() => { list.remove() })
  Object.defineProperties(list, {
    clientHeight: { value: 300 }, scrollHeight: { value: 2_000 },
  })
  vi.spyOn(list, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 500, 300))
  h.viewport.attach(list, h.column)
  h.viewport.updateTurns([{ turn: 7, anchorKey: 'seven', prompt: '', response: '' }])
  const row = h.row(h.column, 'seven', 0)
  row.dataset.chatTurn = '7'
  const rail = document.createElement('nav')
  list.prepend(rail)
  vi.spyOn(rail, 'getBoundingClientRect').mockImplementation(() => { throw new Error('measured the rail') })
  expect(h.viewport.readVisibleTurn()).toBe(7)
  expect(h.viewport.scrollToTurn(7)?.turn).toBe(7)
  vi.spyOn(row, 'getBoundingClientRect').mockClear()
  expect(h.viewport.readVisibleTurn()).toBe(7)
  expect(vi.spyOn(row, 'getBoundingClientRect')).not.toHaveBeenCalled()
  h.viewport.detach()
  expect(h.viewport.readVisibleTurn()).toBeNull()
})

it.each([1, 1000])('selects the first paging marker without measuring other rows (%s later rows)', (count) => {
  const h = fixture()
  const unmarked = h.row(h.column, 'expanded-control', 0)
  delete unmarked.dataset.chatPagingAnchor
  const first = h.row(h.column, 'first', -100)
  const later = Array.from({ length: count }, (_, index) => h.row(h.column, `later-${index}`, 10 + index * 60))
  for (const row of [unmarked, ...later]) {
    vi.spyOn(row, 'getBoundingClientRect').mockImplementation(() => { throw new Error('measured an unselected row') })
  }
  const hitTest = vi.fn(() => { throw new Error('paging used a visual hit test') })
  Object.defineProperty(document, 'elementsFromPoint', { configurable: true, value: hitTest })
  const candidates = vi.spyOn(h.column, 'querySelectorAll')

  h.viewport.beginPaging()

  expect(hitTest).not.toHaveBeenCalled()
  expect(candidates).not.toHaveBeenCalled()
  expect(vi.spyOn(first, 'getBoundingClientRect')).toHaveBeenCalledTimes(1)
  expect(vi.spyOn(h.column, 'getBoundingClientRect')).toHaveBeenCalledTimes(1)
  expect(h.viewport.preserve()?.position).toMatchObject({ anchorKey: 'first', anchorTop: -100 })
})

it('skips hidden and empty paging markers without reading their geometry', () => {
  const h = fixture()
  const hidden = h.row(h.column, 'hidden', 0)
  hidden.setAttribute('hidden', 'until-found')
  const parent = h.group()
  parent.setAttribute('hidden', 'until-found')
  const child = h.row(parent, 'hidden-child', 20)
  const empty = h.row(h.column, 'empty', 40)
  empty.textContent = ''
  const visible = h.row(h.column, 'visible', 60)
  for (const row of [hidden, child, empty]) {
    vi.spyOn(row, 'getBoundingClientRect').mockImplementation(() => { throw new Error('measured an ineligible row') })
  }

  h.viewport.beginPaging()

  expect(vi.spyOn(visible, 'getBoundingClientRect')).toHaveBeenCalledTimes(1)
  expect(h.viewport.preserve()?.position?.anchorKey).toBe('visible')
})

it('does not measure the viewport when no paging marker is available', () => {
  const h = fixture()
  h.viewport.beginPaging()
  expect(h.viewport.preserving).toBe(false)
  expect(vi.spyOn(h.column, 'getBoundingClientRect')).not.toHaveBeenCalled()
})

it('keeps a collapsed header stationary for hidden growth and content inserted before it', () => {
  const h = fixture()
  const header = h.row(h.column, 'collapsed-header', 40)
  const body = document.createElement('div')
  body.setAttribute('hidden', 'until-found')
  header.append(body)
  h.row(body, 'hidden-member', 70)
  h.viewport.beginPaging()

  h.row(body, 'older-hidden-member', 50)
  expect(h.viewport.preserve()?.metrics.top).toBe(0)
  expect(header.getBoundingClientRect().top).toBe(40)

  h.prepend(200)
  expect(h.viewport.preserve()?.metrics.top).toBe(200)
  expect(header.getBoundingClientRect().top).toBe(40)
})

it('captures a grouped member and preserves its reading position after history grows above it', () => {
  const h = fixture()
  const group = h.group()
  h.row(group, 'first', 20)
  h.row(group, 'second', 130)
  h.column.scrollTop = 100

  const position = h.viewport.capturePosition()
  expect(position).toEqual({ anchorKey: 'second', anchorTop: 30, scrollTop: 100 })
  if (position === null) throw new Error('expected a grouped reading anchor')
  h.viewport.beginPreserving(position)
  h.prepend(200)
  const landing = h.viewport.preserve()
  expect(landing?.metrics.top).toBe(300)
  expect(landing?.position).toEqual({ anchorKey: 'second', anchorTop: 30, scrollTop: 300 })
})

it('anchors an open group to its old content even when the pointer ray hits its header', () => {
  const h = fixture()
  const group = h.group()
  group.dataset.chatAnchorKey = 'group'
  const header = document.createElement('button')
  group.append(header)
  const body = document.createElement('div')
  body.dataset.stepProcessBody = ''
  group.append(body)
  const content = document.createElement('div')
  content.dataset.stepProcessContent = ''
  body.append(content)
  h.row(content, 'old-member', 40)
  Object.defineProperty(document, 'elementsFromPoint', { configurable: true, value: () => [header] })

  const position = h.viewport.capturePosition()
  expect(position?.anchorKey).toBe('old-member')
  if (position === null) throw new Error('expected a member anchor')
  h.viewport.beginPreserving(position)
  h.prepend(120)
  expect(h.viewport.preserve()?.metrics.top).toBe(120)
  body.setAttribute('hidden', 'until-found')
  expect(h.viewport.capturePosition()?.anchorKey).toBe('group')
})

it.each([false, true])('ignores a relocating Turn control when paging reveals a steering boundary (hit=%s)', (hit) => {
  const h = fixture()
  const control = h.row(h.column, 'turn-control', 0)
  control.dataset.chatFlowKind = 'turn-process'
  vi.spyOn(control, 'getBoundingClientRect').mockImplementation(() => new DOMRect(0, -h.column.scrollTop, 500, 24))
  const group = h.group()
  group.dataset.chatAnchorKey = 'group'
  const old = h.row(group, 'old-message', 60)
  if (hit) Object.defineProperty(document, 'elementsFromPoint', { configurable: true, value: () => [control] })

  const position = h.viewport.capturePosition()
  h.viewport.beginPreserving(position)
  const steering = h.row(h.column, 'steering', 30)
  h.column.insertBefore(steering, group)
  h.prepend(200)
  h.viewport.preserve()
  expect(old.getBoundingClientRect().top).toBe(60)
  expect(h.column.scrollTop).toBe(200)
  expect(position?.anchorKey).toBe('old-message')
})

it('navigates by Node identity while retaining a distinct visible part anchor', () => {
  const h = fixture()
  const group = h.group()
  const reasoning = h.row(group, 'assistant', 100, 'reasoning')
  const response = h.row(group, 'assistant', 200, 'response')
  h.viewport.updateTurns([{ turn: 1, anchorKey: 'assistant', prompt: '', response: '' }])

  expect(h.viewport.scrollToTurn(1)?.position?.anchorKey).toBe(reasoning.dataset.chatAnchorKey)
  reasoning.setAttribute('hidden', 'until-found')
  const landing = h.viewport.scrollToTurn(1)
  expect(landing?.metrics.top).toBe(176)
  expect(landing?.position?.anchorKey).toBe(response.dataset.chatAnchorKey)
  expect(h.viewport.restore({ anchorKey: response.dataset.chatAnchorKey!, anchorTop: 8, scrollTop: 0 })?.metrics.top)
    .toBe(192)
})

it('excludes empty rows, hidden ancestors, and transparent group shells from fallback sampling', () => {
  const h = fixture()
  const hidden = h.group()
  hidden.setAttribute('hidden', 'until-found')
  h.row(hidden, 'hidden', 10)
  const group = h.group()
  group.dataset.chatFlowKey = 'group'
  group.dataset.chatAnchorKey = 'group'
  const empty = h.row(group, 'empty', 30)
  empty.textContent = ''
  h.row(group, 'visible', 70)

  expect(h.viewport.capturePosition()?.anchorKey).toBe('visible')
})

it('skips hidden group members when navigating to a fallback Turn row', () => {
  const h = fixture()
  const hidden = h.group()
  hidden.setAttribute('hidden', 'until-found')
  h.row(hidden, 'hidden', 10, 'reasoning')
  const visible = h.row(h.group(), 'visible', 150, 'response')

  const landing = h.viewport.scrollToTurnAtOrAfter(1)
  expect(landing?.metrics.top).toBe(126)
  expect(landing?.position?.anchorKey).toBe(visible.dataset.chatAnchorKey)
})

it('retains the original capture and Turn navigation path for ungrouped Nodes', () => {
  const h = fixture()
  h.row(h.column, 'whole', 90)
  h.viewport.updateTurns([{ turn: 1, anchorKey: 'whole', prompt: '', response: '' }])
  expect(h.viewport.capturePosition()?.anchorKey).toBe('whole')
  expect(h.viewport.scrollToTurn(1)?.metrics.top).toBe(66)
})

it('retains a semantic paging row when segmentation remounts its DOM', () => {
  const h = fixture()
  const original = h.row(h.group(), 'retained', 90)
  h.viewport.beginPreserving()
  original.remove()
  const replacement = h.row(h.group(), 'retained', 290)

  expect(h.viewport.preserve()?.metrics.top).toBe(200)
  expect(replacement.getBoundingClientRect().top).toBe(90)
  h.prepend(100)
  expect(h.viewport.preserve()?.metrics.top).toBe(300)
  expect(replacement.getBoundingClientRect().top).toBe(90)
})

function nestedFixture(height: number, cap: number, trailing = 1000, viewportHeight = 300) {
  const scroller = document.createElement('div')
  scroller.dataset.conversationScroll = ''
  const column = document.createElement('div')
  const body = document.createElement('div')
  body.dataset.stepProcessBody = ''
  const content = document.createElement('div')
  content.dataset.stepProcessContent = ''
  const row = document.createElement('div')
  row.dataset.chatAnchorKey = 'retained'
  row.dataset.chatPagingAnchor = ''
  row.textContent = 'retained content'
  content.append(row)
  body.append(content)
  column.append(body)
  scroller.append(column)
  document.body.append(scroller)
  let outerTop = 0
  let innerTop = 0
  let prefix = 0
  const bodyHeight = () => Math.min(height + prefix, cap)
  const columnHeight = () => 100 + bodyHeight() + trailing
  Object.defineProperties(scroller, {
    clientHeight: { value: viewportHeight },
    scrollHeight: { get: () => Math.max(viewportHeight, columnHeight()) },
    scrollTop: {
      get: () => outerTop,
      set: (value: number) => { outerTop = Math.max(0, Math.min(value, scroller.scrollHeight - viewportHeight)) },
    },
  })
  Object.defineProperties(body, {
    clientHeight: { get: bodyHeight },
    scrollHeight: { get: () => height + prefix },
    scrollTop: {
      get: () => innerTop,
      set: (value: number) => { innerTop = Math.max(0, Math.min(value, body.scrollHeight - bodyHeight())) },
    },
  })
  vi.spyOn(scroller, 'getBoundingClientRect').mockImplementation(() => new DOMRect(0, 0, 500, viewportHeight))
  vi.spyOn(column, 'getBoundingClientRect').mockImplementation(() => new DOMRect(0, -outerTop, 500, columnHeight()))
  vi.spyOn(body, 'getBoundingClientRect').mockImplementation(() => new DOMRect(0, 100 - outerTop, 500, bodyHeight()))
  vi.spyOn(content, 'getBoundingClientRect').mockImplementation(() => new DOMRect(0, 100 - outerTop - innerTop, 500, height + prefix))
  vi.spyOn(row, 'getBoundingClientRect').mockImplementation(() => new DOMRect(0, 200 + prefix - outerTop - innerTop, 500, 40))
  const observed = new Set<Element>()
  let notifyResize = () => {}
  class Observer implements ResizeObserver {
    constructor(callback: ResizeObserverCallback) { notifyResize = () => { callback([], this) } }
    observe(target: Element): void { observed.add(target) }
    unobserve(target: Element): void { observed.delete(target) }
    disconnect(): void { observed.clear() }
  }
  vi.stubGlobal('ResizeObserver', Observer)
  const viewport = new ChatViewport()
  viewport.attach(column, column)
  viewport.connect({ scroll: () => {}, scrollEnd: () => {}, resize: () => { viewport.preserve() }, interact: () => {} })
  onTestFinished(() => {
    viewport.detach()
    scroller.remove()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })
  const begin = () => {
    const top = row.getBoundingClientRect().top
    viewport.beginPreserving({ anchorKey: 'retained', anchorTop: top, scrollTop: scroller.scrollTop })
    return top
  }
  return {
    scroller, column, body, content, row, viewport, observed, begin,
    prepend: (amount: number) => { prefix += amount },
    resize: () => { notifyResize() },
  }
}

it('measures only the selected member and its inner and outer containers once when paging starts', () => {
  const h = nestedFixture(600, 400)
  h.viewport.beginPaging()
  expect(vi.spyOn(h.row, 'getBoundingClientRect')).toHaveBeenCalledTimes(1)
  expect(vi.spyOn(h.body, 'getBoundingClientRect')).toHaveBeenCalledTimes(1)
  expect(vi.spyOn(h.scroller, 'getBoundingClientRect')).toHaveBeenCalledTimes(1)
  expect(vi.spyOn(h.column, 'getBoundingClientRect')).not.toHaveBeenCalled()
  expect(vi.spyOn(h.content, 'getBoundingClientRect')).not.toHaveBeenCalled()
})

it.each([
  { height: 200, cap: 400, prefix: 100, inner: 0, expectedInner: 0, expectedOuter: 180 },
  { height: 300, cap: 400, prefix: 200, inner: 0, expectedInner: 100, expectedOuter: 180 },
  { height: 600, cap: 400, prefix: 200, inner: 40, expectedInner: 240, expectedOuter: 80 },
  { height: 600, cap: Infinity, prefix: 200, inner: 0, expectedInner: 0, expectedOuter: 280 },
])('preserves one anchor across inner and outer scrolling (height=$height, cap=$cap)', (test) => {
  const h = nestedFixture(test.height, test.cap)
  h.scroller.scrollTop = 80
  h.body.scrollTop = test.inner
  const top = h.begin()
  h.prepend(test.prefix)
  h.viewport.preserve()
  expect(h.body.scrollTop).toBe(test.expectedInner)
  expect(h.scroller.scrollTop).toBe(test.expectedOuter)
  expect(h.row.getBoundingClientRect().top).toBe(top)
})

it('gives paging compensation priority over an active inner follow animation', () => {
  const h = nestedFixture(600, 400)
  const follow = new ScrollFollow(true, 1)
  onTestFinished(follow.bind(h.body))
  const scrollTo = vi.fn((options?: ScrollToOptions | number, y?: number) => {
    if (typeof options === 'number') h.body.scrollTop = y ?? 0
    else if (options?.behavior === 'instant') h.body.scrollTop = options.top ?? 0
  })
  h.body.scrollTo = scrollTo
  h.body.scrollTop = 100
  const top = h.begin()
  follow.toBottom(h.body, scrollMetrics(h.body), 'smooth')
  expect(follow.animating).toBe(true)
  h.prepend(200)
  h.viewport.preserve()
  expect(h.row.getBoundingClientRect().top).toBe(top)
  expect(scrollTo).toHaveBeenLastCalledWith({ top: 300, behavior: 'instant' })
  expect(follow.animating).toBe(false)
  expect(follow.active).toBe(false)
  follow.sample(scrollMetrics(h.body))
  follow.settle(scrollMetrics(h.body))
  expect(follow.active).toBe(false)
  h.body.scrollTop = scrollMetrics(h.body).floor
  expect(follow.sample(scrollMetrics(h.body))).toBe(true)
})

it.each(['wheel', 'touchstart', 'pointerdown', 'keydown', 'beforematch'])(
  'retains the same paging anchor through later content resizes until %s', (intent) => {
    const h = nestedFixture(200, 400)
    h.scroller.scrollTop = 80
    const top = h.begin()
    expect(h.observed.has(h.content)).toBe(true)
    for (const amount of [100, 100, 100]) {
      h.prepend(amount)
      h.resize()
      expect(h.row.getBoundingClientRect().top).toBe(top)
    }
    h.body.dispatchEvent(intent === 'keydown'
      ? new KeyboardEvent('keydown', { key: 'PageUp', bubbles: true })
      : new Event(intent, { bubbles: true }))
    expect(h.viewport.preserving).toBe(false)
    expect(h.observed.has(h.content)).toBe(false)
    const previousTop = h.scroller.scrollTop
    h.prepend(100)
    h.resize()
    expect(h.scroller.scrollTop).toBe(previousTop)
  })

it.each(['typing', 'space', 'arrow', 'pointer'])(
  'keeps the paging anchor when the composer receives %s', (interaction) => {
    const h = nestedFixture(200, 400)
    const composer = document.createElement('div')
    composer.dataset.composerSeat = ''
    const input = document.createElement('textarea')
    composer.append(input)
    h.scroller.append(composer)
    h.scroller.scrollTop = 80
    const top = h.begin()
    const interact = vi.fn()
    h.viewport.connect({ scroll: () => {}, scrollEnd: () => {}, resize: () => { h.viewport.preserve() }, interact })
    input.dispatchEvent(interaction === 'pointer' ? new Event('pointerdown', { bubbles: true })
      : new KeyboardEvent('keydown', { key: interaction === 'space' ? ' ' : interaction === 'arrow' ? 'ArrowUp' : 'a', bubbles: true }))
    expect(h.viewport.preserving).toBe(true)
    expect(interact).not.toHaveBeenCalled()
    h.prepend(200)
    h.resize()
    expect(h.row.getBoundingClientRect().top).toBe(top)
  },
)

it.each(['a', 'Tab', 'Escape', 'Enter'])(
  'keeps the paging anchor for the non-scrolling key %s in the transcript', (key) => {
    const h = nestedFixture(200, 400)
    const top = h.begin()
    h.body.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
    expect(h.viewport.preserving).toBe(true)
    h.prepend(100)
    h.resize()
    expect(h.row.getBoundingClientRect().top).toBe(top)
  },
)

it('does not compensate twice when native inner anchoring already held the old row', () => {
  const h = nestedFixture(600, 400)
  h.scroller.scrollTop = 80
  h.body.scrollTop = 40
  const top = h.begin()
  h.prepend(200)
  h.body.scrollTop = 240
  h.viewport.preserve()
  expect(h.body.scrollTop).toBe(240)
  expect(h.scroller.scrollTop).toBe(80)
  expect(h.row.getBoundingClientRect().top).toBe(top)
})

it.each([
  { viewportHeight: 800, prefix: 100, outer: 0 },
  { viewportHeight: 450, prefix: 200, outer: 50 },
])('clamps paging to the natural scroll range without adding space (viewport=$viewportHeight)', ({ viewportHeight, prefix, outer }) => {
  const h = nestedFixture(200, 400, 0, viewportHeight)
  h.begin()
  h.prepend(prefix)
  const landing = h.viewport.preserve()
  expect(h.scroller.scrollTop).toBe(outer)
  expect(h.row.getBoundingClientRect().top).toBe(200 + prefix - outer)
  expect(landing?.position?.anchorTop).toBe(h.row.getBoundingClientRect().top)
  expect(h.column.getAttribute('style')).toBeNull()
  h.resize()
  expect(h.scroller.scrollTop).toBe(outer)
})

it('releases a removed paging row without navigating to unrelated content', () => {
  const h = nestedFixture(600, 400)
  h.scroller.scrollTop = 80
  h.begin()
  h.row.remove()
  expect(h.viewport.preserve()).toBeNull()
  expect(h.viewport.preserving).toBe(false)
  expect(h.scroller.scrollTop).toBe(80)
})
