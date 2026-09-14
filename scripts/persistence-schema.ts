/** Extract complete persistent Session record types from one source-only compiler program. */

import { readFileSync } from 'node:fs'
import { dirname, extname, relative, resolve, sep } from 'node:path'
import ts from 'typescript'
import { collectLogEvents } from './persistence-catalog-source.ts'
import {
  canonicalizeSchema,
  schemaChildren,
  schemaDigest,
  type PersistenceRoot,
  type PersistenceSchemaInventory,
  type PersistenceType,
  type SchemaNode,
  type SchemaProperty,
} from './persistence-schema-model.ts'

interface DeclarationMetadata {
  readonly names: Set<string>
  readonly sources: Set<string>
}

interface RootInput {
  readonly key: string
  readonly kind: PersistenceRoot['kind']
  readonly event?: string
  readonly surface?: boolean
  readonly node: number
}

/** A reachable TypeScript type that cannot be represented as a persisted JSON type. */
export class PersistenceSchemaError extends Error {
  override name = 'PersistenceSchemaError'
}

/**
 * Extract every repository event, its complete envelope, and the Session header.
 * @param root - repository root, with source paths in tsconfig.host.json.
 * @returns canonical root fingerprints and all reachable type definitions.
 */
export function extractPersistenceSchema(root: string): PersistenceSchemaInventory {
  root = resolve(root)
  const events = collectLogEvents(root).sort((left, right) => compare(left.name, right.name))
  if (events.length === 0) throw new PersistenceSchemaError('persistence schema: no Session events were discovered')
  const filename = resolve(root, 'scripts/__persistence_schema_roots__.ts')
  const source = [
    "import type { SessionHeader, SessionEvent, SessionEventMap, SurfaceEventType } from '@deepseek-ai/dsh-session/types'",
    'export type HeaderRoot = SessionHeader',
    'export type SurfaceRoot = SurfaceEventType',
    'export type EventNamesRoot = keyof SessionEventMap',
    ...events.map((event, index) => `export type EventRoot${String(index)} = SessionEvent<${JSON.stringify(event.name)}>`),
    '',
  ].join('\n')
  const configPath = resolve(root, 'tsconfig.host.json')
  const config = ts.readConfigFile(configPath, file => readFileSync(file, 'utf8'))
  if (config.error !== undefined) throw new PersistenceSchemaError(diagnosticText(config.error))
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root)
  const configErrors = parsed.errors.filter(error => error.code !== 18003)
  if (configErrors.length > 0) throw new PersistenceSchemaError(configErrors.map(diagnosticText).join('\n'))
  const options: ts.CompilerOptions = {
    ...parsed.options,
    composite: false,
    incremental: false,
    noEmit: true,
    rootDir: root,
    noUnusedLocals: false,
    noUnusedParameters: false,
    // Reachable declaration-file errors must not become opaque any values.
    skipLibCheck: false,
    strict: true,
    exactOptionalPropertyTypes: true,
  }
  const host = ts.createCompilerHost(options)
  const originalGetSourceFile = host.getSourceFile.bind(host)
  host.getSourceFile = (path, languageVersion, onError, shouldCreateNewSourceFile) =>
    resolve(path) === filename
      ? ts.createSourceFile(filename, source, languageVersion, true)
      : originalGetSourceFile(path, languageVersion, onError, shouldCreateNewSourceFile)
  const files = [...new Set([
    ...hostSourceFiles(root, configPath),
    ...events.map(event => resolve(root, event.source.slice(0, event.source.lastIndexOf(':')))),
  ])]
  const program = ts.createProgram({ rootNames: [filename, ...files], options, host })
  const rootSource = program.getSourceFile(filename)
  if (rootSource === undefined) throw new PersistenceSchemaError('persistence schema: compiler omitted the requested roots')
  const diagnostics = [
    ...program.getOptionsDiagnostics(), ...program.getSyntacticDiagnostics(), ...program.getSemanticDiagnostics(rootSource),
  ]
  if (diagnostics.length > 0) throw new PersistenceSchemaError(diagnostics.map(diagnosticText).join('\n'))
  const checker = program.getTypeChecker()
  const declarations = new Map(rootSource.statements.filter(ts.isTypeAliasDeclaration)
    .map(declaration => [declaration.name.text, declaration]))
  const declaration = (name: string): ts.TypeAliasDeclaration => {
    const found = declarations.get(name)
    if (found === undefined) throw new PersistenceSchemaError(`persistence schema: missing compiler root ${name}`)
    return found
  }
  const eventNamesDeclaration = declaration('EventNamesRoot')
  const compiledEvents = stringLiterals(checker.getTypeFromTypeNode(eventNamesDeclaration.type), 'keyof SessionEventMap')
  const discoveredEvents = new Set(events.map(event => event.name))
  const omitted = [...compiledEvents].filter(name => !discoveredEvents.has(name))
  const uncompiled = [...discoveredEvents].filter(name => !compiledEvents.has(name))
  if (omitted.length > 0 || uncompiled.length > 0) {
    throw new PersistenceSchemaError(`persistence schema: compiler and source event discovery disagree; omitted: ${omitted.join(', ')}; uncompiled: ${uncompiled.join(', ')}`)
  }
  const surfaceDeclaration = declaration('SurfaceRoot')
  const surface = stringLiterals(checker.getTypeFromTypeNode(surfaceDeclaration.type), 'SurfaceEventType')
  for (const name of surface) {
    if (!events.some(event => event.name === name)) throw new PersistenceSchemaError(`persistence schema: surface event ${name} has no declaration`)
  }
  const header = declaration('HeaderRoot')
  const physicalFile = resolve(root, 'packages/session/session-persistence-jsonl/src/format.ts')
  const physical = program.getSourceFile(physicalFile)?.statements
    .filter((node): node is ts.InterfaceDeclaration | ts.TypeAliasDeclaration =>
      ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node))
    .filter(declaration => declaration.name.text === 'HeaderLine')
  if (physical?.length !== 1) throw new PersistenceSchemaError('persistence schema: expected one current JSONL HeaderLine declaration')
  const physicalHeader = physical[0] as ts.InterfaceDeclaration | ts.TypeAliasDeclaration
  const declarationSources = validateReachableDeclarations(program, root, [...declarations.values(), physicalHeader])
  const extraction = new SchemaExtractor(root, program, declarationSources)
  const roots: RootInput[] = [{
    key: 'SessionHeader',
    kind: 'header',
    node: extraction.convert(checker.getTypeFromTypeNode(header.type), header),
  }]
  roots.push({ key: 'JsonlHeaderLine', kind: 'header', node: extraction.convert(checker.getTypeAtLocation(physicalHeader), physicalHeader) })
  const envelopes: number[] = []
  for (const [index, event] of events.entries()) {
    const item = declaration(`EventRoot${String(index)}`)
    const node = extraction.convert(checker.getTypeFromTypeNode(item.type), item)
    roots.push({ key: `event:${event.name}`, kind: 'event', event: event.name, surface: surface.has(event.name), node })
    envelopes.push(extraction.envelope(node, event.name))
  }
  roots.splice(2, 0, { key: 'SessionEventEnvelope', kind: 'envelope', node: extraction.union(envelopes) })
  return extraction.inventory(roots)
}

