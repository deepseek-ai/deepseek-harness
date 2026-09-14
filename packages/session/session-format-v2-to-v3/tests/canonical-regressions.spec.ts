import { describe, expect, it } from 'vitest'
import { createSessionFormatCatalog } from '@deepseek-ai/dsh-session-format'
import type { SessionFormatArtifact, SessionFormatEvent, SessionFormatJsonObject } from '@deepseek-ai/dsh-session-format'
import { releasedV0SessionFormatCodec, releasedV1SessionFormatCodec, sessionFormatV0ToV1 } from '@deepseek-ai/dsh-session-format-v0-to-v1'
import { sessionFormatV1ToV2 } from '@deepseek-ai/dsh-session-format-v1-to-v2'
import { assertReleasedV3Header, releasedV2SessionFormatCodec, releasedV3SessionFormatCodec, restoreReleasedV3Artifact, sessionFormatV2ToV3 } from '../src/index.ts'

const header = { version: 2, id: 'canonical:code:session', createdAt: 1, isSeeded: false, delegationDepth: 0 }
const config = { provider: 'mock', model: 'mock', stop: [] }
const catalog = createSessionFormatCatalog({
  currentVersion: 3,
  codecs: [releasedV0SessionFormatCodec, releasedV1SessionFormatCodec, releasedV2SessionFormatCodec, releasedV3SessionFormatCodec],
  migrations: [sessionFormatV0ToV1, sessionFormatV1ToV2, sessionFormatV2ToV3],
  currentEncoder: releasedV3SessionFormatCodec,
  restoreCurrentHeader(value) { assertReleasedV3Header(value); return value },
  restoreCurrent: value => restoreReleasedV3Artifact(value, new Set()),
  restoreTransformedCurrent: value => restoreReleasedV3Artifact(value, new Set()),
})

function event(type: string, seq: number, data: SessionFormatEvent['data'], fields: SessionFormatJsonObject = {}): SessionFormatEvent {
  return { type, seq, time: seq - 20, data, ...fields }
}

function restore(events: readonly SessionFormatEvent[], sourceHeader = header): SessionFormatArtifact {
  const reader = catalog.createRestore({ type: 'session', ...sourceHeader }, { recovery: 'strict', validation: 'current' })
  for (const row of events) reader.decodeRow(row)
  return reader.finish()
}

function reopen(artifact: SessionFormatArtifact): SessionFormatArtifact {
  const reader = catalog.createRestore(releasedV3SessionFormatCodec.encodeHeader(artifact.header, artifact.inheritedEventCount), {
    recovery: 'strict', validation: 'current',
  })
  for (const row of artifact.events) reader.decodeRow(releasedV3SessionFormatCodec.encodeEvent(row))
  return reader.finish()
}

const opening = [event('turn/start', 0, { turn: 1 }), event('step/start', 1, { turn: 1, step: 1 })]
const message = {
  id: 'message:code:1', role: 'user', source: { kind: 'plugin', plugin: 'tools-code-mode' },
  content: [{ type: 'text', text: 'tools-code-mode tool/code-dispatch code 图片' }],
}
const dispatch = {
  rootCallId: 'root:code:1', parentCallId: 'root:code:1', subCallId: 'root:code:1:code:2',
  name: 'run_code', arguments: { code: 'return 3', source: { kind: 'plugin', plugin: 'tools-code-mode' }, start: 4, end: 6 },
}

function seededHistory(): SessionFormatEvent[] {
  return [
    event('agent-preset/selected', 0, { agentPreset: 'code' }),
    event('turn/start', 1, { turn: 1 }),
    event('step/start', 2, { turn: 1, step: 1 }),
    event('request/header', 3, { reason: 'initial', header: { config, system: 'seed prompt', tools: [], adapterDefaults: {} } }),
    event('user/message', 4, message, { surfaceOp: 'append' }),
    event('tool/code-dispatch-start', 5, dispatch),
    event('tool/code-dispatch', 6, { ...dispatch, isError: true, content: message.content }),
    event('step/end', 7, { turn: 1, step: 1 }),
    event('turn/end', 8, { turn: 1, reason: { kind: 'completed' } }),
    event('session-log-deepseek/delivery-accepted', 9, { sessionId: 'parent', throughSeq: 8, sessionFormatVersion: 2 }),
    event('session/end-seed', 10, { inherited: true }),
    event('agent-preset/selected', 11, { agentPreset: 'standard' }),
    event('agent-preset/selected', 12, { agentPreset: 'code' }),
    event('turn/start', 13, { turn: 2 }),
    event('step/start', 14, { turn: 2, step: 1 }),
    event('request/header', 15, { reason: 'change', header: { config, system: 'local prompt', tools: [], adapterDefaults: {} } }),
    event('user/message', 16, { ...message, id: 'message:code:2' }, {
      surfaceOp: { op: 'replace', start: 4, end: 4 }, sourceEventSeqs: [4, 6],
    }),
    event('step/end', 17, { turn: 2, step: 1 }),
    event('turn/end', 18, { turn: 2, reason: { kind: 'completed' } }),
  ]
}

