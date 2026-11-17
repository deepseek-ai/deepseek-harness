/**
 * Reject new reads of the Cordis root context, retiring the recorded existing reads.
 *
 * A read names the root symbol through a Cordis value binding: `Context.root` or `symbols.root`,
 * their `['root']` forms, or `root` destructured from either in a declaration, a parameter default,
 * or an assignment. A binding comes from `@deepseek-ai/cordis` or one of its subpaths through a
 * static import, including renamed and namespace imports, or through a destructured or namespace
 * `import()` or `require()` result. References resolve through the file's own scopes, so a local
 * that shadows the import is not a binding. Any string literal whose value is exactly `cordis.root`,
 * the global symbol key behind `Symbol.for('cordis.root')`, is also a read. Type positions,
 * interfaces, type aliases, and ambient declarations are erased and contain no reads.
 *
 * The check is syntactic: a root context reached through another value, such as a stored
 * reference, an alias of `Context`, a service that returns it, or source text assembled at run
 * time, is outside it.
 *
 * A finding's identity covers the syntax tokens of the access to the root: the element access whose
 * key is the root symbol when one encloses it, otherwise the read itself. Existing reads are
 * recorded in `scripts/cordis-root.baseline.json`; the files in {@link CORDIS_ROOT_EXEMPTIONS} pin
 * the root contract itself and are not scanned.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import {
  countInventory,
  listInventorySources,
  runInventoryGate,
  syntaxFingerprint,
  verifyInventory,
  type InventoryBaseline,
  type InventoryGate,
} from './baseline-inventory.ts'

const root = resolve(import.meta.dirname, '..')

/** Package that exports the Cordis `Context` class and the `symbols` table. */
const CORDIS_MODULE = '@deepseek-ai/cordis'

/** Global symbol key of `Context.root`. */
const ROOT_SYMBOL_KEY = 'cordis.root'

/** Cordis exports that hold the root symbol as their `root` member. */
const ROOT_HOLDERS = new Set(['Context', 'symbols'])

/**
 * Files that exercise the root context itself, keyed by repository path, with the reason each needs
 * it. A key whose file no longer reads the root fails the gate.
 */
export const CORDIS_ROOT_EXEMPTIONS: Readonly<Record<string, string>> = {
  'scripts/cordis-core-rc12.spec.ts': 'pins the vendored Cordis `Context.root` symbol and its `Symbol.for` key',
  'scripts/verify-cordis-root.ts': 'names the root symbol key this gate detects',
}

/** Existing root-read counts, keyed by repository path and syntax fingerprint. */
export type CordisRootBaseline = InventoryBaseline

/** One read of the Cordis root context in authored source. */
export interface CordisRootRead {
  /** Repository-relative path with forward slashes. */
  file: string
  /** One-based source line. */
  line: number
  /** SHA-256 of the access's syntax tokens, excluding comments and whitespace. */
  fingerprint: string
}

/** Declared symbols that refer to a Cordis root holder or to the Cordis module namespace. */
interface CordisBindings {
  checker: ts.TypeChecker
  holders: Set<ts.Symbol>
  namespaces: Set<ts.Symbol>
}

function isCordisSpecifier(node: ts.Node | undefined): boolean {
  return node !== undefined && ts.isStringLiteralLike(node)
    && (node.text === CORDIS_MODULE || node.text.startsWith(`${CORDIS_MODULE}/`))
}

/** Whether an initializer evaluates to the Cordis module: `import()`, `await import()`, or `require()`. */
function loadsCordis(node: ts.Expression): boolean {
  if (ts.isParenthesizedExpression(node) || ts.isAwaitExpression(node)) return loadsCordis(node.expression)
  if (!ts.isCallExpression(node) || node.arguments.length === 0) return false
  const callee = node.expression
  const loader = callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && callee.text === 'require')
  return loader && isCordisSpecifier(node.arguments[0])
}

function propertyText(name: ts.PropertyName | ts.BindingName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) return name.text
  if (ts.isComputedPropertyName(name) && ts.isStringLiteralLike(name.expression)) return name.expression.text
  return undefined
}

/** Type-check one file in isolation, so references resolve through its own scopes only. */
function isolatedChecker(source: ts.SourceFile): ts.TypeChecker {
  const options: ts.CompilerOptions = { allowJs: true, noLib: true, noResolve: true, types: [] }
  const host: ts.CompilerHost = {
    getSourceFile: fileName => (fileName === source.fileName ? source : undefined),
    getDefaultLibFileName: () => 'lib.d.ts',
    writeFile: () => undefined,
    getCurrentDirectory: () => '/',
    getCanonicalFileName: fileName => fileName,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n',
    fileExists: fileName => fileName === source.fileName,
    readFile: () => undefined,
  }
  return ts.createProgram({ rootNames: [source.fileName], options, host }).getTypeChecker()
}

