/** Source-text parsing shared by the package dependency and client package gates. */
import { globSync, readFileSync } from 'node:fs'
import { isBuiltin } from 'node:module'
import { resolve, sep } from 'node:path'
import ts from 'typescript'
import type { PackageDependencyManifest, WorkspacePackageManifest } from './verify-package-dependencies.ts'

export type DependencySection = 'dependencies' | 'devDependencies' | 'optionalDependencies' | 'peerDependencies'

export const ROOT_TYPE_PACKAGES: ReadonlySet<string> = new Set(['@types/react', '@types/react-dom'])

/**
 * Report whether a specifier names a bare package rather than a path or subpath import.
 * @param specifier - module specifier text.
 * @returns whether the specifier resolves outside this package.
 */
function isBareSpecifier(specifier: string): boolean {
  return !specifier.startsWith('.') && !specifier.startsWith('/') && !specifier.startsWith('#')
}

/**
 * Read the leading package segments of one bare module specifier.
 * @param specifier - module specifier text that already passed {@link isBareSpecifier}.
 * @returns the package name this specifier belongs to.
 */
function packageNameForUses(specifier: string): string {
  const segments = specifier.split('/')
  return segments.slice(0, specifier.startsWith('@') ? 2 : 1).join('/')
}

/**
 * Read the bare package name of one module specifier.
 * @param specifier - module specifier text.
 * @returns the package name, or undefined for paths, builtins, and non-package specifiers.
 */
export function packageNameOf(specifier: string): string | undefined {
  if (isBuiltin(specifier) || specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('#')
    || specifier.includes(':') || specifier.includes('*')) {
    return undefined
  }
  const parts = specifier.split('/')
  return specifier.startsWith('@') ? parts.length >= 2 ? `${parts[0]}/${parts[1]}` : undefined : parts[0]
}

/**
 * Read package manifests used for scope discovery and workspace-name checks.
 * @param root - Repository containing the workspace manifests.
 * @returns Every workspace package, the non-experimental release packages, and the packages the policy covers.
 */
export function addUse(target: Map<string, string[]>, name: string, path: string): void {
  const paths = target.get(name) ?? []
  if (!paths.includes(path)) paths.push(path)
  target.set(name, paths)
}

export function section(manifest: PackageDependencyManifest, name: DependencySection): Record<string, string> {
  return manifest[name] ?? {}
}

export function mutableSection(manifest: PackageDependencyManifest, name: DependencySection): Record<string, string> {
  manifest[name] ??= {}
  return manifest[name]
}

export function declaredSections(manifest: PackageDependencyManifest, name: string): DependencySection[] {
  return (['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'] as const)
    .filter(sectionName => section(manifest, sectionName)[name] !== undefined)
}

function importCarriesRuntimeValue(node: ts.ImportDeclaration): boolean {
  const clause = node.importClause
  if (clause === undefined) return true
  if (clause.phaseModifier === ts.SyntaxKind.TypeKeyword) return false
  const bindings = clause.namedBindings
  return clause.name !== undefined
    || bindings === undefined
    || ts.isNamespaceImport(bindings)
    || bindings.elements.length === 0
    || bindings.elements.some(element => !element.isTypeOnly)
}

function exportCarriesRuntimeValue(node: ts.ExportDeclaration): boolean {
  if (node.isTypeOnly) return false
  const clause = node.exportClause
  if (clause === undefined || ts.isNamespaceExport(clause)) return true
  return clause.elements.length === 0 || clause.elements.some(element => !element.isTypeOnly)
}

export function collectSourceFileUses(
  sourceFile: ts.SourceFile,
  runtimeOnly: boolean,
  key: 'local' | 'package' | 'specifier',
  includeRootRelative = false,
): Set<string> {
  const uses = new Set<string>()

  const add = (specifier: ts.Expression | undefined): void => {
    if (specifier === undefined || !ts.isStringLiteralLike(specifier)) return
    if (key === 'local') {
      if (specifier.text.startsWith('.') || includeRootRelative && specifier.text.startsWith('/')) uses.add(specifier.text)
      return
    }
    if (!isBareSpecifier(specifier.text)) return
    uses.add(key === 'package' ? packageNameForUses(specifier.text) : specifier.text)
  }
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      if (!runtimeOnly || importCarriesRuntimeValue(node)) add(node.moduleSpecifier)
    } else if (ts.isExportDeclaration(node)) {
      if (!runtimeOnly || exportCarriesRuntimeValue(node)) add(node.moduleSpecifier)
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      if (!runtimeOnly || !node.isTypeOnly) add(node.moduleReference.expression)
    } else if (!runtimeOnly && ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      add(node.argument.literal)
    } else if (ts.isCallExpression(node)
      && (node.expression.kind === ts.SyntaxKind.ImportKeyword
        || ts.isIdentifier(node.expression) && node.expression.text === 'require')) {
      add(node.arguments[0])
    } else if (!runtimeOnly && key !== 'local' && ts.isModuleDeclaration(node) && ts.isStringLiteral(node.name)) {
      add(node.name)
    } else if (key !== 'local'
      && (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node))) {
      uses.add('react')
    }
    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return uses
}

