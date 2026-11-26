/** Run publint over the exact manifest-declared publication view of every package. */

import {
  globSync,
  readdirSync,
  readFileSync,
  statSync,
} from 'node:fs'
import { dirname, posix, relative, resolve, sep } from 'node:path'
import { parseArgs } from 'node:util'
import { publint, type Message, type PackFile } from 'publint'
import { formatMessage } from 'publint/utils'
import ts from 'typescript'
import { CLIENT_CHUNK_FILE } from '../packages/client/modules/src/chunks.ts'
import { defaultParallelism } from './parallelism.ts'
import { isBrowserBundleFormatFalsePositive } from './publint-browser-format.ts'

const CONCURRENCY_ENV = 'DSH_PUBLINT_CONCURRENCY'
const repositoryRoot = resolve(import.meta.dirname, '..')
const { values: options } = parseArgs({
  args: process.argv.slice(2),
  options: { 'packages-root': { type: 'string' } },
})
const packagesRoot = resolve(options['packages-root'] ?? repositoryRoot)

interface PackageTarget {
  path: string
  directory: string
  manifest: PackageManifest
}

interface PackageManifest {
  name?: string
  files?: unknown
}

type PublintResult =
  | {
    path: string
    status: 'passed'
    messages: Message[]
    closureViolations: string[]
    manifest: Record<string, unknown>
  }
  | {
    path: string
    status: 'failed'
    messages: Message[]
    closureViolations: string[]
    manifest: Record<string, unknown>
    failure?: string
  }

function workspacePackages(): PackageTarget[] {
  return globSync('packages/*/*/package.json', { cwd: packagesRoot })
    .sort()
    .map((manifestPath) => {
      const absoluteManifestPath = resolve(packagesRoot, manifestPath)
      const manifest = JSON.parse(readFileSync(absoluteManifestPath, 'utf8')) as PackageManifest
      return { path: dirname(manifestPath), directory: dirname(absoluteManifestPath), manifest }
    })
}

function publintConcurrency(total: number): number {
  if (total === 0) return 0

  const raw = process.env[CONCURRENCY_ENV]
  if (raw !== undefined && raw !== '') {
    const parsed = Number.parseInt(raw, 10)
    if (!Number.isSafeInteger(parsed) || parsed < 1 || String(parsed) !== raw) {
      throw new Error(`publint-all: ${CONCURRENCY_ENV} must be a positive integer, got ${JSON.stringify(raw)}.`)
    }
    return Math.min(total, parsed)
  }

  return Math.min(total, defaultParallelism())
}

function publicationFiles(target: PackageTarget): PackFile[] {
  const paths = new Set<string>()
  addPath(resolve(target.directory, 'package.json'), paths)
  const declared = Array.isArray(target.manifest.files)
    ? target.manifest.files.filter((value): value is string => typeof value === 'string')
    : []
  for (const pattern of [
    ...declared,
    'README*',
    'LICENSE*',
    'LICENCE*',
    'CHANGELOG*',
    'CHANGES*',
    'HISTORY*',
    'NOTICE*',
  ]) {
    for (const match of globSync(pattern, { cwd: target.directory })) {
      addPath(resolve(target.directory, match), paths)
    }
  }

  return [...paths]
    .sort()
    .map(path => ({
      name: `package/${relative(target.directory, path).split(sep).join('/')}`,
      data: readFileSync(path),
    }))
}

function addPath(path: string, paths: Set<string>): void {
  const stat = statSync(path)
  if (stat.isDirectory()) {
    // readdirSync, not globSync: `**/*` skips dot-prefixed segments, but npm
    // pack publishes dotfiles inside included directories, and this view must
    // match what npm publishes.
    for (const entry of readdirSync(path, { recursive: true, withFileTypes: true })) {
      if (entry.isFile()) paths.add(resolve(entry.parentPath, entry.name))
    }
  } else if (stat.isFile()) {
    paths.add(path)
  }
}

interface RelativeImport {
  specifier: string
  line: number
  /** Whether the request is a synchronous `require` inside the factory of a `__ModuleLoader__.load` registration. */
  factoryRequire: boolean
}

