/** Header row of a program call: its description and sub-call count above the rows it discloses. */
import { useMemo, type ReactNode } from 'react'
import clsx from 'clsx'
import { DisclosureRow, IconHubOutlineRegular, TextShimmer } from '@deepseek-ai/dsh-client-ui-primitives/client'
import type { ToolCallBlock } from '@deepseek-ai/dsh-client-ui-chat/client'
import { localizeAutoReviewDenial } from '../models/auto-review-denial.ts'
import { toolRowModel } from '../models/tool-call-model.ts'
import { stateStatus, type ToolRowProps } from './ToolRow.tsx'
import rowCss from './ToolRow.module.css'
import css from './ProgramCallRow.module.css'

const PROGRAM_ICON = <IconHubOutlineRegular size={14} />

type ProgramCallRowProps = Pick<ToolRowProps, 't'> & {
  /** Wire name of the program tool. */
  readonly toolName: string
  readonly block: ToolCallBlock
  /** Whether this row shows its nested rows. */
  readonly expanded: boolean
  /** Opens or closes this row. */
  readonly onToggle: () => void
  /** The program source row and the sub-call rows, mounted only while this row is open. */
  readonly children: ReactNode
}

/**
 * Render the row that names a program call by its description and discloses its nested rows.
 * The count of dispatched sub-calls follows the description; a failed or interrupted call shows
 * that state there instead, and an Auto-denied call the denial. An Auto-denied call and a call
 * whose description has not arrived show the generic tool title. Preparation has no disclosure.
 * @param props - Program call stage, open state, and the nested rows.
 * @returns The header row with its nested rows while open.
 */
export function ProgramCallRow({ t, toolName, block, expanded, onToggle, children }: ProgramCallRowProps) {
  const model = useMemo(() => toolRowModel(toolName, block), [toolName, block])
  const { state } = model
  const denial = model.autoReviewDenial === null ? null : localizeAutoReviewDenial(model.autoReviewDenial, t)
  // A denied call shows no argument, which includes the description.
  const title = denial !== null || model.summary === '' ? t('tool.title.generic') : model.summary
  const subCallCount = block.subCalls.length
  let detail: string | null = null
  if (state === 'error') {
    detail = denial?.summary ?? t('row.failed')
  } else if (state === 'stopped') {
    detail = t('row.stopped')
  } else if (subCallCount > 0) {
    detail = subCallCount === 1 ? t('row.subCall') : t('row.subCalls', { count: subCallCount })
  }
  // The settled states are visible text; the others are animation only.
  const status = state === 'error' || state === 'stopped' ? null : stateStatus(state, t)
  const expandable = state !== 'preparing'
  return (
    <div className={css.root} data-program-call={toolName} data-state={state}>
      {status !== null && <span className={rowCss.visuallyHidden}>{status}</span>}
      <DisclosureRow
        titleClassName={css.description}
        icon={PROGRAM_ICON}
        title={title}
        running={state === 'running' || state === 'preparing'}
        open={expanded && expandable}
        expandable={expandable}
        expandOnRowClick
        keepContentWhenOpen
        onToggle={onToggle}
        collapsedContent={detail !== null && (
          <>
            <span className={rowCss.sep} data-shimmer-decoration aria-hidden />
            <TextShimmer className={clsx(css.detail, state === 'error' && rowCss.errorSummary, state === 'stopped' && rowCss.stoppedSummary)}>
              {detail}
            </TextShimmer>
          </>
        )}
      >
        {children}
      </DisclosureRow>
    </div>
  )
}
