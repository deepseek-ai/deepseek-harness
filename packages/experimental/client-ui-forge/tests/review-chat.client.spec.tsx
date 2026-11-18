// @vitest-environment jsdom
/**
 * The review page's chat tab and the conversation the page keeps for it: starting the conversation in a Workspace's blank
 * Session on first show or for a quote, retaining and binding it, the draft reference and suggested prompts, switching
 * Workspaces, and the embedded conversation's phase.
 */
import type { ReactNode } from 'react'
import { act, cleanup, fireEvent, render, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionListState, SessionReference, SessionSnapshot } from '@deepseek-ai/dsh-api-session-controller/client'
import type {
  ConversationSnapshot, ConversationViewsProps, WorkspaceSelectedHandler, WorkspaceSessionAdopter,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector, conversationSnapshot, makeTranslate, sessionSnapshot } from '@deepseek-ai/dsh-client-test-runtime'
import type { RenderFactorySlot, SessionAreaProps } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { brandString } from '@deepseek-ai/dsh-brand'
import { en } from '../src/client/locales.ts'
import {
  ReviewChat, ReviewChatView, ReviewConversation, useReviewConversation, type ReviewChatFace, type ReviewChatProps,
  type ReviewConversationProps,
} from '../src/client/review-page/ReviewChat.tsx'
import type { ForgeReviewConversationProps } from '../src/client/slots.ts'
import type { ForgeReviewChangeRequest } from '../src/types.ts'
import { snapshot } from './client-fixtures.client.ts'
import { prUrl, reviewed } from './review-fixtures.client.ts'

afterEach(cleanup)

const t = makeTranslate(en)
const S1 = brandString<SessionId>('s1')
const S2 = brandString<SessionId>('s2')
const S3 = brandString<SessionId>('s3')
type WorkspaceId = Parameters<WorkspaceSelectedHandler>[0]
const W1 = brandString<WorkspaceId>('w1')
const W2 = brandString<WorkspaceId>('w2')
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

/** The reference the chat face hands out for a retained Session, with the release the chat tab calls on it. */
interface Retained {
  readonly reference: SessionReference
  readonly release: ReturnType<typeof vi.fn<() => void>>
}

/** A chat face that records every call, connects to `S1`, and fills a draft at once. */
function chatFace() {
  const retained: Retained[] = []
  const chat = {
    connect: vi.fn<ReviewChatFace['connect']>(async () => S1),
    connectWorkspace: vi.fn<ReviewChatFace['connectWorkspace']>(async () => S2),
    workspaceFailed: vi.fn<ReviewChatFace['workspaceFailed']>(),
    retain: vi.fn<ReviewChatFace['retain']>((sessionId) => {
      // Only the identity the chat tab hands back to the face and the release it calls are supplied.
      const release = vi.fn<() => void>()
      const reference = { sessionId, release } as Pick<SessionReference, 'sessionId' | 'release'> as SessionReference
      retained.push({ reference, release })
      return reference
    }),
    stage: vi.fn<ReviewChatFace['stage']>(),
    fill: vi.fn<ReviewChatFace['fill']>(async () => {}),
    openInMain: vi.fn<ReviewChatFace['openInMain']>(),
    requestWorktree: vi.fn<ReviewChatFace['requestWorktree']>(),
  }
  return { chat, retained }
}

/** Props of the chat tab apart from the conversation, which {@link ChatTab} keeps. */
type ChatTabProps = Omit<ReviewChatProps, 'conversation'>

/** The chat tab with the conversation the review page keeps for its change request. */
function ChatTab(props: ChatTabProps): ReactNode {
  const conversation = useReviewConversation(props.frame, props.sessionId, props.onConversation, props.chat)
  return <ReviewChat {...props} conversation={conversation} />
}

/** Render the chat tab of #7 with a chat face that records every call and connects with `connect`, to `S1` by default. */
function renderChat(overrides: Partial<ChatTabProps> = {}, connect?: ReviewChatFace['connect']) {
  const { chat, retained } = chatFace()
  if (connect !== undefined) chat.connect.mockImplementation(connect)
  const onConversation = vi.fn<ChatTabProps['onConversation']>()
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
  const props: ChatTabProps = {
    frame: reviewed(7), sessionId: undefined, onConversation, chat, renderSlot, SessionProvider, t, ...overrides,
  }
  const view = render(<ChatTab {...props} />)
  const rerender = (next: Partial<ChatTabProps>): void => { view.rerender(<ChatTab {...props} {...next} />) }
  const slot = (): ForgeReviewConversationProps => {
    const owner = slots.at(-1)
    if (owner === undefined) throw new Error('no conversation drawn')
    return owner
  }
  return { view, props, chat, retained, slots, slot, provided, rerender, onConversation }
}

