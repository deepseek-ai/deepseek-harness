/**
 * Pure parsing and structural helpers for the bilingual-document pairing
 * gate. Kept separate from the CLI so corpus discovery and signature behavior
 * can be regression-tested without reading or mutating the repository tree.
 * Also the one home of the generated-region grammar, shared by the pairing
 * gate and the region-injecting generators.
 */

import { basename } from 'node:path'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { gfm } from 'micromark-extension-gfm'
import type { Nodes } from 'mdast'
import {
  languageSwitcherLinkOffset,
  semanticTranslationLinkNodeTarget,
  type TranslationLinkContext,
} from './translation-links.ts'

/** Complete opening marker line: `<!-- BEGIN GENERATED <slug> … -->` (slug captured). */
const GENERATED_REGION_BEGIN_LINE = /^<!-- BEGIN GENERATED (\S+)(?: [^>]*)? -->$/
/** Complete closing marker line: `<!-- END GENERATED <slug> -->` (slug captured). */
const GENERATED_REGION_END_LINE = /^<!-- END GENERATED (\S+) -->$/
/** Loose marker detector: any line that LOOKS like a region marker must parse as one. */
const GENERATED_REGION_MARKER_HINT = /^<!-- (?:BEGIN|END) GENERATED /

/** One generated region: its slug, marker line indices, and text (markers included). */
export interface GeneratedRegion {
  slug: string
  /** Zero-based line index of the BEGIN marker. */
  begin: number
  /** Zero-based line index of the END marker. */
  end: number
  text: string
}

/**
 * Locate every generated region. Regions are line-delimited: a marker occupies
 * its whole line, must be a complete well-formed marker, and the closing slug
 * must match the opener.
 *
 * @param content - Full Markdown document text.
 * @returns The regions in document order.
 * @throws Error on an unopened END, unclosed BEGIN, nested BEGIN, malformed
 *   marker line, or a closing slug that does not match its opener.
 */
export function generatedRegions(content: string): GeneratedRegion[] {
  const lines = content.split('\n')
  const regions: GeneratedRegion[] = []
  let open: { slug: string; begin: number } | null = null
  for (const [index, line] of lines.entries()) {
    const begin = GENERATED_REGION_BEGIN_LINE.exec(line)
    if (begin?.[1]) {
      if (open) throw new Error('generated region BEGIN marker nested inside an open region')
      open = { slug: begin[1], begin: index }
      continue
    }
    const end = GENERATED_REGION_END_LINE.exec(line)
    if (end?.[1]) {
      if (!open) throw new Error('generated region END marker without a BEGIN')
      if (end[1] !== open.slug) throw new Error(`generated region END slug '${end[1]}' does not match its BEGIN slug '${open.slug}'`)
      regions.push({ ...open, end: index, text: lines.slice(open.begin, index + 1).join('\n') })
      open = null
      continue
    }
    if (GENERATED_REGION_MARKER_HINT.test(line)) {
      throw new Error(`malformed generated region marker line: ${JSON.stringify(line)}`)
    }
  }
  if (open) throw new Error('generated region BEGIN marker without an END')
  return regions
}

/**
 * Wrap generated Markdown in the marker lines of one region.
 *
 * @param slug - Region slug, unique within its page.
 * @param body - Region content without markers.
 * @returns The marker-delimited region text.
 */
export function renderGeneratedRegion(slug: string, body: string): string {
  return [`<!-- BEGIN GENERATED ${slug} -->`, body, `<!-- END GENERATED ${slug} -->`].join('\n')
}

/**
 * Replace the one region in a page whose slug matches a freshly rendered region.
 *
 * @param content - The page's current full Markdown text.
 * @param region - The rendered marker-delimited region.
 * @returns The page text with that region replaced.
 * @throws Error when the page does not contain exactly one region with that slug.
 */
export function spliceGeneratedRegion(content: string, region: string): string {
  const slug = generatedRegions(region)[0]?.slug
  const matches = generatedRegions(content).filter(candidate => candidate.slug === slug)
  const match = matches[0]
  if (slug === undefined || matches.length !== 1 || match === undefined) {
    throw new Error(`expected exactly 1 generated region '${slug ?? '?'}', found ${matches.length}; add its BEGIN/END markers once`)
  }
  const lines = content.split('\n')
  return [...lines.slice(0, match.begin), region, ...lines.slice(match.end + 1)].join('\n')
}

