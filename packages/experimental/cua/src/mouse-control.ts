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

  /** @param agent Calling Agent. @returns Whether this Session explicitly approved moving the system pointer. */
  allowed(agent: Agent): boolean {
    return this.decisions.get(agent.id) === true
  }

  /**
   * Ask once for the Session. Simultaneous requests cannot open additional questions.
   * @param agent Live Agent that owns the Session.
   * @param signal Tool lifetime. An aborted tool cannot grant permission.
   * @returns True only when the user chose the offered approval.
   */
  async request(agent: Agent, signal: AbortSignal): Promise<boolean> {
    const decision = this.decisions.get(agent.id)
    if (decision === 'asking') throw new NativeError('MOUSE_CONTROL_PENDING', 'A mouse control request is already awaiting an answer in this session')
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
      if (error instanceof UserQuestionError && error.code === 'ASK_CANCELLED') {
        this.decisions.set(agent.id, false)
        return false
      }
      this.decisions.delete(agent.id)
      throw error
    }
  }
}
