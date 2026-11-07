/** Human decisions about the system pointer live in the provider process, keyed by Session. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { UserQuestionError } from '@deepseek-ai/dsh-user-questions'
import { mouseControlDisplay } from './locales.ts'
import { NativeError } from './native-client.ts'

/** Mouse control applies only to mouseMove and never grants access to an application. */
export class MouseControl {
  private readonly decisions = new Map<Agent['id'], boolean | 'asking'>()

  constructor(private readonly ctx: Context) {}

  /**
   * Select the native route without prompting the user.
   * @param agent Calling Agent.
   * @returns Whether this Session explicitly approved moving the system pointer.
   */
  allowed(agent: Agent): boolean {
    return this.decisions.get(agent.id) === true
  }

  /**
   * Ask the main task for a Session decision. Simultaneous requests cannot open additional questions.
   * @param agent Live Agent that owns the Session.
   * @param signal Tool lifetime. An aborted tool cannot grant permission.
   * @returns True only when the user chose the offered approval.
   */
  async request(agent: Agent, signal: AbortSignal): Promise<boolean> {
    if (agent.session.header.origin === 'subagent') {
      throw new NativeError('MOUSE_CONTROL_UNAVAILABLE', "Delegated tasks cannot move the user's pointer. Use AX hover, click, or performAction. If the task requires a physical hover, report that step in your final result for the main task.")
    }
    const decision = this.decisions.get(agent.id)
    if (decision === 'asking') throw new NativeError('MOUSE_CONTROL_PENDING', 'Wait for the pending mouse control request in this session before continuing')
    if (decision !== undefined) return decision
    const questions = this.ctx.get('userQuestions')
    if (!questions) throw new NativeError('MOUSE_APPROVAL_UNAVAILABLE', 'No human answerer is available for mouse control')
    this.decisions.set(agent.id, 'asking')
    const id = 'cua-mouse-control'
    const approve = mouseControlDisplay.approve.en
    const reject = 'Deny'
    try {
      const result = await questions.ask({ agent, signal, questions: [{
        id, question: mouseControlDisplay.question.en, detail: mouseControlDisplay.detail.en,
        options: [{ label: approve }, { label: reject }],
        intent: { kind: 'approval', approve, reject, display: mouseControlDisplay },
      }] })
      signal.throwIfAborted()
      const [answer] = result.answers
      const granted = result.answers.length === 1 && answer?.id === id && !answer.custom?.trim()
        && answer.selected.length === 1 && answer.selected[0] === approve
      this.decisions.set(agent.id, granted)
      return granted
    } catch (error) {
      this.decisions.delete(agent.id)
      if (error instanceof UserQuestionError && error.code === 'ASK_CANCELLED') {
        throw new NativeError('MOUSE_APPROVAL_CANCELLED', 'The mouse control request was dismissed. Continue without mouse control unless the user asks to reconsider', { cause: error })
      }
      throw error
    }
  }
}
