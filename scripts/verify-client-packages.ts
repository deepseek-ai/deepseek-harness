/**
 * Verify client package modes and the synchronous browser module-request graph.
 */

import { globSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'
import { TypeScriptProject } from './ts-project.ts'

const GATE = 'verify-client-packages'
const CLIENT_MANIFEST_GLOB = 'packages/client/*/package.json'
const MANIFEST_GLOBS = ['packages/*/*/package.json', 'apps/*/package.json', 'vendor/*/package.json']
const CONFIG_GLOB = 'packages/*/*/tsdown.config.ts'
const PLATFORM_SOURCE = 'packages/client/web/src/platform.ts'
const PARSER_PRELOAD_SOURCE = 'packages/client/modules/src/index.ts'
const STATIC_PRESET_SOURCE = 'packages/client/tsdown.client.ts'
const CORDIS = '@deepseek-ai/cordis'

/** One workspace package's browser-module declaration. */
export interface ClientDeclaration {
  readonly name: string
  readonly manifest: string
  readonly dynamic: boolean
  readonly external: readonly string[]
  readonly runtimeSourceUses: Readonly<Record<string, readonly string[]>>
  /** Exact runtime specifiers used to validate `dsh.client.external` declarations. */
  readonly runtimeSourceSpecifiers: Readonly<Record<string, readonly string[]>>
  /** Informational package dependencies declared by the row. */
  readonly inject: readonly string[]
}

/** One package directly under packages/client. */
export interface ClientPackage extends ClientDeclaration {
  readonly staticLinked: boolean
  readonly sourceUses: Readonly<Record<string, readonly string[]>>
  readonly dependencies: Readonly<Record<string, string>>
  readonly peerDependencies: Readonly<Record<string, string>>
  readonly devDependencies: Readonly<Record<string, string>>
}

/** Complete source-plane input to the client package verifier. */
export interface ClientPackageFacts {
  readonly packages: readonly ClientPackage[]
  readonly declarations: readonly ClientDeclaration[]
  readonly staticLinkedPackages: ReadonlySet<string>
  readonly platformModules: readonly string[]
  readonly preloadedExternals: readonly string[]
  readonly parserPreloadIds: readonly string[]
  readonly malformed: readonly string[]
}

/** Result of reading every workspace browser-module declaration. */
export interface ClientDeclarations {
  readonly declarations: ClientDeclaration[]
  readonly malformed: string[]
}

/**
 * Collect bare packages referenced by one production source file.
 * @param path - File path used to select TypeScript's parser mode.
 * @param source - Source text to inspect.
 * @returns Bare package names referenced by imports, declarations, or JSX.
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

function collectSourceFileUses(
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
    uses.add(key === 'package' ? packageNameOf(specifier.text) : specifier.text)
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
export function readClientDeclarations(root: string): ClientDeclarations {
  const malformed: string[] = []
  const declarations = globSync(MANIFEST_GLOBS, { cwd: root })
    .map(normalizePath)
    .sort()
    .flatMap(path => readDeclaration(root, path, malformed) ?? [])
  return { declarations, malformed }
}

/**
 * Return every client package policy violation.
 * @param facts - Package modes, manifests, source uses, and platform module lists.
 * @returns Stable self-contained diagnostics.
 */
export function collectClientPackageViolations(facts: ClientPackageFacts): string[] {
  return [
    ...facts.malformed,
    ...collectModeViolations(facts),
    ...collectModuleViolations(facts),
  ].sort((left, right) => left.localeCompare(right))
}

interface ManifestDocument {
  readonly path: string
  readonly manifest: Manifest
  changed: boolean
}

/**
 * Repair malformed or redundant `dsh.client` declaration entries.
 * @param root - Absolute repository root.
 * @param facts - Facts used by the verification pass.
 * @returns Repository-relative manifests written by the fixer.
 */
export function fixClientPackageManifests(root: string, facts: ClientPackageFacts): string[] {
  const documents = new Map<string, ManifestDocument>()
  const document = (path: string): ManifestDocument => {
    const cached = documents.get(path)
    if (cached !== undefined) return cached
    const loaded: ManifestDocument = {
      path,
      manifest: JSON.parse(readFileSync(resolve(root, path), 'utf8')) as Manifest,
      changed: false,
    }
    documents.set(path, loaded)
    return loaded
  }

  const baseline = new Set([...facts.platformModules, ...facts.preloadedExternals])
  for (const declaration of facts.declarations.filter(entry => entry.dynamic)) {
    const target = document(declaration.manifest)
    const dsh = isRecord(target.manifest.dsh) ? target.manifest.dsh : undefined
    const client = isRecord(dsh?.client) ? dsh.client : undefined
    if (client === undefined) continue
    target.changed = normalizeClientArray(client, 'inject', () => false) || target.changed
    target.changed = normalizeClientArray(
      client,
      'external',
      value => baseline.has(value) || rowPackageOf(value, new Set([declaration.name])) === declaration.name,
    ) || target.changed
  }

  const changed = [...documents.values()].filter(target => target.changed).sort((left, right) =>
    left.path.localeCompare(right.path))
  for (const target of changed) {
    writeFileSync(resolve(root, target.path), JSON.stringify(target.manifest, null, 2) + '\n')
  }
  return changed.map(target => target.path)
}

function normalizeClientArray(
  client: Record<string, unknown>,
  field: 'external' | 'inject',
  remove: (value: string) => boolean,
): boolean {
  const value = client[field]
  if (!Array.isArray(value) || value.some(entry => typeof entry !== 'string')) return false
  const seen = new Set<string>()
  const normalized = value.filter((entry: string) => {
    if (entry === '' || seen.has(entry) || remove(entry)) return false
    seen.add(entry)
    return true
  })
  if (normalized.length === value.length && normalized.every((entry, index) => entry === value[index])) return false
  if (normalized.length === 0) {
    if (field === 'external') delete client.external
    else delete client.inject
  } else {
    client[field] = normalized
  }
  return true
}

function collectModeViolations(facts: ClientPackageFacts): string[] {
  const violations: string[] = []
  for (const pkg of facts.packages) {
    if (pkg.dynamic && pkg.staticLinked) {
      violations.push(
        pkg.manifest + ': ' + pkg.name + ' declares dsh.client and uses the staticLinked preset;'
        + ' a client package must be dynamic or statically linked, not both',
      )
    } else if (!pkg.dynamic && !pkg.staticLinked) {
      violations.push(
        pkg.manifest + ': ' + pkg.name + ' has no supported client package mode;'
        + ' declare dsh.client or use the staticLinked preset',
      )
    }
  }

  const workspaceNames = new Set(facts.declarations.map(entry => entry.name))
  for (const specifier of facts.platformModules) {
    const owner = packageNameOf(specifier)
    if (!workspaceNames.has(owner) || owner === CORDIS || facts.staticLinkedPackages.has(owner)) continue
    violations.push(
      PLATFORM_SOURCE + ': seeded workspace module ' + JSON.stringify(specifier)
      + ' belongs to ' + owner + ', whose build does not use the staticLinked preset',
    )
  }

  const rows = rowNames(facts.declarations)
  for (const specifier of facts.preloadedExternals) {
    if (rowPackageOf(specifier, rows) === undefined) {
      violations.push(
        PLATFORM_SOURCE + ': parser-preloaded external ' + JSON.stringify(specifier)
        + ' has no dynamic dsh.client row',
      )
    }
    if (!facts.parserPreloadIds.includes(stripClientSuffix(specifier))) {
      violations.push(
        PLATFORM_SOURCE + ': parser-preloaded external ' + JSON.stringify(specifier)
        + ' has no matching PARSER_PRELOAD_IDS row in ' + PARSER_PRELOAD_SOURCE,
      )
    }
  }
  return violations
}

interface ModuleEdge {
  readonly from: string
  readonly to: string
  readonly specifier: string
}

function collectModuleViolations(facts: ClientPackageFacts): string[] {
  const violations: string[] = []
  const baseline = new Set([...facts.platformModules, ...facts.preloadedExternals])
  const rows = rowNames(facts.declarations)
  const byName = new Map(facts.declarations.map(entry => [entry.name, entry]))
  const edges: ModuleEdge[] = []

  for (const pkg of facts.declarations.filter(entry => entry.dynamic)) {
    for (const field of ['external', 'inject'] as const) {
      const seen = new Set<string>()
      for (const value of pkg[field]) {
        if (value === '') violations.push(pkg.manifest + ': dsh.client.' + field + ' contains an empty value')
        else if (seen.has(value)) {
          violations.push(pkg.manifest + ': dsh.client.' + field + ' lists ' + JSON.stringify(value) + ' twice')
        }
        seen.add(value)
      }
    }

    for (const specifier of new Set(pkg.external)) {
      if (specifier === '') continue
      if (baseline.has(specifier)) {
        violations.push(
          pkg.manifest + ': dsh.client.external repeats baseline module ' + JSON.stringify(specifier)
          + '; remove the explicit declaration',
        )
        continue
      }
      const supplier = rowPackageOf(specifier, rows)
      if (supplier === pkg.name) {
        violations.push(pkg.manifest + ': dsh.client.external names its own row ' + JSON.stringify(specifier))
      } else if (supplier !== undefined) {
        if (pkg.manifest.startsWith('packages/client/')) {
          violations.push(
            pkg.manifest + ': client feature package requests runtime external ' + JSON.stringify(specifier)
            + '; import shared types only or call an injected Cordis service',
          )
          continue
        }
        if (pkg.runtimeSourceSpecifiers[specifier] === undefined) {
          violations.push(
            pkg.manifest + ': dsh.client.external ' + JSON.stringify(specifier)
            + ' has no runtime import or re-export in production source; remove the stale declaration',
          )
          continue
        }
        edges.push({ from: pkg.name, to: supplier, specifier })
      } else {
        const owner = stripClientSuffix(specifier)
        violations.push(
          pkg.manifest + ': dsh.client.external ' + JSON.stringify(specifier) + ' has no supplier;'
          + (byName.has(owner)
            ? ' workspace package ' + owner
              + ' declares no dynamic dsh.client row and the shell does not seed this specifier'
            : ' no dynamic row or PLATFORM_MODULES entry answers it'),
        )
      }
    }
  }

  violations.push(...collectModuleCycles(edges, byName))
  return violations
}

function collectModuleCycles(
  edges: readonly ModuleEdge[],
  byName: ReadonlyMap<string, ClientDeclaration>,
): string[] {
  const outgoing = new Map<string, ModuleEdge[]>()
  for (const edge of [...edges].sort((left, right) => left.specifier.localeCompare(right.specifier))) {
    outgoing.set(edge.from, [...outgoing.get(edge.from) ?? [], edge])
  }
  const finished = new Set<string>()
  const onPath = new Set<string>()
  const path: ModuleEdge[] = []
  const reported = new Map<string, string>()

  const walk = (name: string): void => {
    onPath.add(name)
    for (const edge of outgoing.get(name) ?? []) {
      if (onPath.has(edge.to)) {
        const start = path.findIndex(entry => entry.from === edge.to)
        const cycle = start === -1 ? [edge] : [...path.slice(start), edge]
        const key = cycleKey(cycle)
        if (!reported.has(key)) reported.set(key, formatCycle(cycle, byName))
      } else if (!finished.has(edge.to)) {
        path.push(edge)
        walk(edge.to)
        path.pop()
      }
    }
    onPath.delete(name)
    finished.add(name)
  }

  for (const name of [...outgoing.keys()].sort()) {
    if (!finished.has(name)) walk(name)
  }
  return [...reported.values()]
}

function cycleKey(cycle: readonly ModuleEdge[]): string {
  const labels = cycle.map(edge => edge.from + ' ' + edge.specifier)
  const first = [...labels].sort()[0]
  const offset = first === undefined ? 0 : labels.indexOf(first)
  return [...labels.slice(offset), ...labels.slice(0, offset)].join(' -> ')
}

function formatCycle(
  cycle: readonly ModuleEdge[],
  byName: ReadonlyMap<string, ClientDeclaration>,
): string {
  const entry = cycle[0]
  const chain = cycle.map(edge => edge.from + ' --(' + edge.specifier + ')-->').join(' ')
  const manifest = entry === undefined ? 'packages/client' : byName.get(entry.from)?.manifest ?? entry.from
  return manifest + ': synchronous dsh.client.external cycle: ' + chain + ' ' + (entry?.from ?? '')
}

interface Manifest {
  name?: unknown
  dsh?: unknown
  dependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

function readDeclaration(
  root: string,
  manifestPath: string,
  malformed: string[],
): ClientDeclaration | undefined {
  const manifest = JSON.parse(readFileSync(resolve(root, manifestPath), 'utf8')) as Manifest
  if (typeof manifest.name !== 'string') return undefined
  const dsh = isRecord(manifest.dsh) ? manifest.dsh : undefined
  const rawClient = dsh?.client
  if (rawClient === undefined) {
    return {
      name: manifest.name, manifest: manifestPath, dynamic: false, external: [], inject: [],
      runtimeSourceUses: {}, runtimeSourceSpecifiers: {},
    }
  }
  if (!isRecord(rawClient)) {
    malformed.push(manifestPath + ': ' + manifest.name + ' dsh.client must be an object')
    return {
      name: manifest.name, manifest: manifestPath, dynamic: false, external: [], inject: [],
      runtimeSourceUses: {}, runtimeSourceSpecifiers: {},
    }
  }
  return {
    name: manifest.name,
    manifest: manifestPath,
    dynamic: true,
    external: stringArray(rawClient.external, manifest.name, manifestPath, 'external', malformed),
    inject: stringArray(rawClient.inject, manifest.name, manifestPath, 'inject', malformed),
    runtimeSourceUses: {},
    runtimeSourceSpecifiers: {},
  }
}

function stringArray(
  value: unknown,
  packageName: string,
  manifestPath: string,
  field: string,
  malformed: string[],
): readonly string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some(entry => typeof entry !== 'string')) {
    malformed.push(manifestPath + ': ' + packageName + ' dsh.client.' + field + ' must be a string array')
    return []
  }
  return value as string[]
}

