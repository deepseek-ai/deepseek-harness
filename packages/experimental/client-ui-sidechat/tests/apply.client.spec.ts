/** Plugin removal releases every contribution, the `/side` command runs the control, and the Host entry stays inert. */
import { Context } from '@deepseek-ai/cordis'
import { expect, it, onTestFinished, vi } from 'vitest'
import type { ResourceProvider } from '@deepseek-ai/dsh-client-resources/client'
import type { CommandContribution } from '@deepseek-ai/dsh-client-ui-commands/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { apply, inject } from '../src/client/index.ts'
import { apply as hostApply } from '../src/index.ts'
import { sidechatAddress } from '../src/client/resource.ts'
import type { SidechatNoticeInjected } from '../src/client/views.tsx'

it('registers contributions through effects and removes all of them at disposal', async () => {
  hostApply()
  expect(inject).toContain('commandUi')
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  const records = new Map<string, { inject?: (id: SessionId) => object }>()
  ctx.provide('slots', {
    inject: (_name: string, register: () => () => void) => ctx.effect(register),
    register: (options: { name: string; inject?: (id: SessionId) => object }) => {
      records.set(options.name, options)
      return () => { records.delete(options.name) }
    },
  } as never)
  const unregisterLocale = vi.fn()
  ctx.provide('locale', { register: () => unregisterLocale, bind: () => (key: string) => key } as never)
  let provider: ResourceProvider<'sidechat'> | undefined
  const unregisterResource = vi.fn()
  ctx.provide('resources', { register: (value: ResourceProvider<'sidechat'>) => { provider = value; return unregisterResource } } as never)
  const release = vi.fn()
  const fork = vi.fn(async () => { throw new Error('offline') })
  const list = { getSnapshot: () => ({ ids: [], byId: {} }), subscribe: () => () => {} }
  ctx.provide('sessions', { retain: vi.fn(() => ({ release })), fork, list } as never)
  let definition: { title: () => string; canOpen: (address: string) => boolean } | undefined
  const unregisterTabs = vi.fn()
  ctx.provide('sidebarRightTabs', { register: (value: typeof definition) => { definition = value; return unregisterTabs } } as never)
  ctx.provide('sidebarRight', { mounted: { getSnapshot: () => 'main', subscribe: () => () => {} }, openResourceIn: vi.fn() } as never)
  let command: CommandContribution | undefined
  const unregisterCommand = vi.fn()
  ctx.provide('commandUi', { register: (value: CommandContribution) => { command = value; return unregisterCommand } } as never)
  vi.spyOn(ctx.logger, 'error').mockImplementation(() => {})
  apply(ctx)

  expect(definition!.title()).toBe('title')
  expect(definition!.canOpen(sidechatAddress('child' as SessionId))).toBe(true)
  expect(definition!.canOpen('https://example.test')).toBe(false)
  // The command is always offered, so a typed `/side` is consumed instead of reaching the model as a message.
  expect(command!.name).toBe('side')
  expect(command!.label?.()).toBe('command')
  expect(command!.description?.()).toBe('command.description')
  expect(command!.available({ sessionId: 'main' as SessionId })).toBe(true)
  expect(command!.ui.kind).toBe('action')
  if (command!.ui.kind === 'action') command!.ui.run({ sessionId: 'main' as SessionId })
  await vi.waitFor(() => { expect(fork).toHaveBeenCalledOnce() })
  const notice = records.get('shell.overlay')!.inject!('main' as SessionId) as SidechatNoticeInjected
  await vi.waitFor(() => { expect(notice.hooks.notice.getSnapshot()).not.toBeNull() })
  notice.dismiss()
  expect(notice.hooks.notice.getSnapshot()).toBeNull()
  const abort = new AbortController()
  const iterator = provider!.open(sidechatAddress('child' as SessionId), { signal: abort.signal })[Symbol.asyncIterator]()
  expect((await iterator.next()).done).toBe(false)
  const stopped = iterator.next()
  abort.abort()
  expect((await stopped).done).toBe(true)
  expect(release).toHaveBeenCalledOnce()

  await ctx.fiber.dispose()
  expect(records.size).toBe(0)
  expect(unregisterTabs).toHaveBeenCalledOnce()
  expect(unregisterResource).toHaveBeenCalledOnce()
  expect(unregisterCommand).toHaveBeenCalledOnce()
  expect(unregisterLocale).toHaveBeenCalledOnce()
})
