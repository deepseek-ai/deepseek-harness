/**
 * apply wiring on a real cordis Context + SlotRegistry: InputTriggerService mounts
 * as ctx.inputTriggers once its sessions dependency is up; the MenuView overlay
 * registration follows the slot declaration, resolves the per-session controller from the slot's
 * sessionId, and unregisters on fiber teardown.
 */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { createScope, scopeOf } from '@deepseek-ai/dsh-api-session-controller/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { apply, inject, InputTriggerService } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type { MenuViewInjected } from '@deepseek-ai/dsh-client-ui-input-trigger/client'

const sid = (k: string): SessionId => k as SessionId

async function bench() {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const slots = ctx.get('slots') as SlotRegistry
  // Stand-in for the ui-conversation composer entry: declare the overlay
  // slot without providing ConversationController, which is not its lifecycle
  // signal.
  slots.register(
    { name: 'root', children: { 'conversation.input.overlay': { kind: 'list', scope: 'session' } } } as never,
    () => null,
  )
  // Sessions face: mint one real scope for session 'a' and resolve it by id.
  const scope = createScope(ctx, sid('a'))
  const session = { sessionId: sid('a') }
  const binding = { sessionId: sid('a'), session, ctx: scope.ctx }
  ctx.provide('sessions', {
    scope: (id: SessionId) => (id === sid('a') ? scope.ctx : undefined),
    scopeOf: (c: Context) => scopeOf(c),
    sessionOf: (c: Context) => c === scope.ctx ? session : undefined,
    binding: (id: SessionId) => id === sid('a') ? binding : undefined,
  } as never)
  const locale = new LocaleRuntime(ctx)
  // These specs assert the shipped Chinese copy. There is no jsdom `window`
  // in this lane, so browser-language detection never runs and the locale
  // comes from FALLBACK_LOCALE (en): state the asserted locale explicitly.
  locale.setLocale('zh')
  ctx.provide('locale', locale)
  return { ctx, slots, locale }
}

describe('apply', () => {
  it('declares the sessions and locale dependencies (scope tree + localized menu copy)', () => {
    expect(inject).toEqual(['sessions', 'locale'])
  })

  it('registers the bilingual menu dictionaries (group titles by source name + the pending row)', async () => {
    const { ctx, locale } = await bench()
    await ctx.plugin({ inject: [...inject], apply }).await()
    const t = locale.bind('slash.menu')
    expect(t('command')).toBe('指令')
    locale.setLocale('en')
    expect(t('skill')).toBe('Skills')
    expect(t('subagent')).toBe('Subagents')
    expect(t('loading')).toBe('Loading…')
  })

  it('mounts ctx.inputTriggers once sessions is up, before any conversation service exists', async () => {
    const { ctx } = await bench()
    await ctx.plugin({ inject: [...inject], apply }).await()
    expect(ctx.get('inputTriggers')).toBeInstanceOf(InputTriggerService)
  })

  it('registers MenuView into the overlay and resolves the per-session controller by slot sessionId', async () => {
    const { ctx, slots } = await bench()
    await ctx.plugin({ inject: [...inject], apply }).await()
    expect(slots.entries('conversation.input.overlay')).toHaveLength(1)
    const entries = slots.entries('conversation.input.overlay')
    expect(entries[0]!.options.id).toBe('slash-menu')
    // Copy rides the standard locale seat, not the business face.
    expect(entries[0]!.locale).toBe('slash.menu')

    const inputTriggers = ctx.get('inputTriggers') as InputTriggerService
    // StoredEntry.inject is declaration-typed ((...args: never[]) shape);
    // the erased registration widens it past a direct cast, so hop unknown.
    const injectEntry = entries[0]!.inject as unknown as (sessionId: SessionId) => MenuViewInjected
    const injected = injectEntry(sid('a'))
    const controller = inputTriggers.sessionOf(
      ctx.sessions.scope(sid('a'))!,
    )
    expect(injected.menu).toBe(controller.menu)
    expect(injected.headers).toBe(controller.headers)
    // The pick face routes into the controller pipeline (closed menu → no-op).
    injected.onPick('command', 0)
    expect(controller.menu.getSnapshot().open).toBe(false)
    // The crumb face routes into the controller too (closed menu → no-op).
    injected.onCrumb('command', 0)
    expect(controller.menu.getSnapshot().open).toBe(false)
    // The hover face routes into the controller too (closed menu → no-op).
    injected.onHover('command', 0)
    expect(controller.menu.getSnapshot().open).toBe(false)
    // The dismiss face routes into the controller too (closed menu → no-op).
    injected.onDismiss()
    expect(controller.menu.getSnapshot().open).toBe(false)
    // An unknown session id fails loud (no silent scope miss).
    expect(() => injectEntry(sid('ghost'))).toThrow(/resolved no scope/)
  })

  it('fiber teardown removes the overlay entry', async () => {
    const { ctx, slots } = await bench()
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(slots.entries('conversation.input.overlay')).toHaveLength(1)

    await fiber.dispose()
    expect(slots.entries('conversation.input.overlay')).toHaveLength(0)
    expect(ctx.get('inputTriggers')).toBeUndefined()
  })
})
