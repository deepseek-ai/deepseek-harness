/**
 * Verify that only experimental packages call `appendPluginRecord` from production source.
 *
 * `appendPluginRecord` in `@deepseek-ai/dsh-session` appends an ignorable `plugin:` record that the
 * experimental persistence catalogue lists and that a Session format migration keeps only on a best-effort
 * basis. Experimental packages may rely on that; a release package must declare its events instead.
 * The owning module and test files, which exercise the operation, are exempt.
 *
 * Discovery is syntax-aware: every identifier spelled `appendPluginRecord` counts — an import, a
 * named re-export, a call, a namespace member, a destructured binding, or an alias source — and so
 * does a string literal of exactly that name, which reaches the function by element access.
 * Comments, including JSDoc links, and longer strings do not count. A wildcard re-export
 * (`export * from`) names no identifier and is not reported; code that calls the function through
 * it still names the function, and that reference is. A file is parsed when its text, or its text
 * with its escapes unescaped, contains the name, so a spelling that escapes part of it (`\u0061`,
 * `\x61`, `\u{61}`, `\141`, `\a`, a line continuation) is still found.
 * Production writes must name a record in the production-only `PluginRecordMap` inventory;
 * test declarations cannot authorize a production write.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import ts from 'typescript'
import { collectPluginRecords } from './plugin-record-catalog.ts'
import { faceConfigs } from './ts-project.ts'

const root = resolve(import.meta.dirname, '..')

/** The restricted function. */
export const RESTRICTED_NAME = 'appendPluginRecord'

/** The module that declares the restricted function. */
export const OWNER_FILE = 'packages/core/session/src/index.ts'

/** Production source under this prefix may call the restricted function. */
export const EXPERIMENTAL_PREFIX = 'packages/experimental/'

/** This gate and its spec name the restricted function to find it. */
const GATE_FILES: ReadonlySet<string> = new Set([
  'scripts/verify-plugin-record-callers.ts',
  'scripts/verify-plugin-record-callers.spec.ts',
])

const SOURCE_EXTENSION = /\.(?:[cm]?[jt]s|[jt]sx)$/u

/** A line continuation, which a string or template literal drops from its value. */
const LINE_CONTINUATION = /\\(?:\r\n|[\n\r\u2028\u2029])/gu

/** A `\u{…}`, `\uXXXX`, or `\xXX` escape, capturing its hex digits. */
const HEX_ESCAPE = /\\(?:u\{([0-9a-fA-F]+)\}|u([0-9a-fA-F]{4})|x([0-9a-fA-F]{2}))/gu

/**
 * A legacy octal escape, which a sloppy-mode script such as a `.cjs` file may use: up to three
 * octal digits, three only when the first is 0–3, so the value stays within 0o377.
 */
const OCTAL_ESCAPE = /\\([0-3][0-7]{0,2}|[4-7][0-7]?)/gu

/**
 * The source as its escapes could spell it: line continuations dropped, hex and legacy octal
 * escapes decoded, and every other backslash removed. Text that the parser reads as the
 * restricted name, in an identifier or a string, contains the name here too.
 * @param source - file contents.
 * @returns the unescaped text.
 */
export function unescaped(source: string): string {
  return source
    .replace(LINE_CONTINUATION, '')
    .replace(HEX_ESCAPE, (match: string, braced?: string, unit?: string, byte?: string) => {
      const code = Number.parseInt(`${braced ?? ''}${unit ?? ''}${byte ?? ''}`, 16)
      return code <= 0x10ffff ? String.fromCodePoint(code) : match
    })
    .replace(OCTAL_ESCAPE, (_match: string, digits: string) => String.fromCharCode(Number.parseInt(digits, 8)))
    .replaceAll('\\', '')
}

/** One production-source reference to the restricted function outside its admitted callers. */
export interface PluginRecordCaller {
  /** Repository-relative path, in POSIX separators. */
  readonly file: string
  /** One-based line number. */
  readonly line: number
  /** The trimmed source line. */
  readonly text: string
  /** Why a production write lacks a catalogue declaration, when applicable. */
  readonly reason?: string
}

/**
 * Whether a repository path is a test file under the repository's lint-override globs.
 * @param file - repository-relative path, in POSIX separators.
 * @returns whether the file is a package, app, or example test, or a script spec.
 */
