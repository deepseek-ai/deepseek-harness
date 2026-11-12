/** Consent answerer for the connection's Agent: unattended approval or MCP elicitation. @module */
import type { Agent } from '@deepseek-ai/dsh-agent'
import { UserQuestionError, type AskUserQuestionAnswer, type AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions'
import type { ElicitResult } from '@modelcontextprotocol/server'

/** Who decides application and pointer consent for the connection's Agent. */
export type ConsentMode = 'allow' | 'elicit'

/** Every consent mode, in the order the configuration documents them. */
export const CONSENT_MODES: readonly ConsentMode[] = ['allow', 'elicit']

/** The MCP client side of an elicitation round trip. */
export interface ElicitationClient {
  /** Whether the connected client declared the `elicitation` capability. */
  supportsElicitation(): boolean
  /**
   * Ask the client to collect one decision from its user.
   * @param message - Question and detail for the user.
   * @param labels - Offered answers, in display order.
   * @param signal - Cancels the pending request.
   * @returns The client's action and its selected label.
   */
  elicit(message: string, labels: readonly string[], signal: AbortSignal | undefined): Promise<ElicitResult>
}

/** Option labels of one question, in display order. */
function labelsOf(question: AskUserQuestionItem): string[] {
  return (question.options ?? []).map(option => option.label)
}

/**
 * Answer one CUA approval question without a human: the label its intent approves.
 * @param questions - Questions of one request.
 * @returns The answer, or undefined when a question is not an approval decision.
 */
export function approveAll(questions: readonly AskUserQuestionItem[]): AskUserQuestionAnswer | undefined {
  const answers: AskUserQuestionAnswer['answers'] = []
  for (const question of questions) {
    if (question.intent?.kind !== 'approval') return undefined
    answers.push({ id: question.id, selected: [question.intent.approve] })
  }
  return { answers }
}

/**
 * Forward one question to the MCP client as a form elicitation and translate its outcome.
 * Decline selects the rejecting label of an approval question; cancel aborts the ask the way a dismissed
 * card does, so the provider records a denial for this Agent.
 * @param client - Connected MCP client.
 * @param question - The question to present.
 * @param signal - Cancels the pending request.
 * @returns The chosen label as a user-questions answer.
 * @throws UserQuestionError with code `ASK_CANCELLED` when the user cancels.
 * @throws Error when the client lacks elicitation or returns no offered label.
 */
export async function elicitAnswer(
  client: ElicitationClient, question: AskUserQuestionItem, signal: AbortSignal | undefined,
): Promise<AskUserQuestionAnswer['answers'][number]> {
  if (!client.supportsElicitation()) {
    throw new Error('The connected MCP client does not support elicitation, so nobody can grant this request; '
      + 'start the server with DSH_CUA_CONSENT=allow to grant application and pointer access without a human')
  }
  const labels = labelsOf(question)
  const message = question.detail === undefined ? question.question : `${question.question}\n\n${question.detail}`
  const result = await client.elicit(message, labels, signal)
  switch (result.action) {
    case 'accept': {
      const decision = result.content?.decision
      if (typeof decision !== 'string' || !labels.includes(decision)) {
        throw new Error(`The MCP client accepted the consent request without one of the offered answers: ${JSON.stringify(labels)}`)
      }
      return { id: question.id, selected: [decision] }
    }
    case 'decline':
      if (question.intent?.kind === 'approval') return { id: question.id, selected: [question.intent.reject] }
      throw new UserQuestionError('The MCP client declined the request', 'ASK_CANCELLED')
    case 'cancel':
      throw new UserQuestionError('The MCP client cancelled the request', 'ASK_CANCELLED')
    default:
      return assertNever(result.action)
  }
}

function assertNever(value: never): never {
  throw new Error(`unknown elicitation action ${String(value)}`)
}

/** A user-questions waterfall listener bound to one connection's Agent. */
export type ConsentAnswerer = (
  request: { questions: AskUserQuestionItem[]; agent?: Agent; signal?: AbortSignal },
  next: () => Promise<AskUserQuestionAnswer>,
) => Promise<AskUserQuestionAnswer>

/**
 * Build the answerer for one connection. Requests of other Agents and non-approval questions in `allow`
 * mode delegate to the next answerer.
 * @param mode - Configured consent mode.
 * @param owns - Whether a request's Agent is this connection's Agent.
 * @param client - Elicitation side of the connected MCP client.
 * @returns The waterfall listener.
 */
export function createConsentAnswerer(
  mode: ConsentMode, owns: (agent: Agent | undefined) => boolean, client: ElicitationClient,
): ConsentAnswerer {
  return async (request, next) => {
    if (!owns(request.agent)) return next()
    if (mode === 'allow') {
      const answer = approveAll(request.questions)
      return answer ?? next()
    }
    const answers: AskUserQuestionAnswer['answers'] = []
    for (const question of request.questions) answers.push(await elicitAnswer(client, question, request.signal))
    return { answers }
  }
}
