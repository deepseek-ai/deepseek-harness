import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { TestSessions } from '@deepseek-ai/dsh-client-test-runtime'
import { apply as applyHost } from '../src/index.ts'
import { apply, inject } from '../src/client/index.ts'
import { ComposerAttachments } from '../src/client/ComposerAttachments.tsx'
import { MessageImages, MessageImagesContent } from '../src/client/MessageImages.tsx'

const IMAGE_SLOTS = [
  'conversation.chat.message.images', 'conversation.chat.user.images',
  'conversation.trajectory.images', 'tool.call.images',
] as const

async function bench() {
  const ctx = new Context()
  const sessions = new TestSessions(async (action) => { await action() }, ctx)
  onTestFinished(async () => {
    await sessions.disposeScopes()
    await ctx.fiber.dispose()
  })
  ctx.provide('sessions', sessions)
  ctx.provide('contextMenus', { open: vi.fn() } as never)
  ctx.provide('locale', new LocaleRuntime(ctx))
  await ctx.plugin(SlotRegistry).await()
  ctx.slots.register({
    name: 'root',
    children: {
      'conversation.input.attachments': { kind: 'single', scope: 'session-maybe' },
      'conversation.chat.message.images': { kind: 'single', scope: 'session' },
      'conversation.chat.user.images': { kind: 'single', scope: 'session' },
      'conversation.trajectory.images': { kind: 'single', scope: 'session' },
      'tool.call.images': { kind: 'single', scope: 'session' },
    },
  } as never, () => null)
  const readFileDrag = vi.fn(() => undefined)
  ctx.provide('fileDrag', { actions: fileDrag, read: readFileDrag })
  const register = vi.spyOn(ctx.slots, 'register')
  const registerFactory = vi.spyOn(ctx.slots, 'registerFactory')
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  return { ctx, fiber, register, registerFactory, readFileDrag }
}

describe('attachment plugin', () => {
  it('keeps the host half empty', () => {
    expect(() => { applyHost() }).not.toThrow()
  })

  it('registers all entries and removes them with the plugin fiber', async () => {
    const { ctx, fiber, register, registerFactory, readFileDrag } = await bench()
    expect(inject).toEqual(['slots', 'fileDrag'])
    expect(registerFactory.mock.calls[0]?.[0]).toMatchObject({
      name: 'conversation.images.content', scope: 'root', locale: 'conversation',
    })
    expect(typeof registerFactory.mock.calls[0]?.[0].inject).toBe('function')
    expect(registerFactory.mock.calls[0]?.[1]).toBe(MessageImagesContent)
    expect(ctx.slots.snapshot('factory:conversation.images.content')).toHaveLength(1)
    expect(ctx.slots.entries('conversation.input.attachments')).toMatchObject([{
      locale: 'conversation', component: ComposerAttachments,
    }])
    const composer = register.mock.calls.find(([options]) => options.name === 'conversation.input.attachments')!
    const injectComposer = composer[0].inject as () => { readFileDrag: () => undefined }
    injectComposer().readFileDrag()
    expect(readFileDrag).toHaveBeenCalledOnce()
    for (const name of IMAGE_SLOTS) {
      expect(ctx.slots.entries(name)).toMatchObject([{ component: MessageImages, options: { priority: 100 } }])
    }
    await fiber.dispose()
    expect(ctx.slots.entries('conversation.input.attachments')).toHaveLength(0)
    for (const name of IMAGE_SLOTS) expect(ctx.slots.entries(name)).toHaveLength(0)
    expect(ctx.slots.snapshot('factory:conversation.images.content')).toHaveLength(0)
  })
})

const fileDrag = { prepare: vi.fn(async () => ({ start: () => true, release: () => {} })), reportFailure: vi.fn() }
