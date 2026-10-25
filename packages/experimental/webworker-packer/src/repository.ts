/**
 * Repository knowledge for the packer: where this tree's workspaces, installation
 * manifest, profile bundles, and config trees are, and how to report a pack.
 *
 * The library half takes all of this as parameters. Keeping the lookup here is what
 * lets the same library pack a different tree, and what keeps `pack.ts` free of
 * assumptions about pnpm workspaces or the `dsh` CLI.
 * @module @deepseek-ai/dsh-experimental-webworker-packer/src/repository
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import {
  bundlePatchPaths, composeEntries, loadOverlayPatches, resolveBundleDir,
} from '@deepseek-ai/dsh-app-boot'
import { OPTIONAL_BUNDLES, PROFILE_TEMPLATES } from '@deepseek-ai/dsh-official-bundles'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import { PLATFORM_ENTRY_CONFIG } from '@deepseek-ai/dsh-experimental-webworker-runtime'
import { collectModuleNames, packVfsImage, type ConfigTree, type ImageInstallation, type ImageTree, type PackResult } from './pack.ts'

export { packPreviewFixture } from './preview.ts'

/**
 * Repository directories scanned for workspace and vendored packages. The
 * image only ever materializes runtime packages, which live here. The Landlock
 * package family contributes its unchanged JavaScript entry from `native/`;
 * examples and python never occur on a roster's dependency chain.
 */
const WORKSPACE_SCAN_ROOTS = ['vendor', 'packages', 'native/system/packages', 'apps']

/** The `dsh` installation package: its manifest anchors bundle resolution, as the launcher's does. */
const CLI_PACKAGE = 'apps/cli'

/** Diagnostic prefix for the app-boot readers this module calls. */
const BIN_NAME = 'dsh-pack-vfs-image'

/** Repository-owned deterministic filesystem content offered by the preview. */
const PREVIEW_EXAMPLE_ROOT = 'packages/experimental/webworker-runtime/tests/fixtures/vfs-example'

/** Config directory metadata owned by the CLI image packer, not the public plugin manifest. */
interface ConfigTreeDeclaration {
  /** Non-empty destination path in the image; mount values must be unique. */
  mount: string
  /** Non-empty source directory path relative to the declaring package root. */
  path: string
  /** Include the directory's YAML plugin rows in the package roster; absent means false. */
  scanRoster?: boolean
}

/** One built-in Preview source and the trees packed into its overlay. */
export interface PreviewFixture {
  /** URL/query-safe identifier. */
  readonly id: string
  /** User-facing chooser label. */
  readonly label: string
  /** User-facing chooser detail. */
  readonly description: string
  /** Opaque trees packed into this fixture's overlay archive. */
  readonly trees: readonly ImageTree[]
}

/**
 * Index every workspace and vendored package by name.
 * @param repoRoot - Absolute repository root.
 * @returns Package name to absolute directory.
 */
export function indexWorkspacePackages(repoRoot: string): Map<string, string> {
  const index = new Map<string, string>()
  const visit = (directory: string): void => {
    const manifest = join(directory, 'package.json')
    if (existsSync(manifest)) {
      const name = (JSON.parse(readFileSync(manifest, 'utf8')) as { name?: unknown }).name
      if (typeof name === 'string') index.set(name, directory)
      // A package root owns its subtree; anything below (test fixtures,
      // nested manifests) is not a separate workspace package.
      return
    }
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      visit(join(directory, entry.name))
    }
  }
  for (const scanRoot of WORKSPACE_SCAN_ROOTS) {
    const absolute = join(repoRoot, scanRoot)
    if (existsSync(absolute)) visit(absolute)
  }
  return index
}

/** The bundles one image offers and the packages it must materialize for them. */
export interface ProfileRoster {
  /** The profile template's bundles, then the installation's optional bundles. */
  readonly bundles: readonly string[]
  /** Those bundle packages plus every package their patch rows name, deduplicated. */
  readonly roster: readonly string[]
}

/**
 * Read what one shipped profile offers from the installation the launcher boots:
 * the template's bundles and every optional bundle, each resolved from the CLI
 * manifest as the launcher resolves them, and the packages their patch files name.
 * Machine state never contributes, so the same tree always packs the same roster.
 * @param repoRoot - Absolute repository root.
 * @param profile - Shipped profile template name.
 * @returns Bundle names and the roster to materialize.
 * @throws When the profile has no shipped template, or a bundle does not resolve or declares no patch.
 */
export function profileRoster(repoRoot: string, profile: string): ProfileRoster {
  const template = shippedTemplate(profile)
  const bundles = [...new Set([...template.bundles, ...OPTIONAL_BUNDLES])]
  const names = new Set<string>(bundles)
  for (const bundle of bundles) collectModuleNames(bundlePatches(repoRoot, bundle), names)
  return { bundles, roster: [...names] }
}

