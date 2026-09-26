import { describe, expect, it } from 'vitest'
import { restoreReleasedV3Artifact } from '@deepseek-ai/dsh-session-format-v2-to-v3'
import { SessionFormatEventCollector } from '@deepseek-ai/dsh-session-format'
import type { SessionFormatEvent, SessionFormatHeader, SessionFormatJsonObject } from '@deepseek-ai/dsh-session-format'
import { createSessionFormatCatalogWithChildren, historicalSessionFormatCatalog, sessionFormatCatalog } from '@deepseek-ai/dsh-session-format-catalog'
import { releasedV3SessionFormatCodec, createSessionFormatV3ToV4, sessionFormatV3ToV4 } from '../src/index.ts'

const header: SessionFormatHeader = { version: 3, id: 'identity', createdAt: 1, isSeeded: false, delegationDepth: 0 }
const fact: SessionFormatEvent = { type: 'feedback/record', seq: 0, time: 2, data: { text: 'retained' } }
const seed: SessionFormatEvent = { type: 'session/end-seed', seq: 1, time: 3, data: { inherited: true } }
const delivery = (version: number | undefined, sessionId = header.id): SessionFormatEvent => ({
  type: 'session-log-deepseek/delivery-accepted', seq: 1, time: 3,
  data: { sessionId, throughSeq: 0, ...(version === undefined ? {} : { sessionFormatVersion: version }) },
})

function stage(sourceHeader = header, sourceInheritedEventCount?: number) {
  return createSessionFormatV3ToV4([]).createStage({
    sourceHeader, targetHeader: sessionFormatV3ToV4.migrateHeader(sourceHeader),
    sourceInheritedEventCount, sourceKind: 'decoded',
  })
}

function migrate(events: readonly SessionFormatEvent[], sourceHeader = header, cut?: number) {
  const current = stage(sourceHeader, cut)
  const output = new SessionFormatEventCollector()
  for (const event of events) current.transformEvent(event, output)
  return { events: output.values, cut: current.finish(output) }
}

function restore(events: readonly SessionFormatEvent[], sourceHeader = header) {
  const reader = createSessionFormatCatalogWithChildren([]).createRestore({ type: 'session', ...sourceHeader }, { recovery: 'strict', validation: 'current' })
  for (const event of events) reader.decodeRow(event)
  return reader.finish()
}

function restoreHistorical(events: readonly SessionFormatEvent[], sourceHeader: SessionFormatHeader) {
  const reader = historicalSessionFormatCatalog.createRestore({ type: 'session', ...sourceHeader }, { recovery: 'strict', validation: 'current' })
  for (const event of events) reader.decodeRow(event)
  return reader.finish()
}

