/** Read `pnpm view` answers about a package's published versions. */
import semver from 'semver'

/** The fields a version listing prints for the package: every version, its publication times, and its dist-tags. */
export const VERSION_LIST_FIELDS = ['versions', 'time', 'dist-tags'] as const

/** The fields read for one version: what decides whether it can replace an installed bundle. */
export const VERSION_FIELDS = ['name', 'version', 'engines', 'peerDependencies', 'deprecated', 'dsh'] as const

/** One published version newer than the installed one, before its own manifest is read. */
export interface PublishedVersion {
  readonly version: string
  readonly publishedAt?: string
  readonly tags: readonly string[]
  readonly prerelease: boolean
}

/** What one version's manifest says about replacing an installed bundle. */
export interface VersionFacts {
  /** The fields `evaluatePluginCompatibility` reads. */
  readonly manifest: { name: string; version: string; engines?: unknown; peerDependencies?: unknown }
  readonly bundle: boolean
  readonly deprecated?: string
}

/** A JSON object, or undefined for anything else. */
function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

/**
 * The published versions newer than the installed one, newest first.
 * @param answer - parsed `pnpm view <name> versions time dist-tags --json` output.
 * @param installed - the installed version.
 * @returns the newer versions with their publication times and dist-tags.
 * @throws when the answer names no versions.
 */
export function newerVersions(answer: unknown, installed: string): PublishedVersion[] {
  const fields = recordOf(answer)
  // pnpm prints a package with one version as a string rather than a one-element array.
  const listed: unknown = typeof fields?.versions === 'string' ? [fields.versions] : fields?.versions
  if (!Array.isArray(listed)) throw new Error('pnpm view answered no versions')
  const time = recordOf(fields?.time) ?? {}
  const tags = Object.entries(recordOf(fields?.['dist-tags']) ?? {})
  return listed
    .filter((version): version is string => typeof version === 'string' && semver.valid(version) !== null && semver.gt(version, installed))
    .sort(semver.rcompare)
    .map((version) => {
      const published = time[version]
      return {
        version,
        ...typeof published === 'string' ? { publishedAt: published } : {},
        tags: tags.filter(([, tagged]) => tagged === version).map(([tag]) => tag),
        prerelease: semver.prerelease(version) !== null,
      }
    })
}

/**
 * What one exact version's manifest says, from `pnpm view <name>@<version> name version engines peerDependencies deprecated dsh --json`.
 * @param answer - the parsed output.
 * @param name - the package name, used when the answer omits it.
 * @param version - the version asked for, used when the answer omits it.
 * @returns the manifest fields compatibility reads, whether the version declares a bundle, and its deprecation message.
 */
export function versionFacts(answer: unknown, name: string, version: string): VersionFacts {
  const fields = recordOf(answer) ?? {}
  const dsh = recordOf(fields.dsh)
  const deprecated = fields.deprecated
  return {
    manifest: {
      name: typeof fields.name === 'string' ? fields.name : name,
      version: typeof fields.version === 'string' ? fields.version : version,
      ...Object.hasOwn(fields, 'engines') ? { engines: fields.engines } : {},
      ...Object.hasOwn(fields, 'peerDependencies') ? { peerDependencies: fields.peerDependencies } : {},
    },
    bundle: recordOf(dsh?.bundle) !== undefined,
    ...typeof deprecated === 'string' && deprecated !== '' ? { deprecated } : {},
  }
}
