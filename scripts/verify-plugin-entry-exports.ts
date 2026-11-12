/**
 * Reject a value that a plugin entry exports beyond what the Cordis Loader loads.
 *
 * The rule lives in docs/defensive-patterns/package-surface.md ("A plugin package exports what the Loader loads"):
 * a function plugin's entry exports `name`, `inject`, `Config`, and `apply`, a service plugin's entry default-exports
 * its plugin class, and either may add the Service Definition classes and error types that other packages extend or
 * throw. The Loader imports the entry when its row activates and reads only what the plugin form provides; any other
 * value on the entry is API that another package can import statically, which evaluates the entry module without its
 * Loader row.
 *
 * The corpus is every `packages/<group>/<package>/src/index.ts`. An entry that exports a value named `apply` is a
 * function plugin. A default export beside `apply` is always reported, even a class allowed below, because the Loader
 * then loads the default export instead of the module namespace. An entry without `apply` whose default export is a
 * class the Loader can construct is a service plugin: its default export and other names for the same class pass, and
 * `name`, `inject`, and `Config` are reported like any other value because the Loader reads them from the class. Other
 * entries are not checked: libraries, a default export that is not a class, and an abstract default class, which
 * defines a capability seam that providers extend. Each entry is read through the Host compiler face and then the
 * Client face; the first face that compiles it classifies it. An entry that neither face compiles fails the gate,
 * because it would otherwise go unchecked, and so does a corpus without a function plugin or without a service plugin.
 *
 * Value-vs-type follows the names each entry exports at run time, resolved against a bound Program because
 * `verbatimModuleSyntax` is off: type-only exports and declarations emit nothing, a re-export emits only a run-time
 * export of its target, and `export *` brings in every run-time name of its target except `default` and the names the
 * module exports itself. A type-only export therefore does not hide a value that `export *` provides under the same
 * name, and a name that only `export type *` reaches, at any depth, is a type. A value passes as a class when every
 * construct signature builds an instance whose base types reach Cordis `Service` or the global `Error`; class
 * declarations, class expressions, and mixin results are judged by what they construct. An export whose target does
 * not resolve is reported, and so is an `export *` whose module does not resolve, under the name `*`.
 *
 * Exports that predate the gate are listed in scripts/plugin-entry-existing-exports.ts. A listed export passes. A list
 * line fails when its package has no entry or its entry is not a plugin, when its export list is empty or repeats a
 * name, and when it names an export the entry no longer reports, so removing an export also removes its line.
 */

import { globSync, readFileSync } from 'node:fs'
import { join, posix, resolve } from 'node:path'
import ts from 'typescript'
import { EXISTING_PLUGIN_ENTRY_EXPORTS } from './plugin-entry-existing-exports.ts'
import { TypeScriptProject, type CompilerFace } from './ts-project.ts'

const GATE = 'verify-plugin-entry-exports'
const root = resolve(import.meta.dirname, '..')

/** The corpus glob for the root entry of every workspace package. */
export const ENTRY_GLOB = 'packages/*/*/src/index.ts'

/** Repository-relative path of the list of exports that predate the gate. */
export const EXISTING_EXPORTS_FILE = 'scripts/plugin-entry-existing-exports.ts'

/** The rule this gate enforces, named in its diagnostics. */
const RULE = 'docs/defensive-patterns/package-surface.md#a-plugin-package-exports-what-the-loader-loads'

/** Values the Loader reads from a function plugin's module namespace. */
const LOADER_FIELDS: ReadonlySet<string> = new Set(['name', 'inject', 'Config', 'apply'])

/** The plugin forms the rule names: `apply` on the module namespace, or a default-exported plugin class. */
export type PluginForm = 'function' | 'service'

/** Every plugin form, in report order. */
const PLUGIN_FORMS: readonly PluginForm[] = ['function', 'service']

/** Package name to the value exports its plugin entry may keep while they still exist. */
export type ExistingEntryExports = Readonly<Record<string, readonly string[]>>

