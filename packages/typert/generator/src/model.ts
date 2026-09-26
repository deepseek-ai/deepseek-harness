/**
 * Compiler-independent Typert analysis model. TypeScript nodes and checker
 * objects are extraction inputs only; emitters consume this graph.
 * @module @deepseek-ai/dsh-typert-generator/model
 */

/** One independently compiled side of the workspace. */
export type TypertFace = 'host' | 'client'

/** Stable graph-local identifier of a type expression. */
export type TypeNodeId = string

/** Stable workspace identifier of a declared symbol. */
export type SymbolId = string

/** Keyword types accepted in ordinary TypeScript source declarations. */
export type KeywordTypeName =
  | 'any'
  | 'bigint'
  | 'boolean'
  | 'never'
  | 'number'
  | 'object'
  | 'string'
  | 'symbol'
  | 'undefined'
  | 'unknown'
  | 'void'

/** Prefix operators accepted on TypeScript type nodes. */
export type TypeOperatorName = 'keyof' | 'readonly' | 'unique'

/** Source position retained for diagnostics and source-edit mode. */
export interface SourceLocation {
  readonly file: string
  readonly line: number
  readonly column: number
}

/** One public package export and the declaration it resolves to. */
export interface ExportModel {
  readonly subpath: string
  readonly name: string
  readonly symbol: SymbolId
  readonly aliases: readonly string[]
}

/** One structured JSDoc tag, retaining its original text for unknown tags. */
export interface JsDocTagModel {
  readonly name: string
  readonly argument?: string
  readonly comment?: string
  readonly text: string
}

/** JSDoc retained as a standard part of every documented model element. */
export interface DocumentationModel {
  readonly description?: string
  readonly summary?: string
  readonly tags: readonly JsDocTagModel[]
  readonly jsDoc?: string
}

/** One Cordis Context contribution. */
export interface ServiceModel extends DocumentationModel {
  readonly key: string
  readonly symbol: SymbolId
  readonly export: ExportModel
  readonly members: readonly string[]
  readonly location: SourceLocation
}

/** One Cordis Events contribution. */
export interface EventModel extends DocumentationModel {
  readonly name: string
  readonly signature: TypeNodeId
  /** Body-free declaration text retained for byte-stable source projections. */
  readonly text: string
  readonly mode?: string
  readonly location: SourceLocation
}

/** One explicitly exported reference-passed object. */
export interface ObjectModel extends DocumentationModel {
  readonly export: ExportModel
  readonly symbol: SymbolId
  readonly passing: 'reference'
}

/** One explicitly selected value type for schema generation. */
export interface SchemaModel extends DocumentationModel {
  readonly export: ExportModel
  readonly symbol: SymbolId
  readonly type: TypeNodeId
}

/** One public business type import retained for a generated Remote declaration. */
export interface RemoteTypeImportModel {
  readonly symbol: SymbolId
  readonly specifier: string
  readonly name: string
}

/** One strict wire boundary and the public symbols needed to name it. */
export interface RemoteBoundaryModel {
  /** Authored public type retained for generated consumer declarations. */
  readonly type: TypeNodeId
  /** Checker-resolved projection used only to emit the runtime codec. */
  readonly codecType: TypeNodeId
  /** Whether the authored top-level boundary explicitly accepts `undefined`. */
  readonly acceptsUndefined: boolean
  readonly typeSymbol: string
  readonly imports: readonly RemoteTypeImportModel[]
}

/** One ordered business argument projected onto a Remote wire field. */
export interface InvocationParameterModel {
  readonly name: string
  readonly wire: string
  readonly source: 'json' | 'lookup'
  readonly lookup?: string
  /** Authored as an optional parameter, so consumers may omit the wire field. */
  readonly optional?: true
  readonly boundary: RemoteBoundaryModel
}

