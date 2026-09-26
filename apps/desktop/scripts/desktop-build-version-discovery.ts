/**
 * Suggest the next build version for a product version, so the sequence number
 * is derived rather than remembered.
 *
 * `apps/desktop/README.md` gives the form as `<product version>.<date>.<index>`
 * for a prerelease base and `<product version>-test.<date>.<index>` for a
 * stable one. What makes an index correct is which ones are taken, and that is
 * recorded where the builds went: the update bucket for an uploaded build, the
 * local output directory for one that was only handed over. Asking the bucket
 * first is what keeps a test feed's numbering unique across machines, and a
 * fresh CI checkout has no local artifacts to fall back on.
 *
 * Reusing an index would overwrite a published installer and invalidate the
 * checksum in the feed that already points at it, so a bucket that answers
 * must answer completely: the listing follows its pages, and a query that
 * cannot finish within the deadline falls back to the local scan rather than
 * numbering against a partial answer.
 */

import { readdir } from 'node:fs/promises'
import { parse } from 'semver'
import { desktopBuildVersionPrefix, validateDesktopBuildVersion } from './desktop-build-version.mjs'
import { DESKTOP_AUTO_UPDATE_ENV, resolveDesktopUploadConfig } from './desktop-auto-update-environment.mjs'
import { createDesktopCos, DESKTOP_COS_REGION } from './desktop-cos.ts'
import type { DesktopPackageTargetName } from './package-target.ts'

/** How long the whole bucket listing may take before the suggestion falls back to local artifacts. */
const LISTING_DEADLINE_MS = 8_000

/** Objects one listing page may return. */
const LISTING_PAGE_SIZE = 1000

/** Artifact name electron-builder writes for one build, on either platform; unsigned Windows builds add a suffix. */
const ARTIFACT = /(?:^|\/)deepseek-harness-(?<version>.+)-(?:mac|win)-(?:arm64|x64)(?:-unsigned)?\.(?:exe|dmg|zip)$/u

/** Inputs that decide which versions are already taken. */
export interface DesktopBuildVersionSuggestionOptions {
  readonly productVersion: string
  readonly target: DesktopPackageTargetName
  readonly environment: NodeJS.ProcessEnv
  /** Date segment to number within; defaults to today where the build runs. */
  readonly date?: string
  /** Directory electron-builder writes installers into for this build. */
  readonly artifactsRoot: string
}

/**
 * Format a date as the convention's segment.
 * @param date - Date to format.
 * @returns The date as `YYYYMMDD` in the build host's own time zone.
 */
export function desktopBuildDateSegment(date: Date = new Date()): string {
  const month = String(date.getMonth() + 1).padStart(2, '0')
  return `${String(date.getFullYear())}${month}${String(date.getDate()).padStart(2, '0')}`
}

/**
 * Read the sequence numbers already used for one product version and date.
 * @param versions - Versions found in a bucket or directory.
 * @param prefix - Everything a numbered build carries before its index.
 * @returns Every index present, unordered.
 */
function sequenceNumbers(versions: Iterable<string>, prefix: string): number[] {
  const numbers: number[] = []
  for (const version of versions) {
    if (!version.startsWith(prefix)) continue
    const index = version.slice(prefix.length)
    if (/^\d+$/u.test(index)) numbers.push(Number(index))
  }
  return numbers
}

/**
 * Read the versions one output directory already holds.
 * @param artifactsRoot - Directory electron-builder wrote installers into.
 * @returns Versions parsed from artifact names.
 */
async function localVersions(artifactsRoot: string): Promise<string[]> {
  const entries = await readdir(artifactsRoot).catch(() => [])
  return entries.map(entry => ARTIFACT.exec(entry)?.groups?.version)
    .filter((version): version is string => version !== undefined && parse(version) !== null)
}

/**
 * Read every version one update bucket publishes for a target.
 * @param options - Product version, target, and environment naming the bucket.
 * @returns Versions parsed from object names, or undefined when the bucket cannot be listed completely in time.
 */
