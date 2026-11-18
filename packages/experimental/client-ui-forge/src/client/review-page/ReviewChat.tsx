/**
 * The review page's chat tab: a conversation about one change request in a blank Session of a Workspace, shown with
 * the New Session hero until its first message and as a transcript afterwards. The page binds the change request to
 * the Session once its first message enters the inbox, and only a Session the page started for the change request
 * shows here, never an existing conversation.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ConversationViewsProps, WorkspaceSelectedHandler, WorkspaceSessionAdopter } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { PropsLocale, PropsRenderFactories, PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionReference } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ForgeReviewChangeRequest } from '../../types.ts'
import type { ForgePanelKey, NS } from '../locales.ts'
import type {} from '../slots.ts'
import css from './ReviewPage.module.css'

type Translate = PropsLocale<typeof NS>['t']

/**
 * A request to fill the draft: the change request reference while the draft is empty, or a suggested prompt that
 * replaces the draft and quotes the reference after it.
 */
export type ReviewDraft =
  | { readonly kind: 'reference'; readonly frame: ForgeReviewChangeRequest }
  | { readonly kind: 'prompt'; readonly frame: ForgeReviewChangeRequest; readonly text: string }

/** What the chat tab asks of the forge panel. */
export interface ReviewChatFace {
  /**
   * Resolve the blank Session a new conversation about the change request starts in: in the Workspace whose folder
   * name is the repository's name, else in the most recently updated Workspace.
   * @returns the Session, or undefined without any Workspace.
   */
  readonly connect: (frame: ForgeReviewChangeRequest) => Promise<SessionId | undefined>
  /** Resolve the blank Session of a Workspace the reader picked in the conversation; rejects when it cannot connect. */
  readonly connectWorkspace: (workspaceId: Parameters<WorkspaceSelectedHandler>[0]) => Promise<SessionId>
  /** Tell the reader that a picked Workspace could not be opened. */
  readonly workspaceFailed: (error: unknown) => void
  /** Retain a Session; the caller releases the returned reference. */
  readonly retain: (sessionId: SessionId) => SessionReference
  /** Bind the change request to the Session at its next message, or forget the choice for null. */
  readonly stage: (sessionId: SessionId, url: string | null) => void
  /** Fill the draft of a retained Session once it opens; settles once the draft is filled or the Session failed to open. */
  readonly fill: (reference: SessionReference, draft: ReviewDraft) => Promise<void>
  /** Show the Session in the main conversation view. */
  readonly openInMain: (sessionId: SessionId) => void
  /** Ask for a worktree for the Session before its first step. */
  readonly requestWorktree: (sessionId: SessionId) => void
}

const PROMPTS: readonly { readonly key: ForgePanelKey; readonly worktree: boolean }[] = [
  { key: 'reviewPage.chat.prompt.review', worktree: false },
  { key: 'reviewPage.chat.prompt.test', worktree: true },
  { key: 'reviewPage.chat.prompt.checks', worktree: false },
]

/** The Chat view only, which the embedded conversation shows. */
export function ReviewChatView(props: ConversationViewsProps): ReactNode {
  return <>{props.renderSlot('conversation.session', { view: 'chat' })}</>
}

/** Full props of the embedded conversation. */
export type ReviewConversationProps = PropsRuntime<'forge.review.conversation'> & PropsRenderFactories

/**
 * Render the shared conversation content for the Session the chat tab shows.
 * @param props - the Session, its conversation state, and the owner's headline and Workspace handler.
 * @returns the embedded conversation.
 */
export function ReviewConversation({
  sessionId, useSession, useConversation, useSessions, renderFactorySlot, headline, onWorkspaceSelected,
}: ReviewConversationProps): ReactNode {
  const session = useSession(value => value)
  const conversation = useConversation(value => value)
  const active = conversation.activeTargets.size > 0 || (!session.blank && !session.awaitingFirstTurn) || session.running
  const blankSummary = useSessions(state => state.byId[sessionId]?.blank)
  const settling = !active && !session.promptAttempted && session.openState === 'loading' && blankSummary !== true
  const hero = !active && !session.promptAttempted && (session.openState === 'open' || blankSummary === true)
  const phase = settling ? 'settling' : hero ? 'hero' : 'active'
  return (
    <div className={css.conversation} data-forge-review-conversation={sessionId}>
      {renderFactorySlot('conversation.content', { variant: 'embedded', phase, hero, headline, onWorkspaceSelected }, {
        slots: { views: ReviewChatView },
      })}
    </div>
  )
}