function hostSourceFiles(root: string, configPath: string, seen = new Set<string>()): string[] {
  configPath = resolve(configPath)
  if (seen.has(configPath)) return []
  seen.add(configPath)
  const read = ts.readConfigFile(configPath, file => readFileSync(file, 'utf8'))
  if (read.error !== undefined) throw new PersistenceSchemaError(diagnosticText(read.error))
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, dirname(configPath), undefined, configPath)
  const errors = parsed.errors.filter(error => error.code !== 18003)
  if (errors.length > 0) throw new PersistenceSchemaError(errors.map(diagnosticText).join('\n'))
  return [
    ...parsed.fileNames.filter(file => /^packages\/[^/]+\/[^/]+\/src\//.test(slash(relative(root, file)))),
    ...(parsed.projectReferences ?? []).flatMap(reference =>
      hostSourceFiles(root, extname(reference.path) === '.json' ? reference.path : resolve(reference.path, 'tsconfig.json'), seen)),
  ]
}

function validateReachableDeclarations(
  program: ts.Program,
  root: string,
  roots: readonly ts.Node[],
): ReadonlyMap<ts.Type, readonly ts.Node[]> {
  const checker = program.getTypeChecker()
  const visited = new Set<ts.Node>()
  const declarations = new Map<ts.SourceFile, ts.Node[]>()
  const definitions = new Map<ts.Type, ts.Node[]>()
  const visit = (node: ts.Node): void => {
    if (visited.has(node)) return
    visited.add(node)
    const file = node.getSourceFile()
    if (trackedSource(slash(relative(root, file.fileName)))) {
      const scopes = declarations.get(file) ?? []
      scopes.push(node)
      declarations.set(file, scopes)
      if (isNamedTypeDeclaration(node) || ts.isTypeLiteralNode(node)) {
        // Primitive aliases share checker types with unaliased properties.
        const type = checker.getTypeAtLocation(node)
        const entries = definitions.get(type) ?? []
        entries.push(node)
        definitions.set(type, entries)
      }
    }
    const target = ts.isTypeReferenceNode(node) ? node.typeName
      : ts.isExpressionWithTypeArguments(node) ? node.expression
        : ts.isTypeQueryNode(node) ? node.exprName
          : ts.isImportTypeNode(node) ? node.qualifier
            : undefined
    if (target !== undefined) {
      let symbol = checker.getSymbolAtLocation(target)
      if (symbol !== undefined && (symbol.flags & ts.SymbolFlags.Alias)) symbol = checker.getAliasedSymbol(symbol)
      for (const declaration of symbol?.declarations ?? []) {
        if (trackedSource(slash(relative(root, declaration.getSourceFile().fileName)))) visit(declaration)
      }
    }
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) return
    ts.forEachChild(node, visit)
  }
  for (const root of roots) visit(root)
  const errors = [...declarations].flatMap(([file, scopes]) => program.getSemanticDiagnostics(file)
    .filter((error) => {
      const start = error.start
      return start !== undefined && scopes.some(scope => start >= scope.getStart() && start < scope.end)
    }))
  if (errors.length > 0) throw new PersistenceSchemaError(errors.map(diagnosticText).join('\n'))
  return definitions
}

