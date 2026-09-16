/**
 * Generate `docs/config-catalog.md` from package entry points, config types,
 * JSDoc, and static Schemastery schemas. Every package must classify, referenced
 * types must resolve without collisions, and every enumerable schema path must
 * exist on the declared config type. External and dynamic types stay unknown;
 * declared runtime-only fields need not appear in the schema. `--check` verifies
 * the committed artifact.
 */

import { globSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import ts from 'typescript'
import { LINK_MAP } from './gen-cordis-catalog.ts'
import { parseJsDoc, pointer, rawJsDoc } from './jsdoc.ts'
import { githubSlug } from './verify-md-links.ts'

const root = resolve(import.meta.dirname, '..')
const OUT = 'docs/config-catalog.md'

/** The fenced-block info string for pasted config declarations (skipped by
 * doc-typecheck, since a lone declaration referencing imports is not
 * standalone-compilable). */
const FENCE = 'ts config-catalog'

/** TypeScript/Node global type names a config declaration may reference
 * without importing; never treated as unresolved. Extend when a new global
 * legitimately appears — the generator hard-errors on unknown names, so an
 * omission is loud, not silent. */
const GLOBAL_TYPES = new Set([
  'Array', 'ReadonlyArray', 'Record', 'Partial', 'Required', 'Readonly', 'Pick', 'Omit',
  'Promise', 'Map', 'Set', 'Date', 'Error', 'RegExp', 'Exclude', 'Extract', 'NonNullable',
  'ReturnType', 'Parameters', 'AbortSignal', 'URL', 'Buffer', 'NodeJS', 'Iterable', 'AsyncIterable',
])

/** How a package classifies for the catalog. */
type Kind = 'config' | 'no-config' | 'seam' | 'library'

/** One name a pasted declaration references but the paste does not contain. */
interface TypeRef {
  /** The name as it appears in the pasted text (the local import alias). */
  alias: string
  /** The name the source module exports it under (pre-alias). */
  imported: string
  /** The import module specifier (package name or external module). */
  specifier: string
}

/** One verbatim declaration paste. */
interface Paste {
  /** Full source text: leading JSDoc (when present) through the closing token. */
  text: string
  /** Source pointer `packages/…/file.ts:line` of the declaration. */
  source: string
}

/** One package's catalog entry. */
export interface CatalogEntry {
  /** npm package name, e.g. `@deepseek-ai/dsh-agent-loop`. */
  pkg: string
  /** Repo-relative package dir, e.g. `packages/core/agent-loop`. */
  dir: string
  /** Repo-relative entry file, `<dir>/src/index.ts`. */
  entry: string
  kind: Kind
  /** Service keys the plugin `inject`s (empty when none declared). */
  inject: string[]
  /** Seam/service class name (kinds `seam` and class-based plugins). */
  className?: string
  /** Name of the config type (kind `config`). */
  configTypeName?: string
  /** Verbatim declaration pastes, the config type first (kind `config`). */
  pastes?: Paste[]
  /** References the pastes leave unresolved locally (kind `config`). */
  refs?: TypeRef[]
  /** Top-level keys and nested key paths (`agents[].id`) of the runtime
   * schema, `null` when no schema exists (kind `config`). */
  schemaKeys?: string[] | null
  /** Package names whose schemas an intersect composes (kind `config`). */
  schemaComposes?: string[]
}

/** A parsed source file plus its import map (local name → origin). */
interface FileCtx {
  abs: string
  rel: string
  text: string
  sf: ts.SourceFile
  /** Local binding name → `{ imported, specifier }`; default imports record
   * `imported: 'default'`. */
  imports: Map<string, { imported: string; specifier: string; typeOnly?: boolean }>
}

/** Throw one aggregate error for every violation the walk collected. */
function report(violations: string[]): void {
  if (violations.length === 0) return
  throw new Error(
    `gen-config-catalog: ${violations.length} violation(s):\n`
    + violations.map(v => `  ${v}`).join('\n'),
  )
}

/** Parse a source file and index its import declarations. */
function loadFile(abs: string, rel: string, cache: Map<string, FileCtx>): FileCtx {
  const cached = cache.get(abs)
  if (cached) return cached
  const text = readFileSync(abs, 'utf8')
  const sf = ts.createSourceFile(abs, text, ts.ScriptTarget.Latest, true)
  const imports: FileCtx['imports'] = new Map()
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) continue
    const specifier = stmt.moduleSpecifier.text
    const clause = stmt.importClause
    if (!clause) continue
    if (clause.name) imports.set(clause.name.text, { imported: 'default', specifier })
    if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const el of clause.namedBindings.elements) {
        imports.set(el.name.text, {
          imported: (el.propertyName ?? el.name).text,
          specifier,
          typeOnly: clause.phaseModifier === ts.SyntaxKind.TypeKeyword || el.isTypeOnly,
        })
      }
    }
    if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
      imports.set(clause.namedBindings.name.text, { imported: '*', specifier })
    }
  }
  const ctx = { abs, rel, text, sf, imports }
  cache.set(abs, ctx)
  return ctx
}

/** A type declaration a paste can contain. */
type TypeDecl = ts.InterfaceDeclaration | ts.TypeAliasDeclaration | ts.EnumDeclaration

/** Find a pasteable type declaration by name in a file, or null. */
function findTypeDecl(ctx: FileCtx, name: string): TypeDecl | null {
  for (const stmt of ctx.sf.statements) {
    if ((ts.isInterfaceDeclaration(stmt) || ts.isTypeAliasDeclaration(stmt) || ts.isEnumDeclaration(stmt))
      && stmt.name.text === name) return stmt
  }
  return null
}

/**
 * Resolve a type name from a file to its declaration (following package-local
 * relative imports transitively) or to the import that brings it in. Returns
 * `null` when the name is neither declared, imported, nor a known global.
 */
