/** Late-reply conversation node: source matching and payload projection. */
import { describe, expect, it } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { ChatConversationViewNode } from '../../ui-chat/src/client/contract/chat-nodes.ts'
import type { ChatSnapshot } from '../../ui-chat/src/client/contract/snapshot.ts'
import { chatViewDefinition } from '../../ui-chat/src/client/conversation-nodes/chat-snapshot-builder.ts'
import { assistantDefinition } from '../../ui-chat/src/client/conversation-nodes/assistant.ts'
import { toolDefinition } from '../../ui-chat/src/client/conversation-nodes/tool.ts'
import { turnProcessDefinition } from '../../ui-chat/src/client/conversation-nodes/turn-process.ts'
import { isAtOrOutside } from '../../ui-chat/src/client/contract/group-tree.ts'
import type { ConversationViewNode } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { messageDefinition } from '../../ui-chat/src/client/conversation-nodes/message.ts'
import { ConversationNodeAssembler } from '../../ui-conversation/src/client/conversation/assembler.ts'
import { en } from '../src/client/locales.ts'
import type { QuestionReplyData } from '../src/client/question-reply.ts'
import { answeredQuestionDefinition, questionReplyDefinition, replyAnswerValues, replyClipboardText, replyPairsOf } from '../src/client/question-reply.ts'

const answered = JSON.stringify({
  kind: 'answer_to_pending_question',
  tool: 'ask_user_question',
  callId: 'call-1',
  questions: [{
    id: 'scope', question: 'Which scope?', header: 'Scope', detail: 'Choose the smallest useful surface.',
    options: [{ label: 'Tool only', description: 'Keep the change narrow.' }], multiSelect: false,
  }, { id: 'notes', question: 'Any notes?' }],
  answers: [{ id: 'scope', selected: ['Tool only'], custom: 'note' }, { id: 'notes', selected: [] }],
})
const noAnswers = JSON.stringify({ questions: [{ id: 'scope', question: 'Which scope?' }] })

function message(source: Record<string, unknown>, text: string, surfaceOp: string | null = 'append', seq = 7) {
  return {
    type: 'user/message',
    seq: SessionSeq(seq),
    time: 7_000,
    ...(surfaceOp === null ? {} : { surfaceOp }),
    data: { id: 'msg-1', role: 'user', source, content: [{ type: 'text', text }] },
  } as never
}

const replySource = (outcome: string) => ({ kind: 'user-question-reply', callId: 'call-1', outcome })

describe('replyPairsOf', () => {
  it('reads question and answer pairs, tolerating a payload without answers', () => {
    expect(replyPairsOf(answered)).toEqual({
      questions: [{
        id: 'scope', question: 'Which scope?', header: 'Scope',
      }, { id: 'notes', question: 'Any notes?' }],
      answers: [{ id: 'scope', selected: ['Tool only'], custom: 'note' }, { id: 'notes', selected: [] }],
    })
    expect(replyPairsOf(noAnswers)).toEqual({ questions: [{ id: 'scope', question: 'Which scope?' }], answers: [] })
  })

  it('omits options from the projected question', () => {
    const text = JSON.stringify({
      questions: [{ id: 'scope', question: 'Which scope?', options: [{ label: 'Tool only', description: 1 }, 'nope', { description: 'no label' }] }],
      answers: [],
    })
    expect(replyPairsOf(text).questions).toEqual([{ id: 'scope', question: 'Which scope?' }])
  })

  it('renders nothing structured for text it cannot read', () => {
    expect(replyPairsOf('not json')).toEqual({ questions: [], answers: [] })
    expect(replyPairsOf('{"questions":"nope"}')).toEqual({ questions: [], answers: [] })
    expect(replyPairsOf('{"questions":[{"id":1}],"answers":[{"id":"x"}]}')).toEqual({ questions: [], answers: [] })
  })
})

function toolCall(argumentsText = JSON.stringify({ questions: [{
  id: 'scope', question: 'Which scope?', header: 'Scope', detail: 'Hidden detail', options: [{ label: 'Tool only' }],
}, { id: 'notes', question: 'Any notes?' }] }), name = 'ask_user_question') {
  return { type: 'tool/call', seq: SessionSeq(5), time: 5_000,
    data: { turn: 1, step: 1, callId: 'call-1', name, arguments: argumentsText } } as never
}

