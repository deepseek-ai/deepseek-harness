import { describe, expect, it } from 'vitest'
import { SessionLogOffset, SessionSeq, TOOL_OUTCOME_UNKNOWN, type SessionEvent } from '@deepseek-ai/dsh-session'
import { createToolResultMessage, createUserMessage, ToolCallId, type ToolSchema } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-tools/types'
import {
  applyUserQuestionEvent, foldUserQuestions, isTimedAskUserQuestionSchema, questionsOf, TIMED_WAIT_PARAMETER,
  userQuestionProjectionDefinition,
} from '../src/projection.ts'

const callId = ToolCallId('call_ask_1')
const toolArguments = JSON.stringify({
  questions: [{
    id: 'scope',
    question: 'Which scope?',
    header: 'Scope',
    options: [{ label: 'Tool only', description: 'Only the tool package.' }, { label: 'Everything' }],
    multi_select: true,
  }],
})
const questions = [{
  id: 'scope',
  question: 'Which scope?',
  header: 'Scope',
  options: [{ label: 'Tool only', description: 'Only the tool package.' }, { label: 'Everything' }],
  multiSelect: true,
}]

function event<K extends SessionEvent['type']>(seq: number, type: K, data: SessionEvent<K>['data']): SessionEvent {
  return { type, seq: SessionSeq(seq), time: seq, data } as SessionEvent
}

/** The `ask_user_question` schema as the blocking legacy tool declares it: no wait parameter. */
const legacySchema: ToolSchema = {
  name: 'ask_user_question',
  description: 'Ask the user a concise question.',
  parameters: { type: 'object', properties: { questions: { type: 'array' } } },
}

/** The `ask_user_question` schema as the timed tool declares it: the wait parameter marks it. */
const timedSchema: ToolSchema = {
  name: 'ask_user_question',
  description: 'Ask brief questions.',
  parameters: { type: 'object', properties: { questions: { type: 'array' }, [TIMED_WAIT_PARAMETER]: { type: 'integer' } } },
}

const bashSchema: ToolSchema = { name: 'bash', description: 'Run a command.', parameters: { type: 'object', properties: {} } }

/** The request header the model saw before it asked. */
function header(seq: number, tools: ToolSchema[] | undefined): SessionEvent {
  return event(seq, 'request/header', {
    header: { config: { provider: 'deepseek-official', model: 'deepseek-v4-flash' }, ...(tools === undefined ? {} : { tools }) },
    reason: 'initial',
  })
}

const timedHeader = header(0, [bashSchema, timedSchema])
const legacyHeader = header(0, [bashSchema, legacySchema])

const asked = event(1, 'tool/call', { turn: 1, step: 1, callId, name: 'ask_user_question', arguments: toolArguments })

function resulted(text: string, error?: { name: string; code: string }): SessionEvent {
  return event(2, 'tool/result', {
    turn: 1,
    step: 1,
    message: createToolResultMessage({ callId, content: [{ type: 'text', text }], isError: error !== undefined }),
    ...(error === undefined ? {} : { error }),
  })
}

const reply = (text = '{}') => createUserMessage({
  source: { kind: 'user-question-reply', callId, outcome: 'answered' },
  content: [{ type: 'text', text }],
})

const answerBatch = [{ id: 'scope', selected: ['Tool only'], custom: 'also docs' }]
const answeredText = JSON.stringify({
  kind: 'answer_to_pending_question', tool: 'ask_user_question', callId,
  questions, answers: answerBatch,
})

const empty = { active: [], settled: [] }

