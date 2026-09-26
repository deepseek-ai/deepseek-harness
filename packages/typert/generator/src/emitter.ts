/**
 * Model-driven Typert artifact emitter. It consumes only FaceModel and
 * TypeGraph data; TypeScript compiler nodes are not part of this boundary.
 * @module @deepseek-ai/dsh-typert-generator/emitter
 */

import { Buffer } from 'node:buffer'
import { posix } from 'node:path'
import { GenMapping, addMapping, toEncodedMap } from '@jridgewell/gen-mapping'
import type {
  DocumentationModel,
  FaceModel,
  InvocationModel,
  MemberModel,
  PackageModel,
  RemoteBoundaryModel,
  RemoteTypeImportModel,
  SchemaModel,
  SymbolId,
  TypeDeclarationModel,
  TypeNodeId,
  TypeNodeModel,
} from './model.ts'
import { TypeGraphRenderer } from './renderer.ts'
import { childTypeNodeIds } from './model.ts'

/** Failure to project a modeled construct into an emitted artifact. */
export class TypertEmitError extends Error {
  override name = 'TypertEmitError'
}

/** JavaScript and declaration artifacts for one package on one face. */
export interface ModelEmitResult {
  readonly package: string
  readonly face: FaceModel['face']
  readonly exports: readonly string[]
  readonly js: string
  readonly dts: string
  readonly remote?: RemoteModelEmitResult
}

/** Host-for-Client Remote contribution generated from the Host Program. */
export interface RemoteModelEmitResult {
  readonly js: string
  readonly dts: string
  readonly dtsMap: string
}

interface RuntimeMemberModel {
  readonly kind: MemberModel['kind']
  readonly name: string
  readonly signature: string
  readonly summary?: string
  readonly jsDoc?: string
}

interface RuntimeTypeModel {
  readonly name: string
  readonly declaration: string
}

interface RuntimeServiceModel extends DocumentationModel {
  readonly key: string
  readonly exportName: string
  readonly members: readonly RuntimeMemberModel[]
  readonly types: readonly RuntimeTypeModel[]
}

interface RuntimeEventModel extends DocumentationModel {
  readonly name: string
  readonly mode?: string
  readonly signature: string
}

interface RuntimeObjectModel extends DocumentationModel {
  readonly name: string
  readonly exportName: string
  readonly members: readonly RuntimeMemberModel[]
  readonly types: readonly RuntimeTypeModel[]
}

interface RuntimePackageModel {
  readonly services: readonly RuntimeServiceModel[]
  readonly events: readonly RuntimeEventModel[]
  readonly objects: readonly RuntimeObjectModel[]
}

/** Emit generated runtime and type artifacts from one independently analyzed face. */
export class FaceModelEmitter {
  private readonly renderer: TypeGraphRenderer

  /**
   * Create an emitter for one face graph.
   * @param face - independently analyzed face.
   */
  constructor(private readonly face: FaceModel) {
    this.renderer = new TypeGraphRenderer(face.graph)
  }

  /**
   * Emit one modeled package.
   * @param packageName - exact package name in the face model.
   * @returns executable JavaScript and its precise declaration file.
   */
  emit(packageName: string): ModelEmitResult {
    const packageModel = this.face.packages.find(candidate => candidate.name === packageName)
    if (packageModel === undefined) {
      throw new TypertEmitError(`typert emitter(${this.face.face}): package ${packageName} is not modeled on this face`)
    }
    const schemas = new SchemaEmitter(
      this.renderer,
      packageModel.schemas,
      invocationBoundaryRoots(packageModel.invocations),
    )
    const schemaArtifact = schemas.emit()
    const runtimeModel = this.runtimeModel(packageModel)
    const js = this.renderJs(packageModel, schemaArtifact, runtimeModel)
    const dts = this.renderDts(packageModel, schemaArtifact)
    return {
      package: packageName,
      face: this.face.face,
      exports: packageModel.schemas.map(schema => schema.export.name),
      js,
      dts,
      ...(this.face.face === 'host' && packageModel.invocations.length > 0
        ? { remote: this.emitRemote(packageModel) }
        : {}),
    }
  }

  private runtimeModel(packageModel: PackageModel): RuntimePackageModel {
    const services = packageModel.services.map((service): RuntimeServiceModel => {
      const members = service.members.map(id => this.runtimeMember(this.renderer.member(id)))
      return {
        ...documentationLiteral(service),
        key: service.key,
        exportName: service.export.name,
        members,
        types: this.runtimeTypes(this.renderer.declarationClosureForMembers(service.members), service.symbol),
      }
    })
    const events = packageModel.events.map((event): RuntimeEventModel => {
      const node = this.renderer.node(event.signature)
      if (node.kind !== 'function') {
        throw new TypertEmitError(`typert emitter(${this.face.face}): event ${event.name} is not a function type`)
      }
      return {
        ...documentationLiteral(event),
        name: event.name,
        ...(event.mode === undefined ? {} : { mode: event.mode }),
        signature: `${quote(event.name)}${this.renderer.renderSignature(node.signature)}`,
      }
    })
    const objects = packageModel.objects.map((object): RuntimeObjectModel => {
      const declaration = this.renderer.declaration(object.symbol)
      return {
        ...documentationLiteral(object),
        name: declaration.name,
        exportName: object.export.name,
        members: declaration.members.map(member => this.runtimeMember(member)),
        types: this.runtimeTypes(this.renderer.declarationClosureForMembers(declaration.members.map(member => member.id)), declaration.id),
      }
    })
    return { services, events, objects }
  }

  private runtimeMember(member: MemberModel): RuntimeMemberModel {
    return {
      kind: member.kind,
      name: member.name,
      signature: this.renderer.renderMember(member, true),
      ...(member.summary === undefined ? {} : { summary: member.summary }),
      ...(member.jsDoc === undefined ? {} : { jsDoc: member.jsDoc }),
    }
  }

