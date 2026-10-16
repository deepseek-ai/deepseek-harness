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
  const mode = environment.PACKAGE_VERSION_MODE
  const selected = mode === 'default' ? (environment.DSH_PACKAGING_PRESET === 'production' ? 'product' : 'auto') : mode
  if (selected !== undefined && !['product', 'auto', 'manual'].includes(selected)) throw new Error('Invalid version mode')
  const requested = selected === 'product' ? productVersion : selected === 'auto' ? 'auto' : environment.PACKAGE_BUILD_VERSION?.trim()
  if (selected === 'manual' && (!requested || requested === 'auto')) throw new Error('Manual version mode requires an explicit version')
  const date = now.toISOString().slice(0, 10).replaceAll('-', '')
  const example = `${desktopBuildVersionPrefix(productVersion)}${date}.1`
  if (!requested) throw new Error(`Build version is required: use auto, ${productVersion}, or e.g. ${example}`)
  let candidate = requested
  if (requested === 'auto') {
    for (const name of ['GITHUB_RUN_NUMBER', 'GITHUB_RUN_ATTEMPT']) {
      if (!/^[1-9]\d*$/u.test(environment[name] ?? '')) throw new Error(`${name} must be a positive integer`)
    }
    candidate = `${desktopBuildVersionPrefix(productVersion)}${date}.${environment.GITHUB_RUN_NUMBER}.${environment.GITHUB_RUN_ATTEMPT}`
  }
  if (environment.DSH_DESKTOP_UPDATE_CHANNEL === 'latest' && candidate.includes('-')) throw new Error('Latest channel requires a stable version; select product or manual stable version')
  try {
    const resolved = validateDesktopBuildVersion(candidate, productVersion)
    return resolved
  } catch {
    throw new Error(`Invalid build version for this checkout: use auto, ${productVersion}, or e.g. ${example}`)
  }
}
