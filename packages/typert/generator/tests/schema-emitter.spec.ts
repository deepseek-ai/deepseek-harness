import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { FaceModelEmitter, TypertEmitError } from '../src/emitter.ts'
import type {
  FaceModel,
  KeywordTypeName,
  MemberModel,
  SignatureMemberModel,
  SignatureModel,
  TypeDeclarationModel,
  TypeNodeModel,
} from '../src/model.ts'

const temporaryRoots: string[] = []
const location = { file: 'fixture.ts', line: 1, column: 1 } as const
const documentation = { tags: [] } as const

const ZOD_NODE_SUPPORT = {
  keyword: 'supported',
  literal: 'supported',
  parenthesized: 'supported',
  reference: 'supported',
  union: 'supported',
  intersection: 'supported',
  array: 'supported',
  tuple: 'supported',
  object: 'supported',
  function: 'unsupported',
  constructor: 'unsupported',
  'indexed-access': 'unsupported',
  operator: 'unsupported',
  conditional: 'unsupported',
  infer: 'unsupported',
  mapped: 'unsupported',
  'template-literal': 'unsupported',
  'type-query': 'unsupported',
  'import-type': 'unsupported',
  predicate: 'unsupported',
  this: 'unsupported',
} as const satisfies Record<TypeNodeModel['kind'], 'supported' | 'unsupported'>

interface SchemaCase {
  readonly name: string
  readonly nodes: readonly TypeNodeModel[]
  readonly accepted: readonly unknown[]
  readonly rejected: readonly unknown[]
}