class SchemaExtractor {
  readonly nodes: SchemaNode[] = []
  private readonly cache = new Map<ts.Type, number>()
  private readonly declarationMetadata = new Map<number, DeclarationMetadata>()

  private readonly checker: ts.TypeChecker

  constructor(
    private readonly root: string,
    program: ts.Program,
    private readonly declarationSources: ReadonlyMap<ts.Type, readonly ts.Node[]>,
  ) {
    this.checker = program.getTypeChecker()
  }

  convert(type: ts.Type, site: ts.Node): number {
    const cached = this.cache.get(type)
    if (cached !== undefined) {
      this.record(cached, type)
      return cached
    }
    const id = this.nodes.length
    this.nodes.push({ kind: 'primitive', type: 'never' })
    this.cache.set(type, id)
    this.record(id, type)
    const add = (node: SchemaNode): number => { this.nodes[id] = node; return id }
    const flags = type.flags
    if (flags & ts.TypeFlags.Any) {
      if ((type as ts.Type & { intrinsicName?: string }).intrinsicName === 'error') this.fail(type, site, 'unresolved compiler type')
      return add({ kind: 'opaque', reason: 'any' })
    }
    if (flags & ts.TypeFlags.Unknown) return add({ kind: 'opaque', reason: 'unknown' })
    if (flags & ts.TypeFlags.Never) return add({ kind: 'primitive', type: 'never' })
    if (flags & ts.TypeFlags.Null) return add({ kind: 'primitive', type: 'null' })
    if (flags & ts.TypeFlags.String) return add({ kind: 'primitive', type: 'string' })
    if (flags & ts.TypeFlags.Number) return add({ kind: 'primitive', type: 'number' })
    if (flags & ts.TypeFlags.Boolean) return add({ kind: 'primitive', type: 'boolean' })
    if (flags & ts.TypeFlags.StringLiteral) return add({ kind: 'literal', value: (type as ts.StringLiteralType).value })
    if (flags & ts.TypeFlags.NumberLiteral) return add({ kind: 'literal', value: (type as ts.NumberLiteralType).value })
    if (flags & ts.TypeFlags.BooleanLiteral) return add({ kind: 'literal', value: this.checker.typeToString(type) === 'true' })
    if (type.isUnion()) return add(this.unionNode(type.types.map(member => this.convert(member, site))))
    if (type.isIntersection()) {
      const material = type.types.filter(member => !this.phantom(member))
      for (const member of material) this.rejectClass(member, site)
      if (material.length === 1) {
        const target = this.convert(material[0] as ts.Type, site)
        return add({ kind: 'union', types: [target] })
      }
      if (material.length === 0 || material.some(member => (member.flags & ts.TypeFlags.Object) === 0)) {
        this.fail(type, site, 'unsupported material intersection')
      }
      return add(this.object(type, site))
    }
    if (this.checker.isTupleType(type)) {
      const reference = type as ts.TypeReference
      const target = reference.target as ts.TupleType
      return add({
        kind: 'tuple',
        elements: this.checker.getTypeArguments(reference).map((element, index) => {
          const flags = target.elementFlags[index] ?? ts.ElementFlags.Required
          const optional = (flags & ts.ElementFlags.Optional) !== 0
          const rest = (flags & (ts.ElementFlags.Rest | ts.ElementFlags.Variadic)) !== 0
          return { type: this.valueType(element, site, optional), optional, rest }
        }),
      })
    }
    if (this.checker.isArrayType(type) || this.checker.isArrayLikeType(type)) {
      const element = this.checker.getIndexTypeOfType(type, ts.IndexKind.Number)
      if (element === undefined) this.fail(type, site, 'array element is unavailable')
      return add({ kind: 'array', element: this.convert(element, site) })
    }
    if (flags & ts.TypeFlags.Object) return add(this.object(type, site))
    this.fail(type, site, 'type has no supported JSON representation')
  }

