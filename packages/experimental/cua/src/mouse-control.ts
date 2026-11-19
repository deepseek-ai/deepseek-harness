/** Session approval for explicit system mouse input, shared by capable CUA providers. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { UserQuestionError } from '@deepseek-ai/dsh-user-questions'
import { NativeError, type NativeClient } from './native-client.ts'
import { applicationAccessDisplay } from './locales.ts'
import { mouseControlPrompt } from './mouse-control-locales.ts'

/** Access is scoped to the live Session and never grants application access. */
export class MouseControl {
  private readonly decisions = new WeakMap<Agent, boolean | 'asking'>()

  private readonly pressed = new WeakMap<Agent['session'], NativeClient>()

  constructor(private readonly ctx: Context, private readonly requireApproval: boolean) {
    ctx.on('session/event', (session, event) => {
      if (event.type !== 'turn/end') return
      const client = this.pressed.get(session)
      this.pressed.delete(session)
      if (client && !client.disposed) {
        void client.requestCleanup('releaseSystemButton', {}).catch((error: unknown) => {
          ctx.logger.warn('Could not release system mouse input at turn end: %s', error)
        })
      }
    })
  }

  /**
   * Arm turn-end cleanup before posting; cancellation can hide an already dispatched press.
   * @param agent Owner of the current turn.
   * @param client Connection that owns and can release the native button.
   */
  trackPress(agent: Agent, client: NativeClient): void {
    this.pressed.set(agent.session, client)
  }

  /**
   * Select the per-call route and any approval required before dispatch.
   * @param agent Agent owning the live Session.
   * @param requested Whether the caller explicitly requested system mouse input.
   * @returns Native pointer mode and an optional preparation that must succeed before input.
   */
  resolve(agent: Agent, requested: boolean): { useSystemPointer: boolean; prepare?: (signal: AbortSignal) => Promise<void> } {
    if (!requested) return { useSystemPointer: false }
    if (agent.session.header.origin === 'subagent') {
      throw new NativeError('MOUSE_CONTROL_UNAVAILABLE', 'Delegated tasks cannot control the system mouse. Use a window-directed action or report the required system-pointer gesture to the main task.')
    }
    if (!this.requireApproval || this.decisions.get(agent) === true) return { useSystemPointer: true }
    return { useSystemPointer: true, prepare: signal => this.approve(agent, signal) }
  }

  private async approve(agent: Agent, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    const decision = this.decisions.get(agent)
    if (decision === 'asking') throw new NativeError('MOUSE_CONTROL_PENDING', 'Wait for the outstanding mouse control request')
    let granted = decision
    if (granted === undefined) {
      const questions = this.ctx.get('userQuestions')
      if (!questions) throw new NativeError('MOUSE_APPROVAL_UNAVAILABLE', 'No human answerer is available for mouse control')
      const id = 'cua-mouse-control'
      const display = { ...mouseControlPrompt, approve: applicationAccessDisplay.approve }
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
          throw new NativeError('MOUSE_APPROVAL_CANCELLED', 'The mouse control request was dismissed. Continue without mouse control unless the user asks to reconsider', { cause: error })
        }
        throw error
      }
    }
    if (!granted) throw new NativeError('MOUSE_CONTROL_DENIED', 'The user declined system mouse control for this session. No input was sent. Use pointer-free actions.')
  }
}
