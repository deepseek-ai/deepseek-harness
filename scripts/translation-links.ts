/** Locale-aware resolution and byte-preserving rewrites for bilingual Markdown links. */

import { existsSync, statSync } from 'node:fs'
import { posix, resolve } from 'node:path'
import type { Nodes } from 'mdast'
import {
  isExternalOrAbsoluteMarkdownUrl,
  markdownDestination,
  parseMarkdown,
  splitMarkdownUrlTarget,
  visitMarkdown,
  type MarkdownDestination,
} from './markdown.ts'

/** Repository and source document used to resolve one relative link. */
export interface TranslationLinkContext {
  /** Absolute repository root. */
  repoRoot: string
  /** Repository-relative Markdown source path. */
  sourcePath: string
  /** Whether an English Markdown path belongs to the active bilingual corpus. */
  isTranslationPairSource: (sourcePath: string) => boolean
  /** Selected content plane; defaults to regular files in the working tree. */
  repositoryFileExists?: (repoPath: string) => boolean
}

/** One relative document link whose target uses the wrong locale sibling. */
export interface TranslationLinkLocaleViolation {
  sourcePath: string
  line: number
  url: string
  expectedUrl: string
}

/** Result of rewriting wrong-locale relative document links. */
export interface TranslationLinkRewriteResult {
  content: string
  rewritten: number
}

interface TranslationPairTarget {
  source: string
  zh: string
}

interface ResolvedTranslationLink {
  pair: TranslationPairTarget
  targetPath: string
  suffix: string
  expectedPath: string
  expectedUrl: string
  locale: 'en' | 'zh'
}

interface Replacement {
  start: number
  end: number
  value: string
}

type LinkNode = Extract<Nodes, { type: 'link' | 'definition' }>

/** Offset of the one top-level switcher link immediately following the H1. */
export function languageSwitcherLinkOffset(
  tree: Nodes,
  markdown: string,
  acceptedTargets: string | readonly string[],
): number | undefined {
  if (tree.type !== 'root') return undefined
  const accepted = new Set(typeof acceptedTargets === 'string' ? [acceptedTargets] : acceptedTargets)
  const headingIndex = tree.children.findIndex(node => node.type === 'heading' && node.depth === 1)
  if (headingIndex < 0) return undefined
  for (const node of tree.children.slice(headingIndex + 1)) {
    if (node.type === 'heading') return undefined
    if (node.type !== 'paragraph' || node.position === undefined) continue
    const start = node.position.start.offset
    const end = node.position.end.offset
    if (start === undefined || end === undefined) continue
    const authored = markdown.slice(start, end)
    if (!/^(?:English \| \[中文\]\([^\n]+\)|\[English\]\([^\n]+\) \| 中文)$/.test(authored)) continue
    const links = node.children.filter((child): child is Extract<Nodes, { type: 'link' }> => child.type === 'link')
    if (links.length === 1 && accepted.has(links[0]?.url ?? '')) {
      return links[0]?.position?.start.offset
    }
  }
  return undefined
}

/** Whether the tree carries its canonical top-level language switcher. */
export function hasLanguageSwitcher(
  tree: Nodes,
  markdown: string,
  acceptedTargets: string | readonly string[],
): boolean {
  return languageSwitcherLinkOffset(tree, markdown, acceptedTargets) !== undefined
}

function decodePath(path: string): string {
  try {
    return decodeURIComponent(path)
  } catch {
    return path
  }
}

function worktreeFileExists(repoRoot: string, repoPath: string): boolean {
  try {
    const path = resolve(repoRoot, repoPath)
    return existsSync(path) && statSync(path).isFile()
  } catch {
    return false
  }
}

function repositoryFileExists(context: TranslationLinkContext, repoPath: string): boolean {
  return context.repositoryFileExists?.(repoPath) ?? worktreeFileExists(context.repoRoot, repoPath)
}

function repositoryRelativePath(path: string): string | undefined {
  const normalized = posix.normalize(path)
  if (normalized === '' || normalized === '.' || normalized === '..' || normalized.startsWith('../') || posix.isAbsolute(normalized)) {
    return undefined
  }
  return normalized
}

