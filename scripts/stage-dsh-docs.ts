/** Stage the repository documentation inside the published `dsh` package. */

import { cp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Repository root, resolved from this script rather than the invoking directory. */
const REPOSITORY_ROOT = fileURLToPath(new URL('..', import.meta.url))

/** Directory whose contents are published, and the package directory that receives them. */
const DOCS_DIRECTORY = join(REPOSITORY_ROOT, 'docs')
const STAGED_DIRECTORY = join(REPOSITORY_ROOT, 'apps', 'cli', 'docs')

/**
 * Replace a package's `docs` directory with the repository documentation.
 *
 * The copy follows the working tree, so a pack publishes the `docs/` contents
 * the checkout holds rather than the committed tree. Runs from the `prepack`
 * lifecycle of `@deepseek-ai/dsh`, so packing the package and packing the
 * release set both publish the same files.
 * @param source - Documentation root to copy; defaults to the repository `docs`.
 * @param destination - Package directory to replace; defaults to `apps/cli/docs`.
 * @returns Resolves after the destination holds the copy.
 */
export async function stageDshDocs(
  source: string = DOCS_DIRECTORY,
  destination: string = STAGED_DIRECTORY,
): Promise<void> {
  await rm(destination, { recursive: true, force: true })
  await cp(source, destination, { recursive: true })
}

/**
 * Remove a staged copy, so no pack leaves a stale tree for the next one.
 * @param destination - Package directory to remove; defaults to `apps/cli/docs`.
 * @returns Resolves after the directory is absent.
 */
export async function cleanStagedDshDocs(destination: string = STAGED_DIRECTORY): Promise<void> {
  await rm(destination, { recursive: true, force: true })
}

if (import.meta.main) {
  if (process.argv.includes('--clean')) await cleanStagedDshDocs()
  else await stageDshDocs()
}
