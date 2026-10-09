/** Select Official bundle packages from the running installation without importing provider code. */
import { existsSync, globSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { bundlePatchPaths, type ProfileManifest } from '@deepseek-ai/dsh-app-boot'

interface WorkspaceManifest extends ProfileManifest {
  main?: string
}

function manifestAt(file: string): WorkspaceManifest {
  return JSON.parse(readFileSync(file, 'utf8')) as WorkspaceManifest
}

/**
 * Offer a source checkout link or an exact published package version. Source installations are
 * identified by the real CLI manifest and its unpacked workspace dependencies, including Desktop's
 * development symlink. An incomplete checkout is an error, never a registry fallback.
 * @param name - Official catalog package name.
 * @param installAnchor - Running application's DSH package.json, possibly reached through a symlink.
 * @param version - Running DSH version used by its release family.
 * @returns An ordinary package-manager spec and its package version.
 * @throws when a source installation lacks its workspace package, bundle patch, or built runtime.
 */
export function officialBundleInstallTarget(name: string, installAnchor: string, version: string): { spec: string; version: string } {
  const anchor = realpathSync(installAnchor)
  const installation = manifestAt(anchor)
  const source = installation.name === '@deepseek-ai/dsh'
    && Object.values(installation.dependencies ?? {}).some(value => value.startsWith('workspace:'))
  if (!source) return { spec: `${name}@${version}`, version }
  const root = resolve(dirname(anchor), '../..')
  if (anchor !== join(root, 'apps', 'cli', 'package.json')
    || !existsSync(join(root, 'package.json'))
    || manifestAt(join(root, 'package.json')).name !== '@deepseek-ai/dsh-root') {
    throw new Error(`Official bundle ${name}: source DSH installation ${anchor} requires its complete workspace checkout`)
  }
  const matches = globSync('packages/*/*/package.json', { cwd: root })
    .map(file => ({ file: join(root, file), manifest: manifestAt(join(root, file)) }))
    .filter(entry => entry.manifest.name === name)
  const selected = matches[0]
  if (matches.length !== 1 || selected === undefined) {
    throw new Error(`Official bundle ${name}: expected one workspace package in ${root}, found ${matches.length}; restore the checkout and run pnpm install`)
  }
  const { file, manifest } = selected
  const directory = realpathSync(dirname(file))
  if (manifest.version !== version || manifest.private === true || manifest.dsh?.bundle === undefined) {
    throw new Error(`Official bundle ${name}: ${file} must declare a public bundle at DSH version ${version}`)
  }
  const main = typeof manifest.main === 'string' ? resolve(directory, manifest.main) : undefined
  if (main === undefined || !existsSync(main) || !statSync(main).isFile()) {
    throw new Error(`Official bundle ${name}: built runtime is missing in ${directory}; run pnpm install and pnpm run build in ${root}`)
  }
  for (const patch of bundlePatchPaths(directory, manifest.dsh.bundle)) {
    if (!existsSync(patch) || !statSync(patch).isFile()) {
      throw new Error(`Official bundle ${name}: bundle patch ${patch} is missing; restore the checkout`)
    }
  }
  return { spec: `link:${directory}`, version }
}