  private runtimeTypes(declarations: readonly TypeDeclarationModel[], root: SymbolId): RuntimeTypeModel[] {
    return declarations
      .filter(declaration => declaration.id !== root)
      .map(declaration => ({
        name: declaration.name,
        declaration: this.renderer.renderDeclaration(declaration.id),
      }))
      .sort((left, right) => left.name.localeCompare(right.name))
  }

  private renderJs(
    packageModel: PackageModel,
    schemas: SchemaArtifact,
    runtimeModel: RuntimePackageModel,
  ): string {
    const lines = [
      '/* Generated by @deepseek-ai/dsh-typert-generator from FaceModel — do not edit. */',
    ]
    if (schemas.definitions.length > 0) lines.push('import { z } from \'zod\'', '')
    lines.push(...schemas.definitions)
    if (schemas.definitions.length > 0) lines.push('')
    for (const schema of schemas.exports) lines.push(`export const ${schema.exportName} = ${schema.internalName}`)
    if (schemas.exports.length > 0) lines.push('')
    const model = JSON.stringify(runtimeModel, null, 2)
    lines.push('export const TYPERT = {')
    lines.push(`  package: ${quote(packageModel.name)},`)
    lines.push(`  face: ${quote(this.face.face)},`)
    lines.push('  schemas: [')
    for (const schema of schemas.exports) {
      lines.push(`    { name: ${quote(schema.exportName)}, create: ${schema.exportName} },`)
    }
    lines.push('  ],')
    lines.push('  invocations: [')
    for (const invocation of packageModel.invocations) {
      lines.push(`${indent(this.invocationLiteral(invocation, schemas), 4)},`)
    }
    lines.push('  ],')
    lines.push(`  model: ${indent(model, 2).trimStart()},`)
    lines.push('}')
    return `${lines.join('\n')}\n`
  }

  private renderDts(packageModel: PackageModel, schemas: SchemaArtifact): string {
    const imports = new Map<string, string[]>()
    for (const schema of schemas.exports) {
      const specifier = packageExportSpecifier(packageModel.name, schema.model.export.subpath)
      const names = imports.get(specifier) ?? []
      names.push(`${schema.model.export.name} as ${schema.exportName}$source`)
      imports.set(specifier, names)
    }
    const lines = [
      '/* Generated by @deepseek-ai/dsh-typert-generator from FaceModel — do not edit. */',
    ]
    if (schemas.exports.length > 0) lines.splice(1, 0, 'import type { z } from \'zod\'')
    for (const [specifier, names] of [...imports].sort(([left], [right]) => left.localeCompare(right))) {
      lines.push(`import type { ${names.sort().join(', ')} } from ${quote(specifier)}`)
    }
    lines.push('')
    for (const schema of schemas.exports) {
      lines.push(`export declare const ${schema.exportName}: () => z.ZodType<${schema.exportName}$source>`)
    }
    if (schemas.exports.length > 0) lines.push('')
    // The Loader validates and narrows this generated module boundary before
    // registration. Keeping the public declaration unknown prevents every
    // contributing business package from depending on the runtime registry.
    lines.push('export declare const TYPERT: unknown')
    return `${lines.join('\n')}\n`
  }

  private emitRemote(packageModel: PackageModel): RemoteModelEmitResult {
    const schemas = new SchemaEmitter(
      this.renderer,
      [],
      invocationBoundaryRoots(packageModel.invocations),
    ).emit()
    const lines = [
      '/* Generated by @deepseek-ai/dsh-typert-generator from the Host FaceModel — do not edit. */',
    ]
    if (schemas.definitions.length > 0) lines.push('import { z } from \'zod\'', '')
    lines.push(...schemas.definitions)
    if (schemas.definitions.length > 0) lines.push('')
    lines.push('export const TYPERT_REMOTE = {')
    lines.push(`  package: ${quote(packageModel.name)},`)
    lines.push('  descriptors: [')
    for (const invocation of packageModel.invocations) {
      lines.push(`${indent(this.invocationLiteral(invocation, schemas), 4)},`)
    }
    lines.push('  ],')
    lines.push('}')
    lines.push('')
    lines.push('export default TYPERT_REMOTE')
    const declaration = this.renderRemoteDts(packageModel)
    return {
      js: `${lines.join('\n')}\n`,
      ...declaration,
    }
  }