const supportedCases: readonly SchemaCase[] = [
  keywordCase('any', [undefined], []),
  keywordCase('unknown', [{ arbitrary: true }], []),
  keywordCase('never', [], [undefined]),
  keywordCase('string', ['value'], [1]),
  keywordCase('number', [1], ['1']),
  keywordCase('bigint', [1n], [1]),
  keywordCase('boolean', [true], ['true']),
  keywordCase('symbol', [Symbol('value')], ['symbol']),
  keywordCase('undefined', [undefined], [null]),
  keywordCase('void', [undefined], [null]),
  keywordCase('object', [{ value: true }, [], () => undefined], [null, 1]),
  {
    name: 'literal',
    nodes: [{ id: 'root', kind: 'literal', value: 'ready', text: "'ready'" }],
    accepted: ['ready'],
    rejected: ['waiting'],
  },
  {
    name: 'numeric literal',
    nodes: [{ id: 'root', kind: 'literal', value: -2, text: '-2' }],
    accepted: [-2],
    rejected: [2],
  },
  {
    name: 'bigint literal',
    nodes: [{ id: 'root', kind: 'literal', value: -2n, text: '-2n' }],
    accepted: [-2n],
    rejected: [-2],
  },
  {
    name: 'boolean literal',
    nodes: [{ id: 'root', kind: 'literal', value: false, text: 'false' }],
    accepted: [false],
    rejected: [true],
  },
  {
    name: 'null literal',
    nodes: [{ id: 'root', kind: 'literal', value: null, text: 'null' }],
    accepted: [null],
    rejected: [undefined],
  },
  {
    name: 'no-substitution template literal',
    nodes: [{ id: 'root', kind: 'literal', value: 'fixed', text: '`fixed`' }],
    accepted: ['fixed'],
    rejected: ['other'],
  },
  {
    name: 'parenthesized',
    nodes: [
      { id: 'root', kind: 'parenthesized', type: 'child' },
      keyword('child', 'string'),
    ],
    accepted: ['value'],
    rejected: [1],
  },
  {
    name: 'standard reference',
    nodes: [{
      id: 'root',
      kind: 'reference',
      name: 'Date',
      target: { kind: 'standard', name: 'Date' },
      arguments: [],
    }],
    accepted: [new Date(0)],
    rejected: ['1970-01-01'],
  },
  {
    name: 'standard Array reference',
    nodes: [
      { id: 'root', kind: 'reference', name: 'Array', target: { kind: 'standard', name: 'Array' }, arguments: ['element'] },
      keyword('element', 'string'),
    ],
    accepted: [['value']],
    rejected: [[1]],
  },
  {
    name: 'standard ReadonlyArray reference',
    nodes: [
      {
        id: 'root',
        kind: 'reference',
        name: 'ReadonlyArray',
        target: { kind: 'standard', name: 'ReadonlyArray' },
        arguments: ['element'],
      },
      keyword('element', 'number'),
    ],
    accepted: [[1]],
    rejected: [['1']],
  },
  {
    name: 'standard Record reference',
    nodes: [
      {
        id: 'root',
        kind: 'reference',
        name: 'Record',
        target: { kind: 'standard', name: 'Record' },
        arguments: ['key', 'value'],
      },
      keyword('key', 'string'),
      keyword('value', 'number'),
    ],
    accepted: [{ one: 1 }],
    rejected: [{ one: '1' }],
  },
  {
    name: 'union',
    nodes: [
      { id: 'root', kind: 'union', types: ['left', 'right'] },
      keyword('left', 'string'),
      keyword('right', 'number'),
    ],
    accepted: ['value', 1],
    rejected: [true],
  },
  {
    name: 'empty union',
    nodes: [{ id: 'root', kind: 'union', types: [] }],
    accepted: [],
    rejected: [undefined],
  },
  {
    name: 'single union',
    nodes: [
      { id: 'root', kind: 'union', types: ['child'] },
      keyword('child', 'string'),
    ],
    accepted: ['value'],
    rejected: [1],
  },
  {
    name: 'intersection',
    nodes: [
      { id: 'root', kind: 'intersection', types: ['left', 'right'] },
      { id: 'left', kind: 'object', members: [property('name', 'string')] },
      { id: 'right', kind: 'object', members: [property('count', 'number')] },
      keyword('string', 'string'),
      keyword('number', 'number'),
    ],
    accepted: [{ name: 'value', count: 1 }],
    rejected: [{ name: 'value' }],
  },
  {
    name: 'empty intersection',
    nodes: [{ id: 'root', kind: 'intersection', types: [] }],
    accepted: [undefined, { value: true }],
    rejected: [],
  },
  {
    name: 'array',
    nodes: [
      { id: 'root', kind: 'array', element: 'element' },
      keyword('element', 'string'),
    ],
    accepted: [['one', 'two']],
    rejected: [['one', 2]],
  },
  {
    name: 'tuple with optional and rest elements',
    nodes: [
      {
        id: 'root',
        kind: 'tuple',
        elements: [
          { name: 'head', type: 'string', optional: false, rest: false },
          { name: 'count', type: 'number', optional: true, rest: false },
          { name: 'tail', type: 'rest-array', optional: false, rest: true },
        ],
      },
      keyword('string', 'string'),
      keyword('number', 'number'),
      { id: 'rest-array', kind: 'array', element: 'boolean' },
      keyword('boolean', 'boolean'),
    ],
    accepted: [['value'], ['value', 1, true, false]],
    rejected: [[1], ['value', 1, 'false']],
  },
  {
    name: 'fixed tuple',
    nodes: [
      {
        id: 'root',
        kind: 'tuple',
        elements: [{ type: 'string', optional: false, rest: false }],
      },
      keyword('string', 'string'),
    ],
    accepted: [['value']],
    rejected: [[], [1]],
  },
  {
    name: 'tuple with standard reference rest',
    nodes: [
      {
        id: 'root',
        kind: 'tuple',
        elements: [{ type: 'rest', optional: false, rest: true }],
      },
      {
        id: 'rest',
        kind: 'reference',
        name: 'ReadonlyArray',
        target: { kind: 'standard', name: 'ReadonlyArray' },
        arguments: ['string'],
      },
      keyword('string', 'string'),
    ],
    accepted: [[], ['value']],
    rejected: [[1]],
  },
  {
    name: 'object',
    nodes: [
      {
        id: 'root',
        kind: 'object',
        members: [
          property('name', 'string', { readonly: true }),
          property('count', 'number', { optional: true }),
        ],
      },
      keyword('string', 'string'),
      keyword('number', 'number'),
    ],
    accepted: [{ name: 'value' }, { name: 'value', count: 1 }],
    rejected: [{ name: 1 }],
  },
]

