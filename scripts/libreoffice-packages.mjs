/** Locate the complete installed Office package closure used by standalone CLI processes. */
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { isAbsolute, join, relative, sep } from 'node:path'

/**
 * Require the declared native engine, or use WASM on other targets.
 * @param {{ optionalDependencies?: Record<string, string> }} manifest - Installed kit manifest.
 * @param {{ platform: string, arch: string }} target - Distribution platform and CPU.
 * @returns {string} Engine package suffix.
 */
export function selectOfficeEngine(manifest, target) {
  const native = `${target.platform}-${target.arch}`
  return Object.hasOwn(manifest.optionalDependencies ?? {}, `@deepseek-ai/libreoffice-kit-${native}`) ? native : 'wasm'
}

/**
 * Find every required package, retaining its installed dependency resolution and target engine.
 * @param {string} staging - Symlink-free installed Node project.
 * @param {{ platform: string, arch: string }} target - Distribution platform and CPU.
 * @returns {Promise<string[]>} Absolute package directories; rejects missing dependencies and paths outside staging.
 */
export async function officePackageDirectories(staging, target) {
  const entry = join(staging, 'node_modules', '@deepseek-ai', 'libreoffice-kit')
  const manifest = JSON.parse(await readFile(join(entry, 'package.json'), 'utf8'))
  const engineName = `@deepseek-ai/libreoffice-kit-${selectOfficeEngine(manifest, target)}`
  const packages = new Set()

  /** @param {string} packageDirectory - Installed package directory. */
  async function visit(packageDirectory) {
    if (packages.has(packageDirectory)) return
    const relativeDirectory = relative(staging, packageDirectory)
    if (isAbsolute(relativeDirectory) || relativeDirectory === '..' || relativeDirectory.startsWith(`..${sep}`)) {
      throw new Error(`Office dependency is outside the deployed closure: ${packageDirectory}`)
    }
    const manifestPath = join(packageDirectory, 'package.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    packages.add(packageDirectory)
    const require = createRequire(manifestPath)
    const dependencies = new Set([
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.optionalDependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}),
    ])
    for (const name of dependencies) {
      if (name.startsWith('@deepseek-ai/libreoffice-kit-')) continue
      const optional = manifest.optionalDependencies?.[name] !== undefined
        || manifest.peerDependenciesMeta?.[name]?.optional === true
      const dependencyDirectory = (require.resolve.paths(name) ?? [])
        .map(directory => join(directory, name))
        .find(directory => existsSync(directory))
      if (dependencyDirectory === undefined) {
        if (optional) continue
        throw new Error(`Office dependency ${name} required by ${manifest.name} is missing.`)
      }
      if (optional) {
        const dependency = JSON.parse(await readFile(join(dependencyDirectory, 'package.json'), 'utf8'))
        if (!supports(dependency.os, target.platform) || !supports(dependency.cpu, target.arch)) continue
      }
      await visit(dependencyDirectory)
    }
  }

  await visit(entry)
  const engineDirectory = join(staging, 'node_modules', engineName)
  if (!existsSync(engineDirectory)) throw new Error(`Office engine ${engineName} required for ${target.platform}/${target.arch} is missing.`)
  await visit(engineDirectory)
  return [...packages].sort()
}

/**
 * @param {string[] | undefined} values - npm platform or CPU selectors.
 * @param {string} value - Target platform or CPU.
 * @returns {boolean} Whether the optional package supports the target.
 */
function supports(values, value) {
  return values === undefined || (!values.includes(`!${value}`)
    && (values.every(item => item.startsWith('!')) || values.includes(value) || values.includes('any')))
}