async function readStaticLinkedRoster(root: string): Promise<Set<string>> {
  const presetUrl = pathToFileURL(resolve(import.meta.dirname, '..', STATIC_PRESET_SOURCE)).href
  const preset = await import(presetUrl) as { isStaticLinkedConfig?: unknown }
  if (typeof preset.isStaticLinkedConfig !== 'function') {
    throw new Error(GATE + ': ' + STATIC_PRESET_SOURCE + ' exports no isStaticLinkedConfig')
  }
  const predicate = preset.isStaticLinkedConfig as (configs: readonly unknown[]) => boolean
  const roster = new Set<string>()
  for (const configPath of globSync(CONFIG_GLOB, { cwd: root }).map(normalizePath).sort()) {
    const loaded = await import(pathToFileURL(resolve(root, configPath)).href) as { default?: unknown }
    if (typeof loaded.default !== 'function') continue
    const configs = (loaded.default as (input: { env: Record<string, string> }) => unknown)({
      env: { DSH_BUILD_FACE: 'client' },
    })
    if (!Array.isArray(configs) || !predicate(configs)) continue
    const manifest = JSON.parse(
      readFileSync(resolve(root, configPath.replace(/tsdown\.config\.ts$/, 'package.json')), 'utf8'),
    ) as Manifest
    if (typeof manifest.name === 'string') roster.add(manifest.name)
  }
  return roster
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression
  while (ts.isAsExpression(current) || ts.isSatisfiesExpression(current) || ts.isParenthesizedExpression(current)) {
    current = current.expression
  }
  return current
}

