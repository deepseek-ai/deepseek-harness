/** Fold of `ask_user_question` tool events into the answerable question set, and its Session projection. */
import { z } from 'zod'
import { SessionLogOffset, TOOL_OUTCOME_UNKNOWN } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionLogOffset as SessionLogOffsetType } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-agent/types'
import type {} from '@deepseek-ai/dsh-tools/types'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, ToolSchema } from '@deepseek-ai/dsh-llm'
import type { AskUserQuestionAnswerItem, AskUserQuestionItem, AskUserQuestionOption, PendingUserQuestion, SettledUserQuestion, UserQuestionProjectionView } from './types.ts'

/**
 * The pure fold state: whether the request header in effect declares the
 * timed `ask_user_question` schema, and the question view that schema's
 * calls build. Calls made under the blocking legacy schema never enter it.
 */
export interface UserQuestionFold {
  readonly timed: boolean
  readonly questions: UserQuestionProjectionView
}

/** Host projection state; `questions` is the wire value, reused whenever an event changes nothing. */
export interface UserQuestionProjectionState extends UserQuestionFold {
  readonly inheritedEventCount: SessionLogOffsetType
}

/** Tool whose calls this projection tracks. */
export const ASK_USER_QUESTION_TOOL = 'ask_user_question'

/**
 * Model-facing parameter only the timed `ask_user_question` schema declares.
 * Its presence in the logged request header is what tells the fold that the
 * `ask_user_question` calls that follow can be continued past a timeout; the
 * blocking legacy schema never declares it.
 */
export const TIMED_WAIT_PARAMETER = 'timeout'

const toolOptionSchema = z.object({
  label: z.string(),
  description: z.string().optional(),
}).loose()

const toolQuestionSchema = z.object({
  id: z.string(),
  question: z.string(),
  header: z.string().optional(),
  options: z.array(toolOptionSchema).optional(),
  multi_select: z.boolean().optional(),
}).loose()

const toolArgumentsSchema = z.object({
  questions: z.array(toolQuestionSchema).min(1),
}).loose()

const optionSchema = z.object({
  label: z.string(),
  description: z.string().optional(),
}).strict().transform((option): AskUserQuestionOption => ({
  label: option.label,
  ...(option.description === undefined ? {} : { description: option.description }),
}))

const questionSchema = z.object({
  id: z.string(),
  question: z.string(),
  detail: z.string().optional(),
  header: z.string().optional(),
  options: z.array(optionSchema).optional(),
  multiSelect: z.boolean().optional(),
}).strict().transform((question): AskUserQuestionItem => ({
  id: question.id,
  question: question.question,
  ...(question.detail === undefined ? {} : { detail: question.detail }),
  ...(question.header === undefined ? {} : { header: question.header }),
  ...(question.options === undefined ? {} : { options: question.options }),
  ...(question.multiSelect === undefined ? {} : { multiSelect: question.multiSelect }),
}))

const pendingQuestionsSchema: z.ZodType<readonly PendingUserQuestion[]> = z.array(z.object({
  callId: z.string().min(1).transform(ToolCallId),
  questions: z.array(questionSchema).min(1),
  state: z.enum(['open', 'continued']),
}).strict()).superRefine((active, context) => {
  if (new Set(active.map(question => question.callId)).size !== active.length) {
    context.addIssue({ code: 'custom', message: 'callIds must be unique' })
  }
})

const answerSchema = z.object({
  id: z.string(),
  selected: z.array(z.string()),
  custom: z.string().optional(),
}).strict().transform((answer): AskUserQuestionAnswerItem => ({
  id: answer.id,
  selected: answer.selected,
  ...(answer.custom === undefined ? {} : { custom: answer.custom }),
}))

const settledQuestionsSchema: z.ZodType<readonly SettledUserQuestion[]> = z.array(z.object({
  callId: z.string().min(1).transform(ToolCallId),
  answers: z.array(answerSchema),
}).strict())

const projectionViewSchema: z.ZodType<UserQuestionProjectionView> = z.object({
  active: pendingQuestionsSchema,
  settled: settledQuestionsSchema,
}).strict()

/** The `answers` batch as both the in-time tool result and the steered late reply spell it. */
const answerBatchSchema = z.object({ answers: z.array(answerSchema) }).loose()

