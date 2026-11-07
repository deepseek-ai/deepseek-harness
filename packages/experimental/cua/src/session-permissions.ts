/** Provider-owned permissions remembered separately for each live Session and requested capability. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { UserQuestionError } from '@deepseek-ai/dsh-user-questions'
import { applicationAccessDisplay } from './locales.ts'

type Localized = { en: string; [locale: string]: string }

/** A provider owns the lifetime and names of the permissions it requests. */
export class CuaSessionPermissions {
  private readonly decisions = new WeakMap<Agent, Map<string, boolean | 'asking'>>()

  constructor(private readonly ctx: Context) {}

  /**
   * Read a permission without asking the user.
   * @param agent Live Session owner.
   * @param permission Provider-defined permission name.
   * @returns Whether the user approved this permission in this Session.
   */
  allowed(agent: Agent, permission: string): boolean {
    return this.decisions.get(agent)?.get(permission) === true
  }

  /**
   * Remember the user's choice only for this permission in this live Session.
   * @param agent Live Session owner.
   * @param permission Provider-defined permission name shared by calls requesting the same access.
   * @param prompt Localized question and scope displayed before the user decides.
   * @param signal Calling operation lifetime. Aborting or dismissing the question leaves the permission undecided.
   * @returns True only when the user selects session approval.
   */
  async request(agent: Agent, permission: string, prompt: { question: Localized; detail: Localized },
    signal: AbortSignal): Promise<boolean> {
    signal.throwIfAborted()
    const decisions = this.decisions.get(agent) ?? new Map<string, boolean | 'asking'>()
    const decision = decisions.get(permission)
    if (decision === 'asking') throw new UserQuestionError('Wait for the outstanding permission request', 'APPROVAL_PENDING')
    if (decision !== undefined) return decision
    const questions = this.ctx.get('userQuestions')
    if (!questions) throw new UserQuestionError('No human answerer is available for the permission request', 'NO_PROVIDER')
    this.decisions.set(agent, decisions)
    decisions.set(permission, 'asking')
    const id = `cua-session-permission:${permission}`
    const display = { ...prompt, approve: applicationAccessDisplay.approve }
    const approve = display.approve.en
    const reject = 'Deny'
    try {
      const result = await questions.ask({ agent, signal, questions: [{
        id, question: prompt.question.en, detail: prompt.detail.en, options: [{ label: approve }, { label: reject }],
        intent: { kind: 'approval', approve, reject, display },
      }] })
      signal.throwIfAborted()
      const [answer] = result.answers
      const granted = result.answers.length === 1 && answer?.id === id && !answer.custom?.trim()
        && answer.selected.length === 1 && answer.selected[0] === approve
      decisions.set(permission, granted)
      return granted
    } catch (error) {
      decisions.delete(permission)
      throw error
    }
  }
}
