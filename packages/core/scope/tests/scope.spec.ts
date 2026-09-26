import { describe, expect, expectTypeOf, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { bindScopeParent, carrierKeyOf, createScope, isScopeCarrier, scopeChainOf, scopeOf, scopeParentOf, scopeTarget } from '@deepseek-ai/dsh-scope'
import type { Scope, Scoped } from '@deepseek-ai/dsh-scope'

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Test-only event for scope-filtered dispatch.
     * @param value - opaque payload recorded by listeners.
     * @mode emit
     */
    'scope-test/ping'(value: string): void
  }
}

/** Mount a host plugin and mint a scope inside it. */
async function mintScope(ctx: Context, key: object): Promise<Scope> {
  let scope!: Scope
  await ctx.plugin((inner: Context) => { scope = createScope(inner, key) })
  return scope
}

describe('createScope', () => {
  it('tags contexts and derived contexts, with the nearest tag winning', async () => {
    const ctx = new Context()
    const outerKey = { name: 'outer' }
    const innerKey = { name: 'inner' }
    const outer = await mintScope(ctx, outerKey)
    const inner = createScope(outer.ctx, innerKey)

    expect(scopeOf(ctx)).toBeUndefined()
    expect(scopeOf(outer.ctx)).toBe(outerKey)
    expect(scopeOf(outer.ctx.extend({}))).toBe(outerKey)
    expect(scopeOf(inner.ctx)).toBe(innerKey)

    await inner.dispose()
    await outer.dispose()
  })

  it('is usable synchronously before the backing fiber activates', async () => {
    const ctx = new Context()
    const events: string[] = []
    let scope!: Scope
    await ctx.plugin((inner: Context) => {
      scope = createScope(inner, { name: 'sync' })
      scope.ctx.effect(() => () => void events.push('disposed'))
      events.push('registered')
    })
    expect(events).toEqual(['registered'])
    await scope.dispose()
    expect(events).toEqual(['registered', 'disposed'])
  })

  it('shares quiescence across repeat and raw-disposer-first calls', async () => {
    const ctx = new Context()
    const scope = await mintScope(ctx, { name: 'quiescence' })
    const gate = Promise.withResolvers<undefined>()
    let finished = false
    scope.ctx.effect(() => async () => {
      await gate.promise
      finished = true
    })

    const raw = Promise.resolve(scope.rawDispose())
    const publicDispose = scope.dispose()
    await Promise.resolve()
    expect(finished).toBe(false)
    gate.resolve(undefined)
    await Promise.all([raw, publicDispose, scope.dispose()])
    expect(finished).toBe(true)
  })

  it('exposes the exact raw disposer for ordered composite teardown', async () => {
    const ctx = new Context()
    const order: string[] = []
    let dispose!: () => Promise<void> | void
    await ctx.plugin((inner: Context) => {
      dispose = inner.effect(function* () {
        yield () => void order.push('outer')
        const scope = createScope(inner, { name: 'nested' })
        scope.ctx.effect(() => () => void order.push('scope'))
        yield scope.rawDispose
        yield () => void order.push('inner')
      })
    })
    await dispose()
    expect(order).toEqual(['inner', 'scope', 'outer'])
  })
})

