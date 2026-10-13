/**
 * Verify root-relative documentation paths in repo-authored TypeScript. The
 * textual scan covers `docs/*.md` and `.agents/notes/*.md`, requires the
 * extension, checks matching string literals too, and excludes built
 * declarations and vendored source.
 */

import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { findReferenceViolations, uniqueRepoFiles, type ReferenceViolation as Violation } from './repo-files.ts'

const root = resolve(import.meta.dirname, '..')

/** Repo-authored TypeScript that may cite docs in comments. */
const PATTERNS = ['packages/**/*.ts']

/** Paths excluded from the scan: built output and vendored upstream source. */
const isExcluded = (p: string): boolean =>
  p.includes('/lib/') || p.endsWith('.d.ts') || p.startsWith('vendor/')

/** A non-first `lib` segment puts `/lib/` in every path below the directory, so the walker skips it. */
const isExcludedDirectory = (dir: string): boolean => dir.split('/').slice(1).includes('lib')

/** Root-relative Markdown path token, excluding trailing prose. */
const DOC_REF = /(?:\bdocs|\.agents\/notes)\/[A-Za-z0-9._/-]+\.md/g

/** Find every broken root-relative documentation reference in one TypeScript file. */
function findViolations(absPath: string): Violation[] {
  return findReferenceViolations(root, absPath, DOC_REF, ref => ref, ref => !existsSync(resolve(root, ref)))
}

const files = uniqueRepoFiles(root, PATTERNS, isExcluded, isExcludedDirectory)
const all = files.flatMap(file => findViolations(file.abs))
const checked = files.length

if (all.length === 0) {
  console.log(`verify-doc-refs: ${checked} file(s) checked, all documentation references resolve.`)
  process.exit(0)
}

console.error('verify-doc-refs: broken documentation references found in source comments (target does not exist):')
for (const v of all) {
  console.error(`  ${v.file}:${v.line}  ${v.ref}`)
}
process.exit(1)