  private invocationLiteral(invocation: InvocationModel, schemas: SchemaArtifact): string {
    const lines = [
      '{',
      `  id: ${quote(invocation.id)},`,
      `  service: ${quote(invocation.service)},`,
      `  namespace: ${quote(invocation.namespace)},`,
      `  method: ${quote(invocation.method)},`,
    ]
    if (invocation.implementation !== undefined) {
      lines.push(`  implementation: ${quote(invocation.implementation)},`)
    }
    if (invocation.mode !== undefined) lines.push(`  mode: ${quote(invocation.mode)},`)
    if (invocation.invocation.kind === 'direct') {
      lines.push('  invocation: { kind: \'direct\' },')
    } else {
      lines.push('  invocation: {')
      lines.push('    kind: \'context\',')
      lines.push(`    context: ${quote(invocation.invocation.context)},`)
      lines.push(`    wire: ${quote(invocation.invocation.wire)},`)
      lines.push(`    codec: ${indent(strictCodec(
        invocation.invocation.boundary,
        schemas.boundary(contextBoundaryKey(invocation)),
      ), 4).trimStart()},`)
      lines.push('  },')
    }
    if (invocation.scope !== undefined) {
      lines.push('  scope: {')
      lines.push(`    context: ${quote(invocation.scope.context)},`)
      lines.push(`    wire: ${quote(invocation.scope.wire)},`)
      lines.push('  },')
    }
    lines.push('  parameters: [')
    invocation.parameters.forEach((parameter, index) => {
      lines.push('    {')
      lines.push(`      name: ${quote(parameter.name)},`)
      lines.push(`      wire: ${quote(parameter.wire)},`)
      lines.push(`      source: ${quote(parameter.source)},`)
      if (parameter.lookup !== undefined) lines.push(`      lookup: ${quote(parameter.lookup)},`)
      if (parameter.boundary.acceptsUndefined) lines.push('      acceptsUndefined: true,')
      lines.push(`      codec: ${indent(strictCodec(
        parameter.boundary,
        schemas.boundary(parameterBoundaryKey(invocation, index)),
      ), 6).trimStart()},`)
      lines.push('    },')
    })
    lines.push('  ],')
    if (invocation.uplink !== undefined) {
      lines.push('  uplink: {')
      lines.push(`    codec: ${indent(strictCodec(
        invocation.uplink.boundary,
        schemas.boundary(uplinkBoundaryKey(invocation)),
      ), 4).trimStart()},`)
      lines.push('  },')
    }
    if (invocation.cancellation !== undefined) {
      lines.push("  cancellation: { parameter: 'signal' },")
    }
    lines.push(`  result: ${indent(strictCodec(
      invocation.result,
      schemas.boundary(resultBoundaryKey(invocation)),
      schemas.encoder(resultBoundaryKey(invocation)),
    ), 2).trimStart()},`)
    lines.push(`  sourceLocation: ${JSON.stringify(invocation.location)},`)
    lines.push('}')
    return lines.join('\n')
  }

  private renderRemoteDts(packageModel: PackageModel): Pick<RemoteModelEmitResult, 'dts' | 'dtsMap'> {
    const imports = remoteImports(packageModel.invocations)
    const referenceNames = allocateRemoteImportNames(imports)
    const grouped = new Map<string, { readonly name: string; readonly local: string }[]>()
    for (const imported of imports) {
      const values = grouped.get(imported.specifier) ?? []
      values.push({
        name: imported.name,
        local: referenceNames.get(imported.symbol) as string,
      })
      grouped.set(imported.specifier, values)
    }
    // A stream method's Client signature returns the handle; `RemoteStream` names
    // what the Host method returns.
    const lines = [
      '/* Generated by @deepseek-ai/dsh-typert-generator from the Host FaceModel — do not edit. */',
      'import type {',
      '  RemoteResult,',
      ...packageModel.invocations.some(invocation => invocation.mode === 'stream') ? ['  RemoteStreamHandle,'] : [],
      '  TypertRemoteContribution,',
      '} from \'@deepseek-ai/dsh-typert-protocol\'',
    ]
    const sourceMap = new GenMapping({ file: 'typert.remote-client.d.ts' })
    for (const [specifier, values] of [...grouped].sort(([left], [right]) => left.localeCompare(right))) {
      const names = values.sort((left, right) => left.local.localeCompare(right.local)).map(value =>
        value.name === value.local ? value.name : `${value.name} as ${value.local}`)
      lines.push(`import type { ${names.join(', ')} } from ${quote(specifier)}`)
    }
    lines.push('')
    if (packageModel.invocations.some(invocation => containsBytes(this.renderer, invocation.result.codecType))) {
      lines.push('type RemoteDecoded<Value> = Value extends Uint8Array ? Uint8Array<ArrayBuffer>')
      lines.push('  : Value extends string | number | boolean | null | undefined ? Value')
      lines.push('  : { [Key in keyof Value]: RemoteDecoded<Value[Key]> }')
      lines.push('')
    }
    lines.push('declare module \'@deepseek-ai/dsh-typert-protocol\' {')
    const direct = packageModel.invocations.filter(invocation => invocation.invocation.kind === 'direct')
    const scoped = packageModel.invocations.filter(invocation =>
      invocation.invocation.kind === 'context' || invocation.scope !== undefined)
    if (direct.length > 0) {
      for (const namespace of uniqueNamespaces(direct)) {
        lines.push(`  interface ${remoteNamespaceInterface(namespace)} {`)
        for (const invocation of direct.filter(candidate => candidate.namespace === namespace)) {
          this.pushRemoteNamespaceSignature(lines, sourceMap, packageModel, invocation, referenceNames)
        }
        lines.push('  }')
      }
      lines.push('  interface TypertRemoteMap {')
      for (const invocation of direct) {
        this.pushRemoteSignature(lines, sourceMap, packageModel, invocation, referenceNames, false)
      }
      lines.push('  }')
      lines.push('  interface TypertRemoteNamespaceMap {')
      for (const namespace of uniqueNamespaces(direct)) {
        lines.push(`    ${quote(namespace)}: ${remoteNamespaceInterface(namespace)}`)
      }
      lines.push('  }')
    }
    if (scoped.length > 0) {
      lines.push('  interface TypertRemoteScopeMap {')
      for (const invocation of scoped) {
        this.pushRemoteSignature(lines, sourceMap, packageModel, invocation, referenceNames, true)
      }
      lines.push('  }')
    }
    lines.push('}')
    lines.push('')
    lines.push('export declare const TYPERT_REMOTE: TypertRemoteContribution')
    lines.push('export default TYPERT_REMOTE')
    lines.push('//# sourceMappingURL=typert.remote-client.d.ts.map')
    return {
      dts: `${lines.join('\n')}\n`,
      dtsMap: `${JSON.stringify(toEncodedMap(sourceMap))}\n`,
    }
  }

