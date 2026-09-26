/**
 * Build-time projection from canonical repository Markdown into VitePress.
 *
 * The generated tree is disposable: sources stay in their owning `docs/`
 * tier, while this adapter rewrites cross-source links for the public site.
 * The same projection also emits a raw-Markdown twin of every route into the
 * build output, so a page's URL, minus any trailing slash, plus `.md` serves
 * it as plain Markdown.
 */

import {
  copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { basename, dirname, extname, posix, relative, resolve, sep } from 'node:path'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { gfm } from 'micromark-extension-gfm'
import type { Nodes } from 'mdast'
import { docsPages, localeCollections, orderedPages, type DocsLocale, type DocsPage } from '../website/docs.ts'
import {
  isExternalOrAbsoluteMarkdownUrl,
  markdownDestination,
  splitMarkdownUrlTarget,
} from './markdown.ts'

const REPOSITORY_URL = 'https://github.com/deepseek-ai/deepseek-harness'
const root = resolve(import.meta.dirname, '..')
const generatedRoot = resolve(root, 'website/.generated')

/**
 * Resolve the public repository ref used by projected source links.
 *
 * @param environment Build environment containing an optional explicit public ref.
 * @returns The configured public ref, or `master`.
 */
export function resolveRepositoryRef(environment: NodeJS.ProcessEnv): string {
  return environment.DOCS_REPOSITORY_REF ?? 'master'
}

interface Replacement {
  start: number
  end: number
  value: string
}

type RewritableNode = Extract<Nodes, { type: 'link' | 'image' | 'definition' }>

/** Inputs for rewriting one canonical Markdown page. */
export interface RewriteMarkdownOptions {
  locale: DocsLocale
  sourcePath: string
  route: string
  pages: DocsPage[]
  repoRoot: string
  repositoryRef: string
  /**
   * Place one referenced image beside the projected page and return the URL to
   * reach it from that page. A GitHub raw URL cannot serve this repository —
   * `raw.githubusercontent.com` answers 404 for a private one, and no reader of
   * the site is authenticated to it — so an image travels into the generated
   * tree and Vite bundles it like any other site asset. Omitted by callers that
   * only rewrite text, which then leave images pointing at the repository.
   */
  placeImage?: (absPath: string) => string
}

function repoPath(absPath: string, repoRoot: string): string {
  return relative(repoRoot, absPath).split(sep).join('/')
}

// `#fragment` suffixes pass through verbatim. Generated cordis-surface
// headings carry explicit `<a id>` anchors with the GitHub slug, so those
// fragments resolve on the published site too; hand-written headings rely on
// VitePress's own slugger, which differs from GitHub's for punctuation-heavy
// text — hand-authored cross-page fragments should prefer plain-text headings
// or explicit anchors.
function decodePath(path: string): string {
  try {
    return decodeURIComponent(path)
  } catch {
    throw new Error(`project-doc-site: malformed percent escape in ${JSON.stringify(path)}.`)
  }
}

function routeTarget(fromRoute: string, toRoute: string, suffix: string): string {
  const target = posix.relative(posix.dirname(fromRoute), toRoute)
  return `${target.startsWith('.') ? target : `./${target}`}${suffix}`
}

function sourceMap(pages: DocsPage[]): Map<string, Map<DocsLocale, DocsPage>> {
  const map = new Map<string, Map<DocsLocale, DocsPage>>()
  for (const page of pages) {
    for (const source of [page.source, ...(page.sourceAliases ?? [])]) {
      const localized = map.get(source) ?? new Map<DocsLocale, DocsPage>()
      if (localized.has(page.locale)) {
        throw new Error(`project-doc-site: duplicate source or alias ${JSON.stringify(source)} for locale ${JSON.stringify(page.locale)}.`)
      }
      localized.set(page.locale, page)
      map.set(source, localized)
    }
  }
  return map
}

function counterpartSource(source: string): string {
  return source.endsWith('.zh.md')
    ? source.replace(/\.zh\.md$/, '.md')
    : source.replace(/\.md$/, '.zh.md')
}

function resolveRepositoryTarget(sourceAbs: string, rawPath: string, repoRoot: string): { absPath: string; line?: number } {
  const decoded = decodePath(rawPath)
  let absPath = resolve(dirname(sourceAbs), decoded)
  if (existsSync(absPath)) return { absPath }

  const lineMatch = decoded.match(/:(\d+)$/)
  if (lineMatch !== null) {
    const lineText = lineMatch[1]
    if (lineText === undefined) throw new Error('project-doc-site: line suffix matched without a line number.')
    absPath = resolve(dirname(sourceAbs), decoded.slice(0, -lineMatch[0].length))
    if (existsSync(absPath)) return { absPath, line: Number.parseInt(lineText, 10) }
  }

  if (extname(decoded) === '') {
    const markdown = resolve(dirname(sourceAbs), `${decoded}.md`)
    if (existsSync(markdown)) return { absPath: markdown }
    const index = resolve(dirname(sourceAbs), decoded, 'index.md')
    if (existsSync(index)) return { absPath: index }
  }

  throw new Error(`project-doc-site: ${repoPath(sourceAbs, repoRoot)} links to missing path ${JSON.stringify(rawPath)}.`)
}

function githubTarget(
  absPath: string,
  line: number | undefined,
  suffix: string,
  repositoryRef: string,
  repoRoot: string,
  image: boolean,
): string {
  const path = repoPath(absPath, repoRoot)
  if (image) return `https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/${repositoryRef}/${path}${suffix}`
  const kind = lstatSync(absPath).isDirectory() ? 'tree' : 'blob'
  const lineSuffix = line === undefined ? suffix : `#L${line}`
  return `${REPOSITORY_URL}/${kind}/${repositoryRef}/${path}${lineSuffix}`
}

/**
 * Rewrite repository-relative links without reserializing Markdown.
 *
 * @param source Markdown text from the canonical file.
 * @param options Source, route, manifest, and repository context.
 * @returns Markdown whose published links resolve inside the site or to GitHub.
 */
export function rewriteMarkdown(source: string, options: RewriteMarkdownOptions): string {
  const sourceAbs = resolve(options.repoRoot, options.sourcePath)
  const published = sourceMap(options.pages)
  const tree = fromMarkdown(source, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] })
  const replacements: Replacement[] = []

  const rewrite = (node: RewritableNode): void => {
    if (isExternalOrAbsoluteMarkdownUrl(node.url)) return
    const { path, suffix } = splitMarkdownUrlTarget(node.url)
    if (path === '') return
    const { absPath, line } = resolveRepositoryTarget(sourceAbs, path, options.repoRoot)
    const targetPath = repoPath(absPath, options.repoRoot)
    const isLanguageSwitcher = targetPath === counterpartSource(options.sourcePath)
    const targetLocale: DocsLocale = isLanguageSwitcher
      ? options.locale === 'root' ? 'en' : 'root'
      : options.locale
    const page = published.get(targetPath)?.get(targetLocale)
    const nextUrl = page !== undefined
      ? routeTarget(options.route, page.route, suffix)
      : node.type === 'image' && options.placeImage !== undefined
        // The suffix rides along exactly as the GitHub branch keeps it: an SVG
        // view fragment or a Vite query changes what the reference means.
        ? `${options.placeImage(absPath)}${suffix}`
        : githubTarget(absPath, line, suffix, options.repositoryRef, options.repoRoot, node.type === 'image')

    const destination = markdownDestination(source, node)
    replacements.push({
      start: destination.start,
      end: destination.end,
      value: nextUrl,
    })
  }

  const visit = (node: Nodes): void => {
    if ((node.type === 'link' || node.type === 'image' || node.type === 'definition') && 'url' in node) rewrite(node)
    if ('children' in node) {
      for (const child of node.children) visit(child)
    }
  }
  visit(tree)

  let projected = source
  for (const replacement of replacements.sort((a, b) => b.start - a.start)) {
    projected = projected.slice(0, replacement.start) + replacement.value + projected.slice(replacement.end)
  }
  return projected
}