  private valueType(type: ts.Type, site: ts.Node, optional: boolean): number {
    if (!optional) return this.convert(type, site)
    const members = (type.isUnion() ? type.types : [type]).filter(member => !(member.flags & ts.TypeFlags.Undefined))
    return this.union(members.map(member => this.convert(member, site)))
  }

  private object(type: ts.Type, site: ts.Node): SchemaNode {
    this.rejectClass(type, site)
    if (type.getCallSignatures().length > 0 || type.getConstructSignatures().length > 0) this.fail(type, site, 'callable data is not JSON')
    const properties: SchemaProperty[] = []
    for (const property of this.checker.getPropertiesOfType(type).sort((left, right) => compare(left.name, right.name))) {
      if (property.getName().startsWith('__@')) this.fail(type, site, 'symbol-keyed data is not a JSON field')
      const declaration = property.valueDeclaration ?? property.declarations?.[0] ?? site
      const propertyType = this.checker.getTypeOfSymbolAtLocation(property, declaration)
      const optional = (property.flags & ts.SymbolFlags.Optional) !== 0
      if (optional && (propertyType.isUnion() ? propertyType.types : [propertyType])
        .every(member => (member.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Never)) !== 0)) continue
      const child = this.valueType(propertyType, declaration, optional)
      properties.push({ name: property.getName(), type: child, optional })
    }
    const indices = this.checker.getIndexInfosOfType(type).map(info => ({
      key: this.convert(info.keyType, site),
      value: this.convert(info.type, site),
    }))
    if (properties.length === 0 && indices.length === 0) this.fail(type, site, 'unconstrained empty object type is not an explicit JSON record')
    return { kind: 'object', properties, indices }
  }

  private rejectClass(type: ts.Type, site: ts.Node): void {
    const symbol = type.getSymbol()
    if (symbol?.declarations?.some(declaration => ts.isClassDeclaration(declaration) || ts.isClassExpression(declaration))) {
      this.fail(type, site, 'class instances require an explicit persisted representation')
    }
  }

  private phantom(type: ts.Type): boolean {
    if (!(type.flags & ts.TypeFlags.Object)) return false
    const properties = this.checker.getPropertiesOfType(type)
    return properties.length > 0 && properties.every(property => property.getName().startsWith('__@'))
      && type.getCallSignatures().length === 0 && type.getConstructSignatures().length === 0
      && this.checker.getIndexInfosOfType(type).length === 0
  }

  union(types: readonly number[]): number {
    const node = this.unionNode(types)
    if (node.kind === 'union' && node.types.length === 1) return node.types[0] as number
    this.nodes.push(node)
    return this.nodes.length - 1
  }

  private unionNode(types: readonly number[]): SchemaNode {
    if (types.length === 0) return { kind: 'primitive', type: 'never' }
    return { kind: 'union', types: [...new Set(types)] }
  }

  envelope(id: number, event: string): number {
    const node = this.nodes[id] as SchemaNode
    if (node.kind === 'union') return this.union(node.types.map(type => this.envelope(type, event)))
    if (node.kind !== 'object') throw new PersistenceSchemaError('persistence schema: SessionEvent must resolve to object alternatives')
    const tag = node.properties.find(property => property.name === 'type')
    const data = node.properties.find(property => property.name === 'data')
    const literal = tag === undefined ? undefined : canonicalizeSchema(this.nodes, tag.type).nodes[0]
    if (tag?.optional !== false || data?.optional !== false || literal?.kind !== 'literal' || literal.value !== event) {
      throw new PersistenceSchemaError(`persistence schema: SessionEvent<${JSON.stringify(event)}> must retain its required type and data fields`)
    }
    const string = this.nodes.length
    this.nodes.push({ kind: 'primitive', type: 'string' })
    const envelope: SchemaNode = {
      kind: 'object',
      properties: node.properties.filter(property => property.name !== 'data')
        .map(property => property.name === 'type' ? { ...property, type: string } : property),
      indices: node.indices,
    }
    this.nodes.push(envelope)
    return this.nodes.length - 1
  }

  inventory(inputs: readonly RootInput[]): PersistenceSchemaInventory {
    const roots = inputs.map((input) => {
      const schema = canonicalizeSchema(this.nodes, input.node)
      return {
        key: input.key,
        kind: input.kind,
        ...(input.event === undefined ? {} : { event: input.event }),
        ...(input.surface === undefined ? {} : { surface: input.surface }),
        digest: schemaDigest(schema),
        schema,
      }
    })
    const found = new Set<number>()
    const paths = new Map<number, Set<string>>()
    const visit = (id: number, path: string): void => {
      const names = paths.get(id) ?? new Set<string>()
      names.add(path)
      paths.set(id, names)
      if (found.has(id)) return
      found.add(id)
      const node = this.nodes[id] as SchemaNode
      if (node.kind === 'object') {
        for (const property of node.properties) visit(property.type, `${path}.${property.name}`)
        for (const index of node.indices) { visit(index.key, `${path}.[key]`); visit(index.value, `${path}.[value]`) }
      } else {
        for (const [index, child] of schemaChildren(node).entries()) visit(child, `${path}[${String(index)}]`)
      }
    }
    for (const input of inputs) visit(input.node, input.key)
    const types = new Map<string, { schema: PersistenceType['schema']; names: Set<string>; sources: Set<string> }>()
    for (const id of found) {
      const schema = canonicalizeSchema(this.nodes, id)
      const digest = schemaDigest(schema)
      const item = types.get(digest) ?? { schema, names: new Set<string>(), sources: new Set<string>() }
      const declarationMetadata = this.declarationMetadata.get(id)
      for (const name of declarationMetadata?.names ?? []) item.names.add(name)
      for (const source of declarationMetadata?.sources ?? []) item.sources.add(source)
      const kind = schema.nodes[0]?.kind
      if (kind !== 'primitive' && kind !== 'literal' && (declarationMetadata === undefined || declarationMetadata.names.size === 0)) {
        for (const path of paths.get(id) ?? []) item.names.add(path)
      }
      types.set(digest, item)
    }
    return {
      formatVersion: 1,
      roots,
      types: [...types].sort(([left], [right]) => compare(left, right)).map(([digest, item]) => ({
        digest,
        schema: item.schema,
        names: [...item.names].sort(compare),
        sources: [...item.sources].sort(compare),
      })),
    }
  }

  private record(id: number, type: ts.Type): void {
    const item = this.declarationMetadata.get(id) ?? { names: new Set<string>(), sources: new Set<string>() }
    const declarations = new Set([
      ...this.declarationSources.get(type) ?? [],
      ...type.aliasSymbol?.declarations ?? [],
      ...type.getSymbol()?.declarations ?? [],
    ])
    for (const declaration of declarations) {
      if (!isNamedTypeDeclaration(declaration) && !ts.isTypeLiteralNode(declaration) && !ts.isEnumMember(declaration)) continue
      const source = declaration.getSourceFile()
      const file = slash(relative(this.root, source.fileName))
      if (!trackedSource(file)) continue
      if (isNamedTypeDeclaration(declaration)) item.names.add(`${file}#${declaration.name.text}`)
      const position = source.getLineAndCharacterOfPosition(declaration.getStart())
      item.sources.add(`${file}:${String(position.line + 1)}`)
    }
    this.declarationMetadata.set(id, item)
  }

  private fail(type: ts.Type, site: ts.Node, reason: string): never {
    const source = slash(relative(this.root, site.getSourceFile().fileName))
    const position = site.getSourceFile().getLineAndCharacterOfPosition(site.getStart())
    throw new PersistenceSchemaError(`persistence schema: ${source}:${String(position.line + 1)}: ${reason}: ${this.checker.typeToString(type)}`)
  }
}

function isNamedTypeDeclaration(node: ts.Node): node is ts.TypeAliasDeclaration | ts.InterfaceDeclaration | ts.EnumDeclaration {
  return ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isEnumDeclaration(node)
}

function stringLiterals(type: ts.Type, name: string): Set<string> {
  if (type.flags & ts.TypeFlags.Never) return new Set()
  const members = type.isUnion() ? type.types : [type]
  if (members.some(member => !(member.flags & ts.TypeFlags.StringLiteral))) throw new PersistenceSchemaError(`persistence schema: ${name} is not a closed string-literal union`)
  return new Set(members.map(member => (member as ts.StringLiteralType).value))
}

function diagnosticText(diagnostic: ts.Diagnostic): string {
  return `persistence schema: TypeScript TS${String(diagnostic.code)}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}`
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function slash(path: string): string {
  return path.split(sep).join('/')
}

function trackedSource(file: string): boolean {
  return (file.startsWith('packages/') || file.startsWith('vendor/')) && !file.includes('/node_modules/')
}