const unsupportedNodeCases: readonly { readonly kind: TypeNodeModel['kind']; readonly nodes: readonly TypeNodeModel[] }[] = [
  { kind: 'function', nodes: [{ id: 'root', kind: 'function', signature: signature('child') }, keyword('child', 'string')] },
  { kind: 'constructor', nodes: [{ id: 'root', kind: 'constructor', abstract: false, signature: signature('child') }, keyword('child', 'string')] },
  { kind: 'indexed-access', nodes: [{ id: 'root', kind: 'indexed-access', object: 'child', index: 'child' }, keyword('child', 'string')] },
  { kind: 'operator', nodes: [{ id: 'root', kind: 'operator', operator: 'keyof', type: 'child' }, keyword('child', 'string')] },
  {
    kind: 'conditional',
    nodes: [{ id: 'root', kind: 'conditional', check: 'child', extends: 'child', whenTrue: 'child', whenFalse: 'child' }, keyword('child', 'string')],
  },
  { kind: 'infer', nodes: [{ id: 'root', kind: 'infer', parameter: { id: 'parameter', name: 'Value', const: false } }] },
  {
    kind: 'mapped',
    nodes: [{
      id: 'root',
      kind: 'mapped',
      parameter: { id: 'parameter', name: 'Key', const: false, constraint: 'child' },
      value: 'child',
      readonly: 'preserve',
      optional: 'preserve',
    }, keyword('child', 'string')],
  },
  {
    kind: 'template-literal',
    nodes: [{ id: 'root', kind: 'template-literal', head: 'prefix-', spans: [{ type: 'child', text: '' }] }, keyword('child', 'string')],
  },
  { kind: 'type-query', nodes: [{ id: 'root', kind: 'type-query', expression: 'value', arguments: [] }] },
  { kind: 'import-type', nodes: [{ id: 'root', kind: 'import-type', module: 'external', arguments: [], typeof: false }] },
  { kind: 'predicate', nodes: [{ id: 'root', kind: 'predicate', asserts: false, parameter: 'value', type: 'child' }, keyword('child', 'string')] },
  { kind: 'this', nodes: [{ id: 'root', kind: 'this' }] },
]

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('SchemaEmitter supported projection matrix', () => {
  it.each(supportedCases)('$name', async ({ nodes, accepted, rejected }) => {
    const schema = await loadSchema(emit(nodes))
    for (const value of accepted) expect(schema.safeParse(value).success).toBe(true)
    for (const value of rejected) expect(schema.safeParse(value).success).toBe(false)
  })

  it('supports recursive declarations and inherited object shapes', async () => {
    const recursive = declaration('Root', 'interface', {
      members: [
        property('value', 'string'),
        property('next', 'self', { optional: true }),
      ],
    })
    const recursiveSchema = await loadSchema(emit([
      keyword('string', 'string'),
      {
        id: 'self',
        kind: 'reference',
        name: 'Root',
        target: { kind: 'declaration', symbol: 'Root' },
        arguments: [],
      },
    ], recursive))
    expect(recursiveSchema.safeParse({ value: 'one', next: { value: 'two' } }).success).toBe(true)
    expect(recursiveSchema.safeParse({ value: 'one', next: { value: 2 } }).success).toBe(false)

    const inherited = declaration('Root', 'interface', {
      extends: ['base-reference'],
      members: [property('current', 'number')],
    })
    const base = declaration('Base', 'interface', { members: [property('base', 'string')] })
    const inheritedSchema = await loadSchema(emit([
      { id: 'base-reference', kind: 'reference', name: 'Base', target: { kind: 'declaration', symbol: 'Base' }, arguments: [] },
      keyword('string', 'string'),
      keyword('number', 'number'),
    ], inherited, [base]))
    expect(inheritedSchema.safeParse({ base: 'value', current: 1 }).success).toBe(true)
    expect(inheritedSchema.safeParse({ current: 1 }).success).toBe(false)
  })

  it('instantiates generic aliases, nested references, defaults, and recursive declarations', async () => {
    const box = declaration('Box', 'interface', {
      typeParameters: [{ id: 'box:value', name: 'Value', const: false }],
      members: [property('value', 'box:value-reference')],
    })
    const wrapper = declaration('Wrapper', 'alias', {
      typeParameters: [
        { id: 'wrapper:value', name: 'Value', const: false },
        { id: 'wrapper:items', name: 'Items', const: false, default: 'wrapper:default-items' },
      ],
      type: 'wrapper:box-reference',
    })
    const recursive = declaration('Recursive', 'interface', {
      typeParameters: [{ id: 'recursive:value', name: 'Value', const: false }],
      members: [
        property('value', 'recursive:value-reference'),
        property('next', 'recursive:self-reference', { optional: true }),
      ],
    })
    const schema = await loadSchema(emit([
      {
        id: 'root',
        kind: 'object',
        members: [
          property('wrapped', 'root:wrapper-reference'),
          property('recursive', 'root:recursive-reference'),
        ],
      },
      {
        id: 'root:wrapper-reference',
        kind: 'reference',
        name: 'Wrapper',
        target: { kind: 'declaration', symbol: 'Wrapper' },
        arguments: ['string'],
      },
      {
        id: 'root:recursive-reference',
        kind: 'reference',
        name: 'Recursive',
        target: { kind: 'declaration', symbol: 'Recursive' },
        arguments: ['number'],
      },
      {
        id: 'wrapper:box-reference',
        kind: 'reference',
        name: 'Box',
        target: { kind: 'declaration', symbol: 'Box' },
        arguments: ['wrapper:items-reference'],
      },
      {
        id: 'wrapper:default-items',
        kind: 'reference',
        name: 'ReadonlyArray',
        target: { kind: 'standard', name: 'ReadonlyArray' },
        arguments: ['wrapper:value-reference'],
      },
      {
        id: 'wrapper:value-reference',
        kind: 'reference',
        name: 'Value',
        target: { kind: 'type-parameter', parameter: 'wrapper:value' },
        arguments: [],
      },
      {
        id: 'wrapper:items-reference',
        kind: 'reference',
        name: 'Items',
        target: { kind: 'type-parameter', parameter: 'wrapper:items' },
        arguments: [],
      },
      {
        id: 'box:value-reference',
        kind: 'reference',
        name: 'Value',
        target: { kind: 'type-parameter', parameter: 'box:value' },
        arguments: [],
      },
      {
        id: 'recursive:value-reference',
        kind: 'reference',
        name: 'Value',
        target: { kind: 'type-parameter', parameter: 'recursive:value' },
        arguments: [],
      },
      {
        id: 'recursive:self-reference',
        kind: 'reference',
        name: 'Recursive',
        target: { kind: 'declaration', symbol: 'Recursive' },
        arguments: ['recursive:value-reference'],
      },
      keyword('string', 'string'),
      keyword('number', 'number'),
    ], undefined, [box, wrapper, recursive]))

    expect(schema.safeParse({
      wrapped: { value: ['one', 'two'] },
      recursive: { value: 1, next: { value: 2 } },
    }).success).toBe(true)
    expect(schema.safeParse({
      wrapped: { value: [1] },
      recursive: { value: 1 },
    }).success).toBe(false)
    expect(schema.safeParse({
      wrapped: { value: ['one'] },
      recursive: { value: 'one' },
    }).success).toBe(false)
  })

  it('erases unique-symbol nominal members without naming a branding utility', async () => {
    const nominal = declaration('Nominal', 'alias', {
      typeParameters: [{ id: 'nominal:brand', name: 'Brand', const: false }],
      type: 'nominal:intersection',
    })
    const symbolMember = {
      ...property('[TOKEN]', 'nominal:brand-reference', { readonly: true }),
      computed: 'symbol',
    } as const
    const schema = await loadSchema(emit([
      {
        id: 'root',
        kind: 'reference',
        name: 'Nominal',
        target: { kind: 'declaration', symbol: 'Nominal' },
        arguments: ['brand'],
      },
      { id: 'brand', kind: 'literal', value: 'Fixture', text: "'Fixture'" },
      { id: 'nominal:intersection', kind: 'intersection', types: ['string', 'nominal:marker'] },
      keyword('string', 'string'),
      { id: 'nominal:marker', kind: 'object', members: [symbolMember] },
      {
        id: 'nominal:brand-reference',
        kind: 'reference',
        name: 'Brand',
        target: { kind: 'type-parameter', parameter: 'nominal:brand' },
        arguments: [],
      },
    ], undefined, [nominal]))

    expect(schema.safeParse('fixture-id').success).toBe(true)
    expect(schema.safeParse(1).success).toBe(false)
  })

  it('erases a unique-symbol numeric brand to its wire number', async () => {
    const nominal = declaration('NominalNumber', 'alias', {
      typeParameters: [{ id: 'nominal-number:brand', name: 'Brand', const: false }],
      type: 'nominal-number:intersection',
    })
    const symbolMember = {
      ...property('[TOKEN]', 'nominal-number:brand-reference', { readonly: true }),
      computed: 'symbol',
    } as const
    const schema = await loadSchema(emit([
      {
        id: 'root',
        kind: 'reference',
        name: 'NominalNumber',
        target: { kind: 'declaration', symbol: 'NominalNumber' },
        arguments: ['brand'],
      },
      { id: 'brand', kind: 'literal', value: 'Fixture', text: "'Fixture'" },
      { id: 'nominal-number:intersection', kind: 'intersection', types: ['number', 'nominal-number:marker'] },
      keyword('number', 'number'),
      { id: 'nominal-number:marker', kind: 'object', members: [symbolMember] },
      {
        id: 'nominal-number:brand-reference',
        kind: 'reference',
        name: 'Brand',
        target: { kind: 'type-parameter', parameter: 'nominal-number:brand' },
        arguments: [],
      },
    ], undefined, [nominal]))

    expect(schema.safeParse(7).success).toBe(true)
    expect(schema.safeParse('7').success).toBe(false)
  })

  it('classifies every TypeNode kind and executes every supported kind', () => {
    const expected = Object.entries(ZOD_NODE_SUPPORT)
      .filter(([, support]) => support === 'supported')
      .map(([kind]) => kind)
      .sort()
    expect(distinct(supportedCases.map(candidate => candidate.nodes[0]?.kind ?? 'missing'))).toEqual(expected)
  })
})

