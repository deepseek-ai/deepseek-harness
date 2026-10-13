/** Resolve optional machine-owned macOS signature storage before signing begins. */
import { accessSync, constants, lstatSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'

/**
 * Require existing private storage with no linked ancestors; never create or repair it during packaging.
 * @param path Explicit absolute cache directory.
 * @returns Normalized directory; invalid paths, ownership, permissions and access fail before signing.
 */
export function validateMacOSSignatureCacheDirectory(path) {
  if (!path || path.includes('\0') || !isAbsolute(path)) {
    throw new Error('DSH_DESKTOP_MACOS_SIGNATURE_CACHE_DIR must be a nonempty absolute directory')
  }
  const root = resolve(path)
  for (let ancestor = root; ; ancestor = dirname(ancestor)) {
    const info = lstatSync(ancestor)
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error(`macOS signature cache: expected an unlinked directory: ${ancestor}`)
    }
    if (ancestor === root && (info.uid !== process.getuid() || (info.mode & 0o077) !== 0 || (info.mode & 0o700) !== 0o700)) {
      throw new Error(`macOS signature cache: directory must be private, accessible and owned by the current account: ${root}`)
    }
    if (ancestor === dirname(ancestor)) break
  }
  accessSync(root, constants.R_OK | constants.W_OK | constants.X_OK)
  return root
}

/**
 * Select validated machine storage or retain the target-local cache when the setting is absent.
 * @param environment File-owned packaging configuration.
 * @param targetBuildRoot Existing target build location used by local packaging.
 * @returns Selected cache directory; only the default may be created later by the signer.
 */
export function resolveMacOSSignatureCacheDirectory(environment, targetBuildRoot) {
  const selected = environment.DSH_DESKTOP_MACOS_SIGNATURE_CACHE_DIR
  return selected === undefined ? join(targetBuildRoot, 'signature-cache') : validateMacOSSignatureCacheDirectory(selected)
}
