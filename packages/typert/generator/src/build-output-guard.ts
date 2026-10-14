/**
 * Detection of workspace build outputs loaded into an analyzed face program,
 * and of workspace imports that resolve to nothing. Typert reads workspace
 * packages only from source when a caller rejects build outputs, so its
 * result cannot depend on whether, or when, package compilation ran: an
 * import that reaches `lib/` on a compiled tree resolves to nothing on a
 * clean one, and both are rejected.
 * @module @deepseek-ai/dsh-typert-generator/build-output-guard
 */

import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import ts from 'typescript'

/** One program file that a workspace package's `lib/` holds, with the imports that load it. */
export interface BuildOutputLoad {
  /** Absolute path of the build output. */
  readonly file: string
  /** Program files outside build outputs whose import specifier resolves to {@link file}. */
  readonly importers: readonly BuildOutputImporter[]
  /** Absolute path of the workspace source compiled to {@link file}, when one exists. */
  readonly source: string | undefined
}

/** One import of a build output from a program file outside build outputs. */
export interface BuildOutputImporter {
  /** Absolute path of the importing file. */
  readonly file: string
  /** Import specifier as written. */
  readonly specifier: string
}

/**
 * List the program files that a workspace package holds under its `lib/`
 * directory. A package is the nearest directory with a `package.json` at or
 * below `root`; files under `node_modules` are external. Importers are found
 * by resolving each program file's import specifiers again, so this pass
 * costs extra only when an output is present.
 * @param program - the analyzed face program.
 * @param root - workspace root.
 * @param host - module resolution host of the program.
 * @returns loads in file-path order; empty when every workspace file comes from source.
 */
export function findBuildOutputLoads(
  program: ts.Program,
  root: string,
  host: ts.ModuleResolutionHost,
): BuildOutputLoad[] {
  const classifier = new BuildOutputClassifier(root)
  const outputs = new Map<string, BuildOutputImporter[]>()
  for (const sourceFile of program.getSourceFiles()) {
    if (classifier.isBuildOutput(sourceFile.fileName)) outputs.set(classifier.canonical(sourceFile.fileName), [])
  }
  if (outputs.size === 0) return []
  const options = program.getCompilerOptions()
  for (const sourceFile of program.getSourceFiles()) {
    if (!classifier.isWorkspaceFile(sourceFile.fileName) || classifier.isBuildOutput(sourceFile.fileName)) continue
    for (const { fileName: specifier } of ts.preProcessFile(sourceFile.text, true, true).importedFiles) {
      const resolved = ts.resolveModuleName(specifier, sourceFile.fileName, options, host).resolvedModule
      const importers = resolved === undefined ? undefined : outputs.get(classifier.canonical(resolved.resolvedFileName))
      importers?.push({ file: classifier.display(sourceFile.fileName), specifier })
    }
  }
  return [...outputs]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([file, importers]) => ({ file: classifier.display(file), importers, source: classifier.sourceFor(file) }))
}

/** One import of a workspace package from a program source file that module resolution cannot resolve. */
export interface UnresolvedWorkspaceImport {
  /** Absolute path of the importing file. */
  readonly file: string
  /** Import specifier as written. */
  readonly specifier: string
  /** Absolute path of the workspace source the specifier's package export compiles from, when one exists. */
  readonly source: string | undefined
}

/**
 * List the imports in workspace program files that name a workspace package
 * and resolve to nothing. A workspace package is one whose `node_modules` link,
 * found from the importing file's directories, leads inside `root` outside any
 * `node_modules`; without that link or a `paths` alias the package cannot be
 * identified, and type checking reports the import. The source of a subpath is
 * derived from the package's `exports` `types` condition under `lib/types/`.
 * @param program - the analyzed face program.
 * @param root - workspace root.
 * @param host - module resolution host of the program.
 * @returns unresolved imports in file and specifier order.
 */
export function findUnresolvedWorkspaceImports(
  program: ts.Program,
  root: string,
  host: ts.ModuleResolutionHost,
): UnresolvedWorkspaceImport[] {
  const classifier = new BuildOutputClassifier(root)
  const options = program.getCompilerOptions()
  const cache = ts.createModuleResolutionCache(root, file => file, options)
  const found: UnresolvedWorkspaceImport[] = []
  for (const sourceFile of program.getSourceFiles()) {
    if (!classifier.isWorkspaceFile(sourceFile.fileName) || classifier.isBuildOutput(sourceFile.fileName)) continue
    for (const { fileName: specifier } of ts.preProcessFile(sourceFile.text, true, true).importedFiles) {
      if (specifier.startsWith('.') || isAbsolute(specifier) || specifier.includes(':')) continue
      if (ts.resolveModuleName(specifier, sourceFile.fileName, options, host, cache).resolvedModule !== undefined) continue
      const packageRoot = classifier.linkedWorkspacePackage(sourceFile.fileName, packageNameOf(specifier))
      if (packageRoot === undefined) continue
      const source = exportSource(packageRoot, specifier)
      found.push({
        file: classifier.display(sourceFile.fileName),
        specifier,
        source: source === undefined ? undefined : classifier.display(source),
      })
    }
  }
  return found.sort((left, right) => left.file.localeCompare(right.file) || left.specifier.localeCompare(right.specifier))
}

