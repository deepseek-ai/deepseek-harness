/** Question-owned summary action and transcript disclosure. */
import { DisclosureRow, IconInspectOutlineRegular, IconQuestionOutlineRegular, TextShimmer } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ToolRowProps } from './ToolRow.tsx'
import { formatToolBody } from '../models/tool-call-model.ts'
import { AskQuestionCard } from './AskQuestionCard.tsx'
import css from './ToolRow.module.css'
import questionCss from './QuestionToolRow.module.css'

type QuestionToolRowProps = Pick<ToolRowProps,
  'useDisclosure' | 't' | 'summary' | 'bodyRaw' | 'output' | 'askQuestion' | 'state' | 'inspect'> & {
    readonly openPanel: () => boolean
    readonly panelLabel: string
  }

/**
 * Render a question with its answer-panel entry point.
 * @param props - Question transcript, panel action, and disclosure state.
 * @returns The question's summary and optional expanded record.
 */
export function QuestionToolRow({
  useDisclosure, t, summary, bodyRaw, output, askQuestion, state, inspect, openPanel, panelLabel,
}: QuestionToolRowProps) {
  const { expanded, toggle } = useDisclosure()
  const expandable = bodyRaw != null || output != null || askQuestion != null
  const open = expanded && expandable
  return (
    <div className={css.root} data-variant="others" data-tool="ask_user_question" data-state={state}>
      {state === 'running' && <span className={css.visuallyHidden}>{t('row.running')}</span>}
      <DisclosureRow
        rowClassName={css.row} leadingClassName={css.leading} titleClassName={css.title}
        chevronClassName={css.chevron} icon={<IconQuestionOutlineRegular />} title={t('ask.rowTitle')}
        running={state === 'running'} open={open} expandable={expandable}
        keepContentWhenOpen onToggle={toggle}
        collapsedContent={<>
          {summary !== '' && <>
            <span className={css.sep} aria-hidden />
            <span className={css.summary}><TextShimmer active={state === 'running'}>{summary}</TextShimmer></span>
          </>}
          <button type="button" className={questionCss.panelButton}
            onClick={(event) => { event.stopPropagation(); if (!openPanel()) toggle() }}
            onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') event.stopPropagation() }}>
            <IconQuestionOutlineRegular />{panelLabel}
          </button>
        </>}
      >
        {open && <div className={css.bodyWrap}>
          {askQuestion != null ? <AskQuestionCard card={askQuestion} /> : <div className={css.ioCard}>
            {bodyRaw != null && <div className={css.ioSection}>
              <span className={css.ioLabel}>{t('row.input')}</span>
              <span className={css.ioText}>{formatToolBody('others', bodyRaw)}</span>
            </div>}
            {bodyRaw != null && output != null && <span className={css.ioDivider} aria-hidden />}
            {output != null && <div className={css.ioSection}>
              <span className={css.ioLabel}>{t('row.output')}</span><span className={css.ioText}>{output}</span>
            </div>}
          </div>}
          {inspect !== undefined && <button type="button" className={css.inspectButton} onClick={inspect}>
            <IconInspectOutlineRegular />{t('row.inspect')}
          </button>}
        </div>}
      </DisclosureRow>
    </div>
  )
}
