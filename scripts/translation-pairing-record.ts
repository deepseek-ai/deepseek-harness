/**
 * Canonical paths, section computation, parsing, and rendering for bilingual
 * pairing records. A record holds one entry per heading section with
 * translated content, so independent edits to different sections change
 * separate record lines and merge with Git's default text merge.
 */

import { createHash } from 'node:crypto'
import { basename } from 'node:path'
import type { Nodes, RootContent } from 'mdast'
import {
  normalizeTranslationMarkdownLinkEdits,
  type TranslationLinkContext,
  type TranslationLinkDestinationEdit,
  type TranslationLinkNormalization,
} from './translation-links.ts'
import { generatedRegions, parseTranslationMarkdown } from './translation-pairing.ts'

/** The three repository-relative paths that form one bilingual pair. */
export interface TranslationPairPaths {
  /** English document path. */
  source: string
  /** Simplified Chinese document path. */
  zh: string
  /** Consistency-record path. */
  meta: string
}

/** Content hashes of one section's translated blocks. */
export interface TranslationSectionHashes {
  en: string
  zh: string
}

/** Section key (English heading-slug path) → hashes, in document order. */
export type TranslationPairingRecord = ReadonlyMap<string, TranslationSectionHashes>

/** Link-resolution inputs shared by both sides of one pair. */
export type TranslationPairingRecordContext = Omit<TranslationLinkContext, 'sourcePath'>

const KEY_LINE = /^(\/[^\s:#]*):$/
const HASH_LINE = /^ {2}(en|zh): ([0-9a-f]{16})$/

/**
 * Derive the counterpart and consistency-record paths from an English document.
 *
 * @param source - Repository-relative English Markdown path.
 * @returns The complete three-path pair.
 */
export function translationPairPaths(source: string): TranslationPairPaths {
  if (!source.endsWith('.md') || source.endsWith('.zh.md')) {
    throw new Error(`expected an English Markdown path, received ${JSON.stringify(source)}`)
  }
  return {
    source,
    zh: source.replace(/\.md$/, '.zh.md'),
    meta: source.replace(/\.md$/, '.i18n.yaml'),
  }
}

interface Section {
  heading?: Extract<Nodes, { type: 'heading' }>
  blocks: string[]
}

/** One top-level Markdown node, located in the text that {@link sections} slices. */
export interface TopLevelBlock {
  node: RootContent
  start: number | undefined
  end: number | undefined
  line: number
}

function headingText(node: Nodes): string {
  if ('value' in node && (node.type === 'text' || node.type === 'inlineCode')) return node.value
  return 'children' in node ? node.children.map(headingText).join('') : ''
}

function topLevelBlocks(tree: Nodes): TopLevelBlock[] {
  if (tree.type !== 'root') throw new Error('Markdown parser returned a non-root tree')
  return tree.children.map(node => ({
    node,
    start: node.position?.start.offset,
    end: node.position?.end.offset,
    line: node.position?.start.line ?? 0,
  }))
}

/** Characters that read only as destination text in every raw or angle-bracket destination slot. */
const PARSE_NEUTRAL_DESTINATION = /^[A-Za-z0-9._/:#%-]+$/

/**
 * Whether one edit replaces a complete, title-free destination that starts on its opener's line,
 * where both the authored and the replacement text match {@link PARSE_NEUTRAL_DESTINATION}.
 */
function isParseNeutralEdit(markdown: string, edit: TranslationLinkDestinationEdit): boolean {
  const authored = markdown.slice(edit.start, edit.end)
  const nodeStart = edit.node.position?.start.offset
  const nodeEnd = edit.node.position?.end.offset
  if (nodeStart === undefined || nodeEnd === undefined || edit.node.url !== authored) return false
  if (!PARSE_NEUTRAL_DESTINATION.test(authored) || !PARSE_NEUTRAL_DESTINATION.test(edit.value)) return false
  const before = markdown.slice(nodeStart, edit.start)
  const after = markdown.slice(edit.end, nodeEnd)
  const angle = before.endsWith('<')
  return edit.node.type === 'link'
    ? /\]\([ \t]*<?$/.test(before) && (angle ? /^>[ \t]*\)$/ : /^[ \t]*\)$/).test(after)
    : /\]:[ \t]*<?$/.test(before) && (angle ? /^>[ \t]*$/ : /^[ \t]*$/).test(after)
}

