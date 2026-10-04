/**
 * Publish one packed release family from the tarballs the pack step produced.
 *
 * Publication is decided per package against the registry, never from a list of
 * "what this release includes": a version the registry lacks is published, a
 * version whose published tarball has the same integrity is skipped, and a
 * version whose published tarball differs fails the run — that last case means
 * the content changed without a version bump
 * ([rationale](../../.agents/notes/implemented/process/2026-08-10-npm-release-sequences.md)).
 *
 * Skipping on identical integrity is what makes re-running the publish step over
 * the same artifact safe.
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { parseArgs } from 'node:util'
import { valid, validRange } from 'semver'
import { releaseFamily } from './families.ts'
import { attempt, attemptEchoed, isEntry } from './process.ts'
import { packedIdentity, readPublishOrder, type PackedIdentity } from './tarball.ts'

/**
 * Registry codes that answer a write which did not settle, rather than a
 * rejection of what was sent. `E409 Failed to save packument` is the one this
 * sequence actually hits: publishing several packages in a row can outrun the
 * registry's own processing. A rejected payload (`E403` over an existing
 * version, a malformed manifest) never clears on a retry and must surface.
 */
const TRANSIENT_PUBLISH_CODES = ['E409', 'E429', 'E500', 'E502', 'E503', 'E504', 'ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN'] as const

/** How many times one tarball's publish is attempted before the run fails. */
const PUBLISH_ATTEMPTS = 4

/**
 * Shortest gap between two publishes, and the first retry backoff.
 *
 * The registry needs a moment to commit a packument before the next write; back
 * to back publishes are what produce `E409`.
 */
const PUBLISH_SPACING_MS = 2_000

/** What the registry knows about one version. */
type RegistryState =
  | { readonly kind: 'absent' }
  | { readonly kind: 'present'; readonly integrity: string }

/**
 * Whether a failed publish is worth another attempt.
 * @param output - combined npm output.
 * @returns True when the registry reported a write it did not commit.
 */
function isTransientFailure(output: string): boolean {
  return TRANSIENT_PUBLISH_CODES.some(code => output.includes(`code ${code}`))
}

/**
 * The subresource integrity string npm records for a tarball.
 * @param tarball - absolute tarball path.
 * @returns A `sha512-<base64>` string.
 */
function integrityOf(tarball: string): string {
  return `sha512-${createHash('sha512').update(readFileSync(tarball)).digest('base64')}`
}

/**
 * Ask the registry whether a version exists, and with what integrity.
 * @param name - package name.
 * @param version - package version.
 * @returns The registry state for that version.
 */
function registryState(name: string, version: string): RegistryState {
  const result = attempt('npm', ['view', `${name}@${version}`, 'dist.integrity', '--json'])
  if (result.status !== 0) {
    const output = `${result.stdout}${result.stderr}`
    if (output.includes('E404') || output.includes('404 Not Found')) return { kind: 'absent' }
    throw new Error(`npm view ${name}@${version} failed:\n${output}`)
  }
  const parsed: unknown = JSON.parse(result.stdout)
  if (typeof parsed !== 'string' || parsed === '') {
    throw new Error(`registry reported no dist.integrity for ${name}@${version}`)
  }
  return { kind: 'present', integrity: parsed }
}

/** Reject empty tags, npm option prefixes, characters requiring URI encoding, and version ranges. */
function validateDistTag(distTag: string): void {
  if (distTag === '' || distTag.startsWith('-') || encodeURIComponent(distTag) !== distTag || validRange(distTag) !== null) {
    throw new Error(`Invalid npm dist-tag ${JSON.stringify(distTag)}: use a non-empty tag without a leading hyphen, characters requiring URI encoding, or a version range.`)
  }
}

/** An explicit channel may be new or already name the same version after a partial publication. */
function verifyDistTag(member: PackedIdentity, distTag: string): void {
  const result = attempt('npm', ['dist-tag', 'ls', member.name])
  if (result.status !== 0) {
    const output = `${result.stdout}${result.stderr}`
    if (output.includes('E404') || output.includes('404 Not Found')) return
    throw new Error(`npm dist-tag ls ${member.name} failed:\n${output}`)
  }
  const tags = new Map<string, string>()
  for (const line of result.stdout.split(/\r?\n/u).filter(line => line !== '')) {
    const match = /^(\S+): (\S+)$/u.exec(line)
    const tag = match?.[1]
    const version = match?.[2]
    if (tag === undefined || version === undefined || valid(version) === null || tags.has(tag)) {
      throw new Error(`npm reported invalid dist-tags for ${member.name}: ${JSON.stringify(line)}`)
    }
    tags.set(tag, version)
  }
  if (tags.size === 0) throw new Error(`npm reported no dist-tags for ${member.name}`)
  const version = tags.get(distTag)
  if (version === undefined) {
    if (registryState(member.name, member.version).kind === 'present') {
      throw new Error(`${member.name}@${member.version} is already published without dist-tag ${distTag}; this run cannot bind an existing version to a new channel.`)
    }
    return
  }
  if (version !== member.version) {
    throw new Error(`${member.name}@${distTag} already points to ${version}; choose an unused dist-tag instead of replacing it with ${member.version}.`)
  }
}