function resolveRepositoryTarget(
  rawPath: string,
  context: TranslationLinkContext,
): string | undefined {
  const decoded = decodePath(rawPath)
  const exact = repositoryRelativePath(posix.join(posix.dirname(context.sourcePath), decoded))
  if (exact === undefined) return undefined
  return repositoryFileExists(context, exact) ? exact : undefined
}

function translationPairTarget(targetPath: string, context: TranslationLinkContext): TranslationPairTarget | undefined {
  const source = targetPath.endsWith('.zh.md')
    ? targetPath.replace(/\.zh\.md$/, '.md')
    : targetPath.endsWith('.md') ? targetPath : undefined
  if (source === undefined || !context.isTranslationPairSource(source)) return undefined
  const zh = source.replace(/\.md$/, '.zh.md')
  return { source, zh }
}

function encodePathSegment(segment: string): string {
  return encodeURIComponent(segment).replace(/[!'()*]/g, character => (
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  ))
}

function relativeExpectedPath(
  context: TranslationLinkContext,
  expectedPath: string,
  rawPath: string,
): string {
  const relative = posix.relative(posix.dirname(context.sourcePath), expectedPath)
  const encoded = relative.split('/').map(encodePathSegment).join('/')
  return rawPath.startsWith('./') && !encoded.startsWith('.') ? `./${encoded}` : encoded
}

function expectedLocalePath(
  rawPath: string,
  locale: 'en' | 'zh',
  context: TranslationLinkContext,
  expectedPath: string,
): string {
  if (locale === 'zh' && rawPath.endsWith('.md') && !rawPath.endsWith('.zh.md')) {
    return rawPath.replace(/\.md$/, '.zh.md')
  }
  if (locale === 'en' && rawPath.endsWith('.zh.md')) return rawPath.replace(/\.zh\.md$/, '.md')
  return relativeExpectedPath(context, expectedPath, rawPath)
}

function resolveTranslationLink(
  url: string,
  context: TranslationLinkContext,
  authoredUrl: string,
): ResolvedTranslationLink | undefined {
  if (isExternalOrAbsoluteMarkdownUrl(url)) return undefined
  const { path } = splitMarkdownUrlTarget(url)
  const authored = splitMarkdownUrlTarget(authoredUrl)
  if (path === '') return undefined
  const targetPath = resolveRepositoryTarget(path, context)
  if (targetPath === undefined) return undefined
  const pair = translationPairTarget(targetPath, context)
  if (pair === undefined) return undefined
  const locale = context.sourcePath.endsWith('.zh.md') ? 'zh' : 'en'
  const expectedPath = locale === 'zh' ? pair.zh : pair.source
  return {
    pair,
    targetPath,
    suffix: authored.suffix,
    expectedPath,
    expectedUrl: `${expectedLocalePath(authored.path, locale, context, expectedPath)}${authored.suffix}`,
    locale,
  }
}

function hasExpectedLocale(resolved: ResolvedTranslationLink): boolean {
  return resolved.targetPath === resolved.expectedPath
}

function replacementFor(destination: MarkdownDestination, value: string): Replacement {
  return { start: destination.start, end: destination.end, value }
}

function authoredExternalTarget(markdown: string, node: LinkNode): string {
  const start = node.position?.start.offset
  const end = node.position?.end.offset
  if (start === undefined || end === undefined) {
    throw new Error(`translation-links: external link ${JSON.stringify(node.url)} has no source offsets`)
  }
  const raw = markdown.slice(start, end)
  if (node.type === 'definition' || raw.startsWith('[')) return markdownDestination(markdown, node).url
  if (raw.startsWith('<') && raw.endsWith('>')) return raw.slice(1, -1)
  return raw
}

function applyReplacements(markdown: string, replacements: Replacement[]): string {
  let output = markdown
  for (const replacement of replacements.sort((left, right) => right.start - left.start)) {
    output = output.slice(0, replacement.start) + replacement.value + output.slice(replacement.end)
  }
  return output
}

function visitDocumentLinkNodes(
  markdown: string,
  skipTargets: readonly string[],
  visitor: (node: LinkNode) => void,
  tree: Nodes = parseMarkdown(markdown),
): void {
  const switcherOffset = languageSwitcherLinkOffset(tree, markdown, skipTargets)
  const referencedIdentifiers = new Set<string>()
  const visitedDefinitions = new Set<string>()
  visitMarkdown(tree, (node) => {
    if (node.type === 'linkReference') referencedIdentifiers.add(node.identifier)
  })
  visitMarkdown(tree, (node) => {
    if (node.type === 'link' && node.position?.start.offset === switcherOffset) return
    if (node.type === 'link') {
      visitor(node)
    } else if (node.type === 'definition'
      && referencedIdentifiers.has(node.identifier)
      && !visitedDefinitions.has(node.identifier)) {
      visitedDefinitions.add(node.identifier)
      visitor(node)
    }
  })
}

