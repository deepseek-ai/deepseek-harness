/**
 * Resolve the version one build publishes, which is not always the version the
 * repository declares.
 *
 * A production release publishes the version in the manifests, aligned with the
 * `dsh` npm package. A test build publishes a version that appends a date and a
 * sequence number, so one test feed can carry several builds of a single
 * product version: `0.1.6-alpha.1.20260916.1` from a prerelease base and
 * `0.1.6-test.20260916.1` from a stable one, as the release versions table in
 * `apps/desktop/README.md` gives them. Passing that version here keeps it out
 * of the manifests, so the tracked version stays the product's while the build
 * version reaches electron-builder, the update feed, and the upload validation
 * as one input.
 *
 * `electron-updater` compares feed versions with `semver.gt` against the
 * installed `app.getVersion()`, so validation uses the same library. Sequence
 * numbers order builds within a feed under either form. The forms differ only
 * against the base itself: builds extending a prerelease outrank it, while
 * `0.1.6-test.1` ranks below `0.1.6`, which is why the stable form belongs to a
 * test feed that never serves the production release.
 */

import { parse } from 'semver'

/** Environment variable that carries the build version through one packaging and upload run. */
export const DESKTOP_BUILD_VERSION_ENV = 'DSH_DESKTOP_BUILD_VERSION'

/** Prerelease field that opens a test build's suffix on a stable product version. */
const STABLE_TEST_FIELD = 'test'

/**
 * Parse a version the updater would accept.
 * @param {string} version - Version to read.
 * @param {string} label - Description used in failures.
 * @returns {import('semver').SemVer} The parsed version.
 */
function parseVersion(version, label) {
  const parsed = parse(version, { loose: false })
  if (parsed === null) throw new Error(`desktop build version: ${label} ${version} is not a version`)
  if (parsed.build.length > 0) {
    // Build metadata does not participate in precedence, so two builds would compare equal to the updater.
    throw new Error(`desktop build version: ${label} ${version} cannot carry build metadata`)
  }
  return parsed
}

/**
 * The prerelease fields every build version for one product version starts with.
 * @param {import('semver').SemVer} product - Parsed product version.
 * @returns {readonly (string | number)[]} Fields a build version must repeat before its date.
 */
function requiredFields(product) {
  return product.prerelease.length === 0 ? [STABLE_TEST_FIELD] : product.prerelease
}

/**
 * Validate a build version against the product version it extends.
 * @param {string} buildVersion - Version this build publishes.
 * @param {string} productVersion - Version the manifests declare.
 * @returns {string} The version as semver normalizes it, which is what the artifacts will carry.
 */
export function validateDesktopBuildVersion(buildVersion, productVersion) {
  const build = parseVersion(buildVersion, 'build version')
  const product = parseVersion(productVersion, 'product version')
  if (build.version === product.version) return build.version
  if (build.compareMain(product) !== 0) {
    throw new Error(`desktop build version: ${buildVersion} must extend product version ${productVersion}`)
  }
  const required = requiredFields(product)
  const extendsProduct = build.prerelease.length > required.length
    && required.every((field, index) => build.prerelease[index] === field)
  if (!extendsProduct) {
    throw new Error(`desktop build version: ${buildVersion} must extend ${productVersion} as ${
      desktopBuildVersionPrefix(productVersion)}<date>.<sequence>`)
  }
  return build.version
}

/**
 * Resolve the version a build publishes.
 * @param {NodeJS.ProcessEnv} env - Packaging or upload environment.
 * @param {string} productVersion - Version the manifests declare.
 * @returns {string} The build version when one is present, otherwise the product version.
 */
export function resolveDesktopBuildVersion(env, productVersion) {
  const buildVersion = env[DESKTOP_BUILD_VERSION_ENV]?.trim()
  if (buildVersion === undefined || buildVersion === '') return productVersion
  return validateDesktopBuildVersion(buildVersion, productVersion)
}

/**
 * Everything a build version carries before its date, including the trailing separator.
 * @param {string} productVersion - Version the manifests declare.
 * @returns {string} The prefix shared by every build version of that product version.
 */
export function desktopBuildVersionPrefix(productVersion) {
  const product = parseVersion(productVersion, 'product version')
  const [release] = product.version.split('-')
  return `${release}-${requiredFields(product).join('.')}.`
}
