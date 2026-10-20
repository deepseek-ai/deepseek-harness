/** Native SDK adapter for the shared user-questions seam. */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { UserQuestionError, type AskUserQuestionRequest } from '@deepseek-ai/dsh-user-questions'
import type { JsonRpcTransportPeer, SdkUserQuestionAnswer, SdkUserQuestionRequest } from '@deepseek-ai/dsh-sdk-protocol'

/** Owns question forwarding and cancellation for one SDK transport. */
export class SdkUserQuestionBridge {
  /** Enabled only after the host advertises an answerer at initialization. */
  enabled = false
  private readonly questionShutdown = new AbortController()
  private readonly unregister: () => void

  constructor(
    private readonly ctx: Context,
    private readonly transport: JsonRpcTransportPeer,
    ownsAgent: (agent: Agent) => boolean,
  ) {
    this.unregister = ctx.on('user-questions/request', async (request, next) => {
      const agent = request.agent
      if (!this.enabled || agent === undefined || !ownsAgent(agent)) return next()
      return this.ask(request, String(agent.session.id))
    })
  }

  /** Stop admission and cancel outstanding questions before SDK Agents drain. */
  close(): void {
    this.enabled = false
    this.unregister()
    this.questionShutdown.abort(new UserQuestionError('SDK server is shutting down', 'ASK_ABORTED'))
  }

  private async ask(request: AskUserQuestionRequest, sessionId: string): Promise<SdkUserQuestionAnswer> {
    const params: SdkUserQuestionRequest = { requestId: randomUUID(), sessionId, questions: request.questions }
    const signal = request.signal === undefined ? this.questionShutdown.signal
      : AbortSignal.any([request.signal, this.questionShutdown.signal])
    signal.throwIfAborted()
    const cancelled = (): void => {
      try {
        this.transport.notify('user-question.cancelled', { requestId: params.requestId, sessionId })
      } catch (error) {
        this.ctx.logger.warn(`SDK question cancellation could not reach the host: ${String(error)}`)
      }
    }
    signal.addEventListener('abort', cancelled, { once: true })
    try {
      const result = await this.transport.request('user-question/ask', params, signal)
      return parseHostAnswer(result, request.questions.map(question => question.id))
    } catch (error) {
      if (error instanceof UserQuestionError) throw error
      throw new UserQuestionError(signal.aborted ? 'SDK user question was cancelled' : 'SDK host could not answer the user question',
        signal.aborted ? 'ASK_ABORTED' : 'PROVIDER_ERROR', { cause: error })
    } finally {
      signal.removeEventListener('abort', cancelled)
    }
  }
}

/** Validate the untrusted host response before it enters a tool result or approval decision. */
function parseHostAnswer(value: unknown, questionIds: readonly string[]): SdkUserQuestionAnswer {
  const badAnswer = (): never => { throw new UserQuestionError('SDK host must answer each question id exactly once with selected labels and optional custom text', 'BAD_ANSWER') }
  if (value === null || typeof value !== 'object' || !('answers' in value) || !Array.isArray(value.answers)) return badAnswer()
  const answers = value.answers.map((answer: unknown) => {
    if (answer === null || typeof answer !== 'object' || !('id' in answer) || typeof answer.id !== 'string'
      || !('selected' in answer) || !Array.isArray(answer.selected) || !answer.selected.every((label: unknown) => typeof label === 'string')
      || ('custom' in answer && typeof answer.custom !== 'string')) return badAnswer()
    return { id: answer.id, selected: answer.selected,
      ...'custom' in answer ? { custom: answer.custom as string } : {} }
  })
  const ids = new Set(answers.map(answer => answer.id))
  if (ids.size !== answers.length || answers.length !== questionIds.length || !questionIds.every(id => ids.has(id))) return badAnswer()
  return { answers }
}
