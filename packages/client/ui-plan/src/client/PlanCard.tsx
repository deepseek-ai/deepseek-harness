/** Persistent transcript cards and pending-review sidebar navigation. */
import { useEffect } from 'react'
import { FileTypeIcon, IconChevronRightOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { SubmittedPlan } from './plan.ts'
import type {} from './plan-definition.ts'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-client-ui-user-questions/client'
import type { createPlanReviewStore } from './review-store.ts'
import css from './PlanCard.module.css'

/** Session-bound navigation for logged plans. */
export interface PlanOpenInjected {
  /** Open or focus the exact submitted plan; does nothing while content previews are unavailable. */
  openPlan: (plan: SubmittedPlan) => void
}

/** Turn-keyed submitted plans and Session-bound navigation. */
export interface PlanCardsInjected extends PlanOpenInjected {
  readonly hooks: {
    /** Whether content previews are loaded, so a plan address has a tab type to open it. */
    readonly previewAvailable: HostObservable<boolean>
  }
  keyedHooks: {
    /** Resolve only this Turn's submitted plans, in invocation order. */
    plans: (turn: string) => ObservableSnapshot<readonly SubmittedPlan[]>
  }
}

/** Session-bound preview navigation for one pending review. */
export interface PlanReviewOpenInjected {
  /**
   * Open the logged plan, or the request's temporary document when no
   * invocation exists; does nothing while content previews are unavailable.
   */
  openReview: (review: PropsRuntime<'conversation.plan-review.actions'>['review'], requestKey: string) => void
  readonly hooks: {
    /** The Session on screen, whose right Sidebar the opens land in; `undefined` while none is. */
    readonly sidebarMounted: HostObservable<SessionId | undefined>
    /** Whether content previews are loaded, so either kind of plan has a tab type to open it. */
    readonly previewAvailable: HostObservable<boolean>
  }
}

/**
 * Render the completed Turn's submitted plans in invocation order; the cards
 * are disabled while content previews are unavailable.
 * @param props - Logged plan, preview availability, localized copy, and Session-bound navigation.
 * @returns keyboard-accessible plan cards, or null for a Turn without plans.
 */
export function PlanCards({ turn, usePlans, usePreviewAvailable, openPlan, t }: PropsRuntime<'conversation.chat.turnTail'> & InjectFace<PlanCardsInjected> & PropsLocale<'plan'>) {
  const plans = usePlans(String(turn.turn))
  const available = usePreviewAvailable(value => value)
  if (plans === undefined || plans.length === 0) return null
  return (
    <div className={css.cards} data-plan-artifacts>
      {plans.map(plan => <button key={plan.callId} type="button" className={css.card} data-plan-card={plan.callId}
        aria-label={t('preview.openNamed', { title: plan.title })} disabled={!available}
        title={available ? undefined : t('preview.unavailable')}
        onClick={() => { openPlan(plan) }}>
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
 * The automatic open waits for content previews and a Session on screen; the
 * manual opener is disabled while content previews are unavailable.
 * `ctx.sidebarRight` names the Session before the commit that brings its
 * Conversation back renders, so a review that arrived while the Conversation
 * was off screen opens from the effect of the commit that mounts it.
 * @param props - Review identity, Session store, localized copy, and navigation.
 * @returns an opener for either logged or temporary plan text.
 */
export function PlanReviewOpen({ review, requestKey, openReview, useSidebarMounted, usePreviewAvailable, t, useStore, actions }: PropsRuntime<'conversation.plan-review.actions'> & InjectFace<PlanReviewOpenInjected> & PropsLocale<'plan'> & PropsStore<ReturnType<typeof createPlanReviewStore>>) {
  const identity = review.callId === undefined ? `review:${requestKey}` : `call:${review.callId}`
  const opened = useStore(state => state.opened[identity] === true)
  const mounted = useSidebarMounted(session => session !== undefined)
  const available = usePreviewAvailable(value => value)
  useEffect(() => {
    if (opened || !mounted || !available) return
    openReview(review, requestKey)
    actions.markOpened(identity)
  }, [identity, opened, mounted, available, openReview, review, requestKey, actions])
  return <button type="button" className={css.reviewLink} disabled={!available}
    title={available ? t('preview.open') : t('preview.unavailable')} aria-label={t('preview.open')}
    onClick={() => { openReview(review, requestKey) }}>{t('preview.full')}<IconChevronRightOutlineRegular size={14} /></button>
}
