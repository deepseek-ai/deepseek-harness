import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import type { SessionEventLike } from '@deepseek-ai/dsh-api-session-controller/client'
import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session/types'
import {
  ConversationEventRegistry, ConversationNodeAssembler,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {
  ConversationMatchHandler, ConversationNodeDefinition, ConversationNodeDefinitionInput,
} from '@deepseek-ai/dsh-client-ui-conversation/client'

function registry(): ConversationEventRegistry {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  return new ConversationEventRegistry(ctx)
}

function definition(kind: string, match: ConversationNodeDefinitionInput['match'], target?: string): ConversationNodeDefinitionInput<null> {
  return {
    kind, match, start: () => null, update: context => context.state,
    ...target === undefined ? {} : { target, buildViewNode: () => null },
  }
}

function turn(seq: number, number = 1): SessionEvent<'turn/start'> {
  return { type: 'turn/start', seq: SessionSeq(seq), time: seq, data: { turn: number } }
}

describe('Conversation event routing', () => {
  it('precomputes mixed function and table routes in registration order', () => {
    const events = registry()
    const handler = () => null
    const a = definition('a', handler)
    const b = definition('b', { 'turn/start': handler })
    const c = definition('c', handler)
    const d = definition('d', { 'step/start': handler, 'turn/start': handler })
    events.register(a)
    const removeB = events.register(b)
    events.register(c)
    events.register(d)
    const selected = events.forEvent('turn/start')
    expect([...selected].map(route => route.definition.kind)).toEqual(['a', 'b', 'c', 'd'])
    expect([...events.forEvent('step/start')].map(route => route.definition.kind)).toEqual(['a', 'c', 'd'])
    expect([...events.forEvent('unknown')].map(route => route.definition.kind)).toEqual(['a', 'c'])
    expect(events.forEvent('unknown')).toBe(events.forEvent('another-unknown'))
    expect(events.forEvent('turn/start')).toBe(selected)
    removeB()
    removeB()
    expect([...events.forEvent('turn/start')].map(route => route.definition.kind)).toEqual(['a', 'c', 'd'])
    expect([...selected].map(route => route.definition.kind)).toEqual(['a', 'b', 'c', 'd'])
    events.register(b)
    expect([...events.forEvent('turn/start')].map(route => route.definition.kind)).toEqual(['a', 'c', 'd', 'b'])
  })

  it('reads table handlers at registration and invokes only candidates for each payload', () => {
    const events = registry()
    const selected = vi.fn<ConversationMatchHandler>(event => event.type === 'turn/start' && event.data.turn === 2
      ? { id: 'second', role: 'start' } : null)
    const unrelated = vi.fn<ConversationMatchHandler>(() => null)
    const unrestricted = vi.fn<ConversationMatchHandler>(() => null)
    let handlerReads = 0
    const table: Record<string, ConversationMatchHandler> = {
      get 'turn/start'() { handlerReads++; return selected },
      'step/start': unrelated,
    }
    events.register(definition('table', table))
    events.register(definition('function', unrestricted))
    const readsAfterRegistration = handlerReads
    const readAllDefinitions = vi.spyOn(events, 'entries')
    const assembler = new ConversationNodeAssembler(events, { entries: () => [] })
    assembler.replaceWindow([], false)
    for (let seq = 1; seq <= 100; seq++) assembler.append({ type: 'event', event: turn(seq, seq) })
    expect(handlerReads).toBe(readsAfterRegistration)
    expect(readAllDefinitions).not.toHaveBeenCalled()
    expect(selected).toHaveBeenCalledTimes(100)
    expect(unrestricted).toHaveBeenCalledTimes(100)
    expect(unrelated).not.toHaveBeenCalled()
    expect(selected.mock.results[0]?.value).toBeNull()
    expect(selected.mock.results[1]?.value).toEqual({ id: 'second', role: 'start' })
  })

  it('keeps callable entries usable by an assembler adapter without indexed routing', () => {
    const events = registry()
    const table = vi.fn<ConversationMatchHandler>(() => null)
    const legacy = vi.fn<ConversationMatchHandler>(() => null)
    events.register(definition('table', { 'turn/start': table }))
    events.register(definition('legacy', legacy))
    expect(events.entries().every(entry => typeof entry.match === 'function')).toBe(true)
    const assembler = new ConversationNodeAssembler({
      entries: () => events.entries(), fallbackEntry: () => events.fallbackEntry(),
    }, { entries: () => [] })
    assembler.append({ type: 'event', event: turn(1) })
    assembler.append({ type: 'event', event: {
      type: 'step/start', seq: SessionSeq(2), time: 2, data: { turn: 1, step: 1 },
    } })
    expect(table).toHaveBeenCalledOnce()
    expect(legacy).toHaveBeenCalledTimes(2)
  })

  it('preserves the Definition receiver of a function-form matcher', () => {
    const events = registry()
    const receivers: ConversationNodeDefinition[] = []
    const match = function (this: ConversationNodeDefinition, _event: SessionEventLike) {
      receivers.push(this)
      return null
    }
    const entry = definition('receiver', match)
    events.register(entry)
    for (const route of events.forEvent('turn/start')) route.match(turn(1))
    expect(receivers).toEqual([entry])
  })

  it('indexes only own table keys, including names inherited by ordinary objects', () => {
    const events = registry()
    const entry = definition('own-keys', { ['__proto__']: () => null, constructor: () => null })
    events.register(entry)
    expect([...events.forEvent('__proto__')].map(route => route.definition.kind)).toEqual(['own-keys'])
    expect([...events.forEvent('constructor')].map(route => route.definition.kind)).toEqual(['own-keys'])
    expect(events.forEvent('toString').size).toBe(0)
    events.register(definition('empty', {}))
    expect(events.forEvent('unlisted').size).toBe(0)
  })

  it('keeps fallback functions callable and normalizes table fallbacks', () => {
    const events = registry()
    const match = vi.fn<ConversationMatchHandler>(() => null)
    const unrestricted = definition('generic-fallback', match, 'chat')
    const dispose = events.registerFallback(unrestricted)
    expect(events.fallbackEntry()).toBe(unrestricted)
    dispose()
    dispose()
    expect(events.fallbackEntry()).toBeUndefined()
    const table = definition('table-fallback', { 'turn/start': match, ['__proto__']: match }, 'chat')
    const removeTable = events.registerFallback(table)
    const resolved = events.fallbackEntry()!
    expect(typeof resolved.match).toBe('function')
    resolved.match(turn(1))
    expect(match).toHaveBeenCalledOnce()
    resolved.match({ type: 'step/start', seq: SessionSeq(2), time: 2, data: { turn: 1, step: 1 } })
    expect(match).toHaveBeenCalledOnce()
    removeTable()
    expect(events.fallbackEntry()).toBeUndefined()
  })

  it.each(['chat', 'other', undefined] as const)('suppresses fallback only after a real match for its target (%s)', (target) => {
    const events = registry()
    const match = vi.fn<ConversationMatchHandler>(event => event.type === 'turn/start' && event.data.turn === 2
      ? { id: 'second', role: 'start' } : null)
    const fallback = vi.fn<ConversationMatchHandler>(() => ({ id: 'fallback', role: 'start' }))
    events.register(definition('ordinary', { 'turn/start': match }, target))
    events.registerFallback(definition('fallback', { 'turn/start': fallback }, 'chat'))
    const assembler = new ConversationNodeAssembler(events, { entries: () => [] })
    assembler.replaceWindow([], false)
    assembler.append({ type: 'event', event: turn(1) })
    assembler.append({ type: 'event', event: turn(2, 2) })
    expect(match).toHaveBeenCalledTimes(2)
    expect(fallback).toHaveBeenCalledTimes(target === 'chat' ? 1 : 2)
  })

  it.each(['indexed', 'legacy'].flatMap(adapter => (
    ['first', 'second', 'third', 'unmatched'].map(target => ({ adapter, target }))
  )))('checks fallback against every matched target ($adapter, $target)', ({ adapter, target }) => {
    const events = registry()
    const targets = ['first', 'first', 'second', 'third', 'second']
    const matched: string[] = []
    for (const [index, ordinaryTarget] of targets.entries()) {
      events.register(definition(`ordinary-${index}`, { 'turn/start': () => {
        matched.push(ordinaryTarget)
        return { id: 'one', role: 'start' }
      } }, ordinaryTarget))
    }
    const fallback = vi.fn<ConversationMatchHandler>(() => ({ id: 'fallback', role: 'start' }))
    events.registerFallback(definition('fallback', fallback, target))
    const definitions = adapter === 'indexed' ? events : {
      entries: () => events.entries(), fallbackEntry: () => events.fallbackEntry(),
    }
    const assembler = new ConversationNodeAssembler(definitions, { entries: () => [] })
    assembler.append({ type: 'event', event: turn(1) })
    expect(matched).toEqual(targets)
    expect(fallback).toHaveBeenCalledTimes(target === 'unmatched' ? 1 : 0)
  })
})