describe('SchemaEmitter unsupported projection matrix', () => {
  it.each(unsupportedNodeCases)('rejects $kind nodes explicitly', ({ kind, nodes }) => {
    expect(() => emit(nodes)).toThrow(new TypertEmitError(
      `typert Zod emitter: root: type node ${kind} has no Zod projection`,
    ))
  })

  it.each([
    ['cross-face', { kind: 'cross-face', face: 'client', package: '@fixture/client', subpath: '.', name: 'Value' }],
    ['external', { kind: 'external', module: 'external', subpath: '.', name: 'Value' }],
  ] as const)('rejects %s references explicitly', (kind, target) => {
    expect(() => emit([{
      id: 'root',
      kind: 'reference',
      name: 'Value',
      target,
      arguments: [],
    }])).toThrow(`typert Zod emitter: Value: ${kind} reference has no Zod projection`)
  })

  it('rejects unbound type parameters, incomplete generic applications, and generic schema exports', () => {
    expect(() => emit([{
      id: 'root',
      kind: 'reference',
      name: 'Value',
      target: { kind: 'type-parameter', parameter: 'parameter' },
      arguments: [],
    }])).toThrow('type parameter has no schema substitution')

    const generic = declaration('Generic', 'interface', {
      typeParameters: [{ id: 'parameter', name: 'Value', const: false }],
    })
    expect(() => emit([{
      id: 'root',
      kind: 'reference',
      name: 'Generic',
      target: { kind: 'declaration', symbol: 'Generic' },
      arguments: [],
    }], undefined, [generic])).toThrow('missing type argument Value')

    const genericRoot = declaration('Root', 'interface', {
      typeParameters: [{ id: 'root:parameter', name: 'Value', const: false }],
    })
    expect(() => emit([], genericRoot)).toThrow('generic schema exports require a concrete declaration')
  })

  it('rejects unsupported standard references and enums', () => {
    const intrinsic = { id: 'root', kind: 'keyword', name: 'intrinsic' } as unknown as TypeNodeModel
    expect(() => emit([intrinsic]))
      .toThrow('keyword intrinsic has no Zod projection')

    expect(() => emit([{
      id: 'root',
      kind: 'reference',
      name: 'Promise',
      target: { kind: 'standard', name: 'Promise' },
      arguments: [],
    }])).toThrow('standard type Promise has no Zod projection')

    const enumeration = declaration('Enumeration', 'enum', {
      enumMembers: [{ ...documentation, name: 'Value', initializer: "'value'", location }],
    })
    expect(() => emit([{
      id: 'root',
      kind: 'reference',
      name: 'Enumeration',
      target: { kind: 'declaration', symbol: 'Enumeration' },
      arguments: [],
    }], undefined, [enumeration])).toThrow('enum declarations have no Zod projection')
  })

  it('rejects incomplete collection references and invalid tuple rest types', () => {
    expect(() => emit([{
      id: 'root',
      kind: 'reference',
      name: 'Array',
      target: { kind: 'standard', name: 'Array' },
      arguments: [],
    }])).toThrow('array reference has no element type')

    expect(() => emit([{
      id: 'root',
      kind: 'reference',
      name: 'Record',
      target: { kind: 'standard', name: 'Record' },
      arguments: [keyword('key', 'string').id],
    }, keyword('key', 'string')])).toThrow('Record requires key and value types')

    expect(() => emit([
      { id: 'root', kind: 'tuple', elements: [{ type: 'rest', optional: false, rest: true }] },
      {
        id: 'rest',
        kind: 'reference',
        name: 'Array',
        target: { kind: 'standard', name: 'Array' },
        arguments: [],
      },
    ])).toThrow('tuple rest array has no element type')

    expect(() => emit([
      { id: 'root', kind: 'tuple', elements: [{ type: 'rest', optional: false, rest: true }] },
      keyword('rest', 'string'),
    ])).toThrow('tuple rest element must retain an array type')
  })

  it('rejects incomplete schema roots and non-function event signatures', () => {
    const incompleteAlias = declaration('Root', 'alias')
    expect(() => emit([], incompleteAlias)).toThrow('alias has no modeled type')

    const missingSymbolFace = schemaFace([keyword('root', 'string')], 'missing')
    expect(() => new FaceModelEmitter(missingSymbolFace).emit('@fixture/schema'))
      .toThrow('referenced declaration is outside the selected schema closure')

    const eventFace: FaceModel = {
      ...schemaFace([], 'Root', []),
      graph: { declarations: [], nodes: [keyword('event', 'string')] },
      packages: [{
        name: '@fixture/schema',
        root: '.',
        exports: [],
        services: [],
        events: [{
          ...documentation,
          name: 'fixture/event',
          signature: 'event',
          text: "'fixture/event'(): string",
          location,
        }],
        objects: [],
        schemas: [],
        invocations: [],
      }],
    }
    expect(() => new FaceModelEmitter(eventFace).emit('@fixture/schema'))
      .toThrow('event fixture/event is not a function type')
    expect(() => new FaceModelEmitter(eventFace).emit('@fixture/missing'))
      .toThrow('package @fixture/missing is not modeled')
  })

  it('emits undocumented events without an optional mode', () => {
    const returns = keyword('returns', 'void')
    const event: TypeNodeModel = {
      id: 'event',
      kind: 'function',
      signature: { typeParameters: [], parameters: [], returns: 'returns' },
    }
    const face: FaceModel = {
      face: 'host',
      graph: { declarations: [], nodes: [returns, event] },
      packages: [{
        name: '@fixture/events',
        root: '.',
        exports: [],
        services: [],
        events: [{
          ...documentation,
          name: 'fixture/event',
          signature: 'event',
          text: "'fixture/event'(): void",
          location,
        }],
        objects: [],
        schemas: [],
        invocations: [],
      }],
    }

    const artifact = new FaceModelEmitter(face).emit('@fixture/events')
    expect(artifact.js).toContain('"name": "fixture/event"')
    expect(artifact.js).not.toContain('"mode"')
  })

  it('skips non-instance data members and emits collision-safe schema identifiers', async () => {
    const hiddenMembers = declaration('Root', 'interface', {
      members: [
        { ...property('static', 'string'), static: true },
        { ...property('private', 'string'), visibility: 'private' },
      ],
    })
    const hiddenSchema = await loadSchema(emit([keyword('string', 'string')], hiddenMembers))
    expect(hiddenSchema.safeParse({ arbitrary: true }).success).toBe(true)

    const first = { ...declaration('first', 'interface'), name: 'Same' }
    const second = { ...declaration('second', 'interface'), name: 'Same' }
    const face = schemaFace([
      { id: 'first-reference', kind: 'reference', name: 'Same', target: { kind: 'declaration', symbol: 'first' }, arguments: [] },
      { id: 'second-reference', kind: 'reference', name: 'Same', target: { kind: 'declaration', symbol: 'second' }, arguments: [] },
    ], 'first', [first, second])
    const packageModel = face.packages[0]
    if (packageModel === undefined) throw new Error('schema face has no package')
    const collisionFace: FaceModel = {
      ...face,
      packages: [{
        ...packageModel,
        schemas: [
          { ...documentation, export: { subpath: '.', name: '1 bad', symbol: 'first', aliases: ['1 bad'] }, symbol: 'first', type: 'first-reference' },
          { ...documentation, export: { subpath: './secondary', name: 'Same', symbol: 'second', aliases: ['Same'] }, symbol: 'second', type: 'second-reference' },
        ],
      }],
    }
    const artifact = new FaceModelEmitter(collisionFace).emit('@fixture/schema')
    expect(artifact.js).toContain('const Same$schema2 =')
    expect(artifact.js).toContain('export const _1_bad = Same$schema')
    expect(artifact.dts).toContain("from '@fixture/schema/secondary'")
  })

  it('emits JSON index signatures as record schemas', async () => {
    const root = declaration('Root', 'interface', {
      members: [indexMember('key', 'value')],
    })
    const schema = await loadSchema(emit([
      keyword('key', 'string'),
      keyword('value', 'number'),
    ], root))

    expect(schema.safeParse({ one: 1, two: 2 }).success).toBe(true)
    expect(schema.safeParse({ one: '1' }).success).toBe(false)
  })

  it('rejects more than one JSON index signature', () => {
    const root = declaration('Root', 'interface', {
      members: [indexMember('key', 'value'), indexMember('other-key', 'other-value')],
    })

    expect(() => emit([
      keyword('key', 'string'),
      keyword('value', 'number'),
      keyword('other-key', 'string'),
      keyword('other-value', 'boolean'),
    ], root)).toThrow('object type has more than one JSON index signature')
  })

  it.each(['method', 'getter', 'setter', 'call', 'construct'] as const)(
    'rejects %s members on data-schema objects',
    (kind) => {
      expect(() => emit([
        { id: 'root', kind: 'object', members: [signatureMember(kind)] },
        keyword('child', 'string'),
      ])).toThrow(`${kind} member member is not data-schema projectable`)
    },
  )

  it('classifies and rejects every unsupported TypeNode kind', () => {
    const expected = Object.entries(ZOD_NODE_SUPPORT)
      .filter(([, support]) => support === 'unsupported')
      .map(([kind]) => kind)
      .sort()
    expect(distinct(unsupportedNodeCases.map(candidate => candidate.kind))).toEqual(expected)
  })
})

