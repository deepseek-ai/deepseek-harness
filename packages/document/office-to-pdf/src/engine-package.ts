/** Locate LibreOffice Kit engine packages where their native helpers can execute. */
import { lstatSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

const WASM_ENGINE = '@deepseek-ai/libreoffice-kit-wasm'

/**
 * Resolve from the kit's installation, mapping native engines to physical `.asar.unpacked` paths.
 * WASM keeps Node's logical path for Electron's archive-aware filesystem, whether or not its assets are unpacked.
 * Paths outside an archive pass through unchanged. The kit rejects a missing unpacked copy without switching engines.
 * @param name - Engine package name requested by the kit.
 * @returns Absolute path of the package's `package.json`.
 * @throws The original Node error when resolution fails for an absent package or another reason.
 * An installed package with an unresolvable manifest throws an Error with the Node error as its cause,
 * preventing engine fallback. Filesystem inspection errors propagate unchanged.
 */
export function resolveEnginePackage(name: string): string {
  const fromKit = createRequire(createRequire(import.meta.url).resolve('@deepseek-ai/libreoffice-kit'))
  let manifest: string
  try {
    manifest = fromKit.resolve(`${name}/package.json`)
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'MODULE_NOT_FOUND') {
      const installed = (fromKit.resolve.paths(name) ?? []).some(directory =>
        lstatSync(join(directory, name), { throwIfNoEntry: false }) !== undefined,
      )
      if (installed) throw new Error(`Installed LibreOfficeKit package is incomplete: ${name}. Reinstall the package.`, { cause: error })
    }
    throw error
  }
  return name === WASM_ENGINE ? manifest : unpackedPath(manifest)
}

/**
 * Map a path inside an ASAR archive to the archive's unpacked resource directory.
 * @param path - Absolute resolved path.
 * @returns The same path with its first `.asar` archive segment replaced by `.asar.unpacked`.
 */
export function unpackedPath(path: string): string {
  return path.replace(/\.asar(?=[\\/])/, '.asar.unpacked')
}