/**
 * Locate the authored tree's top-level nodes in normalized text without reparsing it.
 *
 * An accepted edit only exchanges letters, digits, and `._/:#%-` for others of
 * the same set inside one destination that neither starts a line nor carries a
 * title. Those characters cannot end the destination, start or end a code span,
 * HTML, autolink, autolink literal, emphasis, table cell, title, escape, or
 * character reference, or change how a line starts, so the normalized text
 * parses to the same nodes with offsets moved by the preceding edits.
 *
 * @param markdown - Exact authored text that `tree` parses.
 * @param tree - GFM parse of `markdown`.
 * @param edits - Normalization edits of `markdown` in ascending source order.
 * @returns The moved blocks, or `undefined` when an edit is not provably parse-neutral or lies outside every top-level node.
 */
export function normalizedTopLevelBlocks(
  markdown: string,
  tree: Nodes,
  edits: readonly TranslationLinkDestinationEdit[],
): TopLevelBlock[] | undefined {
  if (!edits.every(edit => isParseNeutralEdit(markdown, edit))) return undefined
  let next = 0
  let shift = 0
  const moved: TopLevelBlock[] = []
  for (const block of topLevelBlocks(tree)) {
    if (block.start === undefined || block.end === undefined) return undefined
    const start = block.start + shift
    for (let edit = edits[next]; edit !== undefined && edit.start < block.end; edit = edits[next]) {
      if (edit.start < block.start || edit.end > block.end) return undefined
      shift += edit.value.length - (edit.end - edit.start)
      next += 1
    }
    moved.push({ ...block, start, end: block.end + shift })
  }
  return next === edits.length ? moved : undefined
}

/**
 * Split normalized Markdown into the preamble plus one section per heading.
 * Fenced code blocks and generated regions, which the pairing gate requires to
 * be identical on both sides, are left out of each section's blocks.
 */
function sections(markdown: string, blocks: readonly TopLevelBlock[]): Section[] {
  const frontmatter = /^---\n[\s\S]*?\n---(?:\n|$)/.exec(markdown)?.[0].length ?? 0
  const result: Section[] = [{ blocks: frontmatter > 0 ? [markdown.slice(0, frontmatter)] : [] }]
  const regionLines = generatedRegions(markdown).map(region => [region.begin + 1, region.end + 1] as const)
  for (const { node, start, end, line } of blocks) {
    if ((start ?? 0) < frontmatter) continue
    if (node.type === 'heading') result.push({ heading: node, blocks: [] })
    if (node.type === 'code' || regionLines.some(([begin, regionEnd]) => line >= begin && line <= regionEnd)) continue
    result.at(-1)?.blocks.push(markdown.slice(start, end))
  }
  return result
}

/** Sections of one normalized side, reusing its authored parse whenever normalization provably keeps the node layout. */
function sideSections(markdown: string, normalized: TranslationLinkNormalization, tree: Nodes | undefined): Section[] {
  if (tree !== undefined && normalized.content === markdown) return sections(markdown, topLevelBlocks(tree))
  const moved = tree === undefined ? undefined : normalizedTopLevelBlocks(markdown, tree, normalized.edits)
  return sections(normalized.content, moved ?? topLevelBlocks(parseTranslationMarkdown(normalized.content)))
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'section'
}

function sectionHash(blocks: string[]): string {
  return createHash('sha256').update(blocks.join('\n')).digest('hex').slice(0, 16)
}

/**
 * Compute the record for one pair's current contents.
 *
 * Both sides are split at every heading; section `i` of one side corresponds
 * to section `i` of the other. Each side's hash covers its top-level blocks
 * except fenced code blocks and generated regions, which the pairing gate
 * requires to be identical on both sides. A section with no remaining blocks
 * has no entry. Keys are the English heading-slug paths, with `~2`, `~3`, …
 * suffixes on repeats.
 *
 * @param paths - Pair paths used to resolve each side's relative links.
 * @param en - English document text.
 * @param zh - Chinese document text.
 * @param context - Link-resolution inputs for both sides.
 * @param trees - Optional GFM parses of the exact English and Chinese inputs; changed normalized text
 *   is parsed again only when {@link normalizedTopLevelBlocks} cannot place its nodes.
 * @returns Entries in document order.
 * @throws Error when the two sides have different heading counts or malformed generated regions.
 */
