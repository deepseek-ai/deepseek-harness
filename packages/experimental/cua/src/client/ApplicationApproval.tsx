/** Computer Use presentation over the existing pending-question answer channel. */
import type { PropsRenderFactories, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ComposerChainProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-user-questions/client'
import type {} from '@deepseek-ai/dsh-client-ui-approval/client'

/**
 * Select only the provider's fixed application question; other interactions keep their renderer.
 * @param pending The session's currently elected interaction.
 * @returns Its application decision, or null for another interaction.
 */
export function selectApplicationApproval(pending: ComposerChainProps['pendingInteraction']) {
  if (pending?.kind !== 'question' || pending.questions.length !== 1) return null
  const item = pending.questions[0] as (typeof pending.questions)[number]
  if (item.id !== 'cua-app-access' || item.intent?.kind !== 'approval') return null
  return { pending, item, intent: item.intent }
}

/** Composer bindings for an application decision and caller-owned localized copy. */
export type ApplicationApprovalProps = PropsRuntime<'conversation.composer'> & PropsRenderFactories & {
  matched: NonNullable<ReturnType<typeof selectApplicationApproval>>
  resolveText: (text: { en: string; [locale: string]: string }) => string
}

/**
 * Render the shared approval card without creating another request or answer lifetime.
 * @param props The existing pending question and renderer bindings.
 * @returns Fixed actions with the provider's original answer labels.
 */
export function ApplicationApproval({ matched: { pending, item, intent }, resolveText, renderFactorySlot }: ApplicationApprovalProps) {
  const always = intent.always
  const answer = (label: string) => pending.answer({ answers: [{ id: item.id, selected: [label] }] })
  return renderFactorySlot('conversation.approval.card', {
    requestKey: pending.key,
    title: intent.display === undefined ? item.question : resolveText(intent.display.question),
    ...(item.detail === undefined ? {} : {
      description: intent.display?.detail === undefined ? item.detail : resolveText(intent.display.detail),
    }),
    ...(intent.subject === undefined ? {} : { subject: intent.subject }),
    allowLabel: intent.display?.approve === undefined ? intent.approve : resolveText(intent.display.approve),
    canAnswer: () => pending.snapshot().channel !== 'none' && !pending.snapshot().closed,
    onAllow: () => answer(intent.approve),
    onReject: () => answer(intent.reject),
    ...(always === undefined ? {} : { onAlways: () => answer(always) }),
  })
}
