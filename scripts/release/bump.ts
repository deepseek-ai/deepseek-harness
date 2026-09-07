/**
 * Bump one release family's version and commit it, so the published version is
 * readable from the repository rather than derived inside CI
 * ([rationale](../../.agents/notes/implemented/process/2026-08-10-npm-release-sequences.md)).
 *
 * The dsh family shares one version across its publishable members, private
 * package manifests, and the workspace root:
 * `major`, `minor`, `patch`, or an explicit `x.y.z` (including a prerelease such
 * as `0.0.1-rc.1`). The vendored family has one version line per package, but
 * every release advances and publishes the complete family so the next release
 * never reuses an unchanged member's existing version from a different
 * repository state.
 *
 * The version lands in the manifests, the lockfile follows, and a human creates
 * the tag after the commit merges. CI never writes to the repository.
 */

import { globSync, readFileSync, writeFileSync } from 'node:fs'
import { join, matchesGlob } from 'node:path'
import { parseArgs } from 'node:util'
import { releaseFamily, type ReleaseFamily, type ReleaseMember } from './families.ts'
import { capture, isEntry } from './process.ts'

/** Files npm publishes whether or not `files` lists them. */
const ALWAYS_PUBLISHED = ['package.json', 'README*', 'LICENSE*', 'LICENCE*'] as const

/**
 * Inputs that decide what a built payload contains. A package whose `files`
 * selects `lib/` publishes build output that git does not track, so a change to
 * the sources or the build configuration changes the tarball while no published
 * path appears in the diff.
 */
const BUILD_INPUTS = ['src/**', 'tsconfig*.json', 'tsdown.config.*', 'build.config.*'] as const

/** Release types the dsh family accepts besides an explicit version. */
const RELEASE_TYPES = ['major', 'minor', 'patch'] as const

/** The workspace root manifest, which carries the dsh family's version. */
const ROOT_MANIFEST = 'package.json'

/** One manifest the bump rewrites, and the tag its new version will carry. */
interface PlannedVersion {
  readonly manifestPath: string
  readonly label: string
  readonly from: string
  readonly to: string
  /** The tag this version publishes from, or undefined for a non-published manifest. */
  readonly tag: string | undefined
}

/** One private dsh workspace whose version follows the publishable family. */
interface PrivateDshVersion {
  /** Repository-relative manifest path. */
  readonly manifestPath: string
  /** Package directory used in bump output. */
  readonly label: string
  /** Current manifest version. */
  readonly version: string
}

/**
 * Split a version into its release numbers, discarding any prerelease segment.
 * @param version - the current version.
 * @returns Major, minor, and patch.
 */