/**
 * Record canonical edit and raw-Markdown targets in VitePress frontmatter.
 *
 * @param markdown Projected Markdown content.
 * @param page Publication manifest entry for the content.
 * @returns Markdown with projection-owned frontmatter fields.
 */
export function addProjectionFrontmatter(markdown: string, page: Pick<DocsPage, 'source' | 'outline' | 'route' | 'sidebar'>): string {
  const fields = [
    `editSource: ${JSON.stringify(page.source)}`,
    ...(page.sidebar === null ? [] : [`rawMarkdownPath: ${JSON.stringify(page.route)}`]),
    ...(page.outline === undefined ? [] : [`outline: ${JSON.stringify(page.outline)}`]),
  ].join('\n')
  if (markdown.startsWith('---\n')) return markdown.replace('---\n', `---\n${fields}\n`)
  return `---\n${fields}\n---\n\n${markdown}`
}

/** The switcher line a canonical page carries so its GitHub reader can reach the other language. */
const LANGUAGE_SWITCHER = /^(?:English \| \[中文\]\([^)]*\)|\[English\]\([^)]*\) \| 中文)$/

/** The repository badge a canonical page carries for its GitHub reader. */
const REPOSITORY_BADGE = /^\[!\[[^\]]*\]\(https:\/\/img\.shields\.io\/[^)]*\)\]\([^)]*\)$/

