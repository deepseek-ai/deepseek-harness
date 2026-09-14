/** VitePress configuration for the locally projected documentation site. */

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { DefaultTheme, PageData, SiteConfig } from 'vitepress'
import type { ViteDevServer } from 'vite'
import { withMermaid } from 'vitepress-plugin-mermaid'
import { landingLink, localeCollections, orderedPages, routeLink, sectionSpec, type DocsLocale, type DocsPage, type DocsSidebar } from '../docs.ts'
import { docsSourceFiles, emitRawMarkdownPages, llmsTxt, projectDocs, rawMarkdownRoute } from '../../scripts/project-doc-site.ts'

projectDocs()

function sidebar(locale: DocsLocale, collection: NonNullable<DocsPage['sidebar']>): DefaultTheme.SidebarItem[] {
  // `orderedPages` already sorts by section placement, so insertion order
  // carries the group order and each group keeps its pages in sequence.
  const groups = new Map<string, DocsPage[]>()
  for (const page of orderedPages(locale, collection)) {
    const entries = groups.get(page.section) ?? []
    entries.push(page)
    groups.set(page.section, entries)
  }
  return [...groups.entries()].map(([text, entries]) => {
    const { collapsed } = sectionSpec(locale, text)
    return {
      text,
      // A present `collapsed` is what makes the default theme render the
      // group as collapsible at all, so an open group must omit the key.
      ...(collapsed === undefined ? {} : { collapsed }),
      items: entries.map(page => ({ text: page.label, link: routeLink(page.route) })),
    }
  })
}

/** One module link shared between the navigation bar and the guide sidebar. */
interface GuideModuleLink {
  /** Label shown in the navigation bar and the guide sidebar. */
  label: string
  /** Sidebar collection the link opens. */
  collection: DocsSidebar
}

/**
 * Per-locale guide-module facts: the guide collection and the module links
 * appended to the guide sidebar.
 */
interface GuideModules {
  /** Guide sidebar collection for the locale. */
  guide: 'zh-guide' | 'en-guide'
  /** Development module link. */
  develop: GuideModuleLink
  /** Reference module link. */
  reference: GuideModuleLink
}

/**
 * Guide-module facts keyed by locale, giving every module label and collection
 * one home shared by the navigation bar and the guide sidebar.
 */
const guideModules = {
  root: {
    guide: localeCollections.root[0],
    develop: { label: '开发', collection: localeCollections.root[1] },
    reference: { label: '参考', collection: localeCollections.root[2] },
  },
  en: {
    guide: localeCollections.en[0],
    develop: { label: 'Development', collection: localeCollections.en[1] },
    reference: { label: 'Reference', collection: localeCollections.en[2] },
  },
} satisfies Record<DocsLocale, GuideModules>

/**
 * Guide sidebar with direct links into the first development and reference pages.
 *
 * @param locale - Route tree whose guide sidebar is being built.
 * @returns Guide groups followed by top-level links to the other documentation modules.
 */
function guideSidebar(locale: DocsLocale): DefaultTheme.SidebarItem[] {
  const { guide, develop, reference } = guideModules[locale]
  return [
    ...sidebar(locale, guide),
    ...[develop, reference].map(({ label, collection }) => ({
      text: label,
      link: landingLink(locale, collection),
    })),
  ]
}

/**
 * Navigation-bar items for the modules the guide sidebar links into, reading
 * their labels and collections from the shared per-locale record.
 *
 * @param locale - Route tree the navigation items belong to.
 * @returns The module items for the locale's navigation bar.
 */
function moduleNav(locale: DocsLocale): DefaultTheme.NavItem[] {
  const { develop, reference } = guideModules[locale]
  const routePrefix = locale === 'root' ? '' : '/en'
  return [
    { text: develop.label, link: landingLink(locale, develop.collection), activeMatch: `^${routePrefix}/develop/` },
    { text: reference.label, link: landingLink(locale, reference.collection), activeMatch: `^${routePrefix}/reference/` },
  ]
}