function toolResult(text = JSON.stringify({ answers: [
  { id: 'notes', selected: [] }, { id: 'scope', selected: ['Tool only'], custom: 'note' },
] }), isError = false, surfaceOp = 'append') {
  return { type: 'tool/result', seq: SessionSeq(6), time: 6_000, surfaceOp,
    data: { turn: 1, step: 1, message: { role: 'tool', isError,
      source: { kind: 'tool', callId: 'call-1' }, content: [{ type: 'text', text }] } } } as never
}

function ptcCall(argumentsValue: unknown = { questions: [{ id: 'scope', question: 'Which scope?', header: 'Scope' }, { id: 'notes', question: 'Any notes?' }] }, name = 'ask_user_question') {
  return { type: 'tool/ptc-dispatch-start', seq: SessionSeq(5), time: 5_000,
    data: { rootCallId: 'root', parentCallId: 'root', subCallId: 'call-1', name, arguments: argumentsValue } } as never
}

function ptcResult(text = JSON.stringify({ answers: [{ id: 'notes', selected: [] }, { id: 'scope', selected: ['Tool only'], custom: 'note' }] }), isError = false, name = 'ask_user_question') {
  return { type: 'tool/ptc-dispatch', seq: SessionSeq(6), time: 6_000,
    data: { rootCallId: 'root', parentCallId: 'root', subCallId: 'call-1', name, arguments: {}, isError,
      content: [{ type: 'text', text }] } } as never
}

function answerAssembler() {
  let nodes: readonly ConversationViewNode[] = []
  const assembler = new ConversationNodeAssembler(
    { entries: () => [answeredQuestionDefinition, questionReplyDefinition, messageDefinition], fallbackEntry: () => undefined },
    { entries: () => [{ target: 'chat', create: () => ({
      empty: nodes,
      replace: input => (nodes = input.nodes),
      apply: (input) => {
        const changed = new Map(nodes.map(node => [node.key, node]))
        for (const node of input.upserts) changed.set(node.key, node)
        return (nodes = [...changed.values()])
      },
    }) }] },
  )
  assembler.activateTarget('chat')
  return { assembler, nodes: () => nodes as readonly ChatConversationViewNode[] }
}