function packageNameOf(specifier: string): string {
  const parts = specifier.split('/')
  return parts.slice(0, specifier.startsWith('@') ? 2 : 1).join('/')
}

function exportSource(packageRoot: string, specifier: string): string | undefined {
  const packageName = packageNameOf(specifier)
  const subpath = specifier === packageName ? '.' : `.${specifier.slice(packageName.length)}`
  let manifest: unknown
  try {
    manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
  } catch (_unreadableManifest) {
    // The error names the import without a suggested source path.
    return undefined
  }
  const entry = property(property(manifest, 'exports'), subpath)
  const types = typeof entry === 'string' ? entry : property(entry, 'types')
  if (typeof types !== 'string' || !types.startsWith('./lib/types/')) return undefined
  const stem = join(packageRoot, 'src', types.slice('./lib/types/'.length).replace(/\.d\.([cm]?)ts$/u, '.$1ts'))
  return [stem, `${stem}x`].find(candidate => existsSync(candidate))
}

function property(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[key] : undefined
}

/**
 * Classifies program files by their real paths, because module resolution
 * reports symbolic-link targets and Windows long names while the workspace
 * root may be spelled through a link or an 8.3 short name; reported paths are
 * spelled under the caller's root.
 */
class BuildOutputClassifier {
  private readonly packageRoots = new Map<string, string | undefined>()
  private readonly realPaths = new Map<string, string>()
  private readonly realRoot: string

  constructor(private readonly root: string) {
    this.realRoot = this.canonical(root)
  }

  canonical(file: string): string {
    const absolute = resolve(file)
    const cached = this.realPaths.get(absolute)
    if (cached !== undefined) return cached
    let real = absolute
    try {
      real = realpathSync.native(absolute)
    } catch (_missingPath) {
      // A path that does not exist, such as an unresolved candidate, keeps its resolved spelling.
    }
    this.realPaths.set(absolute, real)
    return real
  }

  display(file: string): string {
    const path = relative(this.realRoot, this.canonical(file))
    return path.startsWith('..') || isAbsolute(path) ? resolve(file) : join(this.root, path)
  }

  isWorkspaceFile(file: string): boolean {
    const path = relative(this.realRoot, this.canonical(file))
    return path !== '' && !path.startsWith('..') && !isAbsolute(path) && !path.split(sep).includes('node_modules')
  }

  isBuildOutput(file: string): boolean {
    if (!this.isWorkspaceFile(file)) return false
    const real = this.canonical(file)
    const packageRoot = this.packageRoot(dirname(real))
    return packageRoot !== undefined && relative(packageRoot, real).split(sep)[0] === 'lib'
  }

  sourceFor(file: string): string | undefined {
    const real = this.canonical(file)
    const packageRoot = this.packageRoot(dirname(real))
    if (packageRoot === undefined) return undefined
    const [lib, types, ...rest] = relative(packageRoot, real).split(sep)
    const last = rest.at(-1)
    if (lib !== 'lib' || types !== 'types' || last === undefined) return undefined
    const stem = join(packageRoot, 'src', ...rest.slice(0, -1), last.replace(/\.d\.([cm]?)ts$/u, '.$1ts'))
    const source = [stem, `${stem}x`].find(candidate => existsSync(candidate))
    return source === undefined ? undefined : this.display(source)
  }

  linkedWorkspacePackage(importer: string, packageName: string): string | undefined {
    let directory = dirname(resolve(importer))
    for (;;) {
      const link = join(directory, 'node_modules', packageName)
      if (existsSync(link)) {
        const target = this.canonical(link)
        return this.isWorkspaceFile(join(target, 'package.json')) ? target : undefined
      }
      if (this.canonical(directory) === this.realRoot || dirname(directory) === directory) return undefined
      directory = dirname(directory)
    }
  }

  private packageRoot(directory: string): string | undefined {
    if (this.packageRoots.has(directory)) return this.packageRoots.get(directory)
    const found = existsSync(join(directory, 'package.json'))
      ? directory
      : directory === this.realRoot || dirname(directory) === directory
        ? undefined
        : this.packageRoot(dirname(directory))
    this.packageRoots.set(directory, found)
    return found
  }
}
