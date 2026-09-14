/**
 * TestRemote's own contract: subscription and disposal, dispatch driven by the
 * internal plumbing event, the silent drop for an unsubscribed name, and the
 * `$mount` refusal that sends a spec to the real Client Remote service.
 */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { TestRemote } from '../src/remote.ts'

describe('TestRemote', () => {
  it('delivers a forwarded event to its subscribers and stops after disposal', async () => {
    const ctx = new Context()
    const remote = new TestRemote(ctx)
    const seen: string[] = []
    const off = remote.$on('settings/document-updated', (ns: string) => {
      seen.push(ns)
    })

    remote.emit('settings/document-updated', ['ui-theme', 1])
    expect(seen).toEqual(['ui-theme'])

    off()
    remote.emit('settings/document-updated', ['ui-theme', 2])
    expect(seen).toEqual(['ui-theme'])
    await ctx.fiber.dispose()
  })

  it('drops a forwarded event nobody subscribed to', async () => {
    const ctx = new Context()
    const remote = new TestRemote(ctx)
    // No subscriber for this name: the emit must be inert rather than throwing,
    // because the wire carries whatever the Host allowlist selected.
    expect(() => { remote.emit('credentials/reference-updated', ['DEEPSEEK_API_KEY']) }).not.toThrow()
    await ctx.fiber.dispose()
  })

  it('refuses $mount, which needs the real Client Remote service', async () => {
    const ctx = new Context()
    const remote = new TestRemote(ctx)
    await expect(remote.$mount()).rejects.toThrow('needs the real Client Remote service')
    await ctx.fiber.dispose()
  })

  it('reaches a scripted namespace as ctx.remote.<name> and as its own service', async () => {
    const ctx = new Context()
    const credentials = { describe: () => Promise.resolve({ ok: true as const, value: {} }) }
    const remote = new TestRemote(ctx, { credentials })

    expect((remote as unknown as { credentials: unknown }).credentials).toBe(credentials)
    expect(ctx.get('remote.credentials')).toBe(credentials)
    await ctx.fiber.dispose()
  })

  it('refuses a scripted namespace that would shadow one of its own members', async () => {
    const ctx = new Context()
    // Accepting this would replace the very refusal the case above pins.
    expect(() => new TestRemote(ctx, { $mount: {} })).toThrow('would shadow')
    expect(() => new TestRemote(ctx, { subscriptions: {} })).toThrow('would shadow')
    await ctx.fiber.dispose()
  })
})