async function remoteVersions(options: DesktopBuildVersionSuggestionOptions): Promise<string[] | undefined> {
  const platform = options.target === 'win-x64' ? 'win32' as const : 'darwin' as const
  const arch = options.target === 'mac-arm64' ? 'arm64' : 'x64'
  // An unconfigured destination has nothing to be unique against; an invalid one must not be mistaken for it.
  if (options.environment[DESKTOP_AUTO_UPDATE_ENV] === undefined
    && options.environment.DOWNLOAD_TEST_ORIGIN === undefined) return undefined
  const update = resolveDesktopUploadConfig(options.environment, platform, arch)
  const secretId = options.environment[update.secretIdEnvName]?.trim()
  const secretKey = options.environment[update.secretKeyEnvName]?.trim()
  if (secretId === undefined || secretId === '' || secretKey === undefined || secretKey === '') return undefined
  // The SDK has no per-request abort, so its own timeout is what releases an unanswered socket.
  const cos = createDesktopCos({ secretId, secretKey }, LISTING_DEADLINE_MS)
  const deadline = Date.now() + LISTING_DEADLINE_MS
  const versions: string[] = []
  let marker: string | undefined
  try {
    do {
      const page = await Promise.race([
        new Promise<{ keys: string[]; next: string | undefined }>((resolveListing, rejectListing) => {
          cos.getBucket({
            Bucket: update.bucket, Region: DESKTOP_COS_REGION, MaxKeys: LISTING_PAGE_SIZE,
            Prefix: `${update.binaryKeyPrefix}/deepseek-harness-`, ...marker === undefined ? {} : { Marker: marker },
          }, (error, data) => {
            if (error !== null && error !== undefined) rejectListing(error instanceof Error ? error : new Error(String(error)))
            else {
              resolveListing({
                keys: (data?.Contents ?? []).map(object => object.Key),
                next: data?.IsTruncated === 'true' ? data.NextMarker ?? data.Contents?.at(-1)?.Key : undefined,
              })
            }
          })
        }),
        new Promise<never>((_resolveDeadline, rejectDeadline) => {
          setTimeout(() => rejectDeadline(new Error('listing deadline')), Math.max(0, deadline - Date.now())).unref()
        }),
      ])
      for (const key of page.keys) {
        const version = ARTIFACT.exec(key)?.groups?.version
        if (version !== undefined && parse(version) !== null) versions.push(version)
      }
      marker = page.next
    } while (marker !== undefined)
  }
  catch (unfinished) {
    // Numbering against a partial listing could reuse a published index, so an unfinished query yields nothing.
    process.stdout.write(`desktop package: the update bucket did not answer completely (${
      unfinished instanceof Error ? unfinished.message : String(unfinished)}); numbering from local artifacts\n`)
    return undefined
  }
  return versions
}

/**
 * Suggest the next build version for today, numbering after what is already taken.
 * @param options - Product version, target, and environment to search.
 * @returns A validated build version whose index is free.
 */
export async function suggestDesktopBuildVersion(options: DesktopBuildVersionSuggestionOptions): Promise<string> {
  const prefix = `${desktopBuildVersionPrefix(options.productVersion)}${options.date ?? desktopBuildDateSegment()}.`
  const published = await remoteVersions(options)
  const taken = published ?? await localVersions(options.artifactsRoot)
  const used = sequenceNumbers(taken, prefix)
  const next = used.length === 0 ? 1 : Math.max(...used) + 1
  const suggestion = validateDesktopBuildVersion(`${prefix}${String(next)}`, options.productVersion)
  process.stdout.write(`desktop package: numbering ${suggestion} after ${String(used.length)} ${
    published === undefined ? 'local artifact' : 'published build'}${used.length === 1 ? '' : 's'} for ${prefix}*\n`)
  return suggestion
}