function keywordCase(name: KeywordTypeName, accepted: readonly unknown[], rejected: readonly unknown[]): SchemaCase {
  return { name: `keyword ${name}`, nodes: [keyword('root', name)], accepted, rejected }
}

function keyword(id: string, name: KeywordTypeName): TypeNodeModel {
  return { id, kind: 'keyword', name }
}

function signature(returns: string): SignatureModel {
  return { typeParameters: [], parameters: [], returns }
}

function property(
  name: string,
  type: string,
  options: { readonly optional?: boolean; readonly readonly?: boolean } = {},
): MemberModel {
  return {
    ...documentation,
    id: `member:${name}`,
    kind: 'property',
    name,
    type,
    optional: options.optional ?? false,
    readonly: options.readonly ?? false,
    async: false,
    abstract: false,
    static: false,
    visibility: 'public',
    location,
    text: `${name}: unknown`,
  }
}

function signatureMember(kind: 'index'): SignatureMemberModel
function signatureMember(
  kind: Exclude<MemberModel['kind'], 'property' | 'index'>,
): MemberModel
function signatureMember(kind: Exclude<MemberModel['kind'], 'property'>): MemberModel {
  return {
    ...documentation,
    id: `member:${kind}`,
    kind,
    name: 'member',
    signature: signature('child'),
    optional: false,
    readonly: false,
    async: false,
    abstract: false,
    static: false,
    visibility: 'public',
    location,
    text: `${kind} member`,
  }
}