/** One package root entry that the corpus glob found. */
export interface PluginEntry {
  /** Repository-relative POSIX path of the entry. */
  readonly file: string
  /** The `name` field of the package manifest that owns the entry. */
  readonly packageName: string
}

/** One value a plugin entry exports beyond what its form allows. */
export interface EntryValueExport {
  /** Repository-relative POSIX path of the entry. */
  readonly file: string
  /** One-based line of the declaration, re-export specifier, or `export *` statement in the entry. */
  readonly line: number
  readonly packageName: string
  readonly exportName: string
  /** True when the export's target does not resolve, so the value cannot be classified. */
  readonly unresolved: boolean
}

/** What one repository scan checked and found. */
export interface ScanResult {
  /** Number of entries checked, per plugin form. */
  readonly checkedEntries: Readonly<Record<PluginForm, number>>
  /** Reported exports that the existing-export list does not name, sorted by file, line, and name. */
  readonly violations: readonly EntryValueExport[]
  /** Defects in the existing-export list. */
  readonly listProblems: readonly string[]
  /** Entries that no compiler face compiles. */
  readonly unloadedEntries: readonly string[]
  /** Number of reported exports that the existing-export list names. */
  readonly listedExports: number
}

/** How one compiler face classified one entry. */
interface EntryFacts {
  /** Undefined for an entry the Loader cannot load as a plugin. */
  readonly form: PluginForm | undefined
  readonly valueExports: readonly EntryValueExport[]
}

function lineOf(node: ts.Node, sourceFile: ts.SourceFile): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
}

function resolveAlias(symbol: ts.Symbol, checker: ts.TypeChecker): ts.Symbol {
  return (symbol.flags & ts.SymbolFlags.Alias) === 0 ? symbol : checker.getAliasedSymbol(symbol)
}

/**
 * Find every package root entry and the package that owns it.
 * @param repositoryRoot - absolute repository root.
 * @returns entries sorted by path.
 * @throws when an owning manifest has no string `name`.
 */
export function discoverEntries(repositoryRoot: string): PluginEntry[] {
  return globSync(ENTRY_GLOB, { cwd: repositoryRoot })
    .map(file => file.replaceAll('\\', '/'))
    .sort()
    .map((file) => {
      const manifest = posix.join(posix.dirname(posix.dirname(file)), 'package.json')
      const parsed: unknown = JSON.parse(readFileSync(join(repositoryRoot, manifest), 'utf8'))
      const name = typeof parsed === 'object' && parsed !== null && 'name' in parsed ? parsed.name : undefined
      if (typeof name !== 'string') throw new Error(`${GATE}: ${manifest} has no string name`)
      return { file, packageName: name }
    })
}

/** The Cordis `Service` class as this program resolves it, or undefined when the program does not load Cordis. */
function cordisService(project: TypeScriptProject): ts.Symbol | undefined {
  const { checker, program } = project
  const resolved = ts.resolveModuleName(
    '@deepseek-ai/cordis', join(project.projectRoot, 'package.json'), program.getCompilerOptions(), ts.sys,
  ).resolvedModule
  const sourceFile = resolved === undefined ? undefined : program.getSourceFile(resolved.resolvedFileName)
  const moduleSymbol = sourceFile === undefined ? undefined : checker.getSymbolAtLocation(sourceFile)
  if (moduleSymbol === undefined) return undefined
  const service = checker.getExportsOfModule(moduleSymbol).find(symbol => ts.symbolName(symbol) === 'Service')
  return service === undefined ? undefined : resolveAlias(service, checker)
}

/** Whether any hop of an export's alias chain is a type-only import or export. */
function isTypeOnlyAlias(symbol: ts.Symbol, checker: ts.TypeChecker): boolean {
  const seen = new Set<ts.Symbol>()
  for (let current: ts.Symbol | undefined = symbol; current !== undefined && !seen.has(current);) {
    seen.add(current)
    if (current.declarations?.some(declaration => ts.isTypeOnlyImportOrExportDeclaration(declaration)) === true) {
      return true
    }
    if ((current.flags & ts.SymbolFlags.Alias) === 0) return false
    current = checker.getImmediateAliasedSymbol(current)
  }
  return false
}

