import { describe, expect, it } from 'vitest'
import { createSessionFormatCatalog, SessionFormatEventCollector } from '@deepseek-ai/dsh-session-format'
import type {
  SessionFormatArtifact,
  SessionFormatEvent,
  SessionFormatHeader,
  SessionFormatJsonObject,
  SessionFormatJsonValue,
} from '@deepseek-ai/dsh-session-format'
import { releasedV0SessionFormatCodec, releasedV1SessionFormatCodec, sessionFormatV0ToV1 } from '@deepseek-ai/dsh-session-format-v0-to-v1'
import { releasedV2SessionFormatCodec, sessionFormatV1ToV2 } from '@deepseek-ai/dsh-session-format-v1-to-v2'
import { assertReleasedV3Header, releasedV3SessionFormatCodec, restoreReleasedV3Artifact, sessionFormatV2ToV3 } from '../src/index.ts'
import { canonicalizeTransformedEvent } from '../src/payload.ts'

const header: SessionFormatHeader = {
  version: 2, id: 'canonical-envelopes', createdAt: 1, isSeeded: false, delegationDepth: 0,
}

function event(
  type: string,
  seq: number,
  data: SessionFormatJsonValue,
  optional: SessionFormatJsonObject = {},
): SessionFormatEvent {
  return { type, seq, time: seq + 1, data, ...optional }
}

function user(seq: number, optional: SessionFormatJsonObject = { surfaceOp: 'append' }): SessionFormatEvent {
  return event('user/message', seq, {
    id: `user-${seq}`, role: 'user', content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' },
  }, optional)
}

function opening(): SessionFormatEvent[] {
  return [event('turn/start', 0, { turn: 1 }), event('step/start', 1, { turn: 1, step: 1 })]
}

function artifact(events: readonly SessionFormatEvent[]): SessionFormatArtifact {
  return { header: { ...header, version: 3 }, inheritedEventCount: 0, events }
}

function migrate(
  events: readonly SessionFormatEvent[],
  sourceHeader = header,
  sourceInheritedEventCount: number | undefined = 0,
): SessionFormatArtifact {
  const targetHeader = sessionFormatV2ToV3.migrateHeader(sourceHeader)
  const stage = sessionFormatV2ToV3.createStage({
    sourceHeader, targetHeader, sourceInheritedEventCount, sourceKind: 'decoded',
  })
  const output = new SessionFormatEventCollector()
  for (const item of events) stage.transformEvent(item, output)
  const inheritedEventCount = stage.finish(output)
  return { header: targetHeader, inheritedEventCount, events: output.values }
}

function restore(value: SessionFormatArtifact): SessionFormatArtifact {
  return restoreReleasedV3Artifact(value, new Set())
}

function toolLog(isError: boolean, error?: SessionFormatJsonValue): SessionFormatEvent[] {
  return [
    event('turn/start', 0, { turn: 1 }),
    event('step/start', 1, { turn: 1, step: 1 }),
    event('assistant/message', 2, {
      turn: 1, step: 1, stream: [],
      message: {
        id: 'assistant', role: 'assistant', source: { kind: 'model', provider: 'mock', model: 'mock' },
        content: [{ type: 'tool-call', id: 'call', name: 'read', arguments: '{}' }],
      },
    }, { surfaceOp: 'append' }),
    event('tool/call', 3, { turn: 1, step: 1, callId: 'call', name: 'read', arguments: '{}' }),
    event('tool/result', 4, {
      turn: 1, step: 1,
      message: {
        id: 'tool', role: 'user', source: { kind: 'tool', callId: 'call' },
        content: [{ type: 'tool-result', toolCallId: 'call', isError, content: [{ type: 'text', text: 'result' }] }],
      },
      ...(error === undefined ? {} : { error }),
    }, { surfaceOp: 'append', sourceEventSeqs: [3] }),
    event('step/end', 5, { turn: 1, step: 1 }),
    event('turn/end', 6, { turn: 1, reason: { kind: 'completed' } }),
  ]
}

