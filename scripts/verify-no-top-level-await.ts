/**
 * Verify that no importable package source module awaits at module scope.
 *
 * A module-scope `await` makes module evaluation asynchronous: every importer's
 * evaluation then waits on it, a rejection surfaces as a module-evaluation
 * failure instead of an error the module handles, and the module cannot be
 * lowered to the synchronous CommonJS wrapper the browser-worker image loads.
 * Package code does its asynchronous work inside a function it calls, such as an
 * explicit `main()` in a process entry, and handles that promise's failure.
 *
 * Executables are not imported, so they are excluded by declaration, never by
 * file name: a source file that starts with a `#!` line, and the source of a
 * build output that a package manifest's `bin` field names. The repository build
 * emits `src/<path>.ts` and `src/<path>.tsx` as `lib/<path>.js`; a `bin` target
 * outside `lib/` is not a build output and excludes no source file.
 *
 * Discovery is syntax-aware, as `scripts/AGENTS.md` requires: the TypeScript
 * parser finds `await` expressions, `for await` loops, and `await using`
 * declarations whose nearest enclosing function body is the module itself,
 * including those nested in top-level blocks, conditionals, loops, and
 * class computed member names. Text inside strings, template literals, and
 * comments is not code, and the parser does not report it.
 */

import { existsSync, globSync, readdirSync, readFileSync } from 'node:fs'
import { join, posix, resolve } from 'node:path'
import ts from 'typescript'

const GATE = 'verify-no-top-level-await'
const root = resolve(import.meta.dirname, '..')

/** The corpus glob for every TypeScript and TSX file under a workspace package's `src/`. */
export const SOURCE_GLOB = 'packages/*/*/src/**/*.{ts,tsx}'

/** Block-scope flag combination TypeScript records for an `await using` declaration list. */
const AWAIT_USING: number = ts.NodeFlags.AwaitUsing

/** Why a corpus file is not checked. */
export type ExcludedEntry = 'shebang' | 'bin'

/**
 * Source files a package manifest's `bin` field runs.
 * @param packageDirectory - repository-relative POSIX package directory.
 * @param bin - the manifest's `bin` field: a path, a name-to-path map, or absent.
 * @returns repository-relative candidate sources, `.ts` and `.tsx`, for each `lib/<path>.js` target.
 */
export function binSources(packageDirectory: string, bin: unknown): string[] {
  const targets = typeof bin === 'string'
    ? [bin]
    : typeof bin === 'object' && bin !== null ? Object.values(bin).filter(value => typeof value === 'string') : []
  return targets.flatMap((target) => {
    const match = /^lib\/(.+)\.js$/u.exec(posix.normalize(target))
    if (match === null) return []
    return ['ts', 'tsx'].map(extension => `${packageDirectory}/src/${match[1] as string}.${extension}`)
  })
}

/**
 * Read the `bin`-named sources of every package that owns a corpus file.
 * @param repositoryRoot - absolute repository root.
 * @param corpus - repository-relative corpus files.
 * @returns repository-relative sources excluded as `bin` entries.
 */
function binSourcesOfCorpus(repositoryRoot: string, corpus: readonly string[]): Set<string> {
  const sources = new Set<string>()
  for (const directory of new Set(corpus.map(file => file.split('/').slice(0, 3).join('/')))) {
    const manifest = join(repositoryRoot, directory, 'package.json')
    if (!existsSync(manifest)) continue
    const { bin } = JSON.parse(readFileSync(manifest, 'utf8')) as { bin?: unknown }
    for (const source of binSources(directory, bin)) sources.add(source)
  }
  return sources
}

/**
 * Classify one corpus file as an executable excluded from the check.
 * @param file - repository-relative POSIX path.
 * @param sourceText - the file's contents.
 * @param bins - sources named by package `bin` fields.
 * @returns the exclusion reason, or undefined for an importable module.
 */
export function excludedEntry(file: string, sourceText: string, bins: ReadonlySet<string>): ExcludedEntry | undefined {
  if (sourceText.startsWith('#!')) return 'shebang'
  if (bins.has(file)) return 'bin'
  return undefined
}

