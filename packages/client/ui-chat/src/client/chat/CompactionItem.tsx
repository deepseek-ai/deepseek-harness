// A compaction marker does not replace shadowed transcript rows. It is
// expandable only when the current window includes its cited summary.

import { memo, useMemo, useState } from 'react'
import {
  IconApiOutlineRegular,
  IconChevronDownOutlineRegular,
  IconChevronRightOutlineRegular,
  MarkdownText,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChatViewSlotProps } from '../contract/slots.ts'
import { markdownLabels } from '../markdown-labels.ts'
import type { CompactionSummaryNode } from '../contract/snapshot.ts'
import css from './MessageItem.module.css'

interface CompactionItemProps {
  node: CompactionSummaryNode
  /** Optional command title for a manual compaction folded into this marker. */
  title?: string
  /** Command settlement text used when structured compaction counts are unavailable. */
  fallbackSummary?: string | null
  /** The owning view's locale seat. */
  t: ChatViewSlotProps['t']
}

/**
 * Renders the model-history compaction marker.
 * @param props - the marker node off the snapshot cache.
 * @returns the marker row, with the summary disclosure when one is available.
 */
export const CompactionItem = memo(function CompactionItem({
  node,
  title,
  fallbackSummary,
  t,
}: CompactionItemProps) {
  const [expanded, setExpanded] = useState(false)
  const labels = useMemo(() => markdownLabels(t), [t])
  const expandable = node.summary !== null
  const open = expandable && expanded
  const summary = node.shadowedItemCount !== null && node.shadowedTokenCount !== null
    ? t('message.compaction.completed', {
      items: node.shadowedItemCount,
      tokens: node.shadowedTokenCount,
    })
    : fallbackSummary
      ?? (expandable ? t('message.compaction.expand') : t('message.compaction.unavailable'))
  return (
    <div className={css.compactionRow}>
      <button
        type="button"
        className={css.compactionButton}
        disabled={!expandable}
        aria-expanded={expandable ? open : undefined}
        onClick={() => { setExpanded(value => !value) }}
      >
        <span className={css.compactionLeading} aria-hidden>
          <span className={css.compactionContextIcon} data-compaction-icon="context">
            <IconApiOutlineRegular />
          </span>
          <span
            className={css.compactionDisclosureIcon}
            data-compaction-disclosure={open ? 'expanded' : 'collapsed'}
          >
            {open ? <IconChevronDownOutlineRegular /> : <IconChevronRightOutlineRegular />}
          </span>
        </span>
        <span className={css.compactionTitle}>{title ?? t('message.compaction')}</span>
        <span className={css.compactionSep} aria-hidden />
        <span className={css.compactionSummary}>{summary}</span>
      </button>
      {open && node.summary !== null
        && <div className={css.compactionBody}><MarkdownText text={node.summary} labels={labels} /></div>}
    </div>
  )
})
