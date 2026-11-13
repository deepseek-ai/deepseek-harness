import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { FileAttachmentRef, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { Session, SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import {
  convertConversation, ExportConversationError, IMPORTED_MODEL_SOURCE, messageTime, selectBranch,
} from '../src/conversation.ts'
import type { ExportMessage, ExportSessionFile } from '../src/format.ts'

const BASE = Date.UTC(2026, 10, 11, 2, 0, 0)
const at = (ms: number): string => new Date(BASE + ms).toISOString()

function message(
  id: number,
  parent: number | null,
  role: 'USER' | 'ASSISTANT',
  fragments: Array<Record<string, unknown> & { type: string }>,
  options: { status?: string; time?: number } = {},
): ExportMessage {
  return {
    id, parent_id: parent, role, status: options.status ?? 'FINISHED',
    inserted_at: at(options.time ?? id * 1000), fragments,
  }
}

const ask = (content: string) => ({ type: 'REQUEST', content })
const answer = (content: string) => ({ type: 'RESPONSE', content })
const think = (content: string, elapsed: number | null = null) => ({ type: 'THINK', content, elapsed_secs: elapsed })

function conversation(messages: ExportMessage[], title: string | null = 'Original title'): ExportSessionFile {
  return { id: 'conversation-1', title, inserted_at: at(0), messages }
}

function counter(): () => string {
  let next = 0
  return () => `id-${++next}`
}

function convert(file: ExportSessionFile, images?: ReadonlyMap<string, ImageAttachmentRef>) {
  return convertConversation(file, { createId: counter(), maxTitleBytes: 80, ...images === undefined ? {} : { images } })
}

/** Validate through the same seed checks as a live Session and project model history. */
function history(events: readonly SessionEvent[]) {
  const id = SessionId('imported')
  const session = Session.create(id, events, {
    version: SESSION_FORMAT_VERSION, id, createdAt: events[0]?.time ?? 0, cwd: '/tmp/imported', isSeeded: false,
  })
  return session.deriveMessages().map(({ role, content }) => ({ role, content }))
}

function types(events: readonly SessionEvent[]): string[] {
  return events.map(event => event.type)
}

function resultText(content: readonly ContentBlock[] | undefined): string {
  const block = content?.[0]
  return block?.type === 'text' ? block.text : ''
}

function turnEnds(events: readonly SessionEvent[]) {
  return events.flatMap(event => event.type === 'turn/end' ? [event.data.reason] : [])
}

/** The synthetic reference of an exported file whose bytes are not stored: deterministic in the export file id. */
function syntheticFile(fileId: string, name: string, bytes: number): FileAttachmentRef {
  const digest = createHash('sha256').update(`deepseek-chat-export:${fileId}`).digest('hex')
  return { attachmentId: AttachmentId(`sha256:${digest}`), name, bytes }
}

describe('selectBranch', () => {
  it('follows the greatest message id when current_message_id is absent', () => {
    const file = conversation([
      message(1, null, 'USER', [ask('q1')]),
      message(2, 1, 'ASSISTANT', [answer('a1')]),
      message(3, 2, 'USER', [ask('q2')]),
      message(4, 3, 'ASSISTANT', [answer('a2')], { time: 99_000 }),
      message(5, 2, 'USER', [ask('q2 edited')]),
      message(6, 5, 'ASSISTANT', [answer('a2 edited')]),
    ])
    expect(selectBranch(file).map(item => item.id)).toEqual([1, 2, 5, 6])
    expect(selectBranch(conversation([...file.messages].reverse())).map(item => item.id)).toEqual([1, 2, 5, 6])
  })

  it('follows current_message_id into another branch and falls back when it names nothing', () => {
    const messages = [
      message(1, null, 'USER', [ask('q1')]),
      message(2, 1, 'ASSISTANT', [answer('a1')]),
      message(3, 2, 'USER', [ask('q2')]),
      message(4, 3, 'ASSISTANT', [answer('a2')]),
      message(5, 2, 'USER', [ask('q2 edited')]),
      message(6, 5, 'ASSISTANT', [answer('a2 edited')]),
    ]
    expect(selectBranch({ ...conversation(messages), current_message_id: 4 }).map(item => item.id)).toEqual([1, 2, 3, 4])
    expect(selectBranch({ ...conversation(messages), current_message_id: 2 }).map(item => item.id)).toEqual([1, 2])
    expect(selectBranch({ ...conversation(messages), current_message_id: null }).map(item => item.id)).toEqual([1, 2, 5, 6])
    expect(selectBranch({ ...conversation(messages), current_message_id: 99 }).map(item => item.id)).toEqual([1, 2, 5, 6])
  })

  it('rejects trees it cannot linearize', () => {
    expect(() => selectBranch(conversation([]))).toThrow(new ExportConversationError('conversation has no messages'))
    expect(() => selectBranch(conversation([message(1, null, 'USER', []), message(1, null, 'USER', [])])))
      .toThrow('duplicate message id 1')
    expect(() => selectBranch({ ...conversation([message(2, 7, 'USER', [])]), current_message_id: 2 }))
      .toThrow('message parent 7 does not exist')
    expect(() => selectBranch(conversation([message(1, 2, 'USER', []), message(2, 1, 'ASSISTANT', [])])))
      .toThrow('message 2 is part of a parent cycle')
    expect(() => selectBranch({ ...conversation([message(1, 2, 'USER', []), message(2, 1, 'ASSISTANT', [])]), current_message_id: 1 }))
      .toThrow('message 1 is part of a parent cycle')
  })
})

describe('messageTime', () => {
  it('reads RFC 3339 timestamps with any fractional precision', () => {
    expect(messageTime({ ...message(1, null, 'USER', []), inserted_at: '2026-11-11T02:33:23Z' })).toBe(Date.UTC(2026, 10, 11, 2, 33, 23))
    expect(messageTime({ ...message(1, null, 'USER', []), inserted_at: '2026-11-11T02:33:23.123456789Z' }))
      .toBe(Date.UTC(2026, 10, 11, 2, 33, 23, 123))
    expect(() => messageTime({ ...message(1, null, 'USER', []), inserted_at: 'yesterday' }))
      .toThrow('message 1 has an invalid inserted_at')
  })
})

describe('convertConversation', () => {
  it('maps questions, reasoning, and answers to completed turns with the original title and times', () => {
    const converted = convert(conversation([
      message(1, null, 'USER', [ask('What is 2 + 2?')], { time: 1_000 }),
      // The export stamps a reply a few milliseconds before its question.
      message(2, 1, 'ASSISTANT', [think('Add them.', 1.5), answer('4')], { time: 995 }),
      message(3, 2, 'USER', [ask('And 3 + 3?')], { time: 5_000 }),
      message(4, 3, 'ASSISTANT', [answer('6')], { time: 5_000 }),
    ]))
    expect(converted.title).toBe('Original title')
    expect(converted.createdAt).toBe(BASE + 1_000)
    expect(types(converted.events)).toEqual([
      'turn/start', 'step/start', 'system/message', 'user/message', 'assistant/message', 'step/end', 'turn/end', 'session/title',
      'turn/start', 'step/start', 'user/message', 'assistant/message', 'step/end', 'turn/end',
    ])
    expect(converted.events.map(event => event.seq)).toEqual(converted.events.map((_, index) => index))
    expect(converted.events.map(event => event.time - BASE)).toEqual([
      1_000, 1_000, 1_000, 1_000, 2_500, 2_500, 2_500, 2_500,
      5_000, 5_000, 5_000, 5_000, 5_000, 5_000,
    ])
    // An empty system head holds surface node 0 and adds nothing to model history.
    expect(converted.events[2]).toMatchObject({
      type: 'system/message', surfaceOp: 'append', data: { turn: 1, step: 1, message: { role: 'system', content: [], source: { kind: 'system-prompt' } } },
    })
    expect(converted.events.find(event => event.type === 'session/title')?.data)
      .toEqual({ title: 'Original title', messageSeqs: [], source: { kind: 'user' } })
    expect(turnEnds(converted.events)).toEqual([{ kind: 'completed' }, { kind: 'completed' }])
    const assistant = converted.events.find(event => event.type === 'assistant/message')
    expect(assistant?.data).toMatchObject({ turn: 1, step: 1, stream: [], message: { source: { kind: 'model', ...IMPORTED_MODEL_SOURCE } } })
    expect(history(converted.events)).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'What is 2 + 2?' }] },
      { role: 'assistant', content: [{ type: 'reasoning', text: 'Add them.' }, { type: 'text', text: '4' }] },
      { role: 'user', content: [{ type: 'text', text: 'And 3 + 3?' }] },
      { role: 'assistant', content: [{ type: 'text', text: '6' }] },
    ])
  })

  it('ignores empty text and fragments that do not belong to the message role', () => {
    const converted = convert(conversation([
      message(1, null, 'USER', [think('stray'), ask('q')]),
      message(2, 1, 'ASSISTANT', [think(''), ask('stray request'), { type: 'FILE', files: [] }, answer(''), answer('a')]),
    ]))
    expect(history(converted.events)).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'q' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'a' }] },
    ])
  })

  it('omits the title event for a missing or blank title', () => {
    const turn = [message(1, null, 'USER', [ask('q')]), message(2, 1, 'ASSISTANT', [answer('a')])]
    expect(types(convert(conversation(turn, null)).events)).not.toContain('session/title')
    expect(convert(conversation(turn, '  ')).title).toBeNull()
    expect(types(convert(conversation(turn, '\n\t ')).events)).not.toContain('session/title')
  })

  it('collapses whitespace in the title and truncates it to the UTF-8 byte limit', () => {
    const turn = [message(1, null, 'USER', [ask('q')]), message(2, 1, 'ASSISTANT', [answer('a')])]
    const converted = convert(conversation(turn, `  Trip\n\nplan\tfor ${'汉'.repeat(40)}  `))
    // 'Trip plan for ' is 14 bytes; each Han character is 3 bytes, so 22 fit in the remaining 66.
    expect(converted.title).toBe(`Trip plan for ${'汉'.repeat(22)}`)
    expect(converted.events.find(event => event.type === 'session/title')?.data).toMatchObject({ title: converted.title })
  })

  it('writes one empty text block for a user message without content, in the first turn and later', () => {
    const converted = convert(conversation([
      message(1, null, 'USER', [ask('  ')]),
      message(2, 1, 'ASSISTANT', [answer('a1')]),
      message(3, 2, 'USER', [{ type: 'FILE', files: [] }]),
      message(4, 3, 'ASSISTANT', [answer('a2')]),
      message(5, 4, 'USER', []),
      message(6, 5, 'ASSISTANT', [answer('a3')]),
    ]))
    // Seed validation and the model-history projection accept the empty block.
    expect(history(converted.events)).toEqual([
      { role: 'user', content: [{ type: 'text', text: '' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'a1' }] },
      { role: 'user', content: [{ type: 'text', text: '' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'a2' }] },
      { role: 'user', content: [{ type: 'text', text: '' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'a3' }] },
    ])
    expect(JSON.stringify(converted.events)).not.toContain('[empty message]')
  })

  it('replays searches and opened pages as web tool steps split at later reasoning', () => {
    const converted = convert(conversation([
      message(1, null, 'USER', [ask('Find a bus route')]),
      message(2, 1, 'ASSISTANT', [
        think('Search first.', 1),
        {
          type: 'TOOL_SEARCH', queries: ['bus route', ' '],
          results: [
            { url: 'https://a.example/route', title: 'Route A', snippet: 'Take bus 1', published_at: '2025-11-24T16:00:00.000Z', site_name: 'A' },
            { url: 'https://b.example/', title: null, snippet: '', published_at: null, site_name: null },
          ],
        },
        think('Open the best results.', 2),
        { type: 'TOOL_OPEN', status: 'FINISHED', url: 'https://a.example/route', title: 'Route A', published_at: null },
        { type: 'TOOL_OPEN', status: 'FAILED', url: 'https://c.example/', title: null, published_at: null },
        { type: 'TOOL_OPEN', status: 'WIP', url: 'https://d.example/', title: null, published_at: null },
        think('Pages loaded.', 3),
        { type: 'TOOL_OPEN', status: 'FINISHED', url: null, title: null, published_at: null },
        { type: 'TOOL_SEARCH', queries: [' '], results: [] },
        think('Summarize.'),
        answer('Take bus 1.'),
      ]),
    ]))
    expect(types(converted.events)).toEqual([
      'turn/start', 'step/start', 'system/message', 'user/message',
      'assistant/message', 'tool/call', 'tool/result', 'step/end',
      'step/start', 'assistant/message', 'tool/call', 'tool/call', 'tool/result', 'tool/result', 'step/end',
      'step/start', 'assistant/message', 'step/end', 'turn/end', 'session/title',
    ])
    const assistants = converted.events.flatMap(event => event.type === 'assistant/message' ? [event.data] : [])
    expect(assistants.map(data => data.step)).toEqual([1, 2, 3])
    // The address-less open and the blank-query search replay as nothing.
    expect(assistants[2]?.message.content).toEqual([
      { type: 'reasoning', text: 'Pages loaded.' },
      { type: 'reasoning', text: 'Summarize.' },
      { type: 'text', text: 'Take bus 1.' },
    ])
    const calls = converted.events.flatMap(event => event.type === 'tool/call' ? [event] : [])
    expect(calls.map(({ data }) => [data.name, data.arguments])).toEqual([
      ['web_search', '{"queries":["bus route"]}'],
      ['web_fetch', '{"url":"https://a.example/route"}'],
      ['web_fetch', '{"url":"https://c.example/"}'],
    ])
    expect(assistants.flatMap(data => data.message.content.flatMap(block => block.type === 'tool-call' ? [block.id] : [])))
      .toEqual(calls.map(({ data }) => data.callId))
    const results = converted.events.flatMap(event => event.type === 'tool/result' ? [event] : [])
    expect(results.map(result => result.sourceEventSeqs)).toEqual(calls.map(call => [call.seq]))
    expect(results.map(({ data }) => [data.message.toolCallId, data.message.isError]))
      .toEqual(calls.map(({ data }, index) => [data.callId, index === 2]))
    expect(results[0]?.data.meta).toEqual({
      sources: [
        { url: 'https://a.example/route', title: 'Route A', snippet: 'Take bus 1', publishedAt: '2025-11-24T16:00:00.000Z' },
        { url: 'https://b.example/' },
      ],
      truncated: false,
    })
    expect(resultText(results[0]?.data.message.content)).toContain('- [Route A](https://a.example/route) — Take bus 1')
    expect(results[1]?.data.meta).toEqual({ url: 'https://a.example/route', statusCode: 200, truncated: false })
    expect(resultText(results[1]?.data.message.content)).toContain('Route A\n\nThe page content is not included in the DeepSeek chat export.')
    expect(results[2]?.data).not.toHaveProperty('meta')
    expect(results[2]?.data.message.content).toEqual([{ type: 'text', text: 'Error: the page could not be opened.' }])
    expect(converted.events.map(event => event.time - BASE).filter((time, index, all) => time !== all[index - 1]))
      .toEqual([1_000, 3_000, 5_000, 8_000])
    expect(history(converted.events).map(item => item.role)).toEqual(['user', 'assistant', 'tool', 'assistant', 'tool', 'tool', 'assistant'])
  })

  it('splits steps at a stage_id change and keeps one stage in one step', () => {
    const converted = convert(conversation([
      message(1, null, 'USER', [ask('q')]),
      message(2, 1, 'ASSISTANT', [
        think('Search first.', 1),
        { type: 'TOOL_SEARCH', queries: ['bus'], results: [], status: 'FINISHED', stage_id: 1 },
        { type: 'TOOL_OPEN', status: 'FINISHED', url: 'https://a.example/', title: null, stage_id: 2 },
        { type: 'TOOL_OPEN', status: 'FINISHED', url: 'https://b.example/', title: null, stage_id: 2 },
        { type: 'TOOL_FIND', status: 'NO_RESULT', pattern: 'invoice', stage_id: 3 },
        answer('done'),
      ]),
    ]))
    const assistants = converted.events.flatMap(event => event.type === 'assistant/message' ? [event.data] : [])
    expect(assistants.map(data => data.step)).toEqual([1, 2, 3])
    expect(assistants.map(data => data.message.content.map((block) => {
      if (block.type === 'tool-call') return `${block.name} ${block.arguments}`
      return block.type === 'text' ? block.text : block.type
    }))).toEqual([
      ['reasoning', 'web_search {"queries":["bus"]}'],
      ['web_fetch {"url":"https://a.example/"}', 'web_fetch {"url":"https://b.example/"}'],
      // The page find replays as nothing; the answer alone opens the last step.
      ['done'],
    ])
    const calls = converted.events.flatMap(event => event.type === 'tool/call' ? [event.data] : [])
    expect(calls.map(call => [call.step, call.name])).toEqual([[1, 'web_search'], [2, 'web_fetch'], [2, 'web_fetch']])
    expect(history(converted.events).map(item => item.role))
      .toEqual(['user', 'assistant', 'tool', 'assistant', 'tool', 'tool', 'assistant'])
  })

  it('keeps a step holding only text open until the next staged call joins it', () => {
    const converted = convert(conversation([
      message(1, null, 'USER', [ask('q')]),
      message(2, 1, 'ASSISTANT', [
        think('Read the link first.', 1),
        { type: 'READ_LINK', results: [{ url: 'https://a.example/bus', title: 'Bus lines', signature: 'secret' }] },
        { type: 'TOOL_SEARCH', queries: ['bus'], results: [], status: 'FINISHED', stage_id: 2 },
        { type: 'TOOL_OPEN', status: 'FINISHED', url: 'https://a.example/bus', title: 'Bus lines', stage_id: 3 },
        answer('Take bus 1.'),
      ]),
    ]))
    const assistants = converted.events.flatMap(event => event.type === 'assistant/message' ? [event.data] : [])
    expect(assistants.map(data => data.step)).toEqual([1, 2, 3])
    expect(assistants[0]?.message.content).toEqual([
      { type: 'reasoning', text: 'Read the link first.' },
      { type: 'text', text: '[Bus lines](https://a.example/bus)' },
      expect.objectContaining({ type: 'tool-call', name: 'web_search' }),
    ])
    expect(assistants[1]?.message.content).toEqual([expect.objectContaining({ type: 'tool-call', name: 'web_fetch' })])
    // A call-less step that is not last would put two assistant messages in a row.
    const roles = history(converted.events).map(item => item.role)
    expect(roles).toEqual(['user', 'assistant', 'tool', 'assistant', 'tool', 'assistant'])
    expect(roles.filter((role, index) => role === 'assistant' && roles[index - 1] === 'assistant')).toEqual([])
  })

  it('replays a failed search as an error, skips an unfinished one, and defaults a missing status to finished', () => {
    const converted = convert(conversation([
      message(1, null, 'USER', [ask('q')]),
      message(2, 1, 'ASSISTANT', [
        { type: 'TOOL_SEARCH', queries: ['worked'], results: [], status: 'FINISHED' },
        { type: 'TOOL_SEARCH', queries: ['broken'], results: [], status: 'FAILED' },
        { type: 'TOOL_SEARCH', queries: ['unfinished'], results: [], status: 'WIP' },
        { type: 'TOOL_SEARCH', queries: ['legacy'], results: [] },
        answer('a'),
      ]),
    ]))
    const calls = converted.events.flatMap(event => event.type === 'tool/call' ? [event] : [])
    expect(calls.map(({ data }) => data.arguments)).toEqual([
      '{"queries":["worked"]}', '{"queries":["broken"]}', '{"queries":["legacy"]}',
    ])
    const results = converted.events.flatMap(event => event.type === 'tool/result' ? [event.data] : [])
    expect(results.map(result => result.message.isError)).toEqual([false, true, false])
    expect(resultText(results[1]?.message.content)).toBe('Error: the export records this search as failed.')
    expect(results[1]).not.toHaveProperty('meta')
    expect(turnEnds(converted.events)).toEqual([{ kind: 'completed' }])
  })

  it('replays nothing for notices the website shows outside the reply and writes read links as Markdown', () => {
    const converted = convert(conversation([
      message(1, null, 'USER', [ask('q')]),
      message(2, 1, 'ASSISTANT', [
        think('Read the links.'),
        { type: 'PARTIAL_FILE_READ', ratio: 58.7599211387782 },
        { type: 'TIP', content: 'Expert reading links are unavailable.', style: 'INFO' },
        { type: 'TIP', content: '' },
        { type: 'TOOL_FIND', status: 'FINISHED' },
        { type: 'TOOL_FIND', status: 'NO_RESULT', pattern: 'invoice', stage_id: 1 },
        {
          type: 'READ_LINK',
          results: [
            { url: 'https://example.com/a', title: 'Page A', signature: 'secret' },
            { url: 'https://example.com/b', title: null },
            { url: '  ', title: 'Titled' },
            { url: null, title: null },
          ],
        },
        { type: 'READ_LINK', results: [{ url: null, title: null }] },
        { type: 'READ_LINK', results: [] },
        { type: 'CONTENT_RISK', content: 'AI-generated', style: 'WARNING' },
        answer('done'),
      ]),
    ]))
    expect(types(converted.events)).not.toContain('tool/call')
    // Each record keeps its own text block; one line per result named by url or title.
    expect(history(converted.events)[1]?.content).toEqual([
      { type: 'reasoning', text: 'Read the links.' },
      { type: 'text', text: '[Page A](https://example.com/a)\n[https://example.com/b](https://example.com/b)\nTitled' },
      { type: 'text', text: 'done' },
    ])
    expect(JSON.stringify(converted.events)).not.toMatch(/\[(?:partial read|tip|find in page|link):/u)
  })

  it('writes nothing for a reply holding only records the website shows outside the reply', () => {
    const converted = convert(conversation([
      message(1, null, 'USER', [ask('q')]),
      message(2, 1, 'ASSISTANT', [
        { type: 'PARTIAL_FILE_READ', ratio: 100 },
        { type: 'TIP', content: 'notice' },
        { type: 'TOOL_FIND', status: 'FINISHED', pattern: 'x' },
        { type: 'READ_LINK', results: [{ url: '', title: '' }] },
      ]),
    ]))
    expect(types(converted.events)).not.toContain('assistant/message')
    expect(turnEnds(converted.events)).toEqual([
      { kind: 'error', error: { code: 'DEEPSEEK_EXPORT_EMPTY_REPLY', message: 'The original reply has no importable content.' } },
    ])
  })

  it('replays nothing for an image search or an opened page without an address', () => {
    const converted = convert(conversation([
      message(1, null, 'USER', [ask('What is this?')]),
      message(2, 1, 'ASSISTANT', [
        think('Search by image.', 1),
        {
          type: 'TOOL_IMAGE_SEARCH', status: 'FINISHED', stage_id: 1,
          results: [{ title: 'Scarlet macaw', source_page_url: 'https://a.example/macaw', snippet: 'A large red parrot', site_name: null, published_at: null }],
        },
        think('Open the best page.', 2),
        { type: 'TOOL_OPEN', status: 'FINISHED', url: 'https://a.example/macaw', title: 'Scarlet macaw', stage_id: 2 },
        // The exporter writes one all-null open beside the real opens of a stage.
        { type: 'TOOL_OPEN', status: 'FINISHED', url: null, title: null, snippet: null, site_name: null, published_at: null, stage_id: 2, group_id: 1 },
        { type: 'TOOL_OPEN', status: 'FAILED', url: '', title: null, stage_id: 2 },
        { type: 'TOOL_IMAGE_SEARCH', status: 'FAILED', results: [], stage_id: 3 },
        { type: 'TOOL_IMAGE_SEARCH', status: 'WIP', results: [], stage_id: 3 },
        { type: 'TOOL_IMAGE_SEARCH', status: 'FINISHED', results: [{ title: 'legacy result' }] },
        answer('A scarlet macaw.'),
      ]),
    ]))
    const calls = converted.events.flatMap(event => event.type === 'tool/call' ? [event.data] : [])
    expect(calls.map(call => [call.step, call.name, call.arguments])).toEqual([[1, 'web_fetch', '{"url":"https://a.example/macaw"}']])
    // The reasoning before the page open joins its step: the image search opened none of its own.
    expect(history(converted.events).map(item => item.role)).toEqual(['user', 'assistant', 'tool', 'assistant'])
    expect(history(converted.events)[1]?.content).toEqual([
      { type: 'reasoning', text: 'Search by image.' },
      { type: 'reasoning', text: 'Open the best page.' },
      expect.objectContaining({ type: 'tool-call', name: 'web_fetch' }),
    ])
    expect(history(converted.events)[3]?.content).toEqual([{ type: 'text', text: 'A scarlet macaw.' }])
    expect(turnEnds(converted.events)).toEqual([{ kind: 'completed' }])
  })

  it('opens a fetch call without a title and searches without results', () => {
    const converted = convert(conversation([
      message(1, null, 'USER', [ask('q')]),
      message(2, 1, 'ASSISTANT', [
        { type: 'TOOL_SEARCH', queries: ['nothing'], results: [] },
        { type: 'TOOL_OPEN', status: 'FINISHED', url: 'https://e.example/' },
      ]),
    ]))
    const results = converted.events.flatMap(event => event.type === 'tool/result' ? [event.data] : [])
    expect(resultText(results[0]?.message.content)).toContain('No results found.')
    expect(resultText(results[1]?.message.content)).toContain('https://e.example/')
    expect(resultText(results[1]?.message.content)).not.toContain('undefined')
    expect(turnEnds(converted.events)).toEqual([{ kind: 'completed' }])
  })

  it('keeps the question but excludes failed and templated replies from model history', () => {
    const converted = convert(conversation([
      message(1, null, 'USER', [ask('q1')]),
      message(2, 1, 'ASSISTANT', [answer('broken')], { status: 'FAILED' }),
      message(3, 2, 'USER', [ask('q2')]),
      message(4, 3, 'ASSISTANT', [think('partial'), answer('half')], { status: 'INCOMPLETE' }),
      message(5, 4, 'USER', [ask('q3')]),
      message(6, 5, 'ASSISTANT', [{ type: 'TEMPLATE_RESPONSE', content: 'The server is busy. Please try again later.' }]),
      message(7, 6, 'USER', [ask('q4')]),
      message(8, 7, 'ASSISTANT', [{ type: 'READ_LINK', results: [{ signature: 'secret' }] }, { type: 'CONTENT_RISK', content: 'AI-generated', style: 'WARNING' }]),
      message(9, 8, 'USER', [ask('q5')]),
    ]))
    expect(types(converted.events)).not.toContain('assistant/message')
    expect(turnEnds(converted.events)).toEqual([
      {
        kind: 'error',
        error: { code: 'DEEPSEEK_EXPORT_FAILED', message: 'The original reply ended with status "FAILED" and is excluded from the model context.' },
      },
      {
        kind: 'error',
        error: { code: 'DEEPSEEK_EXPORT_INCOMPLETE', message: 'The original reply ended with status "INCOMPLETE" and is excluded from the model context.' },
      },
      { kind: 'error', error: { code: 'DEEPSEEK_EXPORT_TEMPLATE_RESPONSE', message: 'The server is busy. Please try again later.' } },
      { kind: 'error', error: { code: 'DEEPSEEK_EXPORT_EMPTY_REPLY', message: 'The original reply has no importable content.' } },
      { kind: 'error', error: { code: 'DEEPSEEK_EXPORT_NO_REPLY', message: 'The export contains no reply to this message.' } },
    ])
    expect(history(converted.events)).toEqual(['q1', 'q2', 'q3', 'q4', 'q5'].map(text => ({ role: 'user', content: [{ type: 'text', text }] })))
  })

  it('maps an unrecognized status to one fixed code and names it only in the message', () => {
    const converted = convert(conversation([
      message(1, null, 'USER', [ask('q')]),
      message(2, 1, 'ASSISTANT', [answer('a')], { status: 'constructor' }),
    ]))
    expect(turnEnds(converted.events)).toEqual([{
      kind: 'error',
      error: { code: 'DEEPSEEK_EXPORT_UNFINISHED_REPLY', message: 'The original reply ended with status "constructor" and is excluded from the model context.' },
    }])
  })

  it('leaves out a question together with its reply withdrawn by content filtering', () => {
    const converted = convert(conversation([
      message(1, null, 'USER', [ask('withdrawn first')]),
      message(2, 1, 'ASSISTANT', [answer('withdrawn text')], { status: 'CONTENT_FILTER' }),
      message(3, 2, 'USER', [ask('q2')]),
      message(4, 3, 'ASSISTANT', [answer('a2')]),
      message(5, 4, 'USER', [ask('withdrawn later')]),
      message(6, 5, 'ASSISTANT', [answer('withdrawn again')], { status: 'CONTENT_FILTER' }),
      message(7, 6, 'USER', [ask('q4')]),
      message(8, 7, 'ASSISTANT', [answer('a4')]),
    ]))
    expect(JSON.stringify(converted.events)).not.toContain('withdrawn')
    expect(converted.events.flatMap(event => event.type === 'turn/start' ? [event.data.turn] : [])).toEqual([1, 2])
    expect(turnEnds(converted.events)).toEqual([{ kind: 'completed' }, { kind: 'completed' }])
    expect(converted.createdAt).toBe(BASE + 3000)
    expect(history(converted.events).map(item => resultText(item.content))).toEqual(['q2', 'a2', 'q4', 'a4'])
    expect(() => convert(conversation([
      message(1, null, 'USER', [ask('q')]),
      message(2, 1, 'ASSISTANT', [answer('a')], { status: 'CONTENT_FILTER' }),
    ]))).toThrow(new ExportConversationError('every question of the conversation was withdrawn by content filtering'))
  })

  it('writes synthetic file cards for files whose bytes are not stored and image blocks for saved images', () => {
    const files = {
      type: 'FILE',
      files: [
        { id: 'img-1', file_name: 'chart.png', file_size: 10, token_usage: 5, inserted_at: at(0), export_path: 'chat_sessions/c_files/img-1-chart.png', is_image: true, width: 2, height: 2 },
        { id: 'img-2', file_name: 'lost.png', file_size: 12, token_usage: 5, inserted_at: at(0), export_path: null, is_image: true, width: 2, height: 2 },
        { id: 'doc-1', file_name: 'report.pdf', file_size: 2048, token_usage: 5, inserted_at: at(0), export_path: null, is_image: false, width: null, height: null },
      ],
    }
    const file = conversation([message(1, null, 'USER', [files, ask('Explain these')]), message(2, 1, 'ASSISTANT', [answer('ok')])])
    const lost = syntheticFile('img-2', 'lost.png', 12)
    const report = syntheticFile('doc-1', 'report.pdf', 2048)
    expect(report.attachmentId).toBe(`sha256:${createHash('sha256').update('deepseek-chat-export:doc-1').digest('hex')}`)
    // Without a stored image every file is a card; the ids are deterministic in the export file ids.
    expect(history(convert(file).events)[0]).toEqual({
      role: 'user',
      content: [
        { type: 'file', attachment: syntheticFile('img-1', 'chart.png', 10) },
        { type: 'file', attachment: lost },
        { type: 'file', attachment: report },
        { type: 'text', text: 'Explain these' },
      ],
    })
    const image: ImageAttachmentRef = {
      attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`), mediaType: 'image/png', bytes: 10, width: 2, height: 2, name: 'chart.png',
    }
    // A stored image replaces its card; a stored reference under a non-image id is ignored.
    expect(history(convert(file, new Map([['img-1', image], ['doc-1', image]])).events)[0]).toEqual({
      role: 'user',
      content: [
        { type: 'image', attachment: image },
        { type: 'file', attachment: lost },
        { type: 'file', attachment: report },
        { type: 'text', text: 'Explain these' },
      ],
    })
    const imageOnly = conversation([message(1, null, 'USER', [{ type: 'FILE', files: [files.files[0]] }])])
    expect(history(convert(imageOnly, new Map([['img-1', image]])).events)[0]?.content).toEqual([{ type: 'image', attachment: image }])
    const cardOnly = conversation([message(1, null, 'USER', [{ type: 'FILE', files: [files.files[2]] }])])
    expect(history(convert(cardOnly).events)[0]?.content).toEqual([{ type: 'file', attachment: report }])
  })

  it('names a synthetic file card by the sanitized leaf name and defaults a missing size to zero', () => {
    const entry = (id: string, file_name: string, size?: number) => ({
      id, file_name, is_image: false, export_path: null, ...size === undefined ? {} : { file_size: size },
    })
    const converted = convert(conversation([message(1, null, 'USER', [{
      type: 'FILE',
      files: [entry('old-1', 'legacy.txt'), entry('path-1', 'C:\\Users\\me\\Desktop\\notes.md', 7), entry('ctl-1', 'bad\u0000name.csv', 3), entry('blank-1', ' \u001f ', 1)],
    }])]))
    const refs = history(converted.events)[0]?.content.flatMap(block => block.type === 'file' ? [block.attachment] : [])
    expect(refs).toEqual([
      syntheticFile('old-1', 'legacy.txt', 0),
      syntheticFile('path-1', 'notes.md', 7),
      syntheticFile('ctl-1', 'badname.csv', 3),
      syntheticFile('blank-1', 'file', 1),
    ])
  })

  it('drops a reply without a preceding question and requires at least one question', () => {
    const converted = convert(conversation([
      message(1, null, 'ASSISTANT', [answer('greeting')]),
      message(2, 1, 'USER', [ask('q')]),
      message(3, 2, 'ASSISTANT', [answer('a')]),
    ]))
    expect(history(converted.events).map(item => item.content)).toEqual([[{ type: 'text', text: 'q' }], [{ type: 'text', text: 'a' }]])
    expect(() => convert(conversation([message(1, null, 'ASSISTANT', [answer('alone')])])))
      .toThrow(new ExportConversationError('conversation has no user message'))
  })

  it('rejects a malformed mapped fragment and an invalid message time', () => {
    expect(() => convert(conversation([message(1, null, 'USER', [{ type: 'REQUEST', content: 42 }])])))
      .toThrow('message 1 fragment 0 (REQUEST) is malformed')
    expect(() => convert(conversation([{ ...message(1, null, 'USER', [ask('q')]), inserted_at: 'never' }])))
      .toThrow('message 1 has an invalid inserted_at')
  })
})
