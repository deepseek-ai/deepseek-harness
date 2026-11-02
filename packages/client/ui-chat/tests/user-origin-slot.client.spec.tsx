// @vitest-environment jsdom
/**
 * The official user renderer owns the source-decoration chain above its bubble.
 * Steering rows do not render the chain; changing its occupant preserves the
 * existing message content and actions.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import type {
  ChatConversationViewNode, SteeringMessageNode, UserMessageNode,
} from '@deepseek-ai/dsh-client-ui-chat/client'
import type { ChatNodeViewProps, UserContentInput } from '../src/client/contract/slots.ts'
import { UserMessageNodeView } from '../src/client/chat/MessageItem.tsx'
import { zh } from '../src/client/locale.ts'
import { createUserContentFixture } from './user-content-component-fixture.tsx'
import { unusedImageLoader } from './reasoning-component-fixture.tsx'

afterEach(cleanup)

const t: ChatNodeViewProps['t'] = makeTranslate(zh, commonZh)
type UserSlots = PropsRenderSlots<'conversation.chat.user.before'>
const userSlots: UserSlots = {
  renderSlot: () => null,
  renderSlotChain: (_key, _owner, opts) => opts?.fallback ?? null,
  SessionProvider: ({ children }) => <>{children}</>,
}

/** One durable source, unread by Chat itself. */
const SHARED = { kind: 'user', principal: { kind: 'share-viewer', shareId: 'share-1', actor: { subjectId: 'subject-42' } } }

let renderUserContent: ReturnType<typeof createUserContentFixture>
beforeEach(() => { renderUserContent = createUserContentFixture() })

const renderUserFactory: ChatNodeViewProps['renderFactorySlot'] = (name, input) => {
  if (name !== 'conversation.chat.user.content') throw new Error(`Unexpected Chat Factory: ${name}`)
  return renderUserContent(input as UserContentInput, () => null, t)
}

function viewProps(data: UserMessageNode): ChatNodeViewProps<'user'>
function viewProps(data: SteeringMessageNode): ChatNodeViewProps<'steering'>
function viewProps(data: UserMessageNode | SteeringMessageNode): ChatNodeViewProps<'user' | 'steering'> {
  const node = {
    key: `fixture:${data.kind}:${String(data.seq)}`,
    id: String(data.seq),
    kind: data.kind,
    target: 'chat',
    anchorSeq: data.seq,
    location: { kind: 'session' },
    visibility: 'visible',
    data,
  } as ChatConversationViewNode
  const props: Partial<Omit<ChatNodeViewProps, 'node'>> & { node: ChatConversationViewNode } = {
    node, t, loadImage: unusedImageLoader, renderFactorySlot: renderUserFactory, openFile: vi.fn(),
  }
  return props as ChatNodeViewProps<'user' | 'steering'>
}

const userData: UserMessageNode = {
  kind: 'user',
  seq: 7,
  time: 7_000,
  content: [{ type: 'text', text: 'hello' }] as never,
  source: SHARED,
}

const steeringData: SteeringMessageNode = {
  kind: 'steering',
  messageId: 'fixture-steering' as SteeringMessageNode['messageId'],
  seq: 8,
  time: 8_000,
  content: [{ type: 'text', text: 'steer' }] as never,
  source: SHARED,
}

describe('official user renderer origin seat', () => {
  it('renders the source chain above the bubble and passes the durable source', () => {
    const renderSlotChain = vi.fn(() => <span data-test-origin="">来自会话分享</span>)
    const view = render(<UserMessageNodeView {...viewProps(userData)} {...userSlots} renderSlotChain={renderSlotChain} />)
    const row = view.container.firstElementChild as HTMLElement
    const origin = row.querySelector('[data-test-origin]')
    const bubble = row.querySelector('[data-message-bubble]')

    expect(renderSlotChain).toHaveBeenCalledExactlyOnceWith(
      'conversation.chat.user.before', { source: SHARED, kind: 'user' }, { fallback: null },
    )
    expect(origin).not.toBeNull()
    expect(bubble).not.toBeNull()
    expect(row.firstElementChild).toBe(origin)
    expect(origin!.compareDocumentPosition(bubble!) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)
  })

  it('preserves the bubble, text and actions across empty and occupied chain output', () => {
    const props = viewProps(userData)
    const absent = vi.fn(() => null)
    const occupied = vi.fn(() => <span data-test-origin="">来自会话分享</span>)
    const empty = vi.fn(() => null)
    const view = render(<UserMessageNodeView {...props} {...userSlots} renderSlotChain={absent} />)
    const row = view.container.firstElementChild
    const bubble = view.container.querySelector('[data-message-bubble]')
    const text = view.getByText('hello').firstChild
    const copy = view.getByRole('button', { name: '复制' })
    const actions = copy.closest('[data-clock]')
    expect(bubble).not.toBeNull()
    expect(text?.nodeType).toBe(Node.TEXT_NODE)
    expect(actions).not.toBeNull()
    expect(view.container.querySelector('[data-test-origin]')).toBeNull()

    for (const renderSlotChain of [occupied, empty, absent]) {
      view.rerender(<UserMessageNodeView {...props} {...userSlots} renderSlotChain={renderSlotChain} />)
      expect(view.container.firstElementChild).toBe(row)
      expect(view.container.querySelector('[data-message-bubble]')).toBe(bubble)
      expect(view.getByText('hello').firstChild).toBe(text)
      expect(view.getByRole('button', { name: '复制' })).toBe(copy)
      expect(copy.closest('[data-clock]')).toBe(actions)
      expect(view.container.querySelector('[data-test-origin]') !== null).toBe(renderSlotChain === occupied)
    }
  })

  it('asks the chain only for the user row beside a steering row', () => {
    const renderSlotChain = vi.fn(() => <span data-test-origin="" />)
    const view = render(<>
      <UserMessageNodeView {...viewProps(userData)} {...userSlots} renderSlotChain={renderSlotChain} />
      <UserMessageNodeView {...viewProps(steeringData)} renderSlotChain={() => null} />
    </>)
    const steeringRow = view.container.lastElementChild!
    expect(steeringRow.textContent).toContain('steer')

    expect(renderSlotChain).toHaveBeenCalledExactlyOnceWith(
      'conversation.chat.user.before', { source: SHARED, kind: 'user' }, { fallback: null },
    )
    expect(view.container.querySelectorAll('[data-test-origin]')).toHaveLength(1)
    expect(steeringRow.querySelector('[data-test-origin]')).toBeNull()
    expect(view.container.querySelector('[data-chat-steering-batch]')).toBeNull()
  })
})
