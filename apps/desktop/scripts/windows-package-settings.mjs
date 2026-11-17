/** Resolve Windows packaging concurrency and archive compression. */

/**
 * Validate worker limits and compression without accessing signing hardware.
 * File-owned compression takes precedence over the existing electron-builder environment override.
 * @param {NodeJS.ProcessEnv} environment Loaded packaging settings and inherited build environment.
 * @returns {{signatureCacheConcurrency: number, packConcurrency: number, compressionLevel: number}} Worker limits defaulting to four and archive compression defaulting to three.
 */
export function resolveWindowsPackageSettings(environment) {
  const value = environment.DSH_DESKTOP_WINDOWS_SIGNATURE_CACHE_CONCURRENCY ?? '4'
  if (!/^[1-8]$/u.test(value)) {
    throw new Error('desktop package: DSH_DESKTOP_WINDOWS_SIGNATURE_CACHE_CONCURRENCY must be an integer from 1 to 8')
  }
  const pack = environment.DSH_DESKTOP_WINDOWS_PACK_CONCURRENCY ?? '4'
  if (!/^[1-9]\d*$/u.test(pack) || !Number.isSafeInteger(Number(pack))) {
    throw new Error('desktop package: DSH_DESKTOP_WINDOWS_PACK_CONCURRENCY must be a positive integer')
  }
  const compression = environment.DSH_DESKTOP_WINDOWS_COMPRESSION_LEVEL ?? environment.ELECTRON_BUILDER_COMPRESSION_LEVEL ?? '3'
  if (!/^[0-9]$/u.test(compression)) {
    throw new Error('desktop package: DSH_DESKTOP_WINDOWS_COMPRESSION_LEVEL must be an integer from 0 to 9')
  }
  return { signatureCacheConcurrency: Number(value), packConcurrency: Number(pack), compressionLevel: Number(compression) }
}
