import { describe, expect, it } from 'vitest'
import type { SessionFormatEvent, SessionFormatHeader, SessionFormatJsonObject } from '@deepseek-ai/dsh-session-format'
import { SessionFormatEventCollector, SessionFormatUnsupportedMigrationError } from '@deepseek-ai/dsh-session-format'
import { createToolResultMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { createSessionFormatV3ToV4, releasedV4SessionFormatCodec, restoreReleasedV4Artifact, sessionFormatV3ToV4 } from '../src/index.ts'
import { assertV4ToolResultMessage, liftToolResult } from '../src/tool-role.ts'

const header = { version: 4, id: 'tool-role', createdAt: 1, isSeeded: false, delegationDepth: 0 }

function event(seq: number, type: string, data: SessionFormatJsonObject): SessionFormatEvent {
  return { type, seq, time: seq + 1, data }
}

/** Released V3 canonical user-role wrapper tool/result message. */
function wrapperMessage(callId = 'call-1', text = 'result'): SessionFormatJsonObject {
  return {
    id: `tool-result-${callId}`,
    role: 'user',
    source: { kind: 'tool', callId },
    content: [{
      type: 'tool-result',
      toolCallId: callId,
      isError: false,
      content: [{ type: 'text', text }],
    }],
  }
}

/** Native V4 first-class tool-role message. */
function firstClassMessage(callId = 'call-1', text = 'result', isError: boolean | undefined = false): SessionFormatJsonObject {
  return {
    id: `tool-result-${callId}`,
    role: 'tool',
    source: { kind: 'tool', callId },
    toolCallId: callId,
    content: [{ type: 'text', text }],
    ...(isError === undefined ? {} : { isError }),
  }
}

describe('V4 tool-role view and lift', () => {
  it.each([false, true])('serializes lifted result fields in current writer order with isError=%s', (isError) => {
    const content = [{ type: 'text' as const, text: 'result' }]
    const current = createToolResultMessage({ callId: ToolCallId('call-1'), content, isError })
    const row = event(0, 'tool/result', { turn: 1, step: 1, message: {
      ...wrapperMessage(),
      content: [{ type: 'tool-result', toolCallId: 'call-1', content, isError }],
    } })
    const target = (liftToolResult(row).data as SessionFormatJsonObject)['message']
    expect(JSON.stringify(target)).toBe(JSON.stringify({ ...current, id: 'tool-result-call-1' }))
  })

  it.each([undefined, false, true])('preserves outer fields without activating their target names with isError=%s', (isError) => {
    const metadata = JSON.parse('{"__proto__":{"saved":"prototype"},"constructor":{"saved":"constructor"},"extension":{"saved":true}}') as SessionFormatJsonObject
    const content = [{ type: 'text', text: 'result' }]
    const message: SessionFormatJsonObject = {
      ...metadata, ...wrapperMessage(), toolCallId: 'call-1', ...(isError === undefined ? {} : { isError }),
      content: [{ type: 'tool-result', toolCallId: 'call-1', content, ...(isError === undefined ? {} : { isError }) }],
    }
    const row = { ...event(0, 'tool/result', { turn: 1, step: 1, message }), surfaceOp: 'append' } as SessionFormatEvent
    const before = structuredClone(row)
    const lifted = liftToolResult(row)
    const target = (lifted.data as SessionFormatJsonObject)['message'] as SessionFormatJsonObject
    expect(target).toEqual({ id: message['id'], role: 'tool', source: message['source'], toolCallId: 'call-1', content,
      ...(isError === undefined ? {} : { isError, 'plugin:message:isError': isError }),
      'plugin:message:toolCallId': 'call-1',
      'plugin:message:__proto__': metadata['__proto__'], 'plugin:message:constructor': metadata['constructor'],
      'plugin:message:extension': metadata['extension'],
    })
    expect(Object.hasOwn(target, 'plugin:message:__proto__')).toBe(true)
    expect(Object.hasOwn(target, 'plugin:message:constructor')).toBe(true)
    expect(Object.getPrototypeOf(target)).toBe(Object.prototype)
    expect(row).toEqual(before)
    expect(JSON.parse(JSON.stringify(releasedV4SessionFormatCodec.encodeEvent(lifted)))).toEqual(lifted)
  })

  it.each([
    ['toolCallId', 'other-call', false],
    ['isError', true, false],
    ['isError', true, undefined],
    ['isError', 'false', false],
  ] as const)('keeps outer %s data separate from the interpreted result', (field, value, isError) => {
    const row = event(0, 'tool/result', { turn: 1, step: 1, message: {
      ...wrapperMessage(), [field]: value,
      content: [{ type: 'tool-result', toolCallId: 'call-1', content: [], ...(isError === undefined ? {} : { isError }) }],
    } })
    const before = structuredClone(row)
    const target = (liftToolResult(row).data as SessionFormatJsonObject)['message'] as SessionFormatJsonObject
    expect(target[`plugin:message:${field}`]).toEqual(value)
    expect(target['toolCallId']).toBe('call-1')
    expect(target['isError']).toBe(isError)
    expect(row).toEqual(before)
  })

  it('preserves an outer flag without adding an absent result flag', () => {
    const row = event(0, 'tool/result', { turn: 1, step: 1, message: {
      ...wrapperMessage(), isError: false, content: [{ type: 'tool-result', toolCallId: 'call-1', content: [] }],
    } })
    expect(liftToolResult(row).data).toMatchObject({ message: { role: 'tool', 'plugin:message:isError': false } })
    expect((liftToolResult(row).data as SessionFormatJsonObject)['message']).not.toHaveProperty('isError')
  })

  it.each(['extension', '__proto__', 'constructor'])('preserves result-owned %s without adding a core field', (field) => {
    const wrapper = Object.fromEntries([
      ['type', 'tool-result'], ['toolCallId', 'call-1'], ['content', []], [field, { saved: true }],
    ]) as SessionFormatJsonObject
    const row = event(0, 'tool/result', { turn: 1, step: 1, message: { ...wrapperMessage(), content: [wrapper] } })
    const before = structuredClone(row)
    const target = (liftToolResult(row).data as SessionFormatJsonObject)['message'] as SessionFormatJsonObject
    expect(target[`plugin:result:${field}`]).toEqual({ saved: true })
    expect(Object.hasOwn(target, `plugin:result:${field}`)).toBe(true)
    expect(Object.getPrototypeOf(target)).toBe(Object.prototype)
    expect(row).toEqual(before)
  })

  it('keeps repeated owner names and already-prefixed field names distinct', () => {
    const row = event(0, 'tool/result', { turn: 1, step: 1, message: {
      ...wrapperMessage(), note: 'outer', 'plugin:result:note': 'outer prefixed',
      content: [{ type: 'tool-result', toolCallId: 'call-1', content: [], note: 'inner', 'plugin:message:note': 'inner prefixed' }],
    } })
    expect(liftToolResult(row).data).toMatchObject({ message: {
      'plugin:message:note': 'outer', 'plugin:message:plugin:result:note': 'outer prefixed',
      'plugin:result:note': 'inner', 'plugin:result:plugin:message:note': 'inner prefixed',
    } })
  })

  it('lifts a released wrapper into the native tool-role message', () => {
    const wrapperRow = { ...event(0, 'tool/result', { turn: 1, step: 1, message: wrapperMessage() }), surfaceOp: 'append' } as SessionFormatEvent
    const lifted = liftToolResult(wrapperRow)
    expect(lifted.data).toEqual({
      turn: 1,
      step: 1,
      message: firstClassMessage(),
    })
  })

  it('omits isError when a released wrapper did not persist the flag', () => {
    const row = event(0, 'tool/result', {
      turn: 1, step: 1,
      message: {
        ...wrapperMessage(),
        content: [{ type: 'tool-result', toolCallId: 'call-1', content: [{ type: 'text', text: 'result' }] }],
      },
    })
    expect(liftToolResult(row).data).toMatchObject({ message: { role: 'tool', content: [{ type: 'text', text: 'result' }] } })
    expect((liftToolResult(row).data as SessionFormatJsonObject)['message']).not.toHaveProperty('isError')
  })

  it('rejects a released wrapper with a non-boolean isError flag', () => {
    const row = event(0, 'tool/result', {
      turn: 1, step: 1,
      message: {
        ...wrapperMessage(),
        content: [{ type: 'tool-result', toolCallId: 'call-1', isError: 'yes', content: [] }],
      },
    })
    expect(() => liftToolResult(row)).toThrow(/tool-result isError must be boolean/)
  })

  it('passes non-tool rows through the wrapper conversion', () => {
    const row = event(0, 'user/message', { content: [], source: { kind: 'user' }, role: 'user', id: 'u' })
    expect(liftToolResult(row)).toBe(row)
  })

  it('preserves isError and repair identity across the lift', () => {
    const repair = event(0, 'tool/result', {
      turn: 1,
      step: 1,
      message: {
        id: 'interrupted-tool-result-call-1-0',
        role: 'user',
        source: { kind: 'tool', callId: 'call-1' },
        content: [{
          type: 'tool-result',
          toolCallId: 'call-1',
          isError: true,
          content: [{
            type: 'text',
            text: 'The tool call was interrupted before the Harness recorded it as started. Retry it if it is still needed.',
          }],
        }],
      },
      error: { name: 'ToolNotStartedError', code: 'TOOL_NOT_STARTED' },
    })
    const lifted = liftToolResult(repair)
    expect((lifted.data as SessionFormatJsonObject)['message']).toMatchObject({
      role: 'tool',
      toolCallId: 'call-1',
      isError: true,
      id: 'interrupted-tool-result-call-1-0',
    })
    expect((lifted.data as SessionFormatJsonObject)['error']).toEqual({ name: 'ToolNotStartedError', code: 'TOOL_NOT_STARTED' })
  })

  it('refuses nested released results without discarding their identity or error status', () => {
    const row = event(0, 'tool/result', {
      turn: 1,
      step: 1,
      message: {
        ...wrapperMessage(),
        content: [{
          type: 'tool-result',
          toolCallId: 'call-1',
          isError: false,
          content: [{
            type: 'tool-result',
            toolCallId: 'nested-call',
            isError: true,
            content: [{ type: 'text', text: 'hidden' }],
          }],
        }],
      },
    })
    const before = structuredClone(row)
    expect(() => liftToolResult(row)).toThrow(SessionFormatUnsupportedMigrationError)
    expect(() => liftToolResult(row)).toThrow('unsupported by this converter')
    expect(row).toEqual(before)
  })

  it('rejects a released wrapper with extra top-level content blocks', () => {
    const row = event(0, 'tool/result', {
      turn: 1,
      step: 1,
      message: {
        ...wrapperMessage(),
        content: [
          { type: 'tool-result', toolCallId: 'call-1', isError: false, content: [{ type: 'text', text: 'result' }] },
          { type: 'text', text: 'extra' },
        ],
      },
    })
    expect(() => liftToolResult(row)).toThrow(/exactly one tool-result wrapper/)
  })
})

describe('released V4 codec with native tool-role rows', () => {
  it('encodes and decodes a first-class tool result unchanged', () => {
    const row = { ...event(0, 'tool/result', { turn: 1, step: 1, message: firstClassMessage() }), surfaceOp: 'append' } as SessionFormatEvent
    const encoded = releasedV4SessionFormatCodec.encodeEvent(row)
    expect(encoded).toEqual(row)
    const collector = new SessionFormatEventCollector()
    const decoder = releasedV4SessionFormatCodec.createDecoder(
      { type: 'session', ...header },
      'strict',
    )
    decoder.decodeRow(row, collector)
    expect(collector.values).toEqual([row])
  })

  it('rejects a released-wrapper row in the current V4 decoder', () => {
    const wrapperRow = { ...event(0, 'tool/result', { turn: 1, step: 1, message: wrapperMessage() }), surfaceOp: 'append' } as SessionFormatEvent
    const collector = new SessionFormatEventCollector()
    const decoder = releasedV4SessionFormatCodec.createDecoder(
      { type: 'session', ...header },
      'strict',
    )
    expect(() => { decoder.decodeRow(wrapperRow, collector) }).toThrow(/requires a tool-role message/)
  })

  it('keeps native semantic failures hard even in recoverable mode', () => {
    const row = { ...event(0, 'tool/result', { turn: 1, step: 1, message: firstClassMessage('call-1', 'result', 'yes' as never) }), surfaceOp: 'append' } as SessionFormatEvent
    const decoder = releasedV4SessionFormatCodec.createDecoder({ type: 'session', ...header }, 'recoverable')
    expect(() => { decoder.decodeRow(row, new SessionFormatEventCollector()) }).toThrow(/isError must be boolean/)
  })

  it('refuses a native row whose error metadata lacks the message isError flag', () => {
    const bad = event(0, 'tool/result', {
      turn: 1,
      step: 1,
      message: firstClassMessage('call-1', 'result', false),
      error: { name: 'ToolNotStartedError', code: 'TOOL_NOT_STARTED' },
    })
    expect(() => releasedV4SessionFormatCodec.encodeEvent(bad)).toThrow(/error metadata for a non-error tool result/)
  })

  it('restores a first-class artifact through the released V3 relationship rules', () => {
    const artifact = {
      header: header as unknown as SessionFormatHeader,
      inheritedEventCount: 0,
      events: [
        event(0, 'turn/start', { turn: 1 }),
        event(1, 'step/start', { turn: 1, step: 1 }),
        {
          type: 'assistant/message', seq: 2, time: 3, surfaceOp: 'append',
          data: {
            turn: 1, step: 1,
            message: {
              id: 'a-1', role: 'assistant',
              content: [{ type: 'tool-call', id: 'call-1', name: 'bash', arguments: '{}' }],
              source: { kind: 'model', provider: 'mock', model: 'mock' },
            },
            stream: [],
          },
        },
        {
          type: 'tool/call', seq: 3, time: 4,
          data: { turn: 1, step: 1, callId: 'call-1', name: 'bash', arguments: '{}' },
        },
        {
          type: 'tool/result', seq: 4, time: 5, surfaceOp: 'append',
          data: { turn: 1, step: 1, message: firstClassMessage('call-1') },
        },
        event(5, 'step/end', { turn: 1, step: 1 }),
        event(6, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
      ],
    }
    expect(restoreReleasedV4Artifact(artifact as never, new Set(artifact.events.map(item => item.type)))).toBe(artifact)
    expect(artifact.events[4]).toMatchObject({ data: { message: { role: 'tool', toolCallId: 'call-1' } } })
  })
})

describe('V3 to V4 edge lifts released tool results', () => {
  function migrate(rows: readonly SessionFormatEvent[]) {
    const targetHeader = sessionFormatV3ToV4.migrateHeader({ ...header, version: 3 })
    const stage = createSessionFormatV3ToV4([]).createStage({
      sourceHeader: { ...header, version: 3 },
      targetHeader,
      sourceInheritedEventCount: 0,
      sourceKind: 'decoded',
    })
    const collector = new SessionFormatEventCollector()
    for (const [seq, row] of rows.entries()) stage.transformEvent({ ...row, seq }, collector)
    return { header: targetHeader, cut: stage.finish(collector), events: collector.values }
  }

  it('lifts a released wrapper tool result into the native message', () => {
    const rows = [
      event(0, 'turn/start', { turn: 1 }),
      event(1, 'step/start', { turn: 1, step: 1 }),
      {
        type: 'tool/result', seq: 2, time: 3, surfaceOp: 'append',
        data: { turn: 1, step: 1, message: wrapperMessage() },
      },
    ]
    const output = migrate(rows)
    expect(output.events[2]?.data).toEqual({ turn: 1, step: 1, message: firstClassMessage() })
  })

  it('keeps non-tool rows intact and expands runs through the same transform', () => {
    const row = event(0, 'turn/start', { turn: 1 })
    const run = { runType: 'identity', firstSeq: 0, eventCount: 1, expand: () => [row] }
    const emitted: SessionFormatEvent[] = []
    const stage = createSessionFormatV3ToV4([]).createStage({
      sourceHeader: { ...header, version: 3 },
      targetHeader: { ...header },
      sourceInheritedEventCount: 0,
      sourceKind: 'decoded',
    })
    stage.transformRun(run, {
      emitEvent: (value) => { emitted.push(value) },
      emitRun: () => { throw new Error('unexpected run emission') },
    })
    expect(emitted).toEqual([{ ...row, seq: 0 }])
  })
})

describe('native tool-result validation', () => {
  function native(overrides: SessionFormatJsonObject = {}): SessionFormatEvent {
    return event(0, 'tool/result', { turn: 1, step: 1, message: { ...firstClassMessage(), ...overrides } })
  }

  function raw(data: unknown): SessionFormatEvent {
    return { type: 'tool/result', seq: 0, time: 1, data } as SessionFormatEvent
  }

  it('accepts a native message and ignores rows of other event types', () => {
    expect(() => { assertV4ToolResultMessage(native()) }).not.toThrow()
    expect(() => { assertV4ToolResultMessage(event(0, 'user/message', { role: 'user', content: [] })) }).not.toThrow()
  })

  it('refuses data and messages that are not objects', () => {
    expect(() => { assertV4ToolResultMessage(raw('nope')) }).toThrow(/data must be an object/)
    expect(() => { assertV4ToolResultMessage(raw({ message: 'nope' })) }).toThrow(/message must be an object/)
  })

  it('refuses ids that are not non-empty strings', () => {
    expect(() => { assertV4ToolResultMessage(native({ id: '' })) }).toThrow(/string id/)
    expect(() => { assertV4ToolResultMessage(native({ id: 7 })) }).toThrow(/string id/)
  })

  it('refuses a message that is not the tool role', () => {
    expect(() => { assertV4ToolResultMessage(native({ role: 'user' })) }).toThrow(/tool-role message/)
  })

  it('refuses a tool call id that does not match the tool source', () => {
    expect(() => { assertV4ToolResultMessage(native({ toolCallId: 'other' })) }).toThrow(/matching its tool source/)
    expect(() => { assertV4ToolResultMessage(native({ toolCallId: '' })) }).toThrow(/matching its tool source/)
    expect(() => { assertV4ToolResultMessage(native({ source: { kind: 'tool', callId: 'other' } })) }).toThrow(/matching its tool source/)
    expect(() => { assertV4ToolResultMessage(native({ source: 'nope' })) }).toThrow(/matching its tool source/)
  })

  it('refuses a source that is not the tool source', () => {
    expect(() => { assertV4ToolResultMessage(native({ source: { kind: 'model', callId: 'call-1' } })) }).toThrow(/requires a tool source/)
  })

  it('refuses content that is not an array', () => {
    expect(() => { assertV4ToolResultMessage(native({ content: 'nope' })) }).toThrow(/array content/)
  })

  it('refuses an isError flag that is not boolean', () => {
    expect(() => { assertV4ToolResultMessage(native({ isError: 'yes' })) }).toThrow(/isError must be boolean/)
  })

  it('round trips a native message without an isError flag', () => {
    const message: SessionFormatJsonObject = {
      id: 'tool-result-call-1',
      role: 'tool',
      source: { kind: 'tool', callId: 'call-1' },
      toolCallId: 'call-1',
      content: [{ type: 'text', text: 'result' }],
    }
    const row = { ...event(0, 'tool/result', { turn: 1, step: 1, message }), surfaceOp: 'append' } as SessionFormatEvent
    expect(liftToolResult(row)).toBe(row)
  })

  it('refuses a released wrapper without its wrapper block', () => {
    const row = event(0, 'tool/result', {
      turn: 1,
      step: 1,
      message: { id: 'x', role: 'user', source: { kind: 'tool', callId: 'call-1' }, content: [] },
    })
    expect(() => liftToolResult(row)).toThrow(/exactly one tool-result wrapper/)
  })

  it('refuses wrapper rows with invalid source or content fields', () => {
    const invalidSource = event(0, 'tool/result', {
      turn: 1,
      step: 1,
      message: { id: 'x', role: 'user', source: 'nope', content: [] },
    })
    expect(() => liftToolResult(invalidSource)).toThrow(/exactly one tool-result wrapper/)

    const invalidContent = event(0, 'tool/result', {
      turn: 1,
      step: 1,
      message: { id: 'x', role: 'user', source: { kind: 'tool', callId: 'call-1' }, content: 'nope' },
    })
    expect(() => liftToolResult(invalidContent)).toThrow(/exactly one tool-result wrapper/)

    const invalidNestedContent = event(0, 'tool/result', {
      turn: 1,
      step: 1,
      message: {
        ...wrapperMessage(),
        content: [{ type: 'tool-result', toolCallId: 'call-1', content: 'nope' }],
      },
    })
    expect(() => liftToolResult(invalidNestedContent)).toThrow(/tool-result content must be an array/)
  })

  it('refuses a native message that still contains a released wrapper', () => {
    expect(() => {
      assertV4ToolResultMessage(native({
        content: [{ type: 'tool-result', toolCallId: 'call-1', content: [] }],
      }))
    }).toThrow(/must not contain a released tool-result wrapper/)
  })
})
