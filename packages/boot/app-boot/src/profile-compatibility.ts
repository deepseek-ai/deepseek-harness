/** Profile-local compatibility permissions readable before any Cordis plugins load. */
import { readFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { parse } from 'semver'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { getDshRuntimeVersion } from './plugin-compatibility.ts'

/** Independent profile metadata; neither package manifests nor Cordis patches carry grants. */
export const PROFILE_COMPATIBILITY_FILENAME = 'compatibility.json'

/** Published and scoped npm package names, as npm accepts them in a manifest dependency key. */
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/

/** Whether a decoded record accepts only exact DSH versions. */
function isVersionList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(version => typeof version === 'string' && isExactPluginVersion(version))
}

/** Test whether an exemption names a canonical exact SemVer, including build metadata.
 * @param value Version supplied by a manifest or user.
 * @returns False for ranges, prefixes, whitespace, and malformed versions.
 */
export function isExactPluginVersion(value: string): boolean {
  const parsed = parse(value)
  return parsed !== null && value === `${parsed.version}${parsed.build.length === 0 ? '' : `+${parsed.build.join('.')}`}`
}

/** Validate one explicit exemption without granting it.
 * @param packageVersion Exact npm package-name@version, never an installation spec or range.
 * @param runtimeVersion Exact DSH version, including prerelease and build metadata.
 * @throws When either identity is not canonical.
 */
export function validatePluginVersionExemption(packageVersion: string, runtimeVersion: string): void {
  const separator = packageVersion.lastIndexOf('@')
  if (separator <= 0 || !PACKAGE_NAME.test(packageVersion.slice(0, separator))
    || !isExactPluginVersion(packageVersion.slice(separator + 1)) || !isExactPluginVersion(runtimeVersion)) {
    throw new Error('Version exemptions require an exact npm package-name@version and an exact DSH runtime version')
  }
}

/** What one profile's compatibility file currently authorizes, and what is wrong with it. */
export interface ProfileCompatibility {
  /** Accepted exact package-name@version keys mapped to their allowed DSH versions. */
  readonly exemptions: Record<string, string[]>
  /** Human-readable problems; empty when every record was accepted. */
  readonly warnings: string[]
  /**
   * Whether the file holds nothing this reader rejected, so a grant or revocation may rewrite it.
   * A false value means writing would discard content the user must repair by hand.
   */
  readonly rewritable: boolean
}

/** Read the profile's independent compatibility file without loading plugins.
 * A missing file authorizes nothing. An unreadable or unparsable file authorizes nothing and is
 * reported instead of failing, so a bad file can never make the profile unusable; rejected records
 * are skipped while the remaining valid ones still apply.
 * @param profileDir Absolute profile directory.
 * @returns Accepted exemptions plus every problem found; no manifest fallback is used.
 */
export function readProfileCompatibility(profileDir: string): ProfileCompatibility {
  const filename = join(profileDir, PROFILE_COMPATIBILITY_FILENAME)
  const unreadable = (reason: string): ProfileCompatibility =>
    ({ exemptions: {}, warnings: [`${filename} ${reason}; treating the profile as having no exemptions`], rewritable: false })
  let text: string
  try { text = readFileSync(filename, 'utf8') }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { exemptions: {}, warnings: [], rewritable: true }
    return unreadable(`cannot be read (${String(error)})`)
  }
  let value: unknown
  try { value = JSON.parse(text) }
  catch (error) { return unreadable(`is not valid JSON (${String(error)})`) }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return unreadable('must map exact package@version keys to DSH version lists')
  }
  const exemptions: Record<string, string[]> = {}
  const warnings: string[] = []
  for (const [key, versions] of Object.entries(value as Record<string, unknown>)) {
    const separator = key.lastIndexOf('@')
    if (separator <= 0 || !PACKAGE_NAME.test(key.slice(0, separator)) || !isExactPluginVersion(key.slice(separator + 1))) {
      warnings.push(`${filename}: ${JSON.stringify(key)} is not an exact package-name@version key; the record is ignored`)
      continue
    }
    if (!isVersionList(versions)) {
      warnings.push(`${filename}: ${key} must contain a list of exact DSH versions; the record is ignored`)
      continue
    }
    exemptions[key] = versions
  }
  return { exemptions, warnings, rewritable: warnings.length === 0 }
}

/** Read only the accepted exemptions of a profile.
 * @param profileDir Absolute profile directory.
 * @returns Exact package-name@version keys mapped to their allowed DSH versions.
 */
export function readProfileVersionExemptions(profileDir: string): Record<string, string[]> {
  return readProfileCompatibility(profileDir).exemptions
}

/** Persist one informed grant or revocation under the compatibility file's own lock.
 * @param profileDir Profile directory; no package manifest is created or modified.
 * @param packageVersion Exact manifest package-name@version.
 * @param runtimeVersion Exact DSH version; grants must name the current runtime, revocations may name historical ones.
 * @param enabled Whether to grant rather than revoke.
 * @param acceptRisk Required true for grants after explicit acknowledgement of possible crashes or data loss.
 * @returns After the atomic write. Existing plugin instances are not reloaded by this operation.
 * @throws For invalid identities, missing consent, a stale runtime, or a file the reader rejected,
 * which the user must repair by hand because rewriting it would discard their content.
 */
export async function setProfileVersionExemption(
  profileDir: string, packageVersion: string, runtimeVersion: string, enabled: boolean, acceptRisk: boolean,
): Promise<void> {
  validatePluginVersionExemption(packageVersion, runtimeVersion)
  if (enabled && !acceptRisk) {
    throw new Error('Incompatible plugins may cause crashes or data loss. To grant this exact-version exemption, explicitly acknowledge the risk with --accept-risk (acceptRisk: true).')
  }
  const current = getDshRuntimeVersion()
  if (enabled && runtimeVersion !== current) {
    throw new Error(`Cannot approve DSH ${runtimeVersion}: this application runs DSH ${current}. Use --dsh-version ${current}.`)
  }
  await mkdir(profileDir, { recursive: true })
  const filename = join(profileDir, PROFILE_COMPATIBILITY_FILENAME)
  await withFileLock(filename, async () => {
    const current = readProfileCompatibility(profileDir)
    if (!current.rewritable) {
      throw new Error(`${PROFILE_COMPATIBILITY_FILENAME} must be repaired before exemptions change:\n${current.warnings.join('\n')}`)
    }
    const exemptions = current.exemptions
    const versions = exemptions[packageVersion] ?? []
    if (enabled) exemptions[packageVersion] = [...new Set([...versions, runtimeVersion])]
    else {
      const retained = versions.filter(version => version !== runtimeVersion)
      if (retained.length) exemptions[packageVersion] = retained
      else Reflect.deleteProperty(exemptions, packageVersion)
    }
    await writeFileAtomic(filename, JSON.stringify(exemptions, undefined, 2) + '\n', { mode: 0o600 })
  })
}
