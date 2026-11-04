import { contextMenuHook } from '@deepseek-ai/dsh-client-test-runtime'
// @vitest-environment jsdom
import { useState, type ReactNode } from 'react'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { act, cleanup, fireEvent, type RenderResult, within } from '@testing-library/react'
import { AttachmentId, type FileAttachmentRef, type ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { en as commonEn } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import type { PropsRenderFactories, PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { UserContentAttachment, UserContentData, UserContentInput } from '../src/client/contract/slots.ts'
import { UserContent } from '../src/client/chat/UserContent.tsx'
import { en, NS, zh } from '../src/client/locale.ts'
import type { UserTextInjected } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { UserTextRegistry } from '../../ui-conversation/src/client/conversation/user-text-registry.ts'
import { UserText, PlainUserText, SessionReference } from '../../ui-conversation/src/client/user-text/UserText.tsx'
import { sessionReferenceRule } from '../../ui-conversation/src/client/user-text/session-reference-rule.ts'
import { collapseWhitespaceRule, trimWhitespaceRule } from '../../ui-conversation/src/client/user-text/whitespace-rules.ts'
import { fileReferenceRule, folderReferenceRule } from '../../ui-reference/src/client/user-text-rules.ts'
import { FileReference, FolderReference } from '../../ui-reference/src/client/FileReference.tsx'
import { en as referenceEn, zh as referenceZh } from '../../ui-reference/src/client/locales.ts'
import { skillReferenceRule } from '../../ui-skill/src/client/user-text-rules.ts'
import { SkillReference } from '../../ui-skill/src/client/SkillReference.tsx'

afterEach(cleanup)

const image: ImageAttachmentRef = {
  attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`),
  mediaType: 'image/png', bytes: 68, width: 640, height: 320, name: 'history.png',
}
const file: FileAttachmentRef = {
  attachmentId: AttachmentId(`sha256:${'b'.repeat(64)}`), name: 'notes.txt', bytes: 23,
}
const durable: UserContentAttachment = { type: 'image', image: { attachment: image } }
const preview: UserContentAttachment = {
  type: 'image', image: { preview: { url: 'blob:local-preview', name: 'preview.png', width: 4, height: 3 } },
}
const filePart: UserContentAttachment = { type: 'file', file }
const empty: UserContentData = { text: '', attachments: [], extraBlocks: [] }
type RenderSeats = PropsRenderSlots<'conversation.approval.detail'> & PropsRenderFactories

async function bench() {
  const runtime = await SlotTestRuntime.create()
  onTestFinished(() => runtime.dispose())
  const locale = new LocaleRuntime(runtime.ctx)
  runtime.ctx.provide('locale', locale)
  locale.register('common', { en: commonEn, zh: commonZh })
  locale.register(NS, { en, zh })
  locale.register('reference', { en: referenceEn, zh: referenceZh })
  locale.setLocale('en')
  runtime.slots.installLocale(locale)
  const imageCalls: PropsRuntime<'conversation.chat.user.images'>[] = []
  const openFile = vi.fn<(path: string) => void>()
  const openSkill = vi.fn<(name: string) => void>()
  await runtime.mount({ inject: ['slots'], apply: (ctx) => {
    ctx.slots.provideRoot({ props: { useContextMenu: contextMenuHook() } })
    const userText = new UserTextRegistry(ctx)
    for (const rule of [
      sessionReferenceRule, fileReferenceRule, folderReferenceRule, skillReferenceRule,
      collapseWhitespaceRule, trimWhitespaceRule,
    ]) {
      userText.register(rule)
    }
    ctx.slots.registerFactory({
      name: 'conversation.user.text', scope: 'session',
      children: { 'conversation.user.text.node': { kind: 'keyed', scope: 'session', inline: true } },
      inject: (): UserTextInjected => ({
        hooks: { userTextRevision: {
          getSnapshot: () => userText.getSnapshot(), subscribe: listener => userText.subscribe(listener),
        } },
        createUserTextEvaluator: () => userText.createEvaluator(),
        reportTransformFailure: (error: unknown): never => { throw error },
      }),
    }, UserText)
    ctx.slots.register({ name: 'conversation.user.text.node', key: 'text' }, PlainUserText)
    ctx.slots.register({ name: 'conversation.user.text.node', key: 'session' }, SessionReference)
    ctx.slots.register({ name: 'conversation.user.text.node', key: 'file', locale: 'reference',
      inject: () => ({ openFile, resolveFilePath: path => path }) }, FileReference)
    ctx.slots.register({ name: 'conversation.user.text.node', key: 'folder' }, FolderReference)
    ctx.slots.register({ name: 'conversation.user.text.node', key: 'skill', inject: () => ({ openSkill }) }, SkillReference)
    ctx.slots.inject('conversation.chat.user.images', () => ctx.slots.register({ name: 'conversation.chat.user.images' }, function ImageProbe(props) {
      imageCalls.push(props)
      const source = props.images[0]
      if (source === undefined) throw new Error('User content must pass one image to the image Slot')
      const name = 'attachment' in source ? source.attachment.name : source.preview.name
      return <span data-testid="image" data-session={props.sessionId}
        data-current-session={props.useSession(snapshot => snapshot.sessionId)}>{name}</span>
    }))
  } })
  const mountContent = () => runtime.mount({ inject: ['slots'], apply: (ctx) => {
    ctx.slots.registerFactory({
      name: 'conversation.chat.user.content', scope: 'session', locale: NS,
      children: { 'conversation.chat.user.images': { kind: 'single', scope: 'session' } },
    }, UserContent)
  } })
  const owner = await mountContent()
  await runtime.sessions.add({ id: 'user-content' })
  const session = runtime.sessions.retainFor(runtime.ctx, SessionId('user-content'))
  const captured: { seats?: RenderSeats; setContent?: (content: ReactNode) => void } = {}
  await runtime.root.declare({
    'conversation.approval.detail': { kind: 'single', scope: 'session' },
  }, function TestRoot(props) {
    const [content, setContent] = useState<ReactNode>(null)
    captured.seats = props
    captured.setContent = setContent
    return content
  })
  const view = runtime.renderRoot()
  const { seats, setContent } = captured
  if (seats === undefined || setContent === undefined) throw new Error('User content fixture root did not render')
  const { SessionProvider } = seats
  const factory = (input: UserContentInput) => seats.renderFactorySlot('conversation.chat.user.content', input)
  const render = (content: ReactNode, scoped = true): RenderResult => {
    const update = (next: ReactNode): void => {
      act(() => { setContent(scoped ? <SessionProvider session={session}>{next}</SessionProvider> : next) })
    }
    update(content)
    return { ...view, rerender: update }
  }
  const loadImage = vi.fn<UserContentInput['loadImage']>(async () => 'blob:loaded')
  return { runtime, locale, owner, mountContent, factory, render, loadImage, imageCalls, SessionProvider, openFile, openSkill }
}

describe('user Content Factory', () => {
  it('renders prepared text directly without a row, admission markers, time, or copy controls', async () => {
    const b = await bench()
    const text = '**literal user text**\nsecond line'
    const view = b.render(b.factory({ content: { ...empty, text }, facts: {}, loadImage: b.loadImage }))
    const textNode = view.getByText('**literal user text** second line')
    expect(textNode.textContent).toBe(text)
    const root = view.container.querySelector('[data-slot="root"]')
    expect(textNode.closest('div')?.parentElement).toBe(root?.firstElementChild)
    expect(root?.children).toHaveLength(1)
    expect(view.container.querySelector('strong, time, [role="status"], [data-pending-steering], [data-submission-echo]')).toBeNull()
    expect(view.queryAllByRole('button')).toHaveLength(0)
    expect(view.container.querySelector('[data-message-attachments]')).toBeNull()
    expect(b.runtime.factoryOf('conversation.chat.user.content')).toMatchObject({
      component: UserContent, scope: 'session', locale: 'chat',
    })
  })

  it('keeps mixed files, durable images, and local previews in their prepared order through its user-image Slot', async () => {
    const b = await bench()
    const content: UserContentData = {
      ...empty, text: 'Prepared text', attachments: [filePart, durable, { type: 'file', file: { ...file, name: 'last.md' } }, preview],
    }
    const view = b.render(b.factory({ content, facts: {}, loadImage: b.loadImage }))
    const attachments = view.container.querySelector('[data-message-attachments]')
    expect([...attachments?.children ?? []].map(child => child.textContent)).toEqual([
      'notes.txtTXT 23B', 'history.png', 'last.mdMD 23B', 'preview.png',
    ])
    expect(view.getByTitle('notes.txt')).toBeTruthy()
    expect(view.getByText('Prepared text')).toBeTruthy()
    const durableCall = b.imageCalls.find(call => call.images[0] === durable.image)
    const previewCall = b.imageCalls.find(call => call.images[0] === preview.image)
    expect(durableCall?.images).toEqual([durable.image])
    expect(previewCall?.images).toEqual([preview.image])
    for (const call of [durableCall, previewCall]) {
      expect(call).toMatchObject({ align: 'end', compact: true, loadImage: b.loadImage })
    }
    expect(b.loadImage).not.toHaveBeenCalled()
  })

  it.each([
    { label: 'one durable image', attachments: [durable], compact: false },
    { label: 'one preview', attachments: [preview], compact: false },
    { label: 'one file and one image', attachments: [filePart, durable], compact: true },
    { label: 'one preview and one file', attachments: [preview, filePart], compact: true },
  ])('uses all attachments to choose compact images: $label', async ({ attachments, compact }) => {
    const b = await bench()
    const view = b.render(b.factory({ content: { ...empty, attachments }, facts: {}, loadImage: b.loadImage }))
    expect(view.getAllByTestId('image')).toHaveLength(1)
    expect(b.imageCalls[0]).toMatchObject({ compact, align: 'end', loadImage: b.loadImage })
    expect(view.queryAllByRole('button')).toHaveLength(0)
    expect(view.container.querySelector('[data-slot="root"]')?.firstElementChild?.children).toHaveLength(1)
  })

  it('reuses one prepared value in unrelated parents while nested images inherit each Session', async () => {
    const b = await bench()
    await b.runtime.sessions.add({ id: 'other-user-content' })
    const other = b.runtime.sessions.retainFor(b.runtime.ctx, SessionId('other-user-content'))
    const content: UserContentData = Object.freeze({
      text: 'Already prepared', attachments: Object.freeze([preview]), extraBlocks: Object.freeze([]),
    })
    const input: UserContentInput = { content, facts: {}, loadImage: b.loadImage }
    const { SessionProvider } = b
    const view = b.render(<>
      <section data-testid="first">{b.factory(input)}</section>
      <aside data-testid="second"><SessionProvider session={other}>{b.factory(input)}</SessionProvider></aside>
    </>)
    for (const [parent, sessionId] of [['first', 'user-content'], ['second', 'other-user-content']] as const) {
      const section = within(view.getByTestId(parent))
      expect(section.getByText('Already prepared')).toBeTruthy()
      expect(section.getByTestId('image').getAttribute('data-session')).toBe(sessionId)
      expect(section.getByTestId('image').getAttribute('data-current-session')).toBe(sessionId)
    }
    expect(b.imageCalls.every(call => call.images[0] === preview.image)).toBe(true)
  })

  it('binds live Chat locale labels for reference summaries and opaque extra blocks', async () => {
    const b = await bench()
    const block = { type: 'future-block', value: 'x'.repeat(20_001) }
    const content: UserContentData = { ...empty, extraBlocks: [block], referenceLabels: ['Alpha', 'Beta'] }
    const view = b.render(b.factory({ content, facts: {}, loadImage: b.loadImage }))
    expect(view.getByText('Referenced session · Alpha, Beta')).toBeTruthy()
    fireEvent.click(view.getByRole('button', { name: '▸ Extra content block' }))
    expect(view.container.querySelector('pre')?.textContent).toContain('"type": "future-block"')
    expect(view.container.querySelector('pre')?.textContent).toContain(
      `… truncated, ${JSON.stringify(block, null, 2).length} characters total`,
    )
    act(() => { b.locale.setLocale('zh') })
    expect(view.getByText('引用会话 · Alpha、Beta')).toBeTruthy()
    expect(view.getByRole('button', { name: '▾ 附加内容块' })).toBeTruthy()
    expect(view.container.querySelector('pre')?.textContent).toContain(
      `… 已截断，共 ${JSON.stringify(block, null, 2).length} 字符`,
    )
  })

  it('opens file and skill references through their own injectors only in interactive content', async () => {
    const b = await bench()
    const labels = ['Alpha']
    const content: UserContentData = {
      ...empty, text: 'Read @"src/my file.ts" with /review and @Alpha', referenceLabels: labels,
    }
    const facts = { sessionLabels: labels, skillNames: ['review'] }
    const view = b.render(b.factory({ content, facts, loadImage: b.loadImage, interactive: true }))
    fireEvent.click(view.getByRole('button', { name: 'my file.ts' }))
    fireEvent.click(view.getByRole('button', { name: '/review' }))
    expect(b.openFile).toHaveBeenCalledWith('src/my file.ts')
    expect(b.openSkill).toHaveBeenCalledWith('review')
    expect(view.queryByRole('button', { name: 'Alpha' })).toBeNull()
    view.rerender(b.factory({ content, facts, loadImage: b.loadImage }))
    expect(view.queryAllByRole('button')).toHaveLength(0)
    for (const label of ['my file.ts', '/review', 'Alpha']) fireEvent.click(view.getByText(label, { exact: true }))
    expect(b.openFile).toHaveBeenCalledTimes(1)
    expect(b.openSkill).toHaveBeenCalledTimes(1)
    expect(view.container.querySelectorAll('[data-ref-chip]')).toHaveLength(3)
  })

  it('keeps an empty prepared value empty', async () => {
    const b = await bench()
    const view = b.render(b.factory({ content: empty, facts: {}, loadImage: b.loadImage }))
    expect(view.container.textContent).toBe('')
    const root = view.container.querySelector('[data-slot="root"]')
    expect(root?.children).toHaveLength(1)
    expect(root?.firstElementChild?.children).toHaveLength(0)
    expect(view.container.querySelector('[data-message-attachments]')).toBeNull()
    expect(view.queryAllByRole('button')).toHaveLength(0)
    expect(b.imageCalls).toHaveLength(0)
  })

  it('removes live content on owner disposal and renders it again after registration', async () => {
    const b = await bench()
    const view = b.render(b.factory({ content: { ...empty, text: 'Reusable content' }, facts: {}, loadImage: b.loadImage }))
    expect(view.getByText('Reusable content')).toBeTruthy()
    await b.owner.dispose()
    expect(view.queryByText('Reusable content')).toBeNull()
    expect(() => b.runtime.factoryOf('conversation.chat.user.content')).toThrow('no definition')
    await b.mountContent()
    expect(view.getByText('Reusable content')).toBeTruthy()
  })

  it('requires a Session binding even when the prepared value has no images', async () => {
    const b = await bench()
    const message = "strict session factory 'conversation.chat.user.content' rendered without a scope binding"
    const suppressExpectedError = (event: ErrorEvent): void => {
      if (event.error instanceof Error && event.error.message === message) event.preventDefault()
    }
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    window.addEventListener('error', suppressExpectedError)
    try {
      expect(() => b.render(b.factory({ content: { ...empty, text: 'Unbound content' }, facts: {}, loadImage: b.loadImage }), false))
        .toThrow(message)
    } finally {
      window.removeEventListener('error', suppressExpectedError)
      error.mockRestore()
    }
  })
})
