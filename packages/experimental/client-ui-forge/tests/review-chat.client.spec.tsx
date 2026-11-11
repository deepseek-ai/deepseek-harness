// @vitest-environment jsdom
/**
 * The review page's chat tab: starting the conversation in a Workspace's blank Session, retaining and binding it, the
 * draft reference and suggested prompts, switching Workspaces, and the embedded conversation's phase.
 */
import type { ReactNode } from 'react'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionListState, SessionReference, SessionSnapshot } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ConversationSnapshot, ConversationViewsProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector, conversationSnapshot, makeTranslate, sessionSnapshot } from '@deepseek-ai/dsh-client-test-runtime'
import type { RenderFactorySlot, SessionAreaProps } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { brandString } from '@deepseek-ai/dsh-brand'
import { en } from '../src/client/locales.ts'
import {
  ReviewChat, ReviewChatView, ReviewConversation, type ReviewChatFace, type ReviewChatProps, type ReviewConversationProps,
} from '../src/client/ReviewChat.tsx'
import type { ForgeReviewConversationProps } from '../src/client/slots.ts'
import { snapshot } from './client-fixtures.client.ts'
import { prUrl, reviewed } from './review-fixtures.client.ts'

afterEach(cleanup)

const t = makeTranslate(en)
const S1 = brandString<SessionId>('s1')
const S2 = brandString<SessionId>('s2')
const URL7 = prUrl(7)

/** A promise the test settles by hand. */
function deferred<T>() {
  let settle: (value: T) => void = () => {}
  let fail: (error: unknown) => void = () => {}
  const promise = new Promise<T>((resolve, reject) => { settle = resolve; fail = reject })
  return { promise, settle, fail }
}

/** Let the connection settle. */
async function settle(): Promise<void> {
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
}

/** The reference the chat face hands out for a retained Session, with the signal that releases it. */
interface Retained {
  readonly reference: SessionReference
  readonly signal: AbortSignal
}

/** Render the chat tab of #7 with a chat face that records every call and connects to `S1`. */
function renderChat(overrides: Partial<ReviewChatProps> = {}) {
  const retained: Retained[] = []
  const chat = {
    connect: vi.fn<ReviewChatFace['connect']>(async () => S1),
    retain: vi.fn<ReviewChatFace['retain']>((sessionId, signal) => {
      // Only the identity the chat tab hands back to the face is supplied.
      const reference = { sessionId } as SessionReference
      retained.push({ reference, signal })
      return reference
    }),
    stage: vi.fn<ReviewChatFace['stage']>(),
    fill: vi.fn<ReviewChatFace['fill']>(),
    openInMain: vi.fn<ReviewChatFace['openInMain']>(),
    requestWorktree: vi.fn<ReviewChatFace['requestWorktree']>(),
  }
  const slots: ForgeReviewConversationProps[] = []
  const renderSlot = ((_key: string, owner: ForgeReviewConversationProps) => {
    slots.push(owner)
    return <div data-review-conversation={owner.headline} />
  }) as ReviewChatProps['renderSlot']
  const provided: SessionAreaProps['session'][] = []
  function SessionProvider({ session, children }: SessionAreaProps): ReactNode {
    provided.push(session)
    return <>{children}</>
  }
  const props: ReviewChatProps = {
    frame: reviewed(7), sessionId: undefined, onConversation: vi.fn(), chat, renderSlot, SessionProvider, t, ...overrides,
  }
  const view = render(<ReviewChat {...props} />)
  const rerender = (next: Partial<ReviewChatProps>): void => { view.rerender(<ReviewChat {...props} {...next} />) }
  const slot = (): ForgeReviewConversationProps => {
    const owner = slots.at(-1)
    if (owner === undefined) throw new Error('no conversation drawn')
    return owner
  }
  return { view, props, chat, retained, slots, slot, provided, rerender }
}

