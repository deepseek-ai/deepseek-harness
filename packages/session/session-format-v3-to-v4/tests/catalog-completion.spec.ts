import { describe, expect, it } from 'vitest'
import { isSessionFormatJsonObject } from '@deepseek-ai/dsh-session-format'
import { catalogFact, childCatalogFact, childCatalogSubject } from '../src/facts.ts'
import type { SessionFormatEvent, SessionFormatJsonValue } from '@deepseek-ai/dsh-session-format'
import { createSessionFormatV3ToV4, historicalChildCatalogSource, sessionFormatV3ToV4 } from '../src/index.ts'

const header = { version: 3, id: 'parent', createdAt: 1, isSeeded: false, delegationDepth: 0 }
const child = { version: 0, childId: 'child', childCreatedAt: 2, mode: 'continuable', label: 'child task' }

function migrate(events: SessionFormatEvent[], facts: readonly SessionFormatJsonValue[], seeded = false, cut?: number, run = false) {
  const migration = createSessionFormatV3ToV4(facts.map((value) => {
    if (!isSessionFormatJsonObject(value) || !('version' in value)) return value
    const fact = catalogFact(value)
    return { childId: fact['childId']!, childCreatedAt: fact['childCreatedAt']!, descriptorCount: 1,
      descriptor: { version: 3, provider: 'spawn', mode: fact['mode']!, ...(fact['label'] === undefined ? {} : { label: fact['label'] }) } }
  }))
  const stage = migration.createStage({
    sourceHeader: { ...header, isSeeded: seeded, ...(seeded ? { parentSession: 'ancestor' } : {}) }, targetHeader: { ...header, version: 4, isSeeded: seeded },
    sourceKind: 'decoded', sourceInheritedEventCount: cut ?? (seeded ? undefined : 0),
  })
  const output: SessionFormatEvent[] = []
  const context = { emitEvent: (event: SessionFormatEvent) => { output.push(event) }, emitRun: () => { throw new Error('unexpected run') } }
  if (run) stage.transformRun({ runType: 'test', firstSeq: 0, eventCount: events.length, *expand() { yield* events } }, context)
  else for (const event of events) stage.transformEvent(event, context)
  return { cut: stage.finish(context), events: output }
}