/** One module-scope await position. */
export interface TopLevelAwaitViolation {
  /** Repository-relative path, in POSIX separators. */
  readonly file: string
  /** One-based line number. */
  readonly line: number
  /** Which await form was found. */
  readonly what: 'await expression' | 'for await loop' | 'await using declaration'
  /** The offending source line, trimmed. */
  readonly text: string
}

/**
 * Whether a node starts a new function body, so an `await` below it belongs to
 * that function rather than to the module.
 * @param node - an ancestor of the await position.
 * @returns true for every function-like node and class static blocks.
 */
function startsFunctionScope(node: ts.Node): node is ts.FunctionLikeDeclaration | ts.ClassStaticBlockDeclaration {
  return ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)
    || ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node)
    || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)
    || ts.isClassStaticBlockDeclaration(node)
}

/**
 * Whether `child` lies in the part of `scope` that runs when the function is
 * called: its parameters or body. A method's computed name and decorators run
 * where the method is defined, so an await there still belongs to the module.
 * @param scope - the function-like ancestor.
 * @param child - the ancestor's direct child on the path to the await.
 * @returns true when the await runs inside the function.
 */
function runsInsideScope(scope: ts.FunctionLikeDeclaration | ts.ClassStaticBlockDeclaration, child: ts.Node): boolean {
  if (ts.isClassStaticBlockDeclaration(scope)) return true
  return child === scope.body || scope.parameters.some(parameter => parameter === child)
}

/**
 * Whether a node evaluates at module scope.
 * @param node - an await-bearing node.
 * @returns true when no enclosing function body contains it.
 */
function atModuleScope(node: ts.Node): boolean {
  let child = node
  for (let parent = node.parent; !ts.isSourceFile(parent); child = parent, parent = parent.parent) {
    if (startsFunctionScope(parent) && runsInsideScope(parent, child)) return false
  }
  return true
}

/**
 * Find every module-scope await in one source file.
 * @param file - repository-relative path, used for the script kind and the report.
 * @param sourceText - the file's contents.
 * @returns one violation per await position, in source order.
 */
