import { describe, expect, it } from 'vitest'
import { SessionFormatUnsupportedMigrationError } from '@deepseek-ai/dsh-session-format'
import {
  releasedV0SessionFormatCodec,
  sessionFormatV0ToV1,
} from '../src/index.ts'

const header = {
  type: 'session',
  version: 0,
  id: 'legacy',
  createdAt: 1,
  delegationDepth: 0,
} as const

function migrate(rows: readonly unknown[]) {
  return sessionFormatV0ToV1.migrate(releasedV0SessionFormatCodec.decodeArtifact(header, rows))
}

describe('released v0 legacy normalization', () => {
  it('restores pre-identity user, assistant, and replacement tool-result identities', () => {
    const rows = [
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
      {
        type: 'user/message', seq: 1, time: 2,
        data: { content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } },
        surfaceOp: 'append',
      },
      { type: 'step/start', seq: 2, time: 3, data: { turn: 1, step: 1 } },
      {
        type: 'assistant/message', seq: 3, time: 4,
        data: {
          turn: 1,
          step: 1,
          content: [{ type: 'tool-call', id: 'call-1', name: 'read', arguments: '{}' }],
          provenance: { provider: 'mock', model: 'mock' },
        },
        surfaceOp: 'append',
      },
      {
        type: 'tool/call', seq: 4, time: 5,
        data: { turn: 1, step: 1, callId: 'call-1', name: 'read', arguments: '{}' },
      },
      {
        type: 'tool/result', seq: 5, time: 6,
        data: { turn: 1, step: 1, callId: 'call-1', content: [{ type: 'text', text: 'full' }], isError: false },
        sourceEventSeqs: [4],
        surfaceOp: 'append',
      },
      {
        type: 'tool/result', seq: 6, time: 7,
        data: { turn: 1, step: 1, callId: 'call-1', content: [{ type: 'text', text: 'pruned' }], isError: false },
        sourceEventSeqs: [5],
        surfaceOp: { op: 'replace', start: 5, end: 5 },
      },
      { type: 'step/end', seq: 7, time: 8, data: { turn: 1, step: 1 } },
      { type: 'turn/end', seq: 8, time: 9, data: { turn: 1, reason: { kind: 'completed' } } },
    ]

    const events = migrate(rows).events

    expect(events[1]?.data).toMatchObject({ id: 'legacy-message:legacy:1', role: 'user' })
    expect(events[3]?.data).toMatchObject({ message: { id: 'legacy-message:legacy:3', role: 'assistant' } })
    expect(events[5]?.data).toMatchObject({ message: { id: 'legacy-message:legacy:5', role: 'user' } })
    expect(events[6]?.data).toMatchObject({ message: { id: 'legacy-message:legacy:5', role: 'user' } })
  })

  it('normalizes wrapped and flat steering plus every accepted old turn ending', () => {
    const user = {
      id: 'wrapped',
      role: 'user',
      content: [{ type: 'text', text: 'wrapped' }],
      source: { kind: 'user' },
    }
    const rows = [
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1, trigger: { kind: 'message' } } },
      { type: 'steering/message', seq: 1, time: 2, data: { turn: 1, message: user }, surfaceOp: 'append' },
      {
        type: 'steering/message', seq: 2, time: 3,
        data: { turn: 1, content: [{ type: 'text', text: 'flat' }], source: { kind: 'user' } },
        surfaceOp: 'append',
      },
      { type: 'turn/end', seq: 3, time: 4, data: { turn: 1, reason: { kind: 'completed' } } },
      { type: 'turn/start', seq: 4, time: 5, data: { turn: 2, trigger: { kind: 'retry' } } },
      {
        type: 'turn/end', seq: 5, time: 6,
        data: { turn: 2, reason: { kind: 'error', step: 1, failure: { message: 'provider', code: 'SERVER' } } },
      },
      { type: 'turn/start', seq: 6, time: 7, data: { turn: 3, trigger: { kind: 'message' } } },
      { type: 'turn/end', seq: 7, time: 8, data: { turn: 3, reason: { kind: 'aborted' } } },
      { type: 'turn/start', seq: 8, time: 9, data: { turn: 4, trigger: { kind: 'message' } } },
      { type: 'turn/end', seq: 9, time: 10, data: { turn: 4, reason: { kind: 'disposed' } } },
      { type: 'turn/start', seq: 10, time: 11, data: { turn: 5, trigger: { kind: 'message' } } },
      {
        type: 'turn/end', seq: 11, time: 12,
        data: { turn: 5, reason: { kind: 'error', step: 1, message: 'thrown' } },
      },
      { type: 'turn/start', seq: 12, time: 13, data: { turn: 6, trigger: { kind: 'message' } } },
      {
        type: 'turn/end', seq: 13, time: 14,
        data: {
          turn: 6,
          reason: {
            kind: 'error',
            step: 0,
            failure: {
              message: 'detailed', code: 'RATE_LIMIT', status: 429,
              providerRetryAfterMs: 1000, requestId: 'request-1',
            },
          },
        },
      },
      { type: 'turn/start', seq: 14, time: 15, data: { turn: 7, trigger: { kind: 'message' } } },
      {
        type: 'turn/end', seq: 15, time: 16,
        data: { turn: 7, reason: { kind: 'error', step: 0, message: 'coded', code: 'CODED' } },
      },
    ]

    const events = migrate(rows).events

    expect(events.filter(event => event.type === 'turn/start').map(event => event.data))
      .toEqual(Array.from({ length: 7 }, (_, index) => ({ turn: index + 1 })))
    expect(events[1]).toMatchObject({ type: 'user/message', data: { id: 'wrapped' } })
    expect(events[2]).toMatchObject({
      type: 'user/message',
      data: { id: 'legacy-message:legacy:2', role: 'user' },
    })
    expect(events.filter(event => event.type === 'turn/end').map(event => event.data)).toEqual([
      { turn: 1, reason: { kind: 'completed' } },
      { turn: 2, reason: { kind: 'error', error: { message: 'provider', code: 'SERVER' } } },
      { turn: 3, reason: { kind: 'aborted', reason: { kind: 'legacy' } } },
      { turn: 4, reason: { kind: 'aborted', reason: { kind: 'disposed' } } },
      { turn: 5, reason: { kind: 'error', error: { message: 'thrown', code: 'UNKNOWN' } } },
      {
        turn: 6,
        reason: {
          kind: 'error',
          error: {
            message: 'detailed', code: 'RATE_LIMIT', status: 429,
            providerRetryAfterMs: 1000, requestId: 'request-1',
          },
        },
      },
      { turn: 7, reason: { kind: 'error', error: { message: 'coded', code: 'CODED' } } },
    ])
  })

  it.each([
    ['turn/start trigger', { type: 'turn/start', seq: 0, time: 1, data: { turn: 1, trigger: null } }],
    ['flat steering extra', {
      type: 'steering/message', seq: 0, time: 1, surfaceOp: 'append',
      data: { turn: 1, content: [], source: { kind: 'user' }, extra: true },
    }],
    ['steering null', { type: 'steering/message', seq: 0, time: 1, surfaceOp: 'append', data: null }],
    ['turn/end extra', {
      type: 'turn/end', seq: 0, time: 1,
      data: { turn: 1, reason: { kind: 'completed', extra: true } },
    }],
    ['turn/end null reason', { type: 'turn/end', seq: 0, time: 1, data: { turn: 1, reason: null } }],
    ['turn/end intermediate step', {
      type: 'turn/end', seq: 0, time: 1,
      data: { turn: 1, step: 1, reason: { kind: 'completed' } },
    }],
    ['turn/end aborted extra', {
      type: 'turn/end', seq: 0, time: 1,
      data: { turn: 1, reason: { kind: 'aborted', extra: true } },
    }],
    ['turn/end disposed extra', {
      type: 'turn/end', seq: 0, time: 1,
      data: { turn: 1, reason: { kind: 'disposed', extra: true } },
    }],
    ['turn/end error negative step', {
      type: 'turn/end', seq: 0, time: 1,
      data: { turn: 1, reason: { kind: 'error', step: -1, message: 'bad' } },
    }],
    ['turn/end error numeric code', {
      type: 'turn/end', seq: 0, time: 1,
      data: { turn: 1, reason: { kind: 'error', step: 0, message: 'bad', code: 1 } },
    }],
  ])('refuses malformed legacy %s', (_name, event) => {
    expect(() => migrate([event])).toThrow(/malformed|must be a JSON object|unexpected member|non-negative/)
  })

  it.each([
    ['request/header-delta', { config: { model: 'legacy' } }],
    ['mode/set', { mode: 'plan' }],
  ])('classifies retired %s as unsupported migration', (type, data) => {
    expect(() => migrate([{ type, seq: 0, time: 1, data }])).toThrow(SessionFormatUnsupportedMigrationError)
  })

  it('classifies the retired request/header fallback reason as unsupported migration', () => {
    expect(() => migrate([{
      type: 'request/header',
      seq: 0,
      time: 1,
      data: { header: { config: { model: 'legacy' } }, reason: 'fallback' },
    }])).toThrow(SessionFormatUnsupportedMigrationError)
  })

  it('leaves current message and turn-end variants unchanged inside the identity edge', () => {
    const rows = [
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
      {
        type: 'user/message', seq: 1, time: 2, surfaceOp: 'append',
        data: { id: 'current', role: 'user', content: [{ type: 'text', text: 'x' }], source: { kind: 'user' } },
      },
      { type: 'turn/end', seq: 2, time: 3, data: { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } } },
      { type: 'turn/start', seq: 3, time: 4, data: { turn: 2 } },
      { type: 'turn/end', seq: 4, time: 5, data: { turn: 2, reason: { kind: 'error', error: { message: 'x', code: 'X' } } } },
    ]
    expect(migrate(rows).events).toEqual(rows)
  })

  it('refuses wrong-version headers and additional malformed legacy branches', () => {
    expect(() => sessionFormatV0ToV1.migrateHeader({
      version: 1, id: 'x', createdAt: 1, isSeeded: false, delegationDepth: 0,
    })).toThrow(/expected format v0/)
    expect(() => migrate([{
      type: 'turn/start', seq: 0, time: 1, data: { turn: 0, trigger: { kind: 'message' } },
    }])).toThrow(/malformed/)
    expect(() => migrate([{
      type: 'turn/end', seq: 0, time: 1,
      data: { turn: 1, reason: { kind: 'error', step: 0, failure: { message: 1, code: 'X' } } },
    }])).toThrow(/malformed/)
    expect(() => migrate([{
      type: 'tool/result', seq: 0, time: 1, surfaceOp: 'append',
      data: { turn: 1, step: 0, callId: 1, content: [], isError: false },
    }])).toThrow()
    expect(() => migrate([{
      type: 'tool/result', seq: 0, time: 1, surfaceOp: 'append',
      data: { turn: 1, step: 0, callId: 'call', content: [] },
    }])).toThrow()
    expect(migrate([
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
      { type: 'turn/end', seq: 1, time: 2, data: { turn: 1, reason: { kind: 'future-reason' } } },
    ]).events[1]).toMatchObject({ data: { reason: { kind: 'future-reason' } } })
  })

  it('refuses a legacy replacement whose cited message has no imported identity', () => {
    expect(() => migrate([
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
      {
        type: 'tool/result', seq: 1, time: 2,
        data: { turn: 1, step: 0, callId: 'call', content: [], isError: false },
        sourceEventSeqs: [0], surfaceOp: { op: 'replace', start: 0, end: 0 },
      },
    ])).toThrow(/without identity/)
  })

  it('normalizes the legacy request-header message prefix', () => {
    const rows = [
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
      { type: 'request/header', seq: 1, time: 2, data: {
        header: {
          config: { provider: 'mock', model: 'mock' },
          messagePrefix: [{ role: 'user', content: [{ type: 'text', text: 'obsolete' }] }],
        },
        reason: 'initial',
      } },
      { type: 'turn/end', seq: 2, time: 3, data: { turn: 1, reason: { kind: 'completed' } } },
    ]
    const events = migrate(rows).events
    expect(events[1]?.data).not.toHaveProperty('header.messagePrefix')
    expect(() => migrate([
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
      { type: 'request/header', seq: 1, time: 2, data: {
        header: { config: { provider: 'mock', model: 'mock' }, messagePrefix: 'bad' }, reason: 'initial',
      } },
    ])).toThrow(/messagePrefix/)
    expect(() => migrate([{
      type: 'turn/end', seq: 0, time: 1, data: { turn: 0, reason: { kind: 'completed' } },
    }])).toThrow(/malformed/)
    expect(() => migrate([{
      type: 'turn/end', seq: 0, time: 1, data: { turn: 1, reason: { kind: 1 } },
    }])).toThrow(/malformed/)
  })

  it('refuses invalid legacy relationship facts instead of rewriting them', () => {
    const turn = { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } }
    const human = { type: 'user/message', seq: 1, time: 2, surfaceOp: 'append', data: {
      id: 'human', role: 'user', content: [{ type: 'text', text: 'human' }], source: { kind: 'user' },
    } }
    expect(() => migrate([turn, human, {
      type: 'user/message', seq: 2, time: 3, sourceEventSeqs: [1], surfaceOp: { op: 'replace', start: 1, end: 1 }, data: {
        id: 'compact', role: 'user', content: [{ type: 'text', text: 'summary' }],
        source: { kind: 'plugin', plugin: 'compact', compactionId: 'orphan' },
      },
    }])).toThrow(/compaction checkpoint/)
    expect(() => migrate([turn, human, {
      type: 'session/title', seq: 2, time: 3,
      data: { title: 'Pinned', messageSeqs: [1], source: { kind: 'user' } },
    }])).toThrow(/empty exactly/)
  })
})
