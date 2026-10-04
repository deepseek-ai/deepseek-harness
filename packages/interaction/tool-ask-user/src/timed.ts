/**
 * Opt-in timed `ask_user_question` tool definition.
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ToolExecution } from '@deepseek-ai/dsh-tools'
import { TIMED_WAIT_PARAMETER } from '@deepseek-ai/dsh-user-questions'
import type {
  AskUserQuestionAnswer, AskUserQuestionRequestEvent,
} from '@deepseek-ai/dsh-user-questions/types'

function validateTimeout(timeout: number): number {
  if (timeout !== -1 && (!Number.isInteger(timeout) || timeout < 1 || timeout > 2_147_483)) {
    throw new Error('timeout must be -1 or a positive integer up to 2147483 seconds')
  }
  return timeout
}

function validateQuestionIds(questions: readonly { readonly id: string }[]): void {
  const ids = new Set<string>()
  for (const question of questions) {
    if (ids.has(question.id)) throw new Error(`question id ${JSON.stringify(question.id)} must be unique within this call`)
    ids.add(question.id)
  }
}

const description = 'Ask brief, direct, self-contained questions about missing information, preferences, or decisions. '
  + 'Use user-facing terms; assume no knowledge of background work or internal names. '
  + 'Use distinct stable question IDs. A submitted skipped question is an answer item with empty selected and no custom; '
  + 'pending instead means no answer batch arrived before the timeout and the user can still answer.'

/**
 * Instruction the pending result carries in its `message` field. It is a field
 * of the result value rather than prose beside it because the recorded result
 * text is read back as one JSON object: the `userQuestions` projection decides
 * from it that the call stays answerable, and the Client question row decides
 * from it that the recorded result is the timeout, not an answer batch.
 */
const pendingNotice = 'No answer batch arrived before the timeout. This is pending, not a skipped answer. '
  + 'Continue useful independent work. The user can still answer; their reply will be a user message '
  + 'identified as answer_to_pending_question with this callId and the original questions. '
  + 'Do not treat this as permission.'

interface ToolQuestion {
  readonly id: string
  readonly question: string
  readonly header?: string
  readonly options?: { readonly label: string; readonly description?: string }[]
  readonly multi_select?: boolean
}

interface ToolAnswerResult {
  readonly answers: {
    readonly id: string
    readonly selected: string[]
    readonly custom?: string
  }[]
}

/**
 * Translate the model schema into the service request without changing ownership.
 * @param questions - Model-supplied questions in tool-schema form.
 * @param exec - Execution context that owns the agent and cancellation signal.
 * @returns The corresponding user-question service request.
 */
function questionRequest(
  questions: readonly ToolQuestion[],
  exec: Pick<ToolExecution, 'agent' | 'signal'>,
): AskUserQuestionRequestEvent {
  return {
    questions: questions.map(question => ({
      id: question.id,
      question: question.question,
      ...question.header !== undefined ? { header: question.header } : {},
      ...question.options !== undefined ? { options: question.options.map(option => ({ ...option })) } : {},
      ...question.multi_select !== undefined ? { multiSelect: question.multi_select } : {},
    })),
    ...exec.agent !== undefined ? { agent: exec.agent } : {},
    signal: exec.signal,
  }
}

/**
 * Copy service-owned answer arrays into the model-facing result.
 * @param result - Answer returned by the user-question service.
 * @returns A detached model-facing answer payload.
 */
function answerResult(result: AskUserQuestionAnswer): ToolAnswerResult {
  return {
    answers: result.answers.map(answer => ({
      id: answer.id,
      selected: [...answer.selected],
      ...answer.custom !== undefined ? { custom: answer.custom } : {},
    })),
  }
}

/**
 * Register the opt-in timed tool definition.
 * @param ctx - Agent-scoped context receiving the tool.
 * @param timeout - Default foreground wait in seconds.
 */
export function registerTimedAskUser(ctx: Context, timeout = 120): void {
  const defaultTimeout = validateTimeout(timeout)
  /* jscpd:ignore-start -- The timed schema intentionally shares question fields with the legacy tool. */
  ctx.tools.register(defineTool({
    name: 'ask_user_question',
    description,
    parameters: {
      questions: {
        type: 'array',
        required: true,
        description: 'Questions to ask the user.',
        items: {
          type: 'object',
          additionalProperties: true,
          properties: {
            id: { type: 'string', required: true, description: 'Stable id for this question; echoed in the answer.' },
            question: { type: 'string', required: true, description: 'The specific question to ask the user.' },
            header: {
              type: 'string',
              description: 'Optional short heading for the question, such as "Confirm" or "Choose Mode".',
            },
            options: {
              type: 'array',
              description: 'Optional choices to show the user. If you recommend one, put it first and append "(Recommended)" to that label.',
              items: {
                type: 'object',
                additionalProperties: true,
                properties: {
                  label: { type: 'string', required: true, description: 'Short user-facing option label.' },
                  description: { type: 'string', description: 'One sentence explaining the tradeoff or impact.' },
                },
              },
            },
            multi_select: {
              type: 'boolean',
              description: 'Whether the user may select more than one option. Defaults to false.',
            },
          },
        },
      },
      // The `userQuestions` projection reads this parameter's presence out of
      // the logged request header to tell a timed call from a legacy one.
      [TIMED_WAIT_PARAMETER]: {
        type: 'integer',
        description: `Wait seconds for the entire batch (default ${defaultTimeout}); omit unless the user specifies a duration. Use -1 only when an answer is required before proceeding.`,
      },
    },
    output: {
      schema: {
        oneOf: [
          {
            type: 'object', additionalProperties: false,
            properties: {
              pending: {
                type: 'boolean', enum: [true], required: true,
                description: 'True when the foreground wait expired before the user submitted an answer batch. The questions remain answerable; this is not a skipped answer.',
              },
              callId: { type: 'string', required: true, description: 'Tool call whose unanswered questions remain pending.' },
              message: {
                type: 'string', required: true,
                description: 'How to continue while the questions stay answerable.',
              },
            },
          },
          {
            type: 'object', additionalProperties: false,
            properties: {
              answers: {
                type: 'array', required: true,
                description: 'Submitted answer batch with one item per question. A skipped question has empty selected and no custom; unlike pending, the user has completed the batch.',
                items: {
                  type: 'object', additionalProperties: false,
                  properties: {
                    id: { type: 'string', required: true, description: 'Stable question id echoed from the request.' },
                    selected: {
                      type: 'array', required: true, items: { type: 'string' },
                      description: 'Selected option labels. Empty with no custom means the user explicitly skipped this question.',
                    },
                    custom: { type: 'string', description: 'Optional free-form answer; omitted for a skipped question.' },
                  },
                },
              },
            },
          },
        ],
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      const timeout = validateTimeout(args.timeout ?? defaultTimeout)
      validateQuestionIds(args.questions)
      const request = questionRequest(args.questions, exec)
      if (timeout !== -1) {
        if (exec.agent === undefined) throw new Error('timed questions require a live agent')
        const result = await ctx.userQuestions.askTimed({ ...request, agent: exec.agent }, exec.callId, timeout * 1000)
        return 'pending' in result ? { ...result, message: pendingNotice } : answerResult(result)
      }
      // `wait` without `timed`: this tool's indefinite form still keys the
      // Client card by call id, so the UI can reopen a closed panel from the
      // tool call. The legacy tool keeps its unkeyed request.
      const result = await ctx.userQuestions.ask({ ...request, wait: { callId: exec.callId } })
      return answerResult(result)
    },
  }))
  /* jscpd:ignore-end */
}
