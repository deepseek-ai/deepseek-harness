/** Released JSONL framing, source ranges, and row validation. @module */
import { brandString } from '@deepseek-ai/dsh-brand'
import { describe, expect, it } from 'vitest'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import { SESSION_FORMAT_VERSION, SessionId, SessionSeq, SessionLogOffset } from '@deepseek-ai/dsh-session'
import {
  assertNoRetiredHeaderFields, encodeSegment, generationLogFilename, parseGenerationLogFilename,
  projectKey, scanLog, SessionLogScanner, toHeaderLine,
} from '../src/format.ts'
import { meta, oneTurnLog } from '../../session-persistence/tests/contract.ts'

describe('JsonlSessionPersistence: format helpers', () => {
  it('names and parses only canonical immutable generations', () => {
    expect(generationLogFilename(0, 'none')).toBe('session.jsonl')
    expect(generationLogFilename(1, 'none')).toBe('session.v1.jsonl')
    expect(generationLogFilename(27, 'zstd')).toBe('session.v27.jsonl.zstd')
    for (const invalid of [-1, -0, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => generationLogFilename(invalid, 'none')).toThrow(/non-negative safe integer/)
    }
    expect(parseGenerationLogFilename('session.jsonl', 'none')).toBe(0)
    expect(parseGenerationLogFilename('session.v1.jsonl', 'none')).toBe(1)
    expect(parseGenerationLogFilename('session.v9007199254740992.jsonl', 'none')).toBeUndefined()
    for (const name of [
      'session.v0.jsonl',
      'session.v01.jsonl',
      'session.V1.jsonl',
      'session.v1.backup.jsonl',
      'session.migration.deadbeef.tmp.jsonl',
      'session.v1.jsonl.zstd',
    ]) {
      expect(parseGenerationLogFilename(name, 'none')).toBeUndefined()
    }
  })

  it('ignores retired-header checks for non-object values', () => {
    expect(() => { assertNoRetiredHeaderFields(null) }).not.toThrow()
    expect(() => { assertNoRetiredHeaderFields('header') }).not.toThrow()
    expect(() => scanLog(Buffer.from('42\n'))).toThrow(/first line is not a JSON object/)
    expect(() => scanLog(Buffer.from('null\n'))).toThrow(/first line is not a JSON object/)
    expect(() => scanLog(Buffer.from(
      `${JSON.stringify({ type: 'session', version: SESSION_FORMAT_VERSION, id: 123 })}\n`,
    ))).toThrow(/first line is not a session header/)
    expect(() => scanLog(Buffer.from(
      `${JSON.stringify({ type: 'session', version: SESSION_FORMAT_VERSION + 1, id: 123 })}\n`,
    ))).toThrow(`session "123" uses log format v${SESSION_FORMAT_VERSION + 1}`)
  })

  it('encodeSegment neutralizes traversal, separators, and absolute paths', () => {
    expect(encodeSegment('..')).toBe('~002E~002E')
    expect(encodeSegment('.')).toBe('~002E')
    expect(encodeSegment('a/b')).toBe('a~002Fb')
    expect(encodeSegment('/etc/passwd')).toBe('~002Fetc~002Fpasswd')
    expect(encodeSegment('a\u0000b')).toBe('a~0000b')
    expect(encodeSegment('plain-ID_1.2')).toBe('plain-ID_1.2') // safe chars pass through
    expect(encodeSegment('a~b')).toBe('a~007Eb') // ~ itself is escaped
  })

  it('encodeSegment is injective over UTF-16, incl. lone surrogates', () => {
    // Distinct lone surrogates must NOT collide (Buffer.from would normalize
    // both to U+FFFD; code-unit escaping keeps them distinct).
    const hi = encodeSegment(String.fromCharCode(0xD800))
    const lo = encodeSegment(String.fromCharCode(0xDC00))
    expect(hi).toBe('~D800')
    expect(lo).toBe('~DC00')
    expect(hi).not.toBe(lo)
    // A literal "~002F" input cannot collide with the encoding of "/".
    expect(encodeSegment('~002F')).not.toBe(encodeSegment('/'))
  })

  it('encodeSegment rejects an empty id', () => {
    expect(() => encodeSegment('')).toThrow(/empty/)
  })

  it('round-trips every optional header field through the header line', () => {
    const full: SessionHeader = {
      version: SESSION_FORMAT_VERSION,
      id: brandString<SessionId>('full-header'),
      createdAt: 5,
      cwd: '/w',
      parentSession: brandString<SessionId>('parent'),
      isSeeded: true,
      origin: 'subagent',
      delegationDepth: 2,
      agentPreset: 'minimal',
    }
    const events = [
      ...Array.from({ length: 3 }, (_, seq) => ({
        type: 'feedback/record', seq, time: seq + 1, data: { text: `prefix-${String(seq)}` },
      })),
      { type: 'session/end-seed', seq: 3, time: 4, data: { inherited: true } },
    ]
    const scan = scanLog(Buffer.from(
      `${[toHeaderLine(full, SessionLogOffset(3)), ...events].map(value => JSON.stringify(value)).join('\n')}\n`,
    ))
    expect(scan.meta).toEqual(full)
    expect(scan.inheritedEventCount).toBe(3)
  })

  it.each([
    ['unseeded', false, 0],
    ['empty-seed', true, 0],
    ['nonempty-seed', true, 3],
  ] as const)('round-trips current lineage markers for %s', (_case, isSeeded, inheritedEventCount) => {
    const events = isSeeded
      ? [
        ...Array.from({ length: inheritedEventCount }, (_, seq) => ({
          type: 'feedback/record', seq, time: seq + 1, data: { text: `prefix-${String(seq)}` },
        })),
        {
          type: 'session/end-seed',
          seq: inheritedEventCount,
          time: inheritedEventCount + 1,
          data: { inherited: true },
        },
      ]
      : []
    const line = {
      type: 'session',
      version: SESSION_FORMAT_VERSION,
      id: brandString<SessionId>(`physical-seed-${_case}`),
      createdAt: 1000,
      isSeeded,
      delegationDepth: 0,
    }
    const bytes = `${[line, ...events].map(value => JSON.stringify(value)).join('\n')}\n`

    const scanned = scanLog(Buffer.from(bytes))

    expect(scanned.meta.isSeeded).toBe(isSeeded)
    expect(scanned.inheritedEventCount).toBe(SessionLogOffset(inheritedEventCount))
    expect(toHeaderLine(scanned.meta, scanned.inheritedEventCount)).toStrictEqual(line)
  })

  it('rejects a current physical header without explicit isSeeded', () => {
    const { isSeeded: _isSeeded, ...line } = toHeaderLine(meta('missing-is-seeded'))
    expect(() => scanLog(Buffer.from(`${JSON.stringify(line)}\n`))).toThrow(/session header/)
  })

  it('requires logical lineage and the physical inherited cut to agree', () => {
    const unseeded = meta('lineage-cut')
    expect(() => toHeaderLine({ ...unseeded, isSeeded: true }))
      .toThrow('seeded session header requires an inherited event count')
    expect(() => toHeaderLine(unseeded, SessionLogOffset(1)))
      .toThrow('unseeded session header inherited event count must be 0')
  })

  it('projectKey normalizes project paths into bounded readable names', () => {
    expect(projectKey('/Users/qyj/work/deepseek-harness')).toBe('--Users-qyj-work-deepseek-harness--')
    expect(projectKey('/a/b-c')).toBe(projectKey('/a-b/c'))
    expect(projectKey('C:\\work\\agent')).toBe('--C-work-agent--')
    expect(projectKey('/开发/~agent')).toBe('--~5F00~53D1-~007Eagent--')
    expect(projectKey('/')).toBe('--root--')
    expect(projectKey('/' + 'x'.repeat(1_000))).toHaveLength(255)
    expect(() => projectKey('')).toThrow(/empty project path/)
  })

})