describe('V3 to V4 source preservation', () => {
  it('rejects required V3 developer events while preserving ignorable events and native V4 admission', () => {
    const rows: SessionFormatEvent[] = [
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
      { type: 'step/start', seq: 1, time: 2, data: { turn: 1, step: 1 } },
      { type: 'developer/message', seq: 2, time: 3, surfaceOp: 'append', data: {
        turn: 1, step: 1, message: { id: 'developer', role: 'developer', source: { kind: 'tool-registry' }, content: [] },
      } },
      { type: 'step/end', seq: 3, time: 4, data: { turn: 1, step: 1 } },
      { type: 'turn/end', seq: 4, time: 5, data: { turn: 1, reason: { kind: 'completed' } } },
    ]
    const before = structuredClone(rows)
    expect(() => migrate(rows)).toThrow('format v3 contains unknown event type "developer/message" at seq 2')
    expect(() => restore(rows)).toThrow('format v3 contains unknown event type "developer/message" at seq 2')
    expect(() => restoreHistorical(rows, header)).toThrow('unknown event type')
    const ignorable = rows.map(row => row.type === 'developer/message' ? { ...row, ignorable: true } : row)
    expect(restore(ignorable).events).toEqual(ignorable.map(row =>
      row.type === 'developer/message' ? { ...row, type: 'plugin:developer/message' } : row))
    const native = sessionFormatCatalog.createRestore({ type: 'session', ...header, version: 4 }, {
      recovery: 'strict', validation: 'current',
    })
    for (const row of rows) native.decodeRow(row)
    expect(native.finish().events).toEqual(rows)
    expect(rows).toEqual(before)
  })

  it('rejects generic required V3 extensions before target vocabulary admission', () => {
    const required = { ...fact, type: 'external/required' }
    expect(() => migrate([required])).toThrow('format v3 contains unknown event type "external/required" at seq 0')
    expect(() => restore([required])).toThrow('format v3 contains unknown event type "external/required" at seq 0')
    const ignorable = { ...required, ignorable: true }
    expect(restore([ignorable]).events).toEqual([{ ...ignorable, type: 'plugin:external/required' }])
  })

  it('changes only the header version and retains event objects, payloads, timestamps, and coordinates', () => {
    const rows = [fact, delivery(3)]
    const before = JSON.stringify({ header, rows })
    expect(sessionFormatV3ToV4.migrateHeader(header)).toEqual({ ...header, version: 4 })
    expect(migrate(rows)).toEqual({ events: rows, cut: 0 })
    expect(migrate(rows).events[0]).toBe(fact)
    expect(migrate(rows).events[1]).toBe(rows[1])
    expect(JSON.stringify({ header, rows })).toBe(before)
    expect(stage().headerInheritedEventCount).toBe(0)
    expect(migrate([])).toEqual({ events: [], cut: 0 })
    expect(restore(rows)).toEqual({ header: { ...header, version: 4 }, inheritedEventCount: 0, events: rows })
    expect(restore(rows)).toEqual(restore(rows))
  })

  it('keeps interleaved stage state independent and derives an inherited cut unavailable before EOF', () => {
    const inherited = stage({ ...header, isSeeded: true, parentSession: 'ancestor' })
    const local = stage()
    const a = new SessionFormatEventCollector()
    const b = new SessionFormatEventCollector()
    expect(inherited.headerInheritedEventCount).toBeUndefined()
    inherited.transformEvent(fact, a)
    local.transformEvent(fact, b)
    inherited.transformEvent(seed, a)
    expect(local.finish(b)).toBe(0)
    expect(inherited.finish(a)).toBe(1)
    expect(a.values).toEqual([fact, seed])
    expect(b.values).toEqual([fact])
    expect(migrate([fact, seed], { ...header, isSeeded: true }, 1).cut).toBe(1)
  })

  it('consumes compact runs without changing their event values', () => {
    const current = stage()
    const output = new SessionFormatEventCollector()
    current.transformRun({ runType: 'identity', eventCount: 1, firstSeq: 0, *expand() { yield fact } }, output)
    expect(current.finish(output)).toBe(0)
    expect(output.values[0]).toBe(fact)
  })

  it('rejects sparse sequences and inconsistent inheritance', () => {
    expect(() => migrate([{ ...fact, seq: 1 }])).toThrow('dense')
    expect(() => migrate([fact, seed])).toThrow('unseeded')
    expect(() => migrate([fact], { ...header, isSeeded: true })).toThrow('inherited event count')
    expect(() => migrate([fact, seed], { ...header, isSeeded: true }, 0)).toThrow('disagrees')
    expect(() => migrate([fact, { ...seed, data: {} }], { ...header, isSeeded: true })).toThrow('inherited event count')
  })

  it('refuses target-generation delivery while retaining other generations unchanged', () => {
    expect(() => migrate([fact, delivery(4)])).toThrow('claims target format v4')
    expect(() => restore([fact, delivery(4)])).toThrow('claims target format v4')
    for (const version of [undefined, 0, 1, 2, 3, 5, 99]) {
      const marker = delivery(version)
      expect(migrate([fact, marker]).events[1]).toBe(marker)
      expect(restore([fact, marker]).events[1]).toEqual(marker)
    }
  })

  it('checks active V3 coordinates before the delivery becomes historical', () => {
    const marker = delivery(3)
    const data = marker.data as SessionFormatJsonObject
    for (const throughSeq of [-1, 1, 1.5]) {
      expect(() => migrate([fact, { ...marker, data: { ...data, throughSeq } }])).toThrow('throughSeq')
    }
    expect(() => migrate([fact, { ...marker, data: { ...data, sessionId: '' } }])).toThrow('nonempty')
    expect(() => restore([fact, { ...marker, data: { ...data, throughSeq: 1 } }])).toThrow('throughSeq')
    const historical = { ...marker, data: { sessionId: 'ancestor', throughSeq: 500, sessionFormatVersion: 2 } }
    expect(restore([fact, historical]).events[1]).toEqual(historical)
  })

  it('permits foreign active deliveries only inside a parent seed', () => {
    const foreign = delivery(3, 'ancestor')
    expect(() => migrate([fact, foreign])).toThrow('wrong Session')
    expect(() => migrate([fact, foreign], { ...header, parentSession: 'ancestor' })).toThrow('wrong Session')
    const rows = [fact, foreign, { ...seed, seq: 2 }]
    expect(migrate(rows, { ...header, isSeeded: true, parentSession: 'ancestor' }).cut).toBe(2)
    expect(() => migrate(rows, { ...header, isSeeded: true })).toThrow('wrong Session')
    expect(() => migrate([fact, seed, { ...foreign, seq: 2 }], { ...header, isSeeded: true, parentSession: 'ancestor' })).toThrow('wrong Session')
  })

  it('retains unknown ignorable values and refuses unknown required events during strict catalog restoration', () => {
    const opaque: SessionFormatEvent = {
      type: 'external/opaque', seq: 0, time: -5, ignorable: true,
      data: { nested: { seq: 40 }, content: ['opaque'] }, surfaceOp: { future: { ref: 9 } },
    }
    expect(restore([opaque]).events).toEqual([{ ...opaque, type: 'plugin:external/opaque' }])
    const { ignorable: _ignorable, ...required } = opaque
    expect(() => restore([required])).toThrow('unknown event type')
    expect(() => restore([{ ...fact, time: 1.5 }])).toThrow('time')
    expect(() => restore([{ ...fact, extra: 1 }])).toThrow(/field|member/)
  })

  it.each([0, 1, 2, 3])('restores a seeded V%i chain, including upstream cardinality changes, and reopens V4', (version) => {
    const rows = [
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'step/start', data: { turn: 1, step: 1 } },
      { type: 'user/message', data: { id: 'user', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'input' }] }, surfaceOp: 'append' },
      { type: 'request/header', data: { header: { config: { provider: 'mock', model: 'mock' }, system: 'seed prompt' }, reason: 'initial' } },
      { type: 'step/end', data: { turn: 1, step: 1 } },
      { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
      { type: 'session/end-seed', data: version < 2 ? {} : { inherited: true } },
    ].map((event, seq): SessionFormatEvent => ({ ...event, seq, time: seq + 1 }))
    const source = version === 3 ? restoreHistorical(rows, { ...header, version: 2, isSeeded: true }).events : rows
    const physical = version < 2
      ? { type: 'session', version, id: header.id, createdAt: 1, delegationDepth: 0, parentSession: 'ancestor', seedLength: 6 }
      : { type: 'session', ...header, version, isSeeded: true, parentSession: 'ancestor' }
    const before = JSON.stringify({ physical, source })
    const reader = createSessionFormatCatalogWithChildren([]).createRestore(physical, { recovery: 'strict', validation: 'current' })
    for (const row of source) reader.decodeRow(version === 3 ? releasedV3SessionFormatCodec.encodeEvent(row) : row)
    const artifact = reader.finish()
    expect(artifact.header.version).toBe(4)
    expect(artifact.inheritedEventCount).toBe(8)
    expect(artifact.events.filter(event => event.type === 'system/message')).toHaveLength(2)
    expect(artifact.events.at(-1)?.seq).toBe(8)
    const reopened = sessionFormatCatalog.createRestore(sessionFormatCatalog.encodeCurrentHeader(artifact.header, 8), {
      recovery: 'strict', validation: 'current',
    })
    for (const event of artifact.events) reopened.decodeRow(sessionFormatCatalog.encodeCurrentEvent(event))
    expect(reopened.finish()).toEqual(artifact)
    expect(JSON.stringify({ physical, source })).toBe(before)
  })

  it.each(['strict', 'recoverable'] as const)('retains delivery inside a nested inherited prefix during %s restoration', (recovery) => {
    const physical = { type: 'session', ...header, isSeeded: true, parentSession: 'ancestor' }
    const rows = [fact, seed, { ...delivery(3, 'ancestor'), seq: 2 }, { ...seed, seq: 3 }]
    const decoder = releasedV3SessionFormatCodec.createDecoder(physical, 'strict')
    const source = new SessionFormatEventCollector()
    for (const row of rows) decoder.decodeRow(row, source)
    const artifact = restoreReleasedV3Artifact({ header: decoder.header, events: source.values,
      inheritedEventCount: decoder.finish(source) }, new Set(rows.map(row => row.type)))
    expect(artifact.inheritedEventCount).toBe(3)

    const reader = createSessionFormatCatalogWithChildren([]).createRestore(physical, { recovery, validation: 'current' })
    for (const row of rows) reader.decodeRow(row)
    expect(reader.finish()).toEqual({ ...artifact, header: { ...artifact.header, version: 4 } })
  })

  it.each(['strict', 'recoverable'] as const)('refuses foreign delivery after the final inherited cut during %s restoration', (recovery) => {
    const reader = createSessionFormatCatalogWithChildren([]).createRestore({ type: 'session', ...header, isSeeded: true, parentSession: 'ancestor' }, {
      recovery, validation: 'current',
    })
    for (const row of [fact, seed, { ...delivery(3, 'ancestor'), seq: 2 }, { ...seed, seq: 3 }, { ...delivery(3, 'ancestor'), seq: 4 }]) {
      reader.decodeRow(row)
    }
    expect(() => reader.finish()).toThrow('wrong Session')
  })
})
