import { describe, expect, it } from 'vitest'
import { SessionFormatEventCollector } from '@deepseek-ai/dsh-session-format'
import type { SessionFormatEvent, SessionFormatJsonObject } from '@deepseek-ai/dsh-session-format'
import { createSessionFormatCatalogWithChildren, sessionFormatCatalog } from '@deepseek-ai/dsh-session-format-catalog'
import { assertV4MessageSources, assertV4SourceRowAdmission } from '../src/message-sources.ts'
import { releasedV4SessionFormatCodec } from '../src/codec.ts'

const header = { type: 'session', version: 4, id: 'sources', createdAt: 1, delegationDepth: 0, isSeeded: false }
function event(source: unknown): SessionFormatEvent {
  return { type: 'user/message', seq: 0, time: 1, surfaceOp: 'append', data: { id: 'u', role: 'user', source, content: [{ type: 'text', text: 'hello' }] } } as SessionFormatEvent
}

function restore(source: unknown, version: 3 | 4 = 4) {
  const reader = createSessionFormatCatalogWithChildren([]).createRestore({ ...header, version }, { recovery: 'strict', validation: 'current' })
  reader.decodeRow(JSON.parse(JSON.stringify(event(source))))
  return reader.finish()
}

describe('V4 source admission', () => {
  it.each(['constructor', 'toString', '__proto__'])('migrates external producer %s without interpreting inherited object keys', (plugin) => {
    const before = JSON.parse(`{"kind":"plugin","plugin":"${plugin}","__proto__":{"tag":"metadata"},"nested":{"kind":"plugin","plugin":"opaque"}}`) as SessionFormatJsonObject
    const expected = JSON.parse(`{"kind":"plugin:${plugin}","__proto__":{"tag":"metadata"},"nested":{"kind":"plugin","plugin":"opaque"}}`) as SessionFormatJsonObject
    const migrated = restore(before, 3)
    expect(migrated.events[0]?.data).toMatchObject({ source: expected })
    expect(Object.hasOwn((migrated.events[0]?.data as { source: object }).source, '__proto__')).toBe(true)
    expect(JSON.stringify(restore(expected))).toBe(JSON.stringify(migrated))
    expect(before['kind']).toBe('plugin')
  })

  it.each(['acme', 'plugin:acme', 'source:acme', '__proto__'])('retains direct source kind %s through migration and native restore', (kind) => {
    const source = { kind, extra: { kind: 'plugin', plugin: 'opaque' } }
    const migrated = restore(source, 3)
    expect(migrated.events[0]?.data).toMatchObject({ source })
    expect(restore(source)).toEqual(migrated)
  })

  it('rejects missing, malformed, empty, and retired source kinds', () => {
    for (const source of [null, [], {}, { kind: '' }, { kind: 1 }, { kind: 'plugin', plugin: 'compact' }]) {
      expect(() => restore(source)).toThrow(/producer-owned source kind/)
      expect(() => { assertV4MessageSources(event(source)) }).toThrow(/producer-owned source kind/)
    }
  })

  it('rejects retired wrappers in every declared message slot before recovery can discard them', () => {
    const message = event({ kind: 'plugin', plugin: 'compact' }).data
    const rows = [event({ kind: 'plugin', plugin: 'compact' }), ...['system/message', 'assistant/message', 'tool/result'].map(type => ({ type, seq: 0, time: 1, data: { message } })), { type: 'agent/inbox/spliced', seq: 0, time: 1, data: { inserted: [message] } }, { type: 'session/title-llm-request', seq: 0, time: 1, data: { messages: [message] } }]
    for (const row of rows) {
      const decoder = releasedV4SessionFormatCodec.createDecoder(header, 'recoverable')
      const output = new SessionFormatEventCollector()
      decoder.decodeRow(null, output)
      expect(() => { decoder.decodeRow(row, output) }).toThrow(/producer-owned source kind/)
      expect(() => sessionFormatCatalog.encodeCurrentEvent(row)).toThrow(/producer-owned source kind/)
    }
  })

  it('leaves malformed incomplete rows for normal scanner corruption handling', () => {
    for (const row of [null, { type: 'user/message', data: null }, { type: 'system/message', data: {} }, { type: 'agent/inbox/spliced', data: { inserted: false } }, { type: 'agent/inbox/spliced', data: { inserted: [null] } }, { type: 'session/title-llm-request', data: { messages: [event({ kind: 'user' }).data] } }, { type: 'external/event', data: { source: { kind: 'plugin' } } }]) {
      expect(() => { assertV4SourceRowAdmission(row) }).not.toThrow()
    }
  })
})
