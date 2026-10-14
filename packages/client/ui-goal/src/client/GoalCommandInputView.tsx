import { memo } from 'react'
import type { PropsLocale, PropsRenderFactories, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { GOAL_COMMAND, type GoalCommandInputData } from './goal-command-input.ts'
import css from './GoalCommandInputView.module.css'

const GOAL_COMMANDS = [{ start: 0, end: GOAL_COMMAND.length + 1, name: GOAL_COMMAND }] as const

type GoalCommandInputViewProps =
  PropsRuntime<'conversation.chat.node', 'command-input'>
  & PropsLocale<'goal'>
  & PropsRenderFactories

/**
 * Right-aligned `/goal` input bubble without ordinary message actions. The
 * echoed line decorates its leading `/goal` token as a command chip — the run
 * this Node projects is the fact that that token was a command — and keeps
 * the objective, `/goal` mentions included, as plain text.
 */
export const GoalCommandInputView = memo(function GoalCommandInputView({
  node, t, renderFactorySlot,
}: GoalCommandInputViewProps) {
  const data: GoalCommandInputData = node.data
  return (
    <div
      className={css.row}
      data-command-input=""
      role="group"
      aria-label={t('commandInput.aria')}
    >
      <div className={css.stack}>
        <div className={css.bubble}>
          {renderFactorySlot('conversation.user.text', {
            text: data.text,
            facts: { commands: GOAL_COMMANDS },
            interactive: false,
          })}
        </div>
      </div>
    </div>
  )
})
