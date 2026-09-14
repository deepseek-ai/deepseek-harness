// Legacy standalone trajectory cell retained for direct consumers and specs.

import {
  formatElapsedSeconds,
  type TrajectoryCellKind,
  type TrajectoryCellProps,
} from './trajectory-record.ts'
import type { TrajectoryKey, TrajectoryTranslate } from './locales.ts'
import css from './TrajectoryCell.module.css'

export { formatElapsedSeconds }
export type {
  AssistantMetricDetail,
  TrajectoryCellKind,
  TrajectoryCellProps,
} from './trajectory-record.ts'

/** Display label per kind (matches the design tags). */
const KIND_LABEL_KEY: Record<TrajectoryCellKind, TrajectoryKey> = {
  system: 'kind.system',
  user: 'kind.user',
  context: 'kind.context',
  compacted: 'kind.compacted',
  message: 'kind.message',
  tool: 'kind.tool',
  subtool: 'kind.sub',
}

const TAG_CLASS: Record<TrajectoryCellKind, string | undefined> = {
  system: css.tagSystem,
  user: css.tagUser,
  context: css.tagContext,
  compacted: css.tagSystem,
  message: css.tagMessage,
  tool: css.tagTool,
  subtool: css.tagSubtool,
}

/**
 * Render one trajectory step cell.
 * @param props - index, kind, text, time, and optional Message metrics.
 * @returns the cell element.
 */
export function TrajectoryCell({
  t,
  index,
  kind,
  text,
  inputDetail: _inputDetail,
  promptDetail: _promptDetail,
  previousPromptDetail: _previousPromptDetail,
  outputDetail: _outputDetail,
  thinkingDetail: _thinkingDetail,
  sourceBlocks: _sourceBlocks,
  outputBlocks: _outputBlocks,
  schemaDetail: _schemaDetail,
  assistantMetrics: _assistantMetrics,
  result: _result,
  callId: _callId,
  toolName: _toolName,
  isError: _isError,
  timeSeconds,
  startedAt: _startedAt,
  input,
  output,
  think,
  selected = false,
  className,
  ...rest
}: TrajectoryCellProps & { t: TrajectoryTranslate }) {
  const rootClass = [
    css.root,
    selected ? css.selected : undefined,
    className,
  ].filter((c): c is string => c !== undefined).join(' ')
  const showMetrics = kind === 'message'
  return (
    <div className={rootClass} data-kind={kind} data-selected={selected || undefined} {...rest}>
      <span className={css.index}>#{index}</span>
      <span className={css.tagSlot}>
        <span className={[css.tag, TAG_CLASS[kind]].filter((c): c is string => c !== undefined).join(' ')}>{t(KIND_LABEL_KEY[kind])}</span>
      </span>
      <span className={css.text}>{text}</span>
      <span className={css.trailing}>
        {showMetrics ? (
          <>
            <span className={css.metric}>{input ?? ''}</span>
            <span className={css.metric}>{output ?? ''}</span>
            <span className={css.metric}>{think ?? ''}</span>
          </>
        ) : null}
        <span className={css.time}>{formatElapsedSeconds(timeSeconds, t)}</span>
      </span>
    </div>
  )
}
