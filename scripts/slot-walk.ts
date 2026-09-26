/**
 * AST helpers for the client slot surface: the `SlotMap` declaration merges
 * that type every slot, and the `slots.register` / `slots.registerFactory`
 * call sites that say who occupies or declares one. Both readings are lexical:
 * the client catalog generator consumes them, and the same scan doubles as its
 * own exhaustiveness backstop because it reads every source file rather than a
 * reachable-export closure.
 */

import { globSync, readFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import ts from 'typescript'

/** The module whose `SlotMap` / standard-kit interfaces every slot owner merges into. */
const SLOTS_MODULE = '@deepseek-ai/dsh-client-ui-slots'

/** Cheap textual prefilter for a slot-contract merge, quote-style agnostic. */
const MERGE_HEAD = /declare module ['"]@deepseek-ai\/dsh-client-ui-slots['"]/

/** Cheap textual prefilter for a Slot or Factory registration call site. */
const REGISTER_HEAD = /\.(?:register|registerFactory)\(/

/** One `SlotMap` member: the slot's contract as its owning package declares it. */
export interface SlotDeclaration {
  /** SlotMap key, e.g. `settings.section`. */
  key: string
  /** Cardinality literal (`single` / `list` / `keyed` / `chain`), or '' when not a literal. */
  kind: string
  /** Data-scope literal (`root` / `session` / `session-maybe`), or '' when not a literal. */
  scope: string
  /** Type name of the owner-supplied props share, absent when the slot declares none. */
  ownerType?: string
  /** Source text of the `keyProps` member (keyed slots), absent otherwise. */
  keyProps?: string
  /** Source text of the `hookContext` member, absent otherwise. */
  hookContext?: string
  /** Type name of the slot-level inject face, absent when the slot declares none. */
  injectType?: string
  /** The member's JSDoc with container indentation removed, '' when undocumented. */
  jsDoc: string
  /** Workspace package that declares the contract. */
  package: string
  /** Source pointer `packages/…/file.ts:line`. */
  source: string
}

/** One `slots.register()` or `slots.registerFactory()` call site. */
export interface SlotRegistration {
  /** Target SlotMap key the entry contributes into. */
  key: string
  /** Workspace package that registers the entry. */
  package: string
  /** Component argument as written (identifier, or a trimmed expression). */
  component: string
  /** `id` literal of a list entry, absent otherwise. */
  id?: string
  /** `key` literal of a keyed entry, absent otherwise. */
  entryKey?: string
  /** SlotMap keys this registration declares as children (they exist while it is mounted). */
  children: string[]
  /** Whether this call installs a Factory definition instead of occupying an ordinary Slot. */
  factory?: boolean
  /** Source pointer `packages/…/file.ts:line`. */
  source: string
}

/** One exported type declaration, retained with its JSDoc for catalog projection. */
export interface TypeDeclaration {
  /** Declared name. */
  name: string
  /** Full declaration text INCLUDING its JSDoc (member docs are the teaching text). */
  text: string
  /** Source pointer `packages/…/file.ts:line`. */
  source: string
}

/** One scanned source file with the artifacts the catalog reads from it. */
export interface ScannedFile {
  /** Repo-relative, `/`-normalized path. */
  rel: string
  /** Workspace package name that owns the file. */
  package: string
  /** Parsed source file. */
  sf: ts.SourceFile
}

/**
 * Parse every file matching `patterns`, keeping the ones that carry a slot
 * contract merge or a registration call. Files without either are skipped so
 * the scan stays cheap over the whole workspace.
 * @param scanRoot - repository root the patterns resolve against.
 * @param patterns - glob(s) selecting the TypeScript/TSX files to scan.
 * @returns one entry per interesting file, in path order.
 */
export function scanSlotFiles(scanRoot: string, patterns: readonly string[]): ScannedFile[] {
  const out: ScannedFile[] = []
  const names = new Map<string, string>()
  const rels = [...new Set(globSync(patterns as string[], { cwd: scanRoot })
    .map(path => path.split(sep).join('/')))].sort()
  for (const rel of rels) {
    const abs = resolve(scanRoot, rel)
    const text = readFileSync(abs, 'utf8')
    if (!MERGE_HEAD.test(text) && !REGISTER_HEAD.test(text)) continue
    out.push({
      rel,
      package: packageNameOf(scanRoot, rel, names),
      sf: ts.createSourceFile(abs, text, ts.ScriptTarget.Latest, true, scriptKindOf(rel)),
    })
  }
  return out
}

/**
 * Index every exported type declaration of the scanned packages, keeping JSDoc.
 * The catalog resolves owner-props and inject-face shapes through this index
 * instead of a type-checker program: the declaration text with its member
 * documentation IS the teaching material a registrant needs.
 * @param scanRoot - repository root the patterns resolve against.
 * @param patterns - glob(s) selecting the TypeScript/TSX files to index.
 * @returns name → declaration, with names declared more than once dropped as ambiguous.
 */
export function indexExportedTypes(scanRoot: string, patterns: readonly string[]): Map<string, TypeDeclaration> {
  const index = new Map<string, TypeDeclaration>()
  const ambiguous = new Set<string>()
  const rels = [...new Set(globSync(patterns as string[], { cwd: scanRoot })
    .map(path => path.split(sep).join('/')))].sort()
  for (const rel of rels) {
    const abs = resolve(scanRoot, rel)
    const sf = ts.createSourceFile(abs, readFileSync(abs, 'utf8'), ts.ScriptTarget.Latest, true, scriptKindOf(rel))
    for (const statement of sf.statements) {
      if (!ts.isInterfaceDeclaration(statement) && !ts.isTypeAliasDeclaration(statement)) continue
      if (!statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue
      const name = statement.name.text
      if (index.has(name)) {
        ambiguous.add(name)
        continue
      }
      index.set(name, {
        name,
        text: declarationText(statement, sf),
        source: `${rel}:${String(lineOf(sf, statement))}`,
      })
    }
  }
  for (const name of ambiguous) index.delete(name)
  return index
}

/**
 * Read every `SlotMap` member declared in one scanned file.
 * @param file - a file returned by {@link scanSlotFiles}.
 * @returns the declared slots, in source order.
 */
export function slotDeclarations(file: ScannedFile): SlotDeclaration[] {
  const out: SlotDeclaration[] = []
  for (const body of slotModuleBodies(file.sf)) {
    for (const statement of body.statements) {
      if (!ts.isInterfaceDeclaration(statement) || statement.name.text !== 'SlotMap') continue
      for (const member of statement.members) {
        if (!ts.isPropertySignature(member) || member.type === undefined) continue
        const key = ts.isStringLiteral(member.name) || ts.isIdentifier(member.name)
          ? member.name.text
          : member.name.getText(file.sf)
        const entry = ts.isTypeLiteralNode(member.type) ? member.type : undefined
        const ownerType = memberTypeText(entry, 'owner', file.sf)
        const keyProps = memberTypeText(entry, 'keyProps', file.sf)
        const hookContext = memberTypeText(entry, 'hookContext', file.sf)
        const injectType = memberTypeText(entry, 'inject', file.sf)
        out.push({
          key,
          kind: literalMember(entry, 'kind'),
          scope: literalMember(entry, 'scope'),
          ...ownerType === undefined ? {} : { ownerType },
          ...keyProps === undefined ? {} : { keyProps },
          ...hookContext === undefined ? {} : { hookContext },
          ...injectType === undefined ? {} : { injectType },
          jsDoc: jsDocOf(member, file.sf),
          package: file.package,
          source: `${file.rel}:${String(lineOf(file.sf, member))}`,
        })
      }
    }
  }
  return out
}

/**
 * Read every Slot or Factory registration call site in one scanned file: which
 * name it targets, with which component and cell identity, and which ordinary
 * child slots it declares. A call whose `name` is not a string literal is skipped — the
 * shipped composition always names its target literally, and a computed name
 * carries no catalog fact.
 * @param file - a file returned by {@link scanSlotFiles}.
 * @returns the registrations, in source order.
 */
export function slotRegistrations(file: ScannedFile): SlotRegistration[] {
  const out: SlotRegistration[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && (node.expression.name.text === 'register' || node.expression.name.text === 'registerFactory')
      && isSlotsReceiver(node.expression.expression, file.sf)
      && node.arguments.length >= 1) {
      const options = node.arguments[0]
      if (options !== undefined && ts.isObjectLiteralExpression(options)) {
        const key = stringProperty(options, 'name')
        if (key !== undefined) {
          const id = stringProperty(options, 'id')
          const entryKey = stringProperty(options, 'key')
          out.push({
            key,
            package: file.package,
            component: componentText(node.arguments[1], file.sf),
            ...node.expression.name.text === 'registerFactory' ? { factory: true } : {},
            ...id === undefined ? {} : { id },
            ...entryKey === undefined ? {} : { entryKey },
            children: childKeys(options),
            source: `${file.rel}:${String(lineOf(file.sf, node))}`,
          })
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(file.sf)
  return out
}

/**
 * Read one standard-kit interface's members from the scanned files: the props
 * a slot component receives for free from the framework at a given scope.
 * @param files - scanned files to search.
 * @param interfaceName - `GlobalStandardProps`, `SessionStandardProps`, or `SessionMaybeStandardProps`.
 * @returns `member: type` texts in declaration order, merged across declaring files.
 */
export function standardKitMembers(files: readonly ScannedFile[], interfaceName: string): string[] {
  const out: string[] = []
  for (const file of files) {
    for (const body of slotModuleBodies(file.sf)) {
      for (const statement of body.statements) {
        if (!ts.isInterfaceDeclaration(statement) || statement.name.text !== interfaceName) continue
        for (const member of statement.members) {
          if (!ts.isPropertySignature(member)) continue
          const type = member.type === undefined ? 'unknown' : member.type.getText(file.sf)
          out.push(`${member.name.getText(file.sf)}${member.questionToken === undefined ? '' : '?'}: ${collapse(type)}`)
        }
      }
    }
  }
  return out
}

/**
 * Names in the type index that seed texts mention, word-bounded — ONE level, not
 * a transitive closure. The catalog expands an owner-props contract exactly one
 * step: the owner interface carries the interaction protocol in its own member
 * documentation, while the shapes its fields reference belong to the subsystems
 * that own them and would otherwise drag the entire session model into a single
 * slot's report.
 * @param seeds - declaration or signature texts to search.
 * @param index - the type index from {@link indexExportedTypes}.
 * @returns the mentioned names, sorted.
 */
export function referencedTypeNames(
  seeds: readonly string[],
  index: ReadonlyMap<string, TypeDeclaration>,
): string[] {
  const found: string[] = []
  for (const name of index.keys()) {
    const pattern = new RegExp(`\\b${name}\\b`)
    if (seeds.some(text => pattern.test(text))) found.push(name)
  }
  return found.sort()
}

/**
 * Resolve declarations by name, dropping names the index does not hold.
 * @param names - type names to resolve.
 * @param index - the type index from {@link indexExportedTypes}.
 * @returns the resolved declarations, sorted by name.
 */
export function declaredTypes(
  names: readonly string[],
  index: ReadonlyMap<string, TypeDeclaration>,
): TypeDeclaration[] {
  return [...names]
    .flatMap(name => index.get(name) ?? [])
    .sort((left, right) => left.name.localeCompare(right.name))
}

/** Every slot-contract module block in one file, in source order. */
function slotModuleBodies(sf: ts.SourceFile): ts.ModuleBlock[] {
  const bodies: ts.ModuleBlock[] = []
  for (const statement of sf.statements) {
    if (!ts.isModuleDeclaration(statement) || !ts.isStringLiteral(statement.name)) continue
    if (statement.name.text !== SLOTS_MODULE) continue
    if (statement.body !== undefined && ts.isModuleBlock(statement.body)) bodies.push(statement.body)
  }
  return bodies
}

/**
 * Whether a `X.register(...)` receiver is the slots service. Every other
 * registry in the repo (`ctx.tools`, `ctx.commands`, `ctx.settings`, …) also
 * takes an options object with a `name`, so the receiver is what separates a
 * slot occupancy fact from an unrelated registration.
 */
function isSlotsReceiver(receiver: ts.Expression, sf: ts.SourceFile): boolean {
  const text = receiver.getText(sf)
  return text === 'slots' || text.endsWith('.slots')
}

/** The workspace package name owning a repo-relative file, memoized per package root. */
function packageNameOf(scanRoot: string, rel: string, cache: Map<string, string>): string {
  let dir = dirname(resolve(scanRoot, rel))
  while (dir.length > scanRoot.length) {
    const cached = cache.get(dir)
    if (cached !== undefined) return cached
    try {
      const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: unknown }
      if (typeof manifest.name === 'string') {
        cache.set(dir, manifest.name)
        return manifest.name
      }
    } catch {
      // No manifest at this level: keep walking up to the owning package root.
    }
    dir = dirname(dir)
  }
  return '(unknown package)'
}

/** TSX must parse as TSX; a `.ts` file with JSX-looking generics must not. */
function scriptKindOf(rel: string): ts.ScriptKind {
  return rel.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
}

/** 1-based line of a node's first character. */
function lineOf(sf: ts.SourceFile, node: ts.Node): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1
}

/** Declaration text including leading JSDoc, with container indentation removed. */
function declarationText(statement: ts.Node, sf: ts.SourceFile): string {
  return dedent(sf.text.slice(statement.getStart(sf, true), statement.getEnd()))
}

/** One member's JSDoc comment text, '' when the member has none. */
function jsDocOf(member: ts.Node, sf: ts.SourceFile): string {
  // getStart(includeJsDoc) brackets exactly the doc comment: with it the range
  // opens at `/**`, without it at the member itself.
  const withDoc = member.getStart(sf, true)
  const withoutDoc = member.getStart(sf, false)
  if (withDoc >= withoutDoc) return ''
  return dedent(sf.text.slice(withDoc, withoutDoc).trimEnd())
}

/** Strip the shared leading indentation of a multi-line source slice. */
function dedent(text: string): string {
  const lines = text.split('\n')
  const indents = lines.slice(1).filter(line => line.trim() !== '')
    .map(line => (/^\s*/.exec(line) as RegExpExecArray)[0].length)
  const shared = indents.length === 0 ? 0 : Math.min(...indents)
  return [lines[0] ?? '', ...lines.slice(1).map(line => line.slice(shared))].join('\n').trimEnd()
}

/** Collapse a type text to one line so catalog rows stay one row. */
function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** A type-literal member's string-literal type text, '' when absent or computed. */
function literalMember(entry: ts.TypeLiteralNode | undefined, name: string): string {
  const member = namedMember(entry, name)
  if (member?.type === undefined) return ''
  return ts.isLiteralTypeNode(member.type) && ts.isStringLiteral(member.type.literal)
    ? member.type.literal.text
    : ''
}

/** A type-literal member's type text on one line, absent when the member is. */
function memberTypeText(
  entry: ts.TypeLiteralNode | undefined,
  name: string,
  sf: ts.SourceFile,
): string | undefined {
  const member = namedMember(entry, name)
  return member?.type === undefined ? undefined : collapse(member.type.getText(sf))
}

/** One named property signature of a type literal. */
function namedMember(entry: ts.TypeLiteralNode | undefined, name: string): ts.PropertySignature | undefined {
  if (entry === undefined) return undefined
  for (const member of entry.members) {
    if (ts.isPropertySignature(member) && memberName(member.name) === name) return member
  }
  return undefined
}

/** A property name's text, quotes removed. */
function memberName(name: ts.PropertyName): string {
  return ts.isStringLiteral(name) || ts.isIdentifier(name) ? name.text : name.getText()
}

/** One string-literal property of an options object literal. */
function stringProperty(options: ts.ObjectLiteralExpression, name: string): string | undefined {
  for (const property of options.properties) {
    if (!ts.isPropertyAssignment(property)) continue
    if (memberName(property.name) !== name) continue
    if (ts.isStringLiteral(property.initializer)) return property.initializer.text
  }
  return undefined
}

/** The SlotMap keys a registration's `children` table declares. */
function childKeys(options: ts.ObjectLiteralExpression): string[] {
  for (const property of options.properties) {
    if (!ts.isPropertyAssignment(property)) continue
    if (memberName(property.name) !== 'children') continue
    if (!ts.isObjectLiteralExpression(property.initializer)) return []
    return property.initializer.properties
      .flatMap(child => (child.name === undefined ? [] : [memberName(child.name)]))
  }
  return []
}

/** The component argument as written; a non-identifier expression is collapsed. */
function componentText(argument: ts.Expression | undefined, sf: ts.SourceFile): string {
  if (argument === undefined) return '(none)'
  const text = collapse(argument.getText(sf))
  return text.length > 60 ? `${text.slice(0, 57)}…` : text
}
