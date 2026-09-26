/** The generated request-header schema retains the native reader's retired-field refusal. */
import { resolve } from 'node:path'
import { expect, it } from 'vitest'
import { assertV4RowAdmission } from '@deepseek-ai/dsh-session-format-v3-to-v4'
import { extractPersistenceSchema } from './persistence-schema.ts'
import { classifyPersistenceChange } from './persistence-changes.ts'
import { canonicalizeSchema, schemaDigest } from './persistence-schema-model.ts'
import type { SchemaNode } from './persistence-schema-model.ts'

function property(nodes: readonly SchemaNode[], index: number, name: string): number {
  const node = nodes[index]
  if (node?.kind !== 'object') throw new Error(`expected an object containing ${name}`)
  const field = node.properties.find(candidate => candidate.name === name)
  if (field === undefined) throw new Error(`generated schema omits ${name}`)
  return field.type
}

it('requires a version bump before request headers can carry retired system text', { timeout: 60_000 }, () => {
  const inventory = extractPersistenceSchema(resolve(import.meta.dirname, '..'))
  const before = inventory.roots.find(root => root.key === 'event:request/header')
  if (before === undefined) throw new Error('generated schema omits request/header')
  const nodes = [...before.schema.nodes]
  const dataIndex = property(nodes, before.schema.root, 'data')
  const headerIndex = property(nodes, dataIndex, 'header')
  const header = nodes[headerIndex]
  if (header?.kind !== 'object') throw new Error('generated header schema is not an object')
  const reserved = header.properties.find(field => field.name === 'system')
  expect(reserved).toMatchObject({ optional: true })
  if (reserved === undefined) throw new Error('generated header omits the retired system reservation')
  expect(nodes[reserved.type]).toEqual({ kind: 'primitive', type: 'never' })

  const stringIndex = nodes.length
  nodes.push({ kind: 'primitive', type: 'string' })
  nodes[headerIndex] = {
    ...header,
    properties: header.properties.map(field => field.name === 'system' ? { ...field, type: stringIndex } : field),
  }
  const schema = canonicalizeSchema(nodes, before.schema.root)
  const after = { ...before, schema, digest: schemaDigest(schema) }
  expect(classifyPersistenceChange(before, after)).toEqual([{
    path: 'event:request/header.data.header.system',
    kind: 'type-changed',
    description: 'type changed',
    requiresVersionBump: true,
  }])
  expect(() => { assertV4RowAdmission({ type: 'request/header', data: { header: { system: 'retired text' } } }) })
    .toThrow('format v4 request/header rejects retired header.system')
})