/** Validated fields of `scripts/translation-pairing.manifest.json`. */
export interface TranslationPairingManifest {
  /** Source documents exempt from pairing because they are generated, instructional, or bilingual by construction. */
  excluded: string[]
}

const README_ARTIFACT = /(?:^|\/)readme(?:\.md|\.zh\.md|\.i18n\.yaml)$/i
const ROOT_PAIRED_DOCUMENT_ARTIFACT = /^(?:brand_guidelines|contributing|safety)(?:\.md|\.zh\.md|\.i18n\.yaml)$/i
const NON_SOURCE_DIRECTORIES = new Set([
  'node_modules',
  'lib',
  '.pnpm-store',
  '.cache',
  'coverage',
  '.sessions',
  '.storages',
  'tmp',
  'dist-exe',
  '__pycache__',
  '.pytest_cache',
  '.artifacts',
  'vendor',
])

/** Glob traversal exclusions corresponding to the non-source path predicate. */
export const TRANSLATION_SCOPE_GLOB_EXCLUDES = [
  '.agents/notes/archived/**',
  '**/node_modules/**',
  '**/lib/**',
  '**/.pnpm-store/**',
  '**/.cache/**',
  '**/coverage/**',
  '**/.doc-typecheck-*/**',
  '**/.node-next-types-*/**',
  '**/.sessions/**',
  '**/.storages/**',
  '**/tmp/**',
  '**/dist-exe/**',
  '**/__pycache__/**',
  '**/.pytest_cache/**',
  'apps/web/dist/**',
  '.artifacts/**',
  'python/sdk-runtime/src/deepseek_harness_runtime/runtime/**',
  'vendor/**',
]

/** Whether a repository-relative path belongs to a dependency or generated tree. */
function isTranslationSourceExcluded(file: string): boolean {
  const segments = file.split('/')
  return segments.some(segment => NON_SOURCE_DIRECTORIES.has(segment)
      || segment.startsWith('.doc-typecheck-')
    || segment.startsWith('.node-next-types-'))
    || file.startsWith('apps/web/dist/')
    || file.startsWith('python/sdk-runtime/src/deepseek_harness_runtime/runtime/')
}

/** Whether one discovered Markdown or sidecar path belongs to the bilingual source corpus. */
export function isTranslationScopeFile(file: string): boolean {
  return !file.startsWith('.agents/notes/archived/')
    && !isTranslationSourceExcluded(file) && (README_ARTIFACT.test(file)
    || ROOT_PAIRED_DOCUMENT_ARTIFACT.test(file)
    || file.startsWith('.agents/notes/')
    || file.startsWith('docs/')
    || file.startsWith('python/'))
}

/** Read the manifest exclusion list or fail before enforcement starts. */
function excludedField(record: Record<string, unknown>): string[] {
  const value = record.excluded
  if (!Array.isArray(value)) {
    throw new Error('translation-pairing.manifest.json: excluded must be an array of strings')
  }
  const entries: unknown[] = value
  if (!entries.every((entry): entry is string => typeof entry === 'string')) {
    throw new Error('translation-pairing.manifest.json: excluded must be an array of strings')
  }
  return entries
}

/** Parse and validate the checked-in bilingual manifest. */
export function parseTranslationPairingManifest(content: string): TranslationPairingManifest {
  const value: unknown = JSON.parse(content)
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('translation-pairing.manifest.json: expected an object')
  }
  const record = value as Record<string, unknown>
  const unsupported = Object.keys(record).filter(field => field !== 'excluded')
  if (unsupported.length > 0) {
    throw new Error(`translation-pairing.manifest.json: unsupported field(s): ${unsupported.join(', ')}; every in-scope document is required`)
  }
  return { excluded: excludedField(record) }
}

/** Whether a manifest entry excludes one exact file or a directory subtree. */
export function isTranslationPairingManifestExcluded(
  file: string,
  manifest: TranslationPairingManifest,
): boolean {
  return manifest.excluded.some(entry => (entry.endsWith('/') ? file.startsWith(entry) : file === entry))
}

/** Build the active bilingual-source predicate shared by every link consumer. */
export function translationPairSourcePredicate(
  manifest: TranslationPairingManifest,
): (sourcePath: string) => boolean {
  return sourcePath => isTranslationScopeFile(sourcePath)
    && !isTranslationPairingManifestExcluded(sourcePath, manifest)
}

