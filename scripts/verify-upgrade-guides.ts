/**
 * Enforce the `docs/upgrade-guide/v<version>/<item>/guide.md` layout, metadata,
 * sections, and word ceiling defined by the `dsh-create-upgrade-guide` skill.
 * With `--base <ref>`, it also rejects guides added since that commit outside the root version's directory.
 * `verify-translation-pairing` owns the Chinese sibling's pairing record.
 * @module scripts/verify-upgrade-guides
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { JSON_SCHEMA, load } from 'js-yaml'
import { fromMarkdown } from 'mdast-util-from-markdown'

const ROOT = resolve(import.meta.dirname, '..')
const GUIDE_ROOT = 'docs/upgrade-guide'
const FRONTMATTER_KEYS = ['description', 'kind']
/** Required `##` sections for each guide language; the word ceiling applies to the English source. */
const LANGUAGES = {
  'guide.md': { sections: ['Change', 'Migration'], maxWords: 500 },
  'guide.zh.md': { sections: ['变更', '迁移'], maxWords: undefined },
} as const
const SEMVER = String.raw`(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?`
const GUIDE_PATH = new RegExp(`^v${SEMVER}/[a-z0-9]+(?:-[a-z0-9]+)*/(guide\\.md|guide\\.zh\\.md|guide\\.i18n\\.yaml)$`, 'u')

/** Return one guide's frontmatter and structure violations. */
function guideViolations(source: string, language: typeof LANGUAGES[keyof typeof LANGUAGES]): string[] {
  const violations: string[] = []
  const words = source.split(/\s+/u).filter(Boolean).length
  if (language.maxWords !== undefined && words > language.maxWords) violations.push(`${String(words)} words exceeds the ${String(language.maxWords)}-word ceiling`)

  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/u.exec(source)
  if (frontmatter === null) return [...violations, 'must start with YAML frontmatter']
  const metadata = load(frontmatter[1] as string, { schema: JSON_SCHEMA })
  if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) return [...violations, 'frontmatter must be a YAML object']
  const fields = metadata as Record<string, unknown>
  const keys = Object.keys(fields).sort()
  if (keys.join() !== FRONTMATTER_KEYS.join()) violations.push(`frontmatter keys must be exactly ${FRONTMATTER_KEYS.join(', ')}; got ${keys.join(', ') || 'none'}`)
  if (fields.kind !== 'upgrade-guide') violations.push('kind must be upgrade-guide')
  if (typeof fields.description !== 'string' || fields.description.trim() === '') violations.push('description must be a non-empty string')

  const body = source.slice(frontmatter[0].length)
  const outline = fromMarkdown(body).children
    .flatMap(node => node.type === 'heading' && node.depth <= 2 ? [body.slice(node.position?.start.offset, node.position?.end.offset)] : [])
  const expected = language.sections.map(section => `## ${section}`)
  if (outline.length !== expected.length + 1 || !outline[0]?.startsWith('# ') || outline.slice(1).join('\n') !== expected.join('\n')) {
    violations.push(`headings must be one "#" title followed by ${expected.map(heading => `"${heading}"`).join(', ')}; got ${outline.map(heading => `"${heading}"`).join(', ') || 'none'}`)
  }
  return violations
}

/**
 * Report upgrade-guide tree violations.
 * @param root - Repository root containing `docs/upgrade-guide`.
 * @returns diagnostics prefixed by the repository-relative file path; empty when the tree is absent.
 */
export function collectUpgradeGuideViolations(root: string): string[] {
  const directory = join(root, GUIDE_ROOT)
  if (!existsSync(directory)) return []
  const violations: string[] = []
  const files = readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter(entry => !entry.isDirectory())
    .map(entry => join(entry.parentPath, entry.name).slice(directory.length + 1).replaceAll('\\', '/'))
    .sort()
  for (const file of files) {
    const path = `${GUIDE_ROOT}/${file}`
    const name = GUIDE_PATH.exec(file)?.[1]
    if (name === undefined) {
      violations.push(`${path}: only v<semver>/<kebab-case-item>/guide.{md,zh.md,i18n.yaml} files belong in ${GUIDE_ROOT}`)
      continue
    }
    if (name === 'guide.md' || name === 'guide.zh.md') {
      for (const violation of guideViolations(readFileSync(join(directory, file), 'utf8'), LANGUAGES[name])) violations.push(`${path}: ${violation}`)
    }
  }
  return violations
}

