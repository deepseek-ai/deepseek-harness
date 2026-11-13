/**
 * Reject new reads of the Cordis root context, retiring the recorded existing reads.
 *
 * A read is `Context.root`, `Context['root']`, or a destructured `root` on a value binding of
 * `Context` imported from `@deepseek-ai/cordis`, including a renamed or namespace import, and any
 * string literal whose value is exactly `cordis.root`, the global symbol key behind
 * `Symbol.for('cordis.root')`. Type positions such as `typeof Context.root` are not reads.
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

/** Module that exports the Cordis `Context` class. */
const CORDIS_MODULE = '@deepseek-ai/cordis'

/** Global symbol key of `Context.root`. */
const ROOT_SYMBOL_KEY = 'cordis.root'

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

/** Local names that refer to the Cordis `Context` value or to the Cordis module namespace. */
interface CordisBindings {
  context: Set<string>
  namespace: Set<string>
}

function cordisBindings(source: ts.SourceFile): CordisBindings {
  const bindings: CordisBindings = { context: new Set(), namespace: new Set() }
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || statement.importClause === undefined) continue
    if (!ts.isStringLiteral(statement.moduleSpecifier) || statement.moduleSpecifier.text !== CORDIS_MODULE) continue
    const clause = statement.importClause
    if (clause.phaseModifier === ts.SyntaxKind.TypeKeyword || clause.namedBindings === undefined) continue
    if (ts.isNamespaceImport(clause.namedBindings)) {
      bindings.namespace.add(clause.namedBindings.name.text)
      continue
    }
    for (const element of clause.namedBindings.elements) {
      if (!element.isTypeOnly && (element.propertyName ?? element.name).text === 'Context') {
        bindings.context.add(element.name.text)
      }
    }
  }
  return bindings
}

function isContextValue(node: ts.Expression, bindings: CordisBindings): boolean {
  if (ts.isParenthesizedExpression(node)) return isContextValue(node.expression, bindings)
  if (ts.isIdentifier(node)) return bindings.context.has(node.text)
  return ts.isPropertyAccessExpression(node) && node.name.text === 'Context'
    && ts.isIdentifier(node.expression) && bindings.namespace.has(node.expression.text)
}

function isRootKey(node: ts.Expression): boolean {
  return ts.isStringLiteralLike(node) && node.text === 'root'
}

function bindsRoot(pattern: ts.ObjectBindingPattern): boolean {
  return pattern.elements.some((element) => {
    const name = element.propertyName ?? element.name
    if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) return name.text === 'root'
    return ts.isComputedPropertyName(name) && isRootKey(name.expression)
  })
}

function readsRoot(node: ts.Node, bindings: CordisBindings): boolean {
  if (ts.isPropertyAccessExpression(node)) return node.name.text === 'root' && isContextValue(node.expression, bindings)
  if (ts.isElementAccessExpression(node)) return isRootKey(node.argumentExpression) && isContextValue(node.expression, bindings)
  if (ts.isVariableDeclaration(node)) {
    return node.initializer !== undefined && ts.isObjectBindingPattern(node.name) && bindsRoot(node.name)
      && isContextValue(node.initializer, bindings)
  }
  return ts.isStringLiteralLike(node) && node.text === ROOT_SYMBOL_KEY && !ts.isLiteralTypeNode(node.parent)
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
 * @returns reads in AST traversal order; comments, type positions, and strings other than the
 * exact root symbol key do not match.
 */
export function findCordisRootReads(file: string, text: string): CordisRootRead[] {
  const normalized = file.replaceAll('\\', '/')
  const source = ts.createSourceFile(normalized, text, ts.ScriptTarget.Latest, true)
  const bindings = cordisBindings(source)
  const reads: CordisRootRead[] = []
  const record = (node: ts.Node): void => {
    const access = accessOf(node)
    reads.push({
      file: normalized,
      line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
      fingerprint: syntaxFingerprint(access, source),
    })
  }
  const visit = (node: ts.Node): void => {
    if (readsRoot(node, bindings)) record(node)
    // A type query names `Context.root` without reading it.
    if (ts.isTypeQueryNode(node)) return
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
      + ' register through the plugin context, or use `{ global: true }` for an unscoped listener.',
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