/** Relative module requests of one published script and the Client module factories it registers. */
interface ScriptRequests {
  imports: RelativeImport[]
  /** Whether the script registers a package entry: a `__ModuleLoader__.load` call without `chunk`. */
  registersEntry: boolean
  /** `chunk` file names the script registers through `__ModuleLoader__.load`. */
  registeredChunks: string[]
}

/**
 * Return relative imports whose targets are absent from the publication view. A synchronous
 * `require("./client.<name>.js")` inside a registered module factory is also satisfied when a published script in the
 * requester's directory registers the package entry and that chunk, because the Client build moves the chunks an
 * entry requires into the entry file and deletes their own files. Every other relative request, such as an ESM
 * `import` that Node resolves itself, still needs its published file.
 */
function publicationClosureViolations(target: PackageTarget, files: readonly PackFile[]): string[] {
  const published = new Set(files.map(file => file.name))
  const scripts = new Map<string, ScriptRequests>()
  for (const file of files) {
    if (!/\.(?:js|mjs|cjs)$/.test(file.name)) continue
    const bytes = file.data instanceof ArrayBuffer ? new Uint8Array(file.data) : file.data
    const source = typeof bytes === 'string' ? bytes : Buffer.from(bytes).toString('utf8')
    scripts.set(file.name, scriptRequests(file.name, source))
  }
  /** Chunks registered by entry scripts, by directory. */
  const entryChunks = new Map<string, Set<string>>()
  for (const [name, script] of scripts) {
    if (!script.registersEntry) continue
    const directory = posix.dirname(name)
    const chunks = entryChunks.get(directory) ?? new Set<string>()
    for (const chunk of script.registeredChunks) chunks.add(chunk)
    entryChunks.set(directory, chunks)
  }
  const violations: string[] = []
  for (const [name, script] of scripts) {
    const directory = posix.dirname(name)
    for (const imported of script.imports) {
      const resolved = posix.normalize(posix.join(directory, imported.specifier))
      if (resolutionCandidates(resolved).some(candidate => published.has(candidate))) continue
      if (imported.factoryRequire && isEntryCarriedChunk(imported.specifier, entryChunks.get(directory))) continue
      violations.push(
        `${target.path}/${name.slice('package/'.length)}:${String(imported.line)}`
        + ` imports ${JSON.stringify(imported.specifier)}, but ${target.manifest.name ?? target.path}`
        + ` does not publish ${JSON.stringify(resolved.slice('package/'.length))}`,
      )
    }
  }
  return violations
}

/**
 * Whether a relative request names a package-local chunk that an entry script in the requester's directory registers.
 * @param specifier - Relative module request.
 * @param entryChunks - Chunk file names the entry scripts of that directory register.
 * @returns True for a `./client.<name>.js` request whose chunk the entry file carries.
 */
function isEntryCarriedChunk(specifier: string, entryChunks: ReadonlySet<string> | undefined): boolean {
  const chunk = specifier.slice('./'.length)
  return specifier.startsWith('./') && CLIENT_CHUNK_FILE.test(chunk) && entryChunks?.has(chunk) === true
}

/** Paths a relative JavaScript module request can resolve to in a published package. */
function resolutionCandidates(target: string): string[] {
  const base = target.replace(/\/+$/, '')
  return [
    target,
    ...['.js', '.mjs', '.cjs', '/index.js', '/index.mjs', '/index.cjs'].map(suffix => base + suffix),
  ]
}

/**
 * Extract relative static imports, re-exports, dynamic imports, and requires, and the Client module factories the
 * script registers through `__ModuleLoader__.load({ id, chunk?, factory })`.
 */