  private pushRemoteSignature(
    lines: string[],
    sourceMap: GenMapping,
    packageModel: PackageModel,
    invocation: InvocationModel,
    referenceNames: ReadonlyMap<SymbolId, string>,
    scoped: boolean,
  ): void {
    const signature = this.remoteSignature(invocation, referenceNames, scoped)
    const keyLength = signature.indexOf(': (')
    if (keyLength < 0) throw new TypertEmitError(`Remote signature ${invocation.id} has no property delimiter`)
    this.pushMappedRemoteSignature(lines, sourceMap, packageModel, invocation, signature, keyLength)
  }

  private pushRemoteNamespaceSignature(
    lines: string[],
    sourceMap: GenMapping,
    packageModel: PackageModel,
    invocation: InvocationModel,
    referenceNames: ReadonlyMap<SymbolId, string>,
  ): void {
    const key = renderRemotePropertyName(invocation.method)
    const signature = `${key}: ${this.remoteFunctionType(invocation, referenceNames, false)}`
    this.pushMappedRemoteSignature(lines, sourceMap, packageModel, invocation, signature, key.length)
  }

  private pushMappedRemoteSignature(
    lines: string[],
    sourceMap: GenMapping,
    packageModel: PackageModel,
    invocation: InvocationModel,
    signature: string,
    keyLength: number,
  ): void {
    lines.push(`    ${signature}`)
    const generatedLine = lines.length
    const source = remoteDeclarationSource(packageModel, invocation)
    addMapping(sourceMap, {
      generated: { line: generatedLine, column: 4 },
      source,
      original: { line: invocation.location.line, column: invocation.location.column - 1 },
      name: invocation.method,
    })
    addMapping(sourceMap, {
      generated: { line: generatedLine, column: 4 + keyLength },
    })
  }

  private remoteSignature(
    invocation: InvocationModel,
    referenceNames: ReadonlyMap<SymbolId, string>,
    scoped: boolean,
  ): string {
    const context = invocation.invocation.kind === 'context'
      ? invocation.invocation.context
      : invocation.scope?.context
    const key = scoped
      ? `${context as string}:${invocation.namespace}/${invocation.method}`
      : `${invocation.namespace}/${invocation.method}`
    return `${quote(key)}: ${this.remoteFunctionType(invocation, referenceNames, scoped)}`
  }

  private remoteFunctionType(
    invocation: InvocationModel,
    referenceNames: ReadonlyMap<SymbolId, string>,
    scoped: boolean,
  ): string {
    const parameters = invocation.parameters.filter(parameter =>
      !scoped || invocation.invocation.kind === 'context' || parameter.wire !== invocation.scope?.wire).map(parameter =>
      `${safeIdentifier(parameter.wire)}${parameter.optional === true ? '?' : ''}: ${this.renderer.renderType(parameter.boundary.type, referenceNames)}`)
    if (invocation.cancellation !== undefined) parameters.push('signal?: AbortSignal')
    const authoredResult = this.renderer.renderType(invocation.result.type, referenceNames)
    const result = containsBytes(this.renderer, invocation.result.codecType)
      ? `RemoteDecoded<${authoredResult}>`
      : authoredResult
    if (invocation.mode === 'stream') {
      const uplink = invocation.uplink === undefined
        ? 'never'
        : this.renderer.renderType(invocation.uplink.boundary.type, referenceNames)
      return `(${parameters.join(', ')}) => RemoteStreamHandle<${result}, ${uplink}>`
    }
    // The unary Client Remote face delivers the carrier's outcome, so every
    // generated consumer signature resolves to a result the caller reads.
    return `(${parameters.join(', ')}) => Promise<RemoteResult<${result}>>`
  }
}

function remoteDeclarationSource(packageModel: PackageModel, invocation: InvocationModel): string {
  const relativeSource = posix.relative(packageModel.root, invocation.location.file)
  if (relativeSource === '' || relativeSource === '..' || relativeSource.startsWith('../') || posix.isAbsolute(relativeSource)) {
    throw new TypertEmitError(
      `Remote declaration ${invocation.id} is outside its package root ${packageModel.root}`,
    )
  }
  return posix.join('..', relativeSource)
}

function uniqueNamespaces(invocations: readonly InvocationModel[]): string[] {
  return [...new Set(invocations.map(invocation => invocation.namespace))].sort()
}

function remoteNamespaceInterface(namespace: string): string {
  return `TypertRemoteNamespace$${Buffer.from(namespace, 'utf8').toString('hex')}`
}

interface SchemaExport {
  readonly model: SchemaModel
  readonly exportName: string
  readonly internalName: string
}

interface SchemaArtifact {
  readonly definitions: readonly string[]
  readonly exports: readonly SchemaExport[]
  boundary(key: string): string
  encoder(key: string): string | undefined
}

interface BoundarySchemaRoot {
  readonly key: string
  readonly type: TypeNodeId
}

class ResultEncoderEmitter {
  private readonly names = new Map<TypeNodeId, string>()
  private readonly bodies = new Map<TypeNodeId, string>()

  constructor(private readonly renderer: TypeGraphRenderer) {}

  reference(id: TypeNodeId): string | undefined {
    if (!containsBytes(this.renderer, id)) return undefined
    const existing = this.names.get(id)
    if (existing !== undefined) return existing
    const name = `$encode${this.names.size}`
    this.names.set(id, name)
    const node = this.renderer.node(id)
    const container = node.kind === 'object' || node.kind === 'array' || node.kind === 'tuple'
    const body = container || node.kind === 'union' || node.kind === 'intersection'
      ? `return $resultContainer(value, path, ancestors, value => {\n${indent(this.body(id), 2)}\n}, ${container})`
      : this.body(id)
    this.bodies.set(id, `const ${name} = (value, writeBytes, path, ancestors) => {\n${indent(body, 2)}\n}`)
    return name
  }

  definitions(): string[] {
    return this.bodies.size === 0 ? [] : [RESULT_SNAPSHOT, ...this.bodies.values()]
  }