function releaseNumbers(version: string): [number, number, number] {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/.exec(version)
  if (match === null) throw new Error(`cannot read release numbers from version ${version}`)
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

/**
 * Order two versions by their release numbers alone.
 * @param left - one version.
 * @param right - the other version.
 * @returns Negative when `left` is lower, positive when higher, zero when equal.
 */
function compareReleaseNumbers(left: string, right: string): number {
  const [leftMajor, leftMinor, leftPatch] = releaseNumbers(left)
  const [rightMajor, rightMinor, rightPatch] = releaseNumbers(right)
  return leftMajor - rightMajor || leftMinor - rightMinor || leftPatch - rightPatch
}

/**
 * The prerelease segment of a version, or undefined when it has none.
 * @param version - the version to read.
 * @returns The segment after the first `-`.
 */
function prereleaseOf(version: string): string | undefined {
  const index = version.indexOf('-')
  return index === -1 ? undefined : version.slice(index + 1)
}

/**
 * Order two versions by semver precedence.
 *
 * Git's version sort cannot stand in for this: `--sort=v:refname` places
 * `4.0.1-rc.1` above `4.0.1`, while semver gives a prerelease lower precedence
 * than the release it precedes. Prerelease identifiers compare field by field,
 * numeric fields numerically, so `rc.10` outranks `rc.1`.
 * @param left - one version.
 * @param right - the other version.
 * @returns Negative when `left` is lower, positive when higher, zero when equal.
 */
export function compareVersions(left: string, right: string): number {
  const numbers = compareReleaseNumbers(left, right)
  if (numbers !== 0) return numbers
  const leftPre = prereleaseOf(left)
  const rightPre = prereleaseOf(right)
  if (leftPre === undefined || rightPre === undefined) {
    if (leftPre === rightPre) return 0
    return leftPre === undefined ? 1 : -1
  }
  const leftFields = leftPre.split('.')
  const rightFields = rightPre.split('.')
  for (let index = 0; index < Math.max(leftFields.length, rightFields.length); index += 1) {
    const leftField = leftFields[index]
    const rightField = rightFields[index]
    // A shorter identifier list has lower precedence when all its fields match.
    if (leftField === undefined) return -1
    if (rightField === undefined) return 1
    if (leftField === rightField) continue
    const leftNumeric = /^\d+$/.test(leftField)
    const rightNumeric = /^\d+$/.test(rightField)
    if (leftNumeric && rightNumeric) return Number(leftField) - Number(rightField)
    // Numeric fields have lower precedence than alphanumeric ones.
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1
    return leftField < rightField ? -1 : 1
  }
  return 0
}

/**
 * The next dsh version.
 * @param current - the family's current shared version.
 * @param request - `major`, `minor`, `patch`, or an explicit version.
 * @returns The target version.
 */
function nextSharedVersion(current: string, request: string): string {
  if (!RELEASE_TYPES.includes(request as typeof RELEASE_TYPES[number])) {
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(request)) {
      throw new Error(`usage: release:dsh <major|minor|patch|x.y.z>, got ${request}`)
    }
    return request
  }
  const [major, minor, patch] = releaseNumbers(current)
  if (request === 'major') return `${String(major + 1)}.0.0`
  if (request === 'minor') return `${String(major)}.${String(minor + 1)}.0`
  return `${String(major)}.${String(minor)}.${String(patch + 1)}`
}

/**
 * The version a vendored package publishes next.
 *
 * The baseline is the higher of the manifest version and the last tagged
 * version: a vendor re-sync restores upstream's version, which is lower than
 * the release version this repository already reserved, and incrementing that
 * would reuse an existing version.
 *
 * A prerelease does not consume its own release numbers. Publishing
 * `4.0.1-rc.1` leaves `4.0.1` free, so the next stable version is `4.0.1`
 * rather than `4.0.2`, and a second prerelease keeps those numbers too.
 * @param current - the package's manifest version.
 * @param tagged - the version its newest tag names, when it has one.
 * @param prerelease - prerelease identifier to append, for a rehearsal publication.
 * @returns The target version.
 */
export function nextVendorVersion(
  current: string,
  tagged: string | undefined,
  prerelease?: string,
): string {
  const taggedOrder = tagged === undefined ? undefined : compareReleaseNumbers(tagged, current)
  const ahead = taggedOrder !== undefined && taggedOrder > 0
  const baseline = ahead && tagged !== undefined ? tagged : current
  const [major, minor, patch] = releaseNumbers(baseline)
  // Reuse the numbers when the tagged version that set them is a prerelease
  // of them; increment when a stable release already holds them.
  const taggedPrerelease = tagged !== undefined && prereleaseOf(tagged) !== undefined
  const sameReleasePrereleases = taggedOrder === 0 && prereleaseOf(current) !== undefined
  const reuse = taggedPrerelease && (ahead || sameReleasePrereleases)
  const numbers = reuse
    ? `${String(major)}.${String(minor)}.${String(patch)}`
    : `${String(major)}.${String(minor)}.${String(patch + 1)}`
  return prerelease === undefined ? numbers : `${numbers}-${prerelease}`
}

/**
 * Whether a repository-relative path reaches the member's published payload.
 * @param member - the member the path belongs to.
 * @param path - repository-relative path.
 * @returns True when `files`, npm's always-published set, or a build input selects it.
 */