export function findTopLevelAwaits(file: string, sourceText: string): TopLevelAwaitViolation[] {
  const posix = file.replaceAll('\\', '/')
  // Every await form spells the keyword, so a file without it holds no violation and needs no parse.
  if (!sourceText.includes('await')) return []
  const kind = posix.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const source = ts.createSourceFile(posix, sourceText, ts.ScriptTarget.Latest, true, kind)
  const lines = sourceText.split('\n')
  const violations: TopLevelAwaitViolation[] = []
  const record = (node: ts.Node, what: TopLevelAwaitViolation['what']): void => {
    const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line
    violations.push({ file: posix, line: line + 1, what, text: (lines[line] ?? '').trim() })
  }
  const visit = (node: ts.Node): void => {
    if (ts.isAwaitExpression(node) && atModuleScope(node)) record(node, 'await expression')
    else if (ts.isForOfStatement(node) && node.awaitModifier !== undefined && atModuleScope(node)) {
      record(node, 'for await loop')
    } else if (ts.isVariableDeclarationList(node)
      && (node.flags & ts.NodeFlags.BlockScoped) === AWAIT_USING && atModuleScope(node)) {
      record(node, 'await using declaration')
    }
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(source, visit)
  return violations
}

/**
 * List the package source corpus and prove it covers every package source directory.
 * @param repositoryRoot - absolute repository root.
 * @param pattern - corpus glob; only tests pass another value, to prove a narrowed glob is refused.
 * @returns repository-relative POSIX paths, sorted.
 * @throws when the corpus is empty, contains no TSX file, or leaves out a package `src/` directory
 * that holds TypeScript sources, because the gate would then pass by scanning less than it claims.
 */
export function sourceCorpus(repositoryRoot: string = root, pattern: string = SOURCE_GLOB): string[] {
  const files = globSync(pattern, { cwd: repositoryRoot }).map(file => file.replaceAll('\\', '/')).sort()
  if (files.length === 0) throw new Error(`${GATE}: scanned an empty corpus; ${pattern} no longer matches.`)
  if (!files.some(file => file.endsWith('.tsx'))) {
    throw new Error(`${GATE}: the corpus holds no .tsx file; ${pattern} no longer covers TSX sources.`)
  }
  const covered = new Set(files.map(file => file.split('/').slice(0, 3).join('/')))
  const missing: string[] = []
  for (const group of readdirSync(join(repositoryRoot, 'packages'), { withFileTypes: true })) {
    if (!group.isDirectory()) continue
    for (const pkg of readdirSync(join(repositoryRoot, 'packages', group.name), { withFileTypes: true })) {
      const directory = `packages/${group.name}/${pkg.name}`
      if (!pkg.isDirectory() || covered.has(directory)) continue
      if (holdsTypeScript(join(repositoryRoot, directory, 'src'))) missing.push(`${directory}/src`)
    }
  }
  if (missing.length > 0) {
    throw new Error(`${GATE}: the corpus leaves out package sources: ${missing.join(', ')}.`)
  }
  return files
}

/**
 * Whether a directory tree contains a TypeScript or TSX file, walked without the gate's glob.
 * @param directory - absolute directory path, which may be absent.
 * @returns true when at least one `.ts` or `.tsx` file lies below it.
 */
function holdsTypeScript(directory: string): boolean {
  let entries
  try {
    entries = readdirSync(directory, { withFileTypes: true })
  } catch (error) {
    // A package without a src/ directory contributes nothing to the corpus.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
  return entries.some(entry => entry.isDirectory()
    ? holdsTypeScript(join(directory, entry.name))
    : /\.tsx?$/u.test(entry.name))
}

/** What one repository scan checked, excluded, and found. */
export interface ScanResult {
  /** Corpus files checked as importable modules. */
  readonly checked: number
  /** Corpus files excluded as executables, with the reason, in corpus order. */
  readonly excluded: ReadonlyArray<{ readonly file: string; readonly reason: ExcludedEntry }>
  /** Module-scope awaits in checked files, in corpus order. */
  readonly violations: readonly TopLevelAwaitViolation[]
}

/**
 * Scan the package source corpus, excluding executables by declaration.
 * @param repositoryRoot - absolute repository root.
 * @returns the checked count, the excluded executables, and every violation.
 */
export function scanRepository(repositoryRoot: string = root): ScanResult {
  const corpus = sourceCorpus(repositoryRoot)
  const bins = binSourcesOfCorpus(repositoryRoot, corpus)
  const excluded: Array<{ file: string; reason: ExcludedEntry }> = []
  const violations: TopLevelAwaitViolation[] = []
  for (const file of corpus) {
    const text = readFileSync(join(repositoryRoot, file), 'utf8')
    const reason = excludedEntry(file, text, bins)
    if (reason === undefined) violations.push(...findTopLevelAwaits(file, text))
    else excluded.push({ file, reason })
  }
  return { checked: corpus.length - excluded.length, excluded, violations }
}

function main(): void {
  const { checked, excluded, violations } = scanRepository()
  const exclusions = excluded.map(entry => `${entry.file} (${entry.reason})`).join(', ')
  if (violations.length === 0) {
    console.log(`${GATE}: ${String(checked)} package source file(s) contain no module-scope await; `
      + `${String(excluded.length)} executable(s) excluded: ${exclusions || 'none'}.`)
    return
  }
  console.error(`${GATE}: ${String(violations.length)} module-scope await(s) in package sources:\n`)
  for (const violation of violations) {
    console.error(`  ${violation.file}:${String(violation.line)} ${violation.what}`)
    console.error(`    ${violation.text}`)
  }
  console.error('\nMove the asynchronous work into a function the module calls, such as an explicit `main()`,')
  console.error('and handle that promise\'s failure where the module starts it.')
  process.exitCode = 1
}

if (import.meta.filename === resolve(process.argv[1] ?? '')) main()