  private call(id: TypeNodeId, value: string, path = 'path'): string {
    const reference = this.reference(id)
    return reference === undefined ? value : `${reference}(${value}, writeBytes, ${path}, ancestors)`
  }

  private body(id: TypeNodeId): string {
    const node = this.renderer.node(id)
    switch (node.kind) {
      case 'reference': {
        if (node.target.kind === 'standard' && node.target.name === 'Uint8Array') {
          return 'return value instanceof Uint8Array ? writeBytes(value, path) : value'
        }
        if (node.target.kind === 'declaration') {
          const type = this.renderer.declaration(node.target.symbol).type
          if (type !== undefined) return `return ${this.call(type, 'value')}`
        }
        break
      }
      case 'union':
      case 'intersection': return [
        ...node.types.filter(type => containsBytes(this.renderer, type)).map(type => `value = ${this.call(type, 'value')}`),
        'return value',
      ].join('\n')
      case 'array': return [
        'if (!Array.isArray(value)) return value',
        `for (let index = 0; index < value.length; index++) value[index] = ${this.call(node.element, 'value[index]', '[...path, index]')}`,
        'return value',
      ].join('\n')
      case 'tuple': {
        const lines = ['if (!Array.isArray(value)) return value']
        for (const [index, element] of node.elements.entries()) {
          if (!containsBytes(this.renderer, element.type)) continue
          if (element.rest) {
            const rest = this.renderer.node(element.type)
            if (rest.kind !== 'array') break
            lines.push(`for (let index = ${index}; index < value.length; index++) value[index] = ${this.call(rest.element, 'value[index]', '[...path, index]')}`)
          } else {
            lines.push(`if (value.length > ${index}) value[${index}] = ${this.call(element.type, `value[${index}]`, `[...path, ${index}]`)}`)
          }
        }
        return [...lines, 'return value'].join('\n')
      }
      case 'object': {
        const lines = ["if (value === null || typeof value !== 'object' || Array.isArray(value) || value instanceof Uint8Array) return value"]
        for (const member of node.members) {
          if (member.kind === 'property' && containsBytes(this.renderer, member.type)) {
            const key = quote(member.name)
            lines.push(`if (Object.hasOwn(value, ${key})) value[${key}] = ${this.call(member.type, `value[${key}]`, `[...path, ${key}]`)}`)
          } else if (member.kind === 'index' && containsBytes(this.renderer, member.signature.returns)) {
            lines.push(`for (const key of Object.keys(value)) value[key] = ${this.call(member.signature.returns, 'value[key]', '[...path, key]')}`)
          }
        }
        return [...lines, 'return value'].join('\n')
      }
      default: break
    }
    throw new TypertEmitError(`typert result encoder: ${node.kind} has no binary field projection`)
  }
}

const RESULT_SNAPSHOT = `const $resultSnapshot = (input, path) => {
  if (input === null || typeof input !== 'object' || input instanceof Uint8Array) return input
  const toJSON = input.toJSON
  const value = typeof toJSON === 'function' ? toJSON.call(input, path.at(-1)?.toString() ?? 'value') : input
  if (value === null || typeof value !== 'object' || value instanceof Uint8Array) return value
  if (Array.isArray(value)) {
    const items = []
    for (let index = 0, length = value.length; index < length; index++) items.push(value[index])
    return items
  }
  const fields = {}
  for (const key of Object.keys(value)) {
    const item = key === 'toJSON' && value === input ? toJSON : value[key]
    if (key === 'toJSON' && typeof item === 'function') continue
    Object.defineProperty(fields, key, { value: item, enumerable: true, writable: true, configurable: true })
  }
  return fields
}
const $resultContainer = (input, path, ancestors, project, snapshot) => {
  if (input === null || typeof input !== 'object') return project(input)
  const owner = !ancestors.has(input)
  if (!owner && ancestors.get(input) !== path.length) throw new TypeError('Remote result contains a circular object')
  if (owner) ancestors.set(input, path.length)
  try { return project(snapshot ? $resultSnapshot(input, path) : input) }
  finally { if (owner) ancestors.delete(input) }
}`

class SchemaEmitter {
  private readonly names = new Map<SymbolId, string>()
  private readonly boundaryNames = new Map<string, string>()
  private readonly declarations: TypeDeclarationModel[]

  constructor(
    private readonly renderer: TypeGraphRenderer,
    private readonly schemas: readonly SchemaModel[],
    private readonly boundaries: readonly BoundarySchemaRoot[],
  ) {
    const declarations = new Map<SymbolId, TypeDeclarationModel>()
    for (const schema of schemas) {
      for (const declaration of renderer.declarationClosureForTypes([schema.type])) {
        declarations.set(declaration.id, declaration)
      }
    }
    for (const boundary of boundaries) {
      for (const declaration of renderer.declarationClosureForTypes([boundary.type])) {
        declarations.set(declaration.id, declaration)
      }
    }
    this.declarations = renderer.graph.declarations.filter(declaration => declarations.has(declaration.id))
    const identifiers = new Set<string>()
    for (const declaration of this.declarations) {
      const base = `${safeIdentifier(declaration.name)}$schema`
      let name = base
      let suffix = 2
      while (identifiers.has(name)) name = `${base}${String(suffix++)}`
      identifiers.add(name)
      this.names.set(declaration.id, name)
    }
    for (const boundary of boundaries) {
      const base = `${safeIdentifier(boundary.key)}$schema`
      let name = base
      let suffix = 2
      while (identifiers.has(name)) name = `${base}${String(suffix++)}`
      identifiers.add(name)
      this.boundaryNames.set(boundary.key, name)
    }
  }