/**
 * Normalize one CLI pair argument to its English anchor path: any of the
 * pair's three files (`foo.md`, `foo.zh.md`, `foo.i18n.yaml`) or the bare
 * `foo` stem names the same pair, and platform separators are accepted.
 *
 * @param argument - Repo-relative path as passed on a command line.
 * @returns The pair's `foo.md` anchor path with `/` separators.
 */
export function pairAnchorOfArgument(argument: string): string {
  const normalized = argument.split('\\').join('/').replace(/^\.\//, '')
  if (normalized.endsWith('.zh.md')) return `${normalized.slice(0, -'.zh.md'.length)}.md`
  if (normalized.endsWith('.i18n.yaml')) return `${normalized.slice(0, -'.i18n.yaml'.length)}.md`
  if (normalized.endsWith('.md')) return normalized
  return `${normalized}.md`
}

/** A parsed `verify-translation-pairing` invocation. */
export interface TranslationPairingCliRequest {
  /** Content plane read by the check. Writes and corpus checks use the working tree. */
  input: 'worktree' | 'index'
  mode: 'check' | 'list' | 'write'
  /** `corpus` runs discovery over the whole tree; `pairs` touches only the named anchors. */
  scope: 'corpus' | 'pairs'
  /** English anchor paths, empty for corpus scope. */
  anchors: string[]
}

/**
 * Parse and validate `verify-translation-pairing` CLI arguments.
 *
 * Check accepts optional pair paths; `--write` requires either pair paths or
 * `--all` so a bulk re-record is always an explicit choice — a bare
 * `--write` would silently bless every drifted pair in the tree, including
 * ones the caller never confirmed. `--list` is corpus-only.
 *
 * @param argv - Arguments after the script name.
 * @returns The validated request.
 * @throws Error when flags or their combination are invalid.
 */
export function parseTranslationPairingCliArgs(argv: string[]): TranslationPairingCliRequest {
  const flags = argv.filter(argument => argument.startsWith('--'))
  const anchors = [...new Set(argv.filter(argument => !argument.startsWith('--')).map(pairAnchorOfArgument))].sort()
  const unknown = flags.filter(flag => !['--list', '--write', '--all', '--cached'].includes(flag))
  if (unknown.length > 0) throw new Error(`unknown flag(s): ${unknown.join(', ')}`)
  const listMode = flags.includes('--list')
  const writeMode = flags.includes('--write')
  const allMode = flags.includes('--all')
  const cachedMode = flags.includes('--cached')
  if (listMode && (writeMode || allMode || cachedMode || anchors.length > 0)) {
    throw new Error('--list reports the whole corpus and takes no other flags or paths')
  }
  if (allMode && !writeMode) throw new Error('--all only applies to --write')
  if (cachedMode && writeMode) throw new Error('--cached is a read-only index check and cannot be combined with --write')
  if (cachedMode && anchors.length === 0) throw new Error('--cached requires the staged pair paths to check')
  if (writeMode) {
    if (anchors.length > 0 && allMode) throw new Error('--write takes either pair paths or --all, not both')
    if (anchors.length === 0 && !allMode) {
      throw new Error('--write requires the pair(s) you confirmed (any file of a pair), or --all to re-record every complete pair; recording pairs you did not review blesses unconfirmed content')
    }
    return { input: 'worktree', mode: 'write', scope: allMode ? 'corpus' : 'pairs', anchors }
  }
  if (listMode) return { input: 'worktree', mode: 'list', scope: 'corpus', anchors: [] }
  return {
    input: cachedMode ? 'index' : 'worktree',
    mode: 'check',
    scope: anchors.length > 0 ? 'pairs' : 'corpus',
    anchors,
  }
}

/** The structural signature compared between the two sides of a pair. */
export interface TranslationStructureSignature {
  /** Heading depths in document order (h2 -> 2). */
  headings: number[]
  /** Fenced code blocks verbatim: info string plus content, in order. */
  code: string[]
  /** Row and column count of each table, in order. */
  tables: string[]
  /** Kind, ordered-list start, and direct item count of each list, in order. */
  lists: string[]
  /** Every link target in order; the language switcher is excluded. */
  links: string[]
}

/** Parse Markdown with the same GFM extensions used by the pairing gate. */
export function parseTranslationMarkdown(content: string): Nodes {
  return fromMarkdown(content, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] })
}

const PUBLIC_REPOSITORY_BLOB_ROOT = 'https://github.com/deepseek-ai/deepseek-harness/blob/master/'