/**
 * The home patch one shipped profile's image carries: every row `PLATFORM_ENTRY_CONFIG` names, with the config the
 * template's bundle layers compose for it and the Worker's required fields over that config. A patch replaces a row's
 * whole config, so the composed fields stay; the image carries the same bundle files read here.
 * @param repoRoot - Absolute repository root.
 * @param profile - Shipped profile template name.
 * @returns Home patch rows; a row the composition lacks contributes none.
 * @throws When the profile has no shipped template, or a bundle does not resolve or declares no patch.
 */
export function platformHomePatch(repoRoot: string, profile: string): PatchOptions[] {
  const composed: unknown = composeEntries([shippedTemplate(profile).bundles.flatMap(bundle => bundlePatches(repoRoot, bundle))])
  return Object.entries(PLATFORM_ENTRY_CONFIG).flatMap(([id, fields]) => {
    const row = findRow(composed, id)
    if (row === undefined) return []
    const config = typeof row.config === 'object' && row.config !== null && !Array.isArray(row.config) ? row.config : {}
    return [{ id, config: { ...config, ...fields } }]
  })
}

/** Find one Loader row by id, inside group configs too. */
function findRow(rows: unknown, id: string): { config?: unknown } | undefined {
  if (!Array.isArray(rows)) return undefined
  for (const row of rows as Array<{ id?: unknown; config?: unknown }>) {
    if (row.id === id) return row
    const nested = findRow(row.config, id)
    if (nested !== undefined) return nested
  }
  return undefined
}

/** The shipped template of one profile, or a refusal naming it. */
function shippedTemplate(profile: string): { readonly bundles: readonly string[] } {
  const template = Object.hasOwn(PROFILE_TEMPLATES, profile) ? PROFILE_TEMPLATES[profile] : undefined
  if (template === undefined) throw new Error(`vfs image: no shipped profile template named ${JSON.stringify(profile)}`)
  return template
}

/** One bundle's patch rows, resolved from the CLI manifest as the launcher resolves them. */
function bundlePatches(repoRoot: string, bundle: string): PatchOptions[] {
  const directory = resolveBundleDir(BIN_NAME, bundle, installationManifest(repoRoot).manifest, join(repoRoot, CLI_PACKAGE))
  const declaration = (JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as {
    dsh?: { bundle?: Parameters<typeof bundlePatchPaths>[1] }
  }).dsh?.bundle
  if (declaration === undefined) throw new Error(`vfs image: bundle ${bundle} declares no dsh.bundle`)
  return bundlePatchPaths(directory, declaration).flatMap(file => loadOverlayPatches(BIN_NAME, file))
}

/**
 * The installation manifest the image anchors bundle resolution at.
 * @param repoRoot - Absolute repository root.
 * @returns The CLI package name and its manifest path.
 */
export function installationManifest(repoRoot: string): ImageInstallation {
  const manifest = join(repoRoot, CLI_PACKAGE, 'package.json')
  const { name } = JSON.parse(readFileSync(manifest, 'utf8')) as { name: string }
  return { name, manifest }
}

/**
 * Pack this repository's base image for one shipped profile.
 * @param repoRoot - Absolute repository root.
 * @param profile - Shipped profile template name.
 * @param root - Virtual root; the runtime default when omitted.
 * @returns The packed image and its lazy archives.
 */
export function packRepositoryImage(repoRoot: string, profile: string, root?: string): PackResult {
  return packVfsImage({
    profile,
    roster: profileRoster(repoRoot, profile).roster,
    installation: installationManifest(repoRoot),
    ...root === undefined ? {} : { root },
    workspaces: indexWorkspacePackages(repoRoot),
    resolveFrom: repoRoot,
    configTrees: configTrees(repoRoot),
    homePatch: platformHomePatch(repoRoot, profile),
  })
}

/**
 * Config trees the CLI package declares for deployment images
 * (`dsh.configTrees` in its package.json): `path` is relative to the CLI
 * package root, `mount` is the image path, `scanRoster` feeds the tree's yml
 * plugin rows into the pack roster. The CLI owns its config layout; this
 * reader follows the declaration instead of naming directories. A malformed
 * declaration refuses the pack.
 * @param repoRoot - Absolute repository root.
 * @returns Trees with absolute source directories.
 */