function readStringLiteralArray(root: string, sourcePath: string, name: string): string[] {
  const path = resolve(root, sourcePath)
  const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, false, ts.ScriptKind.TS)
  const constants = new Map<string, string>()
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.initializer === undefined) continue
      const initializer = unwrapExpression(declaration.initializer)
      if (ts.isStringLiteral(initializer)) constants.set(declaration.name.text, initializer.text)
    }
  }
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== name) continue
      const expression = declaration.initializer === undefined ? undefined : unwrapExpression(declaration.initializer)
      if (expression === undefined || !ts.isArrayLiteralExpression(expression)) {
        throw new Error(GATE + ': ' + name + ' in ' + sourcePath + ' must be an array literal')
      }
      return expression.elements.map((element) => {
        const value = unwrapExpression(element)
        if (ts.isStringLiteral(value)) return value.text
        if (ts.isIdentifier(value) && constants.has(value.text)) return constants.get(value.text) as string
        throw new Error(GATE + ': ' + name + ' in ' + sourcePath + ' must contain only string constants')
      })
    }
  }
  throw new Error(GATE + ': ' + sourcePath + ' declares no ' + name)
}

async function readFacts(root: string): Promise<ClientPackageFacts> {
  const { declarations: bareDeclarations, malformed } = readClientDeclarations(root)
  const staticLinkedPackages = await readStaticLinkedRoster(root)
  const project = new TypeScriptProject(root, 'client')
  const sourceFiles = project.sourceFiles()
  const declarations = bareDeclarations.map((declaration): ClientDeclaration => {
    const runtimeSourceUses = new Map<string, Set<string>>()
    const runtimeSourceSpecifiers = new Map<string, Set<string>>()
    const sourcePrefix = dirname(declaration.manifest) + '/src/'
    for (const sourceFile of sourceFiles) {
      if (sourceFile.isDeclarationFile) continue
      const file = project.relativePath(sourceFile)
      if (!file.startsWith(sourcePrefix)) continue
      for (const name of collectSourceFileUses(sourceFile, true, 'package')) {
        const locations = runtimeSourceUses.get(name) ?? new Set<string>()
        locations.add(file)
        runtimeSourceUses.set(name, locations)
      }
      for (const specifier of collectSourceFileUses(sourceFile, true, 'specifier')) {
        const locations = runtimeSourceSpecifiers.get(specifier) ?? new Set<string>()
        locations.add(file)
        runtimeSourceSpecifiers.set(specifier, locations)
      }
    }
    return {
      ...declaration,
      runtimeSourceUses: Object.fromEntries(
        [...runtimeSourceUses].sort(([left], [right]) => left.localeCompare(right))
          .map(([name, locations]) => [name, [...locations].sort()]),
      ),
      runtimeSourceSpecifiers: Object.fromEntries(
        [...runtimeSourceSpecifiers].sort(([left], [right]) => left.localeCompare(right))
          .map(([specifier, locations]) => [specifier, [...locations].sort()]),
      ),
    }
  })
  const byManifest = new Map(declarations.map(entry => [entry.manifest, entry]))
  const packages: ClientPackage[] = []

  for (const manifestPath of globSync(CLIENT_MANIFEST_GLOB, { cwd: root }).map(normalizePath).sort()) {
    const declaration = byManifest.get(manifestPath)
    if (declaration === undefined) throw new Error(GATE + ': no declaration facts for ' + manifestPath)
    const manifest = JSON.parse(readFileSync(resolve(root, manifestPath), 'utf8')) as Manifest
    if (typeof manifest.name !== 'string') throw new Error(GATE + ': ' + manifestPath + ' has no package name')
    const sourceUses = new Map<string, Set<string>>()
    const runtimeSourceUses = new Map<string, Set<string>>()
    const packageDirectory = dirname(manifestPath)
    const sourcePrefix = packageDirectory + '/src/'
    for (const sourceFile of sourceFiles) {
      if (sourceFile.isDeclarationFile) continue
      const file = project.relativePath(sourceFile)
      if (!file.startsWith(sourcePrefix)) continue
      for (const name of collectSourceFileUses(sourceFile, false, 'package')) {
        const locations = sourceUses.get(name) ?? new Set<string>()
        locations.add(file)
        sourceUses.set(name, locations)
      }
      for (const name of collectSourceFileUses(sourceFile, true, 'package')) {
        const locations = runtimeSourceUses.get(name) ?? new Set<string>()
        locations.add(file)
        runtimeSourceUses.set(name, locations)
      }
    }
    packages.push({
      ...declaration,
      staticLinked: staticLinkedPackages.has(declaration.name),
      sourceUses: Object.fromEntries(
        [...sourceUses].sort(([left], [right]) => left.localeCompare(right))
          .map(([name, locations]) => [name, [...locations].sort()]),
      ),
      runtimeSourceUses: Object.fromEntries(
        [...runtimeSourceUses].sort(([left], [right]) => left.localeCompare(right))
          .map(([name, locations]) => [name, [...locations].sort()]),
      ),
      dependencies: manifest.dependencies ?? {},
      peerDependencies: manifest.peerDependencies ?? {},
      devDependencies: manifest.devDependencies ?? {},
    })
  }

  return {
    packages,
    declarations,
    staticLinkedPackages,
    platformModules: readStringLiteralArray(root, PLATFORM_SOURCE, 'PLATFORM_MODULES'),
    preloadedExternals: readStringLiteralArray(root, PLATFORM_SOURCE, 'PRELOADED_CLIENT_EXTERNALS'),
    parserPreloadIds: readStringLiteralArray(root, PARSER_PRELOAD_SOURCE, 'PARSER_PRELOAD_IDS'),
    malformed,
  }
}