/** Return the accepted relative and public-repository links to one counterpart. */
export function languageSwitcherTargets(counterpart: string): string[] {
  return [basename(counterpart), `${PUBLIC_REPOSITORY_BLOB_ROOT}${counterpart}`]
}

/** Generated English sources cannot carry a switcher without making their generator stale. */
export function requiresSourceLanguageSwitcher(source: string): boolean {
  return ![
    'docs/agent-lifecycle.md',
    'docs/capability-seams.md',
    'docs/config-catalog.md',
    'docs/cordis-api/context.md',
    'docs/cordis-api/events.md',
    'docs/cordis-api/fiber.md',
    // Excluded from pairing, but kept here for generated-category completeness and direct spec coverage.
    'docs/cordis-api/inherited.md',
    'docs/cordis-api/registry.md',
    'docs/cordis-api/service.md',
    'docs/event-producer-consumer.md',
    'docs/graph-atlas.md',
    'docs/module-graph.md',
    'docs/persistence-catalog.md',
    'docs/tool-catalog.md',
    'docs/tool-execution-pipeline.md',
  ].includes(source)
}

/** Collect the ordered structural signature, skipping accepted switcher targets. */
export function translationStructureSignature(
  tree: Nodes,
  switcherTargets: string | readonly string[],
  linkContext: TranslationLinkContext & { markdown: string },
): TranslationStructureSignature {
  const switcherOffset = languageSwitcherLinkOffset(tree, linkContext.markdown, switcherTargets)
  const sig: TranslationStructureSignature = { headings: [], code: [], tables: [], lists: [], links: [] }
  const definitions = new Map<string, Extract<Nodes, { type: 'definition' }>>()
  const collectDefinitions = (node: Nodes): void => {
    if (node.type === 'definition' && !definitions.has(node.identifier)) {
      definitions.set(node.identifier, node)
    }
    if ('children' in node) for (const child of node.children) collectDefinitions(child)
  }
  collectDefinitions(tree)
  const linkTarget = (node: Extract<Nodes, { type: 'link' | 'definition' }>): string => (
    semanticTranslationLinkNodeTarget(node, linkContext.markdown, linkContext)
  )
  const visit = (node: Nodes): void => {
    switch (node.type) {
      case 'heading':
        sig.headings.push(node.depth)
        break
      case 'code':
        sig.code.push(`\`\`\`${node.lang ?? ''}${node.meta ? ` ${node.meta}` : ''}\n${node.value}`)
        break
      case 'table':
        sig.tables.push(`${node.children.length}x${node.children[0]?.children.length ?? 0}`)
        break
      case 'list':
        sig.lists.push(node.ordered
          ? `ordered:start=${node.start ?? 1}:items=${node.children.length}`
          : `bullet:items=${node.children.length}`)
        break
      case 'link':
        if (node.position?.start.offset !== switcherOffset) {
          sig.links.push(linkTarget(node))
        }
        break
      case 'linkReference': {
        const definition = definitions.get(node.identifier)
        if (definition !== undefined) {
          sig.links.push(linkTarget(definition))
        }
        break
      }
      default:
        // Every other node kind is prose or a container, not part of the signature.
        break
    }
    if ('children' in node) for (const child of node.children) visit(child)
  }
  visit(tree)
  return sig
}

/** Render a signature element for an error message, truncated for readability. */
function show(value: string | number | undefined): string {
  if (value === undefined) return 'nothing'
  const text = JSON.stringify(value)
  return text.length > 72 ? `${text.slice(0, 72)}…` : text
}

/** Return the first divergence for each structural field; empty means equal. */
export function translationStructureDiff(
  source: TranslationStructureSignature,
  zh: TranslationStructureSignature,
): string[] {
  const out: string[] = []
  const fields: [string, (string | number)[], (string | number)[]][] = [
    ['heading (depth)', source.headings, zh.headings],
    ['code block', source.code, zh.code],
    ['table (row x column count)', source.tables, zh.tables],
    ['list (kind, start, item count)', source.lists, zh.lists],
    ['link target', source.links, zh.links],
  ]
  for (const [field, sourceValues, zhValues] of fields) {
    const length = Math.max(sourceValues.length, zhValues.length)
    for (let index = 0; index < length; index++) {
      if (sourceValues[index] !== zhValues[index]) {
        out.push(`${field} #${index + 1} diverges between the pair: ${show(sourceValues[index])} vs ${show(zhValues[index])}`)
        break
      }
    }
  }
  return out
}
