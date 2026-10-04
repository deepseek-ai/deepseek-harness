/** Late-reply conversation node: the steered `user-question-reply` message projected as question and answer pairs. */
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type { ConversationNodeDefinition } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { isAppendSurfaceEvent } from '@deepseek-ai/dsh-session/surface'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-user-questions/types'

/** One asked question as echoed in the reply payload. */
export interface QuestionReplyQuestion {
  readonly id: string
  readonly question: string
  readonly detail?: string
  readonly header?: string
  readonly options?: readonly { readonly label: string; readonly description?: string }[]
  readonly multiSelect?: boolean
}

/** One structured answer as echoed in the reply payload. */
export interface QuestionReplyAnswer {
  readonly id: string
  readonly selected: readonly string[]
  readonly custom?: string
}

/** Presentation data of one late reply. */
export interface QuestionReplyData {
  readonly callId: string
  /** A late answer to the pending questions. */
  readonly outcome: 'answered'
  readonly questions: readonly QuestionReplyQuestion[]
  readonly answers: readonly QuestionReplyAnswer[]
  /** Model-facing text, shown when the payload is unreadable. */
  readonly text: string
  readonly time: number
}

declare module '@deepseek-ai/dsh-client-ui-chat/client' {
  interface ChatNodeDataMap {
    /** Late answer to a continued question. */
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
      ...(typeof question.detail === 'string' ? { detail: question.detail } : {}),
      ...(typeof question.header === 'string' ? { header: question.header } : {}),
      ...(Array.isArray(question.options)
        ? { options: question.options.flatMap((option) => {
          if (!isRecord(option) || typeof option.label !== 'string') return []
          return [{ label: option.label, ...(typeof option.description === 'string' ? { description: option.description } : {}) }]
        }) }
        : {}),
      ...(typeof question.multiSelect === 'boolean' ? { multiSelect: question.multiSelect } : {}),
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
 * Clipboard text of one late reply: every question with the answer the user
 * gave, in the layout the open bubble shows, without the options nobody chose.
 * The text does not depend on whether the bubble is open.
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

/** Late-reply projection owned by the questions UI. */
export const questionReplyDefinition: ConversationNodeDefinition<QuestionReplyState> = {
  kind: 'user-question-reply',
  target: 'chat',
  match: (event) => {
    if (event.type !== 'user/message' || !isAppendSurfaceEvent(event)) return null
    return replySource(event) === null ? null : { id: String(event.data.id), role: 'start' }
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
    return {
      key: context.key,
      kind: 'question-reply',
      id: context.id,
      target: 'chat',
      anchorSeq: seq,
      location: context.start?.location ?? { kind: 'unresolved' },
      visibility: 'visible',
      data,
    }
  },
}