function indexMember(key: string, value: string): SignatureMemberModel {
  return {
    ...signatureMember('index'),
    signature: {
      typeParameters: [],
      parameters: [{
        name: 'key',
        binding: 'identifier',
        type: key,
        optional: false,
        rest: false,
        receiver: false,
      }],
      returns: value,
    },
  }
}

function declaration(
  name: string,
  kind: TypeDeclarationModel['kind'],
  options: Partial<Pick<
    TypeDeclarationModel,
    'abstract' | 'typeParameters' | 'extends' | 'implements' | 'members' | 'type' | 'enumMembers'
  >> = {},
): TypeDeclarationModel {
  return {
    ...documentation,
    id: name,
    package: '@fixture/schema',
    name,
    kind,
    abstract: options.abstract ?? false,
    exported: true,
    location,
    text: `export ${kind === 'alias' ? 'type' : kind} ${name}`,
    typeParameters: options.typeParameters ?? [],
    extends: options.extends ?? [],
    implements: options.implements ?? [],
    members: options.members ?? [],
    ...(options.type === undefined ? {} : { type: options.type }),
    ...(options.enumMembers === undefined ? {} : { enumMembers: options.enumMembers }),
  }
}

function emit(
  nodes: readonly TypeNodeModel[],
  rootDeclaration = declaration('Root', 'alias', { type: 'root' }),
  dependencies: readonly TypeDeclarationModel[] = [],
): string {
  const schemaReference: TypeNodeModel = {
    id: 'schema-reference',
    kind: 'reference',
    name: 'Root',
    target: { kind: 'declaration', symbol: 'Root' },
    arguments: [],
  }
  const face: FaceModel = {
    face: 'host',
    graph: {
      declarations: [rootDeclaration, ...dependencies],
      nodes: [schemaReference, ...nodes],
    },
    packages: [{
      name: '@fixture/schema',
      root: '.',
      exports: [{ subpath: '.', name: 'Root', symbol: 'Root', aliases: ['Root'] }],
      services: [],
      events: [],
      objects: [],
      schemas: [{
        ...documentation,
        export: { subpath: '.', name: 'Root', symbol: 'Root', aliases: ['Root'] },
        symbol: 'Root',
        type: 'schema-reference',
      }],
      invocations: [],
    }],
  }
  return new FaceModelEmitter(face).emit('@fixture/schema').js
}

