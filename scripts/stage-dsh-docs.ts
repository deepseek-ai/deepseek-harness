/** Stage the documentation the website publishes inside the published `dsh` package. */

import { cp, mkdir, readdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { docsPages } from '../website/docs.ts'

/** Repository root, resolved from this script rather than the invoking directory. */
const REPOSITORY_ROOT = fileURLToPath(new URL('..', import.meta.url))

/** Directory whose contents are published, and the package directory that receives them. */
const DOCS_DIRECTORY = join(REPOSITORY_ROOT, 'docs')
const STAGED_DIRECTORY = join(REPOSITORY_ROOT, 'apps', 'cli', 'docs')

/** Generated migration records and the translation guidelines: maintainer material no reader in an installed package needs. */
const EXCLUDED_DIRECTORIES = ['persistence-changes', 'i18n'] as const

/** Translation alignment records the documentation gates own. */
const EXCLUDED_SUFFIX = '.i18n.yaml'

/**
 * Source-relative Markdown paths the documentation website publishes.
 *
 * The npm payload and the site carry the same pages, so a new internal
 * document under `docs/` reaches neither until the manifest adopts it.
 * @returns every manifest source and alias, relative to the documentation root.
 */
export function publishedDocuments(): ReadonlySet<string> {
  const published = new Set<string>()
  for (const page of docsPages) {
    for (const file of [page.source, ...page.sourceAliases ?? []]) {
      if (file.startsWith('docs/')) published.add(file.slice('docs/'.length))
    }
  }
  return published
}

/**
 * Replace a package's `docs` directory with the documentation a reader needs.
 *
 * The copy follows the working tree, so a pack publishes the `docs/` contents
 * the checkout holds rather than the committed tree. Runs from the `prepack`
 * lifecycle of `@deepseek-ai/dsh`, so packing the package and packing the
 * release set both publish the same pages.
 * @param source - Documentation root to copy; defaults to the repository `docs`.
 * @param destination - Package directory to replace; defaults to `apps/cli/docs`.
 * @param published - Source-relative Markdown paths to keep; defaults to the website manifest.
 * @returns Resolves after the destination holds the filtered copy.
 */
export async function stageDshDocs(
  source: string = DOCS_DIRECTORY,
  destination: string = STAGED_DIRECTORY,
  published: ReadonlySet<string> = publishedDocuments(),
): Promise<void> {
  await rm(destination, { recursive: true, force: true })
  for (const file of await stagedFiles(source, published)) {
    const target = join(destination, file)
    await mkdir(dirname(target), { recursive: true })
    await cp(join(source, file), target)
  }
}

/**
 * Remove a staged copy, so no pack leaves a stale tree for the next one.
 * @param destination - Package directory to remove; defaults to `apps/cli/docs`.
 * @returns Resolves after the directory is absent.
 */
export async function cleanStagedDshDocs(destination: string = STAGED_DIRECTORY): Promise<void> {
  await rm(destination, { recursive: true, force: true })
}

/**
 * List the files one stage publishes, in stable path order.
 * @param source - Documentation root to walk.
 * @param published - Source-relative Markdown paths to keep.
 * @returns source-relative POSIX paths of every published file.
 */
async function stagedFiles(source: string, published: ReadonlySet<string>): Promise<string[]> {
  const files: string[] = []
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(join(source, directory), { withFileTypes: true })) {
      const path = directory === '' ? entry.name : `${directory}/${entry.name}`
      if (EXCLUDED_DIRECTORIES.some(excluded => path === excluded || path.startsWith(`${excluded}/`))) continue
      if (entry.isDirectory()) await walk(path)
      else if (!path.endsWith(EXCLUDED_SUFFIX) && (!path.endsWith('.md') || published.has(path))) files.push(path)
    }
  }
  await walk('')
  return files.sort()
}

if (import.meta.main) {
  if (process.argv.includes('--clean')) await cleanStagedDshDocs()
  else await stageDshDocs()
}
