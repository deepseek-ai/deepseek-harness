/** Embed package-owned display metadata for Official bundles whose providers install on demand. */

import { globSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'
import type { DshBundleManifest, LocalizedText } from '../packages/util/package-manifest/src/types.ts'
import { ON_DEMAND_BUNDLES } from '../packages/util/official-bundles/src/bundles.ts'
import type { OfficialBundleCatalogEntry } from '../packages/util/official-bundles/src/index.ts'
import { readPluginMeta, resolvePluginResource } from '../packages/boot/app-boot/src/package-meta.ts'
import { assertBundlePlatform, UnsupportedBundlePlatformError } from '../packages/boot/app-boot/src/bundle-platform.ts'

import { SHIPPED_LOCALE_IDS } from './shipped-locales.ts'

const OUTPUT = 'packages/util/official-bundles/src/catalog.generated.ts'

/**
 * Read complete metadata without importing or activating any provider code.
 * @param root - Repository root containing the catalog's public packages.
 * @param names - Catalog admission list; defaults to the installation-owned list.
 * @returns Offline entries in admission order, with metadata from the owning packages.
 */
export function generateOfficialBundleCatalog(root: string, names: readonly string[] = ON_DEMAND_BUNDLES): OfficialBundleCatalogEntry[] {
  if (names.length === 0 || new Set(names).size !== names.length) throw new Error('Official on-demand catalog must contain distinct package names')
  const manifests = new Map<string, { path: string; private: boolean; bundle: boolean; platforms?: DshBundleManifest['platforms']; listedByDefault?: boolean; runtime: string[] }>()
  for (const path of globSync(['packages/*/*/package.json', 'apps/*/package.json', 'vendor/*/package.json'], { cwd: root }).map(path => path.replaceAll('\\', '/')).sort()) {
    const manifest = JSON.parse(readFileSync(resolve(root, path), 'utf8')) as {
      name: string
      private?: boolean
      dependencies?: Record<string, string>
      optionalDependencies?: Record<string, string>
      peerDependencies?: Record<string, string>
      dsh?: { bundle?: { patch?: unknown; platforms?: DshBundleManifest['platforms']; listedByDefault?: boolean } }
    }
    if (manifests.has(manifest.name)) throw new Error(`duplicate workspace package ${manifest.name}`)
    const listedByDefault = manifest.dsh?.bundle?.listedByDefault
    if (listedByDefault !== undefined && typeof listedByDefault !== 'boolean') throw new Error(`${manifest.name}: dsh.bundle.listedByDefault must be a boolean`)
    const runtime = ['dependencies', 'optionalDependencies', 'peerDependencies'] as const
    manifests.set(manifest.name, { path, private: manifest.private === true, bundle: manifest.dsh?.bundle?.patch !== undefined,
      ...manifest.dsh?.bundle?.platforms === undefined ? {} : { platforms: manifest.dsh.bundle.platforms },
      ...listedByDefault === undefined ? {} : { listedByDefault },
      runtime: runtime.flatMap(section => Object.keys(manifest[section] ?? {})) })
  }
  const visited = new Set<string>()
  const checkInstallation = (name: string): void => {
    if (visited.has(name)) return
    visited.add(name)
    if (names.includes(name)) throw new Error(`${name}: on-demand providers must not be installed by the DSH distribution`)
    for (const dependency of manifests.get(name)?.runtime ?? []) checkInstallation(dependency)
  }
  if (!manifests.has('@deepseek-ai/dsh')) throw new Error('Official catalog requires the DSH installation manifest')
  checkInstallation('@deepseek-ai/dsh')
  return names.map((packageName) => {
    const entry = manifests.get(packageName)
    if (entry === undefined || !entry.path.startsWith('packages/') || !packageName.startsWith('@deepseek-ai/dsh-') || entry.private || !entry.bundle) {
      throw new Error(`${packageName}: Official catalog entries must be public DSH bundle packages`)
    }
    try { assertBundlePlatform(entry.platforms, process.platform) } catch (error) {
      // Catalog generation validates every declaration, including bundles for another Host.
      if (!(error instanceof UnsupportedBundlePlatformError)) throw error
    }
    const parentURL = pathToFileURL(resolve(root, entry.path)).href
    for (const language of SHIPPED_LOCALE_IDS) {
      const file = resolvePluginResource(`${packageName}/locale/${language}.json`, parentURL)
      const dictionary = JSON.parse(readFileSync(file, 'utf8')) as { meta?: { title?: unknown; description?: unknown } }
      if (typeof dictionary.meta?.title !== 'string' || dictionary.meta.title.trim() === ''
        || typeof dictionary.meta.description !== 'string' || dictionary.meta.description.trim() === '') {
        throw new Error(`${packageName}: Official metadata requires explicit ${language} title and description`)
      }
    }
    const meta = readPluginMeta(packageName, parentURL)
    if (meta?.error !== undefined) throw new Error(`${packageName}: ${meta.error}`)
    if (meta?.icon === undefined || typeof meta.title !== 'object' || typeof meta.description !== 'object') {
      throw new Error(`${packageName}: Official catalog entries require an icon and localized title and description`)
    }
    for (const value of [meta.title, meta.description]) {
      for (const language of SHIPPED_LOCALE_IDS) {
        if (typeof value[language] !== 'string' || value[language].trim() === '') {
          throw new Error(`${packageName}: Official metadata requires ${language} text`)
        }
      }
    }
    return { packageName,
      ...entry.listedByDefault === undefined ? {} : { listedByDefault: entry.listedByDefault },
      ...entry.platforms === undefined ? {} : { platforms: entry.platforms },
      meta: { title: meta.title, description: meta.description, icon: meta.icon } }
  })
}

/**
 * Render a source-plane catalog with no package imports or pinned runtime version.
 * @param entries - Validated metadata in catalog order.
 * @returns Deterministic TypeScript source for the official-bundles generated module.
 */
export function renderOfficialBundleCatalog(entries: readonly OfficialBundleCatalogEntry[]): string {
  return '/** Generated offline Official bundle metadata. Run pnpm gen-official-bundle-catalog; do not edit. */\n\n'
    + "import type { OfficialBundleCatalogEntry } from './index.ts'\n\n"
    + '/** Official on-demand entries, independent of installed packages and registry availability. */\n'
    + 'export const OFFICIAL_ON_DEMAND_CATALOG: readonly OfficialBundleCatalogEntry[] = [\n'
    + entries.map(entry => '  {\n'
      + `    packageName: ${quote(entry.packageName)},\n`
      + (entry.platforms === undefined ? '' : `    platforms: [${entry.platforms.map(quote).join(', ')}],\n`)
      + (entry.listedByDefault === undefined ? '' : `    listedByDefault: ${entry.listedByDefault},\n`)
      + '    meta: {\n'
      + `      title: ${localized(entry.meta.title)},\n`
      + `      description: ${localized(entry.meta.description)},\n`
      + `      icon: ${quote(entry.meta.icon)},\n`
      + '    },\n  },\n').join('')
    + ']\n'
}

const printer = ts.createPrinter()
const sourceFile = ts.createSourceFile('catalog.ts', '', ts.ScriptTarget.Latest)

function quote(value: string): string {
  return printer.printNode(ts.EmitHint.Expression, ts.factory.createStringLiteral(value, true), sourceFile)
}

function localized(value: LocalizedText): string {
  if (typeof value === 'string') return quote(value)
  return `{ ${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([language, text]) => `${quote(language)}: ${quote(text)}`).join(', ')} }`
}

/**
 * Write changed metadata or freshness-check it against the owning package resources.
 * @param root - Repository root containing source and metadata resources.
 * @param check - Reject drift without changing the generated file.
 */
export function syncOfficialBundleCatalog(root: string, check: boolean): void {
  const source = renderOfficialBundleCatalog(generateOfficialBundleCatalog(root))
  const path = resolve(root, OUTPUT)
  let current: string | undefined
  try { current = readFileSync(path, 'utf8') }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  if (current === source) return
  if (check) throw new Error(`${OUTPUT} is stale; run pnpm gen-official-bundle-catalog`)
  writeFileSync(path, source)
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  syncOfficialBundleCatalog(resolve(import.meta.dirname, '..'), process.argv.includes('--check'))
  console.log('Official on-demand catalog matches package-owned metadata.')
}