  emit(): SchemaArtifact {
    const definitions = this.declarations.map(declaration => this.declarationDefinition(declaration))
    const encoder = new ResultEncoderEmitter(this.renderer)
    const encoders = new Map<string, string>()
    for (const boundary of this.boundaries) {
      const encode = encoder.reference(boundary.type)
      if (encode !== undefined) encoders.set(boundary.key, encode)
      const name = this.boundaryName(boundary.key)
      definitions.push(`let ${name}$value\nconst ${name} = () => (${name}$value ??= ${this.typeSchema(boundary.type)})`)
    }
    definitions.push(...encoder.definitions())
    const exports = this.schemas.map((model): SchemaExport => ({
      model,
      exportName: safeIdentifier(model.export.name),
      internalName: this.exportSchemaName(model),
    }))
    return {
      definitions,
      exports,
      boundary: key => this.boundaryName(key),
      encoder: key => encoders.get(key),
    }
  }

  private declarationDefinition(declaration: TypeDeclarationModel): string {
    const name = this.schemaName(declaration.id)
    if (declaration.typeParameters.length === 0) {
      return `let ${name}$value\nconst ${name} = () => (${name}$value ??= ${this.declarationSchema(declaration, new Map())})`
    }
    const parameters = declaration.typeParameters.map((parameter, index) =>
      [`type${String(index)}$schema`, parameter.id] as const)
    const substitutions = new Map(parameters.map(([schema, id]) => [id, schema]))
    return `const ${name} = (${parameters.map(([schema]) => schema).join(', ')}) => ${this.declarationSchema(declaration, substitutions)}`
  }

  private declarationSchema(
    declaration: TypeDeclarationModel,
    substitutions: ReadonlyMap<string, string>,
  ): string {
    if (declaration.kind === 'enum') {
      this.fail(declaration.name, 'enum declarations have no Zod projection')
    }
    if (declaration.kind === 'alias') {
      if (declaration.type === undefined) this.fail(declaration.name, 'alias has no modeled type')
      return this.describe(this.typeSchema(declaration.type, substitutions), declaration)
    }
    const own = this.objectSchema(declaration.members, declaration.name, substitutions)
    let result = own
    for (const heritage of declaration.extends) {
      result = `z.intersection(${this.typeSchema(heritage, substitutions)}, ${result})`
    }
    return this.describe(result, declaration)
  }

  private typeSchema(id: TypeNodeId, substitutions: ReadonlyMap<string, string> = new Map()): string {
    const node = this.renderer.node(id)
    switch (node.kind) {
      case 'keyword': return this.keywordSchema(node.name)
      case 'literal': return `z.literal(${node.text})`
      case 'parenthesized': return this.typeSchema(node.type, substitutions)
      case 'reference': return this.referenceSchema(node, substitutions)
      case 'union': {
        if (node.types.length === 0) return 'z.never()'
        if (node.types.length === 1) return this.typeSchema(node.types[0] as TypeNodeId, substitutions)
        return `z.union([${node.types.map(type => this.typeSchema(type, substitutions)).join(', ')}])`
      }
      case 'intersection': {
        const [head, ...tail] = node.types
        if (head === undefined) return 'z.unknown()'
        return tail.reduce(
          (left, right) => `z.intersection(${left}, ${this.typeSchema(right, substitutions)})`,
          this.typeSchema(head, substitutions),
        )
      }
      case 'array': return `z.array(${this.typeSchema(node.element, substitutions)})`
      case 'tuple': {
        const fixed = node.elements.filter(element => !element.rest)
        const rest = node.elements.find(element => element.rest)
        let schema = `z.tuple([${fixed.map(element => this.optional(this.typeSchema(element.type, substitutions), element.optional)).join(', ')}])`
        if (rest !== undefined) schema += `.rest(${this.tupleRestSchema(rest.type, substitutions)})`
        return schema
      }
      case 'object': return this.objectSchema(node.members, id, substitutions)
      case 'operator':
      case 'indexed-access':
      case 'conditional':
      case 'infer':
      case 'mapped':
      case 'template-literal':
      case 'type-query':
      case 'import-type':
      case 'predicate':
      case 'function':
      case 'constructor':
      case 'this': return this.unsupported(node)
    }
  }

  private referenceSchema(
    node: Extract<TypeNodeModel, { kind: 'reference' }>,
    substitutions: ReadonlyMap<string, string>,
  ): string {
    if (node.target.kind === 'declaration') {
      const name = this.schemaName(node.target.symbol)
      const declaration = this.renderer.declaration(node.target.symbol)
      if (declaration.typeParameters.length === 0) {
        if (node.arguments.length > 0) {
          this.fail(node.name, `non-generic declaration received ${String(node.arguments.length)} type arguments`)
        }
        return `z.lazy(() => ${name}())`
      }
      const arguments_ = this.declarationArguments(node, declaration, substitutions)
      return `z.lazy(() => ${name}(${arguments_.join(', ')}))`
    }
    if (node.target.kind === 'type-parameter') {
      if (node.arguments.length > 0) this.fail(node.name, 'type parameter reference cannot receive type arguments')
      const schema = substitutions.get(node.target.parameter)
      if (schema === undefined) this.fail(node.name, 'type parameter has no schema substitution')
      return schema
    }
    if (node.target.kind === 'standard') {
      switch (node.target.name) {
        case 'Array':
        case 'ReadonlyArray': {
          const element = node.arguments[0]
          if (element === undefined) this.fail(node.name, 'array reference has no element type')
          return this.readonly(
            `z.array(${this.typeSchema(element, substitutions)})`,
            node.target.name === 'ReadonlyArray',
          )
        }
        case 'Record': {
          const key = node.arguments[0]
          const value = node.arguments[1]
          if (key === undefined || value === undefined) this.fail(node.name, 'Record requires key and value types')
          return `z.record(${this.typeSchema(key, substitutions)}, ${this.typeSchema(value, substitutions)})`
        }
        case 'Date': return 'z.date()'
        case 'Uint8Array': return 'z.instanceof(Uint8Array)'
        default: this.fail(node.name, `standard type ${node.target.name} has no Zod projection`)
      }
    }
    this.fail(node.name, `${node.target.kind} reference has no Zod projection`)
  }

