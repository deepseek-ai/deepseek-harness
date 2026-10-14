/** Keep LibreOffice workers, prebuilt engines, and their dependencies on the real filesystem. */
import { readFile } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import { downloadRuntimeNpmPackage, type RuntimeNpmArchive } from './primary-runtime/prepare.ts'
import { load as parseYaml } from 'js-yaml'
import { officePackageDirectories } from './libreoffice-packages.mjs'

/** pkg applies these exclusions to dependency `files` as well as root asset globs. */
export const OFFICE_ASSET_IGNORES = [
  '**/node_modules/@deepseek-ai/libreoffice-kit/**',
  '**/node_modules/@deepseek-ai/libreoffice-kit-*/**',
]

/** One npm package at its existing sidecar dependency location. */
export interface OfficePackageArchive extends RuntimeNpmArchive {
  /** Relative package directory inside the sidecar. */
  readonly directory: string
}

/**
 * Resolve one installed npm version against its reviewed workspace lock integrity.
 * @param name - Published package name.
 * @param version - Exact installed version.
 * @param lockfile - Workspace lock recording the exact published archive.
 * @returns Locked npm tarball identity; rejects versions without SHA-512 integrity.
 */
export async function runtimeNpmArchive(name: string, version: string, lockfile = join(import.meta.dirname, '../pnpm-lock.yaml')): Promise<RuntimeNpmArchive> {
  const lock = parseYaml(await readFile(lockfile, 'utf8')) as { packages?: Record<string, { resolution?: { integrity?: string } }> }
  const integrity = lock.packages?.[`${name}@${version}`]?.resolution?.integrity
  if (typeof integrity !== 'string' || !/^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(integrity)) {
    throw new Error(`runtime npm lock: missing SHA-512 integrity for ${name}@${version}`)
  }
  return { name, version, url: `https://registry.npmjs.org/${name}/-/${name.split('/').at(-1)}-${version}.tgz`, integrity }
}

/**
 * Lock the installed Office closure to published npm tarballs, preserving nested dependency locations.
 * @param staging - Complete installed Node closure.
 * @param target - Sidecar platform and CPU.
 * @returns Download records for the selected engine and all dependencies.
 */
export async function officeSidecarArchives(staging: string, target: { platform: string; arch: string }): Promise<OfficePackageArchive[]> {
  const directories = await officePackageDirectories(staging, target)
  return Promise.all(directories.map(async (directory) => {
    const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')) as { name: string; version: string }
    return { ...await runtimeNpmArchive(manifest.name, manifest.version), directory: relative(staging, directory).split(sep).join('/') }
  }))
}

/**
 * Download the complete pinned Office sidecar without npm or package lifecycle scripts.
 * @param packages - Build-locked npm packages and dependency locations.
 * @param destination - Empty sidecar directory.
 * @param cache - Verified archive cache.
 * @returns Resolves after all packages are unpacked and checked.
 */
export async function downloadOfficeSidecar(packages: readonly OfficePackageArchive[], destination: string, cache: string): Promise<void> {
  for (const artifact of packages) {
    if (isAbsolute(artifact.directory) || artifact.directory.split(/[\\/]/u).some(part => part === '..')
      || !artifact.directory.startsWith('node_modules/')) throw new Error(`Office download: invalid package directory ${artifact.directory}`)
    await downloadRuntimeNpmPackage(artifact, join(destination, artifact.directory), cache)
  }
}