function schemaFace(
  nodes: readonly TypeNodeModel[],
  symbol: string,
  declarations: readonly TypeDeclarationModel[] = [declaration('Root', 'alias', { type: 'root' })],
): FaceModel {
  return {
    face: 'host',
    graph: { declarations, nodes },
    packages: [{
      name: '@fixture/schema',
      root: '.',
      exports: [{ subpath: '.', name: 'Root', symbol, aliases: ['Root'] }],
      services: [],
      events: [],
      objects: [],
      schemas: [{
        ...documentation,
        export: { subpath: '.', name: 'Root', symbol, aliases: ['Root'] },
        symbol,
        type: 'root',
      }],
      invocations: [],
    }],
  }
}

async function loadSchema(source: string): Promise<{ safeParse(value: unknown): { success: boolean } }> {
  const root = mkdtempSync(join(import.meta.dirname, '.generated-schema-'))
  temporaryRoots.push(root)
  const path = join(root, 'schema.mjs')
  writeFileSync(path, source)
  const generated = await import(`${pathToFileURL(path).href}?test=${Date.now()}-${String(temporaryRoots.length)}`) as {
    Root: { safeParse(value: unknown): { success: boolean } }
  }
  return generated.Root
}

function distinct(values: readonly string[]): string[] {
  return [...new Set(values)].sort()
}