/**
 * Report tracked guides added since `base` outside `docs/upgrade-guide/v<version>/`, where `<version>` is the
 * root `package.json` version. A version directory is frozen once that version is released, so a guide that a
 * pull request wrote before a release must move to the new version's directory before it merges. A guide that
 * the tip of `origin`'s `release/dsh-<x.y.z>` branch for its version line already contains passes, because
 * merging a release branch forward carries guides that were current on it. The tip is fetched by commit id,
 * without updating any ref, only when such a guide exists and the commit is absent locally; a shallow
 * repository fetches only that commit.
 * @param root - Repository root: a Git working tree with an `origin` remote.
 * @param base - Commit the working tree is compared with: the base-branch commit a pull request merges.
 * @returns diagnostics prefixed by the repository-relative guide path.
 * @throws Error naming the Git command when Git fails, such as for an unknown `base` or an unreachable `origin`.
 */
export function collectStaleUpgradeGuideAdditions(root: string, base: string): string[] {
  const git = (args: readonly string[]): string => {
    try {
      return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error: unknown) {
      const stderr = (error as { stderr?: unknown }).stderr
      throw new Error(`\`git ${args.join(' ')}\` failed: ${typeof stderr === 'string' && stderr.trim() !== '' ? stderr.trim() : String(error)}`, { cause: error })
    }
  }
  const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version?: unknown }
  if (typeof version !== 'string') throw new Error('package.json: version must be a string')
  const current = `${GUIDE_ROOT}/v${version}/`
  const released = new Map<string, ReadonlySet<string>>()
  const releasedGuides = (line: string): ReadonlySet<string> => {
    const tip = git(['ls-remote', 'origin', `refs/heads/release/dsh-${line}`]).split('\t')[0]?.trim() ?? ''
    if (tip === '') return new Set()
    if (spawnSync('git', ['cat-file', '-e', `${tip}^{commit}`], { cwd: root, stdio: 'ignore' }).status !== 0) {
      // Fetching a commit already in a shallow repository with `--depth` would cut the history behind it.
      const shallow = git(['rev-parse', '--is-shallow-repository']).trim() === 'true'
      // A background maintenance run after a shallow fetch rewrites .git/shallow under later Git commands.
      git(['-c', 'maintenance.auto=false', '-c', 'gc.auto=0', 'fetch', '--quiet', '--no-tags', '--no-write-fetch-head', ...(shallow ? ['--depth=1', '--filter=blob:none'] : []), 'origin', tip])
    }
    return new Set(git(['ls-tree', '-r', '-z', '--name-only', tip, '--', GUIDE_ROOT]).split('\0').filter(Boolean))
  }
  return git(['diff', '-z', '--name-only', '--no-renames', '--diff-filter=A', base, '--', GUIDE_ROOT])
    .split('\0')
    .filter((path) => {
      const line = /^v(\d+\.\d+\.\d+)/u.exec(path.split('/')[2] ?? '')?.[1]
      // `collectUpgradeGuideViolations` reports a path outside any version directory.
      if (path === '' || path.startsWith(current) || line === undefined) return false
      if (!released.has(line)) released.set(line, releasedGuides(line))
      return released.get(line)?.has(path) !== true
    })
    .map(path => `${path}: added outside the current version directory; the root version is ${version}, so move the guide to ${current}<item>/`)
}

if (process.argv[1] && import.meta.filename === resolve(process.argv[1])) {
  const { values } = parseArgs({ options: { base: { type: 'string' } } })
  const violations = collectUpgradeGuideViolations(ROOT)
  try {
    if (values.base !== undefined) violations.push(...collectStaleUpgradeGuideAdditions(ROOT, values.base))
  } catch (error: unknown) {
    violations.push(`cannot check guides added since ${values.base ?? ''}: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (violations.length > 0) {
    process.stderr.write('verify-upgrade-guides: violations found (see .agents/skills/dsh-create-upgrade-guide/SKILL.md):\n')
    for (const violation of violations) process.stderr.write(`  ${violation}\n`)
    process.exit(1)
  }
  process.stdout.write('verify-upgrade-guides: upgrade guides conform.\n')
}