/** The conversation the review page keeps for the change request it shows, held while the page shows it. */
export interface ReviewConversation {
  /** Whether no conversation could start, because no Workspace exists or connecting failed. */
  readonly failed: boolean
  /** The retained conversation, or null before one. */
  readonly reference: SessionReference | null
  /**
   * Keep another Session as the conversation: retain it, move the draft of the one held before to it while both are
   * retained, then release the one held before.
   */
  readonly moveTo: (sessionId: SessionId, adopt: WorkspaceSessionAdopter) => void
  /** Record that a conversation's draft already names the change request. */
  readonly markFilled: (sessionId: SessionId) => void
  /**
   * Start the conversation when there is none, retain it, bind the change request at its next message, and quote the
   * change request in its draft.
   * @returns the opened conversation once its draft names the change request, or undefined when none could start.
   */
  readonly start: () => Promise<SessionReference | undefined>
}

/** The conversation the page retains; releasing its reference ends the page's hold. */
interface Held {
  readonly sessionId: SessionId
  readonly reference: SessionReference
}

/**
 * Keep the conversation of the shown change request: retain it while the page shows the change request, so its draft
 * takes quotes from any tab, and quote the change request in its draft once.
 * @param frame - the shown change request, or undefined before its first frame.
 * @param sessionId - the conversation recorded for the change request, or undefined before one.
 * @param onConversation - records the conversation of the change request, or forgets it for null.
 * @param chat - what the chat asks of the forge panel.
 * @returns the conversation state and its actions.
 */
export function useReviewConversation(
  frame: ForgeReviewChangeRequest | undefined, sessionId: SessionId | undefined, onConversation: (sessionId: SessionId | null) => void,
  chat: ReviewChatFace,
): ReviewConversation {
  const [failed, setFailed] = useState(false)
  const [reference, setReference] = useState<{ readonly sessionId: SessionId; readonly reference: SessionReference } | null>(null)
  const held = useRef<Held | null>(null)
  const filled = useRef(new Map<SessionId, Promise<void>>())
  const connecting = useRef<Promise<SessionId | undefined> | null>(null)
  const latest = useRef({ frame, onConversation })
  latest.current = { frame, onConversation }
  const hold = useCallback((id: SessionId): void => {
    if (held.current?.sessionId === id) return
    held.current?.reference.release()
    const retained = chat.retain(id)
    held.current = { sessionId: id, reference: retained }
    setReference({ sessionId: id, reference: retained })
  }, [chat])
  const moveTo = useCallback((id: SessionId, adopt: WorkspaceSessionAdopter): void => {
    const previous = held.current
    const retained = chat.retain(id)
    try {
      adopt(id)
    } catch (error: unknown) {
      retained.release()
      throw error
    }
    held.current = { sessionId: id, reference: retained }
    setReference({ sessionId: id, reference: retained })
    previous?.reference.release()
  }, [chat])
  // A conversation that connects after the page stopped showing the change request is recorded but not retained.
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      held.current?.reference.release()
      held.current = null
    }
  }, [])
  const fillOnce = useCallback(async (retained: SessionReference, shown: ForgeReviewChangeRequest): Promise<void> => {
    let filling = filled.current.get(retained.sessionId)
    if (filling === undefined) {
      filling = chat.fill(retained, { kind: 'reference', frame: shown })
      filled.current.set(retained.sessionId, filling)
    }
    await filling
  }, [chat])
  const markFilled = useCallback((id: SessionId) => { filled.current.set(id, Promise.resolve()) }, [])
  const url = frame?.url
  useEffect(() => {
    if (sessionId === undefined || url === undefined) return
    hold(sessionId)
    chat.stage(sessionId, url)
  }, [sessionId, url, chat, hold])
  useEffect(() => {
    if (frame === undefined || reference === null || reference.sessionId !== sessionId) return
    void fillOnce(reference.reference, frame)
  }, [frame, reference, sessionId, fillOnce])
  const start = useCallback(async (): Promise<SessionReference | undefined> => {
    const shown = latest.current.frame
    if (shown === undefined) return undefined
    let id = sessionId
    if (id === undefined) {
      // Quotes that start the conversation together share one connection, retention, binding, and record.
      connecting.current ??= chat.connect(shown).catch(() => undefined).then((connected) => {
        connecting.current = null
        if (connected === undefined) {
          if (alive.current) setFailed(true)
          return undefined
        }
        chat.stage(connected, shown.url)
        latest.current.onConversation(connected)
        if (alive.current) hold(connected)
        return connected
      })
      id = await connecting.current
      if (id === undefined || !alive.current) return undefined
    }
    hold(id)
    const retained = held.current?.reference
    /* v8 ignore next -- defensive: hold(id) above has just set held.current. */
    if (retained === undefined) return undefined
    await fillOnce(retained, shown)
    return retained
  }, [sessionId, chat, hold, fillOnce])
  return {
    failed,
    reference: reference !== null && reference.sessionId === sessionId ? reference.reference : null,
    moveTo,
    markFilled,
    start,
  }
}