/** One strictly analyzed Host method exported through Typert Gateway. */
export interface InvocationModel {
  readonly id: string
  readonly service: string
  readonly namespace: string
  readonly method: string
  readonly implementation?: string
  readonly mode?: 'stream'
  readonly invocation:
    | { readonly kind: 'direct' }
    | {
      readonly kind: 'context'
      readonly context: string
      readonly wire: string
      readonly boundary: RemoteBoundaryModel
    }
  readonly scope?: {
    readonly context: string
    readonly wire: string
  }
  readonly parameters: readonly InvocationParameterModel[]
  /** Per-item boundary of the Client uplink, from the `In` type argument of `RemoteStream<Out, In>`; absent when the method reads none. */
  readonly uplink?: {
    readonly boundary: RemoteBoundaryModel
  }
  readonly cancellation?: {
    readonly parameter: 'signal'
  }
  readonly result: RemoteBoundaryModel
  readonly location: SourceLocation
}

/** Business semantics discovered in one package on one face. */
export interface PackageModel {
  readonly name: string
  readonly root: string
  readonly exports: readonly ExportModel[]
  readonly services: readonly ServiceModel[]
  readonly events: readonly EventModel[]
  readonly objects: readonly ObjectModel[]
  readonly schemas: readonly SchemaModel[]
  readonly invocations: readonly InvocationModel[]
}

/** One explicit import/re-export edge between independently compiled faces. */
export interface CrossFaceLink {
  readonly fromFace: TypertFace
  readonly fromPackage: string
  readonly toFace: TypertFace
  readonly toPackage: string
  readonly subpath: string
  readonly name: string
}

/** Complete analysis result for an independently compiled face. */
export interface FaceModel {
  readonly face: TypertFace
  readonly packages: readonly PackageModel[]
  readonly graph: TypeGraph
}

/** Complete host/client analysis result. */
export interface WorkspaceModel {
  readonly faces: readonly FaceModel[]
  readonly crossFaceLinks: readonly CrossFaceLink[]
}

/** One top-level authored type declaration indexed without making it a graph root. */
export interface SourceDeclarationModel {
  readonly face: TypertFace
  readonly package: string
  readonly name: string
  readonly kind: 'interface' | 'class' | 'alias' | 'enum'
  readonly location: SourceLocation
  readonly text: string
}

/** Visibility recorded on class members. */
export type MemberVisibility = 'public' | 'protected' | 'private'

/** One generic type parameter, preserving its pre-evaluation constraint/default. */
export interface TypeParameterModel {
  readonly id: string
  readonly name: string
  readonly const: boolean
  readonly constraint?: TypeNodeId
  readonly default?: TypeNodeId
  readonly variance?: 'in' | 'out' | 'in-out'
}

/** One function-like parameter. */
export interface ParameterModel {
  readonly name: string
  readonly binding: 'identifier' | 'object' | 'array'
  readonly type: TypeNodeId
  readonly optional: boolean
  readonly rest: boolean
  readonly receiver: boolean
  readonly initializer?: string
}

/** A function/call/construct signature. */
export interface SignatureModel {
  readonly typeParameters: readonly TypeParameterModel[]
  readonly parameters: readonly ParameterModel[]
  readonly returns: TypeNodeId
}

/** Shared flags of a class/interface/type-literal member. */
export interface MemberBase extends DocumentationModel {
  readonly id: string
  readonly name: string
  /** JSON property name when a literal computed key differs from source text. */
  readonly jsonName?: string
  /** Non-literal computed keys; symbol keys are erased from JSON schemas. */
  readonly computed?: 'symbol' | 'dynamic'
  readonly optional: boolean
  readonly readonly: boolean
  readonly async: boolean
  readonly abstract: boolean
  readonly static: boolean
  readonly visibility: MemberVisibility
  readonly location: SourceLocation
  /** Body-free declaration text retained for byte-stable source projections. */
  readonly text: string
}

/** A property member. */
export interface PropertyMemberModel extends MemberBase {
  readonly kind: 'property'
  readonly type: TypeNodeId
}

