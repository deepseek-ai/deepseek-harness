// @vitest-environment jsdom

import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { makeTranslate, SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import type { MessageImagesOwnerProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { AssistantMarkdown, type AssistantMarkdownProps } from '../src/client/chat/AssistantMarkdown.tsx'
import { useDetailedPresentation } from './presentation-fixture.client.ts'
import { useDisclosure } from '../src/client/chat/use-disclosure.ts'
import { useSearchableHidden } from '../src/client/chat/searchable-hidden.ts'
import { zh } from '../src/client/locale.ts'

afterEach(cleanup)

const t = makeTranslate(zh, commonZh)

const attachment = {
  attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`),
  mediaType: 'image/png' as const,
  bytes: 68,
  width: 640,
  height: 320,
  name: 'history.png',
}

async function renderImages(blocks: AssistantMarkdownProps['blocks'], calls: MessageImagesOwnerProps[]) {
  const runtime = await SlotTestRuntime.create()
  onTestFinished(() => runtime.dispose())
  const loadImage = vi.fn<AssistantMarkdownProps['loadImage']>(async () => 'blob:history')
  runtime.slots.inject('conversation.chat.message.images', () => runtime.slots.register({ name: 'conversation.chat.message.images' }, (owner: MessageImagesOwnerProps) => {
    calls.push(owner)
    return (
      <div data-testid="message-images" data-align={owner.align} data-count={owner.images.length}>
        {owner.images.map((entry, index) => {
          if (!('attachment' in entry)) throw new Error('assistant flow images are always durable references')
          const image = entry.attachment
          return <span key={`${image.attachmentId}:${String(index)}`}>{image.name}</span>
        })}
      </div>
    )
  }))
  await runtime.sessions.add({ id: 'image-labels' })
  const session = runtime.sessions.retainFor(runtime.ctx, SessionId('image-labels'))
  await runtime.root.declare({
    'conversation.chat.reasoning.body': { kind: 'single', scope: 'session' },
    'conversation.chat.message.images': { kind: 'single', scope: 'session' },
  }, ({ renderSlot, SessionProvider }) => (
    <SessionProvider session={session}>
      <AssistantMarkdown loadImage={loadImage} renderSlot={renderSlot}
        useDisclosure={useDisclosure} useGroupAction={useSearchableHidden}
        usePresentation={useDetailedPresentation} t={t} blocks={blocks} streaming={false} />
    </SessionProvider>
  ))
  return { view: runtime.renderRoot(), loadImage }
}

describe('assistant image slot handoff', () => {
  it('passes one image group and its message alignment to the renderer', async () => {
    const calls: MessageImagesOwnerProps[] = []
    const { view, loadImage } = await renderImages([{ kind: 'image', attachment }], calls)
    expect(view.getByTestId('message-images').getAttribute('data-align')).toBe('start')
    expect(calls).toHaveLength(1)
    expect(calls[0]?.images).toEqual([{ attachment }])
    expect(calls[0]?.loadImage).toBe(loadImage)
    expect(view.getByText('history.png')).toBeTruthy()
  })

  it('updates one message loader without changing its sibling or remounting either gallery', () => {
    const firstLoader = vi.fn<AssistantMarkdownProps['loadImage']>(async () => 'blob:first')
    const nextLoader = vi.fn<AssistantMarkdownProps['loadImage']>(async () => 'blob:next')
    const siblingLoader = vi.fn<AssistantMarkdownProps['loadImage']>(async () => 'blob:sibling')
    const firstRenderer = vi.fn((_key: string, _owner: object) => <span>first gallery</span>)
    const siblingRenderer = vi.fn((_key: string, _owner: object) => <span>sibling gallery</span>)
    const props = {
      blocks: [{ kind: 'image', attachment }], streaming: false, t,
      useDisclosure, useGroupAction: useSearchableHidden,
      usePresentation: useDetailedPresentation,
    } satisfies Omit<AssistantMarkdownProps, 'loadImage' | 'renderSlot'>
    const content = (loadImage: AssistantMarkdownProps['loadImage']) => (
      <>
        <AssistantMarkdown {...props} loadImage={loadImage} renderSlot={firstRenderer} />
        <AssistantMarkdown {...props} loadImage={siblingLoader} renderSlot={siblingRenderer} />
      </>
    )
    const view = render(content(firstLoader))
    const firstGallery = view.getByText('first gallery')
    const siblingGallery = view.getByText('sibling gallery')
    const owner = { images: [{ attachment }], align: 'start' }
    expect(firstRenderer).toHaveBeenLastCalledWith('conversation.chat.message.images', {
      ...owner, loadImage: firstLoader,
    })
    expect(siblingRenderer).toHaveBeenLastCalledWith('conversation.chat.message.images', {
      ...owner, loadImage: siblingLoader,
    })

    view.rerender(content(nextLoader))

    expect(firstRenderer).toHaveBeenLastCalledWith('conversation.chat.message.images', {
      ...owner, loadImage: nextLoader,
    })
    expect(siblingRenderer).toHaveBeenLastCalledWith('conversation.chat.message.images', {
      ...owner, loadImage: siblingLoader,
    })
    expect(view.getByText('first gallery')).toBe(firstGallery)
    expect(view.getByText('sibling gallery')).toBe(siblingGallery)
  })

  it('merges consecutive image blocks into one group and splits groups at text', async () => {
    const calls: MessageImagesOwnerProps[] = []
    const { view } = await renderImages([
      { kind: 'image', attachment },
      { kind: 'image', attachment },
      { kind: 'text', text: 'between' },
      { kind: 'image', attachment },
    ], calls)
    const galleries = view.getAllByTestId('message-images')
    expect(galleries).toHaveLength(2)
    expect(galleries.map(gallery => gallery.getAttribute('data-count'))).toEqual(['2', '1'])
    expect(calls.map(call => call.images.length)).toEqual([2, 1])
  })

  it('keeps the renderer output at the image block position between text blocks', async () => {
    const calls: MessageImagesOwnerProps[] = []
    const { view } = await renderImages([
      { kind: 'text', text: 'before' },
      { kind: 'image', attachment },
      { kind: 'text', text: 'after' },
    ], calls)
    const image = view.getByTestId('message-images')
    const before = view.getByText('before')
    const after = view.getByText('after')
    expect(before.compareDocumentPosition(image) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)
    expect(image.compareDocumentPosition(after) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)
  })
})