export function isTestFile(file: string): boolean {
  return /^(?:packages\/[^/]+\/[^/]+|apps\/[^/]+|examples\/[^/]+)\/tests\//u.test(file)
    || /^scripts\/.+\.spec\.tsx?$/u.test(file)
}

/**
 * Whether a file may reference the restricted function.
 * @param file - repository-relative path, in POSIX separators.
 * @returns whether the file is experimental source, the owner, a test, or this gate.
 */
export function isAdmittedCaller(file: string): boolean {
  return file.startsWith(EXPERIMENTAL_PREFIX) || file === OWNER_FILE || isTestFile(file) || GATE_FILES.has(file)
}

function scriptKind(file: string): ts.ScriptKind {
  if (file.endsWith('.tsx')) return ts.ScriptKind.TSX
  if (file.endsWith('.jsx')) return ts.ScriptKind.JSX
  if (/\.[cm]?js$/u.test(file)) return ts.ScriptKind.JS
  return ts.ScriptKind.TS
}

/**
 * Find references to the restricted function in one source file, admitted or not.
 * @param file - repository-relative path; its extension selects the parser.
 * @param source - file contents.
 * @returns one entry per referencing identifier or exact-name string literal, in source order.
 */
export function findPluginRecordReferences(file: string, source: string): PluginRecordCaller[] {
  if (!source.includes(RESTRICTED_NAME) && !unescaped(source).includes(RESTRICTED_NAME)) return []
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKind(file))
  const lines = source.split(/\r?\n/u)
  const references: PluginRecordCaller[] = []
  const visit = (node: ts.Node): void => {
    const named = ts.isIdentifier(node)
      || ts.isStringLiteral(node)
      || ts.isNoSubstitutionTemplateLiteral(node)
    if (named && node.text === RESTRICTED_NAME) {
      const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line
      references.push({ file, line: line + 1, text: lines[line]?.trim() ?? '' })
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return references
}

/** Whether the owner still exports a function declaration under the restricted name. */
function declaresRestrictedFunction(source: string): boolean {
  const sourceFile = ts.createSourceFile(OWNER_FILE, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  return sourceFile.statements.some(statement => ts.isFunctionDeclaration(statement)
    && statement.name?.text === RESTRICTED_NAME
    && ts.getModifiers(statement)?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword) === true)
}

/**
 * Check a source corpus and return its unadmitted references.
 * @param files - repository-relative path, in POSIX separators, to contents.
 * @returns every reference outside experimental source, the owner, tests, and this gate.
 * @throws when the corpus lacks the owner's exported declaration or any experimental or release
 *   package source, because the gate would then pass by checking the wrong files.
 */
export function checkPluginRecordCallers(files: ReadonlyMap<string, string>): PluginRecordCaller[] {
  const owner = files.get(OWNER_FILE)
  if (owner === undefined || !declaresRestrictedFunction(owner)) {
    throw new Error(`verify-plugin-record-callers: ${OWNER_FILE} no longer exports function ${RESTRICTED_NAME}; update this gate with the move or rename.`)
  }
  const paths = [...files.keys()]
  if (!paths.some(file => file.startsWith(EXPERIMENTAL_PREFIX))
    || !paths.some(file => file.startsWith('packages/') && !isAdmittedCaller(file))) {
    throw new Error('verify-plugin-record-callers: the corpus lacks experimental or release package source; the file listing no longer matches the repository.')
  }
  return paths
    .filter(file => !isAdmittedCaller(file))
    .flatMap(file => findPluginRecordReferences(file, files.get(file) ?? ''))
}

/**
 * Check production write keys against the generated catalogue's source inventory.
 * The compiler reads production sources only, so test map augmentations cannot widen the writer.
 * @param repoRoot - checkout holding the compiler face and record declarations.
 * @param files - tracked and unignored repository sources.
 * @returns compiler errors in experimental production consumers, including undeclared write keys.
 */
export function checkDeclaredPluginRecordWrites(
  repoRoot: string,
  files: ReadonlyMap<string, string>,
): PluginRecordCaller[] {
  const declared = new Set(collectPluginRecords(repoRoot).map(record => record.name))
  const candidates = [...files.keys()].filter(file => file.startsWith(EXPERIMENTAL_PREFIX) && !isTestFile(file)
    && findPluginRecordReferences(file, files.get(file) ?? '').length > 0)
  if (candidates.length === 0) return []
  const remaining = new Set(candidates)
  const violations: PluginRecordCaller[] = []
  for (const face of ['host', 'client'] as const) {
    if (remaining.size === 0) break
    const configs = faceConfigs(repoRoot, face)
    const roots = new Set<string>()
    for (const config of configs.byPath.values()) {
      for (const file of config.fileNames) {
        if (!isTestFile(relative(repoRoot, file).replaceAll('\\', '/'))) roots.add(resolve(file))
      }
    }
    const admitted = candidates.filter(file => roots.has(resolve(repoRoot, file)))
    if (admitted.length === 0) continue
    for (const file of admitted) remaining.delete(file)
    const consumers = new Set(admitted.map(file => file.split('/').slice(0, 3).join('/')))
    const program = ts.createProgram([...roots], {
      ...configs.root.options,
      noEmit: true,
      composite: false,
      incremental: false,
    })
    const owner = program.getSourceFile(resolve(repoRoot, 'packages/core/session/src/types.ts'))
    const map = owner?.statements.find((node): node is ts.InterfaceDeclaration =>
      ts.isInterfaceDeclaration(node) && node.name.text === 'PluginRecordMap')
    if (map === undefined) throw new Error('production compiler did not load the owning PluginRecordMap')
    for (const member of program.getTypeChecker().getTypeAtLocation(map).getProperties()) {
      if (declared.has(member.name)) continue
      const declaration = member.declarations?.[0]
      if (declaration === undefined) throw new Error(`plugin record has no source declaration: ${member.name}`)
      const source = declaration.getSourceFile()
      violations.push({
        file: relative(repoRoot, source.fileName).replaceAll('\\', '/'),
        line: source.getLineAndCharacterOfPosition(declaration.getStart(source)).line + 1,
        text: declaration.getText(source),
        reason: `record ${member.name} is visible to production but has no production catalogue declaration`,
      })
    }
    for (const file of roots) {
      const local = relative(repoRoot, file).replaceAll('\\', '/')
      if (!consumers.has(local.split('/').slice(0, 3).join('/'))) continue
      const source = program.getSourceFile(file)
      if (source === undefined) throw new Error(`plugin record caller source was not loaded: ${local}`)
      for (const diagnostic of program.getSemanticDiagnostics(source)) {
        if (diagnostic.category !== ts.DiagnosticCategory.Error) continue
        const line = source.getLineAndCharacterOfPosition(diagnostic.start ?? 0).line
        violations.push({
          file: local,
          line: line + 1,
          text: source.text.split(/\r?\n/u)[line]?.trim() ?? '',
          reason: ts.flattenDiagnosticMessageText(diagnostic.messageText, ' '),
        })
      }
    }
  }
  for (const file of remaining) {
    violations.push({ file, line: 1, text: '', reason: 'production record writers must be included in a Host or Client compiler face' })
  }
  return violations
}

/**
 * Read every tracked or unignored source file outside `vendor/`.
 * @param repoRoot - the repository root; defaults to this checkout.
 * @returns repository-relative path, in POSIX separators, to contents.
 */
export function readRepositorySources(repoRoot: string = root): Map<string, string> {
  const listing = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  const files = new Map<string, string>()
  for (const entry of listing.split('\0')) {
    const file = entry.replaceAll('\\', '/')
    if (file === '' || file.startsWith('vendor/') || !SOURCE_EXTENSION.test(file)) continue
    try {
      files.set(file, readFileSync(resolve(repoRoot, file), 'utf8'))
    } catch (error: unknown) {
      // A file deleted in the working tree is still listed until the deletion is staged.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  return files
}

function main(): void {
  const files = readRepositorySources()
  const callers = [...checkPluginRecordCallers(files), ...checkDeclaredPluginRecordWrites(root, files)]
  if (callers.length === 0) {
    console.log('verify-plugin-record-callers: production callers are experimental and record keys are catalogued.')
    return
  }
  console.error('verify-plugin-record-callers: invalid production record callers.\n')
  for (const caller of callers) console.error(`  ${caller.file}:${String(caller.line)} ${caller.text}${caller.reason === undefined ? '' : ` — ${caller.reason}`}`)
  console.error('\nA release package declares its events in SessionEventMap instead of writing plugin records.')
  process.exit(1)
}

if (import.meta.filename === resolve(process.argv[1] ?? '')) main()
