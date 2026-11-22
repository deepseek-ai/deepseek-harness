/** Real registries bind actions to the displayed session and remove every contribution on unload. */
import { isValidElement } from 'react'
import { Context } from '@deepseek-ai/cordis'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ActionCardId } from '@deepseek-ai/dsh-action-cards/types'
import { expect, it, onTestFinished, vi } from 'vitest'
import { apply, inject } from '../src/client/index.ts'
import { apply as hostApply } from '../src/index.ts'
import { HiddenCardBlock, type TailInjected } from '../src/client/Card.tsx'
import type { SettingsRowInjected } from '../src/client/SettingsRow.tsx'

const Body = () => null

/** A Settings form for the switch row and a forms service whose Host serves every namespace. */
function settingsForms() {
  const form = { getSnapshot: vi.fn(), subscribe: vi.fn(), set: vi.fn(async () => true) }
  const service = {
    get: vi.fn(() => form),
    whileServed: vi.fn((namespaces: readonly string[], register: (served: ReadonlySet<string>) => () => void) =>
      register(new Set(namespaces))),
  }
  return { form, service }
}

it('binds actions to the displayed session, serves registered bodies and removes registrations on unload', async () => {
  hostApply()
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SlotRegistry)
  const slots = ctx.slots
  slots.register({ name: 'root', children: {
    'conversation.chat.turnTail': { kind: 'list', scope: 'session' },
    'conversation.chat.markdown.fence': { kind: 'hoc', scope: 'session' },
  } }, (_props: { renderSlot?: unknown }) => null)
  const act = vi.fn().mockResolvedValue({ ok: true, value: { status: 'accepted' } })
  ctx.provide('remote', { actionCards: { act } })
  ctx.provide('remote.actionCards', { act })
  ctx.provide('configForms', settingsForms().service)
  const locale = new LocaleRuntime(ctx)
  ctx.provide('locale', locale)
  const fiber = await ctx.plugin({ inject, apply })
  const entry = slots.entries('conversation.chat.turnTail')[0]!
  expect(slots.entries('conversation.chat.markdown.fence').map(item => [item.options.key, item.component]))
    .toEqual([['action-card', HiddenCardBlock]])
  expect(HiddenCardBlock()).toBeNull()
  const resolve = entry.inject as NonNullable<typeof entry.inject> & ((sessionId: SessionId) => TailInjected)
  const bound = resolve(brandString<SessionId>('session-one'))
  expect(bound.sessionId).toBe('session-one')
  expect(await bound.act(brandString<ActionCardId>('card'), 'create', { slot: 'page' })).toEqual({ status: 'accepted' })
  expect(act).toHaveBeenCalledWith('session-one', 'card', 'create', { slot: 'page' })
  act.mockResolvedValueOnce({ ok: false })
  expect(await bound.act(brandString<ActionCardId>('card'), 'dismiss')).toBeUndefined()
  expect(bound.bind('actionCards')('dismiss')).toBe('Not now')
  const changes = vi.fn()
  const unsubscribe = bound.hooks.bodies.subscribe(changes)
  const kind = await ctx.plugin({ inject: ['actionCards'], apply: (inner: Context) => {
    inner.effect(() => inner.actionCards.register({ action: 'test_action', locale: 'actionCards', Body }))
  } })
  expect([...bound.hooks.bodies.getSnapshot().keys()]).toEqual(['test_action'])
  const translate = (key: string) => key
  const element = bound.hooks.bodies.getSnapshot().get('test_action')!.render({ proposal: { cardId: brandString<ActionCardId>('card'), turn: 1,
    action: 'test_action', title: 'Counter', brief: 'Keep count.', details: {} }, decision: undefined,
  sessionId: brandString<SessionId>('session-one'), summary: null, fallback: null, Folded: Body, act: vi.fn() }, translate)
  expect(isValidElement(element) && element.type === Body && (element.props as { t: unknown }).t === translate).toBe(true)
  expect(() => ctx.actionCards.register({ action: 'test_action', locale: 'actionCards', Body })).toThrow('a body for "test_action" is already registered')
  await kind.dispose()
  expect(bound.hooks.bodies.getSnapshot().size).toBe(0)
  expect(changes).toHaveBeenCalledTimes(2)
  unsubscribe()
  const release = ctx.actionCards.register({ action: 'other_action', locale: 'actionCards', Body })
  expect(bound.hooks.bodies.getSnapshot().has('other_action')).toBe(true)
  release()
  expect(bound.hooks.bodies.getSnapshot().has('other_action')).toBe(false)
  expect(changes).toHaveBeenCalledTimes(2)
  await fiber.dispose()
  expect(slots.entries('conversation.chat.turnTail')).toHaveLength(0)
  expect(slots.entries('conversation.chat.markdown.fence')).toHaveLength(0)
  expect(ctx.get('actionCards')).toBeUndefined()
  vi.spyOn(locale, 'register').mockImplementation(() => { throw new Error('registration failed') })
  const failed = ctx.plugin({ inject, apply })
  await expect(failed.await()).rejects.toThrow('registration failed')
  await failed.dispose()
  expect(ctx.get('actionCards')).toBeUndefined()
})

it('adds the card switch to General settings while the Host serves action-cards, and removes it on unload', async () => {
  hostApply()
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SlotRegistry)
  const slots = ctx.slots
  slots.register({ name: 'root', children: {
    'conversation.chat.turnTail': { kind: 'list', scope: 'session' },
    'conversation.chat.markdown.fence': { kind: 'hoc', scope: 'session' },
    'settings.general.item': { kind: 'list', scope: 'root' },
  } }, (_props: { renderSlot?: unknown }) => null)
  ctx.provide('remote', { actionCards: { act: vi.fn() } })
  ctx.provide('remote.actionCards', { act: vi.fn() })
  ctx.provide('locale', new LocaleRuntime(ctx))
  const { form, service: configForms } = settingsForms()
  ctx.provide('configForms', configForms)
  const fiber = await ctx.plugin({ inject, apply })
  expect(configForms.get).toHaveBeenCalledWith('action-cards')
  expect(configForms.whileServed).toHaveBeenCalledWith(['action-cards'], expect.any(Function))
  const entry = slots.entries('settings.general.item')[0]!
  expect(entry.options).toMatchObject({ id: 'action-cards', order: 40 })
  const resolve = entry.inject as (() => SettingsRowInjected) & NonNullable<typeof entry.inject>
  const injected = resolve()
  expect(injected.hooks.cardSettings).toBe(form)
  expect(await injected.setEnabled(false)).toBe(true)
  expect(form.set).toHaveBeenCalledWith('enabled', false)
  await fiber.dispose()
  expect(slots.entries('settings.general.item')).toHaveLength(0)
})
