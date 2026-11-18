/** Plan controls and cards opening caller-supplied Markdown in the shared preview. */
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
// Type-only: pulls the ui-conversation SlotMap merge (the input.plan seat).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the `plan` SessionProjectionMap merge for useProjection.
import type {} from '@deepseek-ai/dsh-plan-mode/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/remote'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-client-ui-user-questions/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-client-resources/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { extractMarkdownPlainText } from '@deepseek-ai/dsh-client-ui-primitives'
import { PlanCards, PlanReviewOpen, type PlanCardsInjected, type PlanOpenInjected, type PlanReviewOpenInjected } from './PlanCard.tsx'
import { planDefinition } from './plan-definition.ts'
import { planTitle } from './plan.ts'
import { createPlanReviewStore } from './review-store.ts'
import { PlanChip } from './PlanModeControl.tsx'
import { en, ja, es, fr, de, ru, pt, zh, type PlanKey } from './locales.ts'

export type { PlanKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The composer plan chip's copy. */
    plan: PlanKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'plan'

/** Injected business face of the composer plan seat. */
export interface PlanChipInjected {
  /**
   * Leave plan mode by executing /plan off.
   * @returns null on admitted execution; a user-visible failure line otherwise.
   */
  exitPlanMode: () => Promise<string | null>
}

/**
 * Services for plan controls, Conversation projection, and resource
 * navigation. `contentPreviews` is optional and bound separately.
 */
export const inject = ['slots', 'remote', 'remote.commands', 'sessions', 'locale', 'uiConversation', 'sidebarRight']

/**
 * Register plan controls and cards, enabling openers while content previews are available.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en, ja, es, fr, de, ru, pt }), 'ui-plan: dictionaries')

  const previewId = '@deepseek-ai/dsh-client-ui-plan'
  ctx.effect(() => ctx.uiConversation.events.register(planDefinition), 'ui-plan: conversation definition')
  // The optional content previews: the service while it is present, and its availability for the openers.
  let previews: ClientContext['contentPreviews'] | undefined
  const previewAvailable = createSnapshotStore(false)
  ctx.inject(['contentPreviews'], (scope) => {
    const service = scope.contentPreviews
    scope.effect(() => {
      previews = service
      previewAvailable.set(true)
      return () => {
        previews = undefined
        previewAvailable.set(false)
      }
    }, 'ui-plan: content preview availability')
  })
  const open = (sessionId: SessionId): PlanOpenInjected => ({
    openPlan: (plan) => {
      previews?.open({ mediaType: 'text/markdown', text: plan.markdown }, {
        title: plan.title, key: `plan:${sessionId}:${plan.callId}`,
      })
    },
  })
  const reviewStore = createPlanReviewStore()
  ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({
    name: 'conversation.chat.turnTail', id: previewId, locale: NS,
    inject: (sessionId: SessionId): PlanCardsInjected => {
      const binding = ctx.sessions.binding(sessionId)
      if (binding === undefined) throw new Error(`ui-plan: unknown session "${sessionId}"`)
      const chat = ctx.uiConversation.binding(binding).target('chat')
      return {
        ...open(sessionId),
        hooks: { previewAvailable },
        keyedHooks: {
          plans: (turn) => {
            const snapshot = chat.getSnapshot()
            if (snapshot === undefined) throw new Error('ui-plan: Chat target is unavailable')
            return snapshot.nodes.turnDataSource(Number(turn), 'submitted-plan')
          },
        },
      }
    },
  }, PlanCards))
  ctx.slots.inject('conversation.plan-review.actions', () => ctx.slots.register({
    name: 'conversation.plan-review.actions', id: previewId, locale: NS, store: reviewStore,
    inject: (sessionId: SessionId): PlanReviewOpenInjected => ({
      openReview: (review, requestKey) => {
        if (previews === undefined) return
        // Reviews and logged plans share the same invocation key when one is available.
        previews.open(
          { mediaType: 'text/markdown', text: review.plan },
          { title: planTitle(review.plan) ?? extractMarkdownPlainText(review.plan, { mode: 'first-line' }), key: review.callId === undefined ? `review:${sessionId}:${requestKey}` : `plan:${sessionId}:${review.callId}` },
        )
      },
      hooks: { sidebarMounted: ctx.sidebarRight.mounted, previewAvailable },
    }),
  }, PlanReviewOpen))

  ctx.slots.inject('conversation.input.plan', () => ctx.slots.register({
    name: 'conversation.input.plan',
    locale: NS,
    inject: (sessionId: SessionId): PlanChipInjected => ({
      // Failure strings stay English (error-surface policy: not localized).
      exitPlanMode: async () => {
        const result = await ctx.remote.commands.execute(sessionId, '/plan off', [])
        if (!result.ok) return `${result.error.message} (${result.error.code})`
        if (result.value === undefined) return 'unknown command: /plan off'
        return null
      },
    }),
  }, PlanChip))
}