function resolveTypeName(
  ctx: FileCtx,
  name: string,
  cache: Map<string, FileCtx>,
  violations: string[],
): { decl: TypeDecl; ctx: FileCtx } | { ref: TypeRef } | null {
  const local = findTypeDecl(ctx, name)
  if (local) return { decl: local, ctx }
  const imp = ctx.imports.get(name)
  if (!imp) return null
  if (imp.specifier.startsWith('.')) {
    if (!imp.specifier.endsWith('.ts')) {
      violations.push(`${ctx.rel}: relative import '${imp.specifier}' lacks the explicit .ts extension the repo convention requires.`)
      return null
    }
    if (imp.imported !== name) {
      violations.push(`${ctx.rel}: '${name}' aliases '${imp.imported}' across a package-local import; the catalog pastes declarations verbatim, so keep package-local config types unaliased.`)
      return null
    }
    const abs = resolve(dirname(ctx.abs), imp.specifier)
    const rel = ctx.rel.slice(0, ctx.rel.lastIndexOf('/') + 1) + imp.specifier.replace(/^\.\//, '')
    const target = loadFile(abs, rel, cache)
    return resolveTypeName(target, imp.imported, cache, violations)
  }
  return { ref: { alias: name, imported: imp.imported, specifier: imp.specifier } }
}

/** Collect every type NAME referenced in type positions under a node. */
function collectTypeNames(node: ts.Node, out: Set<string>): void {
  const visit = (n: ts.Node): void => {
    if (ts.isTypeReferenceNode(n)) {
      let head: ts.EntityName = n.typeName
      while (ts.isQualifiedName(head)) head = head.left
      out.add(head.text)
    } else if (ts.isExpressionWithTypeArguments(n) && ts.isIdentifier(n.expression)) {
      out.add(n.expression.text) // heritage clause: `extends X`
    }
    ts.forEachChild(n, visit)
  }
  visit(node)
}

/** The verbatim paste text of a declaration: leading JSDoc through the end. */
function pasteText(ctx: FileCtx, decl: TypeDecl): string {
  const raw = rawJsDoc(ctx.text, decl)
  const start = raw ? ctx.text.indexOf(raw, decl.getFullStart()) : decl.getStart(ctx.sf)
  return ctx.text.slice(start, decl.end)
}

/** Enforce non-empty JSDoc prose on every property of a pasted declaration,
 * recursing into nested type literals (e.g. an array-of-objects field). */
function checkMemberDocs(ctx: FileCtx, decl: TypeDecl, violations: string[]): void {
  const walkMembers = (members: ts.NodeArray<ts.TypeElement>, path: string): void => {
    for (const member of members) {
      if (!ts.isPropertySignature(member)) continue
      const name = member.name.getText(ctx.sf)
      const where = `config field '${path}.${name}' (${pointer(ctx.rel, ctx.sf, member)})`
      if (!parseJsDoc(rawJsDoc(ctx.text, member)).doc) violations.push(`${where} has no JSDoc prose.`)
      if (member.type) walkNested(member.type, `${path}.${name}`)
    }
  }
  const walkNested = (type: ts.Node, path: string): void => {
    if (ts.isTypeLiteralNode(type)) walkMembers(type.members, path)
    else ts.forEachChild(type, (n) => { walkNested(n, path) })
  }
  if (ts.isInterfaceDeclaration(decl)) walkMembers(decl.members, decl.name.text)
  else if (ts.isTypeAliasDeclaration(decl)) walkNested(decl.type, decl.name.text)
}

/** Cross-file resolution context for the schema-path check. */
interface World {
  scanRoot: string
  cache: Map<string, FileCtx>
  /** Workspace package name → repo-relative package dir. */
  pkgDirByName: Map<string, string>
  /** Exact public export declarations used to verify shared schema imports. */
  pkgExportsByName: Map<string, unknown>
  /** Source-plane TypeScript resolution, loaded only for shared schema imports. */
  compilerOptions?: ts.CompilerOptions
}

/** Resolve an explicitly exported workspace module to its mapped source file. */
function loadWorkspaceSource(world: World, from: FileCtx, specifier: string): FileCtx {
  const pkg = specifier.split('/').slice(0, specifier.startsWith('@') ? 2 : 1).join('/')
  const dir = world.pkgDirByName.get(pkg)
  if (dir === undefined) throw new Error(`schema import '${specifier}' is not a workspace package`)
  const subpath = specifier === pkg ? '.' : `.${specifier.slice(pkg.length)}`
  const exports = world.pkgExportsByName.get(pkg)
  if (typeof exports !== 'object' || exports === null || Array.isArray(exports)
    || !Object.hasOwn(exports, subpath) || (exports as Record<string, unknown>)[subpath] == null) {
    throw new Error(`workspace package '${pkg}' does not explicitly export '${subpath}'`)
  }
  if (world.compilerOptions === undefined) {
    const parsed = ts.getParsedCommandLineOfConfigFile(resolve(world.scanRoot, 'tsconfig.json'), {}, {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic(diagnostic) {
        throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))
      },
    })
    if (parsed === undefined || parsed.errors.length > 0) {
      throw new Error(`cannot resolve schema import '${specifier}' through the workspace source tsconfig`)
    }
    world.compilerOptions = parsed.options
  }
  const resolved = ts.resolveModuleName(specifier, from.abs, world.compilerOptions, ts.sys).resolvedModule
  if (resolved === undefined) throw new Error(`schema import '${specifier}' has no workspace source mapping`)
  const sourcePath = relative(resolve(world.scanRoot, dir, 'src'), resolved.resolvedFileName)
  if (isAbsolute(sourcePath) || sourcePath === '..' || sourcePath.startsWith(`..${sep}`)
    || !sourcePath.endsWith('.ts') || sourcePath.endsWith('.d.ts')) {
    throw new Error(`schema import '${specifier}' must resolve inside ${dir}/src to a TypeScript source file`)
  }
  const rel = relative(world.scanRoot, resolved.resolvedFileName).split(sep).join('/')
  return loadFile(resolved.resolvedFileName, rel, world.cache)
}