describe('canonical V2 to V3 envelopes', () => {
  it('renames replacement keys after structural insertion and remaps source-event references', () => {
    const first = user(2)
    const replacement = user(3, { surfaceOp: { op: 'replace', start: 2, end: 2 }, sourceEventSeqs: [2] })
    const source = [...opening(), first, replacement]
    const before = JSON.stringify(source)
    const target = migrate(source)

    expect(target.events.slice(3)).toEqual([{ ...first, seq: 3 }, {
      ...replacement, seq: 4, surfaceOp: { op: 'replace', startSeq: 3, endSeq: 3 }, sourceEventSeqs: [3],
    }])
    expect(target.events[0]).toEqual(source[0])
    expect(target.events[4]).not.toBe(replacement)
    expect(target.events[4]?.data).toBe(replacement.data)
    expect(JSON.stringify(source)).toBe(before)
    expect(restore(target)).toBe(target)
  })

  it('remaps the seed cut and retains other-session captured references', () => {
    const reference = { sessionId: 'source', label: 'source', capturedFormatVersion: 2, capturedThroughSeq: 9, compacted: false, originalMessages: 1, retainedMessages: 1, omittedMessages: 0, omittedBytes: 0, truncated: false, inputIndex: 0 }
    const captured = user(2)
    const source = [
      ...opening(),
      { ...captured, data: { ...captured.data as SessionFormatJsonObject, source: { kind: 'session-reference', form: 'recall', version: 1, references: [reference] } } },
      event('session/end-seed', 3, { inherited: true }),
      user(4),
    ]
    const target = migrate(source, { ...header, isSeeded: true, parentSession: 'parent' }, 3)

    expect(target.inheritedEventCount).toBe(4)
    expect(target.events[0]).toEqual(source[0])
    expect(target.events[3]?.data).toBe(source[2]?.data)
    expect(target.events[4]).toEqual({ ...source[3], seq: 4 })
    expect(target.events[5]).toEqual({ ...source[4], seq: 5 })
    expect(((target.events[3]?.data as SessionFormatJsonObject)['source'] as SessionFormatJsonObject)['references']).toEqual([reference])
    expect(restore(target)).toBe(target)
  })

  it.each([
    ['system', { system: '' }, /header.system/],
    ['tools', { tools: [] }, /empty optional header fields/],
    ['adapterDefaults', { adapterDefaults: {} }, /empty optional header fields/],
    ['all', { system: '', tools: [], adapterDefaults: {} }, /header.system/],
  ] satisfies [string, SessionFormatJsonObject, RegExp][])(
    'omits empty request/header optionals after extracting system: %s', (_name, empty, diagnostic) => {
      const config = { provider: 'mock', model: 'mock' }
      const request = event('request/header', 2, { reason: 'initial', header: { config, ...empty } })
      const source = [...opening(), request]
      const before = JSON.stringify(source)
      const target = migrate(source)

      expect(target.events[3]).toEqual({ ...request, seq: 3, data: { reason: 'initial', header: { config } } })
      expect(((target.events[3]?.data as SessionFormatJsonObject)['header'] as SessionFormatJsonObject)['config']).toBe(config)
      expect(JSON.stringify(source)).toBe(before)
      expect(restore(target)).toBe(target)
      expect(() => restore(artifact(source))).toThrow(diagnostic)
    },
  )

  it('retains nonempty tools and defaults while extracting every nonempty system prompt', () => {
    const tools = [{ name: 'read', description: 'read', parameters: {} }]
    const adapterDefaults = { maxTokens: true }
    for (const system of [undefined, ' ']) {
      const request = event('request/header', 2, {
        reason: 'initial', header: { config: { provider: 'mock', model: 'mock', maxTokens: 20 }, tools, adapterDefaults, ...(system === undefined ? {} : { system }) },
      })
      const target = migrate([...opening(), request])
      const targetHeader = (target.events.at(-1)?.data as SessionFormatJsonObject)['header'] as SessionFormatJsonObject
      expect(targetHeader).toEqual({ config: { provider: 'mock', model: 'mock', maxTokens: 20 }, tools, adapterDefaults })
      expect(targetHeader['tools']).toBe(tools)
      expect(targetHeader['adapterDefaults']).toBe(adapterDefaults)
      expect(target.events.filter(item => item.type === 'system/message')).toHaveLength(system === undefined ? 1 : 2)
      expect(restore(target)).toBe(target)
    }
  })

  it.each([
    ['null', null],
    ['array', []],
    ['scalar', true],
    ['missing end', { op: 'replace', start: 0 }],
    ['wrong op', { op: 'append', start: 0, end: 0 }],
    ['extra field', { op: 'replace', start: 0, end: 0, extra: true }],
    ['V3 fields', { op: 'replace', startSeq: 0, endSeq: 0 }],
    ['mixed fields', { op: 'replace', start: 0, endSeq: 0 }],
    ['both generations', { op: 'replace', start: 0, end: 0, startSeq: 0, endSeq: 0 }],
    ['negative start', { op: 'replace', start: -1, end: 0 }],
    ['fractional end', { op: 'replace', start: 0, end: 0.5 }],
    ['current endpoint', { op: 'replace', start: 2, end: 3 }],
  ] satisfies [string, SessionFormatJsonValue][])(
    'refuses malformed V2 replacement rather than repairing it: %s', (_name, surfaceOp) => {
      expect(() => migrate([...opening(), user(2), user(3, { surfaceOp, sourceEventSeqs: [2] })]))
        .toThrow(_name === 'negative start' ? /surface start must be a non-negative safe integer/ : _name === 'fractional end' ? /surface end must be a non-negative safe integer/ : /surfaceOp|replace|replacement/)
    },
  )

  it.each([
    ['extra field', { op: 'replace', start: 0, end: 0, extra: true }],
    ['wrong op', { op: 'append', start: 0, end: 0 }],
    ['missing start', { op: 'replace', startSeq: 0, end: 0 }],
    ['missing end', { op: 'replace', start: 0, endSeq: 0 }],
  ] satisfies [string, SessionFormatJsonObject][])(
    'refuses malformed released markers at transformed-event admission: %s', (_name, surfaceOp) => {
      const source = user(1, { surfaceOp, sourceEventSeqs: [0] })
      const before = JSON.stringify(source)
      expect(() => canonicalizeTransformedEvent(source))
        .toThrow('format v2 user/message at seq 1 requires exact replace fields op/start/end')
      expect(JSON.stringify(source)).toBe(before)
    },
  )

  it.each([
    ['V2 fields', { op: 'replace', start: 0, end: 0 }],
    ['mixed fields', { op: 'replace', start: 0, endSeq: 0 }],
    ['both generations', { op: 'replace', start: 0, end: 0, startSeq: 0, endSeq: 0 }],
    ['empty object', {}],
    ['missing end', { op: 'replace', startSeq: 0 }],
    ['extra field', { op: 'replace', startSeq: 0, endSeq: 0, extra: true }],
  ] satisfies [string, SessionFormatJsonValue][])(
    'requires canonical replacement fields on native V3: %s', (_name, surfaceOp) => {
      expect(() => restore(artifact([user(0), user(1, { surfaceOp, sourceEventSeqs: [0] })])))
        .toThrow(/exact replace fields/)
    },
  )
})

