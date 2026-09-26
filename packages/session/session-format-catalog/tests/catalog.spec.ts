import { describe, expect, it } from 'vitest'
import type { SessionFormatEvent } from '@deepseek-ai/dsh-session-format'
import { createSessionFormatCatalogWithChildren, historicalSessionFormatCatalog, sessionFormatCatalog } from '../src/index.ts'
import { currentSessionMessageProjections } from '../src/message-projections.ts'
import { MESSAGE_PROJECTION_EVENT_TYPES } from '@deepseek-ai/dsh-session/src/known-event-types.ts'
import { validateInstalledCurrentSessionArtifact } from '../src/current.ts'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

describe('first-party Session format catalog', () => {
  it('supplies every required current message interpreter and validates its durable references', () => {
    expect(currentSessionMessageProjections.map(projection => projection.type).sort())
      .toEqual([...MESSAGE_PROJECTION_EVENT_TYPES].sort())
    const session = Session.create(SessionId('projection-catalog'))
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'no image' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    const artifact = {
      header: { ...session.header, delegationDepth: 0 }, inheritedEventCount: 0,
      events: [...session.snapshotEvents() as unknown as SessionFormatEvent[], { type: 'image/offload', seq: 1, time: 0, data: { targets: [{ seq: 0, imageIndexes: [0] }] } }],
    }
    expect(() => { validateInstalledCurrentSessionArtifact(artifact) }).toThrow(/image index 0 does not exist/)
  })
  it('statically owns every adjacent edge through the current writer', () => {
    const header = {
      type: 'session',
      version: 0,
      id: 'catalog',
      createdAt: 1,
      seedLength: 0,
      delegationDepth: 0,
    }

    expect(sessionFormatCatalog.currentVersion).toBe(SESSION_FORMAT_VERSION)
    expect(sessionFormatCatalog.readHeader(header)).toEqual({
      status: 'migration-required',
      storedVersion: 0,
      targetVersion: SESSION_FORMAT_VERSION,
      header: {
        version: SESSION_FORMAT_VERSION,
        id: 'catalog',
        createdAt: 1,
        isSeeded: true,
        delegationDepth: 0,
      },
    })

    const v1Header = { ...header, version: 1 }
    const restore = createSessionFormatCatalogWithChildren([]).createRestore(v1Header, {
      recovery: 'strict', validation: 'current',
    })
    restore.decodeRow({ type: 'turn/start', seq: 0, time: 2, data: { turn: 1 } })
    expect(restore.finish()).toMatchObject({
      header: { version: SESSION_FORMAT_VERSION, id: 'catalog' },
    })
  })

  it('restores the installed current vocabulary without freezing ordinary payload additions', () => {
    const header = {
      type: 'session', version: SESSION_FORMAT_VERSION, id: 'current-growth', createdAt: 1, isSeeded: false, delegationDepth: 0,
    }
    const restore = (rows: readonly unknown[]) => {
      const current = createSessionFormatCatalogWithChildren([]).createRestore(header, {
        recovery: 'strict', validation: 'current',
      })
      for (const row of rows) current.decodeRow(row)
      return current.finish()
    }
    const extended = restore([{
      type: 'turn/start', seq: 0, time: 1, data: { turn: 1, postReleaseMember: true },
    }])
    expect(extended.events).toEqual([{
      type: 'turn/start', seq: 0, time: 1, data: { turn: 1, postReleaseMember: true },
    }])

    expect(() => restore([{
      type: 'ordinary/not-installed', seq: 0, time: 1, data: 'future',
    }])).toThrow(/unknown event type/)

    const extension = restore([{
      type: 'ordinary/external', seq: 0, time: 1, data: null, ignorable: true,
    }])
    expect(extension.events).toEqual([{
      type: 'ordinary/external', seq: 0, time: 1, data: null, ignorable: true,
    }])
  })

  it.each([0, 1])('restores v%i empty and non-empty inherited prefixes through every adjacent edge', (version) => {
    for (const seedLength of [0, 1]) {
      const sourceHeader = {
        type: 'session', version, id: 'seed-chain', createdAt: 1,
        parentSession: 'parent', seedLength, delegationDepth: 0,
      }
      const restore = createSessionFormatCatalogWithChildren([]).createRestore(sourceHeader, { recovery: 'strict', validation: 'current' })
      if (seedLength > 0) {
        restore.decodeRow({ type: 'feedback/record', seq: 0, time: 1, data: { text: 'inherited' } })
      }
      const artifact = restore.finish()
      expect(artifact.header.version).toBe(SESSION_FORMAT_VERSION)
      expect(artifact.inheritedEventCount).toBe(seedLength)
      expect(artifact.events.at(-1)).toEqual({
        type: 'session/end-seed', seq: seedLength, time: 1, data: { inherited: true },
      })
      expect(sourceHeader.version).toBe(version)
    }
  })

  it.each([false, true])('inserts the v3 system head and remaps the inherited cut (seeded=%s)', (isSeeded) => {
    const header = { type: 'session', version: 2, id: 'v2-identity', createdAt: 1, isSeeded, delegationDepth: 0 }
    const rows = [
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
      { type: 'step/start', seq: 1, time: 2, data: { turn: 1, step: 1 } },
      { type: 'feedback/record', seq: 2, time: 3, data: { text: 'unchanged' } },
      ...(isSeeded ? [{ type: 'session/end-seed', seq: 3, time: 4, data: { inherited: true } }] : []),
    ]
    const before = JSON.stringify({ header, rows })
    const restore = createSessionFormatCatalogWithChildren([]).createRestore(header, { recovery: 'strict', validation: 'current' })
    for (const row of rows) restore.decodeRow(row)
    expect(restore.finish()).toEqual({
      header: { version: SESSION_FORMAT_VERSION, id: 'v2-identity', createdAt: 1, isSeeded, delegationDepth: 0 },
      inheritedEventCount: isSeeded ? 4 : 0,
      events: [
        { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
        { type: 'step/start', seq: 1, time: 2, data: { turn: 1, step: 1 } },
        {
          type: 'system/message', seq: 2, time: 2, surfaceOp: 'append',
          data: {
            turn: 1, step: 1,
            message: {
              id: 'v2-to-v3-system-9673c4ed630de6c21ea6bd6b573094ea8e5e216843a1b572a68657499ad9667b',
              role: 'system', source: { kind: 'system-prompt' }, content: [],
            },
          },
        },
        { type: 'feedback/record', seq: 3, time: 3, data: { text: 'unchanged' } },
        ...(isSeeded ? [{ type: 'session/end-seed', seq: 4, time: 4, data: { inherited: true } }] : []),
      ],
    })
    expect(JSON.stringify({ header, rows })).toBe(before)
  })

  it.each(['current', 'transformed'] as const)('refuses unclassified ignorable v2 events (%s)', (validation) => {
    const header = { type: 'session', version: 2, id: 'v2-unknown', createdAt: 1, isSeeded: false, delegationDepth: 0 }
    const row = { type: 'external/event', seq: 0, time: 1, data: { extra: ['unchanged'] }, ignorable: true }
    const before = JSON.stringify({ header, row })
    const restore = createSessionFormatCatalogWithChildren([]).createRestore(header, { recovery: 'strict', validation })
    expect(() => { restore.decodeRow(row) }).toThrow(/cannot safely transform unclassified event external\/event/)
    expect(JSON.stringify({ header, row })).toBe(before)
  })

  it.each([0, 1, 2])('migrates frozen v%i PTC records and reopens the actual current representation without rewriting IDs', (version) => {
    const sourceHeader = deepFreeze({
      type: 'session', version, id: 'tools-code-mode:session', createdAt: 1, delegationDepth: 0,
      ...(version === 2 ? { isSeeded: false } : {}),
    })
    const message = (id: string) => ({
      id, role: 'user', source: { kind: 'plugin', plugin: 'tools-code-mode' },
      content: [{ type: 'text', text: 'tool/code-dispatch-start tools-code-mode tools-ptc' }],
    })
    const oldId = 'tools-code-mode:message'
    const newId = 'tools-ptc:message'
    const rootId = 'tools-code-mode:root'
    const childId = 'tools-code-mode:child'
    const dispatch = {
      rootCallId: rootId, parentCallId: rootId, subCallId: childId, name: 'read',
      arguments: { text: 'tools-code-mode', nested: { type: 'tool/code-dispatch' } },
    }
    const rows: SessionFormatEvent[] = deepFreeze([
      { type: 'turn/start', seq: 0, time: 10, data: { turn: 1 } },
      { type: 'step/start', seq: 1, time: 10, data: { turn: 1, step: 1 } },
      { type: 'user/message', seq: 2, time: 11, data: message(oldId), surfaceOp: 'append' },
      { type: 'user/message', seq: 3, time: 12, data: message(newId), surfaceOp: 'append' },
      { type: 'agent/inbox/spliced', seq: 4, time: 13, data: { target: 'next-turn', start: 0, inserted: [message(oldId), message(newId)] } },
      { type: 'tool/code-dispatch-start', seq: 5, time: 14, data: dispatch },
      { type: 'tool/code-dispatch', seq: 6, time: 15, data: { ...dispatch, isError: false, content: [{ type: 'text', text: childId }] } },
      { type: 'user/message', seq: 7, time: 16, data: message('tools-code-mode:replacement'), sourceEventSeqs: [2, 3], surfaceOp: { op: 'replace', start: 2, end: 3 } },
      { type: 'step/end', seq: 8, time: 17, data: { turn: 1, step: 1 } },
      { type: 'turn/end', seq: 9, time: 17, data: { turn: 1, reason: { kind: 'completed' } } },
    ])
    const before = JSON.stringify({ sourceHeader, rows })
    const restore = createSessionFormatCatalogWithChildren([]).createRestore(sourceHeader, { recovery: 'strict', validation: 'current' })
    for (const row of rows) restore.decodeRow(row)
    const artifact = restore.finish()
    const renamedMessage = (id: string) => ({ ...message(id), source: { kind: 'ptc-mode' } })
    const expected = [
      rows[0], rows[1],
      expect.objectContaining({ type: 'system/message', seq: 2 }),
      { ...rows[2], seq: 3, data: renamedMessage(oldId) },
      { ...rows[3], seq: 4, data: renamedMessage(newId) },
      { ...rows[4], seq: 5, data: { target: 'next-turn', start: 0, inserted: [renamedMessage(oldId), renamedMessage(newId)] } },
      { ...rows[5], seq: 6, type: 'tool/ptc-dispatch-start' },
      { ...rows[6], seq: 7, type: 'tool/ptc-dispatch' },
      { ...rows[7], seq: 8, sourceEventSeqs: [3, 4], surfaceOp: { op: 'replace', startSeq: 3, endSeq: 4 }, data: renamedMessage('tools-code-mode:replacement') },
      { ...rows[8], seq: 9 }, { ...rows[9], seq: 10 },
    ]
    expect(artifact).toEqual({
      header: { version: SESSION_FORMAT_VERSION, id: sourceHeader.id, createdAt: 1, isSeeded: false, delegationDepth: 0 },
      inheritedEventCount: 0, events: expected,
    })
    const currentHeader = deepFreeze(sessionFormatCatalog.encodeCurrentHeader(artifact.header, artifact.inheritedEventCount))
    const currentRows = deepFreeze(artifact.events.map(event => sessionFormatCatalog.encodeCurrentEvent(event)))
    const encodedBefore = JSON.stringify({ currentHeader, currentRows })
    const reopened = sessionFormatCatalog.createRestore(currentHeader, { recovery: 'strict', validation: 'current' })
    for (const row of currentRows) reopened.decodeRow(row)
    expect(reopened.finish()).toEqual(artifact)
    expect(JSON.stringify({ sourceHeader, rows })).toBe(before)
    expect(JSON.stringify({ currentHeader, currentRows })).toBe(encodedBefore)
  })

  it.each(['current', 'transformed'] as const)('rejects obsolete required tags in V3 input with %s validation and retains ignorable tags', (validation) => {
    const header = deepFreeze({ type: 'session', version: 3, id: 'native-ptc', createdAt: 1, isSeeded: false, delegationDepth: 0 })
    for (const type of ['tool/code-dispatch-start', 'tool/code-dispatch']) {
      const required = deepFreeze({ type, seq: 0, time: 1, data: null })
      const rejected = createSessionFormatCatalogWithChildren([]).createRestore(header, { recovery: 'strict', validation })
      expect(() => { rejected.decodeRow(required) }).toThrow(/unknown event type/)
      const ignorable = deepFreeze({ ...required, ignorable: true, data: { text: 'tools-code-mode', source: { kind: 'plugin', plugin: 'tools-code-mode' } } })
      const accepted = createSessionFormatCatalogWithChildren([]).createRestore(header, { recovery: 'strict', validation })
      accepted.decodeRow(ignorable)
      expect(accepted.finish().events).toEqual([{ ...ignorable, type: `plugin:${type}` }])
    }
  })

  it.each(['current', 'transformed'] as const)('refuses V3 dispatch tag collisions in V2 input with %s validation', (validation) => {
    const header = deepFreeze({ type: 'session', version: 2, id: 'v2-collision', createdAt: 1, isSeeded: false, delegationDepth: 0 })
    for (const type of ['tool/ptc-dispatch-start', 'tool/ptc-dispatch']) {
      for (const ignorable of [false, true]) {
        const restore = createSessionFormatCatalogWithChildren([]).createRestore(header, { recovery: 'strict', validation })
        const row = deepFreeze({ type, seq: 0, time: 1, data: null, ...(ignorable ? { ignorable: true } : {}) })
        expect(() => { restore.decodeRow(row) }).toThrow(/format v2.*ptc-dispatch/)
      }
    }
  })

  it.each(['current', 'transformed'] as const)('renames V2-owned ignorable dispatch tags with %s validation', (validation) => {
    const header = deepFreeze({ type: 'session', version: 2, id: 'v2-owned', createdAt: 1, isSeeded: false, delegationDepth: 0 })
    const data = { rootCallId: 'root', parentCallId: 'root', subCallId: 'child', name: 'read', arguments: {} }
    const rows = deepFreeze([
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
      { type: 'tool/code-dispatch-start', seq: 1, time: 2, data, ignorable: true },
      { type: 'tool/code-dispatch', seq: 2, time: 3, data: { ...data, isError: false, content: [] }, ignorable: true },
    ])
    const restore = createSessionFormatCatalogWithChildren([]).createRestore(header, { recovery: 'strict', validation })
    for (const row of rows) restore.decodeRow(row)
    expect(restore.finish().events).toEqual([
      rows[0], { ...rows[1], type: 'tool/ptc-dispatch-start' }, { ...rows[2], type: 'tool/ptc-dispatch' },
    ])
  })

  it.each(['current', 'transformed'] as const)('refuses a v3 delivery marker in v2 input (%s)', (validation) => {
    const header = { type: 'session', version: 2, id: 'future-delivery', createdAt: 1, isSeeded: false, delegationDepth: 0 }
    const restore = createSessionFormatCatalogWithChildren([]).createRestore(header, { recovery: 'strict', validation })
    restore.decodeRow({ type: 'feedback/record', seq: 0, time: 1, data: { text: 'unaccepted' } })
    expect(() => {
      restore.decodeRow({ type: 'session-log-deepseek/delivery-accepted', seq: 1, time: 2,
        data: { sessionId: header.id, throughSeq: 0, sessionFormatVersion: 3 } })
      restore.finish()
    }).toThrow(/format v2 delivery marker claims target format v3/)
  })

  it('finishes a streaming migration with the target header and dense rows', () => {
    const stream = createSessionFormatCatalogWithChildren([]).createRestore({
      type: 'session', version: 1, id: 'streaming', createdAt: 1, delegationDepth: 0,
    }, { recovery: 'strict', validation: 'current' })
    stream.decodeRow({ type: 'feedback/record', seq: 0, time: 2, data: { text: 'retained' } })

    expect(stream.finish()).toMatchObject({
      header: { version: 4, id: 'streaming' },
      inheritedEventCount: 0,
      events: [{ type: 'feedback/record', seq: 0 }],
    })
  })
})

describe('historical child prerequisite catalog', () => {
  it('uses the V3 event vocabulary for ignorable events whose names become known later', () => {
    const header = { type: 'session', version: 3, id: 'old-extension', createdAt: 1, isSeeded: false, delegationDepth: 0 }
    const rows = [
      { type: 'feedback/record', seq: 0, time: 1, data: { text: 'saved' } },
      { type: 'developer/message', seq: 1, time: 2, ignorable: true, surfaceOp: 'append', sourceEventSeqs: [0],
        data: { content: [{ type: 'tool-result', toolCallId: 'opaque', content: [] }], vendor: true } },
    ]
    const historical = historicalSessionFormatCatalog.createRestore(header, { recovery: 'strict', validation: 'current' })
    for (const row of rows) historical.decodeRow(row)
    expect(historical.finish().events).toEqual(rows)
    const current = createSessionFormatCatalogWithChildren([]).createRestore(header, { recovery: 'strict', validation: 'current' })
    for (const row of rows) current.decodeRow(row)
    expect(current.finish().events).toEqual([rows[0], { ...rows[1], type: 'plugin:developer/message' }])
  })

  it('restores V3 and preceding versions without the incoming catalog-completion edge', () => {
    const header = { type: 'session', version: 2, id: 'historical', createdAt: 1, isSeeded: false, delegationDepth: 0 }
    expect(historicalSessionFormatCatalog.readHeader(header)).toMatchObject({ status: 'migration-required' })
    for (const validation of ['current', 'transformed'] as const) {
      const restored = historicalSessionFormatCatalog.createRestore(header, { recovery: 'strict', validation }).finish()
      expect(restored.header.version).toBe(3)
      expect(historicalSessionFormatCatalog.createRestore({ ...header, version: 3 }, { recovery: 'strict', validation }).finish()).toEqual(restored)
    }
  })
})