function watchCanonicalDocs(server: ViteDevServer): void {
  const sources = docsSourceFiles()
  server.watcher.add(sources)
  server.watcher.on('change', (changed) => {
    if (!sources.includes(changed)) return
    projectDocs()
  })
}

/**
 * Serve the raw-Markdown twin of each route and llms.txt during development,
 * matching what `buildEnd` emits into the static build. Pages project from
 * their canonical sources per request, so an edit shows without a rebuild.
 */
function serveRawMarkdown(server: ViteDevServer): void {
  server.middlewares.use((req, res, next) => {
    if (req.url === undefined || (req.method !== 'GET' && req.method !== 'HEAD')) {
      next()
      return
    }
    // The dev client imports page modules at these same `.md` URLs, and a
    // module script must reach Vite's transform. Browsers declare the purpose:
    // `script` for module imports, `document` for address-bar navigation.
    // Header-less clients (curl, agents) read the raw twin. In-page fetch()
    // (`empty`) also passes to Vite — a deliberate dev-only divergence that
    // keeps Vite's own requests unbroken, while production static hosting
    // answers such a fetch with the raw file.
    const fetchDest = req.headers['sec-fetch-dest']
    if (fetchDest !== undefined && fetchDest !== 'document') {
      next()
      return
    }
    const pathname = req.url.split(/[?#]/, 1)[0] ?? ''
    const sitePath = pathname.startsWith(base) ? pathname.slice(base.length) : pathname.replace(/^\//, '')
    if (sitePath === 'llms.txt') {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8')
      res.end(llmsTxt({ base, ...siteIdentity }))
      return
    }
    const content = sitePath.endsWith('.md') ? rawMarkdownRoute(sitePath) : undefined
    if (content === undefined) {
      next()
      return
    }
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8')
    res.end(content)
  })
}

function escapeVueInterpolation(html: string): string {
  return html.replaceAll('{{', '&#123;&#123;').replaceAll('}}', '&#125;&#125;')
}

const sharedTheme: Pick<DefaultTheme.Config, 'search' | 'socialLinks' | 'editLink'> = {
  search: {
    provider: 'local',
    options: {
      locales: {
        root: {
          translations: {
            button: {
              buttonText: '搜索文档',
              buttonAriaLabel: '搜索文档',
            },
            modal: {
              displayDetails: '显示详细列表',
              resetButtonTitle: '清除搜索',
              backButtonTitle: '关闭搜索',
              noResultsText: '未找到相关结果',
              footer: {
                selectText: '选择',
                selectKeyAriaLabel: '回车键',
                navigateText: '切换',
                navigateUpKeyAriaLabel: '上方向键',
                navigateDownKeyAriaLabel: '下方向键',
                closeText: '关闭',
                closeKeyAriaLabel: 'Esc 键',
              },
            },
          },
        },
      },
    },
  },
  socialLinks: [
    { icon: 'github', link: 'https://github.com/deepseek-ai/deepseek-harness' },
  ],
  editLink: {
    pattern: ({ frontmatter }: PageData) => {
      const data: unknown = frontmatter
      const editSource: unknown = typeof data === 'object' && data !== null ? Reflect.get(data, 'editSource') : undefined
      if (typeof editSource !== 'string') throw new Error('Projected documentation page has no editSource frontmatter.')
      return `https://github.com/deepseek-ai/deepseek-harness/edit/master/${editSource}`
    },
    text: '在 GitHub 上编辑此页',
  },
}

/** Site base path, carrying the leading and trailing slashes VitePress requires. */
const base = process.env.DOCS_BASE ?? '/'

/** Site identity shared by the VitePress configuration and the llms.txt index. */
const siteIdentity = {
  title: 'DeepSeek Harness',
  description: '用于构建 Agent Harness 的插件化 SDK',
}

/**
 * The DeepSeek wordmark, inlined so its `currentColor` fills follow the active
 * theme. An `<img>` would freeze the mark at the colors the file declares.
 */
const wordmark = readFileSync(resolve(import.meta.dirname, '../public/wordmark.svg'), 'utf8')
  .trim()
  .replace('<svg ', '<svg class="dsh-wordmark" ')

/**
 * Head-injected styles for the site identity and sidebar scrollbar.
 *
 * The navigation-bar lockup pairs with `siteTitle`. The scrollbar rules replace
 * the sidebar's platform bar, which reserves 15px of a 265px column and draws a
 * track the rest of the navigation has no border for; `scrollbarScript` supplies
 * the marker that reveals the thumb. Chrome drops `::-webkit-scrollbar` once
 * `scrollbar-width` is set to anything but `auto`, so the standard properties
 * stay behind a query only Firefox answers.
 */
const siteStyle = `
.dsh-lockup { display: inline-flex; align-items: center; gap: 8px; min-width: 0; }
.dsh-wordmark { display: block; height: 22px; width: auto; color: var(--vp-c-text-1); }
.dsh-tag {
  display: inline-flex;
  align-items: center;
  border: 1px solid var(--vp-c-brand-soft);
  border-radius: 999px;
  padding: 1px 9px;
  font-size: 12px;
  font-weight: 500;
  line-height: 18px;
  white-space: nowrap;
  color: var(--vp-c-brand-1);
}

.VPSidebar::-webkit-scrollbar { width: 6px; }
.VPSidebar::-webkit-scrollbar-track { background: transparent; }
.VPSidebar::-webkit-scrollbar-thumb {
  background-color: transparent;
  border-radius: 3px;
  transition: background-color 0.3s;
}
.VPSidebar[data-scrolling]::-webkit-scrollbar-thumb { background-color: var(--vp-c-text-3); }
@supports not selector(::-webkit-scrollbar) {
  .VPSidebar { scrollbar-width: thin; scrollbar-color: transparent transparent; }
  .VPSidebar[data-scrolling] { scrollbar-color: var(--vp-c-text-3) transparent; }
}
`

/**
 * Mark the sidebar while it scrolls, so its scrollbar rests invisible.
 *
 * A sized `::-webkit-scrollbar` opts the element out of the platform's
 * self-hiding overlay bar, leaving one painted at all times; nothing in CSS
 * reports that an element is scrolling. The listener captures instead of
 * bubbling because scroll events do not bubble, and marks a `data-` attribute
 * rather than a class because Vue rewrites `class` wholesale when it patches
 * the element.
 */
const scrollbarScript = `
(() => {
  let idle
  addEventListener('scroll', (event) => {
    const target = event.target
    if (!(target instanceof Element) || !target.classList.contains('VPSidebar')) return
    target.dataset.scrolling = ''
    clearTimeout(idle)
    idle = setTimeout(() => delete target.dataset.scrolling, 800)
  }, true)
})()
`

/**
 * Navigation-bar title: the DeepSeek wordmark and the release-stage tag.
 * VitePress renders `siteTitle` as HTML.
 *
 * @param previewTag - Localized release-stage label.
 * @returns Markup placed beside the navigation-bar home link.
 */
function siteTitle(previewTag: string): string {
  return `<span class="dsh-lockup">${wordmark}<span class="dsh-tag">${previewTag}</span></span>`
}

export default withMermaid({
  title: siteIdentity.title,
  description: siteIdentity.description,
  base,
  /** Emit the raw-Markdown twin of every route plus llms.txt beside the rendered site. */
  buildEnd(siteConfig: SiteConfig) {
    emitRawMarkdownPages(siteConfig.outDir)
    writeFileSync(resolve(siteConfig.outDir, 'llms.txt'), llmsTxt({ base, ...siteIdentity }))
  },
  head: [
    // VitePress leaves head hrefs untouched, so the base belongs here explicitly.
    ['link', { rel: 'icon', type: 'image/svg+xml', href: `${base}favicon.svg` }],
    ['style', {}, siteStyle],
    ['script', {}, scrollbarScript],
  ],
  cleanUrls: true,
  srcDir: '.generated',
  cacheDir: '.cache',
  outDir: '.dist',
  locales: {
    root: {
      label: '简体中文',
      lang: 'zh-CN',
      themeConfig: {
        siteTitle: siteTitle('技术预览'),
        nav: [
          { text: '入门', link: landingLink('root', guideModules.root.guide), activeMatch: '^/guide/' },
          ...moduleNav('root'),
        ],
        sidebar: {
          '/guide/': guideSidebar('root'),
          '/develop/': sidebar('root', 'zh-develop'),
          '/reference/': sidebar('root', 'zh-reference'),
        },
        outline: { label: '本页目录' },
        docFooter: { prev: '上一篇', next: '下一篇' },
        darkModeSwitchLabel: '外观',
        lightModeSwitchTitle: '切换到浅色主题',
        darkModeSwitchTitle: '切换到深色主题',
        sidebarMenuLabel: '菜单',
        returnToTopLabel: '返回顶部',
        langMenuLabel: '切换语言',
        skipToContentLabel: '跳至内容',
      },
    },
    en: {
      label: 'English',
      lang: 'en-US',
      link: '/en/',
      themeConfig: {
        siteTitle: siteTitle('Preview'),
        nav: [
          { text: 'Guide', link: landingLink('en', guideModules.en.guide), activeMatch: '^/en/guide/' },
          ...moduleNav('en'),
        ],
        sidebar: {
          '/en/guide/': guideSidebar('en'),
          '/en/develop/': sidebar('en', 'en-develop'),
          '/en/reference/': sidebar('en', 'en-reference'),
        },
        editLink: {
          pattern: ({ frontmatter }: PageData) => {
            const data: unknown = frontmatter
            const editSource: unknown = typeof data === 'object' && data !== null ? Reflect.get(data, 'editSource') : undefined
            if (typeof editSource !== 'string') throw new Error('Projected documentation page has no editSource frontmatter.')
            return `https://github.com/deepseek-ai/deepseek-harness/edit/master/${editSource}`
          },
          text: 'Edit this page on GitHub',
        },
        outline: { label: 'On this page' },
        docFooter: { prev: 'Previous', next: 'Next' },
      },
    },
  },
  vite: {
    // `srcDir` puts the Vite root inside the disposable generated tree, whose
    // own `public/` no tracked asset can live in.
    publicDir: resolve(import.meta.dirname, '../public'),
    plugins: [
      {
        name: 'deepseek-harness-doc-projector',
        configureServer(server) {
          watchCanonicalDocs(server)
          serveRawMarkdown(server)
        },
      },
    ],
  },
  markdown: {
    config(md) {
      const renderText = md.renderer.rules.text
      const renderCode = md.renderer.rules.code_inline
      const renderFence = md.renderer.rules.fence
      if (renderText === undefined) throw new Error('VitePress Markdown renderer is missing the text rendering rule.')
      if (renderCode === undefined) throw new Error('VitePress Markdown renderer is missing the inline-code rendering rule.')
      if (renderFence === undefined) throw new Error('VitePress Markdown renderer is missing the fence rendering rule.')
      md.renderer.rules.text = (...args) => escapeVueInterpolation(renderText(...args))
      md.renderer.rules.code_inline = (...args) => escapeVueInterpolation(renderCode(...args))
      const renderedFences = new Map<string, string>()
      md.renderer.rules.fence = (...args) => {
        const [tokens, index] = args
        const token = tokens[index]
        if (token === undefined) throw new Error('VitePress code-fence renderer received no token.')
        // Mermaid output embeds the token position, and VitePress snippets resolve source files during rendering.
        if (['mermaid', 'mmd'].includes(token.info.trim().split(/\s+/, 1)[0] ?? '')) return renderFence(...args)
        if (Reflect.get(token, 'src') !== undefined) return renderFence(...args)
        // Keep the cache build-local; a dev renderer can survive many HMR updates.
        if (process.env.NODE_ENV !== 'production') return renderFence(...args)
        const key = JSON.stringify([token.content, token.info, token.markup, token.attrs])
        const cached = renderedFences.get(key)
        if (cached !== undefined) return cached
        const html = renderFence(...args)
        renderedFences.set(key, html)
        return html
      }
    },
  },
  mermaid: {},
  themeConfig: sharedTheme,
})
