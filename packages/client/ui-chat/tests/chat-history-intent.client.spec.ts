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

  it('retains an explicit click until the fold ends without requesting the cached page again', () => {
    const h = fixture()
    h.ready()
    h.mode.mockReturnValue('motion')
    vi.spyOn(h.viewport.motion, 'foldActive').mockReturnValue(true)
    let idle: (() => void) | undefined
    const stop = vi.fn()
    vi.spyOn(h.viewport.motion, 'onFoldIdle').mockImplementation((callback) => { idle = callback; return stop })
    h.navigation.loadEarlier()
    h.check()
    expect(h.onIntent).toHaveBeenLastCalledWith('manual')
    expect(h.loadOlder).not.toHaveBeenCalled()
    expect(h.consumeOlder).not.toHaveBeenCalled()
    h.mode.mockReturnValue('native')
    idle?.()
    vi.advanceTimersByTime(20)
    expect(h.consumeOlder).toHaveBeenCalledOnce()
    h.navigation.dispose()
  })

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
