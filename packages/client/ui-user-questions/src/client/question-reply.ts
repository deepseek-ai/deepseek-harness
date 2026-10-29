/** Answered-question Chat data from in-time tool results and late human replies. */
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type { ConversationLocation, ConversationNodeDefinition } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { isAppendSurfaceEvent } from '@deepseek-ai/dsh-session/surface'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-user-questions/types'
import type {} from '@deepseek-ai/dsh-tool-executor-ptc/types'

/** One asked question as echoed in the reply payload. */
export interface QuestionReplyQuestion {
  readonly id: string
  readonly question: string
  readonly header?: string
}

/** One structured answer as echoed in the reply payload. */
export interface QuestionReplyAnswer {
  readonly id: string
  readonly selected: readonly string[]
  readonly custom?: string
}

/** Presentation data of one submitted answer batch. */
export interface QuestionReplyData {
  readonly callId: string
  /** A submitted answer batch, including individually skipped questions. */
  readonly outcome: 'answered'
  readonly questions: readonly QuestionReplyQuestion[]
  readonly answers: readonly QuestionReplyAnswer[]
  /** Model-facing text, shown when the payload is unreadable. */
  readonly text: string
  readonly time: number
}

declare module '@deepseek-ai/dsh-client-ui-chat/client' {
  interface ChatNodeDataMap {
    /** One answered question batch, regardless of foreground wait timing. */
    'question-reply': QuestionReplyData
  }
}

interface QuestionReplyState extends QuestionReplyData {
  readonly seq: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Read the question and answer pairs out of the reply text at the conversation boundary.
 * @param text - Model-facing JSON payload of the steered message.
 * @returns The pairs, or empty lists when the payload is unreadable.
 */
export function replyPairsOf(text: string): Pick<QuestionReplyData, 'questions' | 'answers'> {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    // A reply whose text is not JSON renders as its raw text.
    void error
    return { questions: [], answers: [] }
  }
  if (!isRecord(value) || !Array.isArray(value.questions)) {
    return { questions: [], answers: [] }
  }
  const questions: QuestionReplyQuestion[] = []
  for (const question of value.questions) {
    if (!isRecord(question) || typeof question.id !== 'string' || typeof question.question !== 'string') continue
    questions.push({
      id: question.id,
      question: question.question,
      ...(typeof question.header === 'string' ? { header: question.header } : {}),
    })
  }
  const answers: QuestionReplyAnswer[] = []
  for (const answer of Array.isArray(value.answers) ? value.answers : []) {
    if (!isRecord(answer) || typeof answer.id !== 'string' || !Array.isArray(answer.selected)) continue
    answers.push({
      id: answer.id,
      selected: answer.selected.filter((item): item is string => typeof item === 'string'),
      ...(typeof answer.custom === 'string' ? { custom: answer.custom } : {}),
    })
  }
  return { questions, answers }
}

/**
 * Answer values of one question in display order: the selected option labels
 * followed by a non-blank custom answer.
 * @param data - Projected reply holding the recorded answers.
 * @param id - Question id to read.
 * @returns The values, empty when the user skipped that question.
 */
export function replyAnswerValues(data: QuestionReplyData, id: string): string[] {
  const answer = data.answers.find(item => item.id === id)
  const custom = answer?.custom?.trim() ?? ''
  return [...(answer?.selected ?? []), ...(custom === '' ? [] : [custom])]
}

/**
 * Clipboard text of one answer batch: every question with the answer the user
 * gave, without question details or unselected options.
 * @param data - Projected reply to copy.
 * @param t - Bound `question` namespace translator owning the answer labels.
 * @returns One block per question, or the model-facing text when the payload was unreadable.
 */
export function replyClipboardText(data: QuestionReplyData, t: PropsLocale<'question'>['t']): string {
  if (data.questions.length === 0) return data.text
  return data.questions.map((question) => {
    const values = replyAnswerValues(data, question.id)
    const heading = question.header && question.header !== question.question
      ? `${question.header} — ${question.question}`
      : question.question
    const answer = values.length === 0
      ? t('reply.skipped')
      : `${t('reply.answerLabel')}${values.join(', ')}`
    return `${heading}\n${answer}`
  }).join('\n\n')
}

/** Validate a late reply source at the persisted conversation boundary. */
function replySource(
  event: Pick<SessionEvent<'user/message'>, 'data'>,
): { callId: string; outcome: QuestionReplyData['outcome'] } | null {
  const source: unknown = event.data.source
  return isRecord(source) && source.kind === 'user-question-reply'
    && typeof source.callId === 'string' && source.outcome === 'answered'
    ? { callId: source.callId, outcome: 'answered' }
    : null
}

/** Reply data retained until a matching tool result records a complete answer batch. */
interface AnsweredQuestionState {
  readonly questions: readonly QuestionReplyQuestion[] | null
  readonly reply: QuestionReplyState | undefined
}

function jsonRecord(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text)
    return isRecord(value) ? value : null
  } catch (error) {
    // Malformed tool JSON remains visible through the generic Tool node.
    void error
    return null
  }
}

function callQuestions(value: unknown): readonly QuestionReplyQuestion[] | null {
  if (!isRecord(value) || !Array.isArray(value.questions) || value.questions.length === 0) return null
  const ids = new Set<string>()
  const questions: QuestionReplyQuestion[] = []
  for (const question of value.questions) {
    if (!isRecord(question) || typeof question.id !== 'string' || typeof question.question !== 'string'
      || ids.has(question.id) || (isRecord(question.intent) && question.intent.kind === 'plan-review')) return null
    ids.add(question.id)
    questions.push({
      id: question.id,
      question: question.question,
      ...(typeof question.header === 'string' ? { header: question.header } : {}),
    })
  }
  return questions
}

