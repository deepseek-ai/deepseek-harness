/** Assistant reasoning disclosure, independent of Tool-call presentation. */
import { memo, useMemo } from 'react'
import { DisclosureRow, IconThinkOutlineRegular, MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChatViewSlotProps, UseDisclosure, UsePresentation } from '../contract/slots.ts'
import { markdownLabels } from '../markdown-labels.ts'
import a11yCss from './accessibility.module.css'
import css from './ReasoningRow.module.css'

const THINK_ICON = <IconThinkOutlineRegular size={14} />

function firstLine(text: string): string {
  const newline = text.indexOf('\n')
  return newline === -1 ? text : text.slice(0, newline)
}

function latestCompletedParagraphFirstLine(text: string): string {
  let summary = ''
  let paragraphStart = 0
  const separator = /\r?\n(?:[\t ]*\r?\n)+/g
  while (true) {
    const nextParagraph = separator.exec(text)
    const paragraphEnd = nextParagraph === null ? text.length
      : nextParagraph.index + nextParagraph[0].indexOf('\n')
    const newline = text.indexOf('\n', paragraphStart)
    if (newline !== -1 && newline <= paragraphEnd) {
      const candidate = text.slice(paragraphStart, newline).trim()
      if (candidate !== '') summary = candidate
    }
    if (nextParagraph === null) return summary
    paragraphStart = nextParagraph.index + nextParagraph[0].length
  }
}

/**
 * Render one assistant reasoning block collapsed until the reader opens it. The
 * collapsed summary omits double-asterisk markers; expanded content renders
 * the complete Markdown with secondary typography. A streaming preview advances
 * when a paragraph's first line completes. Mode changes toggle CSS display without unmounting
 * collapsed summaries.
 * @param props.text - complete or streaming reasoning text.
 * @param props.running - whether this block is the streaming tail.
 * @param props.usePresentation - live display-policy selector for this reasoning row.
 * @param props.useDisclosure - independent open state with enclosing-Turn resets.
 * @param props.t - conversation locale seat for status and Markdown actions.
 * @returns the reasoning disclosure.
 */
export const ReasoningRow = memo(function ReasoningRow({ text, running, usePresentation, useDisclosure, t }: {
  text: string
  running: boolean
  useDisclosure: UseDisclosure
  usePresentation: UsePresentation
  t: ChatViewSlotProps['t']
}) {
  const { expanded, toggle } = useDisclosure()
  const labels = useMemo(() => markdownLabels(t), [t])
  const summaryText = running ? latestCompletedParagraphFirstLine(text) : firstLine(text)
  const summary = useMemo(() => summaryText.replaceAll('**', ''), [summaryText])
  const preview = usePresentation(policy => !expanded && summary !== ''
    && (running || policy.settledReasoningPreview))
  const collapsedContent = useMemo(() => (
    <>
      <span className={css.separator} aria-hidden />
      <span className={css.summary} data-streaming={running || undefined}>
        <span className={css.summaryText}>{summary}</span>
      </span>
    </>
  ), [running, summary])
  const content = useMemo(() => expanded ? (
    <div className={css.thinkBody}>
      <MarkdownText text={text} streaming={running} labels={labels} variant="compact" />
    </div>
  ) : undefined, [expanded, labels, running, text])

  return (
    <div
      className={css.root}
      data-variant="think"
      data-state={running ? 'running' : 'ok'}
      data-expanded={expanded || undefined}
      data-preview={preview || undefined}
    >
      {running && <span className={a11yCss.visuallyHidden}>{t('row.running')}</span>}
      <DisclosureRow
        rowClassName={css.row}
        leadingClassName={css.leading}
        titleClassName={css.title}
        chevronClassName={css.chevron}
        icon={THINK_ICON}
        title={t('message.think')}
        open={expanded}
        expandable
        expandOnRowClick
        onToggle={toggle}
        collapsedContent={collapsedContent}
      >
        {content}
      </DisclosureRow>
    </div>
  )
})