describe.each(['migration', 'native V3'] as const)('%s event admission', (mode) => {
  const admit = (events: readonly SessionFormatEvent[]) => mode === 'migration'
    ? migrate(events)
    : restore(artifact(events))

  it.each(['user/message', 'assistant/message', 'tool/result'])('requires a surface marker on %s', (type) => {
    expect(() => admit([event(type, 0, {})])).toThrow(mode === 'migration' ? /requires surfaceOp/ : /requires a surfaceOp/)
  })

  it.each(['feedback/record', 'assistant/attempt'])(
    'forbids surface metadata on log-only %s', (type) => {
      const variants: SessionFormatJsonObject[] = [{ surfaceOp: 'append' }, { sourceEventSeqs: [] }]
      for (const metadata of variants) {
        expect(() => admit([event(type, 0, {}, metadata)])).toThrow(/unexpected field/)
      }
    },
  )

  it.each([
    ['empty array', []], ['nonempty array', [0]], ['null', null], ['boolean', false],
  ] satisfies [string, SessionFormatJsonValue][])('forbids assistant sourceEventSeqs: %s', (_name, sourceEventSeqs) => {
    const events = toolLog(false)
    events[2] = { ...events[2]!, sourceEventSeqs }
    expect(() => admit(events)).toThrow(mode === 'migration' ? /chunk references/ : /cannot carry sourceEventSeqs/)
  })

  it.each([
    ['empty', []], ['scalar', 0], ['null', null], ['negative', [-1]], ['fractional', [0.5]],
    ['unsafe integer', [Number.MAX_SAFE_INTEGER + 1]], ['current', [3]], ['future', [4]], ['duplicate', [0, 0]],
  ] satisfies [string, SessionFormatJsonValue][])(
    'refuses invalid source-event references: %s', (_name, sourceEventSeqs) => {
      expect(() => admit([...opening(), user(2), user(3, { surfaceOp: 'append', sourceEventSeqs })]))
        .toThrow(/sourceEventSeqs/)
    },
  )

  it.each(['type', 'seq', 'time', 'data'])('requires logical envelope member %s', (key) => {
    const malformed = Object.fromEntries(Object.entries(user(0)).filter(([member]) => member !== key))
    const diagnostic = mode === 'migration' && key === 'type' ? /unclassified event undefined/
      : mode === 'migration' && key === 'seq' ? /source events must be dense/ : /lacks required field/
    expect(() => admit([malformed as SessionFormatEvent])).toThrow(diagnostic)
  })

  it.each([
    ['non-string type', { type: false, seq: 0, time: 1, data: {} }, /type must be a string/],
    ['false ignorable marker', { ...user(0), ignorable: false }, /ignorable must be true/],
    ['null ignorable marker', { ...user(0), ignorable: null }, /ignorable must be true/],
  ] satisfies [string, SessionFormatJsonObject, RegExp][])('rejects invalid envelope values: %s', (_name, malformed, message) => {
    expect(() => admit([malformed as SessionFormatEvent])).toThrow(mode === 'migration' && _name === 'non-string type' ? /unclassified event false/ : message)
  })

  it('rejects a successful tool result carrying error metadata', () => {
    expect(() => admit(toolLog(false, { name: 'ReadError', code: 'READ_FAILED' })))
      .toThrow(/error metadata for a non-error tool result/)
  })

  it.each([undefined, { name: 'ReadError', code: 'READ_FAILED' }])(
    'preserves failed tool results without inventing or deleting error metadata: %j', (error) => {
      const events = toolLog(true, error)
      const target = admit(events)
      const result = target.events.find(item => item.type === 'tool/result')!
      expect(result.data).toBe(events[4]?.data)
      expect(result.seq).toBe(mode === 'migration' ? 5 : 4)
      expect(result['sourceEventSeqs']).toEqual(mode === 'migration' ? [4] : [3])
      expect((result.data as SessionFormatJsonObject)['error']).toBe(error)
      expect(restore(target)).toBe(target)
    },
  )
})