/**
 * Drop the lines that address a canonical page's GitHub reader.
 *
 * The site carries a locale switcher in its navigation bar and links the
 * repository from every page, so projecting these lines would repeat both — the
 * switcher as the first element under each heading.
 *
 * @param markdown Rewritten canonical Markdown content.
 * @returns The content without the switcher line or the repository badge.
 */
function withoutRepositoryChrome(markdown: string): string {
  const lines = markdown.split('\n')
  const switcher = lines.findIndex(line => LANGUAGE_SWITCHER.test(line))
  // Only the switcher introducing the page qualifies; further down the same
  // text is prose or a sample rather than the page's own header.
  if (switcher !== -1 && switcher < 8) {
    lines.splice(switcher, lines[switcher + 1] === '' ? 2 : 1)
  }
  const badge = lines.findLastIndex(line => REPOSITORY_BADGE.test(line))
  if (badge !== -1) {
    lines.splice(lines[badge - 1] === '' ? badge - 1 : badge, lines[badge - 1] === '' ? 2 : 1)
  }
  return lines.join('\n')
}

/**
 * Select the Markdown rendered for one published page.
 *
 * @param markdown Rewritten canonical Markdown content.
 * @param page Publication manifest entry for the content.
 * @returns Full Markdown for ordinary pages or frontmatter-only Markdown for a locale home page.
 */
export function projectedPageContent(markdown: string, page: DocsPage): string {
  if (page.sidebar !== null) return withoutRepositoryChrome(markdown)
  if (!markdown.startsWith('---\n')) {
    throw new Error(`project-doc-site: locale home source ${JSON.stringify(page.source)} must start with YAML frontmatter.`)
  }
  const closingDelimiter = '\n---\n'
  const closing = markdown.indexOf(closingDelimiter, 4)
  if (closing === -1) {
    throw new Error(`project-doc-site: locale home source ${JSON.stringify(page.source)} has unclosed YAML frontmatter.`)
  }
  return markdown.slice(0, closing + closingDelimiter.length)
}

/**
 * The repository file one image reference resolves to, or `undefined` when the
 * target is not a local file this build may publish.
 * @param absPath - resolved image target.
 * @param repoRoot - repository root every published image must stay inside.
 * @returns the file's real path, or `undefined` when it must not be copied.
 *
 * Only a regular file whose real path stays inside the repository qualifies.
 * Publication copies the bytes into the site, so a reference escaping the
 * repository — `../../.ssh/id_rsa`, or a symlink pointing out of the tree —
 * would put a build-machine file on the site; `existsSync` alone, which is all
 * link resolution needs, does not answer that.
 */