/** One name a module exports at run time: the node that introduces it there, and the value it carries. */
interface RuntimeExport {
  /** Undefined for a name a declaration file provides, which has no emit to locate. */
  readonly node: ts.Node | undefined
  /** Undefined when the export's target does not resolve. */
  readonly symbol: ts.Symbol | undefined
}

/** Run-time exports per module, shared by every entry that one Program classifies. */
type RuntimeExportCache = Map<ts.Symbol, ReadonlyMap<string, RuntimeExport>>

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node)?.some(modifier => modifier.kind === kind) ?? false)
}

function bindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text]
  return name.elements.flatMap(element => ts.isOmittedExpression(element) ? [] : bindingNames(element.name))
}

/** The symbol an alias resolves to, or undefined when it reaches no declaration. */
function resolvedTarget(symbol: ts.Symbol, checker: ts.TypeChecker): ts.Symbol | undefined {
  const target = resolveAlias(symbol, checker)
  return (target.declarations ?? []).length === 0 ? undefined : target
}

/** Run-time exports of the module a specifier names, or undefined when the specifier does not resolve. */
function moduleRuntimeExports(
  specifier: ts.Expression, checker: ts.TypeChecker, cache: RuntimeExportCache,
): ReadonlyMap<string, RuntimeExport> | undefined {
  const moduleSymbol = checker.getSymbolAtLocation(specifier)
  return moduleSymbol === undefined ? undefined : runtimeExports(moduleSymbol, checker, cache)
}

/** Run-time exports of a declaration file or ambient module: its values that no type-only alias reaches. */
function declaredRuntimeExports(moduleSymbol: ts.Symbol, checker: ts.TypeChecker, result: Map<string, RuntimeExport>): void {
  for (const exported of checker.getExportsOfModule(moduleSymbol)) {
    if (isTypeOnlyAlias(exported, checker)) continue
    const target = resolvedTarget(exported, checker)
    if (target === undefined || (target.flags & ts.SymbolFlags.Value) !== 0) {
      result.set(ts.symbolName(exported), { node: undefined, symbol: target })
    }
  }
}

/**
 * Names a module exports at run time with `verbatimModuleSyntax` off, each with the node that introduces it in the
 * module: type-only exports and `declare` declarations emit nothing, a re-export emits only a run-time export of its
 * target, and `export *` brings every run-time name of its target except `default` and the names the module exports
 * itself.
 */