function cordisBindings(source: ts.SourceFile): CordisBindings | undefined {
  if (!source.text.includes(CORDIS_MODULE)) return undefined
  const checker = isolatedChecker(source)
  const bindings: CordisBindings = { checker, holders: new Set(), namespaces: new Set() }
  const add = (set: Set<ts.Symbol>, name: ts.Identifier): void => {
    const symbol = checker.getSymbolAtLocation(name)
    if (symbol !== undefined) set.add(symbol)
  }
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && isCordisSpecifier(node.moduleSpecifier)) {
      const clause = node.importClause
      if (clause === undefined || clause.phaseModifier === ts.SyntaxKind.TypeKeyword) return
      if (clause.name !== undefined) add(bindings.namespaces, clause.name)
      if (clause.namedBindings !== undefined && ts.isNamespaceImport(clause.namedBindings)) {
        add(bindings.namespaces, clause.namedBindings.name)
      } else {
        for (const element of clause.namedBindings?.elements ?? []) {
          if (!element.isTypeOnly && ROOT_HOLDERS.has((element.propertyName ?? element.name).text)) {
            add(bindings.holders, element.name)
          }
        }
      }
      return
    }
    if (ts.isImportEqualsDeclaration(node) && !node.isTypeOnly && ts.isExternalModuleReference(node.moduleReference)
      && isCordisSpecifier(node.moduleReference.expression)) {
      add(bindings.namespaces, node.name)
      return
    }
    if (ts.isVariableDeclaration(node) && node.initializer !== undefined && loadsCordis(node.initializer)) {
      if (ts.isIdentifier(node.name)) add(bindings.namespaces, node.name)
      else if (ts.isObjectBindingPattern(node.name)) {
        for (const element of node.name.elements) {
          const exported = propertyText(element.propertyName ?? element.name)
          if (exported !== undefined && ROOT_HOLDERS.has(exported) && ts.isIdentifier(element.name)) {
            add(bindings.holders, element.name)
          }
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return bindings.holders.size + bindings.namespaces.size === 0 ? undefined : bindings
}

function refersTo(node: ts.Identifier, set: Set<ts.Symbol>, bindings: CordisBindings): boolean {
  const symbol = bindings.checker.getSymbolAtLocation(node)
  return symbol !== undefined && set.has(symbol)
}

/** Whether an expression evaluates to `Context` or `symbols` from Cordis. */
function isRootHolder(node: ts.Expression, bindings: CordisBindings): boolean {
  if (ts.isParenthesizedExpression(node)) return isRootHolder(node.expression, bindings)
  if (ts.isIdentifier(node)) return refersTo(node, bindings.holders, bindings)
  const member = ts.isPropertyAccessExpression(node) ? node.name.text
    : ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression) ? node.argumentExpression.text
      : undefined
  if (member === undefined || !ROOT_HOLDERS.has(member)) return false
  const namespace = (node as ts.PropertyAccessExpression | ts.ElementAccessExpression).expression
  return ts.isIdentifier(namespace) && refersTo(namespace, bindings.namespaces, bindings)
}

function isRootKey(node: ts.Expression): boolean {
  return ts.isStringLiteralLike(node) && node.text === 'root'
}

function bindsRoot(pattern: ts.ObjectBindingPattern): boolean {
  return pattern.elements.some(element => propertyText(element.propertyName ?? element.name) === 'root')
}

function assignsRoot(pattern: ts.ObjectLiteralExpression): boolean {
  return pattern.properties.some((property) => {
    if (ts.isShorthandPropertyAssignment(property)) return property.name.text === 'root'
    return ts.isPropertyAssignment(property) && propertyText(property.name) === 'root'
  })
}

function readsRoot(node: ts.Node, bindings: CordisBindings | undefined): boolean {
  if (ts.isStringLiteralLike(node)) return node.text === ROOT_SYMBOL_KEY
  if (bindings === undefined) return false
  if (ts.isPropertyAccessExpression(node)) return node.name.text === 'root' && isRootHolder(node.expression, bindings)
  if (ts.isElementAccessExpression(node)) return isRootKey(node.argumentExpression) && isRootHolder(node.expression, bindings)
  if (ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node)) {
    return node.initializer !== undefined && ts.isObjectBindingPattern(node.name) && bindsRoot(node.name)
      && isRootHolder(node.initializer, bindings)
  }
  return ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
    && ts.isObjectLiteralExpression(node.left) && assignsRoot(node.left) && isRootHolder(node.right, bindings)
}