export function publishableImage(absPath: string, repoRoot: string): string | undefined {
  const real = realpathSync(absPath)
  const inside = real === repoRoot || real.startsWith(`${repoRoot}${sep}`)
  return inside && statSync(real).isFile() ? real : undefined
}

/** Every local image a published page references, resolved to its repository file. */
function referencedImages(): string[] {
  const found = new Set<string>()
  for (const page of docsPages) {
    const sourceAbs = resolve(root, page.source)
    if (!existsSync(sourceAbs)) continue
    rewriteMarkdown(readFileSync(sourceAbs, 'utf8'), {
      sourcePath: page.source,
      locale: page.locale,
      route: page.route,
      pages: docsPages,
      repoRoot: root,
      repositoryRef: 'master',
      placeImage: (absPath) => {
        const real = publishableImage(absPath, root)
        if (real !== undefined) found.add(real)
        return ''
      },
    })
  }
  return [...found]
}

/**
 * Files watched by the local VitePress dev server: every canonical Markdown
 * source, plus the images they publish. Without the images, replacing a
 * screenshot leaves the previous copy in the generated tree until something
 * touches the Markdown beside it.
 */
export function docsSourceFiles(): string[] {
  return [...new Set([...docsPages.map(page => resolve(root, page.source)), ...referencedImages()])]
}

/** Manifest and repository inputs for one projection pass. */
export interface ProjectionContext {
  /** Pages to project. */
  pages: DocsPage[]
  /** Repository root every source and placed image must live under. */
  repoRoot: string
  /** Public ref used by projected GitHub links. */
  repositoryRef: string
}

function defaultProjectionContext(): ProjectionContext {
  return { pages: docsPages, repoRoot: root, repositoryRef: resolveRepositoryRef(process.env) }
}

/**
 * Project every page and its images into one target tree.
 *
 * `entries` are what gets emitted; link resolution always reads the canonical
 * `context.pages`, so an alias entry sharing a source with its index route
 * emits at its own path while links keep targeting canonical routes.
 */
function projectPagesInto(
  targetRoot: string,
  context: ProjectionContext,
  pageContent: (markdown: string, page: DocsPage) => string,
  entries: DocsPage[] = context.pages,
): void {
  const routes = new Set<string>()
  /** Projected path to the repository file that claimed it, pages and images alike. */
  const claimed = new Map<string, string>()

  /** Reserve one projected path, refusing a second source for it. */
  const claim = (target: string, sourceAbs: string): void => {
    const holder = claimed.get(target)
    if (holder !== undefined && holder !== sourceAbs) {
      throw new Error(
        `project-doc-site: ${repoPath(sourceAbs, context.repoRoot)} and ${repoPath(holder, context.repoRoot)}`
        + ` both project to ${relative(targetRoot, target).split(sep).join('/')}.`,
      )
    }
    // A file the projection did not claim is another producer's output — in
    // the twin pass, the build VitePress just wrote, including `public/`
    // copies. Overwriting one would silently corrupt the site.
    if (holder === undefined && existsSync(target)) {
      throw new Error(
        `project-doc-site: ${repoPath(sourceAbs, context.repoRoot)} would overwrite existing build file`
        + ` ${relative(targetRoot, target).split(sep).join('/')}.`,
      )
    }
    claimed.set(target, sourceAbs)
  }

  for (const page of entries) {
    if (routes.has(page.route)) throw new Error(`project-doc-site: duplicate route ${JSON.stringify(page.route)}.`)
    routes.add(page.route)
    const sourceAbs = resolve(context.repoRoot, page.source)
    if (!existsSync(sourceAbs) || !lstatSync(sourceAbs).isFile()) {
      throw new Error(`project-doc-site: source ${JSON.stringify(page.source)} does not exist or is not a file.`)
    }
    const output = resolve(targetRoot, page.route)
    // Claimed before the images are placed: a page and an image landing on one
    // path would otherwise overwrite each other in whichever order they ran.
    claim(output, sourceAbs)
    mkdirSync(dirname(output), { recursive: true })
    const markdown = readFileSync(sourceAbs, 'utf8')
    const projected = rewriteMarkdown(markdown, {
      sourcePath: page.source,
      locale: page.locale,
      route: page.route,
      pages: context.pages,
      repoRoot: context.repoRoot,
      repositoryRef: context.repositoryRef,
      placeImage: (absPath) => {
        const real = publishableImage(absPath, context.repoRoot)
        if (real === undefined) {
          throw new Error(
            `project-doc-site: ${page.source} references image ${repoPath(absPath, context.repoRoot)},`
            + ' which is not a regular file inside the repository.',
          )
        }
        // Beside the page that references it, under its own basename: each
        // locale's route tree gets its own copy, so one relative URL is correct
        // from both.
        const name = basename(real)
        const target = resolve(dirname(output), name)
        claim(target, real)
        copyFileSync(real, target)
        // Encoded because the destination is a Markdown inline target, where an
        // unescaped space would end it early.
        return `./${encodeURI(name)}`
      },
    })
    writeFileSync(output, pageContent(projected, page))
  }
}