/** A method member. */
export interface MethodMemberModel extends MemberBase {
  readonly kind: 'method'
  readonly signature: SignatureModel
}

/** A getter or setter member. */
export interface AccessorMemberModel extends MemberBase {
  readonly kind: 'getter' | 'setter'
  readonly signature: SignatureModel
}

/** A call/construct/index signature in an interface or type literal. */
export interface SignatureMemberModel extends MemberBase {
  readonly kind: 'call' | 'construct' | 'index'
  readonly signature: SignatureModel
}

/** One declaration or object-literal member. */
export type MemberModel =
  | PropertyMemberModel
  | MethodMemberModel
  | AccessorMemberModel
  | SignatureMemberModel

/** One enum member, retaining its developer-authored initializer. */
export interface EnumMemberModel extends DocumentationModel {
  readonly name: string
  readonly initializer?: string
  readonly location: SourceLocation
}

/** One authored part of a merged interface declaration. */
export interface TypeDeclarationPartModel extends DocumentationModel {
  readonly package: string
  readonly location: SourceLocation
  readonly typeParameters: readonly TypeParameterModel[]
  readonly extends: readonly TypeNodeId[]
  readonly members: readonly string[]
}

/** A declared interface, class, or alias. */
export interface TypeDeclarationModel extends DocumentationModel {
  readonly id: SymbolId
  readonly package: string
  readonly name: string
  readonly kind: 'interface' | 'class' | 'alias' | 'enum'
  readonly abstract: boolean
  readonly exported: boolean
  readonly location: SourceLocation
  /** Canonical body-free declaration text retained alongside the type tree. */
  readonly text: string
  readonly typeParameters: readonly TypeParameterModel[]
  readonly extends: readonly TypeNodeId[]
  readonly implements: readonly TypeNodeId[]
  readonly members: readonly MemberModel[]
  readonly parts?: readonly TypeDeclarationPartModel[]
  readonly type?: TypeNodeId
  readonly enumMembers?: readonly EnumMemberModel[]
}

/** Target of a named type reference. */
export type TypeTargetModel =
  | { readonly kind: 'declaration'; readonly symbol: SymbolId }
  | { readonly kind: 'type-parameter'; readonly parameter: string }
  | {
    readonly kind: 'cross-face'
    readonly face: TypertFace
    readonly package: string
    readonly subpath: string
    readonly name: string
  }
  | {
    readonly kind: 'external'
    readonly module: string
    readonly subpath: string
    readonly name: string
  }
  | { readonly kind: 'standard'; readonly name: string }

/** One tuple element, retaining labels and optional/rest modifiers. */
export interface TupleElementModel {
  readonly name?: string
  readonly type: TypeNodeId
  readonly optional: boolean
  readonly rest: boolean
}

/** One template-literal interpolation. */
export interface TemplateSpanModel {
  readonly type: TypeNodeId
  readonly text: string
}

