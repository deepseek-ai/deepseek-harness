/**
 * ui-commands browser half on a real cordis Context with fake slash/slots
 * faces and real session scopes: the plugin body mounts CommandUiRuntime as
 * `command`, the popupSelect shell registers into conversation.input.overlay
 * through slot declaration injection with a per-session inject (sessionId →
 * scope → popupFor; unknown id fails loud), both fold up on fiber disposal
 * (HMR safety), and the service satisfies the frozen CommandUiContract.
 */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, onTestFinished } from 'vitest'
import { createScope, scopeOf } from '@deepseek-ai/dsh-api-session-controller/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { InputTriggerSource } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type { CommandUiContract } from '../src/client/contract.ts'
import type { PopupSelectInjected } from '../src/client/PopupSelectView.tsx'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { apply, CommandUiRuntime, inject } from '../src/client/index.ts'

const sid = (k: string): SessionId => k as SessionId

async function bench() {
  const ctx = new Context()
  const sources = new Map<string, InputTriggerSource>()
  ctx.provide('inputTriggers', {
    registerSource(src: InputTriggerSource) {
      sources.set(`${src.trigger} ${src.name}`, src)
      return () => { sources.delete(`${src.trigger} ${src.name}`) }
    },
  })
  const scopes = new Map<SessionId, Context>()
  ctx.provide('sessions', {
    scope: (id: SessionId) => scopes.get(id),
    scopeOf: (c: Context) => scopeOf(c),
    subagentAddress: (id: SessionId) => id === sid('child')
      ? { parentSessionId: sid('parent'), childSessionId: id, mode: 'continuable' as const }
      : undefined,
  })
  const commandsRemote = { list: () => Promise.resolve({ ok: true as const, value: [] }) }
  // The service subscribes its cache-invalidation events on construction, so
  // the Remote face needs `$on` even where this spec dispatches none.
  ctx.provide('remote', { commands: commandsRemote, $on: () => () => {} })
  ctx.provide('remote.commands', commandsRemote)
  await ctx.plugin(SlotRegistry).await()
  ctx.slots.register({
    name: 'root', children: { 'conversation.input.overlay': { kind: 'list', scope: 'session' } },
  } as never, (() => null) as never)
  ctx.provide('locale', new LocaleRuntime(ctx))
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  const mint = (key: string) => {
    const handle = createScope(ctx, sid(key))
    scopes.set(sid(key), handle.ctx)
    return handle
  }
  return { ctx, fiber, sources, slots: ctx.slots, mint }
}

describe('apply', () => {
  it('declares the services it binds', () => {
    expect(inject).toEqual(['inputTriggers', 'sessions', 'remote', 'remote.commands', 'locale'])
  })

  it('mounts ctx.commandUi, registers the source and the overlay entry, and folds up on disposal', async () => {
    const { ctx, fiber, sources, slots } = await bench()
    const command = ctx.get('commandUi')
    expect(command).toBeInstanceOf(CommandUiRuntime)
    // Frozen-contract conformance (compile-time check rides the assignment).
    const contract: CommandUiContract = command as CommandUiRuntime
    expect(typeof contract.register).toBe('function')
    expect(typeof contract.popupFor).toBe('function')
    expect([...sources.keys()]).toEqual(['/ command'])
    expect(slots.entries('conversation.input.overlay').map(entry => entry.options.id)).toEqual(['command-popup'])
    await fiber.dispose()
    expect(sources.size).toBe(0)
    expect(slots.entries('conversation.input.overlay')).toHaveLength(0)
  })

  it('provides no File action without its composer owner', async () => {
    const { fiber, sources } = await bench()
    onTestFinished(() => fiber.dispose())
    const source = sources.get('/ command')!
    const req = { query: '', position: 'leading' as const, drilled: false, signal: new AbortController().signal }
    expect(await source.candidates({ sessionId: sid('s1') }, req)).toEqual([])
    expect(await source.candidates({ sessionId: sid('child') }, req)).toEqual([])
  })

  it('the overlay inject resolves the per-session popup controller by sessionId and fails loud on an unknown id', async () => {
    const { ctx, slots, mint } = await bench()
    const command = ctx.get('commandUi') as CommandUiRuntime
    const scope = mint('s1')
    const entry = slots.entries('conversation.input.overlay')[0]!
    const injectEntry = entry.inject as unknown as (sessionId: SessionId) => PopupSelectInjected
    expect(injectEntry(sid('s1')).popup).toBe(command.popupFor(scope.ctx))
    expect(() => injectEntry(sid('ghost'))).toThrow(/resolved no scope/)
  })
})
