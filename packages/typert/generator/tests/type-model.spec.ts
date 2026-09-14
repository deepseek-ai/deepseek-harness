import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'
import { afterEach, describe, expect, it } from 'vitest'
import { TypertAnalysisError, WorkspaceAnalyzer } from '../src/analyzer.ts'
import { FaceModelEmitter } from '../src/emitter.ts'
import type {
  KeywordTypeName,
  MemberModel,
  TypeDeclarationModel,
  TypeNodeModel,
  TypeOperatorName,
  TypeTargetModel,
} from '../src/model.ts'
import { TypeGraphRenderer } from '../src/renderer.ts'
import { WorkspaceTypertGenerator } from '../src/workspace.ts'

const fixtureRoot = resolve(import.meta.dirname, 'fixtures/type-model')
const temporaryRoots: string[] = []

function normalizedPath(path: string): string {
  return path.replaceAll('\\', '/')
}

const parseConfigHost: ts.ParseConfigFileHost = {
  ...ts.sys,
  onUnRecoverableConfigFileDiagnostic(diagnostic) {
    throw new Error(formatDiagnostic(diagnostic))
  },
}

const TYPE_NODE_KINDS = {
  keyword: true,
  literal: true,
  parenthesized: true,
  reference: true,
  union: true,
  intersection: true,
  array: true,
  tuple: true,
  object: true,
  function: true,
  constructor: true,
  'indexed-access': true,
  operator: true,
  conditional: true,
  infer: true,
  mapped: true,
  'template-literal': true,
  'type-query': true,
  'import-type': true,
  predicate: true,
  this: true,
} as const satisfies Record<TypeNodeModel['kind'], true>

const TYPE_TARGET_KINDS = {
  declaration: true,
  'type-parameter': true,
  'cross-face': true,
  external: true,
  standard: true,
} as const satisfies Record<TypeTargetModel['kind'], true>

const KEYWORD_TYPE_NAMES = {
  any: true,
  bigint: true,
  boolean: true,
  never: true,
  number: true,
  object: true,
  string: true,
  symbol: true,
  undefined: true,
  unknown: true,
  void: true,
} as const satisfies Record<KeywordTypeName, true>

const TYPE_OPERATOR_NAMES = {
  keyof: true,
  readonly: true,
  unique: true,
} as const satisfies Record<TypeOperatorName, true>

const DECLARATION_KINDS = {
  interface: true,
  class: true,
  alias: true,
  enum: true,
} as const satisfies Record<TypeDeclarationModel['kind'], true>