/**
 * Read browser-module declarations from workspace manifests.
 * @param root - Absolute repository root.
 * @returns Declarations and malformed dsh.client fields.
 */
export function collectSourcePackageUses(path: string, source: string): Set<string> {
  const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true)
  return collectSourceFileUses(sourceFile, false, 'package')
}

/**
 * Collect bare packages whose values one production source file reaches at runtime.
 * @param path - File path used to select TypeScript's parser mode.
 * @param source - Source text to inspect.
 * @returns Bare package names retained by runtime imports, exports, requires, or JSX.
 */
export function collectRuntimeSourcePackageUses(path: string, source: string): Set<string> {
  const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true)
  return collectSourceFileUses(sourceFile, true, 'package')
}

/**
 * Collect exact bare specifiers retained by one production source file.
 * @param path - File path used to select TypeScript's parser mode.
 * @param source - Source text to inspect.
 * @returns Exact specifiers retained by runtime imports, exports, requires, or JSX.
 */
export function collectRuntimeSourceSpecifiers(path: string, source: string): Set<string> {
  const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true)
  return collectSourceFileUses(sourceFile, true, 'specifier')
}

/**
 * Collect relative module specifiers used to follow one source entry's local closure.
 * @param path - File path used to select TypeScript's parser mode.
 * @param source - Source text to inspect.
 * @returns Relative imports, exports, requires, and import types.
 */
export function collectLocalSourceSpecifiers(path: string, source: string): Set<string> {
  const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true)
  return collectSourceFileUses(sourceFile, false, 'local')
}

/**
 * Collect local module specifiers retained by one production source file.
 * @param path - File path used to select TypeScript's parser mode.
 * @param source - Source text to inspect.
 * @param includeRootRelative - Include absolute paths, such as Vite's Web-root imports.
 * @returns Local imports, exports, and requires that survive compilation.
 */
export function collectRuntimeLocalSourceSpecifiers(path: string, source: string, includeRootRelative = false): Set<string> {
  const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true)
  return collectSourceFileUses(sourceFile, true, 'local', includeRootRelative)
}

/**
 * Collect package-asset module specifiers retained by one production source file.
 * @param path - File path used to select TypeScript's parser mode.
 * @param source - Source text to inspect.
 * @returns Relative runtime imports, re-exports, and requires whose extension has a package-asset media type.
 */
/**
 * Normalize a repository path to forward slashes.
 * @param path - platform path inside the repository.
 * @returns the same path with POSIX separators.
 */
export function normalizePath(path: string): string {
  return path.split(sep).join('/')
}

export function readAllSourceUses(root: string, pkg: WorkspacePackageManifest): Map<string, string[]> {
  const uses = new Map<string, string[]>()
  for (const sourcePath of globSync('src/**/*.{ts,tsx,mts,cts}', { cwd: resolve(root, pkg.dir) }).sort()) {
    const source = readFileSync(resolve(root, pkg.dir, sourcePath), 'utf8')
    const displayPath = `${pkg.dir}/${normalizePath(sourcePath)}`
    let runtimeUses: Set<string> | undefined
    for (const specifier of collectSourcePackageUses(sourcePath, source)) {
      const name = packageNameOf(specifier)
      if (name === undefined) continue
      const typesName = `@types/${name.replace(/^@/, '').replace('/', '__')}`
      if (!ROOT_TYPE_PACKAGES.has(typesName)
        && declaredSections(pkg.manifest, name).length === 0
        && declaredSections(pkg.manifest, typesName).length > 0) {
        runtimeUses ??= collectRuntimeSourcePackageUses(sourcePath, source)
        if (!runtimeUses.has(name)) {
          addUse(uses, typesName, displayPath)
          continue
        }
      }
      addUse(uses, name, displayPath)
    }
  }
  return uses
}