const seededHeader = { ...header, isSeeded: true, parentSession: 'parent', agentPreset: 'code' }

describe('canonical preservation across migration and native reload', () => {
  it('keeps empty stop arrays and nested tool schema values while omitting only empty header optionals', () => {
    const tools = [{ name: 'run_code', description: '', parameters: {
      type: 'object', properties: {}, required: [], tools: [], adapterDefaults: {}, system: '',
      source: { kind: 'plugin', plugin: 'tools-code-mode' },
    } }]
    const first = event('request/header', 2, { reason: 'initial', header: { config, system: ' \n', tools, adapterDefaults: {} } })
    const second = event('request/header', 3, { reason: 'series', header: { config, system: ' \n', tools: [], adapterDefaults: {} } })
    const source = [...opening, first, second]
    const before = JSON.stringify(source)
    const target = restore(source)

    expect(target.events.filter(row => row.type === 'request/header')).toEqual([
      { ...first, seq: 4, data: { reason: 'initial', header: { config, tools } } },
      { ...second, seq: 5, data: { reason: 'series', header: { config } } },
    ])
    expect(target.events.filter(row => row.type === 'system/message').map(row =>
      ((row.data as SessionFormatJsonObject)['message'] as SessionFormatJsonObject)['content'],
    )).toEqual([[], [{ type: 'text', text: ' \n' }]])
    expect(reopen(target)).toEqual(target)
    expect(JSON.stringify(source)).toBe(before)
  })

  it('preserves native code presets, attribution and nested canonical-looking extension values', () => {
    const nativeHeader = { ...header, version: 3, agentPreset: 'code' }
    const extension = { tools: [], adapterDefaults: {}, system: '', surfaceOp: { op: 'replace', start: 90, end: 99 }, agentPreset: 'code' }
    const rows = [
      event('agent-preset/selected', 0, { agentPreset: 'code', extension }),
      event('turn/start', 1, { turn: 1 }),
      event('step/start', 2, { turn: 1, step: 1 }),
      event('user/message', 3, { ...message, source: { ...message.source, extension } }, { surfaceOp: 'append' }),
      event('request/header', 4, { reason: 'initial', header: { config, extension } }),
    ]
    const before = JSON.stringify({ header: nativeHeader, rows })
    const target = restore(rows, nativeHeader)
    expect(target).toEqual({ header: nativeHeader, inheritedEventCount: 0, events: rows })
    expect(reopen(target)).toEqual(target)
    expect(JSON.stringify({ header: nativeHeader, rows })).toBe(before)
  })

  it('composes inherited and local preset selections with shifted heads, PTC failure, replacement and historical delivery', () => {
    const source = seededHistory()
    const before = JSON.stringify({ header: seededHeader, source })
    const target = restore(source, seededHeader)
    const mappedSeqs = [0, 1, 2, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 18, 19, 20, 21]
    expect(target.header).toEqual({ ...seededHeader, version: 3, agentPreset: 'ptc' })
    expect(target.inheritedEventCount).toBe(12)
    expect(target.events.filter(row => row.type !== 'system/message')).toEqual(source.map((row, index) => ({
      ...row, seq: mappedSeqs[index],
      ...(row.type === 'agent-preset/selected' && (row.data as SessionFormatJsonObject)['agentPreset'] === 'code'
        ? { data: { agentPreset: 'ptc' } } : {}),
      ...(row.type === 'request/header' ? { data: { ...row.data as SessionFormatJsonObject, header: { config } } } : {}),
      ...(row.type === 'user/message' ? { data: { ...row.data as SessionFormatJsonObject, source: { kind: 'plugin', plugin: 'tools-ptc' } } } : {}),
      ...(row.type === 'tool/code-dispatch-start' ? { type: 'tool/ptc-dispatch-start' } : {}),
      ...(row.type === 'tool/code-dispatch' ? { type: 'tool/ptc-dispatch' } : {}),
      ...(row.seq === 16 ? { surfaceOp: { op: 'replace', startSeq: 6, endSeq: 6 }, sourceEventSeqs: [6, 8] } : {}),
    })))
    expect(target.events.filter(row => row.type === 'system/message').map(row => ({
      seq: row.seq, time: row.time, surfaceOp: row['surfaceOp'], sourceEventSeqs: row['sourceEventSeqs'],
    }))).toEqual([
      { seq: 3, time: -18, surfaceOp: 'append', sourceEventSeqs: undefined },
      { seq: 4, time: -17, surfaceOp: { op: 'replace', startSeq: 3, endSeq: 3 }, sourceEventSeqs: [3] },
      { seq: 17, time: -5, surfaceOp: { op: 'replace', startSeq: 4, endSeq: 4 }, sourceEventSeqs: [4] },
    ])
    expect(target.events[12]).toEqual({ ...source[10], seq: 12 })
    expect(reopen(target)).toEqual(target)
    expect(JSON.stringify({ header: seededHeader, source })).toBe(before)
  })
})