/** A Session with no timed `ask_user_question` call yet, shared so the wire value stays referentially stable. */
const emptyView: UserQuestionProjectionView = { active: [], settled: [] }

const initialFold: UserQuestionFold = { timed: false, questions: emptyView }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Whether one logged tool schema is the timed `ask_user_question` tool's.
 * @param tool - One entry of a request header's assembled tool schemas.
 * @returns True only for an `ask_user_question` schema whose parameters declare {@link TIMED_WAIT_PARAMETER}.
 */
export function isTimedAskUserQuestionSchema(tool: Pick<ToolSchema, 'name' | 'parameters'>): boolean {
  if (tool.name !== ASK_USER_QUESTION_TOOL) return false
  const properties: unknown = tool.parameters['properties']
  return isRecord(properties) && TIMED_WAIT_PARAMETER in properties
}

/**
 * Read the question batch out of logged `ask_user_question` arguments.
 * @param argumentsText - Raw JSON arguments recorded on the `tool/call` event.
 * @returns The questions in service vocabulary, or null when the arguments are unreadable.
 */
export function questionsOf(argumentsText: string): readonly AskUserQuestionItem[] | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(argumentsText)
  } catch (error) {
    // Malformed model arguments never reached the tool; there is no card to show.
    void error
    return null
  }
  const result = toolArgumentsSchema.safeParse(parsed)
  if (!result.success) return null
  return result.data.questions.map(question => ({
    id: question.id,
    question: question.question,
    ...(question.header === undefined ? {} : { header: question.header }),
    ...(question.options === undefined
      ? {}
      : {
        options: question.options.map(option => ({
          label: option.label,
          ...(option.description === undefined ? {} : { description: option.description }),
        })),
      }),
    ...(question.multi_select === undefined ? {} : { multiSelect: question.multi_select }),
  }))
}

function isPendingResult(content: readonly ContentBlock[]): boolean {
  const text = content.find(block => block.type === 'text')
  if (text === undefined) return false
  try {
    const parsed: unknown = JSON.parse(text.text)
    return typeof parsed === 'object' && parsed !== null && (parsed as { pending?: unknown }).pending === true
  } catch (error) {
    // A non-JSON result text is a failure message, never the pending payload.
    void error
    return false
  }
}

/**
 * Read the answer batch out of one recorded text: a tool result or a late reply.
 * @param content - Content blocks of the recorded message.
 * @returns The batch, or null when the text carries none this reader can use.
 */
function answerBatchOf(content: readonly ContentBlock[]): readonly AskUserQuestionAnswerItem[] | null {
  const text = content.find(block => block.type === 'text')
  if (text === undefined) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(text.text)
  } catch (error) {
    // A failure result, a dismissal, and any other text that is not an answer JSON carries no batch.
    void error
    return null
  }
  const result = answerBatchSchema.safeParse(parsed)
  return result.success ? result.data.answers : null
}

/**
 * Close one answerable question and keep the answers it settled with.
 * A reply whose call is no longer answerable changes nothing.
 * @param view - Current question state.
 * @param callId - Call the result or reply named.
 * @param answers - The batch it carried; empty when a late reply carried none.
 * @returns The same view when that call was not answerable, otherwise the updated one.
 */
function settleQuestion(
  view: UserQuestionProjectionView,
  callId: string,
  answers: readonly AskUserQuestionAnswerItem[],
): UserQuestionProjectionView {
  const question = view.active.find(item => item.callId === callId)
  if (question === undefined) return view
  return {
    active: view.active.filter(item => item.callId !== callId),
    settled: [...view.settled, { callId: question.callId, answers }],
  }
}

/**
 * Apply one Session event to this Session's question fold.
 * A `request/header` decides, from the assembled tool schemas it records,
 * whether the `ask_user_question` calls that follow are timed; a call made
 * under the blocking legacy schema is never tracked, so a Session that only
 * ever used that tool folds to the empty view. A tracked question stays
 * answerable as `continued` in exactly two cases: the tool returned the
 * pending payload, or Session resume repair appended the synthetic
 * `TOOL_OUTCOME_UNKNOWN` result for a call the process never finished. An
 * answer batch settles it with that batch; any failure drops it. A PTC
 * sub-call enters the fold when its recorded result is pending. A late reply
 * settles only when the agent admits its user message; queued inbox messages
 * can still be discarded before that point.
 * @param fold - Current fold state.
 * @param event - Next Session event in append order.
 * @returns The same fold when the event is unrelated, otherwise the updated one.
 */