/** Props of the chat tab. */
export interface ReviewChatProps extends Pick<PropsRenderSlots<'forge.review.conversation'>, 'renderSlot' | 'SessionProvider'> {
  /** The change request. */
  readonly frame: ForgeReviewChangeRequest
  /** The conversation the page started for the change request, or undefined before one. */
  readonly sessionId: SessionId | undefined
  /** The conversation the page keeps for the change request. */
  readonly conversation: ReviewConversation
  /** Record the conversation of the change request, or forget it for null. */
  readonly onConversation: (sessionId: SessionId | null) => void
  /** What the tab asks of the forge panel. */
  readonly chat: ReviewChatFace
  /** Forge panel copy. */
  readonly t: Translate
}

/**
 * Render the chat tab: start the conversation on first show, then embed it with the suggested prompts above it.
 * @param props - the change request, its conversation, and the forge panel's chat actions.
 * @returns the tab body.
 */
export function ReviewChat({
  frame, sessionId, conversation, onConversation, chat, renderSlot, SessionProvider, t,
}: ReviewChatProps): ReactNode {
  const { failed, reference, start } = conversation
  useEffect(() => {
    if (sessionId === undefined && !failed) void start()
  }, [sessionId, failed, start])
  // A picked Workspace becomes the conversation only as the latest pick, while the tab still shows the conversation
  // the pick started from.
  const picks = useRef(0)
  const shown = useRef<SessionId | undefined>(sessionId)
  shown.current = sessionId
  useEffect(() => () => { shown.current = undefined }, [])
  const selectWorkspace = useCallback<WorkspaceSelectedHandler>(async (workspaceId, adopt) => {
    const started = shown.current
    if (started === undefined) return
    picks.current += 1
    const pick = picks.current
    const wanted = (): boolean => shown.current === started && picks.current === pick
    let next: SessionId
    try {
      next = await chat.connectWorkspace(workspaceId)
    } catch (error: unknown) {
      if (wanted()) chat.workspaceFailed(error)
      throw error
    }
    // No await from here on, so nothing interleaves with the switch.
    if (!wanted() || next === started) return
    conversation.moveTo(next, adopt)
    // The moved draft already names the change request.
    conversation.markFilled(next)
    chat.stage(started, null)
    onConversation(next)
  }, [chat, conversation, onConversation])
  if (failed) {
    return <div className={css.centered} role="status"><p className={css.emptyTitle}>{t('reviewPage.chat.unavailable')}</p></div>
  }
  if (sessionId === undefined || reference === null) return <div className={css.centered} />
  const name = t('change.number', { number: frame.ref.number })
  const repository = frame.ref.repository
  return (
    <div className={css.chat}>
      <div className={css.chatBar}>
        <span className={css.chatPrompts}>
          {PROMPTS.map(prompt => (
            <Button key={prompt.key} size="sm" variant="outline" onClick={() => {
              if (prompt.worktree) chat.requestWorktree(sessionId)
              void chat.fill(reference, { kind: 'prompt', frame, text: t(prompt.key) })
            }}>{t(prompt.key)}</Button>
          ))}
        </span>
        <span className={css.chatActions}>
          <Button size="sm" variant="ghost" onClick={() => {
            chat.stage(sessionId, null)
            onConversation(null)
          }}>{t('reviewPage.chat.new')}</Button>
          <Button size="sm" variant="ghost" onClick={() => { chat.openInMain(sessionId) }}>{t('reviewPage.chat.openMain')}</Button>
        </span>
      </div>
      <SessionProvider session={reference}>
        {renderSlot('forge.review.conversation', {
          headline: t('reviewPage.chat.headline', { name: `${repository.name} ${name}` }),
          onWorkspaceSelected: selectWorkspace,
        })}
      </SessionProvider>
    </div>
  )
}