describe('ReviewChat start', () => {
  it('starts a conversation about the change request once, retains it, binds the change request, and quotes it in the draft', async () => {
    const b = renderChat()
    expect(b.chat.connect).toHaveBeenCalledWith(b.props.frame)
    expect(b.view.container.textContent).toBe('')
    await settle()
    expect(b.chat.connect).toHaveBeenCalledOnce()
    expect(b.chat.retain).toHaveBeenCalledOnce()
    expect(b.chat.retain).toHaveBeenCalledWith(S1)
    expect(b.chat.stage).toHaveBeenCalledWith(S1, URL7)
    expect(b.props.onConversation).toHaveBeenCalledWith(S1)
    expect(b.chat.fill).toHaveBeenCalledOnce()
    expect(b.chat.fill).toHaveBeenCalledWith(b.retained[0]?.reference, { kind: 'reference', frame: b.props.frame })

    // Once the page records the conversation, the tab shows it without retaining or quoting it again.
    b.rerender({ sessionId: S1 })
    expect(b.chat.retain).toHaveBeenCalledOnce()
    expect(b.chat.fill).toHaveBeenCalledOnce()
    expect(b.provided).toContain(b.retained[0]?.reference)
    expect(b.slot().headline).toBe('Review demo #7')
  })

  it.each([
    ['without any Workspace', async (): Promise<undefined> => { await Promise.resolve() }],
    ['when the Workspace does not open', async (): Promise<SessionId | undefined> => { throw new Error('connect failed') }],
  ] as const)('shows the conversation as unavailable %s, and does not try again', async (_label, connect) => {
    const b = renderChat({}, connect)
    await settle()
    expect(b.view.getByRole('status').textContent).toBe('Conversation unavailable')
    expect(b.props.onConversation).not.toHaveBeenCalled()
    expect(b.chat.retain).not.toHaveBeenCalled()
    b.rerender({ frame: reviewed(7, snapshot(7, { title: 'Renamed' })) })
    await settle()
    expect(b.chat.connect).toHaveBeenCalledOnce()
  })
})