function packageNameOf(specifier: string): string {
  const segments = specifier.split('/')
  return segments.slice(0, specifier.startsWith('@') ? 2 : 1).join('/')
}

function stripClientSuffix(specifier: string): string {
  return specifier.endsWith('/client') ? specifier.slice(0, -'/client'.length) : specifier
}

function rowNames(declarations: readonly ClientDeclaration[]): Set<string> {
  return new Set(declarations.filter(entry => entry.dynamic).map(entry => entry.name))
}

function rowPackageOf(specifier: string, rows: ReadonlySet<string>): string | undefined {
  if (rows.has(specifier)) return specifier
  const stripped = stripClientSuffix(specifier)
  return rows.has(stripped) ? stripped : undefined
}

function isBareSpecifier(specifier: string): boolean {
  return !specifier.startsWith('.') && !specifier.startsWith('/') && !specifier.startsWith('#')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizePath(path: string): string {
  return path.split(sep).join('/')
}

async function main(): Promise<void> {
  const root = resolve(import.meta.dirname, '..')
  let facts = await readFacts(root)
  if (process.argv.includes('--fix')) {
    const changed = fixClientPackageManifests(root, facts)
    console.log(
      changed.length === 0
        ? GATE + ': no mechanically fixable manifest changes.'
        : GATE + ': fixed ' + String(changed.length) + ' manifest(s): ' + changed.join(', '),
    )
    facts = await readFacts(root)
  }
  const violations = collectClientPackageViolations(facts)
  if (violations.length > 0) {
    console.error(GATE + ': ' + String(violations.length) + ' violation(s):')
    for (const violation of violations) console.error('  ' + violation)
    process.exit(1)
  }

  const dynamic = facts.packages.filter(pkg => pkg.dynamic).length
  const requests = facts.declarations.reduce((total, pkg) => total + pkg.external.length, 0)
  console.log(
    GATE + ': ' + String(facts.packages.length) + ' client packages (' + String(dynamic) + ' dynamic, '
    + String(facts.packages.length - dynamic) + ' statically linked) satisfy package-mode and module-request rules; '
    + String(requests) + ' explicit external request(s).',
  )
}

if (process.argv[1] !== undefined && import.meta.filename === resolve(process.argv[1])) {
  await main()
}