export function applyUserQuestionEvent(fold: UserQuestionFold, event: SessionEvent): UserQuestionFold {
  const view = fold.questions
  switch (event.type) {
    case 'request/header': {
      // The log records the exact schema list the model saw; a seeded or
      // tool-less header carries none, which reads as the legacy tool.
      const tools: unknown = event.data.header.tools
      const timed = Array.isArray(tools) && tools.some((tool: unknown) =>
        isRecord(tool) && typeof tool.name === 'string' && isRecord(tool.parameters)
        && isTimedAskUserQuestionSchema({ name: tool.name, parameters: tool.parameters }))
      return timed === fold.timed ? fold : { ...fold, timed }
    }
    case 'tool/call': {
      if (!fold.timed || event.data.name !== ASK_USER_QUESTION_TOOL) return fold
      const questions = questionsOf(event.data.arguments)
      if (questions === null) return fold
      const callId = event.data.callId
      return {
        ...fold,
        questions: {
          ...view,
          active: [...view.active.filter(question => question.callId !== callId), { callId, questions, state: 'open' }],
        },
      }
    }
    case 'tool/result': {
      const callId = event.data.message.toolCallId
      if (!view.active.some(question => question.callId === callId)) return fold
      if (isPendingResult(event.data.message.content) || event.data.error?.code === TOOL_OUTCOME_UNKNOWN) {
        return {
          ...fold,
          questions: {
            ...view,
            active: view.active.map(question => question.callId === callId ? { ...question, state: 'continued' } : question),
          },
        }
      }
      const answers = event.data.error === undefined && event.data.message.isError !== true
        ? answerBatchOf(event.data.message.content)
        : null
      return {
        ...fold,
        questions: answers === null
          ? { ...view, active: view.active.filter(question => question.callId !== callId) }
          : settleQuestion(view, callId, answers),
      }
    }
    case 'tool/ptc-dispatch': {
      if (event.data.name !== ASK_USER_QUESTION_TOOL || event.data.isError || !isPendingResult(event.data.content)) return fold
      const questions = questionsOf(JSON.stringify(event.data.arguments))
      if (questions === null) return fold
      const callId = event.data.subCallId
      return {
        ...fold,
        questions: {
          ...view,
          active: [...view.active.filter(question => question.callId !== callId), { callId, questions, state: 'continued' }],
        },
      }
    }
    case 'user/message': {
      const source = event.data.source
      if (source.kind !== 'user-question-reply') return fold
      const questions = settleQuestion(view, source.callId, answerBatchOf(event.data.content) ?? [])
      return questions === view ? fold : { ...fold, questions }
    }
    default:
      return fold
  }
}

/**
 * Fold a whole Session log into its question state.
 * @param events - Session events in append order.
 * @returns Open and continued timed calls in ask order, and settled ones in settlement order.
 */
export function foldUserQuestions(events: readonly SessionEvent[]): UserQuestionProjectionView {
  return events.reduce(applyUserQuestionEvent, initialFold).questions
}

/** Session projection exposing open, continued, and settled timed questions to every Client. */
export const userQuestionProjectionDefinition = {
  key: 'userQuestions',
  stateSchema: z.object({
    inheritedEventCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).transform(SessionLogOffset),
    timed: z.boolean(),
    questions: projectionViewSchema,
  }).strict(),
  init: (_header, inheritedEventCount) => ({ inheritedEventCount, ...initialFold }),
  apply: (state, event) => {
    if (event.seq < state.inheritedEventCount) return state
    const fold = applyUserQuestionEvent(state, event)
    return fold === state ? state : { ...state, ...fold }
  },
  wire: { viewSchema: projectionViewSchema, view: state => state.questions },
  stateVersion: 2,
} satisfies ProjectionDefinition<'userQuestions', UserQuestionProjectionState>

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    userQuestions: UserQuestionProjectionState
  }
}
