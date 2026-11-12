/** SQLite row decoding uses the released format owner while preserving existing logical headers. @module */
import { describe, expect, it } from 'vitest'
import { SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import { sessionFormatCatalog } from '@deepseek-ai/dsh-session-format-catalog'
import { decodeHeader, decodeEvent } from '../src/codec.ts'

const header = { version: SESSION_FORMAT_VERSION, id: SessionId('codec'), createdAt: 0, isSeeded: false }

describe('SQLite header decoding', () => {
  it('accepts catalog headers and existing logical headers with optional parent metadata', () => {
    expect(decodeHeader(header)).toEqual({ ...header, delegationDepth: 0 })
    const parent = { ...header, parentSession: SessionId('parent'), origin: 'subagent' as const, delegationDepth: 1 }
    expect(decodeHeader(sessionFormatCatalog.encodeCurrentHeader(parent, 0))).toEqual(parent)
  })

  it('refuses a physical header missing its required delegation depth', () => {
    expect(() => decodeHeader({ type: 'session', ...header })).toThrow()
  })

  it('refuses malformed, unsupported and migration-required physical headers', () => {
    expect(() => decodeHeader(null)).toThrow()
    expect(() => decodeHeader({ ...header, version: 100 })).toThrow()
    expect(() => decodeHeader({ type: 'session', ...header, version: 3, delegationDepth: 0 }))
      .toThrow('requires a format migration')
  })
})

describe('SQLite event decoding', () => {
  const event = { type: 'feedback/record', seq: 0, time: 0, data: { text: 'fixture' } }

  it('preserves decoded fields and accepts ignorable extension events', () => {
    expect(decodeEvent(event)).toEqual(event)
    expect(decodeEvent({ ...event, type: 'fixture/extension', ignorable: true })).toEqual({
      ...event, type: 'fixture/extension', ignorable: true,
    })
  })

  it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, '0', null])(
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
