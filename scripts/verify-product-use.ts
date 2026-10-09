/** Check that maintained packages have effective product use or an explicit non-default role. */

import { existsSync, globSync, readFileSync, statSync } from 'node:fs'
import { dirname, extname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'
import ts from 'typescript'
import { applyEntryPatches, type PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import { bundlePatchPaths, composeEntries, loadOverlayPatches } from '../packages/boot/app-boot/src/index.ts'
import type { DshBundleManifest } from '../packages/util/package-manifest/src/types.ts'
import { assertNever } from '../packages/util/values/src/index.ts'
import { isAgentPresetEntry, isCordisGroupEntry, loadCordisYaml } from './cordis-yaml.ts'
import { PRODUCT_PACKAGE_POLICY, type ProductPackagePolicy } from './product-package-policy.ts'
import { collectRuntimeLocalSourceSpecifiers, collectRuntimeSourceSpecifiers } from './verify-client-packages.ts'

const PROFILE_SOURCE = 'packages/boot/app-boot/src/profile.ts'
const ON_DEMAND_SOURCE = 'packages/boot/app-boot/src/official-bundle-packages.ts'
const PROFILES = ['acp', 'web', 'headless', 'sdk', 'sdk-minimal']
const PICKER_SOURCE = 'packages/host/directory-picker-auto/src/index.ts'
const DYNAMIC_MOUNTS: Readonly<Record<string, readonly string[]>> = {
  [PICKER_SOURCE]: ['BACKEND_PACKAGES', 'SURFACE_PACKAGES'],
}

interface Package {
  directory: string
  name: string
  bundle?: DshBundleManifest
  client: boolean
  generatedRemote: boolean
}

interface Reachability {
  packages: Set<string>
  sources: Set<string>
}

/** Effective runtime package use, with explicit selections separated from shipped defaults. */
export interface ProductUseResult {
  /** Violations name the package and the required correction. */
  failures: string[]
  /** Repository-relative package directories reached by a default product entry. */
  defaultPackages: string[]
  /** Repository-relative package directories reached only after optional selection. */
  optionalPackages: string[]
  /** Workspace packages inventoried, including experimental packages and app roots. */
  packageCount: number
  /** Distinct source modules reached across both selections. */
  sourceCount: number
  /** Effective compositions read, including Include files. */
  configCount: number
}

/**
 * Verify effective product composition and source imports without reading built workspace outputs.
 * @param root - Repository root with source mappings and shipped profile declarations.
 * @param policy - Explicit non-default roles; defaults to the repository-owned policy.
 * @returns Default/optional reachability and every undeclared or stale package-policy violation.
 */
export function verifyProductUse(
  root: string, policy: Readonly<Record<string, ProductPackagePolicy>> = PRODUCT_PACKAGE_POLICY,
): ProductUseResult {
  const failures: string[] = []
  const display = (path: string): string => relative(root, path).replaceAll('\\', '/')
  const packages = new Map<string, Package>()
  const directories = new Map<string, Package>()
  const configs = new Set<string>()
  const defaults: Reachability = { packages: new Set(), sources: new Set() }
  const optional: Reachability = { packages: new Set(), sources: new Set() }
  const config = ts.readConfigFile(resolve(root, 'tsconfig.base.json'), path => ts.sys.readFile(path))
  if (config.error !== undefined) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'))
  const converted = ts.convertCompilerOptionsFromJson(
    (config.config as { compilerOptions?: unknown }).compilerOptions, root,
  )
  if (converted.errors.length > 0) throw new Error(converted.errors.map(error => ts.flattenDiagnosticMessageText(error.messageText, '\n')).join('\n'))
  const host: ts.ModuleResolutionHost = { ...ts.sys, getCurrentDirectory: () => root }
  const resolutionCache = ts.createModuleResolutionCache(root, path => path, converted.options)
  for (const path of globSync(['apps/*/package.json', 'packages/*/*/package.json', 'vendor/*/package.json'], { cwd: root }).map(path => path.replaceAll('\\', '/')).sort()) {
    const manifest = JSON.parse(readFileSync(resolve(root, path), 'utf8')) as {
      name: string
      exports?: Record<string, unknown>
      dsh?: { bundle?: DshBundleManifest; client?: unknown }
    }
    if (typeof manifest.name !== 'string' || manifest.name === '') throw new Error(`${path}: missing package name`)
    if (packages.has(manifest.name)) throw new Error(`${path}: duplicate package name ${manifest.name}`)
    const remote = manifest.exports?.['./remote']
    const pkg: Package = { directory: dirname(path), name: manifest.name, client: manifest.dsh?.client !== undefined,
      generatedRemote: isRecord(remote) && remote.default === './lib/typert.remote-client.js'
        && remote.types === './lib/typert.remote-client.d.ts',
      ...(manifest.dsh?.bundle === undefined ? {} : { bundle: manifest.dsh.bundle }) }
    packages.set(pkg.name, pkg)
    directories.set(resolve(root, pkg.directory), pkg)
  }
  if (packages.size === 0) failures.push('no workspace packages found; restore the package inventory')
  const ownerOf = (path: string): Package | undefined => {
    for (let dir = dirname(path); dir !== dirname(dir); dir = dirname(dir)) {
      const pkg = directories.get(dir)
      if (pkg !== undefined) return pkg
    }
    return undefined
  }
  const resolveModule = (specifier: string, from: string): string | undefined => {
    const resolved = ts.resolveModuleName(specifier, from, converted.options, host, resolutionCache).resolvedModule
    if (resolved === undefined || resolved.resolvedFileName.replaceAll('\\', '/').includes('/node_modules/')) return undefined
    const path = resolve(resolved.resolvedFileName)
    if (/(?:^|\/)lib\//.test(display(path)) || path.endsWith('.d.ts')) return undefined
    return path
  }
  const scanSource = (path: string, reach: Reachability): void => {
    if (reach.sources.has(path)) return
    if (!existsSync(path)) { failures.push(`${display(path)}: missing product source entry`); return }
    reach.sources.add(path)
    const owner = ownerOf(path)
    if (owner !== undefined) reach.packages.add(owner.directory)
    const source = readFileSync(path, 'utf8')
    for (const specifier of collectRuntimeSourceSpecifiers(path, source)) reference(specifier, path, reach)
    for (const specifier of collectRuntimeLocalSourceSpecifiers(path, source, true)) {
      const resolved = specifier.startsWith('/')
        ? sourceFile(resolve(root, 'apps/web', `.${specifier}`)) : resolveModule(specifier, path)
      if (resolved !== undefined) scanSource(resolved, reach)
      else if (/\.[cm]?[jt]sx?$/.test(specifier)) failures.push(`${display(path)}: source import ${specifier} does not resolve to source`)
    }
    const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true)
    const visit = (node: ts.Node): void => {
      if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'URL') {
        const first = node.arguments?.[0]
        const base = node.arguments?.[1]
        if (first !== undefined && ts.isStringLiteralLike(first) && first.text.startsWith('.')
          && base?.getText(file) === 'import.meta.url') {
          const target = sourceFile(resolve(dirname(path), first.text))
          if (target !== undefined) scanSource(target, reach)
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(file)
    for (const declaration of DYNAMIC_MOUNTS[display(path)] ?? []) {
      const value = literalDeclaration(file, declaration)
      if (!isRecord(value) || Object.keys(value).length === 0 || !Object.values(value).every(item => typeof item === 'string')) {
        failures.push(`${display(path)}: dynamic mount ${declaration} must declare literal package targets`)
        continue
      }
      for (const target of Object.values(value)) if (typeof target === 'string') mount(target, path, reach)
    }
  }
  const reference = (specifier: string, from: string, reach: Reachability): void => {
    if (specifier.startsWith('cordis:')) return
    const normalized = specifier.startsWith('file:') ? fileURLToPath(specifier) : specifier
    const name = /^(?:@[^/]+\/)?[^/]+/.exec(specifier)?.[0] ?? specifier
    const pkg = packages.get(name)
    if (pkg !== undefined) reach.packages.add(pkg.directory)
    // Typert Remote contributions contain generated descriptors and external codecs, with no workspace runtime imports.
    if (pkg?.generatedRemote && specifier === `${pkg.name}/remote`) return
    const target = resolveModule(normalized, from)
    if (target !== undefined) scanSource(target, reach)
    else if (pkg !== undefined && !/\.(?:json|css|svg|ya?ml)$/.test(specifier)) {
      failures.push(`${display(from)}: ${specifier} does not resolve to workspace source; add a tsconfig.base.json paths mapping`)
    } else if (pkg === undefined && specifier.startsWith('@deepseek-ai/dsh-')) {
      failures.push(`${display(from)}: unknown workspace package ${specifier}`)
    }
  }
  const mount = (specifier: string, from: string, reach: Reachability): void => {
    reference(specifier, from, reach)
    const pkg = packages.get(specifier)
    if (pkg?.client) reference(`${specifier}/client`, from, reach)
  }
  const scanEntries = (entries: readonly unknown[], from: string, reach: Reachability, stack: ReadonlySet<string> = new Set()): void => {
    for (const row of entries) {
      if (!isRecord(row) || row.disabled === true) continue
      if (typeof row.name === 'string') mount(row.name, from, reach)
      if (isCordisGroupEntry(row) || row.name === 'cordis:group' && Array.isArray(row.config)) {
        scanEntries(row.config as unknown[], from, reach, stack)
      }
      if (isAgentPresetEntry(row)) scanEntries(row.config.plugins, from, reach, stack)
      if ((row.name !== '@deepseek-ai/cordis-plugin-include' && row.name !== 'cordis:include') || !isRecord(row.config)) continue
      const path = row.config.path
      if (typeof path !== 'string') { failures.push(`${display(from)}: Include path must be a literal string`); continue }
      const filename = path.startsWith('file:') ? fileURLToPath(path) : resolve(dirname(from), path)
      if (stack.has(filename)) { failures.push(`${display(from)}: cyclic Include ${display(filename)}`); continue }
      const content: unknown = existsSync(filename) ? loadCordisYaml(readFileSync(filename, 'utf8')) : row.config.initial
      configs.add(filename)
      if (!Array.isArray(content)) { failures.push(`${display(filename)}: Include requires an entry array or initial entries`); continue }
      const entries = applyEntryPatches(content as EntryOptions[], row.config.patches as PatchOptions[] | undefined, () => {})
      scanEntries(entries, filename, reach, new Set([...stack, filename]))
    }
  }
  const profilePath = resolve(root, PROFILE_SOURCE)
  const profileFile = ts.createSourceFile(profilePath, readFileSync(profilePath, 'utf8'), ts.ScriptTarget.Latest, true)
  const templates = literalDeclaration(profileFile, 'PROFILE_TEMPLATES')
  const fallback = stringList(literalDeclaration(profileFile, 'DEFAULT_PROFILE_BUNDLES'), PROFILE_SOURCE)
  const catalogPath = resolve(root, ON_DEMAND_SOURCE)
  const catalogFile = ts.createSourceFile(catalogPath, readFileSync(catalogPath, 'utf8'), ts.ScriptTarget.Latest, true)
  const optionals = [
    ...stringList(literalDeclaration(profileFile, 'OPTIONAL_BUNDLES'), PROFILE_SOURCE),
    ...stringList(literalDeclaration(catalogFile, 'ON_DEMAND_BUNDLES'), ON_DEMAND_SOURCE),
  ]
  if (!isRecord(templates)) throw new Error(`${PROFILE_SOURCE}: PROFILE_TEMPLATES must be a literal object`)
  for (const name of PROFILES) if (!isRecord(templates[name])) failures.push(`${PROFILE_SOURCE}: missing shipped ${name} profile`)
  const layers = (names: readonly string[], reach: Reachability): PatchOptions[][] => names.flatMap((name) => {
    const pkg = packages.get(name)
    if (pkg?.bundle === undefined) { failures.push(`${PROFILE_SOURCE}: ${name} must declare dsh.bundle.patch`); return [] }
    reach.packages.add(pkg.directory)
    return [bundlePatchPaths(resolve(root, pkg.directory), pkg.bundle).flatMap((path) => {
      configs.add(path)
      return loadOverlayPatches('verify-product-use', path)
    })]
  })
  const profiles = [...Object.entries(templates).map(([name, value]) => {
    if (!isRecord(value)) throw new Error(`${PROFILE_SOURCE}: invalid ${name} profile`)
    return stringList(value.bundles, `${PROFILE_SOURCE} ${name}`)
  }), fallback]
  for (const names of profiles) {
    if (names.length === 0) failures.push(`${PROFILE_SOURCE}: shipped profile has no bundles`)
    scanEntries(composeEntries(layers(names, defaults)), profilePath, defaults)
  }
  const web = templates.web
  if (isRecord(web)) {
    const webBundles = stringList(web.bundles, `${PROFILE_SOURCE} web`)
    for (const bundle of optionals) scanEntries(composeEntries(layers([...webBundles, bundle], optional)), profilePath, optional)
  }
  for (const path of ['apps/cli/src/bin.ts', 'apps/desktop/src/main.ts']) scanSource(resolve(root, path), defaults)
  const htmlPath = resolve(root, 'apps/web/index.html')
  const dom = new JSDOM(readFileSync(htmlPath, 'utf8'))
  try {
    const scripts = [...dom.window.document.querySelectorAll('script[type="module"]')]
    if (scripts.length === 0) failures.push('apps/web/index.html: missing product module entry')
    for (const script of scripts) {
      const path = script.getAttribute('src')
      if (path === null || /^(?:https?:)?\/\//.test(path)) {
        failures.push('apps/web/index.html: product module entries must name local source files')
      } else scanSource(resolve(root, 'apps/web', path.replace(/^\//, '')), defaults)
    }
  } finally { dom.window.close() }
  for (const [path, entry] of Object.entries(policy)) {
    const pkg = directories.get(resolve(root, path))
    if (!/^packages\/[^/]+\/[^/]+$/.test(path) || path.startsWith('packages/experimental/') || pkg === undefined) {
      failures.push(`${path}: stale package policy; remove the missing or ineligible directory`)
      continue
    }
    if (entry.reason.trim() === '') failures.push(`${path} (${pkg.name}): package policy requires a reason`)
    if (!validCategory(path, entry.category)) failures.push(`${path} (${pkg.name}): invalid policy category ${entry.category}`)
    if (entry.category !== 'web-distribution' && defaults.packages.has(path)) {
      failures.push(`${path} (${pkg.name}): stale ${entry.category} policy; default runtime use requires removing this declaration`)
    }
    if (entry.category === 'web-distribution' && !defaults.packages.has(path)) {
      failures.push(`${path} (${pkg.name}): stale web-distribution policy; restore its product source entry or correct its role`)
    }
  }
  for (const pkg of packages.values()) {
    if (!pkg.directory.startsWith('packages/') || pkg.directory.startsWith('packages/experimental/')) continue
    if (!defaults.packages.has(pkg.directory) && !optional.packages.has(pkg.directory) && policy[pkg.directory] === undefined) {
      failures.push(`${pkg.directory} (${pkg.name}): no product runtime use; mount it, declare its maintained role, or move it to experimental`)
    }
  }
  return { failures: [...new Set(failures)].sort(), defaultPackages: [...defaults.packages].sort(),
    optionalPackages: [...optional.packages].filter(path => !defaults.packages.has(path)).sort(), packageCount: packages.size,
    sourceCount: new Set([...defaults.sources, ...optional.sources]).size, configCount: configs.size }
}

function validCategory(path: string, category: ProductPackagePolicy['category']): boolean {
  switch (category) {
    case 'optional': return !path.startsWith('packages/test-support/')
    case 'test': return path.startsWith('packages/test-support/')
    case 'sdk': return path === 'packages/sdk/client'
    case 'build': return path === 'packages/typert/generator'
    case 'web-distribution': return path === 'packages/client/web' || path === 'packages/client/ui-dockkit'
    case 'declarations': return path === 'packages/util/package-manifest'
    default: return assertNever(category)
  }
}

function sourceFile(path: string): string | undefined {
  if (!/\.[cm]?[jt]sx?$/.test(path)) return undefined
  const stem = path.slice(0, -extname(path).length)
  return [path, `${stem}.ts`, `${stem}.tsx`, `${stem}.mts`, `${stem}.cts`]
    .find(candidate => existsSync(candidate) && statSync(candidate).isFile() && !candidate.endsWith('.d.ts'))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringList(value: unknown, origin: string): string[] {
  if (!Array.isArray(value) || !value.every((item: unknown) => typeof item === 'string')) throw new Error(`${origin}: expected a literal package list`)
  return value
}

function literalDeclaration(file: ts.SourceFile, name: string): unknown {
  const read = (node: ts.Expression): unknown => {
    if (ts.isStringLiteralLike(node)) return node.text
    if (ts.isArrayLiteralExpression(node)) return node.elements.map(read)
    if (ts.isObjectLiteralExpression(node)) return Object.fromEntries(node.properties.map((property) => {
      if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name) && !ts.isStringLiteralLike(property.name)) {
        throw new Error(`${file.fileName}: ${name} requires literal properties`)
      }
      return [property.name.text, read(property.initializer)]
    }))
    if (ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isParenthesizedExpression(node)) return read(node.expression)
    throw new Error(`${file.fileName}: ${name} requires literal package declarations`)
  }
  for (const statement of file.statements) {
    if (!ts.isVariableStatement(statement)) continue
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === name && declaration.initializer !== undefined) {
        return read(declaration.initializer)
      }
    }
  }
  throw new Error(`${file.fileName}: missing ${name} declaration`)
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = verifyProductUse(resolve(dirname(fileURLToPath(import.meta.url)), '..'))
  for (const failure of result.failures) console.error(failure)
  if (result.failures.length > 0) process.exitCode = 1
  else console.log(`Product use: ${String(result.defaultPackages.length)} default, ${String(result.optionalPackages.length)} optional packages; ${String(result.sourceCount)} source modules.`)
}