function visitResolvedDocumentLinks(
  markdown: string,
  context: TranslationLinkContext,
  skipTargets: readonly string[],
  visitor: (node: LinkNode, destination: MarkdownDestination, resolved: ResolvedTranslationLink) => void,
  tree?: Nodes,
): void {
  visitDocumentLinkNodes(markdown, skipTargets, (node) => {
    if (isExternalOrAbsoluteMarkdownUrl(node.url)) return
    const destination = markdownDestination(markdown, node)
    const resolved = resolveTranslationLink(node.url, context, destination.url)
    if (resolved !== undefined) visitor(node, destination, resolved)
  }, tree)
}

/**
 * Return one violation per wrong-locale link or link definition.
 * @param markdown - Exact authored Markdown text used for link offsets.
 * @param context - Repository and locale used to resolve relative links.
 * @param skipTargets - Accepted language-switcher destinations.
 * @param tree - Optional GFM parse of this exact Markdown text; never a normalized or edited document.
 * @returns Wrong-locale links in document order.
 */
export function translationLinkLocaleViolations(
  markdown: string,
  context: TranslationLinkContext,
  skipTargets: readonly string[] = [],
  tree?: Nodes,
): TranslationLinkLocaleViolation[] {
  const violations: TranslationLinkLocaleViolation[] = []
  visitResolvedDocumentLinks(markdown, context, skipTargets, (node, destination, resolved) => {
    if (hasExpectedLocale(resolved)) return
    violations.push({
      sourcePath: context.sourcePath,
      line: node.position?.start.line ?? 0,
      url: destination.url,
      expectedUrl: resolved.expectedUrl,
    })
  }, tree)
  return violations
}

/** Rewrite wrong-locale document links without reserializing surrounding Markdown. */
export function rewriteTranslationLinkLocales(
  markdown: string,
  context: TranslationLinkContext,
  skipTargets: readonly string[] = [],
): TranslationLinkRewriteResult {
  const replacements: Replacement[] = []
  visitResolvedDocumentLinks(markdown, context, skipTargets, (_node, destination, resolved) => {
    if (hasExpectedLocale(resolved)) return
    replacements.push(replacementFor(destination, resolved.expectedUrl))
  })
  return { content: applyReplacements(markdown, replacements), rewritten: replacements.length }
}

/**
 * Normalize only paired-document locale paths while retaining every other byte and URL suffix.
 * @param markdown - Exact authored Markdown text used for link offsets.
 * @param context - Repository and locale used to resolve relative links.
 * @param skipTargets - Accepted language-switcher destinations.
 * @param tree - Optional GFM parse of this exact Markdown text; never a normalized or edited document.
 * @returns Markdown with paired-document destinations replaced by semantic targets.
 */
export function normalizeTranslationMarkdownLinks(
  markdown: string,
  context: TranslationLinkContext,
  skipTargets: readonly string[] = [],
  tree?: Nodes,
): string {
  const replacements: Replacement[] = []
  visitResolvedDocumentLinks(markdown, context, skipTargets, (_node, destination, resolved) => {
    replacements.push(replacementFor(
      destination,
      `dsh-translation-target:${resolved.pair.source}${resolved.suffix}`,
    ))
  }, tree)
  return applyReplacements(markdown, replacements)
}

/** Semantic target of one authored inline link or referenced definition. */
export function semanticTranslationLinkNodeTarget(
  node: LinkNode,
  markdown: string,
  context: TranslationLinkContext,
): string {
  if (isExternalOrAbsoluteMarkdownUrl(node.url)) return authoredExternalTarget(markdown, node)
  const destination = markdownDestination(markdown, node)
  const resolved = resolveTranslationLink(node.url, context, destination.url)
  return resolved === undefined
    ? destination.url
    : `dsh-translation-target:${resolved.pair.source}${resolved.suffix}`
}