describe('native V3 opaque event preservation', () => {
  it.each(['external/future', 'tool/code-dispatch-start', 'tool/code-dispatch'])(
    'preserves arbitrary data and surface metadata on ignorable %s', (type) => {
      for (const data of [null, false, ['opaque'], { nested: { sourceEventSeqs: [900], surfaceOp: null } }]) {
        for (const metadata of [
          { sourceEventSeqs: null, surfaceOp: false },
          { sourceEventSeqs: [900, 900], surfaceOp: { future: ['opaque'] } },
        ]) {
          const source = event(type, 0, data, { ignorable: true, ...metadata })
          const value = artifact([source])
          const before = JSON.stringify(value)
          expect(restore(value)).toBe(value)
          expect(JSON.stringify(value)).toBe(before)
          expect(() => migrate([source])).toThrow(type === 'external/future' ? /cannot safely transform unclassified event/ : /unexpected field sourceEventSeqs/)
        }
      }
    },
  )

  it.each(['external/future', 'tool/code-dispatch-start', 'tool/code-dispatch'])(
    'round-trips ignorable %s with physical source-event ranges and arbitrary data', (type) => {
      for (const data of [null, false, ['opaque'], { nested: { sourceEventSeqs: null } }]) {
        const source = event(type, 1, data, { ignorable: true, sourceEventSeqs: [0], surfaceOp: { future: ['opaque'] } })
        const row = releasedV3SessionFormatCodec.encodeEvent(source)
        const decoder = releasedV3SessionFormatCodec.createDecoder({ type: 'session', ...header, version: 3 }, 'strict')
        const output = new SessionFormatEventCollector()
        const first = event('feedback/record', 0, { text: 'prior' })
        decoder.decodeRow(first, output)
        decoder.decodeRow(row, output)
        expect(decoder.finish(output)).toBe(0)
        expect(output.values).toEqual([first, source])
      }
    },
  )

  it.each(['system/message', 'user/message', 'assistant/message', 'tool/result'])(
    'requires exact replacement envelope fields on %s', (type) => {
      const data = type === 'system/message'
        ? { turn: 1, step: 1, message: { id: 'system', role: 'system', content: [], source: { kind: 'plugin', plugin: 'context' } } }
        : {}
      for (const surfaceOp of [
        { op: 'replace', start: 0, end: 0 },
        { op: 'replace', startSeq: 0, endSeq: 0, extra: true },
      ]) {
        expect(() => releasedV3SessionFormatCodec.encodeEvent(event(type, 1, data, { surfaceOp })))
          .toThrow(/exact replace fields/)
      }
    },
  )

  it.each(['', 'prompt', null, false, [], {}])('hard-refuses native header.system %j after corruption', (system) => {
    const row = event('request/header', 2, { reason: 'initial', header: { config: { provider: 'mock', model: 'mock' }, system } })
    for (const recovery of ['strict', 'recoverable'] as const) {
      const decoder = releasedV3SessionFormatCodec.createDecoder({ type: 'session', ...header, version: 3 }, recovery)
      const output = new SessionFormatEventCollector()
      if (recovery === 'recoverable') decoder.decodeRow(null, output)
      expect(() => { decoder.decodeRow(row, output) }).toThrow(/header.system/)
      expect(() => releasedV3SessionFormatCodec.encodeEvent(row)).toThrow(/header.system/)
    }
  })
})