const MEMBER_KINDS = {
  property: true,
  method: true,
  getter: true,
  setter: true,
  call: true,
  construct: true,
  index: true,
} as const satisfies Record<MemberModel['kind'], true>

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('WorkspaceAnalyzer', { timeout: 60_000 }, () => {
  it('builds independent face models with an explicit cross-face type graph', () => {
    const model = new WorkspaceAnalyzer({ root: fixtureRoot }).analyze()

    expect(model.faces.map(face => face.face)).toEqual(['host', 'client'])
    expect(model.crossFaceLinks).toContainEqual({
      fromFace: 'client',
      fromPackage: '@fixture/client',
      toFace: 'host',
      toPackage: '@fixture/host',
      subpath: '.',
      name: 'Agent',
    })
    expect(model.crossFaceLinks).toContainEqual({
      fromFace: 'client',
      fromPackage: '@fixture/client',
      toFace: 'host',
      toPackage: '@fixture/host',
      subpath: '.',
      name: 'HostAgent',
    })
    expect(model.crossFaceLinks).toContainEqual({
      fromFace: 'client',
      fromPackage: '@fixture/client',
      toFace: 'host',
      toPackage: '@fixture/host',
      subpath: '.',
      name: 'Box',
    })
    const clientPackage = model.faces.find(face => face.face === 'client')?.packages[0]
    expect(clientPackage).toMatchObject({ objects: [], schemas: [] })
    expect(clientPackage?.exports).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'ReexportedBox', aliases: ['ReexportedBox', 'Box'] }),
      expect.objectContaining({ name: 'ReexportedZodType', aliases: ['ReexportedZodType', 'ZodType'] }),
    ]))
    const host = model.faces.find(face => face.face === 'host')
    expect(host?.graph.nodes).toContainEqual(expect.objectContaining({
      kind: 'conditional',
    }))
    expect(host?.graph.nodes).toContainEqual(expect.objectContaining({
      kind: 'mapped',
    }))
    expect(host?.graph.nodes.some(node => node.kind === 'reference'
      && node.target.kind === 'external'
      && node.target.module === 'zod'
      && node.target.name === 'ZodType')).toBe(true)
    expect(host?.graph.nodes.some(node => node.kind === 'reference'
      && node.target.kind === 'external'
      && node.target.module === '@types/node'
      && node.target.name === 'Process')).toBe(true)
    const agent = host?.graph.declarations.find(declaration => declaration.name === 'Agent')
    expect(agent?.implements).toHaveLength(1)
    expect(agent).toMatchObject({
      exported: true,
      location: { file: 'packages/host/src/index.ts' },
    })
    expect(agent?.text).toContain('export class Agent<State extends object = {')
    expect(agent?.members.map(member => member.name)).toEqual(['id', 'state', 'label', 'label', 'run'])
    const service = host?.packages[0]?.services.find(candidate => candidate.key === 'demo')
    const members = new Map(host?.graph.declarations
      .flatMap(declaration => declaration.members)
      .map(member => [member.id, member.name]))
    expect(service?.members.map(member => members.get(member))).toEqual([
      'inspect',
      'acceptsExternal',
      'setPhase',
      'inspectSyntax',
      'inspectAsync',
      'destructure',
    ])
    expect(service?.location).toMatchObject({ file: 'packages/host/src/index.ts' })
    const inspect = host?.graph.declarations
      .flatMap(declaration => declaration.members)
      .find(member => member.name === 'inspect')
    expect(inspect?.text).toBe(
      'inspect(agent: Agent<{ ready: true }>, flags: Flags<Payload>): Present<Payload>',
    )
    expect(host?.packages[0]?.services.filter(candidate => candidate.key === 'demo')).toHaveLength(1)
    expect(host?.packages[0]?.events.filter(candidate => candidate.name === 'demo/ready')).toHaveLength(1)
    expect(host?.packages[0]?.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'demo/unmodeled' }),
      expect.objectContaining({ name: 'demo/serial-property', mode: 'serial' }),
    ]))
    expect(host?.packages[0]?.events.find(candidate => candidate.name === 'demo/unmodeled'))
      .not.toHaveProperty('mode')
    expect(host?.packages[0]?.events.find(candidate => candidate.name === 'demo/ready')).toMatchObject({
      location: { file: 'packages/host/src/index.ts' },
      text: "'demo/ready'(agent: Agent<{ ready: true }>, payload: Box<Payload>): void",
    })
    expect(model).toMatchSnapshot()
  })

  it('merges bounded package programs into the same face model', () => {
    const options = {
      root: fixtureRoot,
      packages: ['@fixture/host', '@fixture/client'],
    } as const
    const direct = new WorkspaceAnalyzer(options).analyze()
    const batched = new WorkspaceAnalyzer(options).analyzeInBatches(1)

    expect(batched).toEqual(direct)
  })

  it('discovers an explicitly keyed service implementation without a Context merge', () => {
    const root = copyFixture('explicit-service-')
    addExplicitServicePackage(root, 'service detached')
    const analyzer = new WorkspaceAnalyzer({ root })

    expect(analyzer.discoverPackages()).toContainEqual({
      package: '@fixture/explicit-service',
      root: 'packages/explicit-service',
      faces: ['host'],
    })
    const model = new WorkspaceAnalyzer({ root, packages: ['@fixture/explicit-service'] }).analyze()
    const service = model.faces[0]?.packages[0]?.services[0]
    expect(service).toMatchObject({ key: 'detached', export: { name: 'DetachedService' } })
  })

  it('prefers an explicitly keyed implementation over its protocol Context merge', () => {
    const root = copyFixture('explicit-service-protocol-')
    addExplicitServicePackage(root, 'service detached', true)
    const model = new WorkspaceAnalyzer({
      root,
      packages: ['@fixture/explicit-service'],
    }).analyze()
    const service = model.faces[0]?.packages[0]?.services[0]

    expect(service).toMatchObject({
      key: 'detached',
      export: { name: 'DetachedService' },
      location: { file: 'packages/explicit-service/src/index.ts' },
    })
  })

  it('rejects an explicit service implementation without one valid key', () => {
    const missing = copyFixture('explicit-service-missing-')
    addExplicitServicePackage(missing, 'service')
    expect(() => new WorkspaceAnalyzer({
      root: missing,
      packages: ['@fixture/explicit-service'],
    }).analyze()).toThrow('@typert service requires exactly one nonempty Cordis service key')

    const invalid = copyFixture('explicit-service-invalid-')
    addExplicitServicePackage(invalid, 'service bad/key')
    expect(() => new WorkspaceAnalyzer({
      root: invalid,
      packages: ['@fixture/explicit-service'],
    }).analyze()).toThrow('@typert service requires exactly one nonempty Cordis service key')
  })

  it('indexes authored top-level exports without promoting them to graph roots', () => {
    const declarations = new WorkspaceAnalyzer({ root: fixtureRoot }).indexSourceDeclarations()
    const agent = declarations.find(declaration => declaration.name === 'Agent')

    expect(agent).toMatchObject({
      face: 'host',
      package: '@fixture/host',
      name: 'Agent',
      kind: 'class',
    })
    expect(agent?.location).toMatchObject({ file: 'packages/host/src/index.ts' })
    expect(agent?.text).toContain('export class Agent<State extends object = {')
    expect(declarations.some(declaration => declaration.name === 'IgnoredDeclaration')).toBe(false)
  })

  it('covers every modeled discriminant with source-authored fixture syntax', () => {
    const model = new WorkspaceAnalyzer({ root: fixtureRoot }).analyze()
    const nodes = model.faces.flatMap(face => face.graph.nodes)
    const declarations = model.faces.flatMap(face => face.graph.declarations)
    const members = declarations.flatMap(declaration => declaration.members)
    const objectMembers = nodes.flatMap(node => node.kind === 'object' ? node.members : [])
    const allMembers = [...members, ...objectMembers]
    const targets = nodes.flatMap(node => node.kind === 'reference' ? [node.target] : [])

    expect(distinct(nodes.map(node => node.kind))).toEqual(Object.keys(TYPE_NODE_KINDS).sort())
    expect(distinct(targets.map(target => target.kind))).toEqual(Object.keys(TYPE_TARGET_KINDS).sort())
    expect(distinct(nodes.flatMap(node => node.kind === 'keyword' ? [node.name] : [])))
      .toEqual(Object.keys(KEYWORD_TYPE_NAMES).sort())
    expect(distinct(nodes.flatMap(node => node.kind === 'operator' ? [node.operator] : [])))
      .toEqual(Object.keys(TYPE_OPERATOR_NAMES).sort())
    expect(distinct(declarations.map(declaration => declaration.kind))).toEqual(Object.keys(DECLARATION_KINDS).sort())
    expect(distinct(members.map(member => member.kind))).toEqual(Object.keys(MEMBER_KINDS).sort())
    expect(allMembers.some(member => member.optional)).toBe(true)
    expect(allMembers.some(member => member.readonly)).toBe(true)
    expect(allMembers.some(member => member.async)).toBe(true)
    expect(distinct(allMembers.map(member => String(member.abstract)))).toEqual(['false', 'true'])
    expect(allMembers.every(member => !member.static && member.visibility === 'public')).toBe(true)

    const signatures = [
      ...members.flatMap(member => 'signature' in member ? [member.signature] : []),
      ...nodes.flatMap(node => node.kind === 'function' || node.kind === 'constructor' ? [node.signature] : []),
    ]
    const typeParameters = declarations.flatMap(declaration => [
      ...declaration.typeParameters,
      ...declaration.members.flatMap(member => 'signature' in member ? member.signature.typeParameters : []),
      ...signatures.flatMap(signature => signature.typeParameters),
    ])
    expect(distinct(typeParameters.map(parameter => String(parameter.const)))).toEqual(['false', 'true'])
    expect(distinct(typeParameters.flatMap(parameter => parameter.variance === undefined ? [] : [parameter.variance])))
      .toEqual(['in', 'in-out', 'out'])

    const parameters = signatures.flatMap(signature => signature.parameters)
    expect(parameters.some(parameter => parameter.optional)).toBe(true)
    expect(parameters.some(parameter => parameter.rest)).toBe(true)
    expect(parameters.some(parameter => parameter.receiver)).toBe(true)

    const tuples = nodes.filter(node => node.kind === 'tuple')
    expect(tuples.some(tuple => tuple.elements.some(element => element.optional))).toBe(true)
    expect(tuples.some(tuple => tuple.elements.some(element => element.rest))).toBe(true)

    const mapped = nodes.filter(node => node.kind === 'mapped')
    expect(distinct(mapped.map(node => node.readonly))).toEqual(['add', 'preserve', 'remove'])
    expect(distinct(mapped.map(node => node.optional))).toEqual(['add', 'preserve', 'remove'])
    expect(mapped.some(node => node.nameType !== undefined)).toBe(true)
    const genericHeritage = declarations
      .flatMap(declaration => [...declaration.extends, ...declaration.implements])
      .map(id => nodes.find(node => node.id === id))
      .find(node => node?.kind === 'reference' && node.arguments.length > 0)
    expect(genericHeritage).toEqual(expect.objectContaining({
      kind: 'reference',
      name: 'Box',
      arguments: [expect.any(String)],
    }))

    expect(parameters).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: '{ name }', binding: 'object' }),
      expect.objectContaining({ name: '[suffix]', binding: 'array' }),
    ]))
    expect(parameters.some(parameter => parameter.binding === 'identifier')).toBe(true)

    const imports = nodes.filter(node => node.kind === 'import-type')
    expect(distinct(imports.map(node => String(node.typeof)))).toEqual(['false', 'true'])
    expect(imports.some(node => node.qualifier !== undefined && node.arguments.length > 0)).toBe(true)
    expect(imports.some(node => node.qualifier === undefined && node.arguments.length === 0)).toBe(true)
    expect(imports.some(node => node.attributes === "{ with: { 'resolution-mode': 'import' } }")).toBe(true)
    expect(imports.some(node => node.module === '@fixture/host'
      && node.qualifier === 'Agent'
      && node.target?.kind === 'cross-face'
      && node.target.name === 'Agent')).toBe(true)

    const literals = nodes.filter(node => node.kind === 'literal')
    expect(distinct(literals.map(node => node.value === null ? 'null' : typeof node.value)))
      .toEqual(['bigint', 'boolean', 'null', 'number', 'string'])
    expect(literals).toEqual(expect.arrayContaining([
      expect.objectContaining({ value: 1n, text: '1n' }),
      expect.objectContaining({ value: -2n, text: '-2n' }),
      expect.objectContaining({ value: 'fixed', text: '`fixed`' }),
    ]))

    const queries = nodes.filter(node => node.kind === 'type-query')
    expect(distinct(queries.map(node => String(node.arguments.length)))).toEqual(['0', '1'])
    expect(queries).toContainEqual(expect.objectContaining({
      expression: 'genericFactory',
      arguments: [expect.any(String)],
    }))

    const templates = nodes.filter(node => node.kind === 'template-literal')
    expect(templates.some(node => node.spans.length === 2
      && node.spans.map(span => span.text).join('|') === '/to/|/end')).toBe(true)

    const constructors = nodes.filter(node => node.kind === 'constructor')
    expect(distinct(constructors.map(node => String(node.abstract)))).toEqual(['false', 'true'])

    const predicates = nodes.filter(node => node.kind === 'predicate')
    expect(distinct(predicates.map(node => String(node.asserts)))).toEqual(['false', 'true'])
    expect(predicates.some(node => node.type === undefined)).toBe(true)
    expect(predicates.some(node => node.type !== undefined)).toBe(true)
    expect(predicates.some(node => node.parameter === 'this')).toBe(true)

    const enumMembers = declarations.flatMap(declaration => declaration.enumMembers ?? [])
    expect(enumMembers.some(member => member.initializer === undefined)).toBe(true)
    expect(enumMembers.some(member => member.initializer !== undefined)).toBe(true)
  })

  it('retains an omitted mapped value when the owning project permits implicit any', () => {
    const root = copyFixture('typert-implicit-mapped-value-')
    const sourcePath = join(root, 'packages/host/src/index.ts')
    writeFileSync(sourcePath, [
      readFileSync(sourcePath, 'utf8'),
      '/** @typert schema */',
      'export type ImplicitMap<Value> = { [Key in keyof Value] }',
      '',
    ].join('\n'))
    const configPath = join(root, 'packages/host/tsconfig.json')
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as { compilerOptions: Record<string, unknown> }
    config.compilerOptions.noImplicitAny = false
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`)

    const nodes = new WorkspaceAnalyzer({ root }).analyze().faces
      .flatMap(face => face.graph.nodes)
    const mapped = nodes.find(node => node.kind === 'mapped' && node.value === undefined)
    expect(mapped).toEqual(expect.objectContaining({ kind: 'mapped' }))
    expect(mapped).not.toHaveProperty('value')
  })

  it('fails in check mode and writes inferred public annotations in write mode', () => {
    const root = copyFixture('typert-type-model-')
    const options = {
      root,
      hostConfig: 'tsconfig.write.json',
      clientConfig: 'missing.client.json',
      packages: ['@fixture/write'],
    } as const

    expect(() => new WorkspaceAnalyzer({ ...options, mode: 'check' }).analyze())
      .toThrow(TypertAnalysisError)

    const model = new WorkspaceAnalyzer({ ...options, mode: 'write' }).analyze()
    const source = readFileSync(join(root, 'packages/write/src/index.ts'), 'utf8')
    expect(source).toContain('value: number = 1')
    expect(source).toContain("echo(input: string = 'value'): string")
    expect(model.faces[0]?.packages[0]?.services[0]?.key).toBe('writable')
    const echo = model.faces[0]?.graph.declarations
      .flatMap(declaration => declaration.members)
      .find(member => member.name === 'echo')
    if (echo?.kind !== 'method') throw new Error('write fixture has no echo method')
    expect(echo.signature.parameters[0]?.initializer).toBe("'value'")
  })

  it('rejects relative imports across face boundaries', () => {
    const root = copyFixture('typert-relative-face-')
    const sourcePath = join(root, 'packages/client', 'src/index.ts')
    const source = readFileSync(sourcePath, 'utf8')
      .replace("from '@fixture/host'", "from '../../host/src/index.ts'")
    writeFileSync(sourcePath, source)

    expect(() => new WorkspaceAnalyzer({ root }).analyze()).toThrow(
      /crosses a package or face without an explicit import/,
    )
  })

  it('rejects package subpaths absent from package.json exports', () => {
    const root = copyFixture('typert-private-export-')
    writeFileSync(
      join(root, 'packages/host/src/private.ts'),
      'export interface PrivateHost { readonly value: string }\n',
    )
    const sourcePath = join(root, 'packages/client', 'src/index.ts')
    const source = readFileSync(sourcePath, 'utf8')
      .replace(
        "import type { HostAgent, Payload } from '@fixture/host'",
        "import type { HostAgent, Payload } from '@fixture/host'\nimport type { PrivateHost } from '@fixture/host/private'",
      )
      .replace(
        'export class ClientBridge extends Service {',
        'export class ClientBridge extends Service {\n  leak(value: PrivateHost): void { void value }',
      )
    writeFileSync(sourcePath, source)

    expect(() => new WorkspaceAnalyzer({ root }).analyze()).toThrow(
      'cross-face reference PrivateHost is not exported by @fixture/host at ./private',
    )
  })

  it('rejects cross-face re-exports outside package.json exports', () => {
    const root = copyFixture('typert-private-reexport-')
    writeFileSync(
      join(root, 'packages/host/src/private.ts'),
      'export interface PrivateHost { readonly value: string }\n',
    )
    const sourcePath = join(root, 'packages/client', 'src/index.ts')
    writeFileSync(sourcePath, [
      readFileSync(sourcePath, 'utf8'),
      "export type { PrivateHost } from '@fixture/host/private'",
      '',
    ].join('\n'))

    expect(() => new WorkspaceAnalyzer({ root }).analyze()).toThrow(
      'cross-face re-export PrivateHost is not exported by @fixture/host at ./private',
    )
  })

  it('rejects cross-face namespace re-exports until the model has a namespace target', () => {
    const root = copyFixture('typert-namespace-reexport-')
    const sourcePath = join(root, 'packages/client', 'src/index.ts')
    writeFileSync(sourcePath, [
      readFileSync(sourcePath, 'utf8'),
      "export type * as HostNamespace from '@fixture/host'",
      '',
    ].join('\n'))

    expect(() => new WorkspaceAnalyzer({ root }).analyze()).toThrow(
      'cross-face namespace re-exports are not supported',
    )
  })

  it('ignores cross-face namespace exports that are not package exports', () => {
    const root = copyFixture('typert-private-namespace-reexport-')
    writeFileSync(
      join(root, 'packages/client', 'src/internal.ts'),
      "export type * as HiddenHostNamespace from '@fixture/host'\n",
    )
    const sourcePath = join(root, 'packages/client', 'src/index.ts')
    writeFileSync(sourcePath, [
      "import './internal.ts'",
      readFileSync(sourcePath, 'utf8'),
    ].join('\n'))

    expect(new WorkspaceAnalyzer({ root }).analyze().faces
      .find(face => face.face === 'client')?.packages[0]?.services.map(service => service.key))
      .toContain('clientBridge')
  })

  it('records public symbols from explicit cross-face star re-exports', () => {
    const root = copyFixture('typert-star-reexport-')
    const sourcePath = join(root, 'packages/client', 'src/index.ts')
    writeFileSync(
      sourcePath,
      readFileSync(sourcePath, 'utf8')
        .replace("export type { Box as ReexportedBox } from '@fixture/host'", "export type * from '@fixture/host'"),
    )

    const model = new WorkspaceAnalyzer({ root }).analyze()
    expect(model.crossFaceLinks).toContainEqual({
      fromFace: 'client',
      fromPackage: '@fixture/client',
      toFace: 'host',
      toPackage: '@fixture/host',
      subpath: '.',
      name: 'Box',
    })
  })

  it('expands explicit same-face package exports through declaration targets', () => {
    const root = copyFixture('typert-same-face-')
    addSameFacePackage(root, '@fixture/host/models', 'Payload')

    const model = new WorkspaceAnalyzer({ root }).analyze()
    const host = model.faces.find(face => face.face === 'host')
    const payload = host?.graph.declarations.find(declaration => declaration.name === 'Payload')
    expect(host?.packages.map(packageModel => packageModel.name)).toContain('@fixture/consumer')
    expect(host?.graph.nodes.some(node => node.id.includes('packages/consumer/src/index.ts')
      && node.kind === 'reference'
      && node.name === 'Payload'
      && node.target.kind === 'declaration'
      && node.target.symbol === payload?.id)).toBe(true)
  })

  it('resolves explicit same-face package re-exports to their declaration owner', () => {
    const root = copyFixture('typert-same-face-reexport-')
    const packageRoot = join(root, 'packages/barrel')
    mkdirSync(join(packageRoot, 'src'), { recursive: true })
    writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({
      name: '@fixture/barrel',
      private: true,
      type: 'module',
      exports: {
        '.': {
          types: './lib/types/index.d.ts',
          default: './lib/index.js',
        },
      },
    }, null, 2))
    writeFileSync(join(packageRoot, 'tsconfig.json'), JSON.stringify({
      extends: '../../tsconfig.base.json',
      compilerOptions: { rootDir: 'src', outDir: 'lib/types' },
      include: ['src'],
      references: [{ path: '../host' }],
    }, null, 2))
    writeFileSync(
      join(packageRoot, 'src/index.ts'),
      "export type { Payload } from '@fixture/host/models'\n",
    )
    const basePath = join(root, 'tsconfig.base.json')
    const base = JSON.parse(readFileSync(basePath, 'utf8')) as {
      compilerOptions: { paths: Record<string, string[]> }
    }
    base.compilerOptions.paths['@fixture/barrel'] = ['./packages/barrel/src/index.ts']
    writeFileSync(basePath, `${JSON.stringify(base, null, 2)}\n`)
    const aggregatePath = join(root, 'tsconfig.host.json')
    const aggregate = JSON.parse(readFileSync(aggregatePath, 'utf8')) as { references: { path: string }[] }
    aggregate.references.push({ path: './packages/barrel' })
    writeFileSync(aggregatePath, `${JSON.stringify(aggregate, null, 2)}\n`)
    addSameFacePackage(root, '@fixture/barrel', 'Payload')
    const consumerConfigPath = join(root, 'packages/consumer/tsconfig.json')
    const consumerConfig = JSON.parse(readFileSync(consumerConfigPath, 'utf8')) as {
      references: { path: string }[]
    }
    consumerConfig.references.push({ path: '../barrel' })
    writeFileSync(consumerConfigPath, `${JSON.stringify(consumerConfig, null, 2)}\n`)

    const model = new WorkspaceAnalyzer({ root }).analyze()
    const host = model.faces.find(face => face.face === 'host')
    const payload = host?.graph.declarations.find(declaration => declaration.name === 'Payload')
    expect(host?.graph.nodes.some(node => node.id.includes('packages/consumer/src/index.ts')
      && node.kind === 'reference'
      && node.name === 'Payload'
      && node.target.kind === 'declaration'
      && node.target.symbol === payload?.id)).toBe(true)
  })

  it('rejects same-face package imports outside package.json exports', () => {
    const root = copyFixture('typert-private-package-')
    writeFileSync(
      join(root, 'packages/host/src/private.ts'),
      'export interface PrivateHost { readonly value: string }\n',
    )
    addSameFacePackage(root, '@fixture/host/private', 'PrivateHost')

    expect(() => new WorkspaceAnalyzer({ root }).analyze()).toThrow(
      'package reference PrivateHost is not exported by @fixture/host at ./private',
    )
  })

  it('rejects relative imports across same-face package boundaries', () => {
    const root = copyFixture('typert-relative-package-')
    addSameFacePackage(root, '@fixture/host/models', 'Payload')
    const sourcePath = join(root, 'packages/consumer/src/index.ts')
    writeFileSync(
      sourcePath,
      readFileSync(sourcePath, 'utf8')
        .replace("'@fixture/host/models'", "'../../host/src/models.ts'"),
    )

    expect(() => new WorkspaceAnalyzer({ root }).analyze()).toThrow(
      'reference to Payload crosses a package without an explicit package import',
    )
  })

  describe('package-local forwarding modules', () => {
    const hostPayload = '@fixture/host:packages/host/src/models.ts#Payload'

    function consumerPayloadTarget(root: string): TypeTargetModel | undefined {
      const host = new WorkspaceAnalyzer({ root }).analyze().faces.find(face => face.face === 'host')
      const schema = host?.packages.find(candidate => candidate.name === '@fixture/consumer')?.schemas[0]
      const consumer = host?.graph.declarations.find(candidate => candidate.id === schema?.symbol)
      const value = consumer?.kind === 'interface'
        ? consumer.members.find(member => member.name === 'value')
        : undefined
      const node = value?.kind === 'property'
        ? host?.graph.nodes.find(candidate => candidate.id === value.type)
        : undefined
      return node?.kind === 'reference' ? node.target : undefined
    }

    it('follows a named re-export to the original declaration', () => {
      const root = copyFixture('typert-forward-named-')
      addSameFacePackage(root, './forward.ts', 'Payload', {
        'forward.ts': "export type { Payload } from '@fixture/host/models'\n",
      })

      expect(consumerPayloadTarget(root)).toEqual({ kind: 'declaration', symbol: hostPayload })
    })

    it('follows renamed hops through several forwarding modules', () => {
      const root = copyFixture('typert-forward-chain-')
      addSameFacePackage(root, './outer.ts', 'Forwarded', {
        'outer.ts': "export type { Inner as Forwarded } from './inner.ts'\n",
        'inner.ts': "export type { Payload as Inner } from '@fixture/host/models'\n",
      })

      expect(consumerPayloadTarget(root)).toEqual({ kind: 'declaration', symbol: hostPayload })
    })

    it('follows an import re-exported without a module specifier', () => {
      const root = copyFixture('typert-forward-import-export-')
      addSameFacePackage(root, './forward.ts', 'Payload', {
        'forward.ts': "import type { Payload as Imported } from '@fixture/host/models'\nexport type { Imported as Payload }\n",
      })

      expect(consumerPayloadTarget(root)).toEqual({ kind: 'declaration', symbol: hostPayload })
    })

    it('follows a star re-export', () => {
      const root = copyFixture('typert-forward-star-')
      addSameFacePackage(root, './forward.ts', 'Payload', {
        'forward.ts': "export * from '@fixture/host/models'\n",
      })

      expect(consumerPayloadTarget(root)).toEqual({ kind: 'declaration', symbol: hostPayload })
    })

    it('follows a namespace import of the forwarding module', () => {
      const root = copyFixture('typert-forward-namespace-')
      addSameFacePackage(root, '@fixture/host/models', 'Payload', {
        'forward.ts': "export type { Payload } from '@fixture/host/models'\n",
      })
      const sourcePath = join(root, 'packages/consumer/src/index.ts')
      writeFileSync(
        sourcePath,
        readFileSync(sourcePath, 'utf8')
          .replace("import type { Payload } from '@fixture/host/models'", "import type * as Forward from './forward.ts'")
          .replace('readonly value: Payload', 'readonly value: Forward.Payload'),
      )

      expect(consumerPayloadTarget(root)).toEqual({ kind: 'declaration', symbol: hostPayload })
    })

    it('rejects a forwarded type absent from the package export', () => {
      const root = copyFixture('typert-forward-private-')
      writeFileSync(
        join(root, 'packages/host/src/private.ts'),
        'export interface PrivateHost { readonly value: string }\n',
      )
      addSameFacePackage(root, './forward.ts', 'PrivateHost', {
        'forward.ts': "export type { PrivateHost } from '@fixture/host/private'\n",
      })

      expect(() => new WorkspaceAnalyzer({ root }).analyze()).toThrow(
        'package reference PrivateHost is not exported by @fixture/host at ./private',
      )
    })

    it('rejects a forwarding module that reaches another package by relative path', () => {
      const root = copyFixture('typert-forward-relative-')
      addSameFacePackage(root, './forward.ts', 'Payload', {
        'forward.ts': "export type { Payload } from '../../host/src/models.ts'\n",
      })

      expect(() => new WorkspaceAnalyzer({ root }).analyze()).toThrow(
        'reference to Payload crosses a package without an explicit package import',
      )
    })

    it('follows a forwarding module across faces', () => {
      const root = copyFixture('typert-forward-cross-face-')
      writeFileSync(
        join(root, 'packages/client/src/forward.ts'),
        "export type { Payload as ForwardedPayload } from '@fixture/host'\n",
      )
      const sourcePath = join(root, 'packages/client/src/index.ts')
      writeFileSync(
        sourcePath,
        readFileSync(sourcePath, 'utf8')
          .replace(
            "import type { HostAgent, Payload } from '@fixture/host'",
            "import type { HostAgent } from '@fixture/host'\nimport type { ForwardedPayload as Payload } from './forward.ts'",
          ),
      )
      const model = new WorkspaceAnalyzer({ root }).analyze()
      const client = model.faces.find(face => face.face === 'client')
      const payload = client?.graph.nodes.find(candidate =>
        candidate.kind === 'reference' && candidate.name === 'Payload' && candidate.id.includes('packages/client/'))

      expect(payload?.kind === 'reference' ? payload.target : undefined).toEqual({
        kind: 'cross-face',
        face: 'host',
        package: '@fixture/host',
        subpath: '.',
        name: 'Payload',
      })
      expect(model.crossFaceLinks).toContainEqual({
        fromFace: 'client',
        fromPackage: '@fixture/client',
        toFace: 'host',
        toPackage: '@fixture/host',
        subpath: '.',
        name: 'Payload',
      })
    })

    it('prefers an explicit re-export over a star edge that loops back', () => {
      const root = copyFixture('typert-forward-cycle-explicit-')
      addSameFacePackage(root, './outer.ts', 'Payload', {
        'outer.ts': "export * from './inner.ts'\n",
        'inner.ts': "export * from './outer.ts'\nexport type { Payload } from '@fixture/host/models'\n",
      })

      expect(consumerPayloadTarget(root)).toEqual({ kind: 'declaration', symbol: hostPayload })
    })

    it('follows a valid renamed route after another route reaches the same module', () => {
      const root = copyFixture('typert-forward-shared-module-')
      addSameFacePackage(root, './outer.ts', 'Payload', {
        'outer.ts': "export * from './left.ts'\nexport * from './right.ts'\n",
        'left.ts': "export { Left as Payload } from './shared.ts'\n",
        'right.ts': "export { Right as Payload } from './shared.ts'\n",
        'shared.ts': [
          "export { Payload as Left } from './relative.ts'",
          "export type { Payload as Right } from '@fixture/host/models'",
          '',
        ].join('\n'),
        'relative.ts': "export type { Payload } from '../../host/src/models.ts'\n",
      })

      expect(consumerPayloadTarget(root)).toEqual({ kind: 'declaration', symbol: hostPayload })
    })

    it('rejects a forwarding cycle whose only exit crosses a package by relative path', () => {
      const root = copyFixture('typert-forward-cycle-relative-')
      addSameFacePackage(root, './outer.ts', 'Payload', {
        'outer.ts': "export * from './inner.ts'\n",
        'inner.ts': "export * from './outer.ts'\nexport type { Payload } from '../../host/src/models.ts'\n",
      })

      expect(() => new WorkspaceAnalyzer({ root }).analyze()).toThrow(
        'reference to Payload crosses a package without an explicit package import',
      )
    })

    it('rejects a namespace re-export in a forwarding module', () => {
      const root = copyFixture('typert-forward-namespace-export-')
      addSameFacePackage(root, '@fixture/host/models', 'Payload', {
        'forward.ts': "export * as models from '@fixture/host/models'\n",
      })
      const sourcePath = join(root, 'packages/consumer/src/index.ts')
      writeFileSync(
        sourcePath,
        readFileSync(sourcePath, 'utf8')
          .replace("import type { Payload } from '@fixture/host/models'", "import type * as Forward from './forward.ts'")
          .replace('readonly value: Payload', 'readonly value: Forward.models.Payload'),
      )

      expect(() => new WorkspaceAnalyzer({ root }).analyze()).toThrow(
        'reference to Payload crosses a package without an explicit package import',
      )
    })

    it('rejects a forwarding module that exports a namespace import binding', () => {
      const root = copyFixture('typert-forward-namespace-binding-')
      addSameFacePackage(root, '@fixture/host/models', 'Payload', {
        'forward.ts': "import type * as Models from '@fixture/host/models'\nexport type { Models }\n",
      })
      const sourcePath = join(root, 'packages/consumer/src/index.ts')
      writeFileSync(
        sourcePath,
        readFileSync(sourcePath, 'utf8')
          .replace("import type { Payload } from '@fixture/host/models'", "import type { Models } from './forward.ts'")
          .replace('readonly value: Payload', 'readonly value: Models.Payload'),
      )

      expect(() => new WorkspaceAnalyzer({ root }).analyze()).toThrow(
        'reference to Payload crosses a package without an explicit package import',
      )
    })

    it('produces one model regardless of batch size or package order', () => {
      const root = copyFixture('typert-forward-batches-')
      addSameFacePackage(root, './forward.ts', 'Payload', {
        'forward.ts': "export type { Payload } from '@fixture/host/models'\n",
      })
      const packages = ['@fixture/host', '@fixture/client', '@fixture/consumer']
      const direct = new WorkspaceAnalyzer({ root, packages }).analyze()

      expect(new WorkspaceAnalyzer({ root, packages }).analyzeInBatches(1)).toEqual(direct)
      expect(new WorkspaceAnalyzer({ root, packages }).analyzeInBatches(2)).toEqual(direct)
      expect(new WorkspaceAnalyzer({ root, packages: [...packages].reverse() }).analyzeInBatches(2)).toEqual(direct)
    })
  })

  it('rejects TypeScript projects with source diagnostics before modeling them', () => {
    const root = copyFixture('typert-invalid-project-')
    const sourcePath = join(root, 'packages/host/src/index.ts')
    writeFileSync(sourcePath, `${readFileSync(sourcePath, 'utf8')}\nconst invalidFixture: string = 1\n`)

    expect(() => new WorkspaceAnalyzer({ root }).analyze()).toThrow(
      /packages\/host\/src\/index\.ts:\d+:\d+: TypeScript TS2322/,
    )
  })

  it('retains every authored part of a merged interface', () => {
    const root = copyFixture('typert-merged-declaration-')
    const sourcePath = join(root, 'packages/host/src/models.ts')
    writeFileSync(sourcePath, [
      readFileSync(sourcePath, 'utf8'),
      '/** @typert object */',
      'export interface Merged<Value extends Entity = Entity> extends Entity { readonly left: Value }',
      'export interface Merged<Value extends Entity = Entity> { readonly right: Value }',
      '/** @typert object */',
      'export interface MergedInput<in Value> { consume(value: Value): void }',
      'export interface MergedInput<Value> { consumeAgain(value: Value): void }',
      '',
    ].join('\n'))

    const model = new WorkspaceAnalyzer({ root }).analyze()
    const merged = model.faces
      .flatMap(face => face.graph.declarations)
      .find(declaration => declaration.name === 'Merged')
    expect(merged?.members.map(member => member.name)).toEqual(['left', 'right'])
    expect(merged?.parts?.map(part => part.members.length)).toEqual([1, 1])
    expect(merged?.parts?.map(part => part.typeParameters.length)).toEqual([1, 1])
    expect(merged?.parts?.map(part => part.extends.length)).toEqual([1, 0])
    expect(merged?.parts?.map(part => part.package)).toEqual(['@fixture/host', '@fixture/host'])
    const mergedInput = model.faces
      .flatMap(face => face.graph.declarations)
      .find(declaration => declaration.name === 'MergedInput')
    expect(mergedInput?.typeParameters[0]?.variance).toBe('in')
  })

  it('rejects merged declarations that include a part outside the registered face', () => {
    const root = copyFixture('typert-external-merge-')
    writeFileSync(join(root, 'external-augmentation.ts'), [
      'export {}',
      'declare global {',
      '  interface ExternalMerged { readonly augmented?: string }',
      '}',
      '',
    ].join('\n'))
    const modelsPath = join(root, 'packages/host/src/models.ts')
    writeFileSync(modelsPath, [
      readFileSync(modelsPath, 'utf8'),
      'declare global {',
      '  interface ExternalMerged { readonly local?: string }',
      '}',
      'export interface SyntaxZoo { readonly externalMerged: ExternalMerged }',
      '',
    ].join('\n'))
    const sourcePath = join(root, 'packages/host/src/index.ts')
    writeFileSync(sourcePath, [
      readFileSync(sourcePath, 'utf8'),
      "import '../../../external-augmentation.ts'",
    ].join('\n'))

    expect(() => new WorkspaceAnalyzer({ root }).analyze()).toThrow(
      'merged interface ExternalMerged contains a declaration outside this face',
    )
  })

  it('keeps unscoped global npm declarations as true external targets', () => {
    const root = copyFixture('typert-unscoped-external-')
    const externalRoot = join(root, 'node_modules/unscoped-global')
    mkdirSync(externalRoot, { recursive: true })
    writeFileSync(join(externalRoot, 'package.json'), JSON.stringify({
      name: 'unscoped-global',
      version: '1.0.0',
      types: './index.d.ts',
    }))
    writeFileSync(join(externalRoot, 'index.d.ts'), [
      'export {}',
      'declare global { interface UnscopedGlobal { readonly value: string } }',
      '',
    ].join('\n'))
    const packageConfigPath = join(root, 'packages/host/tsconfig.json')
    for (const configPath of [packageConfigPath, join(root, 'tsconfig.host.json')]) {
      const config = JSON.parse(readFileSync(configPath, 'utf8')) as {
        compilerOptions?: Record<string, unknown>
      }
      config.compilerOptions ??= {}
      config.compilerOptions.typeRoots = [
        configPath === packageConfigPath ? '../../node_modules' : './node_modules',
        resolve('node_modules/@types'),
      ]
      config.compilerOptions.types = ['unscoped-global', 'node']
      writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`)
    }
    const modelsPath = join(root, 'packages/host/src/models.ts')
    writeFileSync(modelsPath, [
      readFileSync(modelsPath, 'utf8'),
      'export interface SyntaxZoo { readonly unscopedGlobal: UnscopedGlobal }',
      '',
    ].join('\n'))

    const packageConfig = ts.getParsedCommandLineOfConfigFile(
      join(root, 'packages/host/tsconfig.json'),
      {},
      parseConfigHost,
    ) as ts.ParsedCommandLine
    const aggregateConfig = ts.getParsedCommandLineOfConfigFile(
      join(root, 'tsconfig.host.json'),
      {},
      parseConfigHost,
    ) as ts.ParsedCommandLine
    const diagnosticProgram = ts.createProgram({
      rootNames: packageConfig.fileNames,
      options: aggregateConfig.options,
    })
    expect(diagnosticProgram.getSourceFiles().map(source => normalizedPath(source.fileName)))
      .toContain(normalizedPath(join(externalRoot, 'index.d.ts')))

    const targets = new WorkspaceAnalyzer({ root }).analyze().faces
      .flatMap(face => face.graph.nodes)
      .flatMap(node => node.kind === 'reference' ? [node.target] : [])
    expect(targets).toContainEqual({
      kind: 'external',
      module: 'unscoped-global',
      subpath: '.',
      name: 'UnscopedGlobal',
    })
  })

  it('skips ambient imports without physical module files while walking exported sources', () => {
    const root = copyFixture('typert-ambient-import-')
    const declarationsPath = join(root, 'cordis.d.ts')
    writeFileSync(declarationsPath, [
      readFileSync(declarationsPath, 'utf8'),
      "declare module 'fixture-ambient' {}",
      '',
    ].join('\n'))
    const sourcePath = join(root, 'packages/host/src/index.ts')
    writeFileSync(sourcePath, [
      "import 'fixture-ambient'",
      readFileSync(sourcePath, 'utf8'),
    ].join('\n'))

    expect(new WorkspaceAnalyzer({ root }).analyze().faces
      .find(face => face.face === 'host')?.packages[0]?.services.map(service => service.key))
      .toContain('demo')
  })

  it('rejects declaration merges without a lossless model', () => {
    const root = copyFixture('typert-merged-enum-')
    const sourcePath = join(root, 'packages/host/src/models.ts')
    writeFileSync(sourcePath, [
      readFileSync(sourcePath, 'utf8'),
      '/** @typert schema */',
      "export enum MergedEnum { Left = 'left' }",
      "export enum MergedEnum { Right = 'right' }",
      '',
    ].join('\n'))

    expect(() => new WorkspaceAnalyzer({ root }).analyze()).toThrow(
      'merged EnumDeclaration declaration MergedEnum is not supported',
    )
  })

  it('rejects merged interfaces with conflicting authored variance', () => {
    const root = copyFixture('typert-merged-variance-')
    const sourcePath = join(root, 'packages/host/src/models.ts')
    writeFileSync(sourcePath, [
      readFileSync(sourcePath, 'utf8'),
      '/** @typert object */',
      'export interface MergedVariance<in Value> { consume(value: Value): void }',
      'export interface MergedVariance<out Value> { produce(): Value }',
      '',
    ].join('\n'))

    expect(() => new WorkspaceAnalyzer({ root }).analyze()).toThrow(
      'merged interface MergedVariance has incompatible variance modifiers',
    )
  })

  it('handles empty selections and rejects malformed aggregate configs', () => {
    const empty = mkdtempSync(join(import.meta.dirname, '.typert-empty-workspace-'))
    temporaryRoots.push(empty)
    expect(new WorkspaceAnalyzer({ root: empty }).analyze()).toEqual({ faces: [], crossFaceLinks: [] })

    writeFileSync(join(empty, 'empty.d.ts'), 'export {}\n')
    writeFileSync(join(empty, 'tsconfig.host.json'), '{ "files": ["empty.d.ts"] }\n')
    expect(new WorkspaceAnalyzer({ root: empty }).analyze()).toEqual({ faces: [], crossFaceLinks: [] })

    writeFileSync(join(empty, 'tsconfig.host.json'), '{ invalid json')
    expect(() => new WorkspaceAnalyzer({ root: empty }).analyze()).toThrow(TypertAnalysisError)

    writeFileSync(join(empty, 'tsconfig.host.json'), JSON.stringify({ compilerOptions: { target: 'invalid' } }))
    expect(() => new WorkspaceAnalyzer({ root: empty }).analyze()).toThrow(TypertAnalysisError)

    expect(new WorkspaceAnalyzer({ root: fixtureRoot, packages: ['@fixture/absent'] }).analyze())
      .toEqual({ faces: [], crossFaceLinks: [] })
  })

  it('ignores empty Cordis augmentations during package discovery', () => {
    const root = copyFixture('typert-empty-augmentation-')
    const hostRoot = join(root, 'packages/host')
    const manifestPath = join(hostRoot, 'package.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
    manifest.exports = {
      '.': { types: './lib/types/index.d.ts', default: './lib/index.js' },
      './typert': { types: './lib/typert.host.d.ts', default: './lib/typert.host.js' },
    }
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    writeFileSync(join(hostRoot, 'src/index.ts'), [
      'export {}',
      "declare module '@deepseek-ai/cordis' {",
      '  interface Context {}',
      '  interface Events {}',
      '  interface Ignored {}',
      '}',
      '',
    ].join('\n'))

    expect(new WorkspaceAnalyzer({ root }).discoverPackages().map(item => item.package))
      .not.toContain('@fixture/host')
  })

  it('ignores aggregate references that are not named workspace packages', () => {
    const root = copyFixture('typert-registration-filter-')
    mkdirSync(join(root, 'outside'), { recursive: true })
    writeFileSync(join(root, 'outside/tsconfig.json'), '{}\n')
    mkdirSync(join(root, 'packages/no-manifest'), { recursive: true })
    writeFileSync(join(root, 'packages/no-manifest/tsconfig.json'), '{}\n')
    mkdirSync(join(root, 'packages/no-name'), { recursive: true })
    writeFileSync(join(root, 'packages/no-name/tsconfig.json'), '{}\n')
    writeFileSync(join(root, 'packages/no-name/package.json'), '{}\n')
    const aggregatePath = join(root, 'tsconfig.host.json')
    const aggregate = JSON.parse(readFileSync(aggregatePath, 'utf8')) as { references: { path: string }[] }
    aggregate.references.push(
      { path: './outside' },
      { path: './packages/no-manifest' },
      { path: './packages/no-name/tsconfig.json' },
    )
    writeFileSync(aggregatePath, `${JSON.stringify(aggregate, null, 2)}\n`)

    const model = new WorkspaceAnalyzer({ root }).analyze()
    expect(model.faces.find(face => face.face === 'host')?.packages.map(item => item.name))
      .toEqual(['@fixture/host'])
  })

  it('keeps both runtime faces for an ordinary dsh.client project', () => {
    const root = copyFixture('typert-dual-runtime-')
    configureDualRuntimeClient(root, false)

    expect(new WorkspaceAnalyzer({ root }).discoverPackages()).toContainEqual({
      package: '@fixture/client',
      root: 'packages/client',
      faces: ['client', 'host'],
    })
  })

  it('confines explicit face projects to their selected Typert face', () => {
    const root = copyFixture('typert-split-project-')
    configureDualRuntimeClient(root, true)

    const markers = new WorkspaceAnalyzer({ root }).indexSourceDeclarations()
      .filter(declaration => declaration.package === '@fixture/client'
        && declaration.name.endsWith('OnlyMarker'))
      .map(declaration => ({ face: declaration.face, name: declaration.name }))
    expect(markers).toEqual([
      { face: 'client', name: 'ClientOnlyMarker' },
      { face: 'host', name: 'HostOnlyMarker' },
    ])
  })

  it('accepts package export forms while skipping artifact-only rows and unexported packages', { timeout: 180_000 }, () => {
    const root = copyFixture('typert-export-forms-')
    const hostRoot = join(root, 'packages/host')
    writeFileSync(join(hostRoot, 'src/runtime.ts'), 'export interface RuntimeOnly { value: string }\n')
    writeFileSync(join(hostRoot, 'src/direct.ts'), 'export interface Direct { value: string }\n')
    writeFileSync(join(hostRoot, 'src/empty.ts'), '\n')
    const manifestPath = join(hostRoot, 'package.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
    manifest.exports = {
      '.': { types: './lib/types/index.d.ts', default: './lib/index.js' },
      './models': { types: './lib/types/models.d.ts', default: './lib/models.js' },
      './array': [null, { browser: './lib/runtime.js' }],
      './fallback': { browser: null, development: './lib/runtime.js' },
      './direct': './src/direct.ts',
      './empty': { types: './lib/types/empty.d.ts' },
      './none': [null, false],
      './empty-conditions': {},
      './package.json': './package.json',
      './typert': './lib/typert.host.js',
      './client/typert': './lib/typert.client.js',
      './wildcard': './lib/*.js',
      './data': './lib/data.json',
      ignored: './lib/index.js',
    }
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

    const model = new WorkspaceAnalyzer({ root }).analyze()
    const exports = model.faces.find(face => face.face === 'host')?.packages[0]?.exports ?? []
    expect(exports.some(item => item.subpath === './array' && item.name === 'RuntimeOnly')).toBe(true)
    expect(exports.some(item => item.subpath === './fallback' && item.name === 'RuntimeOnly')).toBe(true)
    expect(exports.some(item => item.subpath === './direct' && item.name === 'Direct')).toBe(true)
    expect(exports.some(item => item.subpath === './empty')).toBe(false)

    manifest.exports = './lib/index.js'
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    expect(new WorkspaceAnalyzer({ root }).analyze().faces[0]?.packages[0]?.exports.length).toBeGreaterThan(0)

    manifest.exports = { types: './lib/types/index.d.ts', default: './lib/index.js' }
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    expect(new WorkspaceAnalyzer({ root }).analyze().faces[0]?.packages[0]?.exports.length).toBeGreaterThan(0)

    manifest.exports = [null, './lib/index.js']
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    expect(new WorkspaceAnalyzer({ root }).analyze().faces[0]?.packages[0]?.exports.length).toBeGreaterThan(0)

    manifest.exports = {}
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    expect(new WorkspaceAnalyzer({ root, packages: ['@fixture/host'] }).analyze().faces.flatMap(face => face.packages))
      .toEqual([])

    delete manifest.exports
    manifest.types = './lib/types/index.d.ts'
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    expect(new WorkspaceAnalyzer({ root }).analyze().faces[0]?.packages[0]?.exports.length).toBeGreaterThan(0)

    delete manifest.types
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    expect(new WorkspaceAnalyzer({ root, packages: ['@fixture/host'] }).analyze().faces.flatMap(face => face.packages))
      .toEqual([])
  })

  it('rejects package exports whose source entry is missing', () => {
    const root = copyFixture('typert-missing-export-source-')
    const manifestPath = join(root, 'packages/host/package.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
    manifest.exports = { '.': './lib/missing.js' }
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

    expect(() => new WorkspaceAnalyzer({ root, packages: ['@fixture/host'] }).analyze())
      .toThrow('resolves to missing source')
  })

  it('recognizes all supported typert annotation spellings', () => {
    const root = copyFixture('typert-annotation-modes-')
    const sourcePath = join(root, 'packages/host/src/models.ts')
    writeFileSync(sourcePath, [
      readFileSync(sourcePath, 'utf8'),
      '/** @typert */',
      'export interface DefaultSchema { value: string }',
      '/** @typert type */',
      'export interface TypeSchema { value: string }',
      '/** @typert ignored */',
      'export interface IgnoredSchema { value: string }',
      '',
    ].join('\n'))

    const host = new WorkspaceAnalyzer({ root }).analyze().faces.find(face => face.face === 'host')
    expect(host?.packages[0]?.schemas.map(schema => schema.export.name))
      .toEqual(expect.arrayContaining(['DefaultSchema', 'Payload', 'TypeSchema']))
    expect(host?.packages[0]?.schemas.map(schema => schema.export.name)).not.toContain('IgnoredSchema')
  })

  it('rejects an exported Context service that is not a class or interface', () => {
    const root = copyFixture('typert-invalid-service-')
    const sourcePath = join(root, 'packages/host/src/index.ts')
    const source = readFileSync(sourcePath, 'utf8')
      .replace(
        "export { AgentPhase } from './models.ts'",
        "export { AgentPhase } from './models.ts'\nexport type InvalidService = { value: string }",
      )
      .replace('    demo: DemoService', '    demo: DemoService\n    invalidService: InvalidService')
    writeFileSync(sourcePath, source)

    expect(() => new WorkspaceAnalyzer({ root }).analyze())
      .toThrow('does not resolve to an exported class or interface')
  })

  it('rejects tagged anonymous declarations that cannot be named losslessly', () => {
    const root = copyFixture('typert-anonymous-declaration-')
    const sourcePath = join(root, 'packages/host/src/models.ts')
    writeFileSync(sourcePath, [
      readFileSync(sourcePath, 'utf8'),
      '/** @typert object */',
      'export default class { readonly value: string = "value" }',
      '',
    ].join('\n'))

    expect(() => new WorkspaceAnalyzer({ root }).analyze()).toThrow(
      'anonymous ClassDeclaration cannot be represented as a named type declaration',
    )
  })

  it('retains merged generic interfaces without constraints or defaults', () => {
    const root = copyFixture('typert-plain-merged-interface-')
    const sourcePath = join(root, 'packages/host/src/models.ts')
    writeFileSync(sourcePath, [
      readFileSync(sourcePath, 'utf8'),
      '/** @typert object */',
      'export interface PlainMerged<Value> { left: Value }',
      'export interface PlainMerged<Value> { right: Value }',
      '',
    ].join('\n'))

    const declaration = new WorkspaceAnalyzer({ root }).analyze().faces
      .flatMap(face => face.graph.declarations)
      .find(item => item.name === 'PlainMerged')
    expect(declaration?.typeParameters).toEqual([
      expect.objectContaining({ name: 'Value', const: false }),
    ])
    expect(declaration?.typeParameters[0]).not.toHaveProperty('constraint')
    expect(declaration?.typeParameters[0]).not.toHaveProperty('default')
  })
})

describe('TypeGraphRenderer', { timeout: 60_000 }, () => {
  it('retains every source-authored SyntaxZoo property type through rendering', () => {
    const host = new WorkspaceAnalyzer({ root: fixtureRoot }).analyze().faces
      .find(face => face.face === 'host')
    if (host === undefined) throw new Error('fixture has no host face')
    const declaration = host.graph.declarations.find(candidate => candidate.name === 'SyntaxZoo')
    if (declaration === undefined) throw new Error('fixture has no SyntaxZoo declaration')

    const sourcePath = join(fixtureRoot, 'packages/host/src/models.ts')
    const source = ts.createSourceFile(
      sourcePath,
      readFileSync(sourcePath, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    )
    const sourceDeclaration = source.statements
      .find(statement => ts.isInterfaceDeclaration(statement) && statement.name.text === 'SyntaxZoo')
    if (sourceDeclaration === undefined || !ts.isInterfaceDeclaration(sourceDeclaration)) {
      throw new Error('fixture source has no SyntaxZoo declaration')
    }
    const sourceTypes = new Map(sourceDeclaration.members.flatMap((member) => {
      if (!ts.isPropertySignature(member) || member.type === undefined || !ts.isIdentifier(member.name)) return []
      return [[member.name.text, printType(member.type, source)] as const]
    }))
    const renderer = new TypeGraphRenderer(host.graph)
    const renderedTypes = new Map(declaration.members.flatMap((member) => {
      if (member.kind !== 'property') return []
      return [[member.name, canonicalType(renderer.renderType(member.type))] as const]
    }))

    expect([...renderedTypes.keys()]).toEqual([...sourceTypes.keys()])
    for (const [name, sourceType] of sourceTypes) {
      expect(renderedTypes.get(name), name).toBe(canonicalType(sourceType))
    }
  })

  it('renders every analyzed declaration as compilable TypeScript', () => {
    const model = new WorkspaceAnalyzer({ root: fixtureRoot }).analyze()
    const root = mkdtempSync(join(import.meta.dirname, '.rendered-model-'))
    temporaryRoots.push(root)
    const externalTypes = join(root, 'external.d.ts')
    writeFileSync(externalTypes, [
      'declare module \'@fixture/host\' {',
      '  export class Agent<State = unknown> {}',
      '}',
      '',
    ].join('\n'))
    const rootNames: string[] = [externalTypes]

    for (const face of model.faces) {
      const renderer = new TypeGraphRenderer(face.graph)
      const path = join(root, `${face.face}.d.ts`)
      const prelude = face.face === 'host'
        ? [
          'declare class Service {}',
          'interface ZodType<Output = unknown> {}',
          'declare namespace NodeJS { interface Process {} }',
          "declare const phaseOrder: readonly ['idle', 'running']",
          'declare function genericFactory<Value>(): Value',
        ]
        : [
          'declare class Service {}',
          'declare class Agent<State = unknown> {}',
          'declare enum AgentPhase {}',
          'declare class HostAgent<State = unknown> {}',
          'declare class HostDefault {}',
          'declare namespace Host { class Agent<State = unknown> {} }',
          'interface Payload { name: string; count?: number }',
        ]
      writeFileSync(path, [
        ...prelude,
        ...face.graph.declarations.map(declaration => renderer.renderDeclaration(declaration.id)),
        '',
      ].join('\n\n'))
      rootNames.push(path)
    }

    const program = ts.createProgram({
      rootNames,
      options: {
        strict: true,
        noEmit: true,
        skipLibCheck: false,
        target: ts.ScriptTarget.ES2024,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
      },
    })
    expect(ts.getPreEmitDiagnostics(program).map(formatDiagnostic)).toEqual([])
  })
})

describe('WorkspaceTypertGenerator', { timeout: 60_000 }, () => {
  it('emits host and client faces through their exact root-level public artifacts', () => {
    const artifacts = new WorkspaceTypertGenerator(fixtureRoot).generate()
    expect(artifacts.map(artifact => ({ package: artifact.package, face: artifact.face }))).toEqual([
      { package: '@fixture/host', face: 'host' },
      { package: '@fixture/client', face: 'client' },
    ])
    expect(artifacts.every(artifact => artifact.dts.includes('export declare const TYPERT: unknown'))).toBe(true)
  })

  it('rejects a public Typert subpath that points outside the root-level face artifact', () => {
    const root = copyFixture('typert-artifact-path-')
    const manifestPath = join(root, 'packages/client', 'package.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      exports: Record<string, { types: string; default: string }>
    }
    const clientExport = manifest.exports['./client/typert']
    if (clientExport === undefined) throw new Error('fixture has no client Typert export')
    clientExport.types = './lib/types/typert.client.d.ts'
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

    expect(() => new WorkspaceTypertGenerator(root).generate()).toThrow(
      '@fixture/client must export ./client/typert as',
    )
  })

  it('rejects absent Typert exports and package file entries', () => {
    const noSubpathRoot = copyFixture('typert-missing-artifact-export-')
    const noSubpathManifest = join(noSubpathRoot, 'packages/client', 'package.json')
    const noSubpath = JSON.parse(readFileSync(noSubpathManifest, 'utf8')) as Record<string, unknown>
    noSubpath.exports = './lib/index.js'
    writeFileSync(noSubpathManifest, `${JSON.stringify(noSubpath, null, 2)}\n`)
    expect(() => new WorkspaceTypertGenerator(noSubpathRoot).generate()).toThrow(
      '@fixture/client must export ./client/typert as',
    )

    const invalidSubpathRoot = copyFixture('typert-invalid-artifact-export-')
    const invalidSubpathManifest = join(invalidSubpathRoot, 'packages/client', 'package.json')
    const invalidSubpath = JSON.parse(readFileSync(invalidSubpathManifest, 'utf8')) as {
      exports: Record<string, unknown>
    }
    invalidSubpath.exports['./client/typert'] = null
    writeFileSync(invalidSubpathManifest, `${JSON.stringify(invalidSubpath, null, 2)}\n`)
    expect(() => new WorkspaceTypertGenerator(invalidSubpathRoot).generate()).toThrow(
      '@fixture/client must export ./client/typert as',
    )

    const noFilesRoot = copyFixture('typert-missing-artifact-files-')
    const noFilesManifest = join(noFilesRoot, 'packages/client', 'package.json')
    const noFiles = JSON.parse(readFileSync(noFilesManifest, 'utf8')) as Record<string, unknown>
    delete noFiles.files
    writeFileSync(noFilesManifest, `${JSON.stringify(noFiles, null, 2)}\n`)
    expect(() => new WorkspaceTypertGenerator(noFilesRoot).generate()).toThrow(
      '@fixture/client package files must include lib/typert.client.js',
    )
  })
})

function distinct(values: readonly string[]): string[] {
  return [...new Set(values)].sort()
}

function formatDiagnostic(diagnostic: ts.Diagnostic): string {
  return ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')
}

function printType(node: ts.TypeNode, source: ts.SourceFile): string {
  return ts.createPrinter().printNode(ts.EmitHint.Unspecified, node, source)
}

function canonicalType(text: string): string {
  const source = ts.createSourceFile(
    'canonical-type.ts',
    `type Canonical = ${text}\n`,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  )
  const declaration = source.statements[0]
  if (declaration === undefined || !ts.isTypeAliasDeclaration(declaration)) {
    throw new Error(`cannot parse rendered type ${text}`)
  }
  return printType(declaration.type, source)
}

function copyFixture(prefix: string): string {
  const root = mkdtempSync(join(import.meta.dirname, `.${prefix}`))
  temporaryRoots.push(root)
  cpSync(fixtureRoot, root, { recursive: true })
  return root
}

function configureDualRuntimeClient(root: string, splitProjects: boolean): void {
  const packageRoot = join(root, 'packages/client')
  const manifestPath = join(packageRoot, 'package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    dsh?: { client?: object }
    exports: Record<string, unknown>
  }
  manifest.dsh = { client: {} }
  manifest.exports['./client'] = {
    types: './lib/types/client.d.ts',
    default: './lib/client.js',
  }
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  writeFileSync(join(packageRoot, 'src/client.ts'), [
    "import { Service } from '@deepseek-ai/cordis'",
    'export interface ClientOnlyMarker { readonly client: true }',
    'export class BrowserBridge extends Service {}',
    "declare module '@deepseek-ai/cordis' { interface Context { browserBridge: BrowserBridge } }",
    '',
  ].join('\n'))
  const indexPath = join(packageRoot, 'src/index.ts')
  writeFileSync(indexPath, `${readFileSync(indexPath, 'utf8')}\nexport interface HostOnlyMarker { readonly host: true }\n`)
  if (!splitProjects) return

  const project = JSON.parse(readFileSync(join(packageRoot, 'tsconfig.json'), 'utf8')) as Record<string, unknown>
  delete project.include
  writeFileSync(join(packageRoot, 'tsconfig.host.json'), `${JSON.stringify({
    ...project,
    files: ['src/index.ts'],
  }, null, 2)}\n`)
  writeFileSync(join(packageRoot, 'tsconfig.client.json'), `${JSON.stringify({
    ...project,
    files: ['src/client.ts'],
  }, null, 2)}\n`)
  writeFileSync(join(packageRoot, 'tsconfig.json'), `${JSON.stringify({
    files: [],
    references: [
      { path: './tsconfig.host.json' },
      { path: './tsconfig.client.json' },
    ],
  }, null, 2)}\n`)

  const hostAggregatePath = join(root, 'tsconfig.host.json')
  const hostAggregate = JSON.parse(readFileSync(hostAggregatePath, 'utf8')) as {
    references: { path: string }[]
  }
  hostAggregate.references.push({ path: ['.', 'packages', 'client', 'tsconfig.host.json'].join('/') })
  writeFileSync(hostAggregatePath, `${JSON.stringify(hostAggregate, null, 2)}\n`)

  const clientAggregatePath = join(root, 'tsconfig.client.json')
  const clientAggregate = JSON.parse(readFileSync(clientAggregatePath, 'utf8')) as {
    references: { path: string }[]
  }
  clientAggregate.references = [{ path: ['.', 'packages', 'client', 'tsconfig.client.json'].join('/') }]
  writeFileSync(clientAggregatePath, `${JSON.stringify(clientAggregate, null, 2)}\n`)
}

function addSameFacePackage(
  root: string,
  specifier: string,
  importedName: string,
  files: Readonly<Record<string, string>> = {},
): void {
  const packageRoot = join(root, 'packages/consumer')
  mkdirSync(join(packageRoot, 'src'), { recursive: true })
  for (const [file, source] of Object.entries(files)) writeFileSync(join(packageRoot, 'src', file), source)
  writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({
    name: '@fixture/consumer',
    private: true,
    type: 'module',
    exports: {
      '.': {
        types: './lib/types/index.d.ts',
        default: './lib/index.js',
      },
    },
  }, null, 2))
  writeFileSync(join(packageRoot, 'tsconfig.json'), JSON.stringify({
    extends: '../../tsconfig.base.json',
    compilerOptions: { rootDir: 'src', outDir: 'lib/types' },
    include: ['src'],
    references: [{ path: '../host' }],
  }, null, 2))
  writeFileSync(join(packageRoot, 'src/index.ts'), [
    `import type { ${importedName} } from '${specifier}'`,
    '/** @typert schema */',
    `export interface ConsumerSchema { readonly value: ${importedName} }`,
    '',
  ].join('\n'))
  const aggregatePath = join(root, 'tsconfig.host.json')
  const aggregate = JSON.parse(readFileSync(aggregatePath, 'utf8')) as { references: { path: string }[] }
  aggregate.references.push({ path: './packages/consumer' })
  writeFileSync(aggregatePath, `${JSON.stringify(aggregate, null, 2)}\n`)
}

function addExplicitServicePackage(root: string, annotation: string, withProtocol = false): void {
  const packageRoot = join(root, 'packages/explicit-service')
  mkdirSync(join(packageRoot, 'src'), { recursive: true })
  writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({
    name: '@fixture/explicit-service',
    private: true,
    type: 'module',
    exports: {
      '.': {
        types: './lib/types/index.d.ts',
        default: './lib/index.js',
      },
    },
  }, null, 2))
  writeFileSync(join(packageRoot, 'tsconfig.json'), JSON.stringify({
    extends: '../../tsconfig.base.json',
    compilerOptions: { rootDir: 'src', outDir: 'lib/types' },
    include: ['src'],
  }, null, 2))
  if (withProtocol) {
    writeFileSync(join(packageRoot, 'src/types.ts'), [
      '/** Public detached Service protocol. */',
      'export interface DetachedProtocol {',
      '  /** Report protocol readiness. */',
      '  ready(): boolean',
      '}',
      "declare module '@deepseek-ai/cordis' {",
      '  interface Context { detached: DetachedProtocol }',
      '}',
      '',
    ].join('\n'))
  }
  writeFileSync(join(packageRoot, 'src/index.ts'), [
    "import { Service } from '@deepseek-ai/cordis'",
    ...(withProtocol ? ["export type { DetachedProtocol } from './types.ts'"] : []),
    '/**',
    ' * Service implementation discovered independently of its protocol package.',
    ` * @typert ${annotation}`,
    ' */',
    'export class DetachedService extends Service {',
    '  /** Report readiness. */',
    '  ready(): boolean { return true }',
    '}',
    '',
  ].join('\n'))
  const aggregatePath = join(root, 'tsconfig.host.json')
  const aggregate = JSON.parse(readFileSync(aggregatePath, 'utf8')) as { references: { path: string }[] }
  aggregate.references.push({ path: './packages/explicit-service' })
  writeFileSync(aggregatePath, `${JSON.stringify(aggregate, null, 2)}\n`)
}