describe('userQuestions projection fold', () => {
  it('recognises the timed tool schema by its wait parameter alone', () => {
    expect(isTimedAskUserQuestionSchema(timedSchema)).toBe(true)
    expect(isTimedAskUserQuestionSchema(legacySchema)).toBe(false)
    expect(isTimedAskUserQuestionSchema({ ...timedSchema, name: 'bash' })).toBe(false)
    expect(isTimedAskUserQuestionSchema({ name: 'ask_user_question', parameters: { type: 'object' } })).toBe(false)
  })

  it('opens a question asked under the timed schema and maps the tool vocabulary', () => {
    expect(foldUserQuestions([timedHeader, asked])).toEqual({ active: [{ callId, questions, state: 'open' }], settled: [] })
  })

  it('never tracks a call made under the blocking legacy tool, so a legacy Session folds to the empty view', () => {
    const legacyLog = [legacyHeader, asked]
    expect(foldUserQuestions(legacyLog)).toEqual(empty)
    expect(foldUserQuestions([...legacyLog, resulted('{"answers":[{"id":"scope","selected":["Tool only"]}]}')])).toEqual(empty)
    expect(foldUserQuestions([
      ...legacyLog,
      resulted('The tool call was interrupted after it was recorded.', { name: 'SessionFormatError', code: TOOL_OUTCOME_UNKNOWN }),
    ])).toEqual(empty)
    // No header at all, a header without tools, and a seeded header whose
    // tools are a placeholder string all read as the legacy tool.
    expect(foldUserQuestions([asked])).toEqual(empty)
    expect(foldUserQuestions([header(0, undefined), asked])).toEqual(empty)
    expect(foldUserQuestions([
      event(0, 'request/header', { header: { config: {}, tools: '{{tools}}' }, reason: 'initial' } as never),
      asked,
    ])).toEqual(empty)
  })

  it('follows the latest header when the composed tool changes mid-Session', () => {
    const later = event(3, 'tool/call', { turn: 2, step: 1, callId: ToolCallId('call_ask_2'), name: 'ask_user_question', arguments: toolArguments })
    expect(foldUserQuestions([legacyHeader, asked, header(2, [timedSchema]), later])).toEqual({
      active: [{ callId: ToolCallId('call_ask_2'), questions, state: 'open' }], settled: [],
    })
    expect(foldUserQuestions([timedHeader, asked, header(2, [legacySchema]), later])).toEqual({
      active: [{ callId, questions, state: 'open' }], settled: [],
    })
  })

  it('settles an in-time answer batch with that batch and drops every failure a live Host records', () => {
    expect(foldUserQuestions([timedHeader, asked, resulted('{"answers":[{"id":"scope","selected":["Tool only"]}]}')]))
      .toEqual({ active: [], settled: [{ callId, answers: [{ id: 'scope', selected: ['Tool only'] }] }] })
    expect(foldUserQuestions([timedHeader, asked, resulted('cancelled', { name: 'UserQuestionError', code: 'ASK_CANCELLED' })])).toEqual(empty)
    expect(foldUserQuestions([timedHeader, asked, resulted('aborted', { name: 'UserQuestionError', code: 'ASK_ABORTED' })])).toEqual(empty)
    expect(foldUserQuestions([timedHeader, asked, resulted('boom', { name: 'Error', code: 'UNEXPECTED' })])).toEqual(empty)
    expect(foldUserQuestions([timedHeader, asked, resulted('not json at all')])).toEqual(empty)
    expect(foldUserQuestions([timedHeader, asked, resulted('{"answers":"nope"}')])).toEqual(empty)
    // A batch spelled inside an error result is a failure, whatever its text says.
    expect(foldUserQuestions([timedHeader, asked, event(2, 'tool/result', {
      turn: 1, step: 1,
      message: createToolResultMessage({ callId, content: [{ type: 'text', text: '{"answers":[]}' }], isError: true }),
    })])).toEqual(empty)
  })

  it('keeps a pending call, or one the process never finished, answerable as continued', () => {
    const continued = { active: [{ callId, questions, state: 'continued' }], settled: [] }
    expect(foldUserQuestions([timedHeader, asked, resulted('{"pending":true,"callId":"call_ask_1"}')])).toEqual(continued)
    expect(foldUserQuestions([
      timedHeader,
      asked,
      resulted('The tool call was interrupted after it was recorded.', { name: 'SessionFormatError', code: TOOL_OUTCOME_UNKNOWN }),
    ])).toEqual(continued)
  })

  it('closes a continued question only when its reply is admitted as a user message', () => {
    const continued = [timedHeader, asked, resulted('{"pending":true,"callId":"call_ask_1"}')]
    const settled = { active: [], settled: [{ callId, answers: [] }] }
    expect(foldUserQuestions([
      ...continued,
      event(3, 'agent/inbox/spliced', { target: 'next-step', start: 0, inserted: [reply()] }),
      event(4, 'agent/inbox/spliced', { target: 'next-step', start: 0, removedCount: 1, inserted: [], outcome: 'canceled' }),
    ])).toEqual({ active: [{ callId, questions, state: 'continued' }], settled: [] })
    expect(foldUserQuestions([...continued, event(3, 'user/message', reply())])).toEqual(settled)
  })

  it('records the answers one reply carried, exactly once across its splice and its own event', () => {
    const replied = reply(answeredText)
    const settled = { active: [], settled: [{ callId, answers: answerBatch }] }
    const continued = [timedHeader, asked, resulted('{"pending":true,"callId":"call_ask_1"}')]
    expect(foldUserQuestions([...continued, event(3, 'user/message', replied)])).toEqual(settled)
    expect(foldUserQuestions([
      ...continued,
      event(3, 'agent/inbox/spliced', { target: 'next-step', start: 0, inserted: [replied] }),
      event(4, 'user/message', replied),
    ])).toEqual(settled)
  })

  it('continues a pending PTC sub-call when only run_code appeared in the request header', () => {
    const subCallId = ToolCallId('run_1:ptc:1')
    const dispatchData: SessionEvent<'tool/ptc-dispatch'>['data'] = {
      rootCallId: ToolCallId('run_1'), parentCallId: ToolCallId('run_1'), subCallId,
      name: 'ask_user_question', arguments: JSON.parse(toolArguments), isError: false,
      content: [{ type: 'text', text: JSON.stringify({ pending: true, callId: subCallId }) }],
    }
    const dispatch = event(2, 'tool/ptc-dispatch', dispatchData)
    const runCodeHeader = header(0, [{ name: 'run_code', description: 'Run code.', parameters: { type: 'object' } }])
    expect(foldUserQuestions([runCodeHeader, dispatch])).toEqual({
      active: [{ callId: subCallId, questions, state: 'continued' }], settled: [],
    })
    expect(foldUserQuestions([runCodeHeader, dispatch, dispatch])).toEqual({
      active: [{ callId: subCallId, questions, state: 'continued' }], settled: [],
    })
    expect(foldUserQuestions([runCodeHeader, event(2, 'tool/ptc-dispatch', {
      ...dispatchData, arguments: { questions: 'invalid' },
    })])).toEqual(empty)
    expect(foldUserQuestions([runCodeHeader, event(2, 'tool/ptc-dispatch', { ...dispatchData, isError: true })])).toEqual(empty)
    expect(foldUserQuestions([runCodeHeader, event(2, 'tool/ptc-dispatch', {
      ...dispatchData, content: [{ type: 'text', text: '{"answers":[]}' }],
    })])).toEqual(empty)
  })

  it('settles with no answers when the reply text carries none this reader can use', () => {
    const continued = [timedHeader, asked, resulted('{"pending":true,"callId":"call_ask_1"}')]
    const settled = { active: [], settled: [{ callId, answers: [] }] }
    expect(foldUserQuestions([...continued, event(3, 'user/message', reply('no json here'))])).toEqual(settled)
    expect(foldUserQuestions([...continued, event(3, 'user/message', reply('{"answers":"nope"}'))])).toEqual(settled)
    expect(foldUserQuestions([...continued, event(3, 'user/message', createUserMessage({
      source: { kind: 'user-question-reply', callId, outcome: 'answered' },
      content: [],
    }))])).toEqual(settled)
  })

  it('returns the same fold for unrelated events, unreadable calls, and an unchanged header', () => {
    const fold = [timedHeader, asked].reduce(applyUserQuestionEvent, { timed: false, questions: empty })
    expect(applyUserQuestionEvent(fold, event(5, 'turn/start', { turn: 2 }))).toBe(fold)
    expect(applyUserQuestionEvent(fold, header(5, [timedSchema]))).toBe(fold)
    expect(applyUserQuestionEvent(fold, event(5, 'tool/call', {
      turn: 1, step: 2, callId: ToolCallId('other'), name: 'bash', arguments: '{}',
    }))).toBe(fold)
    expect(applyUserQuestionEvent(fold, event(5, 'tool/call', {
      turn: 1, step: 2, callId: ToolCallId('broken'), name: 'ask_user_question', arguments: '{not json',
    }))).toBe(fold)
    expect(applyUserQuestionEvent(fold, event(5, 'agent/inbox/spliced', {
      target: 'next-step', start: 0, inserted: [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] })],
    }))).toBe(fold)
    expect(applyUserQuestionEvent(fold, event(5, 'user/message', createUserMessage({
      source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }],
    })))).toBe(fold)
    expect(applyUserQuestionEvent(fold, event(5, 'user/message', createUserMessage({
      source: { kind: 'user-question-reply', callId: ToolCallId('other'), outcome: 'answered' },
      content: [{ type: 'text', text: '{}' }],
    })))).toBe(fold)
    expect(applyUserQuestionEvent(fold, event(2, 'tool/result', {
      turn: 1, step: 1,
      message: createToolResultMessage({ callId: ToolCallId('other'), content: [{ type: 'text', text: '{}' }], isError: false }),
    }))).toBe(fold)
  })

  it('tracks several timed calls at once and re-asks under a reused call id in place', () => {
    const otherId = ToolCallId('call_ask_2')
    const other = event(3, 'tool/call', {
      turn: 1, step: 2, callId: otherId, name: 'ask_user_question',
      arguments: '{"questions":[{"id":"name","question":"Name?"}]}',
    })
    const both = [timedHeader, asked, other].reduce(applyUserQuestionEvent, { timed: false, questions: empty })
    expect(both.questions.active.map(question => question.callId)).toEqual([callId, otherId])

    const continued = applyUserQuestionEvent(both, resulted('{"pending":true,"callId":"call_ask_1"}'))
    expect(continued.questions.active.map(question => question.state)).toEqual(['continued', 'open'])

    const reasked = applyUserQuestionEvent(continued, asked)
    expect(reasked.questions.active.map(question => [question.callId, question.state]))
      .toEqual([[otherId, 'open'], [callId, 'open']])
  })

  it('closes a tracked call whose result carries no text at all', () => {
    expect(foldUserQuestions([timedHeader, asked, event(2, 'tool/result', {
      turn: 1, step: 1, message: createToolResultMessage({ callId, content: [], isError: false }),
    })])).toEqual(empty)
  })

  it('restores a checkpointed state in service vocabulary and refuses duplicate call ids', () => {
    const full = {
      callId: 'call_ask_1',
      questions: [
        {
          id: 'plan', question: 'Approve?', detail: '# Plan', header: 'Review',
          options: [{ label: 'Approve', description: 'Ship it.' }, { label: 'Refuse' }], multiSelect: false,
        },
        { id: 'bare', question: 'Anything else?' },
      ],
      state: 'continued',
    }
    const view = { active: [full], settled: [{ callId: 'call_ask_0', answers: answerBatch }] }
    const restored = userQuestionProjectionDefinition.stateSchema.parse({ inheritedEventCount: 3, timed: true, questions: view })
    expect(restored).toEqual({ inheritedEventCount: SessionLogOffset(3), timed: true, questions: view })
    expect(restored.questions.active[0]?.questions[1]).not.toHaveProperty('options')

    const { viewSchema } = userQuestionProjectionDefinition.wire
    expect(() => viewSchema.parse({ active: [full, { ...full, state: 'open' }], settled: [] })).toThrow(/callIds must be unique/)
    expect(() => viewSchema.parse({ active: [{ ...full, callId: '' }], settled: [] })).toThrow()
  })

  it('reads only well-formed question batches out of the arguments', () => {
    expect(questionsOf('{"questions":[]}')).toBeNull()
    expect(questionsOf('{"questions":[{"id":"x"}]}')).toBeNull()
    expect(questionsOf('[]')).toBeNull()
    expect(questionsOf('{"questions":[{"id":"x","question":"Q?"}]}')).toEqual([{ id: 'x', question: 'Q?' }])
  })

  it('does not inherit a parent Session question into a fork and exposes the whole view on the wire', () => {
    const inherited = userQuestionProjectionDefinition.init({} as never, SessionLogOffset(2))
    expect(userQuestionProjectionDefinition.apply(inherited, timedHeader)).toBe(inherited)
    expect(userQuestionProjectionDefinition.apply(inherited, asked)).toBe(inherited)

    const fresh = userQuestionProjectionDefinition.init({} as never, SessionLogOffset(0))
    const armed = userQuestionProjectionDefinition.apply(fresh, timedHeader)
    expect(armed).toMatchObject({ inheritedEventCount: 0, timed: true })
    expect(userQuestionProjectionDefinition.wire.view(armed)).toBe(userQuestionProjectionDefinition.wire.view(fresh))
    const opened = userQuestionProjectionDefinition.apply(armed, asked)
    expect(opened).not.toBe(armed)
    expect(userQuestionProjectionDefinition.wire.view(opened))
      .toEqual({ active: [{ callId, questions, state: 'open' }], settled: [] })
    expect(userQuestionProjectionDefinition.apply(opened, event(5, 'turn/start', { turn: 2 }))).toBe(opened)
    expect(userQuestionProjectionDefinition.stateVersion).toBe(2)
  })
})
