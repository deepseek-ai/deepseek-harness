/** Stage the published documentation inside the published `dsh` package. */

import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { JSON_SCHEMA, load as loadYaml } from 'js-yaml'
import { rcompare } from 'semver'
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

/** Upgrade guides reach an installed reader and are not on the website. */
const ALWAYS_PUBLISHED_DIRECTORY = 'upgrade-guide'

/** Generated index of the staged upgrade guides; the repository tree has none. */
const UPGRADE_GUIDE_INDEX = `${ALWAYS_PUBLISHED_DIRECTORY}/README.md`

/**
 * Source-relative Markdown paths the documentation website publishes.
 *
 * The npm payload carries the same pages plus the upgrade guides, so a new
 * internal document under `docs/` reaches neither surface until the manifest
 * adopts it.
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
 * release set both publish the same files.
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
  const files = await stagedFiles(source, published)
  for (const file of files) {
    const target = join(destination, file)
    await mkdir(dirname(target), { recursive: true })
    await cp(join(source, file), target)
  }
  await mkdir(join(destination, ALWAYS_PUBLISHED_DIRECTORY), { recursive: true })
  await writeFile(join(destination, UPGRADE_GUIDE_INDEX), await upgradeGuideIndex(source, files))
}

/** One upgrade guide pair as the generated index lists it. */
interface IndexedGuide {
  readonly item: string
  readonly title: string
  readonly summary: string
  readonly summaryZh: string
}

/**
 * Render the index of every staged upgrade guide, grouped by the release it upgrades from.
 * @param source - Documentation root holding the guides.
 * @param files - Staged source-relative paths.
 * @returns the index Markdown; without staged guides it holds only the preamble.
 * @throws When a guide lacks its Chinese counterpart, a `description`, or a level-one title.
 */
async function upgradeGuideIndex(source: string, files: readonly string[]): Promise<string> {
  const versions = new Map<string, IndexedGuide[]>()
  for (const file of files) {
    const match = /^upgrade-guide\/v(?<version>[^/]+)\/(?<item>[^/]+)\/guide\.md$/u.exec(file)?.groups
    if (match?.version === undefined || match.item === undefined) continue
    const { version, item } = match
    const english = await guideHeading(join(source, file))
    const chinese = await guideHeading(join(source, file.replace(/\.md$/u, '.zh.md')))
    const guides = versions.get(version) ?? []
    guides.push({ item, title: english.title, summary: english.description, summaryZh: chinese.description })
    versions.set(version, guides)
  }
  const cell = (text: string): string => text.replace(/\s+/gu, ' ').trim().replaceAll('|', '\\|')
  const lines = [
    '# Upgrade guides',
    '',
    'Generated when `@deepseek-ai/dsh` is packed. A `v<T>` section lists what to change when upgrading from release vT to the release after it; vT is the release being left, not the target. Paths are relative to this file.',
    '',
    '打包 `@deepseek-ai/dsh` 时生成。`v<T>` 一节列出从 vT 版本升级到其下一个版本时需要做的修改；vT 是升级前的版本，不是目标版本。路径相对于本文件。',
  ]
  for (const [version, guides] of [...versions].sort(([left], [right]) => rcompare(left, right))) {
    lines.push('', `## v${version}`, '', '| Item | Summary | 摘要 | English | 中文 |', '| --- | --- | --- | --- | --- |')
    for (const guide of guides) {
      const directory = `v${version}/${guide.item}`
      lines.push(`| ${cell(guide.title)} | ${cell(guide.summary)} | ${cell(guide.summaryZh)} | [${directory}/guide.md](${directory}/guide.md) | [${directory}/guide.zh.md](${directory}/guide.zh.md) |`)
    }
  }
  return `${lines.join('\n')}\n`
}

/**
 * Read the frontmatter description and level-one title of one guide.
 * @param path - Absolute guide path.
 * @returns the guide's one-sentence description and title.
 * @throws When the file is missing or lacks either field.
 */
async function guideHeading(path: string): Promise<{ readonly description: string; readonly title: string }> {
  const text = await readFile(path, 'utf8')
  // The same frontmatter rules as `verify-upgrade-guides`; the title is the first heading after it.
  const frontmatter = /^---\r?\n(?<yaml>[\s\S]*?)\r?\n---\r?\n/u.exec(text)
  const yaml = frontmatter?.groups?.yaml
  const metadata = yaml === undefined ? undefined : loadYaml(yaml, { schema: JSON_SCHEMA }) as { description?: unknown } | null
  const title = frontmatter === null ? undefined : /^# (?<title>.+?)\r?$/mu.exec(text.slice(frontmatter[0].length))?.groups?.title
  if (typeof metadata?.description !== 'string' || title === undefined) {
    throw new Error(`stage-dsh-docs: ${path} needs a frontmatter description and a level-one title`)
  }
  return { description: metadata.description, title }
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
      if (entry.isDirectory()) {
        await walk(path)
        continue
      }
      if (path.endsWith(EXCLUDED_SUFFIX)) continue
      if (path.endsWith('.md') && !published.has(path) && !isUpgradeGuide(path)) continue
      files.push(path)
    }
  }
  await walk('')
  return files.sort()
}

/**
 * Whether one path belongs to a shipped upgrade guide.
 * @param path - Source-relative documentation path.
 * @returns whether the path lives under the upgrade-guide tree.
 */
function isUpgradeGuide(path: string): boolean {
  return path.startsWith(`${ALWAYS_PUBLISHED_DIRECTORY}/`)
}

if (import.meta.main) {
  if (process.argv.includes('--clean')) await cleanStagedDshDocs()
  else await stageDshDocs()
}
