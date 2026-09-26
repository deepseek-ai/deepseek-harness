/**
 * Agent-scope primitive spec: the actx minted by createScope carries the
 * tag and the dispatch filter itself, so plain cordis dispatch with the actx
 * as subject routes by agent — same-agent tagged listeners receive,
 * foreign-agent ones are filtered out, untagged listeners hear everything,
 * and a subject-less root dispatch stays unfiltered. Scope-owned listeners
 * dispose with the fiber.
 */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import { createScope, scopeOf } from '../src/client/scope.ts'

const sid = (k: string): SessionId => k as SessionId

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Test-only routed probe event.
     * @param payload - marker payload.
     * @mode bail
     */
    'test/scope-probe'(payload: { from: string }): true | undefined
  }
}

function bench() {
  const root = new Context()
  const a = createScope(root, sid('a'))
  const b = createScope(root, sid('b'))
  const seen: string[] = []
  const listen = (label: string, ctx: Context, answer?: true) => {
    ctx.on('test/scope-probe', (payload) => {
      seen.push(`${label}:${payload.from}`)
      return answer
    })
  }
  return { root, a, b, seen, listen }
}

describe('createScope', () => {
  it('routes same-id generations independently while keeping untagged listeners shared', async () => {
    const root = new Context()
    const previous = createScope(root, sid('same'))
    const replacement = createScope(root, sid('same'))
    const seen: string[] = []
    previous.ctx.on('test/scope-probe', () => { seen.push('old'); return undefined })
    replacement.ctx.on('test/scope-probe', () => { seen.push('new'); return undefined })
    root.on('test/scope-probe', () => { seen.push('root'); return undefined })
    replacement.ctx.emit(replacement.ctx, 'test/scope-probe', { from: 'new' })
    expect(seen).toEqual(['new', 'root'])
    await previous.fiber.dispose()
    seen.length = 0
    replacement.ctx.emit(replacement.ctx, 'test/scope-probe', { from: 'new' })
    expect(seen).toEqual(['new', 'root'])
    await root.fiber.dispose()
  })

  it('tags the ctx (scopeOf) and leaves the root untagged', () => {
    const { root, a } = bench()
    expect(scopeOf(a.ctx)).toBe(sid('a'))
    expect(scopeOf(root)).toBeUndefined()
  })

  it('scoped dispatch reaches same-session and untagged listeners, never a foreign session', () => {
    const { root, a, b, seen, listen } = bench()
    listen('a', a.ctx)
    listen('b', b.ctx)
    listen('root', root)
    a.ctx.bail(a.ctx, 'test/scope-probe', { from: 'a' })
    expect(seen).toEqual(['a:a', 'root:a'])
    seen.length = 0
    b.ctx.emit(b.ctx, 'test/scope-probe', { from: 'b' })
    expect(seen).toEqual(['b:b', 'root:b'])
  })

  it('bail answers the first same-scope listener and skips filtered foreign ones', () => {
    const { a, b, listen } = bench()
    listen('b', b.ctx, true) // registered first, but foreign → filtered out
    expect(a.ctx.bail(a.ctx, 'test/scope-probe', { from: 'a' })).toBeUndefined()
    listen('a', a.ctx, true)
    expect(a.ctx.bail(a.ctx, 'test/scope-probe', { from: 'a' })).toBe(true)
  })

  it('a subject-less root dispatch is unfiltered (every listener hears it)', () => {
    const { root, a, b, seen, listen } = bench()
    listen('a', a.ctx)
    listen('b', b.ctx)
    listen('root', root)
    root.emit('test/scope-probe', { from: 'root' })
    expect(seen).toEqual(['a:root', 'b:root', 'root:root'])
  })

  it('fiber disposal removes scope-owned listeners', async () => {
    const { a, seen, listen } = bench()
    listen('a', a.ctx)
    await a.fiber.dispose()
    a.ctx.emit(a.ctx, 'test/scope-probe', { from: 'late' })
    expect(seen).toEqual([])
  })
})
