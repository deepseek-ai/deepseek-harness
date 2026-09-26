import { describe, expect, it } from 'vitest'
import { createSessionFormatCatalogWithChildren, sessionFormatCatalog } from '@deepseek-ai/dsh-session-format-catalog'
import { SessionFormatEventCollector } from '@deepseek-ai/dsh-session-format'
import type { SessionFormatArtifact, SessionFormatEvent } from '@deepseek-ai/dsh-session-format'
import { releasedV4SessionFormatCodec, restoreReleasedV4Artifact } from '../src/index.ts'

const header = { type: 'session', version: 2, id: 'canonical-v4', createdAt: 1, isSeeded: true, parentSession: 'parent', delegationDepth: 0 }
function source() {
  const user = { id: 'context', role: 'user', source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt' }, content: [{ type: 'text', text: 'context' }] }
  const dispatch = { rootCallId: 'root', parentCallId: 'root', subCallId: 'child', name: 'test', arguments: { kind: 'plugin', plugin: 'tools-ptc' } }
  const rows = [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'step/start', data: { turn: 1, step: 1 } },
    { type: 'request/header', data: { reason: 'initial', header: { config: { provider: 'mock', model: 'mock' }, system: 'system', tools: [] } } },
    { type: 'user/message', surfaceOp: 'append', data: user },
    { type: 'tool/code-dispatch-start', data: dispatch },
    { type: 'tool/code-dispatch', data: { ...dispatch, isError: false, content: [] } },
    { type: 'user/message', surfaceOp: { op: 'replace', start: 3, end: 3 }, sourceEventSeqs: [3], data: { ...user, id: 'replacement', source: { kind: 'plugin', plugin: 'tools-code-mode' } } },
    { type: 'request/header', data: { reason: 'change', header: { config: { provider: 'mock', model: 'mock' }, system: '' } } },
    { type: 'step/end', data: { turn: 1, step: 1 } },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
    { type: 'session/end-seed', data: { inherited: true } },
  ]
  return rows.map((row, seq) => ({ ...row, seq, time: seq + 1 })) as SessionFormatEvent[]
}
function migrated() {
  const restore = createSessionFormatCatalogWithChildren([]).createRestore(header, { recovery: 'strict', validation: 'current' })
  for (const row of source()) restore.decodeRow(row)
  return restore.finish()
}

function reopen(artifact: SessionFormatArtifact) {
  const header = sessionFormatCatalog.encodeCurrentHeader(artifact.header, artifact.inheritedEventCount)
  const restore = sessionFormatCatalog.createRestore(header, {
    recovery: 'strict', validation: 'current',
  })
  for (const event of artifact.events) restore.decodeRow(sessionFormatCatalog.encodeCurrentEvent(event))
  return restore.finish()
}