/** Find a directly declared const schema, requiring public exports at imported entries. */
function schemaConst(ctx: FileCtx, name: string, exported: boolean): ts.Expression | null {
  for (const statement of ctx.sf.statements) {
    if (!ts.isVariableStatement(statement) || !(statement.declarationList.flags & ts.NodeFlags.Const)) continue
    if (exported && !statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue
    const declaration = statement.declarationList.declarations.find(item => ts.isIdentifier(item.name) && item.name.text === name)
    if (declaration?.initializer !== undefined) return declaration.initializer
  }
  return null
}

/** Follow only const identities and named value imports; never execute schema factories. */
function schemaAlias(world: World, ctx: FileCtx, name: string): { ctx: FileCtx; expr: ts.Expression } {
  const local = schemaConst(ctx, name, false)
  if (local !== null) return { ctx, expr: local }
  const imported = ctx.imports.get(name)
  if (imported === undefined || imported.typeOnly || imported.imported === '*' || imported.imported === 'default') {
    throw new Error(`schema alias '${name}' must name a const or named value import`)
  }
  const target = loadWorkspaceSource(world, ctx, imported.specifier)
  const expr = schemaConst(target, imported.imported, true)
  if (expr === null) throw new Error(`schema import '${imported.specifier}' has no exported const '${imported.imported}'`)
  return { ctx: target, expr }
}

/** How a schema key path fared against the declared config type: definitely
 * present, definitely absent, or crossing a type the walk cannot enumerate
 * (only `missing` is a violation — `unknown` must never mis-report). */
type PathLookup = 'found' | 'missing' | 'unknown'

/** One step of a schema key path: a named member, or an array-element hop. */
type PathStep = { member: string } | { array: true }

/** Parse a schema key path (`agents[].id`) into member/array steps. */
function parsePath(path: string): PathStep[] {
  const steps: PathStep[] = []
  for (const seg of path.split('.')) {
    let name = seg
    let arrays = 0
    while (name.endsWith('[]')) {
      name = name.slice(0, -2)
      arrays += 1
    }
    steps.push({ member: name })
    for (let i = 0; i < arrays; i += 1) steps.push({ array: true })
  }
  return steps
}

/** Load a package-relative import target as a FileCtx. */
function loadRelative(world: World, from: FileCtx, specifier: string): FileCtx {
  const abs = resolve(dirname(from.abs), specifier)
  const rel = from.rel.slice(0, from.rel.lastIndexOf('/') + 1) + specifier.replace(/^\.\//, '')
  return loadFile(abs, rel, world.cache)
}

/** Find a type declaration EXPORTED (directly or via re-export chains) from a
 * file, following `export … from './x.ts'` and `export * from './x.ts'`. */
function findExportedTypeDecl(world: World, ctx: FileCtx, name: string, seen = new Set<string>()): { decl: TypeDecl; ctx: FileCtx } | null {
  const key = `${ctx.abs}#${name}`
  if (seen.has(key)) return null
  seen.add(key)
  const local = findTypeDecl(ctx, name)
  if (local) return { decl: local, ctx }
  for (const stmt of ctx.sf.statements) {
    if (!ts.isExportDeclaration(stmt) || !stmt.moduleSpecifier || !ts.isStringLiteral(stmt.moduleSpecifier)) continue
    const spec = stmt.moduleSpecifier.text
    if (!spec.startsWith('.') || !spec.endsWith('.ts')) continue
    let lookFor: string | null = null
    if (!stmt.exportClause) {
      lookFor = name // export * from './x.ts'
    } else if (ts.isNamedExports(stmt.exportClause)) {
      const el = stmt.exportClause.elements.find(e => e.name.text === name)
      if (el) lookFor = (el.propertyName ?? el.name).text
    }
    if (lookFor === null) continue
    const hit = findExportedTypeDecl(world, loadRelative(world, ctx, spec), lookFor, seen)
    if (hit) return hit
  }
  return null
}

/** Resolve a referenced type NAME to its declaration: declared locally, via a
 * package-relative import, or via a workspace-package import (entry file +
 * re-export chains). `'unknown'` = external or otherwise out of reach. */
function declForTypeName(world: World, ctx: FileCtx, name: string): { decl: TypeDecl; ctx: FileCtx } | 'unknown' {
  const local = findTypeDecl(ctx, name)
  if (local) return { decl: local, ctx }
  const imp = ctx.imports.get(name)
  if (!imp) return 'unknown'
  if (imp.specifier.startsWith('.')) {
    if (!imp.specifier.endsWith('.ts')) return 'unknown'
    return findExportedTypeDecl(world, loadRelative(world, ctx, imp.specifier), imp.imported) ?? 'unknown'
  }
  const dir = world.pkgDirByName.get(imp.specifier)
  if (dir === undefined) {
    try {
      const target = loadWorkspaceSource(world, ctx, imp.specifier)
      return findExportedTypeDecl(world, target, imp.imported) ?? 'unknown'
    } catch {
      // External or unsupported declarations remain unknown for type presence;
      // a runtime schema alias reports the same resolution failure separately.
      return 'unknown'
    }
  }
  const entryRel = `${dir}/src/index.ts`
  let entry: FileCtx
  try {
    entry = loadFile(resolve(world.scanRoot, entryRel), entryRel, world.cache)
  } catch {
    // A workspace package without a readable entry is reported by its own
    // classification pass; for a lookup it is out of reach.
    return 'unknown'
  }
  return findExportedTypeDecl(world, entry, imp.imported) ?? 'unknown'
}

/** Utility wrappers that pass a member lookup through to their type argument. */
const PASSTHROUGH_WRAPPERS = new Set(['Partial', 'Required', 'Readonly', 'NonNullable'])

/**
 * Walk a schema key path against a declared type. This is a PRESENCE check,
 * not a runtime value check: it answers "does the declared config type have a member
 * here", resolving interfaces (heritage included), type aliases, literals,
 * intersections, unions, arrays, indexed access, pass-through utility
 * wrappers, and type references across package-local and workspace imports.
 * Anything it cannot see through resolves `'unknown'`, never `'missing'`.
 */
function lookupPath(world: World, ctx: FileCtx, node: ts.Node, steps: PathStep[], seen: Set<string>): PathLookup {
  if (steps.length === 0) return 'found'
  // Guard only named declarations, where recursive types can loop. Structural
  // children can share a source position with their parent, so guarding them
  // would mistake ordinary descent for a cycle.
  if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) {
    const key = `${ctx.abs}:${node.pos}:${steps.length}`
    if (seen.has(key)) return 'unknown' // recursive type — bail rather than loop
    seen.add(key)
  }
  const step = steps[0]
  if (step === undefined) return 'found'
  // Combine branch results: any found wins, else any unknown taints, else missing.
  const combine = (results: PathLookup[]): PathLookup => {
    if (results.includes('found')) return 'found'
    if (results.includes('unknown')) return 'unknown'
    return 'missing'
  }
  const intoMembers = (members: ts.NodeArray<ts.TypeElement>): PathLookup | null => {
    if (!('member' in step)) return null
    for (const m of members) {
      if (!ts.isPropertySignature(m) || m.name.getText(ctx.sf) !== step.member) continue
      if (steps.length === 1) return 'found'
      return m.type ? lookupPath(world, ctx, m.type, steps.slice(1), seen) : 'unknown'
    }
    return null // not among these members; caller consults heritage/parts
  }
  if (ts.isInterfaceDeclaration(node)) {
    if (!('member' in step)) return 'unknown' // an array step cannot land on an interface
    const direct = intoMembers(node.members)
    if (direct !== null) return direct
    const bases: PathLookup[] = []
    for (const clause of node.heritageClauses ?? []) {
      for (const base of clause.types) {
        if (!ts.isIdentifier(base.expression)) {
          bases.push('unknown')
          continue
        }
        const resolved = declForTypeName(world, ctx, base.expression.text)
        bases.push(resolved === 'unknown' ? 'unknown' : lookupPath(world, resolved.ctx, resolved.decl, steps, seen))
      }
    }
    return bases.length ? combine(bases) : 'missing'
  }
  if (ts.isTypeAliasDeclaration(node)) return lookupPath(world, ctx, node.type, steps, seen)
  if (ts.isTypeLiteralNode(node)) {
    if (!('member' in step)) return 'unknown'
    return intoMembers(node.members) ?? 'missing'
  }
  if (ts.isParenthesizedTypeNode(node)) return lookupPath(world, ctx, node.type, steps, seen)
  if (ts.isIntersectionTypeNode(node)) {
    return combine(node.types.map(t => lookupPath(world, ctx, t, steps, seen)))
  }
  if (ts.isUnionTypeNode(node)) {
    // Presence on a union is only definite when every branch agrees.
    const results = node.types.map(t => lookupPath(world, ctx, t, steps, seen))
    if (results.every(r => r === 'found')) return 'found'
    if (results.every(r => r === 'missing')) return 'missing'
    return 'unknown'
  }
  if (ts.isArrayTypeNode(node)) {
    return 'array' in step ? lookupPath(world, ctx, node.elementType, steps.slice(1), seen) : 'unknown'
  }
  if (ts.isTypeOperatorNode(node)) return lookupPath(world, ctx, node.type, steps, seen)
  if (ts.isIndexedAccessTypeNode(node)) {
    const index = node.indexType
    if (ts.isLiteralTypeNode(index) && ts.isStringLiteral(index.literal)) {
      return lookupPath(world, ctx, node.objectType, [{ member: index.literal.text }, ...steps], seen)
    }
    return 'unknown'
  }
  if (ts.isTypeReferenceNode(node)) {
    let head: ts.EntityName = node.typeName
    while (ts.isQualifiedName(head)) head = head.left
    const name = head.text
    if (PASSTHROUGH_WRAPPERS.has(name) && node.typeArguments?.[0]) {
      return lookupPath(world, ctx, node.typeArguments[0], steps, seen)
    }
    if ((name === 'Array' || name === 'ReadonlyArray') && node.typeArguments?.[0]) {
      return 'array' in step ? lookupPath(world, ctx, node.typeArguments[0], steps.slice(1), seen) : 'unknown'
    }
    if (!ts.isIdentifier(node.typeName)) return 'unknown' // namespace-qualified: out of reach
    const resolved = declForTypeName(world, ctx, name)
    return resolved === 'unknown' ? 'unknown' : lookupPath(world, resolved.ctx, resolved.decl, steps, seen)
  }
  return 'unknown'
}

/** Unwrap `as` / `satisfies` / parenthesized wrappers around an expression. */
function unwrapExpr(expr: ts.Expression): ts.Expression {
  let e = expr
  while (ts.isAsExpression(e) || ts.isSatisfiesExpression(e) || ts.isParenthesizedExpression(e)) e = e.expression
  return e
}

/**
 * Statically walk a schemastery schema expression to its key paths plus the
 * packages whose schemas an intersect composes. A key path is the top-level
 * key or a nested path through object/array compositions (`agents[].id`).
 * Handles object/union calls, chained refinements, named const schema imports
 * through public workspace source paths, and `z.intersect([X.Config, …])`; errors on
 * anything else, so a schema the walk cannot see fails the gate instead of
 * silently thinning it. Nested values that are neither `object` nor `array`
 * compositions (primitives, unions, dynamic-key dicts) contribute no paths.
 */
function walkSchemaExpr(
  world: World,
  ctx: FileCtx,
  expr: ts.Expression,
  where: string,
  violations: string[],
  aliases = new Set<string>(),
): { keys: string[]; composes: string[] } {
  const keys: string[] = []
  const composes: string[] = []
  // Nested paths under one object property's VALUE expression: recurse through
  // chained refinements toward the base call, descending into object/array.
  const collectValuePaths = (value: ts.Expression, base: string): void => {
    const call = unwrapExpr(value)
    if (!ts.isCallExpression(call) || !ts.isPropertyAccessExpression(call.expression)) return
    const method = call.expression.name.text
    if (method === 'object' && call.arguments[0] && ts.isObjectLiteralExpression(call.arguments[0])) {
      for (const prop of call.arguments[0].properties) {
        if (!ts.isPropertyAssignment(prop)) continue
        const key = ts.isStringLiteral(prop.name) ? prop.name.text : prop.name.getText(ctx.sf)
        keys.push(`${base}.${key}`)
        collectValuePaths(prop.initializer, `${base}.${key}`)
      }
      return
    }
    if (method === 'array' && call.arguments[0]) {
      collectValuePaths(call.arguments[0], `${base}[]`)
      return
    }
    const inner = unwrapExpr(call.expression.expression)
    if (ts.isCallExpression(inner)) collectValuePaths(inner, base)
  }
  const visit = (e: ts.Expression): void => {
    const call = unwrapExpr(e)
    if (ts.isIdentifier(call)) {
      const identity = `${ctx.abs}#${call.text}`
      if (aliases.has(identity)) {
        violations.push(`${where}: cyclic schema alias '${call.text}' in ${ctx.rel}.`)
        return
      }
      try {
        const target = schemaAlias(world, ctx, call.text)
        const result = walkSchemaExpr(world, target.ctx, target.expr, where, violations, new Set([...aliases, identity]))
        keys.push(...result.keys)
        composes.push(...result.composes)
      } catch (error) {
        violations.push(`${where}: ${error instanceof Error ? error.message : String(error)}.`)
      }
      return
    }
    if (!ts.isCallExpression(call) || !ts.isPropertyAccessExpression(call.expression)) {
      violations.push(`${where}: schema expression is not a statically walkable schemastery call.`)
      return
    }
    const method = call.expression.name.text
    if (method === 'object' && call.arguments[0] && ts.isObjectLiteralExpression(call.arguments[0])) {
      for (const prop of call.arguments[0].properties) {
        if (ts.isPropertyAssignment(prop) || ts.isShorthandPropertyAssignment(prop)) {
          const key = ts.isStringLiteral(prop.name) ? prop.name.text : prop.name.getText(ctx.sf)
          keys.push(key)
          if (ts.isPropertyAssignment(prop)) collectValuePaths(prop.initializer, key)
        } else {
          violations.push(`${where}: schema object property '${prop.getText(ctx.sf)}' is not a plain key.`)
        }
      }
      return
    }
    if (method === 'intersect' && call.arguments[0] && ts.isArrayLiteralExpression(call.arguments[0])) {
      for (const el of call.arguments[0].elements) {
        const part = unwrapExpr(el)
        if (ts.isPropertyAccessExpression(part) && part.name.text === 'Config' && ts.isIdentifier(part.expression)) {
          const imp = ctx.imports.get(part.expression.text)
          if (imp && !imp.specifier.startsWith('.')) { composes.push(imp.specifier); continue }
        }
        if (ts.isCallExpression(part) || ts.isIdentifier(part)) { visit(part); continue }
        violations.push(`${where}: intersect element '${part.getText(ctx.sf)}' is neither a workspace plugin's Config nor an inline schema call.`)
      }
      return
    }
    // A union of objects (discriminated union config): collect keys from all
    // variants. Each variant is visited the same way as an intersect element.
    if (method === 'union' && call.arguments[0] && ts.isArrayLiteralExpression(call.arguments[0])) {
      for (const el of call.arguments[0].elements) {
        const part = unwrapExpr(el)
        if (ts.isCallExpression(part) || ts.isIdentifier(part)) { visit(part); continue }
        violations.push(`${where}: union element '${part.getText(ctx.sf)}' is not a schema call or const alias.`)
      }
      return
    }
    // A chained refinement (`z.object({…}).default(…)` etc.): the keys live on
    // the call the chain hangs off — keep unwrapping toward it.
    const base = unwrapExpr(call.expression.expression)
    if (ts.isCallExpression(base)) { visit(base); return }
    violations.push(`${where}: schema call '${method}' is not object/intersect and hangs off no walkable base call.`)
  }
  visit(expr)
  return { keys, composes }
}

/** Find a plugin's schemastery schema expression: an exported `const Config`
 * in the entry file, else a `static Config` on the plugin class. */
function findSchemaExpr(ctx: FileCtx, pluginClass: ts.ClassDeclaration | null): ts.Expression | null {
  for (const stmt of ctx.sf.statements) {
    if (!ts.isVariableStatement(stmt)) continue
    if (!stmt.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) continue
    for (const decl of stmt.declarationList.declarations) {
      if (ts.isIdentifier(decl.name) && decl.name.text === 'Config' && decl.initializer) return decl.initializer
    }
  }
  for (const member of pluginClass?.members ?? []) {
    if (!ts.isPropertyDeclaration(member) || member.name.getText() !== 'Config') continue
    if (!member.modifiers?.some(m => m.kind === ts.SyntaxKind.StaticKeyword)) continue
    if (member.initializer) return member.initializer
  }
  return null
}

/** Read an `inject` service-key list: `export const inject = […]` in the entry
 * file, else `static inject = […]` on the plugin class. */
function findInject(ctx: FileCtx, pluginClass: ts.ClassDeclaration | null, violations: string[]): string[] {
  const fromArray = (expr: ts.Expression, where: string): string[] => {
    if (!ts.isArrayLiteralExpression(expr)) {
      violations.push(`${where}: inject is not a plain string-array literal; teach the generator the new declaration form.`)
      return []
    }
    return expr.elements.map(el => ts.isStringLiteral(el) ? el.text : el.getText(ctx.sf))
  }
  for (const stmt of ctx.sf.statements) {
    if (!ts.isVariableStatement(stmt)) continue
    for (const decl of stmt.declarationList.declarations) {
      if (ts.isIdentifier(decl.name) && decl.name.text === 'inject' && decl.initializer) {
        return fromArray(decl.initializer, ctx.rel)
      }
    }
  }
  for (const member of pluginClass?.members ?? []) {
    if (ts.isPropertyDeclaration(member) && member.name.getText() === 'inject' && member.initializer) {
      return fromArray(member.initializer, ctx.rel)
    }
  }
  return []
}

/** Resolve the entry file's default export to its class/function declaration
 * (mirroring the Loader's `unwrapExports`), or null when there is none. */
function defaultExport(ctx: FileCtx): ts.ClassDeclaration | ts.FunctionDeclaration | null {
  for (const stmt of ctx.sf.statements) {
    if (ts.isExportAssignment(stmt) && !stmt.isExportEquals && ts.isIdentifier(stmt.expression)) {
      const name = stmt.expression.text
      for (const s of ctx.sf.statements) {
        if ((ts.isClassDeclaration(s) || ts.isFunctionDeclaration(s)) && s.name?.text === name) return s
      }
      return null
    }
    if ((ts.isClassDeclaration(stmt) || ts.isFunctionDeclaration(stmt))
      && stmt.modifiers?.some(m => m.kind === ts.SyntaxKind.DefaultKeyword)) return stmt
  }
  return null
}

/** Find the exported `apply` function declaration in the entry file, or null. */
function applyExport(ctx: FileCtx): ts.FunctionDeclaration | null {
  for (const stmt of ctx.sf.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name?.text === 'apply'
      && stmt.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) return stmt
  }
  return null
}

