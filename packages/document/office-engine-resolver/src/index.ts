/** Locate LibreOffice Kit engine packages from the consumer's Kit installation without module hooks. */
import { lstatSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

/**
 * Locate an engine package manifest for Kit.
 * @param name - Engine package name requested by Kit.
 * @returns Absolute path of the package's `package.json`.
 * @throws An error with code `MODULE_NOT_FOUND` when the package is absent.
 */
export type EnginePackageResolver = (name: string) => string

/**
 * Anchor engine resolution to the Kit entry actually used by the consumer, not this package's installation.
 * Each returned callback retains its own Node resolver and installs no module hooks.
 * @param kitEntry - Absolute Kit entry path or file URL, normally the consumer's `import.meta.resolve('@deepseek-ai/libreoffice-kit')`.
 * @returns A callback for Kit's `resolveEnginePackage` option. Native paths map the first ASAR segment to its unpacked copy;
 * WASM and paths outside archives stay unchanged. Kit validates the returned manifest and required engine assets.
 * @throws Node's error if `kitEntry` cannot be used by `createRequire`.
 * On invocation, the callback preserves Node errors for absent packages and other resolution failures.
 * An installed package with an unresolvable manifest throws an incomplete-installation Error with the Node error as its cause,
 * preventing engine fallback. Filesystem inspection errors propagate unchanged.
 */
export function createEnginePackageResolver(kitEntry: string | URL): EnginePackageResolver {
  const fromKit = createRequire(kitEntry)
  return (name) => {
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
    return name === '@deepseek-ai/libreoffice-kit-wasm' ? manifest : unpackedPath(manifest)
  }
}

/** Map only the first ASAR archive segment; already-unpacked paths pass through unchanged. */
function unpackedPath(path: string): string {
  return path.replace(/\.asar(?=[\\/])/, '.asar.unpacked')
}