describe('scopeTarget', () => {
  it('routes scoped listeners by key while untagged listeners remain global', async () => {
    const ctx = new Context()
    const keyA = { name: 'A' }
    const keyB = { name: 'B' }
    const scopeA = await mintScope(ctx, keyA)
    const scopeB = await mintScope(ctx, keyB)
    const heard: string[] = []
    ctx.on('scope-test/ping', value => void heard.push(`global:${value}`))
    scopeA.ctx.on('scope-test/ping', value => void heard.push(`A:${value}`))
    scopeB.ctx.on('scope-test/ping', value => void heard.push(`B:${value}`))

    ctx.emit(scopeTarget(ctx, keyA), 'scope-test/ping', 'a')
    ctx.emit(scopeTarget(ctx, keyB), 'scope-test/ping', 'b')
    ctx.emit(scopeTarget(ctx, undefined), 'scope-test/ping', 'none')

    expect(heard).toEqual(['global:a', 'A:a', 'global:b', 'B:b', 'global:none'])
    await Promise.all([scopeA.dispose(), scopeB.dispose()])
  })

  it('preserves a base Cordis filter and its receiver', async () => {
    const ctx = new Context()
    const key = { name: 'A' }
    const scope = await mintScope(ctx, key)
    const heard: string[] = []
    ctx.on('scope-test/ping', value => void heard.push(`global:${value}`))
    scope.ctx.on('scope-test/ping', value => void heard.push(`A:${value}`))
    let receiverMatches = false
    const base = {
      [Context.filter](this: object): boolean {
        receiverMatches = this === base
        return false
      },
    }

    ctx.emit(scopeTarget(base, key), 'scope-test/ping', 'vetoed')
    expect(heard).toEqual([])
    expect(receiverMatches).toBe(true)
    await scope.dispose()
  })

  it('{ global: true } listeners retain Cordis global-listener semantics', async () => {
    const ctx = new Context()
    const scope = await mintScope(ctx, { name: 'A' })
    const heard: string[] = []
    scope.ctx.on('scope-test/ping', value => void heard.push(value), { global: true })
    ctx.emit(scopeTarget(ctx, { name: 'other' }), 'scope-test/ping', 'foreign')
    ctx.emit(scopeTarget(ctx, undefined), 'scope-test/ping', 'none')
    expect(heard).toEqual(['foreign', 'none'])
    await scope.dispose()
  })

  it('uses an opaque branded carrier with a separately tracked key', () => {
    const key = { name: 'key' }
    const subject = { value: 1 }
    const carrier = scopeTarget(subject, key)
    expect(isScopeCarrier(carrier)).toBe(true)
    expect(carrierKeyOf(carrier)).toBe(key)
    expect(isScopeCarrier(subject)).toBe(false)
    expect(carrierKeyOf(subject)).toBeUndefined()
    expect('value' in carrier).toBe(false)
    expectTypeOf(carrier).toEqualTypeOf<Scoped<typeof subject>>()
  })
})

describe('scope parent chain', () => {
  it('links at mint, walks to the root, and rejects cycles', () => {
    const ctx = new Context()
    const preset = { kind: 'preset' }
    const agent = { kind: 'agent' }
    createScope(ctx, preset)
    createScope(ctx, agent, { parent: preset })

    expect(scopeParentOf(agent)).toBe(preset)
    expect(scopeParentOf(preset)).toBeUndefined()
    expect(scopeChainOf(agent)).toEqual([agent, preset])
    expect(scopeChainOf(undefined)).toEqual([])
    expect(() => { bindScopeParent(preset, agent) }).toThrow(/cycle/)
    expect(() => { bindScopeParent(preset, preset) }).toThrow(/cycle/)
  })

  it('re-links only through the binding held by the original binder', () => {
    const ctx = new Context()
    const presetA = { id: 'a' }
    const presetB = { id: 'b' }
    const agent = { id: 'agent' }
    createScope(ctx, presetA)
    createScope(ctx, presetB)
    const binding = bindScopeParent(agent, presetA)
    createScope(ctx, agent)

    // A bound key cannot be re-bound from the outside; only the binding moves it.
    expect(() => bindScopeParent(agent, presetB)).toThrow(/already bound/)
    binding.rebind(presetB)

    expect(scopeChainOf(agent)).toEqual([agent, presetB])
    // The rebind keeps the cycle check: a parent may not adopt its ancestor.
    const child = { id: 'child' }
    const childBinding = bindScopeParent(child, agent)
    void childBinding
    expect(() => { binding.rebind(child) }).toThrow(/cycle/)
  })

  it('admits an ancestor-tagged listener for a descendant dispatch, never the reverse', () => {
    const ctx = new Context()
    const preset = { kind: 'preset' }
    const agent = { kind: 'agent' }
    const other = { kind: 'other-preset' }
    const presetScope = createScope(ctx, preset)
    const agentScope = createScope(ctx, agent, { parent: preset })
    const otherScope = createScope(ctx, other)

    const seen: string[] = []
    ctx.on('probe/event' as never, ((): void => { seen.push('untagged') }) as never)
    presetScope.ctx.on('probe/event' as never, ((): void => { seen.push('preset') }) as never)
    agentScope.ctx.on('probe/event' as never, ((): void => { seen.push('agent') }) as never)
    otherScope.ctx.on('probe/event' as never, ((): void => { seen.push('other') }) as never)

    const emit = ctx as { emit: (carrier: object, type: string) => void }
    // Dispatch at the AGENT key: its own tag and its ancestor's admit; a
    // sibling root does not.
    emit.emit(scopeTarget({}, agent), 'probe/event')
    expect(seen.sort()).toEqual(['agent', 'preset', 'untagged'])

    // Dispatch at the PRESET key: the agent-tagged listener sits BELOW the
    // dispatch key and stays excluded — events flow up the chain, not down.
    seen.length = 0
    emit.emit(scopeTarget({}, preset), 'probe/event')
    expect(seen.sort()).toEqual(['preset', 'untagged'])
  })
})