function runtimeExports(
  moduleSymbol: ts.Symbol, checker: ts.TypeChecker, cache: RuntimeExportCache,
): ReadonlyMap<string, RuntimeExport> {
  const cached = cache.get(moduleSymbol)
  if (cached !== undefined) return cached
  const result = new Map<string, RuntimeExport>()
  // An `export *` cycle that reaches this module again sees the names collected so far.
  cache.set(moduleSymbol, result)
  const file = moduleSymbol.valueDeclaration
  if (file === undefined || !ts.isSourceFile(file) || file.isDeclarationFile) {
    declaredRuntimeExports(moduleSymbol, checker, result)
    return result
  }
  const table = new Map(checker.getExportsOfModule(moduleSymbol).map(symbol => [ts.symbolName(symbol), symbol]))
  const own = (name: string): ts.Symbol | undefined => {
    const symbol = table.get(name)
    return symbol === undefined ? undefined : resolvedTarget(symbol, checker)
  }
  const add = (name: string, node: ts.Node, symbol: ts.Symbol | undefined): void => {
    if (!result.has(name)) result.set(name, { node, symbol })
  }
  const stars: ts.ExportDeclaration[] = []
  for (const statement of file.statements) {
    if (ts.isExportDeclaration(statement)) {
      if (statement.isTypeOnly) continue
      const clause = statement.exportClause
      const specifier = statement.moduleSpecifier
      if (clause === undefined) {
        stars.push(statement)
      } else if (ts.isNamespaceExport(clause)) {
        add(clause.name.text, clause, specifier === undefined ? undefined : checker.getSymbolAtLocation(specifier))
      } else {
        for (const element of clause.elements) {
          if (element.isTypeOnly) continue
          if (specifier === undefined) {
            const local = checker.getExportSpecifierLocalTargetSymbol(element)
            if (local !== undefined && isTypeOnlyAlias(local, checker)) continue
            const target = local === undefined ? undefined : resolvedTarget(local, checker)
            if (target === undefined || (target.flags & ts.SymbolFlags.Value) !== 0) add(element.name.text, element, target)
          } else {
            const source = moduleRuntimeExports(specifier, checker, cache)
            const reexported = source?.get((element.propertyName ?? element.name).text)
            if (source === undefined || reexported !== undefined) add(element.name.text, element, reexported?.symbol)
          }
        }
      }
    } else if (ts.isExportAssignment(statement)) {
      if (statement.isExportEquals !== true) add('default', statement, own('default'))
    } else if (hasModifier(statement, ts.SyntaxKind.ExportKeyword) && !hasModifier(statement, ts.SyntaxKind.DeclareKeyword)) {
      const asDefault = hasModifier(statement, ts.SyntaxKind.DefaultKeyword) ? 'default' : undefined
      if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) {
        const name = asDefault ?? statement.name?.text
        if (name !== undefined) add(name, statement, own(name))
      } else if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          for (const name of bindingNames(declaration.name)) add(name, declaration, own(name))
        }
      } else if (ts.isEnumDeclaration(statement)) {
        if (!hasModifier(statement, ts.SyntaxKind.ConstKeyword)) add(statement.name.text, statement, own(statement.name.text))
      } else if (ts.isModuleDeclaration(statement) && ts.isIdentifier(statement.name)) {
        const namespace = own(statement.name.text)
        if (namespace !== undefined && (namespace.flags & ts.SymbolFlags.ValueModule) !== 0) {
          add(statement.name.text, statement, namespace)
        }
      }
    }
  }
  const explicit = new Set(result.keys())
  for (const star of stars) {
    const source = star.moduleSpecifier === undefined ? undefined : moduleRuntimeExports(star.moduleSpecifier, checker, cache)
    if (source === undefined) {
      add('*', star, undefined)
      continue
    }
    for (const [name, { symbol }] of source) {
      if (name !== 'default' && !explicit.has(name)) add(name, star, symbol)
    }
  }
  return result
}

