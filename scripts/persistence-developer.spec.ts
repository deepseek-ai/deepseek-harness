/** Developer field classification matches native admission and metadata preservation. */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { Session, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import type { SessionFormatEvent } from '@deepseek-ai/dsh-session-format'
import { sessionFormatCatalog } from '@deepseek-ai/dsh-session-format-catalog'
import { canonicalizeSchema, schemaDigest } from './persistence-schema-model.ts'
import { classifyPersistenceChange, parsePersistenceSnapshot } from './persistence-changes.ts'

function toolAdditionSchema() {
  const inventory = parsePersistenceSnapshot(JSON.parse(readFileSync(new URL('../docs/persistence-schema.json', import.meta.url), 'utf8')) as unknown)
  const before = inventory.roots.find(root => root.key === 'event:developer/message')!
  const nodes = [...structuredClone(before.schema.nodes)]
  const blockIndex = nodes.findIndex(node => node.kind === 'object' && node.properties.some((property) => {
    const type = nodes[property.type]
    return property.name === 'type' && type?.kind === 'literal' && type.value === 'tool-addition'
  }))
  const block = nodes[blockIndex]!
  if (block.kind !== 'object') throw new Error('missing tool-addition schema')
  const stringIndex = nodes.findIndex(node => node.kind === 'primitive' && node.type === 'string')
  return { before, nodes, blockIndex, block, stringIndex }
}

describe('developer field compatibility', () => {
  it('requires a version bump before a future declaration can use the rejected inline tool field', () => {
    const { before, nodes, blockIndex, block, stringIndex } = toolAdditionSchema()
    nodes[blockIndex] = { ...block, properties: [
      ...block.properties.filter(property => property.name !== 'tool'),
      { name: 'tool', type: stringIndex, optional: true },
    ] }
    const schema = canonicalizeSchema(nodes, 0)
    expect(classifyPersistenceChange(before, { ...before, schema, digest: schemaDigest(schema) }))
      .toContainEqual(expect.objectContaining({ requiresVersionBump: true }))
    const reserved = block.properties.find(property => property.name === 'tool')
    expect(reserved).toMatchObject({ optional: true })
    expect(before.schema.nodes[reserved!.type]).toEqual({ kind: 'primitive', type: 'never' })
    const event: SessionFormatEvent = { type: 'developer/message', seq: 3, time: 4, surfaceOp: 'append', data: {
      turn: 1, step: 1, headerSeq: 2, message: { id: 'legacy-inline', role: 'developer', source: { kind: 'tool-registry' },
        content: [{ type: 'tool-addition', toolName: 'search', tool: 'optional metadata' }],
      },
    } }
    expect(() => sessionFormatCatalog.encodeCurrentEvent(event)).toThrow('omit inline tool definitions')
  })

  it('accepts and preserves a tool-addition field classified as optional', () => {
    const { before, nodes, blockIndex, block, stringIndex } = toolAdditionSchema()
    nodes[blockIndex] = { ...block, properties: [...block.properties, { name: 'traceId', type: stringIndex, optional: true }] }
    const schema = canonicalizeSchema(nodes, 0)
    expect(classifyPersistenceChange(before, { ...before, schema, digest: schemaDigest(schema) })).toMatchObject([{ kind: 'optional-property-added', requiresVersionBump: false }])
    const header = { version: 4, id: 'optional-developer-field', createdAt: 1, isSeeded: false, delegationDepth: 0 }
    const message = { id: 'developer', role: 'developer', source: { kind: 'tool-registry', extra: true },
      content: [{ type: 'tool-addition', toolName: 'search', traceId: 'retained' }], extra: true }
    const events: SessionFormatEvent[] = [
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
      { type: 'step/start', seq: 1, time: 2, data: { turn: 1, step: 1 } },
      { type: 'request/header', seq: 2, time: 3, data: { reason: 'initial', header: { config: { provider: 'test', model: 'test' }, tools: [{ name: 'search', description: 'Search', parameters: {} }] } } },
      { type: 'developer/message', seq: 3, time: 4, surfaceOp: 'append', data: { turn: 1, step: 1, headerSeq: 2, message, extra: true } },
    ]
    const reader = sessionFormatCatalog.createRestore(sessionFormatCatalog.encodeCurrentHeader(header, 0), { recovery: 'strict', validation: 'current' })
    for (const event of events) reader.decodeRow(sessionFormatCatalog.encodeCurrentEvent(event))
    const artifact = reader.finish()
    expect(artifact.events).toEqual(events)
    const restored = Session.fromRestore(SessionId(header.id), artifact.events as SessionEvent[],
      artifact.header as unknown as SessionHeader, SessionLogOffset(0), 'detached')
    expect(restored.deriveMessages()).toEqual([message])
  })
})
