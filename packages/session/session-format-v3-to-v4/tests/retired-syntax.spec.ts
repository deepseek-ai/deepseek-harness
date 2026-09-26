import { describe, expect, it } from 'vitest'
import { SessionFormatEventCollector, type SessionFormatEvent } from '@deepseek-ai/dsh-session-format'
import { sessionFormatCatalog } from '@deepseek-ai/dsh-session-format-catalog'
import { releasedV4SessionFormatCodec, restoreReleasedV4Artifact } from '../src/index.ts'

const header = { version: 4, id: 'native-syntax', createdAt: 1, delegationDepth: 0, isSeeded: false }
const physical = { type: 'session', ...header }
const request = (data: unknown): SessionFormatEvent => ({ type: 'request/header', seq: 1, time: 1, data }) as SessionFormatEvent
const turn: SessionFormatEvent = { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } }

describe('native retired syntax admission', () => {
  it('rejects retired headers and PTC tags in strict reads, encoding, and recoverable suffixes', () => {
    const invalid = [
      request(null), request({ header: null }), request({ header: { config: { provider: 'mock', model: 'mock' }, system: '' } }),
      { type: 'tool/code-dispatch-start', seq: 1, time: 1, data: {} },
      { type: 'tool/code-dispatch', seq: 1, time: 1, data: {} },
    ]
    for (const event of invalid) {
      expect(() => sessionFormatCatalog.encodeCurrentEvent(event)).toThrow()
      const read = sessionFormatCatalog.createRestore(physical, { recovery: 'strict', validation: 'current' })
      read.decodeRow(turn)
      expect(() => { read.decodeRow(event) }).toThrow()
      const scanner = releasedV4SessionFormatCodec.createDecoder(physical, 'recoverable')
      const output = new SessionFormatEventCollector()
      scanner.decodeRow(null, output)
      expect(() => { scanner.decodeRow(event, output) }).toThrow()
      const artifact = { header, inheritedEventCount: 0, events: [turn, event] }
      expect(() => restoreReleasedV4Artifact(artifact, new Set([turn.type, event.type]))).toThrow()
    }
  })

  it('keeps known request fields open and obsolete ignorable tags opaque', () => {
    const rows = [turn, request({ reason: 'initial', header: { config: { provider: 'mock', model: 'mock' }, extra: true } }),
      { type: 'tool/code-dispatch-start', seq: 2, time: 1, data: { unknown: true }, ignorable: true },
      { type: 'tool/code-dispatch', seq: 3, time: 1, data: null, ignorable: true },
    ] as SessionFormatEvent[]
    const read = sessionFormatCatalog.createRestore(physical, { recovery: 'strict', validation: 'current' })
    for (const event of rows) read.decodeRow(JSON.parse(JSON.stringify(sessionFormatCatalog.encodeCurrentEvent(event))))
    expect(read.finish().events).toEqual(rows)
  })
})
