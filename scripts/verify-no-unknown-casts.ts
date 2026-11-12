/** Reject new assertions to unknown while retiring the recorded existing assertions. */

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

/** Existing assertion counts, keyed by repository path and syntax fingerprint. */
export type UnknownCastBaseline = InventoryBaseline

/** One direct assertion to unknown in authored source. */
export interface UnknownCast {
  /** Repository-relative path with forward slashes. */
  file: string
  /** One-based source line. */
  line: number
  /** SHA-256 of the assertion's syntax tokens, excluding comments and whitespace. */
  fingerprint: string
}

function assertsUnknown(type: ts.TypeNode): boolean {
  if (ts.isParenthesizedTypeNode(type)) return assertsUnknown(type.type)
  return type.kind === ts.SyntaxKind.UnknownKeyword
    || (ts.isUnionTypeNode(type) && type.types.some(assertsUnknown))
}

/**
 * Find assertions to unknown, including angle syntax and unknown members of asserted unions.
 * @param file - repository-relative source path; its extension selects TS or TSX parsing.
 * @param text - source contents.
 * @returns assertions in AST traversal order; comments, strings, aliases and unknown containers do not match.
 */
export function findUnknownCasts(file: string, text: string): UnknownCast[] {
  const normalized = file.replaceAll('\\', '/')
  const source = ts.createSourceFile(normalized, text, ts.ScriptTarget.Latest, true)
  const casts: UnknownCast[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
      if (assertsUnknown(node.type)) {
        casts.push({
          file: normalized,
          line: source.getLineAndCharacterOfPosition(node.type.getStart(source)).line + 1,
          fingerprint: syntaxFingerprint(node, source),
        })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return casts
}

/**
 * Scan tracked source and non-ignored new source, including tests and configuration files.
 * @param repoRoot - repository root containing the Git index.
 * @returns every direct unknown assertion in the current working tree.
 * @throws if discovery omits a required source area or an eligible path is a symlink.
 */
export function scanUnknownCasts(repoRoot: string): UnknownCast[] {
  return listInventorySources(repoRoot, 'verify-no-unknown-casts')
    .flatMap(file => findUnknownCasts(file, readFileSync(resolve(repoRoot, file), 'utf8')))
}

const gate: InventoryGate<UnknownCast> = {
  name: 'verify-no-unknown-casts',
  baselinePath: 'scripts/no-unknown-casts.baseline.json',
  scan: scanUnknownCasts,
  rejection: 'new assertions to unknown are forbidden. Use a typed value or narrow the input.',
  describe: cast => `${cast.file}:${String(cast.line)} (${cast.fingerprint})`,
  success: count => `verify-no-unknown-casts: no new assertions; ${String(count)} existing assertions remain.`,
}

/**
 * Count exact assertions without granting a file-wide allowance.
 * @param casts - observed assertions.
 * @returns path and fingerprint counts in stable order for comparison and pruning.
 */
export function countUnknownCasts(casts: readonly UnknownCast[]): UnknownCastBaseline {
  return countInventory(casts)
}

/**
 * Enforce the recorded assertion inventory, optionally deleting retired allowances.
 * @param repoRoot - repository root to scan.
 * @param prune - remove stale entries only after establishing that no new assertion exists.
 * @returns the number of existing assertions still present.
 * @throws for new assertions, malformed inventories, or stale entries without pruning.
 */
export function verifyNoUnknownCasts(repoRoot: string, prune = false): number {
  return verifyInventory(gate, repoRoot, prune)
}

if (import.meta.filename === resolve(process.argv[1] ?? '')) {
  runInventoryGate(gate, root)
}
