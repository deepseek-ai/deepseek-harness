/**
 * Reject empty `catch` clauses that break the recorded rule, retiring the legacy clauses.
 *
 * An empty clause — a body whose statements, if any, are all bare `;` — must name the discarded
 * error, state in a comment why the error needs no handling, and wrap a `try` holding one
 * statement; a wider `try` hides statements whose failures the clause also discards.
 *
 * A body holding any other statement is out of scope: whether it handles the error is not
 * decidable from syntax, so `catch { "use strict" }` and similar no-ops stay legal and the
 * specification records that boundary. So is a file the parser cannot read past, which yields
 * whatever clauses it recovered; the typecheck covers tracked source.
 *
 * Legacy clauses that break a condition are recorded in `scripts/empty-catch.baseline.json`.
 * Fixing one requires `--prune` to retire its entry, and a merge that brings recorded clauses
 * requires `--record <merged-ref>`.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import {
  countInventory,
  listInventorySources,
  recordInventory,
  runInventoryGate,
  syntaxFingerprint,
  verifyInventory,
  type InventoryBaseline,
  type InventoryGate,
} from './baseline-inventory.ts'

const root = resolve(import.meta.dirname, '..')

/** Existing empty-clause counts, keyed by repository path and syntax fingerprint. */
export type EmptyCatchBaseline = InventoryBaseline

/** One condition of the rule that an empty clause breaks. */
export type EmptyCatchDefect = 'unnamed' | 'unexplained' | 'wide-try'

/** One empty `catch` clause that breaks at least one condition. */
export interface EmptyCatch {
  /** Repository-relative path with forward slashes. */
  file: string
  /** One-based line of the `catch` keyword. */
  line: number
  /** SHA-256 of the clause's syntax tokens, excluding comments and whitespace. */
  fingerprint: string
  /** Broken conditions in {@link EmptyCatchDefect} order. */
  defects: readonly EmptyCatchDefect[]
}

/** Findings plus the number of clauses examined, which detects a walk that stopped matching. */
interface EmptyCatchScan {
  findings: EmptyCatch[]
  clauses: number
}

function scriptKind(file: string): ts.ScriptKind {
  if (file.endsWith('.tsx')) return ts.ScriptKind.TSX
  if (file.endsWith('.jsx')) return ts.ScriptKind.JSX
  if (/\.(?:js|mjs|cjs)$/u.test(file)) return ts.ScriptKind.JS
  return ts.ScriptKind.TS
}

/**
 * Whether the span holds a comment token.
 *
 * Scanning the span keeps a comment marker inside a string or template literal from counting.
 * @param text - the whole source file.
 * @param from - inclusive start offset of the span.
 * @param to - exclusive end offset of the span.
 * @returns `true` when the span holds a line or block comment.
 */
function hasComment(text: string, from: number, to: number): boolean {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, text.slice(from, to))
  for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) {
    if (kind === ts.SyntaxKind.SingleLineCommentTrivia || kind === ts.SyntaxKind.MultiLineCommentTrivia) return true
  }
  return false
}

/**
 * Span that can carry a clause's reason: from just after the preceding token — a line above the
 * `catch` keyword belongs to the clause — through the end of the line closing its block.
 * @param clause - the catch clause whose reason to look for.
 * @param text - the whole source file.
 * @returns inclusive start and exclusive end offsets.
 */
function reasonSpan(clause: ts.CatchClause, text: string): { from: number; to: number } {
  const lineEnd = text.indexOf('\n', clause.end)
  return { from: clause.getFullStart(), to: lineEnd === -1 ? text.length : lineEnd }
}

/** Names a binding pattern binds, so `catch ({})` names nothing. */
function boundNames(name: ts.BindingName, names: string[]): void {
  if (ts.isIdentifier(name)) {
    names.push(name.text)
    return
  }
  for (const element of name.elements) {
    if (!ts.isOmittedExpression(element)) boundNames(element.name, names)
  }
}

/** Bound names of the thrown value; empty for `catch {` and for a pattern that binds nothing. */
function bindingNames(clause: ts.CatchClause): readonly string[] {
  const declaration = clause.variableDeclaration
  if (declaration === undefined) return []
  const names: string[] = []
  boundNames(declaration.name, names)
  return names
}

/** Statements other than a bare `;`, which cannot stand in for handling an error. */
function nonEmptyStatements(block: ts.Block): readonly ts.Statement[] {
  return block.statements.filter(statement => !ts.isEmptyStatement(statement))
}

