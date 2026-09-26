import { describe, expect, it } from 'vitest'
import { SessionFormatEventCollector, type SessionFormatEvent } from '@deepseek-ai/dsh-session-format'
import { createSessionFormatCatalogWithChildren, sessionFormatCatalog } from '@deepseek-ai/dsh-session-format-catalog'
import { releasedV4SessionFormatCodec } from '../src/codec.ts'

const header = { type: 'session', version: 4, id: 'system-fields', createdAt: 1, delegationDepth: 0, isSeeded: false }
const migrated = createSessionFormatCatalogWithChildren([]).createRestore({ ...header, version: 3 }, { recovery: 'strict', validation: 'current' })
for (const event of [
  { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
  { type: 'step/start', seq: 1, time: 1, data: { turn: 1, step: 1 } },
  { type: 'system/message', seq: 2, time: 1, surfaceOp: 'append', data: { turn: 1, step: 1, message: {
    id: 'system', role: 'system', source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt' }, content: [],
  } } },
]) migrated.decodeRow(event)
const source = (migrated.finish().events[2]?.data as { message: { source: object } }).message.source
const attachment = { attachmentId: 'sha256:image', mediaType: 'image/png', bytes: 1, width: 1, height: 1 }
const message = (content: unknown) => ({ id: 'system', role: 'system', source, content })
const row = (data: unknown): SessionFormatEvent => ({ type: 'system/message', seq: 2, time: 1, surfaceOp: 'append', data }) as SessionFormatEvent

function restored(data: unknown) {
  const read = sessionFormatCatalog.createRestore(header, { recovery: 'strict', validation: 'current' })
  for (const event of [{ type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } }, { type: 'step/start', seq: 1, time: 1, data: { turn: 1, step: 1 } }, row(data)]) {
    read.decodeRow(JSON.parse(JSON.stringify(sessionFormatCatalog.encodeCurrentEvent(event))))
  }
  return read.finish()
}

describe('native system-message fields', () => {
  it('preserves required fields and extra JSON on known and extensible block types', () => {
    const content = [
      { type: 'text', text: '', extension: { keep: true } }, { type: 'reasoning', text: 'reasoning' },
      { type: 'tool-call', id: 'call', name: 'read', arguments: '{}' }, { type: 'file', extension: true },
      { type: 'image', attachment }, { type: 'image', attachment: {
        ...attachment, name: 'name', originalDimensions: { width: 1, height: 2 }, extension: true,
      } },
    ]
    const data = { turn: 1, step: 1, message: message(content), extra: true }
    expect(restored(data).events[2]?.data).toEqual(data)
  })

  it('rejects malformed fields before a recoverable scanner can discard the row', () => {
    const contents = [
      null, [null], [{}], [{ type: '' }], [{ type: 'text', text: 1 }], [{ type: 'tool-call', id: '' }],
      [{ type: 'tool-call', id: 'id', name: '' }], [{ type: 'tool-call', id: 'id', name: 'name', arguments: null }],
      [{ type: 'tool-result', toolCallId: 'call', content: [] }],
      ...[null, { ...attachment, mediaType: 'text/plain' }, { ...attachment, attachmentId: '' }, { ...attachment, bytes: -1 }, { ...attachment, width: 0 }, { ...attachment, height: 0 }, { ...attachment, name: 1 }, { ...attachment, originalDimensions: null }, { ...attachment, originalDimensions: { width: 0, height: 1 } }, { ...attachment, originalDimensions: { width: 1, height: 0 } }].map(value => ({ type: 'image', attachment: value })).map(block => [block]),
    ]
    const invalid = [null, { turn: 0, step: 1 }, { turn: 1, step: 0 }, { turn: 1, step: 1, message: null },
      ...[{ ...message([]), id: '' }, { ...message([]), role: 'user' }, ...contents.map(message)].map(value => ({ turn: 1, step: 1, message: value })),
    ]
    for (const data of invalid) {
      expect(() => restored(data)).toThrow()
      const read = releasedV4SessionFormatCodec.createDecoder(header, 'recoverable')
      const output = new SessionFormatEventCollector()
      read.decodeRow(null, output)
      expect(() => { read.decodeRow(row(data), output) }).toThrow()
    }
  })
})
