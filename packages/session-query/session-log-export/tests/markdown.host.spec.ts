import { describe, expect, it } from 'vitest'
import type { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { ContentBlock, MessageId, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, SessionSeq } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-title'
import { brandNumber, brandString } from '@deepseek-ai/dsh-brand'
import { formatSessionMarkdown } from '../src/markdown.ts'

const messageId = (value: string): MessageId => brandString<MessageId>(value)
const callId = (value: string): ToolCallId => brandString<ToolCallId>(value)
const attachmentId = (value: string): AttachmentId => brandString<AttachmentId>(value)
const sequence = (value: number): SessionSeq => brandNumber<SessionSeq>(value)

function titleEvent(seq: number, title: string): SessionEvent<'session/title'> {
  return {
    type: 'session/title',
    seq: sequence(seq),
    time: seq,
    data: { title, messageSeqs: [], source: { kind: 'fallback' } },
  }
}

function renderWithTitle(input: {
  readonly title: string | undefined
  readonly events: readonly SessionEvent[]
}): string {
  return formatSessionMarkdown(input.title === undefined
    ? input.events
    : [titleEvent(0, input.title), ...input.events])
}

function start(seq: number, turn: number): SessionEvent<'turn/start'> {
  return { type: 'turn/start', seq: sequence(seq), time: seq, data: { turn } }
}

function end(seq: number, turn: number): SessionEvent<'turn/end'> {
  return { type: 'turn/end', seq: sequence(seq), time: seq, data: { turn, reason: { kind: 'completed' } } }
}

function user(seq: number, text: string, kind: 'user' | 'injected' = 'user'): SessionEvent<'user/message'> {
  return {
    type: 'user/message',
    seq: sequence(seq),
    time: seq,
    surfaceOp: 'append',
    data: {
      role: 'user',
      id: messageId(`user-${String(seq)}`),
      source: kind === 'user' ? { kind: 'user' } : { kind: 'model', provider: 'test', model: 'test' },
      content: [{ type: 'text', text }],
    },
  }
}

function userWithAttachments(seq: number): SessionEvent<'user/message'> {
  const content: ContentBlock[] = [
    { type: 'text', text: 'See the attachments.' },
    {
      type: 'image',
      attachment: {
        attachmentId: attachmentId('img-secret-1'),
        mediaType: 'image/png',
        bytes: 123,
        width: 640,
        height: 480,
        name: 'diagram.png',
      },
    },
    {
      type: 'file',
      attachment: { attachmentId: attachmentId('file-secret-1'), name: 'notes.txt', bytes: 42 },
    },
  ]
  return {
    type: 'user/message',
    seq: sequence(seq),
    time: seq,
    surfaceOp: 'append',
    data: { role: 'user', id: messageId(`user-${String(seq)}`), source: { kind: 'user' }, content },
  }
}

function userBlocks(seq: number, content: ContentBlock[]): SessionEvent<'user/message'> {
  return {
    type: 'user/message',
    seq: sequence(seq),
    time: seq,
    surfaceOp: 'append',
    data: { role: 'user', id: messageId(`user-${String(seq)}`), source: { kind: 'user' }, content },
  }
}

function assistant(seq: number, content: ContentBlock[], turn = 1): SessionEvent<'assistant/message'> {
  return {
    type: 'assistant/message',
    seq: sequence(seq),
    time: seq,
    surfaceOp: 'append',
    data: {
      turn,
      step: 1,
      message: {
        role: 'assistant',
        id: messageId(`assistant-${String(seq)}`),
        source: { kind: 'model', provider: 'test', model: 'test' },
        content,
      },
      stream: [],
    },
  }
}

function toolCall(seq: number, id: string, name: string, argumentsText: string): SessionEvent<'tool/call'> {
  return {
    type: 'tool/call',
    seq: sequence(seq),
    time: seq,
    data: { turn: 1, step: 1, callId: callId(id), name, arguments: argumentsText },
  }
}

function toolResult(
  seq: number,
  id: string,
  content: ContentBlock[],
  options: { readonly isError?: boolean; readonly reason?: string } = {},
): SessionEvent<'tool/result'> {
  return {
    type: 'tool/result',
    seq: sequence(seq),
    time: seq,
    surfaceOp: 'append',
    data: {
      turn: 1,
      step: 1,
      message: {
        role: 'tool',
        id: messageId(`result-${String(seq)}`),
        source: { kind: 'tool', callId: callId(id) },
        toolCallId: callId(id),
        content,
        ...options.isError === true ? { isError: true } : {},
      },
      ...options.reason === undefined
        ? {}
        : { error: { name: 'ToolError', code: 'TOOL_FAILED', reason: options.reason } },
    },
  }
}

function text(value: string): ContentBlock {
  return { type: 'text', text: value }
}

describe('formatSessionMarkdown', () => {

  it('selects the latest real session/title event and treats missing or blank titles as untitled', () => {
    const events = [
      titleEvent(0, 'Old title'),
      start(1, 1),
      user(2, 'Question'),
      titleEvent(3, 'Latest title'),
      assistant(4, [text('Answer')]),
      end(5, 1),
    ]
    expect(formatSessionMarkdown(events)).toContain('# Latest title')
    expect(formatSessionMarkdown(events)).not.toContain('# Old title')

    const blank = [titleEvent(0, '   '), start(1, 1), user(2, 'Question'), end(3, 1)]
    expect(formatSessionMarkdown(blank)).toBe('# Untitled Session\n\n> Question\n')
    expect(formatSessionMarkdown([])).toBe('# Untitled Session\n')
  })


  it('emits an exact fenced source path when supplied and omits it otherwise', () => {
    const events = [
      titleEvent(0, 'Source path'),
      start(1, 1),
      user(2, 'Question'),
      assistant(3, [text('Answer')]),
      end(4, 1),
    ]
    const sourcePath = '/tmp/Session files/```\nsecond'
    expect(formatSessionMarkdown(events, sourcePath)).toBe([
      '# Source path',
      '',
      'Session file:',
      '',
      '````text',
      sourcePath,
      '````',
      '',
      '> Question',
      '',
      'Answer',
      '',
    ].join('\n'))
    expect(formatSessionMarkdown(events, '')).toBe('# Source path\n\n> Question\n\nAnswer\n')
    expect(formatSessionMarkdown(events)).toBe('# Source path\n\n> Question\n\nAnswer\n')
  })

  it('does not mutate a frozen logical event snapshot', () => {
    const events = Object.freeze([
      Object.freeze(titleEvent(0, 'Frozen')),
      Object.freeze(start(1, 1)),
      Object.freeze(user(2, 'Question')),
      Object.freeze(assistant(3, [text('Answer')])),
      Object.freeze(end(4, 1)),
    ])
    expect(formatSessionMarkdown(events)).toBe('# Frozen\n\n> Question\n\nAnswer\n')
    expect(events).toHaveLength(5)
  })

  it('keeps complete chronology across inherited history and a compaction surface replacement', () => {
    const markdown = renderWithTitle({
      title: 'Chronology',
      events: [
        start(1, 1),
        user(2, 'Original question'),
        assistant(3, [text('Original working note')]),
        toolCall(4, 'call-1', 'read', '{"file_path":"a.md"}'),
        toolResult(5, 'call-1', [text('alpha')]),
        assistant(6, [text('Original answer')]),
        end(7, 1),
        { type: 'session/end-seed', seq: sequence(8), time: 8, data: {} },
        {
          ...user(9, 'COMPACTED SUMMARY TEXT', 'injected'),
          surfaceOp: { op: 'replace', startSeq: sequence(2), endSeq: sequence(6) },
        },
        start(10, 2),
        user(11, 'Follow-up question'),
        assistant(12, [text('Second answer')]),
        end(13, 2),
      ],
    })

    expect(markdown).toContain('> Original question')
    expect(markdown).toContain('Original working note')
    expect(markdown).toContain('Original answer')
    expect(markdown).toContain('> Follow-up question')
    expect(markdown).toContain('Second answer')
    expect(markdown).not.toContain('COMPACTED SUMMARY TEXT')
    expect(markdown.indexOf('Original answer')).toBeLessThan(markdown.indexOf('Second answer'))
    expect(markdown.match(/Original answer/gu)).toHaveLength(1)
    expect(markdown.endsWith('\n')).toBe(true)
    expect(markdown.endsWith('\n\n')).toBe(false)
  })

  it('renders a turn with a collapsible commentary/tool section before the final reply', () => {
    const markdown = renderWithTitle({
      title: 'Turn layout',
      events: [
        start(1, 1),
        user(2, 'Please inspect'),
        assistant(3, [text('I will inspect.')]),
        toolCall(4, 'call-1', 'bash', '{"command":"echo hi"}'),
        toolResult(5, 'call-1', [text('hi\n')]),
        assistant(6, [text('Done.')]),
        end(7, 1),
      ],
    })

    expect(markdown).toBe([
      '# Turn layout',
      '',
      '> Please inspect',
      '',
      '<details><summary>2 previous messages</summary>',
      '',
      '**Assistant**',
      '',
      'I will inspect.',
      '',
      '**Tool: `bash`**',
      '',
      '```json',
      '{',
      '  "command": "echo hi"',
      '}',
      '```',
      '',
      '**Result**',
      '',
      '```',
      'hi',
      '```',
      '',
      '</details>',
      '',
      'Done.',
      '',
    ].join('\n'))
  })

  it('keeps a mid-turn steering message after the activity that preceded it', () => {
    const markdown = renderWithTitle({
      title: 'Steering order',
      events: [
        start(1, 1),
        user(2, 'Start the task'),
        assistant(3, [text('Working before steering')]),
        toolCall(4, 'call-1', 'bash', '{"command":"first"}'),
        toolResult(5, 'call-1', [text('first result')]),
        user(6, 'Steer to the second path'),
        assistant(7, [text('Working after steering')]),
        toolCall(8, 'call-2', 'bash', '{"command":"second"}'),
        toolResult(9, 'call-2', [text('second result')]),
        assistant(10, [text('Final answer')]),
        end(11, 1),
      ],
    })

    const before = markdown.indexOf('Working before steering')
    const firstResult = markdown.indexOf('first result')
    const steering = markdown.indexOf('> Steer to the second path')
    const after = markdown.indexOf('Working after steering')
    const secondResult = markdown.indexOf('second result')
    const final = markdown.indexOf('Final answer')
    expect(before).toBeGreaterThan(-1)
    expect(before).toBeLessThan(firstResult)
    expect(firstResult).toBeLessThan(steering)
    expect(steering).toBeLessThan(after)
    expect(after).toBeLessThan(secondResult)
    expect(secondResult).toBeLessThan(final)
    expect(markdown.match(/<details>/gu)).toHaveLength(2)
    expect(markdown.match(/<details><summary>2 previous messages<\/summary>/gu)).toHaveLength(2)
  })

  it('preserves authored details and code fences in the final reply', () => {
    const authored = [
      'Before',
      '',
      '<details>',
      '<summary>Authored</summary>',
      '',
      '```html',
      '<summary>code</summary>',
      '```',
      '',
      '</details>',
      '',
      'After',
    ].join('\n')
    const markdown = renderWithTitle({
      title: 'Authored final',
      events: [start(1, 1), user(2, 'Show details'), assistant(3, [text(authored)]), end(4, 1)],
    })

    expect(markdown).toContain(authored)
    expect(markdown).not.toContain('&lt;')
    expect(markdown.endsWith(`${authored}\n`)).toBe(true)
  })

  it('ignores replacement surface events and keeps original append chronology', () => {
    const markdown = renderWithTitle({
      title: 'Replacements',
      events: [
        start(1, 1),
        user(2, 'Original prompt'),
        assistant(3, [text('Original commentary')]),
        toolCall(4, 'call-1', 'bash', '{"command":"original"}'),
        toolResult(5, 'call-1', [text('original full output')]),
        assistant(6, [text('Original final')]),
        end(7, 1),
        {
          ...assistant(8, [text('REPLACEMENT ASSISTANT')]),
          surfaceOp: { op: 'replace', startSeq: sequence(3), endSeq: sequence(6) },
        },
        {
          ...toolResult(9, 'call-1', [text('REPLACEMENT TOOL OUTPUT')]),
          surfaceOp: { op: 'replace', startSeq: sequence(5), endSeq: sequence(5) },
        },
        {
          ...user(10, 'REPLACEMENT USER'),
          surfaceOp: { op: 'replace', startSeq: sequence(2), endSeq: sequence(2) },
        },
      ],
    })

    expect(markdown).toContain('> Original prompt')
    expect(markdown).toContain('Original commentary')
    expect(markdown).toContain('original full output')
    expect(markdown.match(/original full output/gu)).toHaveLength(1)
    expect(markdown).toContain('Original final')
    expect(markdown).not.toContain('REPLACEMENT ASSISTANT')
    expect(markdown).not.toContain('REPLACEMENT TOOL OUTPUT')
    expect(markdown).not.toContain('REPLACEMENT USER')
    expect(markdown).not.toContain('**Tool: `unknown`**')
    expect(markdown.match(/<details>/gu)).toHaveLength(1)
  })

  it('emits no empty assistant section and exactly one trailing newline', () => {
    const markdown = renderWithTitle({
      title: 'Whitespace',
      events: [
        start(1, 1),
        user(2, 'Question'),
        assistant(3, [text('   \n\t')]),
        assistant(4, [text('Answer')]),
        end(5, 1),
      ],
    })

    expect(markdown).toBe('# Whitespace\n\n> Question\n\nAnswer\n')
  })


  it('preserves four-space and tab indentation in final and commentary prose', () => {
    const markdown = renderWithTitle({
      title: 'Indented code',
      events: [
        start(1, 1),
        user(2, 'Show code'),
        assistant(3, [text('    <details>\n    <summary>literal code</summary>')]),
        assistant(4, [text('\tif (ready) {\n\t  run()\n\t}')]),
        end(5, 1),
      ],
    })

    expect(markdown).toContain('**Assistant**\n\n    <details>\n    <summary>literal code</summary>')
    expect(markdown).toContain('\tif (ready) {\n\t  run()\n\t}')
    expect(markdown).not.toContain('&lt;details>')
    expect(markdown.endsWith('\t}\n')).toBe(true)
  })

  it('closes unfinished commentary fences before the generated details closer', () => {
    const backtick = renderWithTitle({
      title: 'Backtick fence',
      events: [
        start(1, 1),
        user(2, 'Question'),
        assistant(3, [text('Before\n\n```ts\nconst x = 1')]),
        assistant(4, [text('After backtick')]),
        end(5, 1),
      ],
    })
    expect(backtick).toContain('const x = 1\n```\n\n</details>\n\nAfter backtick')

    const tilde = renderWithTitle({
      title: 'Tilde fence',
      events: [
        start(1, 1),
        user(2, 'Question'),
        assistant(3, [text('~~~js\nconst y = 2')]),
        assistant(4, [text('After tilde')]),
        end(5, 1),
      ],
    })
    expect(tilde).toContain('const y = 2\n~~~\n\n</details>\n\nAfter tilde')

    const longer = renderWithTitle({
      title: 'Longer fence',
      events: [
        start(1, 1),
        user(2, 'Question'),
        assistant(3, [text('````md\nlonger fence')]),
        assistant(4, [text('After longer')]),
        end(5, 1),
      ],
    })
    expect(longer).toContain('longer fence\n````\n\n</details>\n\nAfter longer')
  })

  it('does not treat an invalid backtick info string as an open fence', () => {
    const markdown = renderWithTitle({
      title: 'Invalid fence',
      events: [
        start(1, 1),
        user(2, 'Question'),
        assistant(3, [text('```bad`info\nstill prose')]),
        assistant(4, [text('After invalid')]),
        end(5, 1),
      ],
    })

    expect(markdown).toContain('```bad`info\nstill prose')
    expect(markdown.match(/```/gu)).toHaveLength(1)
    expect(markdown).toContain('still prose\n\n</details>\n\nAfter invalid')
  })

  it('closes an unfinished final fence before the next turn', () => {
    const markdown = renderWithTitle({
      title: 'Final fence',
      events: [
        start(1, 1),
        user(2, 'First question'),
        assistant(3, [text('```sh\necho hi')]),
        end(4, 1),
        start(5, 2),
        user(6, 'Second question'),
        end(7, 2),
      ],
    })

    expect(markdown).toContain('echo hi\n```\n\n> Second question')
    expect(markdown.indexOf('echo hi')).toBeLessThan(markdown.indexOf('> Second question'))
  })


  it('strips blank edge lines without removing indented code blank lines', () => {
    const markdown = renderWithTitle({
      title: 'Edge blanks',
      events: [
        start(1, 1),
        user(2, 'Question'),
        assistant(3, [text('\n    first\n\n    second\n\n')]),
        end(4, 1),
      ],
    })

    expect(markdown).toBe('# Edge blanks\n\n> Question\n\n    first\n\n    second\n')
  })

  it('escapes wrapper tags outside fences and grows fences past tool backtick runs', () => {
    const markdown = renderWithTitle({
      title: 'Escaping',
      events: [
        start(1, 1),
        user(2, 'Run it'),
        assistant(3, [text('Before\n\n</details>\n\n```md\n</details>\n```\n\n```bad`info')]),
        toolCall(4, 'call-1', '</summary>', '{"value":"````"}'),
        toolResult(5, 'call-1', [text('`````\n</details>')]),
        assistant(6, [text('Finished')]),
        end(7, 1),
      ],
    })

    expect(markdown).toContain('&lt;/details>')
    expect(markdown).toContain('```md\n</details>\n```')
    expect(markdown).toContain('`````json')
    expect(markdown).toContain('``````')
    expect(markdown).toContain('**Tool: `&lt;/summary>`**')
    expect(markdown.endsWith('</details>\n\nFinished\n')).toBe(true)
  })

  it('labels attachments and omits reasoning, system prompts, and injected context', () => {
    const markdown = renderWithTitle({
      title: 'Hidden input',
      events: [
        start(1, 1),
        {
          type: 'system/message',
          seq: sequence(2),
          time: 2,
          surfaceOp: 'append',
          data: {
            turn: 1,
            step: 1,
            message: {
              role: 'system',
              id: messageId('system-1'),
              source: { kind: 'system-prompt' },
              content: [text('SYSTEM ONLY')],
            },
          },
        },
        userWithAttachments(3),
        user(4, 'SECRET INJECTED', 'injected'),
        assistant(5, [
          { type: 'reasoning', text: 'REASONING ONLY' },
          text('Visible answer'),
        ]),
        end(6, 1),
      ],
    })

    expect(markdown).toContain('> See the attachments.')
    expect(markdown).toContain('> [Image: diagram.png (640×480, 123 bytes)]')
    expect(markdown).toContain('> [File: notes.txt (42 bytes)]')
    expect(markdown).not.toContain('img-secret-1')
    expect(markdown).not.toContain('file-secret-1')
    expect(markdown).not.toContain('SECRET INJECTED')
    expect(markdown).not.toContain('SYSTEM ONLY')
    expect(markdown).not.toContain('REASONING ONLY')
    expect(markdown).toContain('Visible answer')
  })

  it('exports only the heading for a blank Session and escapes title newlines', () => {
    expect(renderWithTitle({ title: 'One\nTwo', events: [] })).toBe('# One Two\n')
    expect(renderWithTitle({ title: '  ', events: [] })).toBe('# Untitled Session\n')
    expect(renderWithTitle({ title: undefined, events: [] })).toBe('# Untitled Session\n')
  })

  it('renders tool-only and incomplete turns predictably', () => {
    const markdown = renderWithTitle({
      title: 'Incomplete',
      events: [
        start(1, 1),
        user(2, 'Run the tool'),
        assistant(3, [{ type: 'tool-call', id: callId('call-1'), name: 'bash', arguments: '{}' }]),
        toolCall(4, 'call-1', 'bash', '{}'),
        toolResult(5, 'call-1', [text('done')], { isError: true, reason: 'exit 1' }),
        start(6, 2),
        user(7, 'Another'),
        toolCall(8, 'call-2', 'read', '{"file_path":"b.md"}'),
        toolResult(9, 'call-2', [{ type: 'image', attachment: {
          attachmentId: attachmentId('result-image'),
          mediaType: 'image/png',
          bytes: 10,
          width: 1,
          height: 2,
        } }]),
        toolCall(10, 'call-3', 'bash', '{}'),
      ],
    })

    expect(markdown).toContain('<details><summary>1 previous message</summary>')
    expect(markdown).toContain('**Result (error)**')
    expect(markdown).toContain('Error: exit 1')
    expect(markdown).toContain('[Image: attachment (1×2, 10 bytes)]')
    expect(markdown).not.toContain('<details><summary>0 previous messages</summary>')
    expect(markdown).toContain('(no result recorded)')
    expect(markdown.endsWith('\n')).toBe(true)
  })

  it('renders assistant-only, user-only, empty, and malformed content predictably', () => {
    const markdown = renderWithTitle({
      title: 'Edge content',
      events: [
        // A committed assistant message before the first turn marker still
        // renders, and forms an assistant-only turn with no user blockquote.
        assistant(1, [text('No turn marker')]),
        start(2, 1),
        user(3, 'Only question'),
        end(4, 1),
        start(5, 2),
        userBlocks(6, [
          text(''),
          { type: 'tool-call', id: callId('user-tool'), name: 'read', arguments: '{}' },
        ]),
        assistant(7, [
          text(''),
          {
            type: 'image',
            attachment: {
              attachmentId: attachmentId('assistant-image'),
              mediaType: 'image/png',
              bytes: 8,
              width: 2,
              height: 3,
            },
          },
          {
            type: 'file',
            attachment: { attachmentId: attachmentId('assistant-file'), name: 'a.txt', bytes: 4 },
          },
        ]),
        end(8, 2),
        start(9, 3),
        user(10, 'Tools'),
        toolCall(11, 'call-1', 'bash', 'not-json'),
        toolResult(12, 'call-1', [
          text(''),
          { type: 'file', attachment: { attachmentId: attachmentId('result-file'), name: 'b.txt', bytes: 5 } },
        ]),
        toolCall(13, 'call-2', 'bash', '{}'),
        toolResult(14, 'call-2', [], { isError: true, reason: 'boom' }),
        toolCall(15, 'call-3', 'bash', '{}'),
        toolResult(16, 'call-3', []),
        assistant(17, [text('Final')]),
        end(18, 3),
      ],
    })

    expect(markdown).toContain('No turn marker')
    expect(markdown).toContain('> Only question')
    expect(markdown).toContain('[Image: attachment (2×3, 8 bytes)]')
    expect(markdown).toContain('[File: a.txt (4 bytes)]')
    expect(markdown).toContain('[File: b.txt (5 bytes)]')
    expect(markdown).toContain('not-json')
    expect(markdown).toContain('Error: boom')
    expect(markdown).toContain('(no output)')
    expect(markdown).toContain('Final')
  })

  it('renders an orphan tool result without inventing a call name', () => {
    const markdown = renderWithTitle({
      title: 'Orphan',
      events: [
        start(1, 1),
        user(2, 'Question'),
        toolResult(3, 'missing-call', [text('orphan output')]),
        assistant(4, [text('Answer')]),
        end(5, 1),
      ],
    })

    expect(markdown).toContain('**Tool: `unknown`**')
    expect(markdown).toContain('orphan output')
    expect(markdown).toContain('<details><summary>1 previous message</summary>')
  })
})