function analyze(file: string, text: string): EmptyCatchScan {
  const normalized = file.replaceAll('\\', '/')
  const source = ts.createSourceFile(normalized, text, ts.ScriptTarget.Latest, true, scriptKind(normalized))
  const findings: EmptyCatch[] = []
  let clauses = 0
  const visit = (node: ts.Node): void => {
    if (ts.isCatchClause(node)) {
      clauses += 1
      if (nonEmptyStatements(node.block).length === 0) {
        const names = bindingNames(node)
        const defects: EmptyCatchDefect[] = []
        if (!names.some(name => name !== '_')) defects.push('unnamed')
        const span = reasonSpan(node, text)
        if (!hasComment(text, span.from, span.to)) defects.push('unexplained')
        if (!ts.isTryStatement(node.parent) || nonEmptyStatements(node.parent.tryBlock).length !== 1) {
          defects.push('wide-try')
        }
        if (defects.length > 0) {
          findings.push({
            file: normalized,
            line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
            fingerprint: syntaxFingerprint(node, source),
            defects,
          })
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return { findings, clauses }
}

/**
 * Find empty catch clauses that break the rule.
 * @param file - repository-relative source path; its extension selects the parse mode.
 * @param text - source contents.
 * @returns findings in AST traversal order; a clause whose body holds a real statement never matches.
 */
export function findEmptyCatches(file: string, text: string): EmptyCatch[] {
  return analyze(file, text).findings
}

/**
 * Scan tracked source and non-ignored new source, including tests and configuration files.
 * @param repoRoot - repository root containing the Git index.
 * @returns every empty clause that breaks the rule in the current working tree.
 * @throws if discovery omits a required source area, finds no catch clause at all, or an eligible path is a symlink.
 */
export function scanEmptyCatches(repoRoot: string): EmptyCatch[] {
  const scans = listInventorySources(repoRoot, 'verify-empty-catch')
    .map(file => analyze(file, readFileSync(resolve(repoRoot, file), 'utf8')))
  if (scans.every(scan => scan.clauses === 0)) {
    throw new Error('verify-empty-catch: source discovery found no catch clause')
  }
  return scans.flatMap(scan => scan.findings)
}

const gate: InventoryGate<EmptyCatch> = {
  name: 'verify-empty-catch',
  baselinePath: 'scripts/empty-catch.baseline.json',
  scan: scanEmptyCatches,
  rejection: 'an empty catch must name the discarded error, state why it needs no handling,'
    + ' and keep its try to one statement (see .agents/skills/dsh-error-handling/SKILL.md#catch-recover-or-stop).',
  describe: finding => `${finding.file}:${String(finding.line)} (${finding.defects.join(', ')})`,
  success: count => `verify-empty-catch: no new silent catches; ${String(count)} recorded clauses remain.`,
}

/**
 * Count exact clauses without granting a file-wide allowance.
 * @param findings - observed empty clauses.
 * @returns path and fingerprint counts in stable order for comparison and pruning.
 */
export function countEmptyCatches(findings: readonly EmptyCatch[]): EmptyCatchBaseline {
  return countInventory(findings)
}

/**
 * Enforce the recorded clause inventory, optionally deleting retired allowances.
 * @param repoRoot - repository root to scan.
 * @param prune - remove stale entries only after establishing that no new clause breaks the rule.
 * @returns the number of clauses that still break the rule.
 * @throws for new broken clauses, malformed inventories, or stale entries without pruning.
 */
export function verifyEmptyCatch(repoRoot: string, prune = false): number {
  return verifyInventory(gate, repoRoot, prune)
}

/**
 * Record the current clauses, after proving every clause the inventory does not allow already
 * exists at `ref`. A merge that lands recorded clauses is the only case that adds entries.
 * @param repoRoot - repository root to scan and write.
 * @param ref - a revision the repository contains, normally the merged target branch.
 * @returns the number of recorded clauses.
 * @throws when `ref` is not an ancestor of the current commit, or a newly allowed clause is absent at `ref`.
 */
export function recordEmptyCatch(repoRoot: string, ref: string): number {
  return recordInventory(gate, repoRoot, ref)
}

if (import.meta.filename === resolve(process.argv[1] ?? '')) {
  runInventoryGate(gate, root)
}