/**
 * Publish one tarball, retrying a registry write that did not settle.
 *
 * Every retry re-reads the registry first, because `E409` can answer a write
 * that landed anyway: republishing a version that now exists fails permanently,
 * so the same integrity appearing under the failed attempt counts as success.
 * @param tarball - absolute tarball path.
 * @param name - package name the tarball declares.
 * @param version - package version the tarball declares.
 * @param distTag - explicit npm dist-tag, or undefined for npm's `latest` default.
 */
async function publishTarball(
  tarball: string,
  name: string,
  version: string,
  distTag: string | undefined,
): Promise<void> {
  const tagArgs = distTag === undefined ? [] : ['--tag', distTag]
  for (let tries = 1; tries <= PUBLISH_ATTEMPTS; tries += 1) {
    // No --access: every release member declares its own publishConfig, and
    // a command-line flag would override it. check-workspace-constraints
    // requires a public access level on every release member.
    const result = attemptEchoed('npm', ['publish', tarball, ...tagArgs])
    const output = `${result.stdout}${result.stderr}`
    if (result.status === 0) return

    const settled = registryState(name, version)
    if (settled.kind === 'present' && settled.integrity === integrityOf(tarball)) {
      console.log(`release publish: ${name}@${version} landed despite a reported failure, continuing`)
      return
    }
    if (tries === PUBLISH_ATTEMPTS || !isTransientFailure(output)) {
      throw new Error(`npm publish ${name}@${version} failed:\n${output}`)
    }
    const backoff = PUBLISH_SPACING_MS * 2 ** (tries - 1)
    console.log(
      `release publish: ${name}@${version} hit a transient registry failure`
      + ` (attempt ${String(tries)} of ${String(PUBLISH_ATTEMPTS)}), retrying in ${String(backoff)}ms`,
    )
    await sleep(backoff)
  }
}

/**
 * Publish packed artifacts, preserving occupied explicit channels and existing version integrity.
 * @param familyId - release family whose default channels apply when no override is supplied.
 * @param directory - packed artifact directory containing the publication order.
 * @param distTag - optional explicit npm channel, checked across the whole batch before uploading.
 * @returns Resolves after every artifact has been published or verified as already present.
 */
export async function publishRelease(familyId: string, directory: string, distTag?: string): Promise<void> {
  if (distTag !== undefined) validateDistTag(distTag)
  const family = releaseFamily(familyId)

  // Every entry in the order settles as either published or already present, so
  // one counter answers "how far along is this run" for whoever is watching a
  // release that takes minutes per family.
  const order = readPublishOrder(directory).map((filename) => {
    const tarball = join(directory, filename)
    return { tarball, ...packedIdentity(tarball) }
  })
  if (distTag !== undefined) {
    for (const member of order) verifyDistTag(member, distTag)
  }
  const total = String(order.length)
  let published = 0
  let skipped = 0
  for (const [index, { tarball, name, version }] of order.entries()) {
    const progress = `[${String(index + 1)}/${total}]`
    const state = registryState(name, version)
    if (state.kind === 'present') {
      const local = integrityOf(tarball)
      if (state.integrity !== local) {
        throw new Error(
          `${name}@${version} is already published with different content`
          + `\n  registry: ${state.integrity}\n  packed:   ${local}`
          + '\nBump the version, or investigate why the build is not reproducible.',
        )
      }
      console.log(`release publish: ${progress} ${name}@${version} already published, skipping`)
      skipped += 1
      continue
    }
    // Space out the writes: the gap belongs between publishes, so a run that
    // only skips does not wait at all.
    if (published > 0) await sleep(PUBLISH_SPACING_MS)
    await publishTarball(tarball, name, version, distTag ?? family.distTagForVersion(version))
    console.log(`release publish: ${progress} ${name}@${version} published`)
    published += 1
  }

  console.log(
    `release publish: family ${family.id}, ${total} member(s),`
    + ` ${String(published)} published, ${String(skipped)} already present`,
  )
}

/** Publish the family named by `--family` from the directory named by `--from`. */
async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { family: { type: 'string' }, from: { type: 'string' }, 'dist-tag': { type: 'string' } },
    allowPositionals: false,
  })
  if (values.family === undefined || values.from === undefined) {
    throw new Error('usage: publish.ts --family <dsh|vendor> --from <packed directory> [--dist-tag <tag>]')
  }
  await publishRelease(values.family, resolve(process.cwd(), values.from), values['dist-tag'])
}

if (isEntry(import.meta.url)) await main()