export function reachesPayload(member: ReleaseMember, path: string): boolean {
  const relative = path.slice(member.directory.length + 1)
  const files = member.manifest.files
  const selected = Array.isArray(files) ? files.filter((entry): entry is string => typeof entry === 'string') : []
  const built = selected.some(pattern => pattern.startsWith('lib'))
  const patterns = [...ALWAYS_PUBLISHED, ...selected, ...built ? BUILD_INPUTS : []]
  return patterns.some(pattern =>
    matchesGlob(relative, pattern) || matchesGlob(relative, `${pattern}/**`) || relative === pattern)
}

/**
 * The newest version a member tagged.
 * @param family - the member's family.
 * @param member - the member.
 * @returns The version, or undefined when the member has no release tag.
 */
function lastTaggedVersion(family: ReleaseFamily, member: ReleaseMember): string | undefined {
  const prefix = family.tagPrefixFor(member)
  const versions = capture('git', ['tag', '--list', `${prefix}*`])
    .split('\n').filter(line => line !== '').map(tag => tag.slice(prefix.length))
  if (versions.length === 0) return undefined
  return versions.reduce((newest, candidate) => compareVersions(candidate, newest) > 0 ? candidate : newest)
}

/**
 * Write a version into a manifest, preserving formatting and key order.
 * @param root - repository root.
 * @param manifestPath - repository-relative manifest path.
 * @param from - the version the manifest currently carries.
 * @param to - the target version.
 */
function writeVersion(root: string, manifestPath: string, from: string, to: string): void {
  const path = join(root, manifestPath)
  const text = readFileSync(path, 'utf8')
  const line = `"version": "${from}"`
  if (!text.includes(line)) throw new Error(`${manifestPath}: cannot locate ${line}`)
  writeFileSync(path, text.replace(line, `"version": "${to}"`))
}

/**
 * Read the workspace root version.
 * @param root - repository root.
 * @returns The root manifest version.
 */
function rootVersion(root: string): string {
  const manifest: unknown = JSON.parse(readFileSync(join(root, ROOT_MANIFEST), 'utf8'))
  const version = (manifest as Record<string, unknown>).version
  if (typeof version !== 'string') throw new Error('package.json must declare a string version')
  return version
}

/**
 * Discover private package and application manifests that share the dsh version
 * without joining its publish set.
 * @param root - repository root.
 * @returns Private workspace manifests sorted by path.
 */
function privateDshVersions(root: string): PrivateDshVersion[] {
  return globSync(['apps/*/package.json', 'packages/*/*/package.json'], { cwd: root })
    .map(path => path.replaceAll('\\', '/'))
    .sort()
    .flatMap((manifestPath) => {
      const parsed: unknown = JSON.parse(readFileSync(join(root, manifestPath), 'utf8'))
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error(`${manifestPath} is not a JSON object`)
      }
      const manifest = parsed as Record<string, unknown>
      if (manifest.private !== true) return []
      if (typeof manifest.version !== 'string') {
        throw new Error(`${manifestPath} must declare a string version`)
      }
      return [{
        manifestPath,
        label: manifestPath.slice(0, -'/package.json'.length),
        version: manifest.version,
      }]
    })
}

/**
 * Plan the dsh family's rewrite: one version for every publishable member,
 * private package, and the root.
 * @param family - the dsh family.
 * @param root - repository root.
 * @param members - the family's members.
 * @param request - `major`, `minor`, `patch`, or an explicit version.
 * @returns The manifests to rewrite and the shared target version.
 */
export function planShared(
  family: ReleaseFamily,
  root: string,
  members: readonly ReleaseMember[],
  request: string,
): { planned: PlannedVersion[]; version: string } {
  const [first] = members
  if (first === undefined) throw new Error(`release family ${family.id} has no members`)
  const version = nextSharedVersion(first.version, request)
  // The workspace root carries the family version too: the workspace constraint
  // requires every member's version to equal the root's.
  const planned: PlannedVersion[] = [
    { manifestPath: ROOT_MANIFEST, label: ROOT_MANIFEST, from: rootVersion(root), to: version, tag: undefined },
  ]
  for (const member of members) {
    planned.push({
      manifestPath: `${member.directory}/package.json`,
      label: member.directory,
      from: member.version,
      to: version,
      tag: family.tagFor({ ...member, version }),
    })
  }
  const publishableManifests = new Set(members.map(member => `${member.directory}/package.json`))
  for (const entry of privateDshVersions(root)) {
    if (publishableManifests.has(entry.manifestPath)) continue
    planned.push({
      manifestPath: entry.manifestPath,
      label: entry.label,
      from: entry.version,
      to: version,
      tag: undefined,
    })
  }
  return { planned, version }
}