function isTypeReference(type: ts.Type): type is ts.TypeReference {
  return (type.flags & ts.TypeFlags.Object) !== 0
    && ((type as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference) !== 0
}

/** Whether an instance type or one of its base types, through generic and mixin bases, is a root class. */
function reachesRoot(
  type: ts.Type, checker: ts.TypeChecker, isRoot: (symbol: ts.Symbol) => boolean, seen: Set<ts.Type>,
): boolean {
  if (seen.has(type)) return false
  seen.add(type)
  if (type.isIntersection()) return type.types.some(part => reachesRoot(part, checker, isRoot, seen))
  const declared = isTypeReference(type) ? type.target : type
  const symbol = declared.getSymbol()
  if (symbol !== undefined && isRoot(symbol)) return true
  return declared.isClassOrInterface()
    && checker.getBaseTypes(declared).some(base => reachesRoot(base, checker, isRoot, seen))
}

/** Whether a value is a class the Loader can construct: it has construct signatures and no abstract declaration. */
function isConstructibleClass(symbol: ts.Symbol, checker: ts.TypeChecker): boolean {
  return checker.getTypeOfSymbol(symbol).getConstructSignatures().length > 0
    && !(symbol.declarations ?? []).some(declaration =>
      ts.isClassDeclaration(declaration) && hasModifier(declaration, ts.SyntaxKind.AbstractKeyword))
}

/** The plugin form of an entry from its run-time exports, or undefined when the Loader cannot load it as a plugin. */
function pluginForm(exports: ReadonlyMap<string, RuntimeExport>, checker: ts.TypeChecker): PluginForm | undefined {
  if (exports.get('apply')?.symbol !== undefined) return 'function'
  const pluginClass = exports.get('default')?.symbol
  return pluginClass !== undefined && isConstructibleClass(pluginClass, checker) ? 'service' : undefined
}

/** Classify one entry's exports in the face whose program compiled it. */
function classifyEntry(
  project: TypeScriptProject, entry: PluginEntry, sourceFile: ts.SourceFile, service: ts.Symbol | undefined,
  cache: RuntimeExportCache,
): EntryFacts {
  const { checker, program } = project
  const moduleSymbol = checker.getSymbolAtLocation(sourceFile)
  if (moduleSymbol === undefined) return { form: undefined, valueExports: [] }
  const exports = runtimeExports(moduleSymbol, checker, cache)
  const form = pluginForm(exports, checker)
  if (form === undefined) return { form, valueExports: [] }
  const pluginClass = form === 'service' ? exports.get('default')?.symbol : undefined
  const isRoot = (symbol: ts.Symbol): boolean => symbol === service
    || (ts.symbolName(symbol) === 'Error'
      && (symbol.declarations ?? []).some(declaration => program.isSourceFileDefaultLibrary(declaration.getSourceFile())))
  const constructsRootClass = (target: ts.Symbol): boolean => {
    const signatures = checker.getTypeOfSymbol(target).getConstructSignatures()
    return signatures.length > 0
      && signatures.every(signature => reachesRoot(signature.getReturnType(), checker, isRoot, new Set()))
  }

  const valueExports: EntryValueExport[] = []
  for (const [exportName, { node, symbol }] of exports) {
    if (form === 'function' ? LOADER_FIELDS.has(exportName) : symbol === pluginClass) continue
    // The Loader loads a default export instead of a function plugin's namespace, so the class allowance never covers it.
    if (exportName !== 'default' && symbol !== undefined && constructsRootClass(symbol)) continue
    valueExports.push({
      file: entry.file,
      line: lineOf(node ?? sourceFile, sourceFile),
      packageName: entry.packageName,
      exportName,
      unresolved: symbol === undefined,
    })
  }
  return { form, valueExports }
}

function duplicates(names: readonly string[]): string[] {
  const seen = new Set<string>()
  return [...new Set(names.filter(name => seen.has(name) || !seen.add(name)))]
}

/** Problems of the existing-export list against what the scan classified. */
function existingListProblems(
  existing: ExistingEntryExports, entries: readonly PluginEntry[], facts: ReadonlyMap<string, EntryFacts>,
): string[] {
  const problems: string[] = []
  const entriesByPackage = new Map(entries.map(entry => [entry.packageName, entry]))
  for (const [packageName, exportNames] of Object.entries(existing)) {
    const entry = entriesByPackage.get(packageName)
    if (entry === undefined) {
      problems.push(`${packageName} has no ${ENTRY_GLOB} entry; remove its line`)
      continue
    }
    const entryFacts = facts.get(entry.file)
    // An entry that no face compiles is reported on its own; its exports are unknown.
    if (entryFacts === undefined) continue
    if (entryFacts.form === undefined) {
      problems.push(`${packageName}: ${entry.file} is not a plugin entry; remove its line`)
      continue
    }
    if (exportNames.length === 0) problems.push(`${packageName} lists no exports; remove its line`)
    for (const name of duplicates(exportNames)) problems.push(`${packageName} lists ${name} more than once; keep one`)
    const reported = new Set(entryFacts.valueExports.map(value => value.exportName))
    for (const name of new Set(exportNames)) {
      if (!reported.has(name)) {
        problems.push(`${packageName} lists ${name}, which ${entry.file} no longer exports beyond the rule; remove it`)
      }
    }
  }
  return problems
}

/**
 * Classify the entries one compiler face compiles and that no earlier face classified. The face's Program stays local
 * to this call, so it is collectable before the next face builds its own.
 */
function classifyFace(
  repositoryRoot: string, face: CompilerFace, entries: readonly PluginEntry[], facts: Map<string, EntryFacts>,
): void {
  const project = new TypeScriptProject(repositoryRoot, face)
  const service = cordisService(project)
  const cache: RuntimeExportCache = new Map()
  for (const entry of entries) {
    if (facts.has(entry.file)) continue
    const sourceFile = project.program.getSourceFile(resolve(repositoryRoot, entry.file))
    if (sourceFile !== undefined) facts.set(entry.file, classifyEntry(project, entry, sourceFile, service, cache))
  }
}

/**
 * Check every plugin entry against the rule and the existing-export list.
 * @param repositoryRoot - absolute root holding `packages/` and the `tsconfig.<face>.json` aggregates.
 * @param existing - package name to the value exports that may remain.
 * @param faces - compiler faces to load in order; the first face that compiles an entry classifies it.
 * @returns the checked counts, the unlisted exports, the list problems, and the uncompiled entries.
 */
export function scanRepository(
  repositoryRoot: string = root,
  existing: ExistingEntryExports = EXISTING_PLUGIN_ENTRY_EXPORTS,
  faces: readonly CompilerFace[] = ['host', 'client'],
): ScanResult {
  const entries = discoverEntries(repositoryRoot)
  const facts = new Map<string, EntryFacts>()
  for (const face of faces) classifyFace(repositoryRoot, face, entries, facts)
  const reported = entries.flatMap(entry => facts.get(entry.file)?.valueExports ?? [])
  const violations = reported
    .filter(value => existing[value.packageName]?.includes(value.exportName) !== true)
    .sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line
      || left.exportName.localeCompare(right.exportName))
  const checked = (form: PluginForm): number => entries.filter(entry => facts.get(entry.file)?.form === form).length
  return {
    checkedEntries: { function: checked('function'), service: checked('service') },
    violations,
    listProblems: existingListProblems(existing, entries, facts),
    unloadedEntries: entries.filter(entry => !facts.has(entry.file)).map(entry => entry.file),
    listedExports: reported.length - violations.length,
  }
}

