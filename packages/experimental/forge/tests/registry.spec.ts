import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import ForgeService, { changeRequestKey } from '../src/index.ts'
import { demo, FakeProvider, forgeContext, provide, ref } from './fake-provider.ts'

let ctx: Context | undefined

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
})

describe('forge registry', () => {
  it('rejects a backoff cap shorter than the active poll interval', async () => {
    ctx = new Context()
    await expect(ctx.plugin(ForgeService, { activeIntervalMs: 30_000, maxBackoffMs: 1_000 }))
      .rejects.toThrow('maxBackoffMs must be greater than or equal to activeIntervalMs')
  })

  it.each([1_000, 2_000])('accepts backoff cap %s at or above the active interval', async (maxBackoffMs) => {
    ctx = new Context()
    await ctx.plugin(ForgeService, { activeIntervalMs: 1_000, maxBackoffMs })
    expect(ctx.forge).toBeDefined()
  })

  it('resolves remotes and change request URLs through the first provider that serves them', async () => {
    ctx = await forgeContext()
    await provide(ctx, new FakeProvider('fake'))
    await provide(ctx, new FakeProvider('other'))

    expect(ctx.forge.repositoryFromRemote('fake://fake.test/Octo/Demo')).toEqual({ forge: 'fake', host: 'fake.test', owner: 'Octo', name: 'Demo' })
    expect(ctx.forge.changeRequestFromUrl('https://fake.test/Octo/Demo/change/7')).toEqual(ref(7))
    expect(ctx.forge.repositoryFromRemote('https://unknown.test/a/b')).toBeUndefined()
    expect(ctx.forge.changeRequestFromUrl('https://unknown.test/a/b/pull/1')).toBeUndefined()
  })

  it('delegates repository operations to the provider of their forge', async () => {
    ctx = await forgeContext()
    const provider = new FakeProvider()
    provider.heads.set('Octo/Demo:topic', [ref(3)])
    provider.readinessResult = { state: 'unauthenticated', message: 'run gh auth login' }
    await provide(ctx, provider)
    const signal = new AbortController().signal

    expect(ctx.forge.changeRequestUrl(ref(3))).toBe('https://fake.test/Octo/Demo/change/3')
    await expect(ctx.forge.findByHead(demo, 'topic', signal)).resolves.toEqual([ref(3)])
    await expect(ctx.forge.readiness(demo, signal)).resolves.toEqual({ state: 'unauthenticated', message: 'run gh auth login' })
  })

  it('rejects operations for a forge without a provider', async () => {
    ctx = await forgeContext()
    const elsewhere = { ...demo, forge: 'missing' }
    const signal = new AbortController().signal

    expect(() => ctx!.forge.changeRequestUrl(ref(1, elsewhere))).toThrow('forge: no provider is registered for "missing"')
    await expect(ctx.forge.findByHead(elsewhere, 'topic', signal)).rejects.toThrow('forge: no provider is registered for "missing"')
    await expect(ctx.forge.readiness(elsewhere, signal)).rejects.toThrow('forge: no provider is registered for "missing"')
    await expect(ctx.forge.markReady(ref(1, elsewhere), signal)).rejects.toThrow('forge: no provider is registered for "missing"')
    await expect(ctx.forge.merge(ref(1, elsewhere), { method: 'squash', headSha: 'a'.repeat(40) }, signal))
      .rejects.toThrow('forge: no provider is registered for "missing"')
    await expect(ctx.forge.diff(ref(1, elsewhere), signal)).rejects.toThrow('forge: no provider is registered for "missing"')
    await expect(ctx.forge.fileText(ref(1, elsewhere), 'a'.repeat(40), 'x', signal)).rejects.toThrow('forge: no provider is registered for "missing"')
    expect(() => ctx!.forge.fileUrl(ref(1, elsewhere), 'a'.repeat(40), 'x')).toThrow('forge: no provider is registered for "missing"')
  })

  it('delegates change request reads to the provider of their forge', async () => {
    ctx = await forgeContext()
    const provider = new FakeProvider()
    provider.readResult = 'diff --git a/x b/x'
    await provide(ctx, provider)
    const signal = new AbortController().signal

    await expect(ctx.forge.diff(ref(3), signal)).resolves.toBe('diff --git a/x b/x')
    provider.readResult = { code: 'not-found', message: 'gone' }
    await expect(ctx.forge.fileText(ref(3), 'b'.repeat(40), 'src/a.ts', signal)).resolves.toEqual({ code: 'not-found', message: 'gone' })
    expect(ctx.forge.fileUrl(ref(3), 'b'.repeat(40), 'src/a.ts')).toBe(`https://fake.test/Octo/Demo/file/${'b'.repeat(40)}/src/a.ts`)
    expect(provider.actions).toEqual(['diff 3', `text 3 ${'b'.repeat(40)} src/a.ts`])
  })

  it('delegates change request actions to the provider of their forge and returns its outcome', async () => {
    ctx = await forgeContext()
    const provider = new FakeProvider()
    await provide(ctx, provider)
    const signal = new AbortController().signal

    await expect(ctx.forge.markReady(ref(3), signal)).resolves.toBeUndefined()
    provider.actionResult = { code: 'stale', message: 'Head branch was modified' }
    await expect(ctx.forge.merge(ref(3), { method: 'rebase', headSha: 'b'.repeat(40) }, signal))
      .resolves.toEqual({ code: 'stale', message: 'Head branch was modified' })
    expect(provider.actions).toEqual(['ready 3', `merge 3 rebase ${'b'.repeat(40)}`])
  })

  it('refuses a second provider for the same forge', async () => {
    ctx = await forgeContext()
    await provide(ctx, new FakeProvider())

    await expect(provide(ctx, new FakeProvider())).rejects.toThrow('forge: a provider for "fake" is already registered')
  })

  it('removes a provider when its contributing fiber is disposed', async () => {
    ctx = await forgeContext()
    const fiber = await provide(ctx, new FakeProvider())
    expect(ctx.forge.changeRequestFromUrl('https://fake.test/Octo/Demo/change/1')).toBeDefined()

    await fiber.dispose()

    expect(ctx.forge.changeRequestFromUrl('https://fake.test/Octo/Demo/change/1')).toBeUndefined()
    expect(ctx.forge.repositoryFromRemote('fake://fake.test/Octo/Demo')).toBeUndefined()
  })

  it('removes a provider through the disposer that register returns', async () => {
    ctx = await forgeContext()
    const unregister = ctx.forge.register(new FakeProvider())
    expect(ctx.forge.repositoryFromRemote('fake://fake.test/Octo/Demo')).toBeDefined()

    await unregister()

    expect(ctx.forge.repositoryFromRemote('fake://fake.test/Octo/Demo')).toBeUndefined()
  })

  it('builds case-insensitive keys from forge, host, owner, name, and number', () => {
    const upper = changeRequestKey(ref(9, { forge: 'fake', host: 'FAKE.test', owner: 'OCTO', name: 'DEMO' }))

    expect(upper).toBe('fake:fake.test/octo/demo#9')
    expect(changeRequestKey(ref(9))).toBe(upper)
  })

  it.each([
    ['activeIntervalMs', 0],
    ['idleIntervalMs', -1],
    ['maxBackoffMs', 1.5],
    ['fetchTimeoutMs', 2_147_483_648],
  ])('rejects %s = %s at load', async (key, value) => {
    ctx = new Context()

    await expect(ctx.plugin(ForgeService, { [key]: value })).rejects.toThrow(`forge: ${key} must be a positive integer no greater than 2147483647`)
  })
})