/** Compiler-independent TypeScript type expression. */
export type TypeNodeModel =
  | { readonly id: TypeNodeId; readonly kind: 'keyword'; readonly name: KeywordTypeName }
  | { readonly id: TypeNodeId; readonly kind: 'literal'; readonly value: string | number | bigint | boolean | null; readonly text: string }
  | { readonly id: TypeNodeId; readonly kind: 'parenthesized'; readonly type: TypeNodeId }
  | { readonly id: TypeNodeId; readonly kind: 'reference'; readonly name: string; readonly target: TypeTargetModel; readonly arguments: readonly TypeNodeId[] }
  | { readonly id: TypeNodeId; readonly kind: 'union' | 'intersection'; readonly types: readonly TypeNodeId[] }
  | { readonly id: TypeNodeId; readonly kind: 'array'; readonly element: TypeNodeId }
  | { readonly id: TypeNodeId; readonly kind: 'tuple'; readonly elements: readonly TupleElementModel[] }
  | { readonly id: TypeNodeId; readonly kind: 'object'; readonly members: readonly MemberModel[] }
  | { readonly id: TypeNodeId; readonly kind: 'function'; readonly signature: SignatureModel }
  | { readonly id: TypeNodeId; readonly kind: 'constructor'; readonly abstract: boolean; readonly signature: SignatureModel }
  | { readonly id: TypeNodeId; readonly kind: 'indexed-access'; readonly object: TypeNodeId; readonly index: TypeNodeId }
  | { readonly id: TypeNodeId; readonly kind: 'operator'; readonly operator: TypeOperatorName; readonly type: TypeNodeId }
  | { readonly id: TypeNodeId; readonly kind: 'conditional'; readonly check: TypeNodeId; readonly extends: TypeNodeId; readonly whenTrue: TypeNodeId; readonly whenFalse: TypeNodeId }
  | { readonly id: TypeNodeId; readonly kind: 'infer'; readonly parameter: TypeParameterModel }
  | {
    readonly id: TypeNodeId
    readonly kind: 'mapped'
    readonly parameter: TypeParameterModel
    readonly nameType?: TypeNodeId
    readonly value?: TypeNodeId
    readonly readonly: 'add' | 'remove' | 'preserve'
    readonly optional: 'add' | 'remove' | 'preserve'
  }
  | { readonly id: TypeNodeId; readonly kind: 'template-literal'; readonly head: string; readonly spans: readonly TemplateSpanModel[] }
  | { readonly id: TypeNodeId; readonly kind: 'type-query'; readonly expression: string; readonly arguments: readonly TypeNodeId[] }
  | {
    readonly id: TypeNodeId
    readonly kind: 'import-type'
    readonly module: string
    readonly qualifier?: string
    readonly arguments: readonly TypeNodeId[]
    readonly typeof: boolean
    readonly attributes?: string
    readonly target?: TypeTargetModel
  }
  | { readonly id: TypeNodeId; readonly kind: 'predicate'; readonly asserts: boolean; readonly parameter: string; readonly type?: TypeNodeId }
  | { readonly id: TypeNodeId; readonly kind: 'this' }

/**
 * Return the direct type-expression edges owned by one node.
 * @param node - compiler-independent type node to inspect.
 * @returns graph-local ids of its direct child type nodes.
 */
export function childTypeNodeIds(node: TypeNodeModel): TypeNodeId[] {
  switch (node.kind) {
    case 'parenthesized':
    case 'operator': return [node.type]
    case 'reference': return [...node.arguments]
    case 'union':
    case 'intersection': return [...node.types]
    case 'array': return [node.element]
    case 'tuple': return node.elements.map(element => element.type)
    case 'indexed-access': return [node.object, node.index]
    case 'conditional': return [node.check, node.extends, node.whenTrue, node.whenFalse]
    case 'mapped': return [
      ...(node.parameter.constraint === undefined ? [] : [node.parameter.constraint]),
      ...(node.parameter.default === undefined ? [] : [node.parameter.default]),
      ...(node.nameType === undefined ? [] : [node.nameType]),
      ...(node.value === undefined ? [] : [node.value]),
    ]
    case 'template-literal': return node.spans.map(span => span.type)
    case 'type-query':
    case 'import-type': return [...node.arguments]
    case 'predicate': return node.type === undefined ? [] : [node.type]
    case 'infer': return [
      ...(node.parameter.constraint === undefined ? [] : [node.parameter.constraint]),
      ...(node.parameter.default === undefined ? [] : [node.parameter.default]),
    ]
    case 'keyword':
    case 'literal':
    case 'object':
    case 'function':
    case 'constructor':
    case 'this': return []
    default: return assertNever(node)
  }
}

/** Type declarations and expressions owned by one face. */
export interface TypeGraph {
  readonly declarations: readonly TypeDeclarationModel[]
  readonly nodes: readonly TypeNodeModel[]
}

function assertNever(value: never): never {
  throw new Error(`unsupported model variant ${JSON.stringify(value)}`)
}
