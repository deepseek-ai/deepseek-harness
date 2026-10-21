/** Literal display for text-derived quote nodes. */
import { QuotePreview } from '@deepseek-ai/dsh-client-ui-primitives'
import type { UserTextNodeProps } from '@deepseek-ai/dsh-client-ui-conversation/client'

/**
 * Display decoded quote text without further interpretation.
 * @param props - the quote node produced by the registered blockquote matcher.
 * @returns the shared literal excerpt and clipped full-text popover.
 */
export function QuotedUserText({ node }: UserTextNodeProps<'quote'>) {
  return <QuotePreview text={node.data.text} />
}
