/**
 * Verify client package modes, the synchronous browser module-request graph, package-asset publication, and the
 * `/client` spelling of repository references to packages whose root reuses the `./client` declarations.
 */

import { execFileSync } from 'node:child_process'
import { globSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, posix, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { transform } from 'lightningcss'
import ts from 'typescript'
import {
  PACKAGE_ASSET_EXPORT,
  PACKAGE_ASSET_EXPORT_TARGET,
  PACKAGE_ASSET_FILES_ENTRY,
  packageAssetMediaType,
} from '../packages/client/modules/src/assets.ts'
import { stripClientSuffix } from '../packages/client/modules/src/client/manifest.ts'
import { TypeScriptProject } from './ts-project.ts'

export {
  collectLocalSourceSpecifiers,
  collectRuntimeLocalSourceSpecifiers,
  collectRuntimeSourcePackageUses,
  collectRuntimeSourceSpecifiers,
  collectSourcePackageUses,
} from './source-parse-uses.ts'
import { collectSourceFileUses } from './source-parse-uses.ts'
const GATE = 'verify-client-packages'
const CLIENT_MANIFEST_GLOB = 'packages/client/*/package.json'
/** Manifest prefix of Client feature packages, which may request only infrastructure rows at runtime. */
const CLIENT_FEATURE_PREFIX = 'packages/client/'
/** Manifest prefix of the Remote API group, whose dynamic rows are infrastructure a Client feature may request. */
const INFRASTRUCTURE_PREFIX = 'packages/api/'
const MANIFEST_GLOBS = ['packages/*/*/package.json', 'apps/*/package.json', 'vendor/*/package.json', 'vendor/im/*/package.json']
const CONFIG_GLOB = 'packages/*/*/tsdown.config.ts'
const PLATFORM_SOURCE = 'packages/client/web/src/platform.ts'
const PARSER_PRELOAD_SOURCE = 'packages/client/modules/src/index.ts'
const STATIC_PRESET_SOURCE = 'packages/client/tsdown.client.ts'
const CORDIS = '@deepseek-ai/cordis'
/** Stylesheet requests the dynamic build preset compiles: CSS Modules, global sheets, and `?inline` text. */
const STYLESHEET_REQUEST = /\.css(?:\?inline)?$/u
const INLINE_STYLESHEET_QUERY = /\?inline$/u
/** Repository TypeScript sources whose module references the `/client` spelling rule reads. */
const TYPESCRIPT_SOURCE = /\.(?:[cm]?ts|tsx)$/u
/**
 * Fixtures of code outside the repository, which may name these packages by either spelling; they compile against the
 * published declarations ([check](verify-client-package-consumer-types.ts)).
 */
const EXTERNAL_CONSUMER_FIXTURES = 'scripts/fixtures/client-package-consumer/'
/** Vitest calls whose first argument is a module specifier. */
const VITEST_MODULE_CALLS = new Set(['mock', 'doMock', 'unmock', 'doUnmock', 'importActual', 'importMock'])

/** One source location whose reference makes the dynamic build preset emit a package asset. */
export interface AssetReference {
  /** Repository-relative, `/`-separated source or stylesheet path. */
  readonly file: string
  /** The JSON-quoted module specifier, or `url("<value>")` for a stylesheet reference. */
  readonly reference: string
}

/** One workspace package's browser-module declaration. */
export interface ClientDeclaration {
  readonly name: string
  readonly manifest: string
  readonly dynamic: boolean
  /** String `dsh.client.platform`; undefined without a row or a string platform. */
  readonly platform: string | undefined
  /** Whether the row declares `dsh.client.immediately: true`. */
  readonly immediately: boolean
  readonly external: readonly string[]
  readonly runtimeSourceUses: Readonly<Record<string, readonly string[]>>
  /** Exact runtime specifiers used to validate `dsh.client.external` declarations. */
  readonly runtimeSourceSpecifiers: Readonly<Record<string, readonly string[]>>
  /** Informational package dependencies declared by the row. */
  readonly inject: readonly string[]
  /** Raw `exports["./assets/*"]` value; undefined when the manifest declares no such subpath. */
  readonly assetExport: unknown
  /**
   * Package-asset references in a dynamic Web row's Client sources under `src/` and in the package stylesheets they
   * import, sorted by file and then reference; empty for every other package.
   */
  readonly assetReferences: readonly AssetReference[]
}

/**
 * One module specifier in repository TypeScript source: an import or export declaration, an `import()` expression
 * or type, a `require` or Vitest module-mock call, or a `declare module` name.
 */
export interface ModuleReference {
  /** Repository-relative, `/`-separated source path. */
  readonly file: string
  /** One-based line of the specifier. */
  readonly line: number
  /** The module specifier as written. */
  readonly module: string
  /** `augmentation` for a `declare module` name, `import` for every other reference. */
  readonly kind: 'augmentation' | 'import'
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
  /** Workspace packages whose root `types` export is their `./client` declarations ({@link reusesClientTypes}). */
  readonly clientTypedRoots: ReadonlySet<string>
  /**
   * References to the {@link clientTypedRoots} packages, or to their `/client` subpaths, in the repository's
   * TypeScript sources outside `vendor/` and the external consumer fixtures.
   */
  readonly clientTypedRootReferences: readonly ModuleReference[]
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
export function collectSourceAssetSpecifiers(path: string, source: string): Set<string> {
  const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true)
  return new Set([...collectSourceFileUses(sourceFile, true, 'local')].filter(isAssetSpecifier))
}

function isAssetSpecifier(specifier: string): boolean {
  return packageAssetMediaType(specifier) !== undefined
}

/**
 * Collect the relative `url()` values of one stylesheet, which the dynamic build preset resolves to package assets.
 * @param path - Stylesheet path; a `.module.css` name enables CSS Modules syntax, as in the build preset.
 * @param source - Stylesheet text.
 * @returns `url()` values in source order, excluding empty values, fragments, root-relative paths, and URLs with a
 * scheme such as `data:` or `https:`.
 * @throws when lightningcss cannot parse the stylesheet; the message names `path`.
 */
export function collectStylesheetAssetUrls(path: string, source: string): string[] {
  const urls: string[] = []
  try {
    transform({
      filename: path,
      code: Buffer.from(source),
      cssModules: path.endsWith('.module.css'),
      visitor: {
        Url(url) {
          if (isRelativeStylesheetUrl(url.url)) urls.push(url.url)
        },
        // lightningcss does not visit the urls inside image-set(), so its options are read here.
        Image(image) {
          if (image.type !== 'image-set') return
          for (const option of image.value.options) {
            if (option.image.type === 'url' && isRelativeStylesheetUrl(option.image.value.url)) urls.push(option.image.value.url)
          }
        },
      },
    })
  } catch (error) {
    throw new Error(
      GATE + ': cannot parse stylesheet ' + path + ': ' + (error instanceof Error ? error.message : String(error)),
      { cause: error },
    )
  }
  return urls
}

function isRelativeStylesheetUrl(url: string): boolean {
  return url !== '' && !url.startsWith('#') && !url.startsWith('/') && !/^[a-z][a-z\d+.-]*:/iu.test(url)
}

/**
 * Read package-asset references from the stylesheets that Client sources import. The dynamic build preset
 * compiles exactly these stylesheets: the package's own stylesheets under `src/`, whose relative `url()` values name
 * package assets, and dependency stylesheets imported by bare specifier, whose relative `url()` values it publishes
 * under `lib/assets/vendor/`. A stylesheet no Client source imports, such as a copied static payload, keeps its
 * `url()` values unchanged.
 * @param root - Absolute repository root.
 * @param packageDirectory - Repository-relative, `/`-separated package directory.
 * @param importers - Repository-relative, `/`-separated Client source paths and their runtime local module specifiers
 *   and bare stylesheet specifiers.
 * @returns Imported `.css` and `.css?inline` stylesheets under the package's `src/`, in path order, and the references
 *   of those and of the imported dependency stylesheets, which are named by their repository-relative real path.
 * @throws when a bare stylesheet specifier does not resolve from the package directory.
 */
export function readStylesheetAssetReferences(
  root: string,
  packageDirectory: string,
  importers: ReadonlyMap<string, Iterable<string>>,
): { readonly stylesheets: readonly string[]; readonly references: readonly AssetReference[] } {
  const sourcePrefix = packageDirectory + '/src/'
  const imported = new Set<string>()
  const dependencies = new Set<string>()
  const packageRequire = createRequire(resolve(root, packageDirectory, 'package.json'))
  for (const [file, specifiers] of importers) {
    for (const specifier of specifiers) {
      if (!STYLESHEET_REQUEST.test(specifier)) continue
      const request = specifier.replace(INLINE_STYLESHEET_QUERY, '')
      if (specifier.startsWith('.')) {
        const stylesheet = posix.join(posix.dirname(file), request)
        if (stylesheet.startsWith(sourcePrefix)) imported.add(stylesheet)
        continue
      }
      let resolved: string
      try {
        resolved = realpathSync(packageRequire.resolve(request))
      } catch (error) {
        throw new Error(
          GATE + ': ' + file + ' imports stylesheet ' + JSON.stringify(specifier) + ', which does not resolve from '
          + packageDirectory,
          { cause: error },
        )
      }
      dependencies.add(normalizePath(relative(realpathSync(root), resolved)))
    }
  }
  const stylesheets = [...imported].sort()
  const references = (files: readonly string[]): AssetReference[] => files.flatMap(file =>
    collectStylesheetAssetUrls(file, readFileSync(resolve(root, file), 'utf8'))
      .map(url => ({ file, reference: 'url(' + JSON.stringify(url) + ')' })))
  return { stylesheets, references: [...references(stylesheets), ...references([...dependencies].sort())] }
}

/**
 * Collect the module specifiers one TypeScript source file references, at any nesting depth: import and export
 * declarations, `import()` expressions and types, `require` and Vitest module-mock calls, and `declare module` names.
 * String literals in other positions and comments are not references.
 * @param file - Repository-relative, `/`-separated path; a `.tsx` name selects the TSX parser.
 * @param source - Source text.
 * @returns The references in source order.
 */
export function collectModuleReferences(file: string, source: string): ModuleReference[] {
  const sourceFile = ts.createSourceFile(
    file, source, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
  const found: ModuleReference[] = []
  const add = (literal: ts.Node | undefined, kind: ModuleReference['kind']): void => {
    if (literal === undefined || !ts.isStringLiteralLike(literal)) return
    found.push({ file, line: sourceFile.getLineAndCharacterOfPosition(literal.getStart()).line + 1, module: literal.text, kind })
  }
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      add(node.moduleSpecifier, 'import')
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      add(node.moduleReference.expression, 'import')
    } else if (ts.isModuleDeclaration(node) && ts.isStringLiteral(node.name)) {
      add(node.name, 'augmentation')
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      add(node.argument.literal, 'import')
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression
      const vitestModuleCall = ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)
        && callee.expression.text === 'vi' && VITEST_MODULE_CALLS.has(callee.name.text)
      if (callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && callee.text === 'require') || vitestModuleCall) {
        add(node.arguments[0], 'import')
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return found
}

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
 * @param facts - Package modes, manifests, source uses, package-asset references, and platform module lists.
 * @returns Stable self-contained diagnostics.
 */
export function collectClientPackageViolations(facts: ClientPackageFacts): string[] {
  return [
    ...facts.malformed,
    ...collectModeViolations(facts),
    ...collectModuleViolations(facts),
    ...collectAssetViolations(facts),
    ...collectClientTypedRootViolations(facts),
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

  const baseline = baselineRequests(facts)
  for (const declaration of facts.declarations.filter(entry => entry.dynamic)) {
    const target = document(declaration.manifest)
    const dsh = isRecord(target.manifest.dsh) ? target.manifest.dsh : undefined
    const client = isRecord(dsh?.client) ? dsh.client : undefined
    if (client === undefined) continue
    target.changed = normalizeClientArray(client, 'inject', () => false) || target.changed
    target.changed = normalizeClientArray(
      client,
      'external',
      value => baseline(value) || rowPackageOf(value, new Set([declaration.name])) === declaration.name,
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
    // A dynamic row answers its package name in the module table once the immediately tier has loaded.
    const row = facts.declarations.find(entry => entry.dynamic && entry.name === specifier)
    if (row?.immediately === true) continue
    violations.push(
      PLATFORM_SOURCE + ': workspace platform module ' + JSON.stringify(specifier)
      + ' belongs to ' + owner + ', whose build does not use the staticLinked preset,'
      + ' and has no dsh.client row of the same package name with immediately: true',
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
  const baseline = baselineRequests(facts)
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
      if (baseline(specifier)) {
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
        // The iframe provider shares the registry's Realm error identity; this is an infrastructure edge, not UI composition.
        const realmProvider = pkg.name === '@deepseek-ai/dsh-client-script-realm-iframe'
          && specifier === '@deepseek-ai/dsh-client-script-realm/client'
        if (pkg.manifest.startsWith(CLIENT_FEATURE_PREFIX) && !isInfrastructureRow(byName.get(supplier)) && !realmProvider) {
          violations.push(
            pkg.manifest + ': client feature package requests runtime external ' + JSON.stringify(specifier)
            + '; request only rows under ' + INFRASTRUCTURE_PREFIX + ', import shared types only,'
            + ' or call an injected Cordis service',
          )
          continue
        }
        // The build leaves both `<specifier>` and `<specifier>/client` imports to the requested row.
        if (pkg.runtimeSourceSpecifiers[specifier] === undefined
          && pkg.runtimeSourceSpecifiers[specifier + '/client'] === undefined) {
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

/**
 * Whether a supplier row belongs to the Remote API infrastructure group.
 * @param supplier - declaration that answers the requested specifier.
 * @returns true for a package whose manifest lies under `packages/api/`.
 */
function isInfrastructureRow(supplier: ClientDeclaration | undefined): boolean {
  return supplier !== undefined && supplier.manifest.startsWith(INFRASTRUCTURE_PREFIX)
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

/** Whether the dynamic build preset builds this package's browser face, the only face that emits package assets. */
function buildsDynamicWebClient(declaration: ClientDeclaration): boolean {
  return declaration.dynamic && declaration.platform === 'web'
}

function collectAssetViolations(facts: ClientPackageFacts): string[] {
  const violations: string[] = []
  const exportKey = 'exports[' + JSON.stringify(PACKAGE_ASSET_EXPORT) + ']'
  for (const pkg of facts.declarations) {
    const declared = pkg.assetExport !== undefined
    const covered = buildsDynamicWebClient(pkg)
    if (declared && pkg.assetExport !== PACKAGE_ASSET_EXPORT_TARGET) {
      violations.push(
        pkg.manifest + ': ' + exportKey + ' is ' + JSON.stringify(pkg.assetExport)
        + '; it must be exactly ' + JSON.stringify(PACKAGE_ASSET_EXPORT_TARGET),
      )
    }
    if (declared && !covered) {
      violations.push(
        pkg.manifest + ': ' + pkg.name + ' declares ' + exportKey + ' without a dsh.client row for platform "web";'
        + ' only dynamic Web Client packages publish package assets',
      )
    }
    if (!covered) continue
    const first = pkg.assetReferences[0]
    if (!declared && first !== undefined) {
      violations.push(
        pkg.manifest + ': ' + pkg.name + ' references package asset ' + first.reference + ' in ' + first.file
        + ' but declares no ' + exportKey + '; add ' + JSON.stringify(PACKAGE_ASSET_EXPORT) + ': '
        + JSON.stringify(PACKAGE_ASSET_EXPORT_TARGET) + ' and publish ' + JSON.stringify(PACKAGE_ASSET_FILES_ENTRY),
      )
    } else if (declared && first === undefined) {
      violations.push(
        pkg.manifest + ': ' + pkg.name + ' declares an unused ' + PACKAGE_ASSET_EXPORT + ' export;'
        + ' no Client source or stylesheet it imports references a package asset',
      )
    }
  }
  return violations
}

/**
 * Reject repository references that name the package root of a workspace package whose root reuses the `./client`
 * declarations; repository code names its `/client` subpath for values, types, and augmentations. Such a package root
 * is published with the `./client` declarations for code outside the repository, but in the repository it resolves to
 * the Host entry under `src/`, which carries neither the `/client` exports nor their declarations.
 * @param facts - The client-typed roots and the references to them in repository sources.
 * @returns One diagnostic per package-root reference.
 */
function collectClientTypedRootViolations(facts: ClientPackageFacts): string[] {
  return facts.clientTypedRootReferences.flatMap(({ file, line, module, kind }) => {
    if (!facts.clientTypedRoots.has(module)) return []
    return [
      file + ':' + String(line) + ': ' + (kind === 'augmentation' ? 'declare module ' : 'module reference ')
      + JSON.stringify(module) + ' names the package root; repository code names ' + JSON.stringify(module + '/client')
      + ' for values, types, and augmentations. The package publishes its ./client declarations as the root types for'
      + ' code outside the repository, but in this repository the package root resolves to the Host entry under src/,'
      + ' which carries neither the /client exports nor their declarations.',
    ]
  })
}

/**
 * Whether a manifest's root `types` export is its `./client` declarations, as for a package whose root runtime is only a
 * Host entry.
 * @param manifest - Parsed `package.json`.
 * @returns True when `exports["."].types` and `exports["./client"].types` name the same file.
 */
export function reusesClientTypes(manifest: { readonly exports?: unknown }): boolean {
  if (!isRecord(manifest.exports)) return false
  const rootEntry = manifest.exports['.']
  const clientEntry = manifest.exports['./client']
  const rootTypes = isRecord(rootEntry) ? rootEntry.types : undefined
  const clientTypes = isRecord(clientEntry) ? clientEntry.types : undefined
  return typeof clientTypes === 'string' && rootTypes === clientTypes
}

/**
 * Read the workspace packages whose root reuses the `./client` declarations.
 * @param root - Absolute repository root.
 * @returns Package names.
 */
function readClientTypedRoots(root: string): ReadonlySet<string> {
  const names = new Set<string>()
  for (const path of globSync(MANIFEST_GLOBS, { cwd: root })) {
    const manifest = JSON.parse(readFileSync(resolve(root, path), 'utf8')) as Manifest
    if (typeof manifest.name === 'string' && reusesClientTypes(manifest)) names.add(manifest.name)
  }
  return names
}

interface Manifest {
  name?: unknown
  dsh?: unknown
  exports?: unknown
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
  const assetExport = isRecord(manifest.exports) ? manifest.exports[PACKAGE_ASSET_EXPORT] : undefined
  const rowless = {
    name: manifest.name, manifest: manifestPath, dynamic: false, platform: undefined, immediately: false,
    external: [], inject: [],
    runtimeSourceUses: {}, runtimeSourceSpecifiers: {}, assetExport, assetReferences: [],
  } satisfies ClientDeclaration
  if (rawClient === undefined) return rowless
  if (!isRecord(rawClient)) {
    malformed.push(manifestPath + ': ' + manifest.name + ' dsh.client must be an object')
    return rowless
  }
  return {
    name: manifest.name,
    manifest: manifestPath,
    dynamic: true,
    platform: typeof rawClient.platform === 'string' ? rawClient.platform : undefined,
    immediately: rawClient.immediately === true,
    external: stringArray(rawClient.external, manifest.name, manifestPath, 'external', malformed),
    inject: stringArray(rawClient.inject, manifest.name, manifestPath, 'inject', malformed),
    runtimeSourceUses: {},
    runtimeSourceSpecifiers: {},
    assetExport,
    assetReferences: [],
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

/**
 * Read the references to the given packages and their `/client` subpaths in the tracked and untracked, not ignored,
 * TypeScript sources outside `vendor/` and the external consumer fixtures.
 * @param root - Absolute repository root.
 * @param packages - Package names whose references to read.
 * @returns The references, by file and then line.
 */
function readPackageReferences(root: string, packages: ReadonlySet<string>): ModuleReference[] {
  const listing = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  const found: ModuleReference[] = []
  for (const entry of listing.split('\0')) {
    const file = normalizePath(entry)
    if (file === '' || file.startsWith('vendor/') || file.startsWith(EXTERNAL_CONSUMER_FIXTURES)) continue
    if (!TYPESCRIPT_SOURCE.test(file)) continue
    let source: string
    try {
      source = readFileSync(resolve(root, file), 'utf8')
    } catch (error: unknown) {
      // A file deleted in the working tree is still listed until the deletion is staged.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      continue
    }
    if (![...packages].some(name => source.includes(name))) continue
    found.push(...collectModuleReferences(file, source).filter(reference => packages.has(stripClientSuffix(reference.module))))
  }
  return found
}

async function readFacts(root: string): Promise<ClientPackageFacts> {
  const { declarations: bareDeclarations, malformed } = readClientDeclarations(root)
  const staticLinkedPackages = await readStaticLinkedRoster(root)
  const project = new TypeScriptProject(root, 'client')
  const sourceFiles = project.sourceFiles()
  let webStylesheets = 0
  const declarations = bareDeclarations.map((declaration): ClientDeclaration => {
    const runtimeSourceUses = new Map<string, Set<string>>()
    const runtimeSourceSpecifiers = new Map<string, Set<string>>()
    const assetReferences: AssetReference[] = []
    const scansAssets = buildsDynamicWebClient(declaration)
    const importers = new Map<string, ReadonlySet<string>>()
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
      if (!scansAssets) continue
      const localSpecifiers = collectSourceFileUses(sourceFile, true, 'local')
      const bareStylesheets = [...collectSourceFileUses(sourceFile, true, 'specifier')]
        .filter(specifier => STYLESHEET_REQUEST.test(specifier))
      importers.set(file, new Set([...localSpecifiers, ...bareStylesheets]))
      for (const specifier of localSpecifiers) {
        if (isAssetSpecifier(specifier)) assetReferences.push({ file, reference: JSON.stringify(specifier) })
      }
    }
    if (scansAssets) {
      // A Web row always has a browser half, so an empty source set means the Client program stopped covering it.
      if (importers.size === 0) {
        throw new Error(
          GATE + ': the Client program loads no source under ' + sourcePrefix + ' for dynamic Web row '
          + declaration.name + '; its package-asset references cannot be read',
        )
      }
      const stylesheets = readStylesheetAssetReferences(root, dirname(declaration.manifest), importers)
      webStylesheets += stylesheets.stylesheets.length
      assetReferences.push(...stylesheets.references)
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
      assetReferences: assetReferences.sort((left, right) =>
        left.file.localeCompare(right.file) || left.reference.localeCompare(right.reference)),
    }
  })
  if (webStylesheets === 0) {
    throw new Error(GATE + ': no dynamic Web row imports a stylesheet from its src/ directory; the stylesheet scan read an empty corpus')
  }
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

  const clientTypedRoots = readClientTypedRoots(root)
  return {
    packages,
    declarations,
    staticLinkedPackages,
    platformModules: readStringLiteralArray(root, PLATFORM_SOURCE, 'PLATFORM_MODULES'),
    preloadedExternals: readStringLiteralArray(root, PLATFORM_SOURCE, 'PRELOADED_CLIENT_EXTERNALS'),
    parserPreloadIds: readStringLiteralArray(root, PARSER_PRELOAD_SOURCE, 'PARSER_PRELOAD_IDS'),
    clientTypedRoots,
    clientTypedRootReferences: readPackageReferences(root, clientTypedRoots),
    malformed,
  }
}

function packageNameOf(specifier: string): string {
  const segments = specifier.split('/')
  return segments.slice(0, specifier.startsWith('@') ? 2 : 1).join('/')
}

/**
 * Whether a specifier is a request every dynamic bundle already makes: a baseline module, or its `/client` subpath,
 * which the build preset and the module table resolve to the same entry.
 * @param facts - Platform module lists.
 * @returns The predicate over declared `dsh.client.external` specifiers.
 */
function baselineRequests(facts: ClientPackageFacts): (specifier: string) => boolean {
  const baseline = new Set([...facts.platformModules, ...facts.preloadedExternals])
  return specifier => baseline.has(specifier) || baseline.has(stripClientSuffix(specifier))
}

function rowNames(declarations: readonly ClientDeclaration[]): Set<string> {
  return new Set(declarations.filter(entry => entry.dynamic).map(entry => entry.name))
}

function rowPackageOf(specifier: string, rows: ReadonlySet<string>): string | undefined {
  if (rows.has(specifier)) return specifier
  const stripped = stripClientSuffix(specifier)
  return rows.has(stripped) ? stripped : undefined
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
  // The three `immediately` Client packages reuse their ./client declarations at the root, and repository code augments
  // them in many files; an empty package set or no augmentation means a manifest or the source scan read nothing.
  if (facts.clientTypedRoots.size === 0) {
    console.error(GATE + ': no workspace package root reuses its ./client declarations, so the /client spelling rule'
      + ' has no package to check')
    process.exit(1)
  }
  const augmentations = facts.clientTypedRootReferences.filter(reference => reference.kind === 'augmentation').length
  if (augmentations === 0) {
    console.error(GATE + ': the module-reference scan found no declare module of '
      + [...facts.clientTypedRoots].map(name => name + '/client').join(', '))
    process.exit(1)
  }

  const dynamic = facts.packages.filter(pkg => pkg.dynamic).length
  const requests = facts.declarations.reduce((total, pkg) => total + pkg.external.length, 0)
  const assetExports = facts.declarations.filter(pkg => pkg.assetExport !== undefined).length
  console.log(
    GATE + ': ' + String(facts.packages.length) + ' client packages (' + String(dynamic) + ' dynamic, '
    + String(facts.packages.length - dynamic) + ' statically linked) satisfy package-mode, module-request, '
    + 'package-asset, and /client spelling rules; ' + String(requests) + ' explicit external request(s), '
    + String(assetExports) + ' package-asset export(s), ' + String(facts.clientTypedRootReferences.length)
    + ' /client reference(s) to ' + String(facts.clientTypedRoots.size) + ' package(s) whose root reuses the ./client'
    + ' declarations, ' + String(augmentations) + ' of them augmentations.',
  )
}

if (process.argv[1] !== undefined && import.meta.filename === resolve(process.argv[1])) {
  await main()
}
