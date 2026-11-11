/**
 * The review page's chat tab: a conversation about one change request in a blank Session of a Workspace, shown with
 * the New Session hero until its first message and as a transcript afterwards. The page binds the change request to
 * the Session once its first message enters the inbox, and only a Session the page started for the change request
 * shows here, never an existing conversation.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ConversationViewsProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { PropsLocale, PropsRenderFactories, PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionReference } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ForgeReviewChangeRequest } from '../types.ts'
import type { ForgePanelKey, NS } from './locales.ts'
import type {} from './slots.ts'
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
  /** Retain a Session while `signal` lasts. */
  readonly retain: (sessionId: SessionId, signal: AbortSignal) => SessionReference
  /** Bind the change request to the Session at its next message, or forget the choice for null. */
  readonly stage: (sessionId: SessionId, url: string | null) => void
  /** Fill the draft of a retained Session once it opens. */
  readonly fill: (reference: SessionReference, draft: ReviewDraft) => void
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
  sessionId, useSession, useConversation, useSessions, renderFactorySlot, headline, onWorkspaceSession,
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
      {renderFactorySlot('conversation.content', { variant: 'embedded', phase, hero, headline, onWorkspaceSession }, {
        slots: { views: ReviewChatView },
      })}
    </div>
  )
}

/** Props of the chat tab. */
export interface ReviewChatProps extends Pick<PropsRenderSlots<'forge.review.conversation'>, 'renderSlot' | 'SessionProvider'> {
  /** The change request. */
  readonly frame: ForgeReviewChangeRequest
  /** The conversation the page started for the change request, or undefined before one. */
  readonly sessionId: SessionId | undefined
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
export function ReviewChat({ frame, sessionId, onConversation, chat, renderSlot, SessionProvider, t }: ReviewChatProps): ReactNode {
  const [failed, setFailed] = useState(false)
  const [reference, setReference] = useState<{ readonly sessionId: SessionId; readonly reference: SessionReference } | null>(null)
  const held = useRef<{ readonly sessionId: SessionId; readonly controller: AbortController } | null>(null)
  // Retains synchronously: a Workspace the reader picks moves the draft to its blank as soon as the handler returns.
  const hold = useCallback((id: SessionId): void => {
    if (held.current?.sessionId === id) return
    held.current?.controller.abort()
    const controller = new AbortController()
    held.current = { sessionId: id, controller }
    setReference({ sessionId: id, reference: chat.retain(id, controller.signal) })
  }, [chat])
  useEffect(() => () => {
    held.current?.controller.abort()
    held.current = null
  }, [])
  useEffect(() => {
    if (sessionId !== undefined) return
    let cancelled = false
    void chat.connect(frame).then((connected) => {
      if (cancelled) return
      if (connected === undefined) { setFailed(true); return }
      onConversation(connected)
    }, () => { if (!cancelled) setFailed(true) })
    return () => { cancelled = true }
  }, [sessionId, frame, chat, onConversation])
  const url = frame.url
  const [filled, setFilled] = useState<SessionId | null>(null)
  useEffect(() => {
    if (sessionId === undefined) return
    hold(sessionId)
    chat.stage(sessionId, url)
  }, [sessionId, url, chat, hold])
  // The reference goes in once per conversation; later frames of the same change request do not refill it.
  useEffect(() => {
    if (sessionId === undefined || filled === sessionId || reference?.sessionId !== sessionId) return
    setFilled(sessionId)
    chat.fill(reference.reference, { kind: 'reference', frame })
  }, [sessionId, filled, reference, frame, chat])
  if (failed) {
    return <div className={css.centered} role="status"><p className={css.emptyTitle}>{t('reviewPage.chat.unavailable')}</p></div>
  }
  if (sessionId === undefined || reference?.sessionId !== sessionId) return <div className={css.centered} />
  const name = t('change.number', { number: frame.ref.number })
  const repository = frame.ref.repository
  return (
    <div className={css.chat}>
      <div className={css.chatBar}>
        <span className={css.chatPrompts}>
          {PROMPTS.map(prompt => (
            <Button key={prompt.key} size="sm" variant="outline" onClick={() => {
              if (prompt.worktree) chat.requestWorktree(sessionId)
              chat.fill(reference.reference, { kind: 'prompt', frame, text: t(prompt.key) })
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
      <SessionProvider session={reference.reference}>
        {renderSlot('forge.review.conversation', {
          headline: t('reviewPage.chat.headline', { name: `${repository.name} ${name}` }),
          onWorkspaceSession: (next) => {
            if (next === sessionId) return
            hold(next)
            // The moved draft already names the change request.
            setFilled(next)
            chat.stage(sessionId, null)
            onConversation(next)
          },
        })}
      </SessionProvider>
    </div>
  )
}