describe('answeredQuestionDefinition', () => {
  it.each(['native', 'ptc'].flatMap(transport => ['replay', 'live', 'prepend'].flatMap(mode => [false, true].map(late => ({ mode, late, transport })))))('projects ordinary and late answer folding independently ($transport, $mode, late=$late)', ({ mode, late, transport }) => {
    const call = transport === 'native' ? toolCall() : ptcCall()
    const result = transport === 'native' ? toolResult : ptcResult
    const entries = [
      { type: 'event' as const, event: { type: 'turn/start', seq: SessionSeq(1), time: 1000, data: { turn: 1 } } as never },
      { type: 'event' as const, event: { type: 'step/start', seq: SessionSeq(2), time: 2000, data: { turn: 1, step: 1 } } as never },
      { type: 'event' as const, event: message({ kind: 'user' }, 'Ask me about scope', 'append', 3) },
      { type: 'event' as const, event: call },
      { type: 'event' as const, event: late ? result('{"pending":true,"callId":"call-1"}') : result() },
      { type: 'event' as const, event: { type: 'step/end', seq: SessionSeq(7), time: 7000, data: { turn: 1, step: 1 } } as never },
      { type: 'event' as const, event: { type: 'step/start', seq: SessionSeq(8), time: 8000, data: { turn: 1, step: 2 } } as never },
      { type: 'event' as const, event: { type: 'assistant/message', seq: SessionSeq(10), time: 10000, surfaceOp: 'append',
        data: { turn: 1, step: 2, stream: [], message: { id: 'final', role: 'assistant', source: { kind: 'model', provider: 'fake', model: 'fake' }, content: [{ type: 'text', text: 'Done' }] } } } as never },
      { type: 'event' as const, event: { type: 'step/end', seq: SessionSeq(11), time: 11000, data: { turn: 1, step: 2 } } as never },
      { type: 'event' as const, event: { type: 'turn/end', seq: SessionSeq(12), time: 12000, data: { turn: 1, reason: { kind: 'completed' } } } as never },
    ]
    if (late) entries.splice(7, 0, { type: 'event' as const, event: message(replySource('answered'), answered, 'append', 9) })
    if (transport === 'ptc') entries.splice(3, 0, { type: 'event' as const, event: {
      type: 'tool/call', seq: SessionSeq(4), time: 4000,
      data: { turn: 1, step: 1, callId: 'root', name: 'run_code', arguments: '{}' },
    } as never })
    const run = new ConversationNodeAssembler(
      {
        entries: () => [answeredQuestionDefinition, questionReplyDefinition, messageDefinition,
          assistantDefinition, toolDefinition, turnProcessDefinition],
        fallbackEntry: () => undefined,
      },
      { entries: () => [chatViewDefinition] },
    )
    if (mode === 'live') {
      run.replaceWindow([], false)
      run.activateTarget('chat')
      for (const entry of entries) { run.append(entry); run.flush() }
    } else if (mode === 'prepend') {
      run.replaceWindow(entries.slice(4), true)
      run.activateTarget('chat')
      run.prepend(entries.slice(0, 4), false)
      run.flush()
    } else {
      run.replaceWindow(entries, false)
      run.activateTarget('chat')
    }
    const view = run.snapshot('chat') as ChatSnapshot
    const batch = view.nodes.values().find(node => node.kind === 'question-reply')!
    const presentation = view.nodes.processSource(batch.key).getSnapshot()
    expect(presentation).toMatchObject({ turnClosed: true, hasExternalProcess: true, hasInterleavedInput: late })
    expect(batch).toMatchObject({ groupTree: late ? 'input' : 'turn', visibility: 'visible' })
    expect(isAtOrOutside(batch, 'turn')).toBe(true)
    expect(isAtOrOutside(batch, 'input')).toBe(late)
  })

  it('does not present a question until its answer arrives, then pairs one batch at the result position', () => {
    const run = answerAssembler()
    run.assembler.replaceWindow([{ type: 'event', event: toolCall() }], false)
    run.assembler.flush()
    expect(run.nodes()).toEqual([])
    run.assembler.append({ type: 'event', event: toolResult() })
    run.assembler.flush()
    expect(run.nodes()).toHaveLength(1)
    expect(run.nodes()[0]).toMatchObject({ kind: 'question-reply', anchorSeq: 6, groupTree: 'turn', visibility: 'visible',
      data: { callId: 'call-1', time: 6_000, outcome: 'answered',
        questions: [{ id: 'scope', question: 'Which scope?', header: 'Scope' }, { id: 'notes', question: 'Any notes?' }],
        answers: [{ id: 'notes', selected: [] }, { id: 'scope', selected: ['Tool only'], custom: 'note' }] } })
    expect(run.nodes()[0]?.data).not.toHaveProperty('seq')
    const replay = answerAssembler()
    replay.assembler.replaceWindow([{ type: 'event', event: toolCall() }, { type: 'event', event: toolResult() }], false)
    replay.assembler.flush()
    expect(replay.nodes().map(({ location: _location, ...node }) => node))
      .toEqual(run.nodes().map(({ location: _location, ...node }) => node))
    expect(replay.nodes()[0]?.location.kind).toBe(run.nodes()[0]?.location.kind)
  })

  it('keeps an update-only tail pending and derives the batch when its call is prepended', () => {
    const run = answerAssembler()
    run.assembler.replaceWindow([{ type: 'event', event: toolResult() }], false)
    run.assembler.flush()
    expect(run.nodes()).toEqual([])
    run.assembler.prepend([{ type: 'event', event: toolCall() }], false)
    run.assembler.flush()
    expect(run.nodes()).toHaveLength(1)
    expect(run.nodes()[0]).toMatchObject({ kind: 'question-reply', anchorSeq: 6 })
  })

  it('leaves pending results without a bubble and presents the eventual late answer exactly once', () => {
    const run = answerAssembler()
    run.assembler.replaceWindow([{ type: 'event', event: toolCall() },
      { type: 'event', event: toolResult('{"pending":true,"callId":"call-1"}') },
      { type: 'event', event: message(replySource('answered'), answered) }], false)
    run.assembler.flush()
    expect(run.nodes()).toHaveLength(1)
    expect(run.nodes()[0]).toMatchObject({ kind: 'question-reply', anchorSeq: 7, groupTree: 'exchange' })
  })

  it.each([
    'null', '[]', 'not json', '{"answers":"wrong"}', '{"answers":[]}',
    '{"answers":[{"id":"scope","selected":[]},{"id":"scope","selected":[]}]}',
    '{"answers":[{"id":"scope","selected":[1]},{"id":"notes","selected":[]}]}',
    '{"answers":[{"id":"scope","selected":[],"custom":1},{"id":"notes","selected":[]}]}',
    '{"answers":[{"id":"wrong","selected":[]},{"id":"notes","selected":[]}]}',
  ])('retains the generic fallback instead of fabricating answers from %s', (text) => {
    const run = answerAssembler()
    run.assembler.replaceWindow([{ type: 'event', event: toolCall() }, { type: 'event', event: toolResult(text) }], false)
    run.assembler.flush()
    expect(run.nodes()).toEqual([])
  })

  it.each(['not json', '{"questions":[]}', '{"questions":[{"id":1}]}',
    '{"questions":[{"id":"scope","question":"A"},{"id":"scope","question":"B"}]}',
    '{"questions":[{"id":"scope","question":"Approve?","intent":{"kind":"plan-review"}}]}',
  ])('does not pair unsafe or plan-review call arguments %s', (args) => {
    const run = answerAssembler()
    run.assembler.replaceWindow([{ type: 'event', event: toolCall(args) }, { type: 'event', event: toolResult() }], false)
    run.assembler.flush()
    expect(run.nodes()).toEqual([])
  })

  it.each([{ content: [] }, { content: [{ type: 'image', source: { kind: 'inline', data: '', mediaType: 'image/png' } }] },
    { content: [{ type: 'text', text: '{}' }, { type: 'text', text: '{}' }] },
  ])('leaves unsupported result content in the generic Tool presentation', ({ content }) => {
    const run = answerAssembler()
    const result = { type: 'tool/result', seq: SessionSeq(6), time: 6_000, surfaceOp: 'append',
      data: { turn: 1, step: 1, message: { role: 'tool', source: { kind: 'tool', callId: 'call-1' }, content } } } as never
    run.assembler.replaceWindow([{ type: 'event', event: toolCall() }, { type: 'event', event: result }], false)
    run.assembler.flush()
    expect(run.nodes()).toEqual([])
  })

  it('retains a published node key while replay withdraws its answer evidence', () => {
    const event = toolCall()
    const state = answeredQuestionDefinition.start({} as never, { event, id: 'call-1', role: 'start' } as never, {} as never)
    const answeredState = answeredQuestionDefinition.update({ state } as never,
      { event: toolResult(), id: 'call-1', role: 'update' } as never)
    const current = new Map()
    const node = answeredQuestionDefinition.buildViewNode!({ state: answeredState, current,
      key: 'answered:1', id: 'call-1', start: undefined } as never) as ChatConversationViewNode
    expect(node.location).toEqual({ kind: 'unresolved' })
    expect(node.visibility).toBe('visible')
    current.set('chat', node)
    const hidden = answeredQuestionDefinition.buildViewNode!({ state, current,
      key: 'answered:1', id: 'call-1', start: undefined } as never)
    expect(hidden).toMatchObject({ key: 'answered:1', visibility: 'hidden' })
    expect(answeredQuestionDefinition.buildViewNode!({ state: undefined, current: new Map() } as never)).toBeNull()
  })

  it('ignores unrelated PTC calls and retains malformed or failed dispatches in the generic tool view', () => {
    expect(answeredQuestionDefinition.match(ptcCall(undefined, 'bash'))).toBeNull()
    expect(answeredQuestionDefinition.match(ptcResult(undefined, false, 'bash'))).toBeNull()
    for (const [call, result] of [
      [ptcCall(), ptcResult(undefined, true)],
      [ptcCall(), ptcResult('not json')],
      [ptcCall({ questions: [] }), ptcResult()],
      [ptcCall({ questions: [{ id: 'plan', question: 'Approve?', intent: { kind: 'plan-review' } }] }), ptcResult()],
    ]) {
      const run = answerAssembler()
      run.assembler.replaceWindow([{ type: 'event', event: call! }, { type: 'event', event: result! }], false)
      run.assembler.flush()
      expect(run.nodes()).toEqual([])
    }
  })

  it('requires tool/call as its starting evidence', () => {
    expect(() => answeredQuestionDefinition.start({} as never,
      { event: toolResult(), id: 'call-1', role: 'start' } as never, {} as never)).toThrow(/requires tool\/call/)
  })

  it('excludes other tools, plan approval, failed results, and non-appended results', () => {
    expect(answeredQuestionDefinition.match(toolCall(undefined, 'exit_plan_mode'))).toBeNull()
    expect(answeredQuestionDefinition.match(toolCall(undefined, 'bash'))).toBeNull()
    expect(answeredQuestionDefinition.match(toolResult(undefined, false, 'replace'))).toBeNull()
    const run = answerAssembler()
    run.assembler.replaceWindow([{ type: 'event', event: toolCall() }, { type: 'event', event: toolResult(undefined, true) }], false)
    run.assembler.flush()
    expect(run.nodes()).toEqual([])
  })
})