/** Rebuild the disposable VitePress source tree from the publication manifest. */
export function projectDocs(): void {
  rmSync(generatedRoot, { recursive: true, force: true })
  projectPagesInto(generatedRoot, defaultProjectionContext(), (markdown, page) =>
    addProjectionFrontmatter(projectedPageContent(markdown, page), page))
}

/**
 * Strip the leading YAML frontmatter of a projected page.
 *
 * @param markdown Rewritten canonical Markdown content.
 * @param source Repository-relative page source, named by the failure.
 * @returns The content after the frontmatter block, or the input when none opens it.
 */
function withoutFrontmatter(markdown: string, source: string): string {
  if (!markdown.startsWith('---\n')) return markdown
  const closingDelimiter = '\n---\n'
  const closing = markdown.indexOf(closingDelimiter, 4)
  if (closing === -1) {
    throw new Error(`project-doc-site: ${JSON.stringify(source)} has unclosed YAML frontmatter.`)
  }
  return markdown.slice(closing + closingDelimiter.length).replace(/^\n+/, '')
}

/**
 * The raw-Markdown twin of one published page.
 *
 * Frontmatter is VitePress rendering configuration and is dropped. A locale
 * home page therefore keeps its body here, while the rendered site truncates
 * it to the frontmatter redirect.
 *
 * @param markdown Rewritten canonical Markdown content.
 * @param source Repository-relative page source, named by frontmatter failures.
 * @returns Plain Markdown without frontmatter or repository chrome.
 */
export function rawMarkdownPageContent(markdown: string, source: string): string {
  return withoutRepositoryChrome(withoutFrontmatter(markdown, source))
}

/**
 * Parent-level alias route of an index route, or `undefined` for other routes.
 *
 * The rendered site shows an index route as a directory URL, so "append
 * `.md`" naturally lands on `<dir>.md` once the trailing slash is dropped.
 * The root `index.md` has no parent to alias into.
 */
function indexAliasRoute(route: string): string | undefined {
  const match = /^(.+)\/index\.md$/.exec(route)
  return match?.[1] === undefined ? undefined : `${match[1]}.md`
}

/**
 * Site-relative Markdown files the raw-Markdown projection emits: every
 * route, plus one parent-level alias per index route.
 *
 * @param pages Pages to project, defaulting to the publication manifest.
 * @returns The emitted paths, routes first.
 */
export function rawMarkdownFiles(pages: DocsPage[] = docsPages): string[] {
  const aliases = pages.map(page => indexAliasRoute(page.route)).filter(alias => alias !== undefined)
  return [...pages.map(page => page.route), ...aliases]
}

