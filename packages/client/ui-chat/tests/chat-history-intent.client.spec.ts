// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionSeq } from '@deepseek-ai/dsh-session/types'
import { ChatNavigation, type ChatNavigationInput } from '../src/client/chat/use-chat-navigation.ts'
import { ChatReading } from '../src/client/chat/use-chat-reading.ts'
import { ChatViewport } from '../src/client/chat/use-chat-viewport.ts'
import { ScrollFollow } from '../src/client/chat/use-scroll-follow.ts'

function fixture() {
  const viewport = new ChatViewport()
  vi.spyOn(viewport, 'confirmHistoryStart').mockReturnValue(true)
  const mode = vi.spyOn(viewport, 'historyConsumption').mockReturnValue('native')
  const reading = new ChatReading(viewport, { read: () => null, save: () => {} }, {
    initialized: true, followingTail: false, activeTurn: 1,
  }, () => {}, new ScrollFollow(false, 24))
  const loadOlder = vi.fn()
  const consumeOlder = vi.fn(() => true)
  const onIntent = vi.fn()
  let input: ChatNavigationInput = {
    isOpen: true, firstSeq: SessionSeq(20), hasMore: true, loadingOlder: false,
    historyLoadStatus: 'idle', loadOlder, consumeOlder, loadThrough: async () => {},
  }
  const navigation = new ChatNavigation(viewport, reading, input, () => {}, onIntent)
  const check = () => {
    navigation.requestHistoryCheck()
    vi.advanceTimersByTime(20)
  }
  const ready = () => {
    input = { ...input, historyLoadStatus: 'pendingConsumption' }
    navigation.setInput(input)
  }
  return { viewport, navigation, reading, mode, loadOlder, consumeOlder, onIntent, check, ready }
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })

describe('history consumption intent', () => {
  it.each(['motion', 'pointer', 'unavailable'] as const)('leaves an automatic page for a click after %s', (blocker) => {
    const h = fixture()
    h.check()
    expect(h.loadOlder).toHaveBeenCalledOnce()
    h.ready()
    h.mode.mockReturnValue(blocker)
    h.check()
    expect(h.onIntent).toHaveBeenLastCalledWith('none')
    h.mode.mockReturnValue('native')
    h.ready()
    h.check()
    h.check()
    expect(h.consumeOlder).not.toHaveBeenCalled()
    expect(h.loadOlder).toHaveBeenCalledOnce()
    h.navigation.loadEarlier()
    h.check()
    expect(h.consumeOlder).toHaveBeenCalledOnce()
    h.navigation.dispose()
  })

  it.each(['touch', 'inner-scroll'] as const)('continues automatic consumption after %s ends', (blocker) => {
    const h = fixture()
    h.check()
    h.ready()
    h.mode.mockReturnValue(blocker)
    h.check()
    expect(h.onIntent).toHaveBeenLastCalledWith('auto')
    expect(h.consumeOlder).not.toHaveBeenCalled()
    h.mode.mockReturnValue('native')
    h.check()
    expect(h.consumeOlder).toHaveBeenCalledOnce()
    expect(h.loadOlder).toHaveBeenCalledOnce()
    h.navigation.dispose()
  })

  it.each(['motion', 'touch', 'pointer', 'inner-scroll', 'unavailable'] as const)(
    'uses baseline manual paging for a cached page without consulting the automatic %s gate', (blocker) => {
      const h = fixture()
      h.ready()
      h.mode.mockReturnValue(blocker)
      const begin = vi.spyOn(h.viewport, 'beginManualPaging')
      h.navigation.loadEarlier()
      h.check()
      expect(h.mode).not.toHaveBeenCalled()
      expect(begin).toHaveBeenCalledOnce()
      expect(h.loadOlder).not.toHaveBeenCalled()
      expect(h.consumeOlder).toHaveBeenCalledOnce()
      expect(h.onIntent).toHaveBeenLastCalledWith('none')
      h.navigation.dispose()
    },
  )

  it('joins a pending automatic request when clicked and consumes once after it returns', () => {
    const h = fixture()
    h.check()
    h.navigation.loadEarlier()
    h.check()
    expect(h.loadOlder).toHaveBeenCalledOnce()
    h.ready()
    h.check()
    expect(h.consumeOlder).toHaveBeenCalledOnce()
    expect(h.onIntent).toHaveBeenLastCalledWith('none')
    h.navigation.dispose()
  })

  it.each(['touch', 'inner-scroll'] as const)('keeps %s ahead of an active motion blocker', (input) => {
    const viewport = new ChatViewport()
    const root = document.createElement('div')
    const inner = document.createElement('div')
    inner.dataset.stepProcessBody = ''
    root.append(inner)
    document.body.append(root)
    viewport.attach(root, root)
    vi.spyOn(viewport.motion, 'active').mockReturnValue(true)
    if (input === 'touch') root.dispatchEvent(new Event('touchstart', { bubbles: true }))
    else inner.dispatchEvent(new Event('scroll'))
    expect(viewport.historyConsumption()).toBe(input)
    viewport.detach()
    root.remove()
  })

  it('does not consume a cached page on a fresh view until clicked', () => {
    const h = fixture()
    h.ready()
    h.check()
    expect(h.consumeOlder).not.toHaveBeenCalled()
    h.navigation.loadEarlier()
    h.check()
    expect(h.consumeOlder).toHaveBeenCalledOnce()
    h.navigation.dispose()
  })
})
