/** Session approval for explicit system input, shared by capable CUA providers. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { UserQuestionError } from '@deepseek-ai/dsh-user-questions'
import { NativeError } from './native-client.ts'
import { applicationAccessDisplay } from './locales.ts'
import { systemInputControlPrompt } from './system-input-locales.ts'

/** Access is scoped to the live Session and never grants application access. */
export class SystemInputControl {
  private readonly decisions = new WeakMap<Agent, boolean | 'asking'>()

  constructor(private readonly ctx: Context, private readonly requireApproval: boolean) {}

  /**
   * Select the per-call route and any approval required before dispatch.
   * @param agent Agent owning the live Session.
   * @param requested Whether the caller explicitly requested system input.
   * @returns Native pointer mode and an optional preparation that must succeed before input.
   */
  resolve(agent: Agent, requested: boolean): { useSystemInput: boolean; prepare?: (signal: AbortSignal) => Promise<void> } {
    if (!requested) return { useSystemInput: false }
    if (agent.session.header.origin === 'subagent') {
      throw new NativeError('SYSTEM_INPUT_UNAVAILABLE', 'Delegated tasks cannot control the system keyboard or mouse. Use a window-directed action or report the required system input to the main task.')
    }
    if (!this.requireApproval || this.decisions.get(agent) === true) return { useSystemInput: true }
    return { useSystemInput: true, prepare: signal => this.approve(agent, signal) }
  }

  private async approve(agent: Agent, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    const decision = this.decisions.get(agent)
    if (decision === 'asking') throw new NativeError('SYSTEM_INPUT_PENDING', 'Wait for the outstanding system input request')
    let granted = decision
    if (granted === undefined) {
      const questions = this.ctx.get('userQuestions')
      if (!questions) throw new NativeError('SYSTEM_INPUT_APPROVAL_UNAVAILABLE', 'No human answerer is available for system input')
      const id = 'cua-system-input'
      const display = { ...systemInputControlPrompt, approve: applicationAccessDisplay.approve }
      const approve = display.approve.en
      const reject = 'Deny'
      this.decisions.set(agent, 'asking')
      try {
        const result = await questions.ask({ agent, signal, questions: [{
          id, question: display.question.en, detail: display.detail.en, options: [{ label: approve }, { label: reject }],
          intent: { kind: 'approval', approve, reject, display },
        }] })
        signal.throwIfAborted()
        const [answer] = result.answers
        granted = result.answers.length === 1 && answer?.id === id && !answer.custom?.trim()
          && answer.selected.length === 1 && answer.selected[0] === approve
        this.decisions.set(agent, granted)
      } catch (error) {
        this.decisions.delete(agent)
        if (error instanceof UserQuestionError && error.code === 'ASK_CANCELLED') {
          throw new NativeError('SYSTEM_INPUT_APPROVAL_CANCELLED', 'The system input request was dismissed. Continue without system input unless the user asks to reconsider', { cause: error })
        }
        throw error
      }
    }
    if (!granted) throw new NativeError('SYSTEM_INPUT_DENIED', 'The user declined system input for this session. No input was sent. Use non-system actions.')
  }
}
