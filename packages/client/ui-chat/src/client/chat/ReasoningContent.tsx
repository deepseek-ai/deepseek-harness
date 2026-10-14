/** Official reasoning content and its default Body Slot adapter. */
import { memo, useMemo } from 'react'
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import type { FactoryComponentPropsOf, PropsRenderFactories, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { markdownLabels } from '../markdown-labels.ts'

type ReasoningBodyProps = PropsRuntime<'conversation.chat.reasoning.body'> & PropsRenderFactories

/**
 * Render compact reasoning with caller-supplied labels or Chat's defaults.
 * @param props - display text, streaming state, optional localized labels, and the Factory's locale seat; no Session is required.
 * @returns the standard reasoning content; supplied labels are used without merging defaults.
 */
export const ReasoningContent = memo(function ReasoningContent({ text, running, labels, t }: FactoryComponentPropsOf<'conversation.chat.reasoning.content'>) {
  const resolvedLabels = useMemo(() => labels ?? markdownLabels(t), [labels, t])
  return <MarkdownText text={text} streaming={running} labels={resolvedLabels} variant="compact" />
})

/**
 * Render the default Body through the same Factory available to third-party wrappers.
 * @param props - original reasoning and the framework's Factory renderer.
 * @returns an occurrence of the official reasoning Content Factory.
 */
export function DefaultReasoningBody({ text, running, renderFactorySlot }: ReasoningBodyProps) {
  return renderFactorySlot('conversation.chat.reasoning.content', { text, running })
}
