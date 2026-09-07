/**
 * Repository knowledge for the packer: where this tree's workspaces, profile
 * composition, and config trees are, and how to report a pack.
 *
 * The library half takes all of this as parameters. Keeping the lookup here is what
 * lets the same library pack a different tree, and what keeps `pack.ts` free of
 * assumptions about pnpm workspaces or the `dsh` CLI.
 * @module @deepseek-ai/dsh-experimental-webworker-packer/src/repository
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { DSH_HOME_ENV } from '@deepseek-ai/dsh-home-paths'
import type { DshConfigTreeDeclaration } from '@deepseek-ai/dsh-package-manifest'
import type { ConfigTree, ImageTree, PackResult } from './pack.ts'

/**
 * Repository directories scanned for workspace and vendored packages. The
 * image only ever materializes runtime packages, which live here. The Landlock
 * package family contributes its unchanged JavaScript entry from `native/`;
 * examples and python never occur on a roster's dependency chain.
 */
const WORKSPACE_SCAN_ROOTS = ['vendor', 'packages', 'native/landlock-run/packages', 'apps']

/** Composition entry point package: the `dsh` CLI, run from source. */
const CLI_PACKAGE = 'apps/cli'

/** Composition entry point: the `dsh` CLI, run from source. */
const CLI_ENTRY = `${CLI_PACKAGE}/src/bin.ts`

/** Repository-owned deterministic filesystem content offered by the preview. */
const PREVIEW_EXAMPLE_ROOT = 'packages/experimental/webworker-runtime/tests/fixtures/vfs-example'

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

/**
 * Compose one profile through the real CLI dump path, leaving `!!js`
 * unevaluated. The dump runs against a throwaway Harness home and default
 * layers only, so the image is the shipped profile: the machine's `$DSH_HOME`
 * — its profile manifest with locally installed bundles, and its patch files —
 * would otherwise leak this machine's plugins into the image and break the
 * same-tree-same-bytes guarantee.
 * @param repoRoot - Absolute repository root.
 * @param profile - Profile name to compose.
 * @returns The composed YAML.
 */
export function composeProfile(repoRoot: string, profile: string): string {
  const home = mkdtempSync(join(tmpdir(), 'dsh-pack-home-'))
  try {
    return execFileSync(
      process.execPath,
      ['--import', 'tsx/esm', join(repoRoot, CLI_ENTRY), '--profile', profile, '--dump-default-config'],
      { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { ...process.env, [DSH_HOME_ENV]: home } },
    )
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
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
    const tree = entry as Partial<DshConfigTreeDeclaration> | null
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