const t = makeTranslate(en)
const replyData = (overrides: Partial<QuestionReplyData> = {}): QuestionReplyData => ({
  callId: 'call-1',
  outcome: 'answered',
  questions: [{
    id: 'scope', question: 'Which scope?', header: 'Scope',
  }, { id: 'notes', question: 'Any notes?' }],
  answers: [{ id: 'scope', selected: ['Tool only'], custom: 'note' }, { id: 'notes', selected: [] }],
  text: answered,
  time: 7_000,
  ...overrides,
})

describe('replyAnswerValues', () => {
  it('orders selected labels before a non-blank custom answer', () => {
    const data = replyData()
    expect(replyAnswerValues(data, 'scope')).toEqual(['Tool only', 'note'])
    expect(replyAnswerValues(data, 'notes')).toEqual([])
    expect(replyAnswerValues(data, 'absent')).toEqual([])
    expect(replyAnswerValues(replyData({ answers: [{ id: 'scope', selected: [], custom: '  ' }] }), 'scope')).toEqual([])
    expect(replyAnswerValues(replyData({ answers: [{ id: 'scope', selected: [], custom: 'free text' }] }), 'scope'))
      .toEqual(['free text'])
  })
})

describe('replyClipboardText', () => {
  it('pairs every question with its answer and names the questions the user skipped', () => {
    expect(replyClipboardText(replyData(), t)).toBe(
      'Scope — Which scope?\nAnswer: Tool only, note\n\nAny notes?\nSkipped',
    )
  })

  it('drops a header that repeats its question', () => {
    const data = replyData({
      questions: [{ id: 'scope', question: 'Which scope?', header: 'Which scope?' }],
      answers: [{ id: 'scope', selected: ['Tool only'] }],
    })
    expect(replyClipboardText(data, t)).toBe('Which scope?\nAnswer: Tool only')
  })

  it('falls back to the model-facing text when the payload carried no questions', () => {
    expect(replyClipboardText(replyData({ questions: [], text: 'not json' }), t)).toBe('not json')
  })
})