  private declarationArguments(
    node: Extract<TypeNodeModel, { kind: 'reference' }>,
    declaration: TypeDeclarationModel,
    substitutions: ReadonlyMap<string, string>,
  ): string[] {
    if (node.arguments.length > declaration.typeParameters.length) {
      this.fail(
        node.name,
        `generic declaration accepts ${String(declaration.typeParameters.length)} type arguments but received ${String(node.arguments.length)}`,
      )
    }
    const resolved = new Map(substitutions)
    const arguments_: string[] = []
    for (const [index, parameter] of declaration.typeParameters.entries()) {
      const argument = node.arguments[index]
      const schema = argument === undefined
        ? parameter.default === undefined
          ? this.fail(node.name, `missing type argument ${parameter.name}`)
          : this.typeSchema(parameter.default, resolved)
        : this.typeSchema(argument, substitutions)
      arguments_.push(schema)
      resolved.set(parameter.id, schema)
    }
    return arguments_
  }

  private tupleRestSchema(id: TypeNodeId, substitutions: ReadonlyMap<string, string>): string {
    const node = this.renderer.node(id)
    if (node.kind === 'array') return this.typeSchema(node.element, substitutions)
    if (node.kind === 'reference'
      && node.target.kind === 'standard'
      && (node.target.name === 'Array' || node.target.name === 'ReadonlyArray')) {
      const element = node.arguments[0]
      if (element === undefined) this.fail(node.name, 'tuple rest array has no element type')
      return this.typeSchema(element, substitutions)
    }
    this.fail(id, 'tuple rest element must retain an array type')
  }

  private objectSchema(
    members: readonly MemberModel[],
    subject: string,
    substitutions: ReadonlyMap<string, string>,
  ): string {
    const properties: string[] = []
    const indices: string[] = []
    let symbolMembers = 0
    for (const member of members) {
      if (member.static || member.visibility !== 'public') continue
      if (member.computed === 'symbol') {
        symbolMembers++
        continue
      }
      if (member.computed === 'dynamic') {
        this.fail(subject, `computed member ${member.name} has no fixed JSON property name`)
      }
      if (member.kind === 'index') {
        const parameter = member.signature.parameters[0]
        if (member.signature.parameters.length !== 1 || parameter === undefined) {
          this.fail(subject, 'index signature must have exactly one key parameter')
        }
        indices.push(this.readonly(
          `z.record(${this.typeSchema(parameter.type, substitutions)}, ${this.typeSchema(member.signature.returns, substitutions)})`,
          member.readonly,
        ))
        continue
      }
      if (member.kind !== 'property') this.fail(subject, `${member.kind} member ${member.name} is not data-schema projectable`)
      // Freezing a union may freeze its populated Uint8Array member.
      const schema = this.readonly(this.typeSchema(member.type, substitutions),
        member.readonly && !containsBytes(this.renderer, member.type, false))
      const property = this.describe(
        this.optional(schema, member.optional),
        member,
      )
      properties.push(`${quote(member.jsonName ?? member.name)}: ${property}`)
    }
    if (indices.length > 1) this.fail(subject, 'object type has more than one JSON index signature')
    // A unique-symbol-only object is a compile-time marker and imposes no JSON shape.
    if (properties.length === 0 && indices.length === 0 && symbolMembers > 0) return 'z.unknown()'
    const object = `z.object({${properties.length === 0 ? '' : `\n${properties.map(property => `  ${property},`).join('\n')}\n`}})`
    const index = indices[0]
    if (index === undefined) return object
    if (properties.length === 0) return index
    return `z.intersection(${object}, ${index})`
  }

  private exportSchemaName(model: SchemaModel): string {
    const name = this.schemaName(model.symbol)
    const declaration = this.renderer.declaration(model.symbol)
    if (declaration.typeParameters.length > 0) {
      this.fail(model.export.name, 'generic schema exports require a concrete declaration')
    }
    return name
  }

  private keywordSchema(name: string): string {
    switch (name) {
      case 'any': return 'z.any()'
      case 'unknown': return 'z.unknown()'
      case 'never': return 'z.never()'
      case 'string': return 'z.string()'
      case 'number': return 'z.number()'
      case 'bigint': return 'z.bigint()'
      case 'boolean': return 'z.boolean()'
      case 'symbol': return 'z.symbol()'
      case 'undefined': return 'z.undefined()'
      case 'void': return 'z.void()'
      case 'object': return "z.custom((value) => (typeof value === 'object' && value !== null) || typeof value === 'function')"
      default: this.fail(name, `keyword ${name} has no Zod projection`)
    }
  }

  private schemaName(symbol: SymbolId): string {
    const name = this.names.get(symbol)
    if (name === undefined) this.fail(symbol, 'referenced declaration is outside the selected schema closure')
    return name
  }

  private boundaryName(key: string): string {
    const name = this.boundaryNames.get(key)
    if (name === undefined) this.fail(key, 'invocation boundary is outside the selected schema roots')
    return name
  }

  private describe(schema: string, documentation: DocumentationModel): string {
    return documentation.description === undefined ? schema : `${schema}.describe(${quote(documentation.description)})`
  }

  private optional(schema: string, optional: boolean): string {
    return optional ? `${schema}.optional()` : schema
  }

  private readonly(schema: string, readonly: boolean): string {
    return readonly ? `${schema}.readonly()` : schema
  }

  private unsupported(node: TypeNodeModel): never {
    this.fail(node.id, `type node ${node.kind} has no Zod projection`)
  }