/**
 * Emit the raw-Markdown twin of every published route into a built site, so
 * static hosting serves the page's URL, minus any trailing slash, plus `.md`
 * as plain Markdown. Each index route also emits a parent-level alias twin,
 * projected over the alias route so its relative links stay correct.
 * Referenced images are copied beside the pages, keeping the same relative
 * URLs valid in both trees. Existing build files stay in place, and a name
 * collision with one fails the emission. Markdown files carry a UTF-8 BOM so
 * browser navigation decodes them even when static hosting omits a charset.
 *
 * @param outDir Build output directory to emit into.
 * @param context Manifest and repository inputs, defaulting to this repository.
 */
export function emitRawMarkdownPages(outDir: string, context: ProjectionContext = defaultProjectionContext()): void {
  const aliases = context.pages.flatMap((page) => {
    const alias = indexAliasRoute(page.route)
    return alias === undefined ? [] : [{ ...page, route: alias }]
  })
  projectPagesInto(
    outDir,
    context,
    (markdown, page) => `\uFEFF${rawMarkdownPageContent(markdown, page.source)}`,
    [...context.pages, ...aliases],
  )
}

/**
 * Raw Markdown served for one site route.
 *
 * Dev-server counterpart of {@link emitRawMarkdownPages}: images are not
 * copied because the generated tree already serves them beside the page.
 *
 * @param route Manifest route, including its `.md` suffix.
 * @param context Manifest and repository inputs, defaulting to this repository.
 * @returns The projected page, or `undefined` when the manifest does not publish the route.
 */
export function rawMarkdownRoute(route: string, context: ProjectionContext = defaultProjectionContext()): string | undefined {
  const page = context.pages.find(candidate => candidate.route === route)
  if (page === undefined) return undefined
  const markdown = readFileSync(resolve(context.repoRoot, page.source), 'utf8')
  return rawMarkdownPageContent(rewriteMarkdown(markdown, {
    sourcePath: page.source,
    locale: page.locale,
    route: page.route,
    pages: context.pages,
    repoRoot: context.repoRoot,
    repositoryRef: context.repositoryRef,
    placeImage: absPath => `./${encodeURI(basename(absPath))}`,
  }), page.source)
}

/** Site identity written into llms.txt. */
export interface LlmsTxtSite {
  /** Site base path, carrying the leading and trailing slashes VitePress requires. */
  base: string
  /** Site title. */
  title: string
  /** Site description. */
  description: string
}

/** Locale groups llms.txt lists, in the order the site's navigation presents them. */
const llmsTxtLocales: readonly { heading: string; locale: DocsLocale }[] = [
  { heading: '简体中文', locale: 'root' },
  { heading: 'English', locale: 'en' },
]

/**
 * The llms.txt index of every published page's raw-Markdown twin.
 *
 * Links are site-absolute so an agent resolves them against the host it
 * fetched llms.txt from; locale home pages stay out because this file is the
 * agent-facing entry point itself.
 *
 * @param site Site identity and base path.
 * @returns llms.txt content listing both locale trees.
 */
export function llmsTxt(site: LlmsTxtSite): string {
  const lines = [
    `# ${site.title}`,
    '',
    `> ${site.description}`,
    '',
    '页面 URL 去掉末尾斜杠再加 `.md` 即为该页原始 Markdown(根路径用 `/index.md`);下方列表是各页精确地址。Drop any trailing slash and append `.md` to a page URL for its raw Markdown (the site root is `/index.md`); the list below carries the exact addresses.',
  ]
  for (const { heading, locale } of llmsTxtLocales) {
    lines.push('', `## ${heading}`, '')
    for (const collection of localeCollections[locale]) {
      for (const page of orderedPages(locale, collection)) {
        lines.push(`- [${page.label}](${site.base}${page.route}): ${page.section}`)
      }
    }
  }
  return `${lines.join('\n')}\n`
}