describe('JsonlSessionPersistence: scanLog unit', () => {
  it('requires exactly one newline-terminated header record', () => {
    const header = JSON.stringify(toHeaderLine(meta('scanner-header')))
    expect(() => new SessionLogScanner(Buffer.alloc(0))).toThrow(/header-less/)
    expect(() => new SessionLogScanner(Buffer.from(header))).toThrow(/header-less/)
    expect(() => new SessionLogScanner(Buffer.from(`${header}\n${header}\n`))).toThrow(/header-less/)
  })

  it('fails immediately on an invalid row in strict scanner mode', () => {
    const header = Buffer.from(`${JSON.stringify(toHeaderLine(meta('scanner-strict')))}\n`)
    const scanner = new SessionLogScanner(header, 'strict')
    expect(() => { scanner.write(Buffer.from('null\n')) }).toThrow(/invalid committed event/)
  })

  it('expands valid stored source-event ranges', () => {
    const log = [
      JSON.stringify(toHeaderLine(meta('scanner-source-ranges'))),
      JSON.stringify({ type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } }),
      JSON.stringify(oneTurnLog()[1]),
      JSON.stringify({
        ...oneTurnLog()[1], seq: 2, time: 3, sourceEventSeqs: [[0, 1]],
      }),
      '',
    ].join('\n')
    const restored = scanLog(Buffer.from(log)).events[2]
    expect(restored).toMatchObject({ type: 'user/message', surfaceOp: 'append', sourceEventSeqs: [0, 1] })
  })

  it('requires the tagged inherited cut to agree with the current header lineage', () => {
    const seeded = { ...meta('scanner-seeded-cut'), isSeeded: true }
    const seededHeader = JSON.stringify(toHeaderLine(seeded, SessionLogOffset(0)))
    expect(() => scanLog(Buffer.from(`${seededHeader}\n`)))
      .toThrow(/seeded Session lacks an inherited end-seed marker/)

    const unseededHeader = JSON.stringify(toHeaderLine(meta('scanner-unseeded-cut')))
    const inheritedMarker = JSON.stringify({
      type: 'session/end-seed', seq: 0, time: 1, data: { inherited: true },
    })
    expect(() => scanLog(Buffer.from(`${unseededHeader}\n${inheritedMarker}\n`)))
      .toThrow(/unseeded Session contains an inherited end-seed marker/)
  })

  it('handles empty writes, boundary newlines, torn fragments, and scanner completion', () => {
    const header = Buffer.from(`${JSON.stringify(toHeaderLine(meta('scanner-lifecycle')))}\n`)
    const event = Buffer.from(JSON.stringify(oneTurnLog()[0]))
    const scanner = new SessionLogScanner(header)

    scanner.write(Buffer.alloc(0))
    scanner.write(event)
    scanner.write(Buffer.from('\nignored torn tail'))
    const result = scanner.finish()

    expect(result.events).toEqual([oneTurnLog()[0]])
    expect(result.committedBytes).toBe(header.length + event.length + 1)
    expect(() => { scanner.write(Buffer.from('\n')) }).toThrow(/finished/)
  })

  it('keeps scanning after a tolerable corrupt suffix until a committed turn end appears', () => {
    const header = Buffer.from(`${JSON.stringify(toHeaderLine(meta('scanner-corrupt-suffix')))}\n`)
    const scanner = new SessionLogScanner(header)
    scanner.write(Buffer.from([
      JSON.stringify(oneTurnLog()[0]),
      '{not json',
      JSON.stringify({ type: 'step/start', seq: SessionSeq(1), time: 2, data: { turn: 1, step: 1 } }),
      '',
    ].join('\n')))
    expect(scanner.finish().events).toEqual([oneTurnLog()[0]])

    const committed = new SessionLogScanner(header)
    expect(() => { committed.write(Buffer.from([
      JSON.stringify({ type: 'turn/end', seq: SessionSeq(1), time: 2, data: { turn: 1, reason: { kind: 'completed' } } }),
      '',
    ].join('\n'))) }).toThrow(/seq gap/)
  })

  it('incrementally scans records split across reusable decoder chunks', () => {
    const header = Buffer.from(`${JSON.stringify(toHeaderLine(meta('incremental')))}\n`)
    const body = Buffer.from(`${oneTurnLog().map(event => JSON.stringify(event)).join('\n').replace('"hi"', '"你好"')}\n`)
    const split = body.indexOf(Buffer.from('你')) + 1
    const firstChunk = Buffer.from(body.subarray(0, split))
    const scanner = new SessionLogScanner(header)

    scanner.write(firstChunk)
    const checkpoint = scanner.checkpoint()
    firstChunk.fill(0)
    scanner.write(body.subarray(split))

    expect(checkpoint).toMatchObject({
      inputBytes: header.length + split,
      eventCount: 1,
    })
    expect(scanner.finish()).toEqual(scanLog(Buffer.concat([header, body])))
  })

  it('rejects a header-less / empty log', () => {
    expect(() => scanLog(Buffer.from(''))).toThrow()
  })

  it('rejects a corrupt header line', () => {
    expect(() => scanLog(Buffer.from('not json\n'))).toThrow(/header/)
  })

  it('rejects a non-session first line', () => {
    expect(() => scanLog(Buffer.from('{"type":"event"}\n'))).toThrow(/session header/)
  })

  it.each([
    ['fractional', 1.5],
    ['negative', -1],
    ['unsafe', Number.MAX_SAFE_INTEGER + 1],
  ])('rejects a session header with a %s createdAt', (_label, createdAt) => {
    const log = JSON.stringify({
      type: 'session',
      version: SESSION_FORMAT_VERSION,
      id: 'invalid-created-at',
      createdAt,
      delegationDepth: 0,
    }) + '\n'
    expect(() => scanLog(Buffer.from(log))).toThrow(/session header/)
  })

  it('rejects a session header with negative-zero createdAt', () => {
    const log = `{"type":"session","version":${SESSION_FORMAT_VERSION},"id":"invalid-created-at","createdAt":-0,"delegationDepth":0}\n`
    expect(() => scanLog(Buffer.from(log))).toThrow(/session header/)
  })

  it.each([
    ['missing', undefined],
    ['a string', '1'],
    ['fractional', 1.5],
    ['negative', -1],
  ])('rejects a session header with %s delegationDepth', (_label, delegationDepth) => {
    const log = JSON.stringify({
      type: 'session',
      version: SESSION_FORMAT_VERSION,
      id: 'invalid-depth',
      createdAt: 1,
      ...delegationDepth === undefined ? {} : { delegationDepth },
    }) + '\n'
    expect(() => scanLog(Buffer.from(log))).toThrow(/session header/)
  })

  it('rejects a session header with negative-zero delegationDepth', () => {
    const log = `{"type":"session","version":${SESSION_FORMAT_VERSION},"id":"invalid-depth","createdAt":1,"delegationDepth":-0}\n`
    expect(() => scanLog(Buffer.from(log))).toThrow(/session header/)
  })

  it('round-trips the agent preset a session was composed from', () => {
    const line = toHeaderLine({
      version: SESSION_FORMAT_VERSION,
      id: brandString<SessionId>('composed'),
      isSeeded: false,
      createdAt: 1,
      delegationDepth: 0,
      agentPreset: 'minimal',
    })
    const log = `${JSON.stringify(line)}\n`

    // The preset decides the resumed session's tools and prompt; dropping it
    // on disk would restore a composition the logged history contradicts.
    expect(scanLog(Buffer.from(log)).meta.agentPreset).toBe('minimal')
  })

  it('rejects a session header whose agentPreset is not a string', () => {
    const log = JSON.stringify({
      type: 'session',
      version: SESSION_FORMAT_VERSION,
      id: 'bad-preset',
      createdAt: 1,
      delegationDepth: 0,
      agentPreset: 7,
    }) + '\n'

    expect(() => scanLog(Buffer.from(log))).toThrow(/session header/)
  })

  it('a seq gap after the last turn/end bounds the preserved tail (torn fragment tolerated)', () => {
    const log = [
      JSON.stringify({ type: 'session', version: SESSION_FORMAT_VERSION, id: 'g', createdAt: 1, isSeeded: false, delegationDepth: 0 }),
      JSON.stringify({ type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } }),
      JSON.stringify({ type: 'step/start', seq: SessionSeq(2), time: 2, data: { turn: 1, step: 1 } }), // gap: missing seq 1
    ].join('\n') + '\n'
    // No committed turn/end, so the gap is a tolerated crash boundary: scanLog
    // PRESERVES the contiguous prefix (turn/start seq 0) — real interrupted-turn
    // work, not discarded — and stops at the gap.
    expect(scanLog(Buffer.from(log)).events.map(e => e.seq)).toEqual([0])
  })

  it('rejects a seq gap BEFORE a later committed turn/end (committed data damaged)', () => {
    const log = [
      JSON.stringify({ type: 'session', version: SESSION_FORMAT_VERSION, id: 'g2', createdAt: 1, isSeeded: false, delegationDepth: 0 }),
      JSON.stringify({ type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } }),
      JSON.stringify({ type: 'step/start', seq: SessionSeq(2), time: 2, data: { turn: 1, step: 1 } }), // gap: missing seq 1
      JSON.stringify({ type: 'turn/end', seq: SessionSeq(3), time: 3, data: { turn: 1, reason: { kind: 'completed' } } }),
    ].join('\n') + '\n'
    // A turn/end exists, so the prefix up to it is committed — but it has a hole.
    // Truncating it would silently drop committed data → unloadable.
    expect(() => scanLog(Buffer.from(log))).toThrow(/seq gap/)
  })

  it.each([
    ['assistant/message', {}, /assistant\/message requires a message/],
    ['agent/inbox/spliced', { inserted: null }, /agent\/inbox\/spliced requires message array/],
    ['session/title-llm-request', { messages: [null] }, /session\/title-llm-request requires message objects/],
  ])('rejects malformed %s message slots before exposing a native scan', (type, data, error) => {
    const prefix = [
      { type: 'session', version: SESSION_FORMAT_VERSION, id: 'malformed-tail', createdAt: 1, isSeeded: false, delegationDepth: 0 },
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
    ].map(row => JSON.stringify(row)).join('\n') + '\n'
    const malformed = JSON.stringify({ type, seq: 1, time: 2, data }) + '\n'
    expect(() => scanLog(Buffer.from(prefix + malformed))).toThrow(error)
    const committed = JSON.stringify({ type: 'turn/end', seq: 2, time: 3, data: { turn: 1, reason: { kind: 'completed' } } }) + '\n'
    expect(() => scanLog(Buffer.from(prefix + malformed + committed))).toThrow(error)
  })

  it.each([false, true])('rejects malformed native tool results before recovery (sealed=%s)', (sealed) => {
    const rows = [
      { type: 'session', version: SESSION_FORMAT_VERSION, id: 'malformed-tool', createdAt: 1, isSeeded: false, delegationDepth: 0 },
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
      { type: 'tool/result', seq: 1, time: 2, data: { message: [] } },
      ...(sealed ? [{ type: 'turn/end', seq: 2, time: 3, data: { turn: 1, reason: { kind: 'completed' } } }] : []),
    ]
    const log = rows.map(row => JSON.stringify(row)).join('\n') + '\n'
    expect(() => scanLog(Buffer.from(log))).toThrow(/tool\/result.*message must be an object/)
  })

  it('rejects malformed records before a later committed turn/end', () => {
    const corruptRecords = [
      ['{not json', /unparsable committed event/],
      ['null', /invalid committed event/],
      [JSON.stringify({ type: 'assistant/message', sourceEventSeqs: [0], data: {} }), /invalid committed event/],
    ] as const
    for (const [record, message] of corruptRecords) {
      const log = [
        JSON.stringify({ type: 'session', version: SESSION_FORMAT_VERSION, id: 'c', createdAt: 1, isSeeded: false, delegationDepth: 0 }),
        record,
        JSON.stringify({ type: 'turn/end', seq: SessionSeq(1), time: 2, data: { turn: 1, reason: { kind: 'completed' } } }),
      ].join('\n') + '\n'
      expect(() => scanLog(Buffer.from(log))).toThrow(message)
    }
  })

  it('a header-only log (no event lines at all) preserves nothing — committedBytes is the header', () => {
    const log = JSON.stringify({
      type: 'session', version: SESSION_FORMAT_VERSION, id: 'h0', createdAt: 1,
      isSeeded: false, delegationDepth: 0,
    }) + '\n'
    const scanned = scanLog(Buffer.from(log))
    expect(scanned.events).toEqual([])
    // committedBytes falls back to the header line's end (no preserved events).
    expect(scanned.committedBytes).toBe(Buffer.byteLength(log, 'utf8'))
  })

  it('a corrupt line after the last turn/end bounds the preserved tail', () => {
    const log = [
      JSON.stringify({ type: 'session', version: SESSION_FORMAT_VERSION, id: 'c2', createdAt: 1, isSeeded: false, delegationDepth: 0 }),
      JSON.stringify({ type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } }),
      '{not json', // corrupt crash fragment, no turn/end committed
    ].join('\n') + '\n'
    // The contiguous prefix (turn/start seq 0) is preserved; the corrupt
    // fragment after it is the tolerated crash boundary.
    expect(scanLog(Buffer.from(log)).events.map(e => e.seq)).toEqual([0])
  })

  it('tolerates a seq gap AFTER a turn/end (uncommitted tail)', () => {
    const log = [
      JSON.stringify({ type: 'session', version: SESSION_FORMAT_VERSION, id: 't', createdAt: 1, isSeeded: false, delegationDepth: 0 }),
      JSON.stringify({ type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } }),
      JSON.stringify({ type: 'turn/end', seq: SessionSeq(1), time: 2, data: { turn: 1, reason: { kind: 'completed' } } }),
      JSON.stringify({ type: 'step/start', seq: SessionSeq(9), time: 3, data: { turn: 2, step: 1 } }), // gap in uncommitted tail
    ].join('\n') + '\n'
    const { events } = scanLog(Buffer.from(log))
    expect(events.map(e => e.seq)).toEqual([0, 1]) // tail dropped
  })
})
