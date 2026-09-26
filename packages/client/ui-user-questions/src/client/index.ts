/**
 * Web question plugin, browser half: QuestionComposer registered as a
 * selector-routed entry of the conversation-declared composer chain, plus the
 * `question` dictionaries. The selector narrows the owner's currency to the
 * question carrier (matched prop), and the whole behavior surface rides the
 * carrier (domain encoding in contract/slots.ts PendingQuestion); copy rides
 * the standard locale seat. Export discipline: packages/client/AGENTS.md.
 *
 * One entry, two shapes: the composer renders a request that declares a
 * presentation intent as that intent's own surface (`plan-review` → the plan
 * decision card) and every other request as the generic question flow. A
 * separate chain entry per shape would race the same carrier, so the shape
 * choice lives inside this entry — see QuestionComposer.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ComposerChainProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { PendingInteractionPublisher } from '@deepseek-ai/dsh-client-ui-session/client'
import type { TypertClientEventListener } from '@deepseek-ai/dsh-typert-protocol'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import { PendingQuestion } from './contract/slots.ts'
import { createQuestionDraftStore } from './draft-store.ts'
import { QuestionComposer } from './QuestionComposer.tsx'
import { en, zh, type QuestionKey } from './locales.ts'

export type {
  PendingQuestion, PlanReview, QuestionAnswer, QuestionComposerProps, QuestionWait,
} from './contract/slots.ts'
export type { QuestionKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The question composer's copy. */
    question: QuestionKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'question'

type QuestionListener = TypertClientEventListener<'user-questions/request'>
type ClientQuestionRequest = Parameters<QuestionListener>[0]
type ClientQuestionNext = Parameters<QuestionListener>[1]
type ClientQuestionAnswer = Awaited<ReturnType<QuestionListener>>

/** Required services: Agent scopes, Remote Events, Session UI, Slot registry, and copy. */
export const inject = ['sessions', 'remote', 'uiSession', 'slots', 'locale']

/** Present one request until the user answers, cancels, or its lifetime ends. */
async function answerQuestion(
  ctx: ClientContext,
  owner: ClientContext,
  request: ClientQuestionRequest,
  next: ClientQuestionNext,
  registerPendingInteraction: PendingInteractionPublisher<PendingQuestion>,
): Promise<ClientQuestionAnswer> {
  const sessionId = (ctx.sessions as ISessions).scopeOf(owner)
  if (sessionId === undefined) return next()
  const pending = new PendingQuestion(sessionId, request.questions, request.signal)
  const completed = Promise.withResolvers<void>()
  const remove = registerPendingInteraction(pending, async () => {
    pending.delegate()
    await completed.promise
  })
  try {
    try {
      return await pending.result
    } catch (error) {
      if (pending.isDelegation(error)) return await next()
      throw error
    }
  } finally {
    remove()
    completed.resolve()
  }
}

/**
 * Client plugin body: register the `question` dictionaries and the question
 * composer into the composer chain. Zero business face — data and verbs live
 * on the matched carrier; t rides the standard locale seat.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-user-questions: dictionaries')
  const questionDraftStore = createQuestionDraftStore()
  const registerPendingInteraction = ctx.uiSession.registerPendingInteraction<PendingQuestion>(
    pending => pending.kind === 'plan-review' ? 2 : 1,
  )
  ctx.slots.inject('conversation.composer', () => ctx.slots.register(
    {
      name: 'conversation.composer',
      select: ({ pendingInteraction }: ComposerChainProps): PendingQuestion | null =>
        pendingInteraction instanceof PendingQuestion ? pendingInteraction : null,
      locale: NS,
      store: questionDraftStore,
      children: { 'conversation.plan-review.actions': { kind: 'list', scope: 'session' } },
    },
    QuestionComposer,
  ))
  ctx.remote.$on('user-questions/request', function (request, next) {
    return answerQuestion(ctx, this, request, next, registerPendingInteraction)
  })
}