function resultReply(
  questions: readonly QuestionReplyQuestion[],
  event: SessionEvent<'tool/result' | 'tool/ptc-dispatch'>,
): QuestionReplyState | undefined {
  const result = event.type === 'tool/result' ? event.data.message : event.data
  if (result.isError === true) return undefined
  const content = result.content
  if (content.length !== 1 || content[0]?.type !== 'text') return undefined
  const text = content[0].text
  const value = jsonRecord(text)
  if (value === null || value.pending === true || !Array.isArray(value.answers)
    || value.answers.length !== questions.length) return undefined
  const ids = new Set(questions.map(question => question.id))
  const answers: QuestionReplyAnswer[] = []
  for (const answer of value.answers) {
    if (!isRecord(answer) || typeof answer.id !== 'string' || !ids.delete(answer.id)
      || !Array.isArray(answer.selected) || !answer.selected.every(item => typeof item === 'string')
      || (answer.custom !== undefined && typeof answer.custom !== 'string')) return undefined
    answers.push({ id: answer.id, selected: answer.selected,
      ...(answer.custom === undefined ? {} : { custom: answer.custom }) })
  }
  return { seq: event.seq, time: event.time, callId: String(event.type === 'tool/result' ? event.data.message.source.callId : event.data.subCallId),
    outcome: 'answered', questions, answers, text }
}

/**
 * In-time ask-user answers paired by native callId or PTC subCallId. Pending, failed, and
 * malformed results retain their generic Tool presentation; late answers are
 * owned by questionReplyDefinition. Work is bounded by this call's answer batch.
 */
export const answeredQuestionDefinition: ConversationNodeDefinition<AnsweredQuestionState> = {
  kind: 'answered-user-question',
  target: 'chat',
  match: (event) => {
    if (event.type === 'tool/call' && event.data.name === 'ask_user_question') {
      return { id: String(event.data.callId), role: 'start' }
    }
    if (event.type === 'tool/ptc-dispatch-start' && event.data.name === 'ask_user_question') {
      return { id: String(event.data.subCallId), role: 'start' }
    }
    if (event.type === 'tool/ptc-dispatch' && event.data.name === 'ask_user_question') {
      return { id: String(event.data.subCallId), role: 'update' }
    }
    // Native results omit the tool name; retain update-only matches for history prepends.
    if (event.type === 'tool/result' && isAppendSurfaceEvent(event)) {
      return { id: String(event.data.message.source.callId), role: 'update' }
    }
    return null
  },
  start: (_context, match) => {
    const event = match.event
    if (event.type !== 'tool/call' && event.type !== 'tool/ptc-dispatch-start') {
      throw new Error('answered-user-question requires tool/call or tool/ptc-dispatch-start')
    }
    return { questions: callQuestions(event.type === 'tool/call' ? jsonRecord(event.data.arguments) : event.data.arguments), reply: undefined }
  },
  update: (context, match) => {
    if ((match.event.type !== 'tool/result' && match.event.type !== 'tool/ptc-dispatch') || context.state.questions === null) return context.state
    return { ...context.state, reply: resultReply(context.state.questions, match.event) }
  },
  buildViewNode: (context) => {
    const reply = context.state?.reply
    if (reply === undefined) {
      const current = context.current.get('chat')
      return current == null ? null : { ...current, visibility: 'hidden' }
    }
    const { seq, ...data } = reply
    return {
      key: context.key, id: context.id, kind: 'question-reply', target: 'chat',
      anchorSeq: seq, location: context.start?.location ?? { kind: 'unresolved' },
      groupTree: 'turn', visibility: 'visible', data,
    }
  },
}

/**
 * Late-reply projection owned by the questions UI. It claims the reply message
 * on the Chat target, so the generic message Definition never presents it.
 */
export const questionReplyDefinition: ConversationNodeDefinition<QuestionReplyState> = {
  kind: 'user-question-reply',
  target: 'chat',
  match: (event) => {
    if (event.type !== 'user/message' || !isAppendSurfaceEvent(event)) return null
    return replySource(event) === null ? null : { id: String(event.data.id), role: 'start', exclusive: true }
  },
  start: (_context, match) => {
    if (match.event.type !== 'user/message') throw new Error('user-question-reply start requires user/message')
    const event = match.event
    const block = event.data.content.find(item => item.type === 'text')
    const text = block?.text ?? ''
    const source = replySource(event)
    if (source === null) throw new Error('user-question-reply start requires a reply source')
    return {
      seq: event.seq,
      time: event.time,
      callId: source.callId,
      outcome: source.outcome,
      text,
      ...replyPairsOf(text),
    }
  },
  update: context => context.state,
  buildViewNode: (context) => {
    if (context.state === undefined) return null
    const { seq, ...data } = context.state
    const location: ConversationLocation = context.start?.location ?? { kind: 'unresolved' }
    return {
      key: context.key,
      kind: 'question-reply',
      id: context.id,
      target: 'chat',
      anchorSeq: seq,
      location,
      groupTree: location.kind === 'step' && location.step.step === 1 ? 'exchange' : 'input',
      visibility: 'visible',
      data,
    }
  },
}