describe('ReviewChat conversation', () => {
  it('retains the conversation, binds the change request to it, and fills the reference into its draft once', () => {
    const b = renderChat({ sessionId: S1 })
    expect(b.chat.connect).not.toHaveBeenCalled()
    expect(b.chat.retain).toHaveBeenCalledOnce()
    expect(b.chat.retain).toHaveBeenCalledWith(S1)
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

  it('shows the blank Session of a picked Workspace, moving the draft while both Sessions are retained', async () => {
    const b = renderChat({ sessionId: S1 })
    const held: boolean[] = []
    const adopt = vi.fn<WorkspaceSessionAdopter>(() => {
      held.push(b.retained[0]?.release.mock.calls.length === 0, b.retained[1]?.release.mock.calls.length === 0)
    })
    await act(async () => { await b.slot().onWorkspaceSelected(W1, adopt) })
    expect(b.chat.connectWorkspace).toHaveBeenCalledWith(W1)
    expect(b.chat.retain).toHaveBeenLastCalledWith(S2)
    expect(adopt).toHaveBeenCalledWith(S2)
    expect(held).toEqual([true, true])
    expect(b.retained[0]?.release).toHaveBeenCalledOnce()
    expect(b.retained[1]?.release).not.toHaveBeenCalled()
    expect(b.chat.stage).toHaveBeenLastCalledWith(S1, null)
    expect(b.props.onConversation).toHaveBeenCalledWith(S2)

    b.rerender({ sessionId: S2 })
    expect(b.chat.retain).toHaveBeenCalledTimes(2)
    expect(b.chat.stage).toHaveBeenLastCalledWith(S2, URL7)
    // The moved draft already names the change request.
    expect(b.chat.fill).toHaveBeenCalledOnce()
    b.view.unmount()
    expect(b.retained[1]?.release).toHaveBeenCalledOnce()
  })

  it('keeps the conversation when the picked Workspace resolves to it', async () => {
    const b = renderChat({ sessionId: S1 })
    b.chat.connectWorkspace.mockResolvedValueOnce(S1)
    const adopt = vi.fn<WorkspaceSessionAdopter>()
    await act(async () => { await b.slot().onWorkspaceSelected(W1, adopt) })
    expect(adopt).not.toHaveBeenCalled()
    expect(b.chat.retain).toHaveBeenCalledOnce()
    expect(b.props.onConversation).not.toHaveBeenCalled()
  })

  it('shows only the latest of two picks, whichever connects first', async () => {
    const b = renderChat({ sessionId: S1 })
    const first = Promise.withResolvers<SessionId>()
    const second = Promise.withResolvers<SessionId>()
    b.chat.connectWorkspace.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const adopt = vi.fn<WorkspaceSessionAdopter>()
    const select = b.slot().onWorkspaceSelected
    const picks = [select(W1, adopt), select(W2, adopt)]
    await act(async () => {
      second.resolve(S3)
      first.resolve(S2)
      await Promise.all(picks)
    })
    expect(adopt.mock.calls).toEqual([[S3]])
    expect(b.onConversation.mock.calls).toEqual([[S3]])
  })

  it('drops a pick that connects after the tab started another conversation or left', async () => {
    const b = renderChat({ sessionId: S1 })
    const pending = Promise.withResolvers<SessionId>()
    b.chat.connectWorkspace.mockReturnValueOnce(pending.promise)
    const adopt = vi.fn<WorkspaceSessionAdopter>()
    const select = b.slot().onWorkspaceSelected
    const pick = select(W1, adopt)
    b.rerender({ sessionId: S3 })
    await act(async () => {
      pending.resolve(S2)
      await pick
    })
    expect(adopt).not.toHaveBeenCalled()
    expect(b.props.onConversation).not.toHaveBeenCalled()

    b.view.unmount()
    await select(W2, adopt)
    expect(b.chat.connectWorkspace).toHaveBeenCalledOnce()
    expect(adopt).not.toHaveBeenCalled()
  })

  it('reports a Workspace that cannot connect once, for the latest pick only, and rejects both', async () => {
    const b = renderChat({ sessionId: S1 })
    const first = Promise.withResolvers<SessionId>()
    const second = Promise.withResolvers<SessionId>()
    b.chat.connectWorkspace.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const adopt = vi.fn<WorkspaceSessionAdopter>()
    const select = b.slot().onWorkspaceSelected
    const picks = [select(W1, adopt), select(W2, adopt)]
    const offline = new Error('offline')
    first.reject(new Error('gone'))
    second.reject(offline)
    await act(async () => {
      await expect(picks[0]).rejects.toThrow('gone')
      await expect(picks[1]).rejects.toThrow('offline')
    })
    expect(b.chat.workspaceFailed.mock.calls).toEqual([[offline]])
    expect(adopt).not.toHaveBeenCalled()
    expect(b.props.onConversation).not.toHaveBeenCalled()
  })

  it('keeps the conversation and releases the picked Session when the draft cannot move', async () => {
    const b = renderChat({ sessionId: S1 })
    const select: WorkspaceSelectedHandler = b.slot().onWorkspaceSelected
    await expect(select(W1, () => { throw new Error('no binding') })).rejects.toThrow('no binding')
    expect(b.retained[1]?.release).toHaveBeenCalledOnce()
    expect(b.retained[0]?.release).not.toHaveBeenCalled()
    expect(b.props.onConversation).not.toHaveBeenCalled()
  })
})

describe('useReviewConversation', () => {
  /** Keep the conversation of #7, or of a change request with no frame yet, through the hook alone. */
  function renderConversation(frame: ForgeReviewChangeRequest | undefined, sessionId: SessionId | undefined) {
    const face = chatFace()
    const onConversation = vi.fn<(sessionId: SessionId | null) => void>()
    const hook = renderHook(() => useReviewConversation(frame, sessionId, onConversation, face.chat))
    return { ...face, onConversation, hook }
  }

  it('starts and retains nothing before the change request\'s first frame', async () => {
    const b = renderConversation(undefined, S1)
    expect(await b.hook.result.current.start()).toBeUndefined()
    expect(b.chat.connect).not.toHaveBeenCalled()
    expect(b.chat.retain).not.toHaveBeenCalled()
    expect(b.hook.result.current.reference).toBeNull()
    b.hook.unmount()
  })

  it('connects once for quotes that arrive together, and hands the conversation out once its draft names the change request', async () => {
    const b = renderConversation(reviewed(7), undefined)
    const connected = deferred<SessionId | undefined>()
    const filled = deferred<undefined>()
    b.chat.connect.mockReturnValueOnce(connected.promise)
    b.chat.fill.mockReturnValueOnce(filled.promise)
    const started: (SessionReference | undefined)[] = []
    act(() => {
      void b.hook.result.current.start().then((value) => { started.push(value) })
      void b.hook.result.current.start().then((value) => { started.push(value) })
    })
    expect(b.chat.connect).toHaveBeenCalledOnce()
    connected.settle(S1)
    await settle()
    expect(b.chat.retain).toHaveBeenCalledOnce()
    expect(b.onConversation).toHaveBeenCalledWith(S1)
    expect(b.chat.fill).toHaveBeenCalledOnce()
    expect(started).toEqual([])
    filled.settle(undefined)
    await settle()
    expect(started).toEqual([b.retained[0]?.reference, b.retained[0]?.reference])
  })

  it('records but neither retains nor reports a conversation that connects after the page stopped showing it', async () => {
    const b = renderConversation(reviewed(7), undefined)
    const connected = deferred<SessionId | undefined>()
    b.chat.connect.mockReturnValueOnce(connected.promise)
    const started: (SessionReference | undefined)[] = []
    act(() => { void b.hook.result.current.start().then((value) => { started.push(value) }) })
    b.hook.unmount()
    connected.settle(S1)
    await settle()
    expect(started).toEqual([undefined])
    expect(b.chat.stage).toHaveBeenCalledOnce()
    expect(b.chat.stage).toHaveBeenCalledWith(S1, reviewed(7).url)
    expect(b.onConversation).toHaveBeenCalledWith(S1)
    expect(b.chat.retain).not.toHaveBeenCalled()
  })

  it('reports no failure for a connection that fails after the page stopped showing it', async () => {
    const b = renderConversation(reviewed(7), undefined)
    const connected = deferred<SessionId | undefined>()
    b.chat.connect.mockReturnValueOnce(connected.promise)
    let started: SessionReference | undefined | null = null
    act(() => { void b.hook.result.current.start().then((value) => { started = value }) })
    const failed = b.hook.result.current.failed
    b.hook.unmount()
    connected.settle(undefined)
    await settle()
    expect([failed, started]).toEqual([false, undefined])
    expect(b.onConversation).not.toHaveBeenCalled()
  })

  it('hands out the recorded conversation once the draft it is filling names the change request', async () => {
    const face = chatFace()
    const filled = deferred<undefined>()
    face.chat.fill.mockReturnValueOnce(filled.promise)
    const hook = renderHook(() => useReviewConversation(reviewed(7), S1, vi.fn(), face.chat))
    expect(face.chat.fill).toHaveBeenCalledOnce()
    const started: (SessionReference | undefined)[] = []
    void hook.result.current.start().then((value) => { started.push(value) })
    await settle()
    expect(started).toEqual([])
    filled.settle(undefined)
    await settle()
    expect(started).toEqual([face.retained[0]?.reference])
    expect(hook.result.current.reference).toBe(face.retained[0]?.reference)
    expect(face.chat.connect).not.toHaveBeenCalled()
    expect(face.chat.fill).toHaveBeenCalledOnce()
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
    const onWorkspaceSelected = vi.fn<WorkspaceSelectedHandler>()
    const props = {
      sessionId: S1, useSession: bindSnapshotSelector(session), useConversation: bindSnapshotSelector(conversation),
      useSessions: bindSnapshotSelector(sessions), renderFactorySlot, headline: 'Review demo #7', onWorkspaceSelected,
    }
    const view = render(<ReviewConversation {...props as ReviewConversationProps} />)
    return { view, factory, onWorkspaceSelected }
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
      variant: 'embedded', phase, hero, headline: 'Review demo #7', onWorkspaceSelected: b.onWorkspaceSelected,
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