describe('canonical refusal in composed catalog paths', () => {
  it.each(['tool/ptc-dispatch-start', 'tool/ptc-dispatch', 'agent-preset/selected', 'session-log-deepseek/delivery-accepted'])(
    'does not treat ignorable known %s as an opaque envelope', (type) => {
      const target = restore(seededHistory(), seededHeader)
      const index = target.events.findLastIndex(row => row.type === type)
      const original = target.events[index]!
      for (const metadata of [{ surfaceOp: 'append' }, { sourceEventSeqs: [0] }]) {
        const invalid = { ...original, ignorable: true, ...metadata }
        expect(() => releasedV3SessionFormatCodec.encodeEvent(invalid)).toThrow(/unexpected field/)
        expect(() => restoreReleasedV3Artifact({ ...target, events: target.events.with(index, invalid) }, new Set()))
          .toThrow(/unexpected field/)
        const reader = catalog.createRestore({ type: 'session', ...target.header }, { recovery: 'strict', validation: 'transformed' })
        for (const row of target.events.slice(0, index)) reader.decodeRow(releasedV3SessionFormatCodec.encodeEvent(row))
        expect(() => { reader.decodeRow(invalid) }).toThrow(/unexpected field/)
      }
    },
  )

  it.each(['current', 'transformed'] as const)('refuses target-generation delivery before and after the inherited cut under %s recovery', (validation) => {
    for (const recovery of ['strict', 'recoverable'] as const) {
      for (const inherited of [true, false]) {
        const source = seededHistory()
        const seq = inherited ? 9 : source.length
        const marker = event('session-log-deepseek/delivery-accepted', seq, {
          sessionId: inherited ? 'parent' : header.id, throughSeq: 8, sessionFormatVersion: 3,
        }, { ignorable: true })
        const rows = inherited ? source.with(seq, marker) : [...source, marker]
        const before = JSON.stringify(rows)
        const reader = catalog.createRestore({ type: 'session', ...seededHeader }, { recovery, validation })
        expect(() => {
          for (const row of rows) reader.decodeRow(row)
          reader.finish()
        }).toThrow('format v2 delivery marker claims target format v3')
        expect(JSON.stringify(rows)).toBe(before)
      }
    }
  })

  it('refuses a local foreign V2 watermark even when an earlier inherited watermark has the same owner', () => {
    const source = seededHistory()
    const local = event('session-log-deepseek/delivery-accepted', source.length, {
      sessionId: 'parent', throughSeq: 8, sessionFormatVersion: 2,
    })
    expect(() => restore([...source, local], seededHeader)).toThrow('current-generation delivery marker names the wrong Session')
    expect(restore(source, seededHeader).events.find(row => row.type === 'session-log-deepseek/delivery-accepted')?.data)
      .toEqual(source[9]?.data)
  })
})
