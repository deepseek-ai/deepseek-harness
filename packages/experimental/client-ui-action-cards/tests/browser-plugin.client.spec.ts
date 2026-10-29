/** Real registries bind actions to the displayed session and remove every contribution on unload. */
import { isValidElement } from 'react'
import { Context } from '@deepseek-ai/cordis'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import { expect, it, onTestFinished, vi } from 'vitest'
import { mountActionCards, inject } from '../src/client/mount.ts'
import { apply as hostApply } from '../src/index.ts'
import type { TailInjected } from '../src/client/Card.tsx'

const apply = (ctx: Context) => mountActionCards(ctx, { package: '@deepseek-ai/dsh-action-cards', descriptors: [] })
const Body = () => null

it('binds actions to the displayed session, serves registered bodies and removes registrations on unload', async () => {
  hostApply()
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SlotRegistry)
  const slots = ctx.slots
  slots.register({ name: 'root', children: {
    'conversation.chat.turnTail': { kind: 'list', scope: 'session' },
    'tool.call.toolview': { kind: 'keyed', scope: 'session' },
  } }, (_props: { renderSlot?: unknown }) => null)
  const act = vi.fn().mockResolvedValue({ ok: true, value: { status: 'accepted' } })
  const unmount = vi.fn(async () => {})
  ctx.provide('remote', { actionCards: { act }, $mount: vi.fn(async () => unmount) })
  ctx.provide('remote.actionCards', { act })
  const locale = new LocaleRuntime(ctx)
  ctx.provide('locale', locale)
  const fiber = await ctx.plugin({ inject, apply })
  const entry = slots.entries('conversation.chat.turnTail')[0]!
  expect(slots.entries('tool.call.toolview').map(item => item.options.key)).toEqual(['propose_action'])
  const resolve = entry.inject as NonNullable<typeof entry.inject> & ((sessionId: SessionId) => TailInjected)
  const bound = resolve(SessionId('session-one'))
  expect(bound.sessionId).toBe('session-one')
  expect(await bound.act(ToolCallId('card'), 'create', { slot: 'page' })).toEqual({ status: 'accepted' })
  expect(act).toHaveBeenCalledWith('session-one', 'card', 'create', { slot: 'page' })
  act.mockResolvedValueOnce({ ok: false })
  expect(await bound.act(ToolCallId('card'), 'dismiss')).toBeUndefined()
  expect(bound.bind('actionCards')('dismiss')).toBe('Not now')
  const changes = vi.fn()
  const unsubscribe = bound.hooks.bodies.subscribe(changes)
  const kind = await ctx.plugin({ inject: ['actionCards'], apply: (inner: Context) => {
    inner.effect(() => inner.actionCards.register({ action: 'test_action', locale: 'actionCards', Body }))
  } })
  expect([...bound.hooks.bodies.getSnapshot().keys()]).toEqual(['test_action'])
  const translate = (key: string) => key
  const element = bound.hooks.bodies.getSnapshot().get('test_action')!.render({ proposal: { callId: ToolCallId('card'), turn: 1,
    action: 'test_action', title: 'Counter', brief: 'Keep count.', details: {} }, decision: undefined,
  sessionId: SessionId('session-one'), summary: null, Folded: Body, act: vi.fn() }, translate)
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
  expect(unmount).toHaveBeenCalledOnce()
  expect(slots.entries('conversation.chat.turnTail')).toHaveLength(0)
  expect(slots.entries('tool.call.toolview')).toHaveLength(0)
  expect(ctx.get('actionCards')).toBeUndefined()
  vi.spyOn(locale, 'register').mockImplementation(() => { throw new Error('registration failed') })
  const failed = ctx.plugin({ inject, apply })
  await expect(failed.await()).rejects.toThrow('registration failed')
  await failed.dispose()
  expect(unmount).toHaveBeenCalledTimes(2)
})