describe('canonical V4 integration', () => {
  it('composes seeded systems, source ownership, PTC, canonical replacements and native round-trip', () => {
    const target = migrated()
    expect(target.header.version).toBe(4)
    expect(target.inheritedEventCount).toBe(13)
    const systems = target.events.filter(event => event.type === 'system/message')
    expect(systems).toHaveLength(3)
    for (const system of systems) expect(system.data).toMatchObject({ message: { role: 'system', source: { kind: 'system-prompt' } } })
    const users = target.events.filter(event => event.type === 'user/message')
    expect(users[0]?.data).toMatchObject({ source: { kind: 'runtime-context' } })
    expect(users[1]).toMatchObject({ surfaceOp: { op: 'replace', startSeq: 5, endSeq: 5 }, sourceEventSeqs: [5], data: { source: { kind: 'ptc-mode' } } })
    expect(target.events.find(event => event.type === 'tool/ptc-dispatch')?.data).toMatchObject({ arguments: { kind: 'plugin', plugin: 'tools-ptc' } })
    const before = JSON.stringify(target)
    expect(restoreReleasedV4Artifact(target, new Set(target.events.map(event => event.type)))).toBe(target)
    expect(reopen(target)).toEqual(target)
    expect(JSON.stringify(target)).toBe(before)
  })

  it.each([{ sourceEventSeqs: [] }, { surfaceOp: { op: 'replace', start: 0, end: 0 } }])('rejects noncanonical native metadata %j', (override) => {
    const target = migrated()
    const system = target.events.find(event => event.type === 'system/message')!
    const bad = { ...system, ...override }
    const invalid = { ...target, events: target.events.map(event => event === system ? bad : event) }
    expect(() => reopen(invalid)).toThrow()
  })

  it('leaves common event and message validation to current Session restoration', () => {
    const decoder = releasedV4SessionFormatCodec.createDecoder({ ...header, version: 4, isSeeded: false }, 'recoverable')
    const output = new SessionFormatEventCollector()
    decoder.decodeRow(null, output)
    expect(decoder.finish(output)).toBe(0)
  })

  it('keeps earlier-generation delivery markers ignored and validates native current ownership', () => {
    const marker = (version: number): SessionFormatEvent => ({ type: 'session-log-deepseek/delivery-accepted', seq: 0, time: 1, data: { sessionId: 'other', throughSeq: 0, sessionFormatVersion: version } })
    const { type: _type, ...logical } = header
    const artifact = { header: { ...logical, version: 4, isSeeded: false }, inheritedEventCount: 0, events: [marker(3)] }
    expect(restoreReleasedV4Artifact(artifact, new Set([marker(3).type]))).toBe(artifact)
    expect(() => restoreReleasedV4Artifact({ ...artifact, events: [{ type: 'feedback/record', seq: 0, time: 1, ignorable: true, data: {} }, { ...marker(4), seq: 1 }] }, new Set(['feedback/record', marker(4).type]))).toThrow(/wrong Session/)
    const reader = createSessionFormatCatalogWithChildren([]).createRestore({ ...header, version: 3, isSeeded: false }, { recovery: 'strict', validation: 'current' })
    reader.decodeRow({ type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } })
    reader.decodeRow({ ...marker(3), seq: 1, time: 2 })
    expect(() => reader.finish()).toThrow(/wrong Session/)
  })

  it('retains native compaction checkpoint sources during restoration', () => {
    const artifact: SessionFormatArtifact = {
      header: { version: 4, id: 'compact-v4', createdAt: 1, isSeeded: false, delegationDepth: 0 },
      inheritedEventCount: 0,
      events: [
        { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
        { type: 'user/message', seq: 1, time: 2, data: { id: 'input', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'input' }] }, surfaceOp: 'append' },
        { type: 'compaction/start', seq: 2, time: 3, data: { compactionId: 'compact-1', turn: 1 } },
        { type: 'compaction/summary', seq: 3, time: 4, data: {
          compactionId: 'compact-1', summary: [{ type: 'text', text: 'summary' }],
          shadowedRange: { start: 1, end: 1 }, shadowedSeqs: [1], shadowedTokenCount: 1,
          provider: 'mock', model: 'mock',
        } },
        { type: 'user/message', seq: 4, time: 5, data: {
          id: 'checkpoint', role: 'user',
          source: { kind: 'compact-checkpoint', compactionId: 'compact-1' },
          content: [{ type: 'text', text: 'summary' }],
        }, surfaceOp: { op: 'replace', startSeq: 1, endSeq: 1 }, sourceEventSeqs: [2, 3, 1] },
        { type: 'compaction/end', seq: 5, time: 6, data: { compactionId: 'compact-1', turn: 1 } },
        { type: 'turn/end', seq: 6, time: 7, data: { turn: 1, reason: { kind: 'completed' } } },
      ],
    }
    expect(restoreReleasedV4Artifact(artifact, new Set(artifact.events.map(event => event.type)))).toBe(artifact)
    expect(artifact.events[4]?.data).toMatchObject({ source: { kind: 'compact-checkpoint', compactionId: 'compact-1' } })
  })
})