describe('questionReplyDefinition', () => {
  it('claims only appended user messages carrying the reply source', () => {
    expect(questionReplyDefinition.match(message(replySource('answered'), answered)))
      .toEqual({ id: 'msg-1', role: 'start', exclusive: true })
    expect(questionReplyDefinition.match(message({ kind: 'user' }, answered))).toBeNull()
    expect(questionReplyDefinition.match(message({ kind: 'plugin', plugin: 'user-questions' }, answered))).toBeNull()
    expect(questionReplyDefinition.match(message(replySource('answered'), answered, null))).toBeNull()
  })

  it('claims the message the generic projection also matches, so Chat holds one Node for it', () => {
    const event = message(replySource('answered'), answered)
    expect(messageDefinition.match(event)).toEqual({ id: 'msg-1', role: 'start' })
    let chat: readonly ConversationViewNode[] = []
    const definitions = [messageDefinition, questionReplyDefinition]
    const assembler = new ConversationNodeAssembler(
      { entries: () => definitions, fallbackEntry: () => undefined },
      { entries: () => [{
        target: 'chat',
        create: () => ({
          empty: chat,
          replace: ({ nodes }) => (chat = nodes),
          apply: ({ upserts }) => (chat = [...chat, ...upserts]),
        }),
      }] },
    )
    assembler.activateTarget('chat')
    assembler.replaceWindow([{ type: 'event', event }], false)
    assembler.flush()
    expect(chat.map(node => node.kind)).toEqual(['question-reply'])
  })

  it('projects the outcome from the source and the pairs from the text into its own node', () => {
    const event = message(replySource('answered'), answered)
    const state = questionReplyDefinition.start({} as never, { event, id: 'msg-1', role: 'start' } as never, {} as never)
    expect(state).toMatchObject({
      seq: 7, time: 7_000, callId: 'call-1', outcome: 'answered',
      questions: [{ id: 'scope', question: 'Which scope?' }, { id: 'notes', question: 'Any notes?' }], answers: [{ id: 'scope', selected: ['Tool only'], custom: 'note' }, { id: 'notes', selected: [] }], text: answered,
    })

    const node = questionReplyDefinition.buildViewNode!({ state, key: 'reply:1', id: 'msg-1', start: undefined } as never)
    expect(node).toMatchObject({
      key: 'reply:1', kind: 'question-reply', id: 'msg-1', target: 'chat', anchorSeq: 7, visibility: 'visible',
      location: { kind: 'unresolved' },
      data: { callId: 'call-1', outcome: 'answered', text: answered },
    })
    expect(node).not.toHaveProperty('data.seq')
    expect(questionReplyDefinition.update({ state } as never, {} as never)).toBe(state)
    expect(questionReplyDefinition.buildViewNode!({ state: undefined } as never)).toBeNull()
  })

  it('opens an exchange only for a reply admitted into Step 1', () => {
    const event = message(replySource('answered'), answered)
    const state = questionReplyDefinition.start({} as never, { event, id: 'msg-1', role: 'start' } as never, {} as never)
    for (const step of [1, 2]) {
      const node = questionReplyDefinition.buildViewNode!({
        state, key: 'reply:1', id: 'msg-1', start: { location: { kind: 'step', step: { step } } },
      } as never)
      expect((node as ChatConversationViewNode | null)?.groupTree).toBe(step === 1 ? 'exchange' : 'input')
    }
  })

  it('starts an empty record for a reply without text', () => {
    const untyped = {
      type: 'user/message', seq: SessionSeq(8), time: 8_000, surfaceOp: 'append',
      data: { id: 'msg-2', role: 'user', source: replySource('answered'), content: [{ type: 'image', source: { kind: 'inline', data: '', mediaType: 'image/png' } }] },
    } as never
    const state = questionReplyDefinition.start({} as never, { event: untyped, id: 'msg-2', role: 'start' } as never, {} as never)
    expect(state).toEqual({ seq: 8, time: 8_000, callId: 'call-1', outcome: 'answered', text: '', questions: [], answers: [] })
  })

  it('rejects a reply source without an answered outcome', () => {
    const event = message({ kind: 'user-question-reply', callId: 'call-1' }, answered)
    expect(questionReplyDefinition.match(event)).toBeNull()
    expect(() => questionReplyDefinition.start({} as never, { event, id: 'msg-1', role: 'start' } as never, {} as never)).toThrow(/requires a reply source/)
    expect(() => questionReplyDefinition.start({} as never, {
      event: { ...(event as object), type: 'tool/call' }, id: 'x', role: 'start',
    } as never, {} as never)).toThrow(/requires user\/message/)
  })
})