export function configTrees(repoRoot: string): ConfigTree[] {
  const packageDir = join(repoRoot, CLI_PACKAGE)
  const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as {
    dsh?: { configTrees?: unknown }
  }
  const declared = manifest.dsh?.configTrees
  if (declared === undefined) return []
  if (!Array.isArray(declared)) {
    throw new Error(`vfs image: ${CLI_PACKAGE} dsh.configTrees must be an array`)
  }
  const mounts = new Set<string>()
  return declared.map((entry, index) => {
    const tree = entry as Partial<ConfigTreeDeclaration> | null
    const at = `${CLI_PACKAGE} dsh.configTrees[${String(index)}]`
    if (tree === null || typeof tree !== 'object'
      || typeof tree.mount !== 'string' || tree.mount === ''
      || typeof tree.path !== 'string' || tree.path === ''
      || (tree.scanRoster !== undefined && typeof tree.scanRoster !== 'boolean')) {
      throw new Error(`vfs image: ${at} must declare a string mount, a string path, and an optional boolean scanRoster`)
    }
    if (mounts.has(tree.mount)) {
      throw new Error(`vfs image: ${at} repeats mount ${JSON.stringify(tree.mount)}`)
    }
    mounts.add(tree.mount)
    return {
      mount: tree.mount,
      directory: join(packageDir, tree.path),
      ...tree.scanRoster === undefined ? {} : { scanRoster: tree.scanRoster },
    }
  })
}

/**
 * Built-in filesystem fixtures offered by the repository preview.
 * Session and Workspace semantics remain opaque here; the owning runtime tests
 * validate those files through their production readers.
 * @param repoRoot - Absolute repository root.
 * @returns Named chooser entries and their overlay trees.
 */
export function previewFixtures(repoRoot: string): PreviewFixture[] {
  const root = join(repoRoot, PREVIEW_EXAMPLE_ROOT)
  return [{
    id: 'vfs-example',
    label: 'Built-in showcase',
    description: 'Sample workspace, tool cards, subagents, and paged history.',
    trees: ['home', 'workspace'].map(mount => ({ mount, directory: join(root, mount) })),
  }]
}

/**
 * Render one pack as the lines a build log should carry.
 *
 * Refusals and unresolved dependencies are the two states a reader must not miss, so
 * they are spelled out rather than counted.
 * @param result - What the pack produced.
 * @param repoRoot - Absolute repository root, for relative paths.
 * @param outputFile - Where the image was written.
 * @returns Lines to print.
 */
export function describePack(result: PackResult, repoRoot: string, outputFile: string): string[] {
  const sizeOf = (prefix: string): number => Object.entries(result.files)
    .filter(([name]) => name.startsWith(prefix))
    .reduce((sum, [, bytes]) => sum + bytes.byteLength, 0)
  const megabytes = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(2)} MB`
  const workspaceCount = result.workspacePackages
  const heaviest = [...result.packages.entries()]
    .map(([name, count]) => ({ name, count, bytes: sizeOf(`node_modules/${name}/`) }))
    .sort((left, right) => right.bytes - left.bytes)
    .slice(0, 12)

  return [
    `vfs image: ${relative(repoRoot, outputFile)}`,
    `  roster entries      ${String(result.roster.length)}`,
    `  packages            ${String(result.packages.size)} (${String(workspaceCount)} workspace)`,
    `  files               ${String(Object.keys(result.files).length)}`,
    `  raw                 ${megabytes(Object.values(result.files).reduce((sum, bytes) => sum + bytes.byteLength, 0))}`,
    `  compressed          ${megabytes(result.image.byteLength)}`,
    `  config + presets    ${megabytes(sizeOf('config/'))}`,
    `  lazy archives       ${String(result.lazyArchives.length)} (${megabytes(result.lazyArchives.reduce((sum, archive) => sum + archive.image.byteLength, 0))} compressed)`,
    ...result.lazyArchives.map(archive =>
      `    ${megabytes(archive.image.byteLength).padStart(9)}  ${archive.name}  ${archive.files.join(', ')}`),
    `  javascript entries  ${String(result.javascriptEntries)} (dropped ${String(result.executables.length)} executable scripts, ${String(result.pageBundles.length)} page bundles verbatim)`,
    `  wrapper contract    ${result.contract}`,
    `  transform           ${String(result.transform.rewritten)} of ${String(result.transform.visited)} reached entries rewritten, ${String(result.droppedJavascriptEntries)} unreachable dropped`,
    `  unresolved          ${String(result.unresolvedExternalRequests.length)} third-party request(s) left to fail loud at require time`,
    '  heaviest packages:',
    ...heaviest.map(entry => `    ${entry.bytes.toString().padStart(9)} B  ${entry.name} (${String(entry.count)} files)`),
    ...result.missing.length === 0
      ? []
      : ['  unresolved dependencies:', ...result.missing.map(entry => `    ${entry}`)],
    '',
  ]
}
