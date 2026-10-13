// @vitest-environment jsdom
/** Independent domain image positions with one shared official gallery Factory. */
import { act, cleanup, within } from '@testing-library/react'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { UiConversation } from '@deepseek-ai/dsh-client-ui-conversation/src/client/conversation/assembly.ts'
import { en, zh } from '@deepseek-ai/dsh-client-ui-conversation/src/client/locales.ts'
import type { MessageImagesOwnerProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import * as attachmentPlugin from '../src/client/index.ts'

afterEach(cleanup)

const SLOTS = [
  'conversation.chat.user.images', 'conversation.chat.message.images',
  'conversation.trajectory.images', 'tool.call.images',
] as const

async function bench() {
  const runtime = await SlotTestRuntime.create()
  onTestFinished(() => runtime.dispose())
  const locale = new LocaleRuntime(runtime.ctx)
  locale.register('conversation', { en, zh })
  locale.setLocale('en')
  runtime.ctx.provide('locale', locale)
  runtime.slots.installLocale(locale)
  new UiConversation(runtime.ctx, runtime.sessions)
  await runtime.mount(attachmentPlugin)
  await runtime.sessions.add({ id: 'image-domains' })
  const session = runtime.sessions.retainFor(runtime.ctx, SessionId('image-domains'))
  const input: MessageImagesOwnerProps = {
    images: [{ attachment: {
      attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`), mediaType: 'image/png',
      name: 'shared.png', width: 1, height: 1, bytes: 68,
    } }],
    loadImage: vi.fn(async () => 'blob:shared'), align: 'start',
  }
  await runtime.root.declare({
    'conversation.chat.user.images': { kind: 'single', scope: 'session' },
    'conversation.chat.message.images': { kind: 'single', scope: 'session' },
    'conversation.trajectory.images': { kind: 'single', scope: 'session' },
    'tool.call.images': { kind: 'single', scope: 'session' },
  }, ({ renderSlot, SessionProvider }) => <SessionProvider session={session}>
    {SLOTS.map(name => <section key={name} data-testid={name}>{renderSlot(name, input)}</section>)}
  </SessionProvider>)
  return { runtime, view: runtime.renderRoot() }
}

describe('domain image Slots', () => {
  it.each(SLOTS)('replaces only %s and restores the shared gallery on disposal', async (name) => {
    const { runtime, view } = await bench()
    expect(runtime.factoryOf('conversation.images.content').scope).toBe('root')
    const images = new Map<string, HTMLElement>()
    for (const slot of SLOTS) {
      expect(runtime.slots.entries(slot)[0]?.options.priority).toBe(100)
      images.set(slot, await within(view.getByTestId(slot)).findByAltText('shared.png'))
    }
    const override = await runtime.mount({ inject: ['slots'], apply(ctx) {
      ctx.slots.register({ name, priority: 0 }, () => <span>Domain override</span>)
    } })
    const target = within(view.getByTestId(name))
    expect(target.getByText('Domain override')).toBeTruthy()
    expect(target.queryByAltText('shared.png')).toBeNull()
    for (const other of SLOTS.filter(slot => slot !== name)) {
      expect(within(view.getByTestId(other)).getByAltText('shared.png')).toBe(images.get(other))
    }
    await act(async () => { await override.dispose() })
    expect(target.queryByText('Domain override')).toBeNull()
    expect(await target.findByAltText('shared.png')).toBeTruthy()
    for (const other of SLOTS.filter(slot => slot !== name)) {
      expect(within(view.getByTestId(other)).getByAltText('shared.png')).toBe(images.get(other))
    }
  })
})
