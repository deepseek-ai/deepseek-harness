import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createAssistantMessage } from '@deepseek-ai/dsh-llm'
import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import { parseSessionLog } from '@deepseek-ai/dsh-llm-replay'
import {
  canonicalSessionFixture,
  inspectSessionFixtureLayouts,
  isPhysicalSessionFixture,
} from './session-fixture-layout.ts'

const HEADER = '  {"type":"session","version":2,"id":"fixture","createdAt":1,"isSeeded":false,"delegationDepth":0}  '
const root = resolve(import.meta.dirname, '..')
const FIXTURE_MESSAGE = createAssistantMessage({
  content: [{ type: 'text', text: 'part-0part-1part-2part-3' }],
  source: { provider: 'mock', model: 'mock' },
})
const FIXTURE_STREAM: SessionEvent<'assistant/message'>['data']['stream'] = [
  {
    type: 'text-chunks',
    time0: 10,
    index: 0,
    dt: [1, 1, 1],
    texts: ['part-0', 'part-1', 'part-2', 'part-3'],
  },
  { type: 'chunk', time: 14, chunk: { type: 'finish', reason: { kind: 'stop' } } },
]

function assistantMessage(): SessionEvent<'assistant/message'> {
  return {
    type: 'assistant/message',
    seq: SessionSeq(2),
    time: 14,
    data: {
      turn: 1,
      step: 1,
      message: FIXTURE_MESSAGE,
      stream: FIXTURE_STREAM,
    },
    surfaceOp: 'append',
  }
}

function fixtureEvents(): SessionEvent[] {
  return [
    { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } },
    { type: 'step/start', seq: SessionSeq(1), time: 2, data: { turn: 1, step: 1 } },
    assistantMessage(),
  ]
}

function unpackedFixture(): string {
  return [HEADER, ...fixtureEvents().map(event => JSON.stringify(event)), ''].join('\n')
}

function decodedBody(content: string): SessionEvent[] {
  return parseSessionLog(content)
}

describe('canonicalSessionFixture', () => {
  it('preserves the header line and nested compact stream losslessly', () => {
    const canonical = canonicalSessionFixture(unpackedFixture(), 'fixture.jsonl')
    expect(canonical).toBeDefined()
    expect(canonical?.split('\n')[0]).toBe(HEADER)
    const message = canonical?.split('\n')
      .map(line => JSON.parse(line || '{}') as Record<string, unknown>)
      .find(record => record.type === 'assistant/message')
    expect(message).toMatchObject({
      type: 'assistant/message',
      data: {
        stream: FIXTURE_STREAM,
      },
    })
    expect(message).not.toHaveProperty('seq')
    expect(message).not.toHaveProperty('time')
    expect(decodedBody(canonical ?? '').map(({ seq: _seq, time: _time, ...event }) => event))
      .toStrictEqual(fixtureEvents().map(({ seq: _seq, time: _time, ...event }) => event))
  })

  it('ignores JSONL whose first record is not a session header', () => {
    expect(canonicalSessionFixture('{"type":"session_event"}\n{"value":1}\n')).toBeUndefined()
  })

  it('is idempotent for an already packed fixture', () => {
    const packed = canonicalSessionFixture(unpackedFixture())
    expect(packed).toBeDefined()
    expect(canonicalSessionFixture(packed ?? '')).toBe(packed)
  })

  it('is idempotent for an already projected fixture', () => {
    const projected = [
      HEADER,
      '{"type":"turn/start","data":{"turn":1}}',
      '',
    ].join('\n')
    expect(canonicalSessionFixture(projected)).toBe(projected)
  })

  it('preserves owner-restored request-header tokens in current projected fixtures', () => {
    const projected = [
      HEADER,
      '{"type":"turn/start","data":{"turn":1}}',
      '{"type":"request/header","data":{"header":{"config":{"provider":"mock","model":"mock"},"system":"{{system}}","tools":"{{tools}}"},"reason":"initial"}}',
      '',
    ].join('\n')
    expect(canonicalSessionFixture(projected)).toBe(projected)
  })

  it('fails loud on malformed records after a session header', () => {
    expect(() => canonicalSessionFixture(`${HEADER}\n{not-json}\n`, 'broken.jsonl'))
      .toThrow(/broken\.jsonl: session snapshot line 2 contains invalid JSON/)
  })

  it('labels malformed packed rows with the fixture path and line', () => {
    const releasedHeader = '{"type":"session","version":0,"id":"fixture","createdAt":1,"delegationDepth":0}'
    expect(() => canonicalSessionFixture(`${releasedHeader}\n{"type":"text-chunks"}\n`, 'broken.jsonl'))
      .toThrow(/broken\.jsonl: session snapshot line 2: released text-chunks row 0 lacks required member "data"/)
  })
})

describe('isPhysicalSessionFixture', () => {
  it('recognizes fixtures that preserve physical persistence encoding', () => {
    expect(isPhysicalSessionFixture(
      'packages/experimental/webworker-runtime/tests/fixtures/vfs-example/home/sessions/--dsh-workspace--/main/session.jsonl',
    )).toBe(true)
    expect(isPhysicalSessionFixture(
      'packages/experimental/webworker-runtime/tests/fixtures/vfs-example/home/sessions/--dsh-workspace--/main/session.v1.jsonl',
    )).toBe(true)
    expect(isPhysicalSessionFixture(
      'scripts/snapshots/python-sdk-single-exe/advanced/session.1.jsonl',
    )).toBe(true)
    expect(isPhysicalSessionFixture(
      'scripts/snapshots/python-sdk-single-exe/advanced/session.1.v1.jsonl',
    )).toBe(true)
    expect(isPhysicalSessionFixture(
      'scripts/snapshots/python-sdk-single-exe/advanced/session.jsonl',
    )).toBe(true)
    expect(isPhysicalSessionFixture(
      'scripts/snapshots/python-sdk-single-exe/restart/session.2.jsonl',
    )).toBe(true)
    expect(isPhysicalSessionFixture(
      'packages/experimental/webworker-runtime/tests/fixtures/vfs-example/home/sessions/README.jsonl',
    )).toBe(false)
    expect(isPhysicalSessionFixture(
      'scripts/snapshots/python-sdk-single-exe/advanced/requests.jsonl',
    )).toBe(false)
    expect(isPhysicalSessionFixture('apps/web/tests/snapshots/example/session.jsonl')).toBe(false)
  })
})

it('keeps every session-format JSONL fixture projected into canonical event layout', () => {
  const nonCanonical = inspectSessionFixtureLayouts(root)
    .filter(fixture => fixture.source !== fixture.canonical)
    .map(fixture => fixture.path)
  expect(
    nonCanonical,
    'Run `pnpm run migrate:packed-session-fixtures` and commit the mechanical fixture rewrite.',
  ).toEqual([])
})
