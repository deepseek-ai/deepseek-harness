/** Resolve manual Desktop CI build versions without release storage access. */
import { desktopBuildVersionPrefix, validateDesktopBuildVersion } from './desktop-build-version.mjs'

/**
 * Resolve an explicit version or a UTC date/run/attempt identifier without release storage access.
 * @param {NodeJS.ProcessEnv} environment Manual version and GitHub run identity.
 * @param {string} productVersion Version declared by the selected checkout.
 * @param {Date} now Time used for the UTC date segment.
 * @returns {string} Validated build version.
 */
export function desktopCiVersion(environment, productVersion, now = new Date()) {
  const input = environment.PACKAGE_VERSION_MODE
  // TODO: Remove legacy mode aliases on 2027-01-04 with the workflow source_ref mapping.
  const mode = input === 'product' ? 'follow-dsh' : input === 'auto' ? 'build-number' : input
  const selected = mode === 'default' ? (environment.DSH_PACKAGING_PRESET === 'production' ? 'follow-dsh' : 'build-number') : mode
  if (selected !== undefined && !['follow-dsh', 'build-number', 'manual'].includes(selected)) throw new Error('Invalid version mode')
  const requested = selected === 'follow-dsh' ? productVersion : selected === 'build-number' ? 'auto' : environment.PACKAGE_BUILD_VERSION?.trim()
  if (selected === 'manual' && (!requested || requested === 'auto')) throw new Error('Manual version mode requires an explicit version')
  const date = now.toISOString().slice(0, 10).replaceAll('-', '')
  const example = `${desktopBuildVersionPrefix(productVersion)}${date}.1`
  if (!requested) throw new Error(`Build version is required: select version_mode=build-number, or use ${productVersion}, or e.g. ${example}`)
  let candidate = requested
  if (requested === 'auto') {
    for (const name of ['GITHUB_RUN_NUMBER', 'GITHUB_RUN_ATTEMPT']) {
      if (!/^[1-9]\d*$/u.test(environment[name] ?? '')) throw new Error(`${name} must be a positive integer`)
    }
    candidate = `${desktopBuildVersionPrefix(productVersion)}${date}.${environment.GITHUB_RUN_NUMBER}.${environment.GITHUB_RUN_ATTEMPT}`
  }
  try {
    const resolved = validateDesktopBuildVersion(candidate, productVersion)
    return resolved
  } catch {
    throw new Error(`Invalid build version for this checkout: select version_mode=build-number, or use ${productVersion}, or e.g. ${example}`)
  }
}