/**
 * Walk every `packages/<group>/<pkg>` entry and build the catalog entries.
 * Hard-errors (aggregated) on any violation listed in the module doc.
 * `scanRoot` defaults to the repo root; tests pass a fixture dir.
 */
export function collectConfigCatalog(scanRoot: string = root): CatalogEntry[] {
  const violations: string[] = []
  const cache = new Map<string, FileCtx>()
  const entries: CatalogEntry[] = []

  // Pre-pass: package name → dir, so schema-path lookups can follow
  // workspace-package imports while individual packages are still being walked.
  const pkgDirByName = new Map<string, string>()
  const pkgExportsByName = new Map<string, unknown>()
  const manifests: { dir: string; pkg: string }[] = []
  for (const manifestRel of globSync('packages/*/*/package.json', { cwd: scanRoot }).map(path => path.split(sep).join('/')).sort()) {
    const dir = manifestRel.slice(0, -'/package.json'.length)
    const manifest = JSON.parse(readFileSync(resolve(scanRoot, manifestRel), 'utf8')) as { name?: string; os?: string[]; cpu?: string[]; exports?: unknown }
    const pkg = manifest.name
    if (!pkg) {
      violations.push(`${manifestRel} has no "name".`)
      continue
    }
    if (manifest.os !== undefined && manifest.cpu !== undefined) {
      // A per-platform native-binary package (npm os/cpu selection) ships no
      // JavaScript at all — nothing to classify, no Config to catalog.
      continue
    }
    pkgDirByName.set(pkg, dir)
    pkgExportsByName.set(pkg, manifest.exports)
    manifests.push({ dir, pkg })
  }
  const world: World = { scanRoot, cache, pkgDirByName, pkgExportsByName }

  for (const { dir, pkg } of manifests) {
    const entryRel = `${dir}/src/index.ts`
    let ctx: FileCtx
    try {
      ctx = loadFile(resolve(scanRoot, entryRel), entryRel, cache)
    } catch {
      // A package without src/index.ts cannot be classified — that is the
      // violation itself; nothing else in this loop body can run without it.
      violations.push(`${pkg}: entry ${entryRel} is missing or unreadable.`)
      continue
    }

    // Classify, mirroring the Loader's unwrapExports: the default export IS
    // the plugin when present; else an exported `apply` makes the module
    // namespace the plugin; else the package is a plain library.
    const dflt = defaultExport(ctx)
    const apply = applyExport(ctx)
    let pluginClass: ts.ClassDeclaration | null = null
    let configParam: ts.ParameterDeclaration | undefined
    let kind: Kind
    let className: string | undefined
    if (dflt && ts.isClassDeclaration(dflt)) {
      className = dflt.name?.text
      if (dflt.modifiers?.some(m => m.kind === ts.SyntaxKind.AbstractKeyword)) {
        kind = 'seam'
      } else {
        pluginClass = dflt
        const ctor = dflt.members.find(ts.isConstructorDeclaration)
        configParam = ctor?.parameters[1]
        kind = configParam ? 'config' : 'no-config'
      }
    } else if (dflt) {
      configParam = dflt.parameters[1]
      kind = configParam ? 'config' : 'no-config'
    } else if (apply) {
      configParam = apply.parameters[1]
      kind = configParam ? 'config' : 'no-config'
    } else {
      kind = 'library'
    }

    const entry: CatalogEntry = {
      pkg,
      dir,
      entry: entryRel,
      kind,
      inject: kind === 'library' || kind === 'seam' ? [] : findInject(ctx, pluginClass, violations),
      ...className !== undefined ? { className } : {},
    }
    entries.push(entry)
    if (kind !== 'config' || !configParam) continue

    // Resolve the config type and paste its package-local transitive closure.
    if (!configParam.type || !ts.isTypeReferenceNode(configParam.type) || !ts.isIdentifier(configParam.type.typeName)) {
      violations.push(`${pkg}: config parameter type (${pointer(entryRel, ctx.sf, configParam)}) is not a plain type-name reference; declare a named config type.`)
      continue
    }
    const typeName = configParam.type.typeName.text
    entry.configTypeName = typeName
    const pastes: Paste[] = []
    const refs = new Map<string, TypeRef>()
    // A bare name is the fence's whole namespace: two DIFFERENT declarations
    // (or a declaration in one file and an import in another) sharing a name
    // cannot both render unambiguously, so every resolution is identity-checked
    // by source pointer and a collision is a violation, never a silent skip.
    const pastedDeclByName = new Map<string, string>()
    const queue: { name: string; from: FileCtx }[] = [{ name: typeName, from: ctx }]
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) {
      const { name, from } = item
      const resolved = resolveTypeName(from, name, cache, violations)
      if (resolved === null) {
        violations.push(`${pkg}: config declaration references '${name}' (via ${from.rel}), which is neither declared in the package, imported, nor a known global type.`)
        continue
      }
      if ('ref' in resolved) {
        if (name === typeName) {
          violations.push(`${pkg}: config type '${name}' is imported from '${resolved.ref.specifier}'; a plugin's config type must live in its own package.`)
          continue
        }
        if (pastedDeclByName.has(name)) {
          violations.push(`${pkg}: '${name}' resolves to a package-local declaration (${pastedDeclByName.get(name) ?? ''}) in one file and an import from '${resolved.ref.specifier}' in another; rename one so the fence is unambiguous.`)
          continue
        }
        const existing = refs.get(name)
        if (existing && (existing.specifier !== resolved.ref.specifier || existing.imported !== resolved.ref.imported)) {
          violations.push(`${pkg}: '${name}' is imported from both '${existing.specifier}' (${existing.imported}) and '${resolved.ref.specifier}' (${resolved.ref.imported}) across the pasted closure; disambiguate the aliases.`)
          continue
        }
        refs.set(name, resolved.ref)
        continue
      }
      const declKey = pointer(resolved.ctx.rel, resolved.ctx.sf, resolved.decl)
      const prior = pastedDeclByName.get(name)
      if (prior === declKey) continue // same declaration reached again — benign
      if (prior !== undefined) {
        violations.push(`${pkg}: type name '${name}' resolves to two different declarations (${prior} and ${declKey}) across the pasted closure; rename one — a verbatim fence cannot carry two same-named declarations.`)
        continue
      }
      if (refs.has(name)) {
        violations.push(`${pkg}: '${name}' resolves to an import from '${refs.get(name)?.specifier ?? ''}' in one file and a package-local declaration (${declKey}) in another; rename one so the fence is unambiguous.`)
        continue
      }
      pastedDeclByName.set(name, declKey)
      pastes.push({ text: pasteText(resolved.ctx, resolved.decl), source: declKey })
      checkMemberDocs(resolved.ctx, resolved.decl, violations)
      const names = new Set<string>()
      collectTypeNames(resolved.decl, names)
      for (const n of names) {
        if (GLOBAL_TYPES.has(n)) continue
        queue.push({ name: n, from: resolved.ctx })
      }
    }
    entry.pastes = pastes
    entry.refs = [...refs.values()].sort((a, b) => a.alias.localeCompare(b.alias))

    // Statically walk the runtime schema (when one exists) for the subset check.
    const schemaExpr = findSchemaExpr(ctx, pluginClass)
    if (schemaExpr) {
      const { keys, composes } = walkSchemaExpr(world, ctx, unwrapExpr(schemaExpr), `${pkg} (${entryRel})`, violations)
      entry.schemaKeys = keys
      entry.schemaComposes = composes
    } else {
      entry.schemaKeys = null
    }
  }

  // Fold composed schemas' key paths in, then check each path against the type.
  // Only a definite miss fails; types the walk cannot enumerate stay unknown.
  const byName = new Map(entries.map(e => [e.pkg, e]))
  for (const entry of entries) {
    if (entry.kind !== 'config' || entry.schemaKeys === null || entry.schemaKeys === undefined) continue
    const seen = new Set<string>()
    const foldComposed = (e: CatalogEntry): string[] => {
      if (seen.has(e.pkg)) return []
      seen.add(e.pkg)
      const keys = [...e.schemaKeys ?? []]
      for (const composed of e.schemaComposes ?? []) {
        const target = byName.get(composed)
        if (!target) {
          violations.push(`${entry.pkg}: schema intersects '${composed}', which is not a workspace package the walk collected.`)
          continue
        }
        keys.push(...foldComposed(target))
      }
      return keys
    }
    const allKeys = foldComposed(entry)
    const mainPaste = entry.pastes?.[0]
    const mainFile = mainPaste?.source.split(':')[0]
    const mainCtx = mainFile !== undefined ? cache.get(resolve(scanRoot, mainFile)) : undefined
    const mainDecl = mainCtx && entry.configTypeName !== undefined ? findTypeDecl(mainCtx, entry.configTypeName) : null
    if (!mainCtx || !mainDecl) {
      violations.push(`${entry.pkg}: cannot locate config type '${entry.configTypeName ?? ''}' for the schema-path check.`)
      continue
    }
    for (const keyPath of allKeys) {
      if (lookupPath(world, mainCtx, mainDecl, parsePath(keyPath), new Set()) === 'missing') {
        violations.push(`${entry.pkg}: schema validates key '${keyPath}' but config type '${entry.configTypeName ?? ''}' declares no such member — the catalog paste would hide a loader-accepted field.`)
      }
    }
  }

  report(violations)
  return entries.sort((a, b) => a.pkg.localeCompare(b.pkg))
}

