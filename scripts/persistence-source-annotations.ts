/** Resolve producer opt-ins and core-owned source bindings before schema extraction. */

import { relative, resolve, sep } from 'node:path'
import ts from 'typescript'
import type { SourceCompatibility } from './persistence-schema-model.ts'

const CORE_SOURCE = 'packages/llm/llm/src/message.ts'

/**
 * Resolve explicit authoring annotations without using type names in recorded history.
 * @param root - repository root.
 * @param program - the complete source-only persistence compiler program.
 * @returns policies keyed by the original source property declaration.
 */
export function sourceCompatibilityAnnotations(
  root: string, program: ts.Program,
): ReadonlyMap<ts.Declaration, readonly SourceCompatibility[]> {
  const checker = program.getTypeChecker()
  const bindings = new Map<ts.Declaration, readonly ('user' | 'developer')[]>()
  const qualifications = new Set<ts.Node>()
  const core = program.getSourceFile(resolve(root, CORE_SOURCE))
  for (const file of program.getSourceFiles()) {
    const path = relative(root, file.fileName).split(sep).join('/')
    if (!path.startsWith('packages/') || path.includes('/node_modules/')) continue
    const visit = (node: ts.Node): void => {
      for (const tag of ts.getJSDocTags(node)) {
        if (tag.tagName.text === 'persistenceSource') {
          const roles = typeof tag.comment === 'string' ? tag.comment.trim().split(/\s+/u) : []
          if (!ts.isPropertySignature(node) || file !== core || node.name.getText() !== 'source'
            || !ts.isInterfaceDeclaration(node.parent) || node.parent.name.text !== 'MessageBase'
            || roles.length === 0 || roles.some(role => role !== 'user' && role !== 'developer')
            || new Set(roles).size !== roles.length || bindings.has(node)) {
            throw new Error(`persistence schema: invalid @persistenceSource binding in ${path}`)
          }
          bindings.set(node, roles as ('user' | 'developer')[])
        }
        if (tag.tagName.text === 'persistenceAttribution') {
          if (tag.comment !== undefined || qualifications.has(node)) throw new Error(`persistence schema: invalid @persistenceAttribution in ${path}`)
          qualifications.add(node)
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(file)
  }
  const sourceMap = core?.statements.find((node): node is ts.InterfaceDeclaration => ts.isInterfaceDeclaration(node) && node.name.text === 'MessageSourceMap')
  const byKind = new Map<string, boolean>()
  if (sourceMap !== undefined) {
    for (const property of checker.getPropertiesOfType(checker.getTypeAtLocation(sourceMap))) {
      const declarations = property.declarations ?? []
      const marked = declarations.filter(declaration => qualifications.has(declaration))
      for (const declaration of marked) qualifications.delete(declaration)
      if (marked.length !== 0 && marked.length !== declarations.length) throw new Error(`persistence schema: conflicting attribution for ${property.name}`)
      const site = property.valueDeclaration ?? declarations[0] ?? sourceMap
      const type = checker.getTypeOfSymbolAtLocation(property, site)
      const kinds = new Set<string>()
      for (const alternative of type.isUnion() ? type.types : [type]) {
        const discriminator = alternative.getProperty('kind')
        const kind = discriminator === undefined ? undefined : checker.getTypeOfSymbolAtLocation(discriminator, site)
        if (discriminator === undefined || (discriminator.flags & ts.SymbolFlags.Optional) !== 0 || kind === undefined
          || !(kind.flags & ts.TypeFlags.StringLiteral) || (kind as ts.StringLiteralType).value.length === 0) {
          if (marked.length > 0) throw new Error(`persistence schema: attribution ${property.name} requires one literal wire kind`)
          continue
        }
        kinds.add((kind as ts.StringLiteralType).value)
      }
      if (marked.length > 0 && kinds.size !== 1) throw new Error(`persistence schema: attribution ${property.name} requires one literal wire kind`)
      for (const kind of kinds) {
        const qualified = marked.length > 0
        if (byKind.has(kind) && (byKind.get(kind) === true || qualified)) throw new Error(`persistence schema: conflicting attribution for wire kind ${kind}`)
        byKind.set(kind, qualified)
      }
    }
  }
  if (qualifications.size > 0) throw new Error('persistence schema: @persistenceAttribution must annotate a MessageSourceMap producer property')
  const attributionKinds = [...byKind].filter(([, qualified]) => qualified).map(([kind]) => kind).sort()
  return new Map([...bindings].map(([declaration, roles]) => [declaration, roles.map(role => ({
    version: 1, policy: 'session-source-attribution', binding: role === 'user' ? 'session.user-message.source' : 'session.developer-message.source',
    discriminator: 'kind', unknownKinds: 'preserve', attributionKinds,
  }))]))
}
