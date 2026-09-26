/** Persistent transcript cards and pending-review sidebar navigation. */
import { useEffect } from 'react'
import { FileTypeIcon, IconChevronRightOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { SubmittedPlan } from './plan.ts'
import type {} from './plan-definition.ts'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-client-ui-user-questions/client'
import type { createPlanReviewStore } from './review-store.ts'
import css from './PlanPreview.module.css'

/** Session-bound navigation for logged plans. */
export interface PlanOpenInjected {
  /** Open or focus the exact submitted plan. */
  openPlan: (callId: ToolCallId) => void
}

/** Turn-keyed submitted plans and Session-bound navigation. */
export interface PlanCardsInjected extends PlanOpenInjected {
  keyedHooks: {
    /** Resolve only this Turn's submitted plans, in invocation order. */
    plans: (turn: string) => ObservableSnapshot<readonly SubmittedPlan[]>
  }
}

/** Session-bound preview navigation for one pending review. */
export interface PlanReviewOpenInjected {
  /** Open the logged plan, or the request's temporary document when no invocation exists. */
  openReview: (review: PropsRuntime<'conversation.plan-review.actions'>['review'], requestKey: string) => void
  readonly hooks: {
    /** The session whose right Sidebar seat is mounted; `undefined` while none is on screen. */
    readonly sidebarMounted: HostObservable<SessionId | undefined>
  }
}

/**
 * Render the completed Turn's submitted plans in invocation order.
 * @param props - Logged plan, localized copy, and Session-bound navigation.
 * @returns keyboard-accessible plan cards, or null for a Turn without plans.
 */
export function PlanCards({ turn, usePlans, openPlan, t }: PropsRuntime<'conversation.chat.turnTail'> & InjectFace<PlanCardsInjected> & PropsLocale<'plan'>) {
  const plans = usePlans(String(turn.turn))
  if (plans === undefined || plans.length === 0) return null
  return (
    <div className={css.cards} data-plan-artifacts>
      {plans.map(plan => <button key={plan.callId} type="button" className={css.card} data-plan-card={plan.callId}
        aria-label={t('preview.openNamed', { title: plan.title })}
        onClick={() => { openPlan(plan.callId) }}>
        <span className={css.cardIcon}><FileTypeIcon kind="markdown" size={20} /></span>
        <span className={css.cardDetails}>
          <span className={css.cardTitle}>{plan.title}</span>
          <span className={css.cardDescription}>{t('preview.document')}</span>
        </span>
        <span className={css.cardOpen}>{t('preview.action')}</span>
      </button>)}
    </div>
  )
}

/**
 * Open each pending plan automatically and retain a manual opener without answering it.
 *
 * The automatic open waits for a mounted Sidebar seat: a review that arrives
 * while the Conversation is off screen mounts in the same commit as the seat,
 * ahead of it, and the seat binds from its own effect. Reading the bound
 * session through the hook opens once that binding exists.
 * @param props - Review identity, Session store, localized copy, and navigation.
 * @returns an opener for either logged or temporary plan text.
 */
export function PlanReviewOpen({ review, requestKey, openReview, useSidebarMounted, t, useStore, actions }: PropsRuntime<'conversation.plan-review.actions'> & InjectFace<PlanReviewOpenInjected> & PropsLocale<'plan'> & PropsStore<ReturnType<typeof createPlanReviewStore>>) {
  const identity = review.callId === undefined ? `review:${requestKey}` : `call:${review.callId}`
  const opened = useStore(state => state.opened[identity] === true)
  const mounted = useSidebarMounted(session => session !== undefined)
  useEffect(() => {
    if (opened || !mounted) return
    openReview(review, requestKey)
    actions.markOpened(identity)
  }, [identity, opened, mounted, openReview, review, requestKey, actions])
  return <button type="button" className={css.reviewLink} title={t('preview.open')} aria-label={t('preview.open')}
    onClick={() => { openReview(review, requestKey) }}>{t('preview.full')}<IconChevronRightOutlineRegular size={14} /></button>
}