/** Render the `Requires:` service-key line, or '' when the plugin injects nothing. */
function requiresLine(inject: string[]): string {
  return inject.length ? `Requires: ${inject.map(k => `\`${k}\``).join(' · ')}` : ''
}

/** Render one reference as a link: another plugin's config type → its section,
 * a curated subsystems name → its page, any other workspace type →
 * its source file, an external type → named with its module, unlinked. */
function refLink(ref: TypeRef, byName: Map<string, CatalogEntry>): string {
  const target = byName.get(ref.specifier)
  if (target?.kind === 'config' && ref.imported === target.configTypeName) {
    return `[\`${ref.alias}\`](#${githubSlug(target.pkg)})`
  }
  const page = LINK_MAP[ref.imported]
  if (page) return `[\`${ref.alias}\`](subsystems/${page})`
  if (target) return `[\`${ref.alias}\`](../${target.entry})`
  return `\`${ref.alias}\` (\`${ref.specifier}\`)`
}

/** Render one configurable plugin's section. */
function renderConfigEntry(entry: CatalogEntry, byName: Map<string, CatalogEntry>): string[] {
  const out = [`<a id="${githubSlug(entry.pkg)}"></a>`, '', `## \`${entry.pkg}\``, '']
  const requires = requiresLine(entry.inject)
  if (requires) out.push(requires, '')
  out.push('```' + FENCE, ...(entry.pastes ?? []).map(p => p.text).join('\n\n').split('\n'), '```', '')
  if (entry.refs && entry.refs.length > 0) {
    out.push(`Depends on: ${entry.refs.map(r => refLink(r, byName)).join(' · ')}`, '')
  }
  const source = entry.pastes?.[0]?.source ?? entry.entry
  out.push(`Source: [\`${source}\`](../${source.split(':')[0]})`, '')
  return out
}