/** Whether a subtree is erased from the emitted program, so it contains no reads. */
function isErased(node: ts.Node): boolean {
  if (ts.isSourceFile(node)) return node.isDeclarationFile
  if (ts.canHaveModifiers(node) && ts.getModifiers(node)?.some(modifier => modifier.kind === ts.SyntaxKind.DeclareKeyword)) {
    return true
  }
  if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) return true
  // A class `extends` clause evaluates its expression; every other type node is erased.
  if (ts.isExpressionWithTypeArguments(node)) {
    return !(ts.isHeritageClause(node.parent) && node.parent.token === ts.SyntaxKind.ExtendsKeyword
      && ts.isClassLike(node.parent.parent))
  }
  return ts.isTypeNode(node)
}

/** The expression whose tokens identify a read: an element access keyed by the root, or the read. */
function accessOf(node: ts.Node): ts.Node {
  let current = node
  while (ts.isParenthesizedExpression(current.parent) || (ts.isCallExpression(current.parent)
    && current.parent.arguments.length === 1 && current.parent.arguments[0] === current)) {
    current = current.parent
  }
  const parent = current.parent
  return ts.isElementAccessExpression(parent) && parent.argumentExpression === current ? parent : node
}

/**
 * Find reads of the Cordis root context.
 * @param file - repository-relative source path; its extension selects TS or TSX parsing.
 * @param text - source contents.
 * @returns reads in AST traversal order; comments, erased type syntax, shadowed names, and strings
 * other than the exact root symbol key do not match.
 */
export function findCordisRootReads(file: string, text: string): CordisRootRead[] {
  const normalized = file.replaceAll('\\', '/')
  const source = ts.createSourceFile(`/${normalized}`, text, ts.ScriptTarget.Latest, true)
  const bindings = cordisBindings(source)
  const reads: CordisRootRead[] = []
  const record = (node: ts.Node): void => {
    reads.push({
      file: normalized,
      line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
      fingerprint: syntaxFingerprint(accessOf(node), source),
    })
  }
  const visit = (node: ts.Node): void => {
    if (isErased(node)) return
    if (readsRoot(node, bindings)) record(node)
    ts.forEachChild(node, visit)
  }
  visit(source)
  return reads
}

/**
 * Scan tracked source and non-ignored new source, including tests and configuration files.
 * @param repoRoot - repository root containing the Git index.
 * @param exemptions - repository paths left unscanned, each of which must still read the root.
 * @returns every root read outside the exempt files.
 * @throws if discovery omits a required source area, an eligible path is a symlink, or an exempt
 * file is missing or no longer reads the root.
 */
export function scanCordisRootReads(
  repoRoot: string,
  exemptions: Readonly<Record<string, string>> = CORDIS_ROOT_EXEMPTIONS,
): CordisRootRead[] {
  const files = listInventorySources(repoRoot, 'verify-cordis-root')
  const reads = files.flatMap(file => findCordisRootReads(file, readFileSync(resolve(repoRoot, file), 'utf8')))
  for (const file of Object.keys(exemptions)) {
    if (!reads.some(read => read.file === file)) {
      throw new Error(`verify-cordis-root: exempt file ${file} no longer reads the root context; remove its exemption`)
    }
  }
  return reads.filter(read => !Object.hasOwn(exemptions, read.file))
}

function createGate(exemptions: Readonly<Record<string, string>>): InventoryGate<CordisRootRead> {
  return {
    name: 'verify-cordis-root',
    baselinePath: 'scripts/cordis-root.baseline.json',
    scan: repoRoot => scanCordisRootReads(repoRoot, exemptions),
    rejection: 'new reads of the Cordis root context are forbidden. Declare the service in `inject`,'
      + ' register through the plugin context, or use `{ global: true }` for an unscoped listener'
      + ' (see docs/defensive-patterns/general.md#plugins-do-not-read-the-cordis-root-context).',
    describe: read => `${read.file}:${String(read.line)} (${read.fingerprint})`,
    success: count => `verify-cordis-root: no new root reads; ${String(count)} recorded reads remain.`,
  }
}

/**
 * Count exact reads without granting a file-wide allowance.
 * @param reads - observed root reads.
 * @returns path and fingerprint counts in stable order for comparison and pruning.
 */
export function countCordisRootReads(reads: readonly CordisRootRead[]): CordisRootBaseline {
  return countInventory(reads)
}

/**
 * Enforce the recorded root-read inventory, optionally deleting retired allowances.
 * @param repoRoot - repository root to scan.
 * @param prune - remove stale entries only after establishing that no new read exists.
 * @param exemptions - repository paths left unscanned, each of which must still read the root.
 * @returns the number of recorded reads still present.
 * @throws for new reads, malformed inventories, stale entries without pruning, or stale exemptions.
 */
export function verifyCordisRoot(
  repoRoot: string,
  prune = false,
  exemptions: Readonly<Record<string, string>> = CORDIS_ROOT_EXEMPTIONS,
): number {
  return verifyInventory(createGate(exemptions), repoRoot, prune)
}

if (import.meta.filename === resolve(process.argv[1] ?? '')) {
  runInventoryGate(createGate(CORDIS_ROOT_EXEMPTIONS), root)
}
