/** Maps ordinary message occurrences to Desktop product events. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-product-analytics/client'
import type { MessageSubmission } from '../contract/composer-submission.ts'

/**
 * Report the original message occurrence without reading newer Session facts.
 * @param ctx - client context.
 * @param submission - original occurrence and Session snapshot.
 */
export function reportMessageSubmission(ctx: Context, submission: MessageSubmission): void {
  const { state, timestamp, mode } = submission
  if (state === undefined) return
  const model = state.model
  ctx.get('productAnalytics')?.track('send_button_click', {
    ...state.sessionId === undefined ? {} : { session_id: state.sessionId },
    ...model === undefined ? {} : { model_name: `${model.provider}/${model.name}`, ...model.effort === undefined ? {} : { thinking_effort: model.effort } },
    run_mode: state.runMode,
    msg_type: state.running ? mode : 'default',
  }, timestamp)
}
