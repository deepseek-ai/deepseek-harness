import { describe, expect, it } from 'vitest'
import { canonicalizeSchema, isArbitraryJsonSchema, schemaDigest, type SchemaNode } from './persistence-schema-model.ts'

const string: SchemaNode = { kind: 'primitive', type: 'string' }
const number: SchemaNode = { kind: 'primitive', type: 'number' }

describe('canonical persisted type graphs', () => {
  it('ignores source ordering and shared versus duplicated subtypes', () => {
    const left: SchemaNode[] = [
      { kind: 'object', properties: [{ name: 'b', type: 1, optional: false }, { name: 'a', type: 1, optional: true }], indices: [] }, string,
    ]
    const right: SchemaNode[] = [
      string, string,
      { kind: 'object', properties: [{ name: 'a', type: 0, optional: true }, { name: 'b', type: 1, optional: false }], indices: [] },
    ]
    expect(canonicalizeSchema(left, 0)).toEqual(canonicalizeSchema(right, 2))
  })

  it('minimizes differently factored recursive aliases to the same graph', () => {
    const self: SchemaNode[] = [
      { kind: 'object', properties: [{ name: 'next', type: 0, optional: true }, { name: 'value', type: 1, optional: false }], indices: [] }, string,
    ]
    const mutual: SchemaNode[] = [
      { kind: 'object', properties: [{ name: 'value', type: 2, optional: false }, { name: 'next', type: 1, optional: true }], indices: [] },
      { kind: 'object', properties: [{ name: 'next', type: 0, optional: true }, { name: 'value', type: 3, optional: false }], indices: [] }, string, string,
    ]
    const normalized = canonicalizeSchema(self, 0)
    expect(canonicalizeSchema(mutual, 0)).toEqual(normalized)
    expect(canonicalizeSchema(normalized.nodes, 0)).toEqual(normalized)
    mutual[3] = number
    expect(schemaDigest(canonicalizeSchema(mutual, 0))).not.toBe(schemaDigest(normalized))
  })

  it('flattens reordered unions and removes structurally equal alternatives', () => {
    const flat: SchemaNode[] = [{ kind: 'union', types: [1, 2] }, string, number]
    const factored: SchemaNode[] = [string, number, { kind: 'union', types: [0, 3] }, { kind: 'union', types: [1, 0] }]
    expect(canonicalizeSchema(flat, 0)).toEqual(canonicalizeSchema(factored, 2))
    expect(canonicalizeSchema([{ kind: 'union', types: [1, 2] }, string, string], 0)).toEqual(canonicalizeSchema([string], 0))
    expect(canonicalizeSchema([{ kind: 'union', types: [1, 2] }, { kind: 'literal', value: true }, { kind: 'literal', value: false }], 0))
      .toEqual(canonicalizeSchema([{ kind: 'primitive', type: 'boolean' }], 0))
  })

  it('ignores recursive union, field, index signature and graph numbering order together', () => {
    const original: SchemaNode[] = [
      { kind: 'union', types: [1, 2, 3] },
      { kind: 'object', properties: [{ name: 'label', type: 5, optional: false }, { name: 'next', type: 0, optional: true }], indices: [] },
      { kind: 'array', element: 0 },
      { kind: 'object', properties: [], indices: [{ key: 5, value: 0 }, { key: 4, value: 1 }] },
      number,
      string,
    ]
    const reordered: SchemaNode[] = [
      string,
      { kind: 'object', properties: [], indices: [{ key: 3, value: 5 }, { key: 0, value: 4 }] },
      { kind: 'array', element: 4 },
      number,
      { kind: 'union', types: [1, 2, 5] },
      { kind: 'object', properties: [{ name: 'next', type: 4, optional: true }, { name: 'label', type: 0, optional: false }], indices: [] },
    ]
    expect(canonicalizeSchema(reordered, 4)).toEqual(canonicalizeSchema(original, 0))
  })

  it('preserves tuple positions, element absence, and rest elements', () => {
    const baseline: SchemaNode[] = [{ kind: 'tuple', elements: [{ type: 1, optional: false, rest: false }, { type: 2, optional: true, rest: false }] }, string, number]
    const reversed: SchemaNode[] = [{ kind: 'tuple', elements: [{ type: 2, optional: false, rest: false }, { type: 1, optional: true, rest: false }] }, string, number]
    const rest: SchemaNode[] = [{ kind: 'tuple', elements: [{ type: 1, optional: false, rest: false }, { type: 2, optional: false, rest: true }] }, string, number]
    const digest = schemaDigest(canonicalizeSchema(baseline, 0))
    expect(schemaDigest(canonicalizeSchema(reversed, 0))).not.toBe(digest)
    expect(schemaDigest(canonicalizeSchema(rest, 0))).not.toBe(digest)
  })

  it('recognizes arbitrary recursive JSON structurally and retains its definition', () => {
    const json: SchemaNode[] = [
      { kind: 'union', types: [1, 2, 3, 4, 5, 6] },
      { kind: 'primitive', type: 'null' }, { kind: 'primitive', type: 'boolean' }, number, string,
      { kind: 'array', element: 0 }, { kind: 'object', properties: [], indices: [{ key: 4, value: 0 }] },
    ]
    const schema = canonicalizeSchema(json, 0)
    expect(isArbitraryJsonSchema(schema)).toBe(true)
    expect(schema.nodes.some(node => node.kind === 'array' && node.element === 0)).toBe(true)
    json[0] = { kind: 'union', types: [1, 2, 3, 4, 5] }
    expect(isArbitraryJsonSchema(canonicalizeSchema(json, 0))).toBe(false)
  })

  it('rejects missing references and unproductive union cycles', () => {
    expect(() => canonicalizeSchema([{ kind: 'array', element: 5 }], 0)).toThrow('missing node 5')
    expect(() => canonicalizeSchema([{ kind: 'union', types: [0] }], 0)).toThrow('union cycle')
  })
})