describe('FaceModelEmitter', { timeout: 60_000 }, () => {
  it('emits runnable Zod JavaScript, precise declarations, and runtime package metadata', async () => {
    const model = new WorkspaceAnalyzer({ root: fixtureRoot }).analyze()
    const host = model.faces.find(face => face.face === 'host')
    if (host === undefined) throw new Error('fixture has no host face')
    const artifact = new FaceModelEmitter(host).emit('@fixture/host')

    expect(artifact.js).toMatchSnapshot()
    expect(artifact.dts).toMatchSnapshot()

    const root = mkdtempSync(join(import.meta.dirname, '.generated-model-'))
    temporaryRoots.push(root)
    const modulePath = join(root, 'host.mjs')
    writeFileSync(modulePath, artifact.js)
    const generated = await import(`${pathToFileURL(modulePath).href}?test=${Date.now()}`) as {
      Payload: { safeParse(value: unknown): { success: boolean } }
      TYPERT: {
        package: string
        face: string
        schemas: { name: string; schema: unknown }[]
        model: { services: { key: string; members: { signature: string }[] }[] }
      }
    }
    expect(generated.Payload.safeParse({ name: 'ready', count: 2 }).success).toBe(true)
    expect(generated.Payload.safeParse({ name: 'ready', count: 'two' }).success).toBe(false)
    expect(generated.TYPERT).toMatchObject({ package: '@fixture/host', face: 'host' })
    expect(generated.TYPERT.schemas[0]?.schema).toBe(generated.Payload)
    const demo = generated.TYPERT.model.services.find(service => service.key === 'demo')
    expect(demo).toMatchObject({ key: 'demo' })
    expect(demo?.members.map(member => member.signature)).toContain(
      'inspect(agent: Agent<{ ready: true }>, flags: Flags<Payload>): Present<Payload>',
    )

    const declarationPath = join(root, 'host.d.ts')
    const consumerPath = join(root, 'consumer.ts')
    const sourceStubPath = join(root, 'source.d.ts')
    writeFileSync(declarationPath, artifact.dts)
    writeFileSync(consumerPath, [
      'import { Payload } from \'./host.js\'',
      'import type { Payload as SourcePayload } from \'@fixture/host\'',
      'import type { z } from \'zod\'',
      'const precise: z.ZodType<SourcePayload> = Payload',
      'void precise',
      '',
    ].join('\n'))
    writeFileSync(sourceStubPath, [
      'declare module \'@fixture/host\' {',
      '  export interface Payload { name: string; count?: number }',
      '}',
      '',
    ].join('\n'))
    const program = ts.createProgram({
      rootNames: [consumerPath, declarationPath, sourceStubPath],
      options: {
        strict: true,
        noEmit: true,
        skipLibCheck: false,
        target: ts.ScriptTarget.ES2024,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
      },
    })
    const diagnostics = ts.getPreEmitDiagnostics(program)
    expect(diagnostics.map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))).toEqual([])
  })
})
