import { useCallback } from 'react'
import { IconQuestionOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent/types'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
// Also merges the userQuestions key into SessionProjectionMap for useProjection.
import type {
  AskUserQuestionAnswerItem, AskUserQuestionItem, AskUserQuestionOption,
} from '@deepseek-ai/dsh-user-questions/types'
import type { ToolCallViewProps, UserQuestionRecord } from '../../contract/slots.ts'
import type { AskQuestionCardModel } from '../models/ask-question-card-model.ts'
import { singleResultText } from '../models/raw-tool-call.ts'
import { toolRowModel } from '../models/tool-call-model.ts'
import { ToolRow } from '../components/ToolRow.tsx'
import { QuestionToolRow } from '../components/QuestionToolRow.tsx'
import { CONVERSATION_NS as NS } from '../../locale.ts'

/** One paired question and its visible answer lines. */
interface AnsweredQuestion {
  id: string
  question: string
  answers: string[]
}

/** Everything a recorded answer batch puts on its row. */
interface AnswerPresentation {
  summary: string
  /** The paired transcript card; absent when pairing the batch would be ambiguous. */
  transcript: AskQuestionCardModel | null
  /** Material for the read-only panel; absent whenever the transcript card is, since both render the same pairing. */
  record: UserQuestionRecord | undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** Answer records from the result JSON; null when the result is malformed. */
function answerEntries(text: string): AskUserQuestionAnswerItem[] | null {
  const parsed = parseJson(text)
  if (!isRecord(parsed)) return null
  const answers = parsed.answers
  if (!Array.isArray(answers) || !answers.every(isRecord)) return null
  const entries: AskUserQuestionAnswerItem[] = []
  for (const answer of answers) {
    if (typeof answer.id !== 'string'
      || !Array.isArray(answer.selected)
      || !answer.selected.every(item => typeof item === 'string')
      || (answer.custom !== undefined && typeof answer.custom !== 'string')) return null
    entries.push({
      id: answer.id,
      selected: answer.selected,
      ...(answer.custom === undefined ? {} : { custom: answer.custom }),
    })
  }
  return entries
}

/** Answers from a submitted steer that still awaits admission to a step. */
function queuedAnswerEntries(message: unknown, callId: string): AskUserQuestionAnswerItem[] | null {
  if (!isRecord(message) || !Array.isArray(message.content)) return null
  const content: unknown = message.content[0]
  if (!isRecord(content) || content.type !== 'text' || typeof content.text !== 'string') return null
  const parsed = parseJson(content.text)
  if (!isRecord(parsed) || parsed.kind !== 'answer_to_pending_question' || parsed.callId !== callId) return null
  return answerEntries(content.text)
}

/** One question's choices from call JSON; absent when any entry is malformed. */
function optionEntries(value: unknown): AskUserQuestionOption[] | undefined {
  if (!Array.isArray(value)) return undefined
  const options: AskUserQuestionOption[] = []
  for (const option of value) {
    if (!isRecord(option) || typeof option.label !== 'string') return undefined
    options.push({
      label: option.label,
      ...(typeof option.description === 'string' ? { description: option.description } : {}),
    })
  }
  return options
}

/**
 * Questions from call JSON; null when pairing with answers would be ambiguous.
 * The optional presentation fields are carried for the read-only answer panel,
 * which renders the same option lists the user chose from; a malformed one is
 * dropped rather than failing the whole call, because the transcript card needs
 * only the id and the question text.
 */
function questionEntries(argsRaw: string): AskUserQuestionItem[] | null {
  const parsed = parseJson(argsRaw)
  if (!isRecord(parsed) || !Array.isArray(parsed.questions) || parsed.questions.length === 0) return null
  const questions: AskUserQuestionItem[] = []
  const ids = new Set<string>()
  for (const question of parsed.questions) {
    if (!isRecord(question)
      || typeof question.id !== 'string'
      || typeof question.question !== 'string'
      || ids.has(question.id)) return null
    ids.add(question.id)
    const options = optionEntries(question.options)
    questions.push({
      id: question.id,
      question: question.question,
      ...(typeof question.header === 'string' ? { header: question.header } : {}),
      ...(typeof question.detail === 'string' ? { detail: question.detail } : {}),
      ...(options === undefined ? {} : { options }),
      // The tool schema spells the multi-select flag in snake case.
      ...(typeof question.multi_select === 'boolean' ? { multiSelect: question.multi_select } : {}),
    })
  }
  return questions
}

/** Pair questions with result entries by their echoed stable ids. */
function pairAnswers(
  questions: readonly AskUserQuestionItem[],
  answers: readonly AskUserQuestionAnswerItem[],
): AnsweredQuestion[] | null {
  if (questions.length !== answers.length) return null
  const byId = new Map<string, AskUserQuestionAnswerItem>()
  for (const answer of answers) {
    if (byId.has(answer.id)) return null
    byId.set(answer.id, answer)
  }
  const paired: AnsweredQuestion[] = []
  for (const question of questions) {
    const answer = byId.get(question.id)
    if (answer === undefined) return null
    paired.push({
      id: question.id,
      question: question.question,
      answers: [
        ...answer.selected,
        ...(answer.custom === undefined || answer.custom === '' ? [] : [answer.custom]),
      ],
    })
  }
  return paired
}

/**
 * Answer summary, transcript content, and panel material from one recorded
 * answer batch, whether the result carried it in time or a late reply did.
 * @param questions - The call's questions, or null when they failed validation.
 * @param answers - The recorded answer batch.
 * @param t - Row translator.
 * @returns What the answered row shows.
 */
function answeredPresentation(
  questions: readonly AskUserQuestionItem[] | null,
  answers: readonly AskUserQuestionAnswerItem[],
  t: AskQuestionRowProps['t'],
): AnswerPresentation {
  const answered = answers.filter(answer => answer.selected.length > 0 || (answer.custom ?? '') !== '').length
  const paired = questions === null ? null : pairAnswers(questions, answers)
  return {
    summary: t('ask.answered', { answered, total: answers.length }),
    transcript: paired === null ? null : { kind: 'answered', questions: paired, skippedLabel: t('ask.skipped') },
    // The read-only panel renders the option lists the user chose from and
    // looks each answer up by question id, so a batch this row cannot pair
    // unambiguously gets no panel either: blank or dropped answers would read
    // as choices the user made.
    record: paired === null || questions === null ? undefined : { questions, answers },
  }
}

/** Best-effort answered-count summary when strict transcript pairing fails. */
function answeredSummary(text: string, t: AskQuestionRowProps['t']): string | null {
  const parsed = parseJson(text)
  if (!isRecord(parsed)) return null
  const answers = parsed.answers
  if (!Array.isArray(answers) || !answers.every(isRecord)) return null
  const answered = answers.filter(a =>
    (Array.isArray(a.selected) && a.selected.length > 0)
    || (typeof a.custom === 'string' && a.custom !== '')).length
  return t('ask.answered', { answered, total: answers.length })
}

/** Whether a successful tool result records a still-answerable timed question. */
function isPendingResult(text: string): boolean {
  const parsed = parseJson(text)
  return isRecord(parsed) && parsed.pending === true && typeof parsed.callId === 'string'
}

/** Injected panel verbs for the row's own Session, filled by the optional panel provider. */
interface AskQuestionPanelInjected {
  /**
   * Show one call's answer panel in the composer.
   * @param callId - the row's own `ask_user_question` call.
   * @returns whether a panel for that call was there to show.
   */
  revealPanel: (callId: string) => boolean
  /**
   * Show one settled call's recorded answers as a read-only panel.
   * @param callId - the row's own `ask_user_question` call.
   * @param record - the call's questions and recorded answers, read from this row.
   * @returns whether a panel provider was there to show it.
   */
  reviewPanel: (callId: string, record: UserQuestionRecord) => boolean
}

type AskQuestionRowProps = ToolCallViewProps & PropsLocale<'conversation'> & InjectFace<AskQuestionPanelInjected>

/** Summarizes a pending, answered, cancelled, or interrupted question set. */
export function AskQuestionRow({
  callId, toolName, block, inspect, useDisclosure, useProjection, revealPanel, reviewPanel, t,
}: AskQuestionRowProps) {
  const model = toolRowModel(toolName, block)
  // The `userQuestions` projection lists exactly the timed calls that can still
  // take an answer — the running ones and the ones the agent continued past —
  // so it, not the recorded result, decides whether this row offers its panel.
  // A recorded pending result stays recorded after the reply, the skip, or the
  // timeout lands, and a legacy blocking call is never listed: its row reads
  // exactly as it did before timed questions existed.
  const answerable = useProjection('userQuestions', view =>
    view?.active.some(row => row.callId === callId) ?? false)
  // The same projection settles every answered timed call with its batch: the
  // one its own result carried, or the one a late reply carried after the
  // result recorded the timeout. A legacy call is never settled there, so its
  // answers come from its result text alone, without a panel to read back.
  const settled = useProjection('userQuestions', view =>
    view?.settled.find(row => row.callId === callId))
  // A continued call stays answerable until its steered reply is admitted.
  // Select the durable Inbox entry so its submitted answers can be reviewed
  // read-only during that interval, including after a browser reconnect.
  const queuedReply = useProjection('inbox', (view) => {
    const matches = (message: unknown): boolean => {
      const source = isRecord(message) ? message.source : undefined
      return isRecord(source) && source.kind === 'user-question-reply' && source.callId === callId
    }
    return view?.['next-step'].find(matches) ?? view?.['next-turn'].find(matches)
  })
  const reopen = useCallback(() => revealPanel(callId), [callId, revealPanel])
  // Composer verdicts settle the call as specific UserQuestionErrors
  // (ask_user_question handler): 'ASK_CANCELLED' is the user's own
  // dismissal of the set, 'ASK_ABORTED' is a turn interrupt landing while the
  // question was pending. Both name their verdict instead of the generic
  // failed shape, and the abort keeps the shared stopped (amber) semantics of
  // any other interrupted tool call.
  const code = 'kind' in block ? block.error?.code : undefined
  const argsRaw = model.bodyRaw ?? ''
  let summary = model.summary
  let state = model.state
  let transcript: AskQuestionCardModel | null = null
  // An answerable call reopens its panel, a queued reply reveals the row's
  // read-only transcript, and a settled call opens a read-only panel.
  let rowAction: (() => boolean) | undefined
  let rowActionLabel = t('ask.reopen')
  if (code === 'ASK_CANCELLED') {
    summary = t('ask.cancelled')
    state = 'ok'
    const questions = questionEntries(argsRaw)
    if (questions !== null) {
      transcript = { kind: 'unanswered', questions, verdict: t('ask.cancelledDetail') }
    }
  } else if (code === 'ASK_ABORTED') {
    summary = t('ask.interrupted')
    state = 'stopped'
    const questions = questionEntries(argsRaw)
    if (questions !== null) {
      transcript = { kind: 'unanswered', questions, verdict: t('ask.interruptedDetail') }
    }
  } else if (model.state === 'running') {
    summary = t('ask.waiting')
    if (answerable) rowAction = reopen
  } else if (code === 'TOOL_OUTCOME_UNKNOWN' && (answerable || settled !== undefined)) {
    // Crash repair has no pending result text; the durable question projection
    // still knows whether the interrupted call can take a late answer.
    state = 'ok'
    const questions = questionEntries(argsRaw)
    if (answerable) {
      summary = t('ask.pending')
      if (questions !== null) transcript = { kind: 'unanswered', questions, verdict: t('ask.pendingDetail') }
      rowAction = reopen
    } else if (settled?.answers.length === 0) {
      summary = t('ask.closed')
      if (questions !== null) transcript = { kind: 'unanswered', questions, verdict: t('ask.closedDetail') }
    } else if (settled !== undefined) {
      const presentation = answeredPresentation(questions, settled.answers, t)
      summary = presentation.summary
      transcript = presentation.transcript
      const record = presentation.record
      if (record !== undefined) {
        rowAction = () => reviewPanel(callId, record)
        rowActionLabel = t('ask.review')
      }
    }
  } else if ('kind' in block && model.state === 'ok') {
    const text = singleResultText(block)
    if (text !== undefined) {
      const questions = questionEntries(argsRaw)
      // A timed question's recorded result may be the timeout; whether it is
      // still answerable, and what the user finally answered, is the
      // projection's to say.
      const pending = isPendingResult(text)
      if (pending && answerable) {
        summary = t('ask.pending')
        if (questions !== null) {
          transcript = { kind: 'unanswered', questions, verdict: t('ask.pendingDetail') }
        }
        rowAction = reopen
      } else if (pending && (settled === undefined || settled.answers.length === 0)) {
        summary = t('ask.closed')
        if (questions !== null) {
          transcript = { kind: 'unanswered', questions, verdict: t('ask.closedDetail') }
        }
      } else {
        // Answered either way: whether the answer beat the timeout is the
        // agent's pacing, not something a reader of the row has to reason
        // about, so a late-answered call reads exactly like an in-time one.
        const answers = settled?.answers ?? answerEntries(text)
        const presentation = answers === null ? null : answeredPresentation(questions, answers, t)
        // Full transcripts require stable ids and valid visible fields; retain the
        // legacy best-effort count when only strict pairing is unsafe.
        summary = presentation?.summary ?? answeredSummary(text, t) ?? model.summary
        transcript = presentation?.transcript ?? null
        // Only a timed call has a panel to read its answers back in.
        const record = settled === undefined ? undefined : presentation?.record
        if (record !== undefined) {
          rowAction = () => reviewPanel(callId, record)
          rowActionLabel = t('ask.review')
        }
      }
    }
  }
  if (answerable && queuedReply !== undefined && rowAction === reopen) {
    const answers = queuedAnswerEntries(queuedReply, callId)
    const presentation = answers === null ? null : answeredPresentation(questionEntries(argsRaw), answers, t)
    if (presentation?.record !== undefined) {
      summary = presentation.summary
      transcript = presentation.transcript
      // The queued reply is reviewed in this row while its editable card is absent.
      rowAction = () => false
      rowActionLabel = t('ask.review')
    }
  }
  if (rowAction !== undefined) return (
    <QuestionToolRow useDisclosure={useDisclosure} t={t} summary={summary}
      bodyRaw={transcript === null ? model.bodyRaw : null} output={transcript === null ? model.output : null}
      askQuestion={transcript} state={state} inspect={inspect}
      openPanel={rowAction} panelLabel={rowActionLabel} />
  )
  return (
    <ToolRow
      useDisclosure={useDisclosure}
      t={t}
      variant={model.variant}
      toolName={toolName}
      icon={<IconQuestionOutlineRegular />}
      title={t(model.titleKey)}
      summary={summary}
      bodyRaw={transcript === null ? model.bodyRaw : null}
      output={transcript === null ? model.output : null}
      askQuestion={transcript}
      state={state}
      inspect={inspect}
    />
  )
}

/** Registers the ask-user-question conversation row. */
export const askQuestionToolview = {
  name: 'ask-question-toolview',
  inject: ['slots'],
  apply(ctx: Context): void {
    ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
      name: 'tool.call.toolview', key: 'ask_user_question', locale: NS,
      // Read per click, not per render: a composition with no question UI
      // provides no panels, and the row then falls back to its own record.
      inject: (sessionId): AskQuestionPanelInjected => ({
        revealPanel: callId => ctx.get('userQuestionPanels')?.reveal(sessionId, callId) ?? false,
        reviewPanel: (callId, record) =>
          ctx.get('userQuestionPanels')?.review(sessionId, callId, record) ?? false,
      }),
    }, AskQuestionRow))
  },
}
