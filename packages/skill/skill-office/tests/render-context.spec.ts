/** Render detection uses recorded tool names, not JSON spelling or quoted skill instructions. */
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { expect, it } from 'vitest'
import { expectNoRenderContext, officeCalls } from './fixtures/real-office.ts'

it.each([undefined, 2])('rejects a native render with JSON indentation %s', (indent) => {
  const session = Session.create(SessionId('native-render'))
  session.append('tool/call', {
    turn: 1, step: 1, callId: ToolCallId('render'), name: 'office_render',
    arguments: JSON.stringify({ input: 'input.docx' }, null, indent),
  })
  expect(officeCalls(session.snapshotEvents())).toEqual([
    { callId: 'render', name: 'office_render', args: { input: 'input.docx' } },
  ])
  expect(() => { expectNoRenderContext(session.snapshotEvents()) }).toThrow()
})

it('rejects a PTC render even without a model-visible PTC result', () => {
  const session = Session.create(SessionId('ptc-render'))
  session.append('tool/ptc-dispatch', {
    rootCallId: ToolCallId('program'), parentCallId: ToolCallId('program'), subCallId: ToolCallId('program:1'),
    name: 'office_render', arguments: { input: 'input.docx' }, isError: false, content: [],
  })
  expect(session.deriveMessages()).toEqual([])
  expect(officeCalls(session.snapshotEvents())).toEqual([
    { callId: 'program:1', name: 'office_render', args: { input: 'input.docx' } },
  ])
  expect(() => { expectNoRenderContext(session.snapshotEvents()) }).toThrow()
})

it.each(['office_convert', 'office_recalculate'])('accepts %s and quoted render instructions without a render call', (name) => {
  const session = Session.create(SessionId('pdf-conversion'))
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'For visual inspection use office_render.' }], source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('tool/call', {
    turn: 1, step: 1, callId: ToolCallId('output'), name,
    arguments: JSON.stringify({ input: 'input.xlsx', format: 'xlsx' }),
  })
  expect(officeCalls(session.snapshotEvents())).toEqual([
    { callId: 'output', name, args: { input: 'input.xlsx', format: 'xlsx' } },
  ])
  expectNoRenderContext(session.snapshotEvents())
})