export function computeTranslationPairingRecord(
  paths: TranslationPairPaths,
  en: string,
  zh: string,
  context: TranslationPairingRecordContext,
  trees?: { readonly en: Nodes; readonly zh: Nodes },
): TranslationPairingRecord {
  const normalizedEn = normalizeTranslationMarkdownLinkEdits(en, { ...context, sourcePath: paths.source }, [], trees?.en)
  const normalizedZh = normalizeTranslationMarkdownLinkEdits(zh, { ...context, sourcePath: paths.zh }, [], trees?.zh)
  const enSections = sideSections(en, normalizedEn, trees?.en)
  const zhSections = sideSections(zh, normalizedZh, trees?.zh)
  if (enSections.length !== zhSections.length) {
    throw new Error(`${paths.source} has ${enSections.length - 1} heading(s) but ${paths.zh} has ${zhSections.length - 1}`)
  }
  const record = new Map<string, TranslationSectionHashes>()
  const ancestors: { depth: number; slug: string }[] = []
  const keys = new Set<string>()
  for (const [index, enSection] of enSections.entries()) {
    const zhSection = zhSections[index]
    if (zhSection === undefined) throw new Error('section alignment lost its counterpart')
    let path = '/'
    if (enSection.heading !== undefined) {
      const depth = enSection.heading.depth
      while ((ancestors.at(-1)?.depth ?? 0) >= depth) ancestors.pop()
      ancestors.push({ depth, slug: slug(headingText(enSection.heading)) })
      path = `/${ancestors.map(ancestor => ancestor.slug).join('/')}`
    }
    let key = path
    for (let repeat = 2; keys.has(key); repeat++) key = `${path}~${repeat}`
    keys.add(key)
    if (enSection.blocks.length === 0 && zhSection.blocks.length === 0) continue
    record.set(key, { en: sectionHash(enSection.blocks), zh: sectionHash(zhSection.blocks) })
  }
  return record
}

/**
 * Parse a consistency record.
 *
 * @param content - Complete sidecar text.
 * @returns Entries in file order, or `undefined` for malformed or duplicate entries.
 */
export function parseTranslationPairingRecord(content: string): TranslationPairingRecord | undefined {
  const record = new Map<string, TranslationSectionHashes>()
  const lines = content.split('\n').filter(line => line !== '' && !line.startsWith('#'))
  for (let index = 0; index < lines.length; index += 3) {
    const key = KEY_LINE.exec(lines[index] ?? '')?.[1]
    const en = HASH_LINE.exec(lines[index + 1] ?? '')
    const zh = HASH_LINE.exec(lines[index + 2] ?? '')
    if (key === undefined || record.has(key) || en?.[1] !== 'en' || zh?.[1] !== 'zh' || !en[2] || !zh[2]) {
      return undefined
    }
    record.set(key, { en: en[2], zh: zh[2] })
  }
  return record
}

/**
 * Render the canonical consistency record for a pair.
 *
 * @param paths - Pair paths written into the recovery command.
 * @param record - Confirmed section hashes.
 * @returns Canonical YAML text with exactly one trailing newline.
 */
export function renderTranslationPairingRecord(paths: TranslationPairPaths, record: TranslationPairingRecord): string {
  return [
    `# Bilingual-pair consistency record for ${basename(paths.source)} (docs/i18n/README.md): per heading`,
    '# section, a hash of its English and Chinese blocks outside code blocks and generated regions.',
    '# After editing either side, bring the other along and re-record with:',
    `#   pnpm run verify-translation-pairing --write ${paths.source}`,
    ...[...record].flatMap(([key, hashes]) => [`${key}:`, `  en: ${hashes.en}`, `  zh: ${hashes.zh}`]),
    '',
  ].join('\n')
}

/**
 * Describe how a current record differs from the confirmed one.
 *
 * @param recorded - Confirmed record.
 * @param current - Record computed from current contents.
 * @returns One message per changed, added, or removed section; empty when equal.
 */
export function translationPairingRecordDiff(
  recorded: TranslationPairingRecord,
  current: TranslationPairingRecord,
): string[] {
  const out: string[] = []
  for (const [key, hashes] of current) {
    const confirmed = recorded.get(key)
    if (confirmed === undefined) {
      out.push(`section ${key} has unconfirmed translated content`)
      continue
    }
    const sides = (['en', 'zh'] as const).filter(side => confirmed[side] !== hashes[side])
    if (sides.length > 0) out.push(`section ${key} changed since confirmation (${sides.join(', ')})`)
  }
  for (const key of recorded.keys()) {
    if (!current.has(key)) out.push(`section ${key} is recorded but no longer has translated content`)
  }
  return out
}