/**
 * Plan the vendored family's rewrite: every package advances together while
 * retaining its own version line and tag.
 * @param family - the vendored family.
 * @param members - the family's members.
 * @param prerelease - prerelease identifier to append, for a rehearsal publication.
 * @returns The manifests to rewrite.
 */
function planPerPackage(
  family: ReleaseFamily,
  members: readonly ReleaseMember[],
  prerelease: string | undefined,
): PlannedVersion[] {
  const planned: PlannedVersion[] = []
  for (const member of members) {
    const tagged = lastTaggedVersion(family, member)
    const to = nextVendorVersion(member.version, tagged, prerelease)
    planned.push({
      manifestPath: `${member.directory}/package.json`,
      label: member.directory,
      from: member.version,
      to,
      tag: family.tagFor({ ...member, version: to }),
    })
  }
  return planned
}

/**
 * Bump the family named by `--family` and commit; `--dry-run` only reports the
 * plan. `--prerelease rc.1` makes the vendored family publish a rehearsal
 * version, which never takes the stable dist-tag.
 */
function main(): void {
  const { values, positionals } = parseArgs({
    options: {
      family: { type: 'string' },
      prerelease: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
    },
    allowPositionals: true,
  })
  if (values.family === undefined) throw new Error('usage: bump.ts --family <dsh|vendor> [version]')

  const family = releaseFamily(values.family)
  const root = process.cwd()
  const members = family.members(root)
  family.verifyVersions(members)

  let planned: PlannedVersion[]
  let sharedVersion: string | undefined
  if (family.id === 'dsh') {
    const request = positionals[0]
    if (request === undefined) throw new Error('usage: release:dsh <major|minor|patch|x.y.z>')
    if (values.prerelease !== undefined) {
      throw new Error('release:dsh takes the prerelease in its version argument, as in 0.0.1-rc.1')
    }
    const shared = planShared(family, root, members, request)
    planned = shared.planned
    sharedVersion = shared.version
  } else {
    if (positionals.length > 0) throw new Error('release:vendor takes no version: each package increments its own patch')
    if (values.prerelease !== undefined && !/^[0-9A-Za-z.-]+$/.test(values.prerelease)) {
      throw new Error(`--prerelease must be a semver prerelease identifier, got ${values.prerelease}`)
    }
    planned = planPerPackage(family, members, values.prerelease)
  }

  if (planned.length === 0) {
    console.log(`release bump: family ${family.id}, nothing changed since publication`)
    return
  }

  const dryRun = values['dry-run']
  if (!dryRun) {
    for (const entry of planned) writeVersion(root, entry.manifestPath, entry.from, entry.to)
    capture('pnpm', ['install', '--lockfile-only'])
  }

  const summary = sharedVersion
    ?? planned.map(entry => `${entry.label.replace('vendor/', '')} ${entry.to}`).join(', ')
  console.log(`release bump: family ${family.id} -> ${summary}`)
  for (const entry of planned) console.log(`  ${entry.label}: ${entry.from} -> ${entry.to}`)

  if (dryRun) {
    console.log('release bump: dry run, nothing written')
    return
  }
  capture('git', ['add', 'pnpm-lock.yaml', ...planned.map(entry => entry.manifestPath)])
  capture('git', ['commit', '-m', `release(${family.id}): ${summary}`])
  console.log('release bump: committed. After this merges to master, tag it:')
  for (const tag of [...new Set(planned.map(entry => entry.tag).filter(tag => tag !== undefined))]) {
    console.log(`  git tag ${tag} <merge commit> && git push origin ${tag}`)
  }
}

if (isEntry(import.meta.url)) main()