describe('native V3 physical admission', () => {
  const physicalHeader = { type: 'session', ...header, version: 3 }
  const catalog = createSessionFormatCatalog({
    currentVersion: 3,
    codecs: [releasedV0SessionFormatCodec, releasedV1SessionFormatCodec, releasedV2SessionFormatCodec, releasedV3SessionFormatCodec],
    migrations: [sessionFormatV0ToV1, sessionFormatV1ToV2, sessionFormatV2ToV3],
    currentEncoder: releasedV3SessionFormatCodec,
    restoreCurrentHeader(value) { assertReleasedV3Header(value); return value },
    restoreCurrent: restore,
    restoreTransformedCurrent: restore,
  })
  const invalidRows: [string, SessionFormatEvent, RegExp][] = [
    ['missing surface marker', user(1, {}), /requires a surfaceOp/],
    ['old replacement', user(1, { surfaceOp: { op: 'replace', start: 0, end: 0 } }), /exact replace fields/],
    ['current replacement start', user(1, { surfaceOp: { op: 'replace', startSeq: 1, endSeq: 0 } }), /replacement endpoints must reference earlier events/],
    ['future replacement start', user(1, { surfaceOp: { op: 'replace', startSeq: 2, endSeq: 0 } }), /replacement endpoints must reference earlier events/],
    ['current replacement end', user(1, { surfaceOp: { op: 'replace', startSeq: 0, endSeq: 1 } }), /replacement endpoints must reference earlier events/],
    ['future replacement end', user(1, { surfaceOp: { op: 'replace', startSeq: 0, endSeq: 2 } }), /replacement endpoints must reference earlier events/],
    ['empty header optional', event('request/header', 1, {
      reason: 'initial', header: { config: { provider: 'mock', model: 'mock' }, tools: [] },
    }), /empty optional header fields/],
    ['contradictory tool result', { ...toolLog(false, { code: 'FAILED' })[4]!, seq: 1, sourceEventSeqs: [0] }, /non-error tool result/],
  ]

  it.each(invalidRows)('rejects %s through strict decoding and encoding', (_name, invalid, message) => {
    const decoder = releasedV3SessionFormatCodec.createDecoder(physicalHeader, 'strict')
    const output = new SessionFormatEventCollector()
    decoder.decodeRow(event('turn/start', 0, { turn: 1 }), output)
    expect(() => { decoder.decodeRow(invalid, output) }).toThrow(message)
    expect(() => releasedV3SessionFormatCodec.encodeEvent(invalid)).toThrow(message)
  })

  it.each(invalidRows)('rejects %s even when native catalog validation is transformed', (_name, invalid, message) => {
    const reader = catalog.createRestore(physicalHeader, { recovery: 'strict', validation: 'transformed' })
    reader.decodeRow(event('turn/start', 0, { turn: 1 }))
    expect(() => { reader.decodeRow(invalid) }).toThrow(message)
  })

  it.each(invalidRows)('discards an incomplete invalid tail containing %s', (_name, invalid) => {
    const decoder = releasedV3SessionFormatCodec.createDecoder(physicalHeader, 'recoverable')
    const output = new SessionFormatEventCollector()
    const opening = event('turn/start', 0, { turn: 1 })
    decoder.decodeRow(opening, output)
    decoder.decodeRow(invalid, output)
    decoder.decodeRow(user(2), output)
    expect(decoder.finish(output)).toBe(0)
    expect(output.values).toEqual([opening])
  })

  it.each(invalidRows)('refuses a later commit after %s', (_name, invalid, message) => {
    const decoder = releasedV3SessionFormatCodec.createDecoder(physicalHeader, 'recoverable')
    const output = new SessionFormatEventCollector()
    decoder.decodeRow(event('turn/start', 0, { turn: 1 }), output)
    decoder.decodeRow(invalid, output)
    expect(() => { decoder.decodeRow(event('turn/end', 2, { turn: 1, reason: { kind: 'completed' } }), output) })
      .toThrow(message)
  })

  it('retains the accepted seeded cut before a discarded invalid marker', () => {
    const decoder = releasedV3SessionFormatCodec.createDecoder({ ...physicalHeader, isSeeded: true }, 'recoverable')
    const output = new SessionFormatEventCollector()
    const first = event('external/event', 0, {}, { ignorable: true })
    const marker = event('session/end-seed', 1, { inherited: true })
    decoder.decodeRow(first, output)
    decoder.decodeRow(marker, output)
    decoder.decodeRow(event('session/end-seed', 2, { inherited: true }, { surfaceOp: 'append' }), output)
    decoder.decodeRow(user(3), output)
    expect(decoder.finish(output)).toBe(1)
    expect(output.values).toEqual([first, marker])
  })

  it('rejects a seeded log whose only inherited marker was discarded', () => {
    const decoder = releasedV3SessionFormatCodec.createDecoder({ ...physicalHeader, isSeeded: true }, 'recoverable')
    const output = new SessionFormatEventCollector()
    decoder.decodeRow(event('session/end-seed', 0, { inherited: true }, { surfaceOp: 'append' }), output)
    expect(() => decoder.finish(output)).toThrow(/lacks an accepted inherited end-seed marker/)
    expect(output.values).toEqual([])
  })

  it('ignores a discarded inherited marker in an unseeded semantic tail', () => {
    const decoder = releasedV3SessionFormatCodec.createDecoder(physicalHeader, 'recoverable')
    const output = new SessionFormatEventCollector()
    const first = event('external/event', 0, {}, { ignorable: true })
    decoder.decodeRow(first, output)
    decoder.decodeRow(user(1, {}), output)
    decoder.decodeRow(event('session/end-seed', 2, { inherited: true }), output)
    expect(decoder.finish(output)).toBe(0)
    expect(output.values).toEqual([first])
  })

  it.each([0, 1])('rejects an accepted inherited marker at seq %s in an unseeded log with a discarded tail', (seq) => {
    const decoder = releasedV3SessionFormatCodec.createDecoder(physicalHeader, 'recoverable')
    const output = new SessionFormatEventCollector()
    if (seq === 1) decoder.decodeRow(event('external/event', 0, {}, { ignorable: true }), output)
    decoder.decodeRow(event('session/end-seed', seq, { inherited: true }), output)
    decoder.decodeRow(user(seq + 1, {}), output)
    expect(() => decoder.finish(output)).toThrow(/unseeded Session contains an inherited end-seed marker/)
  })

  it('preserves ordinary untagged markers during recovery', () => {
    const decoder = releasedV3SessionFormatCodec.createDecoder(physicalHeader, 'recoverable')
    const output = new SessionFormatEventCollector()
    const marker = event('session/end-seed', 0, {})
    decoder.decodeRow(marker, output)
    decoder.decodeRow(user(1, {}), output)
    expect(decoder.finish(output)).toBe(0)
    expect(output.values).toEqual([marker])
  })

  it('preserves a canonical native artifact through transformed catalog decoding', () => {
    const reader = catalog.createRestore(physicalHeader, { recovery: 'strict', validation: 'transformed' })
    const source = toolLog(false)
    for (const item of source) reader.decodeRow(releasedV3SessionFormatCodec.encodeEvent(item))
    expect(reader.finish()).toEqual(artifact(source))
  })
})

