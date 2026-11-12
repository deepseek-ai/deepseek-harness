/** Installed readers validate event-local native fields without a complete artifact. @module */
import { expect, it } from 'vitest'
import { decodeReleasedV4Event } from '../src/codec.ts'

it.each([
  ['session/title-llm-request', { messages: [{ id: 'title', role: 'user', source: { kind: '' }, content: [] }] }],
  ['session-log-deepseek/delivery-accepted', { sessionFormatVersion: 4, throughSeq: 1, sessionId: 'source' }],
] as const)('rejects malformed %s when the reader owns its vocabulary', (type, data) => {
  const row = { type, data, seq: 1, time: 0 }
  expect(() => decodeReleasedV4Event(row, new Set([type]))).toThrow()
})