function scriptRequests(file: string, sourceText: string): ScriptRequests {
  const source = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, false, ts.ScriptKind.JS)
  const requests: ScriptRequests = { imports: [], registersEntry: false, registeredChunks: [] }
  const record = (node: ts.Node, literal: ts.Expression | undefined, factoryRequire: boolean): void => {
    if (literal === undefined || !ts.isStringLiteralLike(literal) || !literal.text.startsWith('.')) return
    requests.imports.push({
      specifier: literal.text,
      line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
      factoryRequire,
    })
  }
  const register = (registration: ts.ObjectLiteralExpression): void => {
    const chunk = registration.properties.find((property): property is ts.PropertyAssignment =>
      ts.isPropertyAssignment(property) && ts.isIdentifier(property.name) && property.name.text === 'chunk')
    if (chunk === undefined) requests.registersEntry = true
    else if (ts.isStringLiteralLike(chunk.initializer)) requests.registeredChunks.push(chunk.initializer.text)
  }
  /** @param inFactory - Whether the node lies inside the `factory` of a `__ModuleLoader__.load` registration. */
  const visit = (node: ts.Node, inFactory: boolean): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      record(node, node.moduleSpecifier, false)
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      record(node, node.arguments[0], false)
    } else if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'require') {
      record(node, node.arguments[0], inFactory)
    } else if (ts.isCallExpression(node) && isModuleLoaderLoad(node.expression)) {
      const registration = node.arguments[0]
      if (registration !== undefined && ts.isObjectLiteralExpression(registration)) {
        register(registration)
        for (const property of registration.properties) visit(property, inFactory || isFactoryProperty(property))
        return
      }
    }
    ts.forEachChild(node, (child) => { visit(child, inFactory) })
  }
  visit(source, false)
  return requests
}

/** Whether a registration member is its `factory`. */
function isFactoryProperty(property: ts.ObjectLiteralElementLike): boolean {
  return (ts.isPropertyAssignment(property) || ts.isMethodDeclaration(property))
    && ts.isIdentifier(property.name) && property.name.text === 'factory'
}

/** Whether a callee is `__ModuleLoader__.load`, directly or as a `window` property. */
function isModuleLoaderLoad(callee: ts.Expression): boolean {
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== 'load') return false
  const loader = callee.expression
  if (ts.isIdentifier(loader)) return loader.text === '__ModuleLoader__'
  return ts.isPropertyAccessExpression(loader) && loader.name.text === '__ModuleLoader__'
    && ts.isIdentifier(loader.expression) && loader.expression.text === 'window'
}

async function runPublint(target: PackageTarget): Promise<PublintResult> {
  try {
    const files = publicationFiles(target)
    const closureViolations = publicationClosureViolations(target, files)
    const result = await publint({
      pkgDir: 'package',
      pack: { files },
    })
    const manifest = result.pkg as Record<string, unknown>
    const messages = result.messages.filter(message => !isBrowserBundleFormatFalsePositive(message))
    return messages.some(message => message.type === 'error') || closureViolations.length > 0
      ? { path: target.path, status: 'failed', messages, closureViolations, manifest }
      : { path: target.path, status: 'passed', messages, closureViolations, manifest }
  } catch (error: unknown) {
    return {
      path: target.path,
      status: 'failed',
      messages: [],
      closureViolations: [],
      manifest: target.manifest as Record<string, unknown>,
      failure: error instanceof Error ? error.message : String(error),
    }
  }
}

async function runAll(targets: PackageTarget[], concurrency: number): Promise<PublintResult[]> {
  let next = 0
  const results: Array<PublintResult | undefined> = []
  await Promise.all(Array.from({ length: concurrency }, async () => {
    for (;;) {
      const index = next
      next += 1
      const target = targets[index]
      if (target === undefined) return
      results[index] = await runPublint(target)
    }
  }))

  return targets.map((target, index) => {
    const result = results[index]
    if (result === undefined) throw new Error(`publint-all: missing result for ${target.path}.`)
    return result
  })
}

function printResult(result: PublintResult): void {
  console.log(`Running publint for ${result.path}...`)
  if ('failure' in result) console.error(result.failure)
  for (const message of result.messages) {
    console.log(formatMessage(message, result.manifest, { color: false }) ?? message.code)
  }
  for (const violation of result.closureViolations) console.error(violation)
  if (result.status === 'passed' && result.messages.length === 0 && result.closureViolations.length === 0) {
    console.log('All good!')
  }
}

const packages = workspacePackages()
const concurrency = publintConcurrency(packages.length)
console.log(`publint-all: linting ${packages.length} package(s) with ${concurrency} worker(s).`)

const results = await runAll(packages, concurrency)
for (const result of results) printResult(result)

if (results.some(result => result.status === 'failed')) process.exit(1)
