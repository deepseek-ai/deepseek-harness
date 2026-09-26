/** Resolve file-owned Windows signature-cache concurrency before packaging starts. */

/**
 * Validate the cache worker limit without accessing signing hardware.
 * @param {NodeJS.ProcessEnv} environment File-owned Windows packaging settings.
 * @returns {{signatureCacheConcurrency: number}} Worker limit, defaulting to four when omitted.
 */
export function resolveWindowsPackageSettings(environment) {
  const value = environment.DSH_DESKTOP_WINDOWS_SIGNATURE_CACHE_CONCURRENCY ?? '4'
  if (!/^[1-8]$/u.test(value)) {
    throw new Error('desktop package: DSH_DESKTOP_WINDOWS_SIGNATURE_CACHE_CONCURRENCY must be an integer from 1 to 8')
  }
  return { signatureCacheConcurrency: Number(value) }
}
