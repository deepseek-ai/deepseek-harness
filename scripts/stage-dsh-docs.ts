/** Stage the reader-facing documentation inside the published `dsh` package. */

import { cp, rm } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Repository root, resolved from this script rather than the invoking directory. */
const REPOSITORY_ROOT = fileURLToPath(new URL('..', import.meta.url))

/** Generated per-release migration records; an installed package carries the current contract instead. */
const EXCLUDED_DIRECTORY = 'persistence-changes'

/** Translation alignment records the documentation gates own; a reader never opens one. */
const EXCLUDED_SUFFIX = '.i18n.yaml'

/**
 * Replace a package's `docs` directory with the documentation a reader needs.
 *
 * Runs from the `prepack` lifecycle of `@deepseek-ai/dsh`, so packing the
 * package and packing the release set both publish the same Markdown.
 * @param source - Documentation root to copy; defaults to the repository `docs`.
 * @param destination - Package directory to replace; defaults to `apps/cli/docs`.
 * @returns Resolves after the destination holds the filtered copy.
 */
export async function stageDshDocs(
  source: string = join(REPOSITORY_ROOT, 'docs'),
  destination: string = join(REPOSITORY_ROOT, 'apps', 'cli', 'docs'),
): Promise<void> {
  await rm(destination, { recursive: true, force: true })
  await cp(source, destination, {
    recursive: true,
    filter: entry => !isExcluded(source, entry),
  })
}

/**
 * Whether one source path is tooling-owned or generated rather than reader-facing.
 * @param source - Documentation root the entry belongs to.
 * @param entry - Absolute source path offered to the copy filter.
 * @returns whether the copy skips this entry.
 */
function isExcluded(source: string, entry: string): boolean {
  const path = relative(source, entry).split(sep).join('/')
  return path === EXCLUDED_DIRECTORY
    || path.startsWith(`${EXCLUDED_DIRECTORY}/`)
    || path.endsWith(EXCLUDED_SUFFIX)
}

if (import.meta.main) await stageDshDocs()
