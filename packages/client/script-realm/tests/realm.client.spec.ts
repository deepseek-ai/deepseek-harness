// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { expect, it, vi } from 'vitest'
import ScriptRealmRegistry, { ScriptRealmError, type ScriptRealm, type ScriptRealmId } from '../src/client/index.ts'
import { apply as hostApply } from '../src/index.ts'

it('keeps the Host entry inert and registers factories for their plugin lifetime', async () => {
  expect(() => { hostApply() }).not.toThrow()
  const ctx = new Context()
  const registry = ctx.plugin(ScriptRealmRegistry)
  await registry.await()
  const realm: ScriptRealm = { id: 'test' as ScriptRealmId, expose: async () => {}, execute: async () => {}, dispose: async () => {} }
  const create = vi.fn(async () => realm)
  const provider = ctx.plugin({ inject: ['scriptRealms'], apply(owner: Context) { owner.scriptRealms.register('test', { create }) } })
  try {
    await provider.await()
    expect(create).not.toHaveBeenCalled()
    expect(await ctx.get('scriptRealms')!.create('test', { id: realm.id, signal: new AbortController().signal })).toBe(realm)
    await provider.dispose()
    await expect(ctx.get('scriptRealms')!.create('test', { id: realm.id, signal: new AbortController().signal })).rejects.toThrow('not registered')
  } finally {
    await ctx.fiber.dispose()
  }
})

it('does not call a provider for an already cancelled creation', async () => {
  const ctx = new Context()
  const registry = ctx.plugin(ScriptRealmRegistry)
  await registry.await()
  const create = vi.fn()
  const off = ctx.get('scriptRealms')!.register('cancelled', { create })
  const controller = new AbortController()
  controller.abort(new Error('cancelled'))
  try {
    await expect(ctx.get('scriptRealms')!.create('cancelled', { id: 'test' as ScriptRealmId, signal: controller.signal })).rejects.toThrow('cancelled')
    expect(create).not.toHaveBeenCalled()
  } finally {
    await off()
    await ctx.fiber.dispose()
  }
})


it('rejects duplicate registrations without replacing the original provider', async () => {
  const ctx = new Context()
  await ctx.plugin(ScriptRealmRegistry).await()
  const registry = ctx.get('scriptRealms')!
  const failure = new Error('provider failed')
  const first = vi.fn(() => Promise.reject(failure))
  const replacement = vi.fn()
  const stop = registry.register('unique', { create: first })
  try {
    expect(() => registry.register('unique', { create: replacement })).toThrow('already registered')
    await expect(registry.create('unique', { id: 'failed' as ScriptRealmId, signal: new AbortController().signal })).rejects.toBe(failure)
    expect(first).toHaveBeenCalledOnce()
    expect(replacement).not.toHaveBeenCalled()
    await stop()
    await stop()
    const absent = registry.create('unique', { id: 'missing' as ScriptRealmId, signal: new AbortController().signal })
    await expect(absent).rejects.toMatchObject({ name: 'ScriptRealmError', stage: 'create', realmId: 'missing' })
    const realm: ScriptRealm = { id: 'replacement' as ScriptRealmId, expose: async () => {}, execute: async () => {}, dispose: async () => {} }
    const next = vi.fn(async () => realm)
    registry.register('unique', { create: next })
    await stop()
    await expect(registry.create('unique', { id: realm.id, signal: new AbortController().signal })).resolves.toBe(realm)
    expect(next).toHaveBeenCalledOnce()
  } finally {
    await ctx.fiber.dispose()
  }
})

it('keeps the failed operation and optional script URL on realm errors', () => {
  const cause = new Error('network unavailable')
  const error = new ScriptRealmError({ stage: 'execute', realmId: 'resource' as ScriptRealmId,
    message: 'script failed', url: '/plugin.js', cause })
  expect(error).toMatchObject({ name: 'ScriptRealmError', stage: 'execute', realmId: 'resource',
    message: 'script failed', url: '/plugin.js', cause })
  const create = new ScriptRealmError({ stage: 'create', realmId: 'resource' as ScriptRealmId, message: 'creation failed' })
  expect(create.url).toBeUndefined()
})