/**
 * Render a scan as failure lines.
 * @param result - one repository scan.
 * @returns one line per failure, empty when the tree passes.
 */
export function scanFailures(result: ScanResult): string[] {
  return [
    ...PLUGIN_FORMS.filter(form => result.checkedEntries[form] === 0)
      .map(form => `no ${form} plugin entry matches ${ENTRY_GLOB}; entry discovery or classification is broken`),
    ...result.unloadedEntries.map(file =>
      `${file} is compiled by neither tsconfig.host.json nor tsconfig.client.json, so its exports go unchecked`),
    ...result.violations.map(value => `${value.file}:${String(value.line)} ${value.packageName} exports `
      + `${value.exportName}${value.unresolved ? ', whose target does not resolve' : ''}`),
    ...result.listProblems.map(problem => `${EXISTING_EXPORTS_FILE}: ${problem}`),
  ]
}

/** CLI entry: report every failure and exit 1, or confirm the invariant holds. */
function main(): void {
  const result = scanRepository()
  const failures = scanFailures(result)
  if (failures.length === 0) {
    console.log(`${GATE}: ${String(result.checkedEntries.function)} function plugin and`
      + ` ${String(result.checkedEntries.service)} service plugin entries export only what the Loader loads, types,`
      + ` and Service or Error classes, apart from ${String(result.listedExports)} export(s) listed in`
      + ` ${EXISTING_EXPORTS_FILE}.`)
    return
  }
  console.error(`${GATE}: ${String(failures.length)} problem(s):`)
  for (const failure of failures) console.error(`  ${failure}`)
  if (result.violations.length > 0) {
    console.error('\nA function plugin entry exports name, inject, Config, and apply, and a service plugin entry'
      + ' default-exports its plugin class; either may also export types and classes extending Cordis Service or'
      + ` Error (${RULE}).`)
    console.error('Keep any other value in an internal module: same-package tests import that module, and other'
      + ' packages reach the behavior through a ctx service.')
  }
  process.exitCode = 1
}

if (process.argv[1] && import.meta.filename === resolve(process.argv[1])) main()
