/** SQLite JSON decoding preserves logical Session records. @module */
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import { SESSION_FORMAT_VERSION, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import { decodeHeader, decodeEvent, materializeHeader } from '../src/codec.ts'

const header: SessionHeader = { version: SESSION_FORMAT_VERSION, id: SessionId('codec'), createdAt: 0, isSeeded: false }

describe('SQLite header decoding', () => {
  it('reads logical metadata and preserves optional parent metadata', () => {
    expect(decodeHeader(header)).toEqual({ ...header, delegationDepth: 0 })
    const parent = { ...header, cwd: '/work', parentSession: SessionId('parent'), origin: 'subagent' as const, delegationDepth: 1, agentPreset: 'worker' }
    expect(decodeHeader(parent)).toEqual(parent)
  })

  it.each([null, { ...header, version: 100 }, { ...header, version: 3 }, { ...header, delegationDepth: -1 }])(
    'refuses malformed or unsupported logical metadata %j', (value) => {
      expect(() => decodeHeader(value)).toThrow()
    },
  )
})

describe('SQLite event decoding', () => {
  const event = { type: 'feedback/record', seq: 0, time: 0, data: { text: 'fixture' } }

  it('preserves decoded fields and accepts ignorable extension events', () => {
    expect(decodeEvent(event)).toEqual(event)
    expect(decodeEvent({ ...event, type: 'fixture/extension', ignorable: true })).toEqual({
      ...event, type: 'fixture/extension', ignorable: true,
    })
  })

  it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1, '0', null])(
    'refuses invalid sequence %s before Session adoption', (seq) => {
      expect(() => decodeEvent({ ...event, seq })).toThrow()
    },
  )

  it.each(['type', 'seq', 'time', 'data'])('refuses a missing %s field', (key) => {
    const row = Object.fromEntries(Object.entries(event).filter(([field]) => field !== key))
    expect(() => decodeEvent(row)).toThrow()
  })

  it.each([
    { type: 1 }, { time: 0.5 }, { time: Number.MAX_SAFE_INTEGER + 1 },
    { ignorable: false }, { extra: true }, { data: undefined },
  ])('refuses malformed envelope fields %j', (fields) => {
    expect(() => decodeEvent({ ...event, ...fields })).toThrow()
  })
})

it('requires the inherited count to agree with seeded metadata', () => {
  expect(() => materializeHeader({ ...header, isSeeded: true })).toThrow('seeded session header requires')
  expect(() => materializeHeader(header, SessionLogOffset(1))).toThrow('unseeded session header inherited')
  expect(materializeHeader(header)).toEqual({ ...header, delegationDepth: 0 })
  expect(materializeHeader({ ...header, isSeeded: true }, SessionLogOffset(0))).toMatchObject({ isSeeded: true })
})
