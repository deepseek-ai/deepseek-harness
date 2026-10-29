/** Plugin dispatch is synchronous, scoped, and independent of browser default cancellation. */
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import type { TextInteractionRequest } from '../src/client/contract/text-interaction.ts'
import { ConversationInteractionRegistry } from '../src/client/conversation/interaction-registry.ts'

function fixture() {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  return new ConversationInteractionRegistry(ctx)
}

const sessionId = SessionId('interaction')
const gesture = () => ({ trigger: 'selection' as const, hasSelection: true, readText: () => 'selected', preventDefault: vi.fn() })

describe('Conversation interaction registrations', () => {
  it('passes the session to consumers and stops at the first opened surface', () => {
    const registry = fixture()
    const pass = vi.fn()
    const later = vi.fn()
    registry.register({ id: 'pass', onInteraction: pass })
    registry.register({ id: 'quote', onInteraction: (request) => { request.open() } })
    registry.register({ id: 'later', onInteraction: later })
    const request = gesture()
    expect(registry.dispatch(sessionId, request)).toBe('quote')
    expect(pass).toHaveBeenCalledWith(expect.objectContaining({ sessionId, trigger: 'selection' }))
    expect(later).not.toHaveBeenCalled()
    expect(request.preventDefault).not.toHaveBeenCalled()
  })

  it('allows cancellation without opening and ignores retained gesture methods', () => {
    const registry = fixture()
    let retained: TextInteractionRequest | undefined
    registry.register({ id: 'menu', onInteraction: (request) => { retained = request; request.preventDefault() } })
    const request = gesture()
    expect(registry.dispatch(sessionId, request)).toBeNull()
    expect(request.preventDefault).toHaveBeenCalledOnce()
    retained!.open()
    retained!.preventDefault()
    expect(request.preventDefault).toHaveBeenCalledOnce()
  })

  it('publishes removal and rejects empty or duplicate IDs', () => {
    const registry = fixture()
    const changed = vi.fn()
    const off = registry.subscribe(changed)
    expect(() => registry.register({ id: '', onInteraction: () => {} })).toThrow('must not be empty')
    const dispose = registry.register({ id: 'quote', onInteraction: (request) => { request.open() } })
    const ids = registry.getSnapshot()
    expect(ids).toEqual(['quote'])
    expect(registry.getSnapshot()).toBe(ids)
    expect(() => registry.register({ id: 'quote', onInteraction: () => {} })).toThrow('Duplicate')
    dispose()
    dispose()
    expect(registry.getSnapshot()).toEqual([])
    expect(changed).toHaveBeenCalledTimes(2)
    expect(registry.dispatch(sessionId, gesture())).toBeNull()
    off()
  })
})