describe('ReviewChat start', () => {
  it('starts a conversation about the change request once and records it', async () => {
    const b = renderChat()
    expect(b.chat.connect).toHaveBeenCalledWith(b.props.frame)
    expect(b.view.container.textContent).toBe('')
    await settle()
    expect(b.props.onConversation).toHaveBeenCalledWith(S1)
    expect(b.chat.retain).not.toHaveBeenCalled()
  })

  it.each([
    ['without any Workspace', async (): Promise<undefined> => { await Promise.resolve() }],
    ['when the Workspace does not open', async (): Promise<SessionId | undefined> => { throw new Error('connect failed') }],
  ] as const)('shows the conversation as unavailable %s', async (_label, connect) => {
    const b = renderChat()
    b.chat.connect.mockImplementation(connect)
    b.rerender({ frame: reviewed(7, snapshot(7, { title: 'Renamed' })) })
    await settle()
    expect(b.view.getByRole('status').textContent).toBe('Conversation unavailable')
    expect(b.props.onConversation).not.toHaveBeenCalled()
  })

  it('ignores a connection that settles after the tab closed', async () => {
    const resolved = deferred<SessionId | undefined>()
    const rejected = deferred<SessionId | undefined>()
    const first = renderChat()
    first.chat.connect.mockReturnValueOnce(resolved.promise)
    first.rerender({ frame: reviewed(7, snapshot(7, { title: 'Renamed' })) })
    first.view.unmount()
    const second = renderChat()
    second.chat.connect.mockReturnValueOnce(rejected.promise)
    second.rerender({ frame: reviewed(7, snapshot(7, { title: 'Renamed' })) })
    second.view.unmount()
    resolved.settle(S1)
    rejected.fail(new Error('late'))
    await settle()
    expect(first.props.onConversation).not.toHaveBeenCalled()
    expect(second.props.onConversation).not.toHaveBeenCalled()
    expect(second.view.container.innerHTML).toBe('')
  })
})

describe('ReviewChat conversation', () => {
  it('retains the conversation, binds the change request to it, and fills the reference into its draft once', () => {
    const b = renderChat({ sessionId: S1 })
    expect(b.chat.connect).not.toHaveBeenCalled()
    expect(b.chat.retain).toHaveBeenCalledOnce()
    expect(b.chat.retain).toHaveBeenCalledWith(S1, b.retained[0]?.signal)
    expect(b.chat.stage).toHaveBeenCalledWith(S1, URL7)
    expect(b.chat.fill).toHaveBeenCalledOnce()
    expect(b.chat.fill).toHaveBeenCalledWith(b.retained[0]?.reference, { kind: 'reference', frame: b.props.frame })
    expect(b.provided).toContain(b.retained[0]?.reference)
    expect(b.slot().headline).toBe('Review demo #7')
    expect(b.view.container.querySelector('[data-review-conversation="Review demo #7"]')).not.toBeNull()

    // A later frame of the same change request and a new chat face keep the retained Session and its draft.
    const chat = { ...b.chat }
    b.rerender({ frame: reviewed(7, snapshot(7, { title: 'Renamed' })), chat })
    expect(b.chat.retain).toHaveBeenCalledOnce()
    expect(b.chat.fill).toHaveBeenCalledOnce()
    expect(b.chat.stage).toHaveBeenCalledTimes(2)
  })

  it('fills a suggested prompt, asking for a worktree before the one that runs tests', () => {
    const b = renderChat({ sessionId: S1 })
    const reference = b.retained[0]?.reference
    fireEvent.click(b.view.getByRole('button', { name: 'Review this change request' }))
    expect(b.chat.requestWorktree).not.toHaveBeenCalled()
    expect(b.chat.fill).toHaveBeenLastCalledWith(reference, { kind: 'prompt', frame: b.props.frame, text: 'Review this change request' })
    fireEvent.click(b.view.getByRole('button', { name: 'Check out and run the related tests' }))
    expect(b.chat.requestWorktree).toHaveBeenCalledWith(S1)
    expect(b.chat.fill).toHaveBeenLastCalledWith(reference, {
      kind: 'prompt', frame: b.props.frame, text: 'Check out and run the related tests',
    })
    fireEvent.click(b.view.getByRole('button', { name: 'Explain the failed checks' }))
    expect(b.chat.requestWorktree).toHaveBeenCalledOnce()
  })

  it('starts over, forgetting the binding, and opens the conversation in the main view', () => {
    const b = renderChat({ sessionId: S1 })
    fireEvent.click(b.view.getByRole('button', { name: 'New conversation' }))
    expect(b.chat.stage).toHaveBeenLastCalledWith(S1, null)
    expect(b.props.onConversation).toHaveBeenCalledWith(null)
    fireEvent.click(b.view.getByRole('button', { name: 'Open in main view' }))
    expect(b.chat.openInMain).toHaveBeenCalledWith(S1)
  })

  it('moves to the blank Session of a Workspace the reader picks, retaining it before the handler returns', () => {
    const b = renderChat({ sessionId: S1 })
    act(() => { b.slot().onWorkspaceSession(S1) })
    expect(b.chat.retain).toHaveBeenCalledOnce()
    expect(b.props.onConversation).not.toHaveBeenCalled()

    act(() => { b.slot().onWorkspaceSession(S2) })
    expect(b.chat.retain).toHaveBeenLastCalledWith(S2, b.retained[1]?.signal)
    expect(b.retained[0]?.signal.aborted).toBe(true)
    expect(b.chat.stage).toHaveBeenLastCalledWith(S1, null)
    expect(b.props.onConversation).toHaveBeenCalledWith(S2)

    b.rerender({ sessionId: S2 })
    expect(b.chat.retain).toHaveBeenCalledTimes(2)
    expect(b.chat.stage).toHaveBeenLastCalledWith(S2, URL7)
    // The moved draft already names the change request.
    expect(b.chat.fill).toHaveBeenCalledOnce()
    b.view.unmount()
    expect(b.retained[1]?.signal.aborted).toBe(true)
  })
})