/** Render one terse list line (the no-config / seam / library sections). */
function renderTerse(entry: CatalogEntry, detail: string): string {
  const requires = entry.inject.length ? ` — requires ${entry.inject.map(k => `\`${k}\``).join(' · ')}` : ''
  return `- \`${entry.pkg}\`${detail}${requires} ([\`${entry.entry}\`](../${entry.entry}))`
}

/** Render the full catalog (pure, deterministic given sorted entries). */
export function render(entries: CatalogEntry[]): string {
  const byName = new Map(entries.map(e => [e.pkg, e]))
  const lines: string[] = [
    '<!-- Generated by scripts/gen-config-catalog.ts — do not edit by hand.',
    '     Run `pnpm run gen-config-catalog` to regenerate. -->',
    '',
    '# Plugin Config Catalog',
    '',
    'Every `config:` block a `cordis.yml` entry can set: for each loadable harness package, the verbatim config declaration (JSDoc included) its `apply` function or service constructor receives, with every referenced type pasted alongside (package-local types) or linked (everything else). The paste is the plugin\'s full declared config type — a field the runtime schema deliberately excludes is a runtime-only seam (its own JSDoc says so) and is not settable from `cordis.yml`. This is the **deployment**-axis reference — the wiring a plugin author works against is the generated Cordis API region on each [subsystem page](subsystems/core.md), the model-facing tool schemas are the [tool catalog](tool-catalog.md), and [subsystems/](subsystems/core.md) documents the types these declarations reference.',
    '',
    'This file is GENERATED from source (`scripts/gen-config-catalog.ts`) and verified fresh by `pnpm run verify-config-catalog` (part of `doc-sync`) — do not edit it by hand. Declaration blocks use a `ts config-catalog` fence (skipped by doc-typecheck, since a lone declaration referencing imports is not standalone-compilable). The generator also cross-checks the runtime schemastery schema against the pasted declaration — every schema-validated key, nested keys included, must be locatable on the declared config type — so the paste cannot hide a loader-accepted field.',
    '',
    'A `Requires:` line lists the service keys the plugin `inject`s: its `cordis.yml` tree must also load providers for those services. Scope is the harness tier (`packages/`); the vendored cordis plugins a config tree may also load (the console logger, …) are pinned upstream source ([vendoring policy](../vendor/README.md)) and not catalogued here.',
    '',
  ]
  for (const entry of entries.filter(e => e.kind === 'config')) {
    lines.push(...renderConfigEntry(entry, byName))
  }
  lines.push(
    '## Loadable plugins with no config',
    '',
    'These load from a `cordis.yml` entry with no `config:` block; they declare no configuration API.',
    '',
    ...entries.filter(e => e.kind === 'no-config').map(e => renderTerse(e, '')),
    '',
    '## Seam packages (not directly loadable)',
    '',
    'Abstract service classes — a deployment loads a concrete implementation package instead ([capability seams](../.agents/notes/implemented/architecture/2026-06-13-capability-seams.md)).',
    '',
    ...entries.filter(e => e.kind === 'seam').map(e => renderTerse(e, ` — abstract \`${e.className ?? ''}\``)),
    '',
    '## Library packages (no plugin entry)',
    '',
    'Imported as libraries by other packages; a `cordis.yml` cannot load them.',
    '',
    ...entries.filter(e => e.kind === 'library').map(e => renderTerse(e, '')),
    '',
  )
  return lines.join('\n')
}

/** CLI entry: default writes the catalog, `--check` fails if the committed
 * copy is stale. Guarded behind an entry-point check so importing this module
 * for tests neither regenerates the committed file nor calls process.exit. */
function main(): void {
  const content = render(collectConfigCatalog())
  if (process.argv.includes('--check')) {
    let committed: string | null = null
    try {
      committed = readFileSync(resolve(root, OUT), 'utf8')
    } catch {
      // Only ENOENT (not yet generated) is expected; a present-but-unreadable
      // file is not a state this repo produces. Either way the remedy is the
      // same — regenerate — so treat a read failure as "stale".
      committed = null
    }
    if (committed === content) {
      console.log(`gen-config-catalog: ${OUT} is up to date.`)
      process.exit(0)
    }
    console.error(`gen-config-catalog: ${OUT} is stale. Run \`pnpm run gen-config-catalog\` and commit ${OUT}.`)
    process.exit(1)
  }
  writeFileSync(resolve(root, OUT), content)
  console.log(`gen-config-catalog: wrote ${OUT}.`)
}

if (process.argv[1] && import.meta.filename === resolve(process.argv[1])) {
  main()
}