describe('V3 parent catalog completion', () => {
  it('interprets V1 descriptors and includes an evidence source path in diagnostics', () => {
    expect(childCatalogFact({
      childId: 'child', childCreatedAt: 2, descriptorCount: 1,
      descriptor: { version: 1, provider: 'spawn', label: 'legacy child' },
    })).toEqual({ version: 0, childId: 'child', childCreatedAt: 2, mode: 'continuable', label: 'legacy child' })
    expect(childCatalogSubject({ childId: 'child', sourcePath: '/tmp/session.v3.jsonl' }))
      .toBe('Session child (raw log: /tmp/session.v3.jsonl)')
  })

  it('appends deterministic child facts without changing source events', () => {
    const source = [{ type: 'feedback/record', seq: 0, time: 10, data: { text: 'retained' } }]
    const result = migrate(source, [child])
    expect(result.events[0]).toBe(source[0])
    expect(result.events[1]).toEqual({ type: 'subagent/catalog', seq: 1, time: 10, data: child })
    expect(migrate(source, [child])).toEqual(result)
    expect(source).toHaveLength(1)
  })

  it('preserves existing facts and adds only missing children', () => {
    const source = [{ type: 'subagent/catalog', seq: 0, time: 5, data: child }]
    expect(migrate(source, [child, child]).events).toEqual(source)
    expect(migrate(source, [child, { ...child, childId: 'second' }]).events).toHaveLength(2)
  })

  it('does not treat inherited catalog membership as owned', () => {
    const source = [
      { type: 'subagent/catalog', seq: 0, time: 1, data: child },
      { type: 'session/end-seed', seq: 1, time: 2, data: { inherited: true } },
    ]
    const result = migrate(source, [child], true)
    expect(result.cut).toBe(1)
    expect(result.events[2]).toMatchObject({ type: 'subagent/catalog', seq: 2, data: child })
  })

  it('validates catalog payloads only after the final inherited seed marker', () => {
    const opaque = { type: 'subagent/catalog', seq: 0, time: 1, data: { version: 99 } }
    const seed = { type: 'session/end-seed', seq: 1, time: 2, data: { inherited: true } }
    const source = [opaque, seed, { ...opaque, seq: 2 }, { ...seed, seq: 3 }]
    expect(migrate(source, [child], true).events).toEqual([
      ...source, { type: 'subagent/catalog', seq: 4, time: 2, data: child },
    ])
    expect(() => migrate([...source, { ...opaque, seq: 4 }], [], true)).toThrow('supported versioned')
    expect(() => migrate([opaque], [])).toThrow('supported versioned')
  })

  it('requires explicit corpus facts and refuses conflicting identities', () => {
    expect(() => sessionFormatV3ToV4.createStage({ sourceHeader: header, targetHeader: { ...header, version: 4 },
      sourceKind: 'decoded', sourceInheritedEventCount: 0 })).toThrow('explicit historical child facts')
    expect(() => migrate([], [{ ...child, mode: 'invalid' }])).toThrow('supported versioned')
    expect(() => migrate([{ type: 'subagent/catalog', seq: 0, time: 2, data: child }], [{ ...child, childCreatedAt: 3 }])).toThrow('conflicts')
  })

  it('extracts the own descriptor after a fork prefix', () => {
    const artifact = {
      header: { ...header, id: 'child', createdAt: 2, origin: 'subagent' as const, parentSession: 'parent', isSeeded: true },
      inheritedEventCount: 1,
      events: [
        { type: 'subagent/descriptor', seq: 0, time: 1, data: { version: 3, mode: 'one-shot', provider: 'fork' } },
        { type: 'subagent/descriptor', seq: 1, time: 2, data: { version: 3, mode: 'continuable', provider: 'fork', label: 'child task' } },
      ],
    }
    expect(childCatalogFact(historicalChildCatalogSource(artifact))).toEqual(child)
    expect(migrate([], [historicalChildCatalogSource({ ...artifact, inheritedEventCount: 0 })]).events).toMatchObject([{ data: { childId: 'child', mode: 'unknown' } }])
    expect(migrate([], [historicalChildCatalogSource({ ...artifact, events: [] })]).events).toMatchObject([{ data: { childId: 'child', mode: 'unknown' } }])
  })
  it('orders tied and differently dated children independently of directory enumeration', () => {
    const children = [{ ...child, childId: 'z' }, { ...child, childId: 'a' }, { ...child, childId: 'first', childCreatedAt: 1 }]
    expect(migrate([], children).events.map(event => event.data)).toEqual([children[2], children[1], children[0]])
    expect(migrate([], children).events[0]?.time).toBe(1)
  })

  it('rejects duplicates, sparse events, and missing or inconsistent seed cuts', () => {
    const catalog = { type: 'subagent/catalog', seq: 0, time: 1, data: child }
    expect(() => migrate([catalog, { ...catalog, seq: 1 }], [])).toThrow('duplicate')
    expect(() => migrate([{ ...catalog, seq: 1 }], [])).toThrow('dense')
    expect(() => migrate([], [], true)).toThrow('inherited event count')
    expect(() => migrate([], [], false, 1)).toThrow('disagrees')
    expect(migrate([catalog], [], false, undefined, true).events).toEqual([catalog])
  })

  it('refuses target delivery activation and invalid current delivery ownership', () => {
    const preceding = { type: 'feedback/record', seq: 0, time: 1, data: { text: 'prior' } }
    const delivery = { type: 'session-log-deepseek/delivery-accepted', seq: 1, time: 1,
      data: { sessionId: 'other', throughSeq: 0, sessionFormatVersion: 4 } }
    expect(() => migrate([preceding, delivery], [])).toThrow('claims target format v4')
    expect(() => migrate([preceding, { ...delivery, data: { ...delivery.data, sessionFormatVersion: 3 } }], [])).toThrow('wrong Session')
  })

  it('retains unknown children while validating available descriptor fields', () => {
    const artifact = { header: { ...header, origin: 'subagent' as const, parentSession: 'parent' }, inheritedEventCount: 0, events: [] }
    expect(() => historicalChildCatalogSource({ ...artifact, header })).toThrow('direct parent')
    for (const data of [null, {}, { version: 4, mode: 'one-shot', provider: 'spawn' }]) {
      expect(migrate([], [historicalChildCatalogSource({ ...artifact, events: [{ type: 'subagent/descriptor', seq: 0, time: 1, data }] })]).events).toMatchObject([{ data: { childId: 'parent', mode: 'unknown' } }])
    }
    for (const value of [null, { ...child, version: 2 }, { ...child, childId: null },
      { ...child, label: null }, { ...child, childCreatedAt: -1 }]) {
      expect(() => migrate([], [value])).toThrow()
    }
    expect(migrate([], [{ version: 0, childId: 'one-shot', childCreatedAt: 2, mode: 'one-shot' }]).events).toHaveLength(1)
  })

  it.each([null, { version: 99 }])('retains existing catalog extensions without interpreting unavailable descriptors: %j', (descriptor) => {
    const data = { ...child, plugin: 'retained' }
    const source = [{ type: 'subagent/catalog', seq: 0, time: 1, data }]
    expect(migrate(source, [{ childId: 'child', childCreatedAt: 2, descriptorCount: descriptor === null ? 0 : 1, descriptor }]).events).toEqual(source)
  })

  it('keeps parent facts authoritative when a child has multiple own descriptors', () => {
    const data = { ...child, extension: { retained: true } }
    const source = [{ type: 'subagent/catalog', seq: 0, time: 1, data }]
    const evidence = { childId: 'child', childCreatedAt: 2, descriptorCount: 2,
      descriptor: { version: 3, mode: 'one-shot', provider: 'spawn', label: 'ambiguous child identity' } }
    expect(migrate(source, [evidence]).events).toEqual(source)
    expect(() => migrate(source, [{ ...evidence, childCreatedAt: 3 }])).toThrow('conflicts')
  })

  it.each(['missing', 'unknown', 'multiple'] as const)('continues catalog backfill after %s child evidence', (kind) => {
    const descriptor: SessionFormatJsonValue = kind === 'missing' ? null : kind === 'unknown' ? { version: 99 }
      : { version: 3, mode: 'one-shot', provider: 'spawn' }
    const unavailable = { childId: 'unavailable', childCreatedAt: 1,
      descriptorCount: kind === 'missing' ? 0 : kind === 'multiple' ? 2 : 1, descriptor }
    expect(migrate([], [child, unavailable]).events).toEqual([
      { type: 'subagent/catalog', seq: 0, time: 1, data: { version: 1, childId: 'unavailable', childCreatedAt: 1, mode: 'unknown' } },
      { type: 'subagent/catalog', seq: 1, time: 1, data: child },
    ])
  })

  it('refuses malformed supplemental evidence and known descriptor conflicts', () => {
    for (const source of [null, {}, { childId: 'child', childCreatedAt: 2, descriptor: null, descriptorCount: -1 }]) {
      expect(() => migrate([], [source])).toThrow()
    }
    const source = { childId: 'child', childCreatedAt: 2, descriptorCount: 1,
      descriptor: { version: 3, mode: 'continuable', label: 'child task' } }
    expect(() => migrate([], [source])).toThrow('invalid subagent descriptor provider')
    const existing = [{ type: 'subagent/catalog', seq: 0, time: 1, data: child }]
    expect(() => migrate(existing, [{ ...source, descriptor: { ...source.descriptor, provider: 'spawn', label: 'different' } }])).toThrow('conflicts')
  })

  it('validates predecessor delivery before preserving its generation identity', () => {
    const prior = { type: 'feedback/record', seq: 0, time: 1, data: { text: 'prior' } }
    const marker = { type: 'session-log-deepseek/delivery-accepted', seq: 1, time: 1,
      data: { sessionId: 'ancestor', throughSeq: 0, sessionFormatVersion: 3 } }
    const seed = { type: 'session/end-seed', seq: 2, time: 2, data: { inherited: true } }
    expect(migrate([prior, marker, seed], [], true).events).toEqual([prior, marker, seed])
    expect(() => migrate([prior, { ...seed, seq: 1 }, { ...marker, seq: 2 }], [], true)).toThrow('wrong Session')
    expect(migrate([prior, { ...marker, data: { ...marker.data, sessionFormatVersion: 2 } }], []).events).toHaveLength(2)
    expect(migrate([prior, { ...marker, data: { ...marker.data, sessionId: 'parent' } }], []).events).toHaveLength(2)
    expect(childCatalogFact(historicalChildCatalogSource({ header: { ...header, origin: 'subagent', parentSession: 'ancestor' }, inheritedEventCount: 0,
      events: [{ type: 'subagent/descriptor', seq: 0, time: 1, data: { version: 3, mode: 'one-shot', provider: 'spawn' } }] }))).toEqual({ version: 0, childId: 'parent', childCreatedAt: 1, mode: 'one-shot' })
  })
})
