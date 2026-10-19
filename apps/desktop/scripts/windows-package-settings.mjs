/** Resolve file-owned Windows packaging and signature-cache concurrency. */

/**
 * Validate packaging and cache worker limits without accessing signing hardware.
 * @param {NodeJS.ProcessEnv} environment File-owned Windows packaging settings.
 * @returns {{signatureCacheConcurrency: number, packConcurrency: number}} Worker limits, each defaulting to four when omitted.
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
  return { signatureCacheConcurrency: Number(value), packConcurrency: Number(pack) }
}