  private fail(subject: string, message: string): never {
    throw new TypertEmitError(`typert Zod emitter: ${subject}: ${message}`)
  }
}

function documentationLiteral(documentation: DocumentationModel): DocumentationModel {
  return {
    ...(documentation.description === undefined ? {} : { description: documentation.description }),
    ...(documentation.summary === undefined ? {} : { summary: documentation.summary }),
    tags: documentation.tags,
    ...(documentation.jsDoc === undefined ? {} : { jsDoc: documentation.jsDoc }),
  }
}

function invocationBoundaryRoots(invocations: readonly InvocationModel[]): BoundarySchemaRoot[] {
  const result: BoundarySchemaRoot[] = []
  for (const invocation of invocations) {
    if (invocation.invocation.kind === 'context') {
      result.push({ key: contextBoundaryKey(invocation), type: invocation.invocation.boundary.codecType })
    }
    invocation.parameters.forEach((parameter, index) => {
      result.push({ key: parameterBoundaryKey(invocation, index), type: parameter.boundary.codecType })
    })
    if (invocation.uplink !== undefined) {
      result.push({ key: uplinkBoundaryKey(invocation), type: invocation.uplink.boundary.codecType })
    }
    result.push({ key: resultBoundaryKey(invocation), type: invocation.result.codecType })
  }
  return result
}

function contextBoundaryKey(invocation: InvocationModel): string {
  return `${invocation.id}:context`
}

function uplinkBoundaryKey(invocation: InvocationModel): string {
  return `${invocation.id}:uplink`
}

function parameterBoundaryKey(invocation: InvocationModel, index: number): string {
  return `${invocation.id}:parameter:${String(index)}`
}

function resultBoundaryKey(invocation: InvocationModel): string {
  return `${invocation.id}:result`
}

function containsBytes(
  renderer: TypeGraphRenderer,
  id: TypeNodeId,
  nested = true,
  visited = new Set<TypeNodeId>(),
): boolean {
  if (visited.has(id)) return false
  visited.add(id)
  const node = renderer.node(id)
  if (node.kind === 'reference') {
    if (node.target.kind === 'standard' && node.target.name === 'Uint8Array') return true
    if (node.target.kind === 'declaration') {
      const declaration = renderer.declaration(node.target.symbol)
      if (declaration.type !== undefined && containsBytes(renderer, declaration.type, nested, visited)) return true
    }
    if (!nested) return false
  }
  if (!nested && node.kind !== 'reference' && node.kind !== 'parenthesized'
    && node.kind !== 'union' && node.kind !== 'intersection') return false
  if (node.kind === 'object' && node.members.some(member =>
    containsBytes(renderer, member.kind === 'property' ? member.type : member.signature.returns, nested, visited))) return true
  return childTypeNodeIds(node).some(child => containsBytes(renderer, child, nested, visited))
}

function strictCodec(boundary: RemoteBoundaryModel, schema: string, encoder?: string): string {
  return [
    '{',
    '  mode: \'strict\',',
    `  typeSymbol: ${quote(boundary.typeSymbol)},`,
    `  create: ${schema},`,
    ...(encoder === undefined ? [] : [
      `  decode: value => ${schema}().parse(value),`,
      `  encode: (value, writeBytes) => ${encoder}(value, writeBytes, [], new Map()),`,
    ]),
    '}',
  ].join('\n')
}

function remoteImports(invocations: readonly InvocationModel[]): RemoteTypeImportModel[] {
  const imports = new Map<SymbolId, RemoteTypeImportModel>()
  const add = (boundary: RemoteBoundaryModel): void => {
    for (const imported of boundary.imports) {
      const current = imports.get(imported.symbol)
      if (current !== undefined
        && (current.specifier !== imported.specifier || current.name !== imported.name)) {
        throw new TypertEmitError(`typert Remote emitter: symbol ${imported.symbol} has inconsistent public imports`)
      }
      imports.set(imported.symbol, imported)
    }
  }
  for (const invocation of invocations) {
    if (invocation.invocation.kind === 'context') add(invocation.invocation.boundary)
    for (const parameter of invocation.parameters) add(parameter.boundary)
    if (invocation.uplink !== undefined) add(invocation.uplink.boundary)
    add(invocation.result)
  }
  return [...imports.values()].sort((left, right) =>
    left.specifier.localeCompare(right.specifier) || left.name.localeCompare(right.name))
}

function allocateRemoteImportNames(imports: readonly RemoteTypeImportModel[]): ReadonlyMap<SymbolId, string> {
  const used = new Set([
    'RemoteDecoded',
    'RemoteResult',
    'RemoteStreamHandle',
    'TypertRemoteContribution',
    'TYPERT_REMOTE',
  ])
  const names = new Map<SymbolId, string>()
  for (const imported of imports) {
    const base = safeIdentifier(imported.name)
    let name = base
    let suffix = 2
    while (used.has(name)) name = `${base}$remote${String(suffix++)}`
    used.add(name)
    names.set(imported.symbol, name)
  }
  return names
}

function packageExportSpecifier(packageName: string, subpath: string): string {
  return subpath === '.' ? packageName : `${packageName}${subpath.slice(1)}`
}

function safeIdentifier(name: string): string {
  const normalized = name.replace(/[^$\w]/gu, '_')
  if (/^[$A-Z_a-z]/u.test(normalized)) return normalized
  return `_${normalized}`
}

function renderRemotePropertyName(name: string): string {
  return /^[$A-Z_a-z][$\w]*$/u.test(name) ? name : quote(name)
}

function quote(value: string): string {
  return `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'").replaceAll('\n', '\\n').replaceAll('\r', '\\r')}'`
}

function indent(value: string, spaces: number): string {
  const prefix = ' '.repeat(spaces)
  return value.split('\n').map(line => `${prefix}${line}`).join('\n')
}