describe('V3 full artifact relationships', () => {
  it.each([{ surfaceOp: 'append' }, { sourceEventSeqs: [] }])('defers unclassified required metadata %j until vocabulary-aware restoration', (metadata) => {
    const required = event('future/required', 0, {}, metadata)
    const output = new SessionFormatEventCollector()
    const decoder = releasedV3SessionFormatCodec.createDecoder({ type: 'session', ...header, version: 3 }, 'recoverable')
    decoder.decodeRow(required, output)
    expect(decoder.finish(output)).toBe(0)
    expect(output.values).toEqual([required])
    expect(() => restore(artifact(output.values))).toThrow(/unknown event type/)
    expect(() => restoreReleasedV3Artifact(artifact(output.values), new Set(['future/required'])))
      .toThrow(/unexpected field/)
  })

  it('admits installed required extension payloads without surface metadata', () => {
    const required = event('future/required', 0, { extension: true })
    const value = artifact([required])
    expect(restoreReleasedV3Artifact(value, new Set(['future/required']))).toBe(value)
  })

  it('accepts repeated replacement whose endpoints reverse numeric order', () => {
    const source = [
      ...opening(), user(2), user(3), user(4),
      user(5, { surfaceOp: { op: 'replace', start: 2, end: 3 }, sourceEventSeqs: [2, 3] }),
      user(6, { surfaceOp: { op: 'replace', start: 5, end: 4 }, sourceEventSeqs: [5, 4] }),
    ]
    const target = migrate(source)
    expect(target.events[7]?.['surfaceOp']).toEqual({ op: 'replace', startSeq: 6, endSeq: 5 })
    expect(restore(target)).toBe(target)
    const native = artifact([
      user(0), user(1), user(2),
      user(3, { surfaceOp: { op: 'replace', startSeq: 0, endSeq: 1 }, sourceEventSeqs: [0, 1] }),
      user(4, { surfaceOp: { op: 'replace', startSeq: 3, endSeq: 2 }, sourceEventSeqs: [3, 2] }),
    ])
    expect(restore(native)).toBe(native)
  })

  it.each([
    ['shadowed endpoint', 2, 4, [2, 4], /range is not on the current surface/],
    ['reversed surface order', 4, 5, [4, 5], /range is not on the current surface/],
    ['missing source-event references', 5, 4, undefined, /omit a shadowed surface node/],
    ['incomplete source-event references', 5, 4, [5], /omit a shadowed surface node/],
  ] as const)('retains range and source-coverage validation: %s', (_name, start, end, sources, message) => {
    const source = [
      ...opening(), user(2), user(3), user(4),
      user(5, { surfaceOp: { op: 'replace', start: 2, end: 3 }, sourceEventSeqs: [2, 3] }),
      user(6, {
        surfaceOp: { op: 'replace', start, end },
        ...(sources === undefined ? {} : { sourceEventSeqs: sources }),
      }),
    ]
    const target = migrate(source)
    expect(() => restore(target)).toThrow(message)
  })

  it('retains advertised tool lifecycle validation after local envelope admission', () => {
    const events = toolLog(true)
    events[3] = event('feedback/record', 3, { text: 'not a tool call' })
    expect(() => restore(migrate(events))).toThrow(/not the exact TOOL_NOT_STARTED repair/)
  })
})
