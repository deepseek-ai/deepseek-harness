import { memo } from 'react'
import { projectUserText } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { GOAL_COMMAND, type GoalCommandInputData } from './goal-command-input.ts'
import css from './GoalCommandInputView.module.css'

type GoalCommandInputViewProps =
  PropsRuntime<'conversation.chat.node', 'command-input'>
  & PropsLocale<'goal'>

/**
 * Right-aligned `/goal` input bubble without ordinary message actions. The
 * echoed line decorates its leading `/goal` token as a command chip — the run
 * this Node projects is the fact that that token was a command — and keeps
 * the objective, `/goal` mentions included, as plain text.
 */
export const GoalCommandInputView = memo(function GoalCommandInputView({
  node, t,
}: GoalCommandInputViewProps) {
  const data: GoalCommandInputData = node.data
  // Only the leading token is the executed command; the rest of the line is
  // the objective, where a further `/goal` is prose.
  const split = data.text.search(/\s/u)
  const head = split === -1 ? data.text : data.text.slice(0, split)
  const rest = split === -1 ? '' : data.text.slice(split)
  return (
    <div
      className={css.row}
      data-command-input=""
      role="group"
      aria-label={t('commandInput.aria')}
    >
      <div className={css.stack}>
        <div className={css.bubble}>
          {projectUserText(head, [], [GOAL_COMMAND], 'command')}
          {rest !== '' && projectUserText(rest, [])}
        </div>
      </div>
    </div>
  )
})