describe('ReviewConversation', () => {
  type Facts = Partial<Pick<SessionSnapshot, 'blank' | 'awaitingFirstTurn' | 'running' | 'promptAttempted' | 'openState'>>
  const blank: Facts = { blank: true, awaitingFirstTurn: true, openState: 'open' }

  function renderConversation(facts: Facts, options: { readonly active?: boolean; readonly listedBlank?: boolean } = {}) {
    const session = createSnapshotStore<SessionSnapshot>({ ...sessionSnapshot(S1), ...facts })
    const conversation = createSnapshotStore<ConversationSnapshot>(conversationSnapshot({
      activeTargets: new Set(options.active === true ? ['chat'] : []),
    }))
    const summary = { id: S1, displayTitle: 'S1', running: false, blank: options.listedBlank ?? false, updatedAt: 0, retainedBy: {} }
    const sessions = createSnapshotStore<SessionListState>({
      ids: [S1], byId: options.listedBlank === undefined ? {} : { [S1]: summary }, phase: 'ready', projectionsBySession: {},
    })
    const factory: unknown[][] = []
    const renderFactorySlot: RenderFactorySlot = (...args) => {
      factory.push(args)
      return null
    }
    const onWorkspaceSession: (sessionId: SessionId) => void = vi.fn()
    const props = {
      sessionId: S1, useSession: bindSnapshotSelector(session), useConversation: bindSnapshotSelector(conversation),
      useSessions: bindSnapshotSelector(sessions), renderFactorySlot, headline: 'Review demo #7', onWorkspaceSession,
    }
    const view = render(<ReviewConversation {...props as ReviewConversationProps} />)
    return { view, factory, onWorkspaceSession }
  }

  it.each([
    ['active once a target runs', blank, { active: true }, 'active', false],
    ['active once the Session has turns', { blank: false, awaitingFirstTurn: false }, {}, 'active', false],
    ['active while it runs', { ...blank, running: true }, {}, 'active', false],
    ['active once a prompt was attempted', { ...blank, promptAttempted: true }, {}, 'active', false],
    ['settling while a Session not known to be blank opens', { ...blank, openState: 'loading' }, {}, 'settling', false],
    ['a hero while a Session listed as blank opens', { ...blank, openState: 'loading' }, { listedBlank: true }, 'hero', true],
    ['a hero once a blank Session opened', { blank: false, awaitingFirstTurn: true }, { listedBlank: false }, 'hero', true],
    ['active when a blank Session failed to open', { ...blank, openState: 'error' }, {}, 'active', false],
  ] as const)('shows the conversation as %s', (_label, facts, options, phase, hero) => {
    const b = renderConversation(facts, options)
    expect(b.view.container.querySelector(`[data-forge-review-conversation="${S1}"]`)).not.toBeNull()
    expect(b.factory).toEqual([['conversation.content', {
      variant: 'embedded', phase, hero, headline: 'Review demo #7', onWorkspaceSession: b.onWorkspaceSession,
    }, { slots: { views: ReviewChatView } }]])
  })

  it('shows only the Chat view of the conversation', () => {
    const calls: [string, object][] = []
    const renderSlot = ((key: string, owner: object) => {
      calls.push([key, owner])
      return <p>chat view</p>
    }) as ConversationViewsProps['renderSlot']
    const view = render(<ReviewChatView {...{ renderSlot } as ConversationViewsProps} />)
    expect(calls).toEqual([['conversation.session', { view: 'chat' }]])
    expect(view.getByText('chat view')).toBeTruthy()
  })
})
