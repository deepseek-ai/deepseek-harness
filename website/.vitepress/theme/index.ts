/** Default documentation theme with Markdown actions, long-table controls, and image and diagram viewers. */
import DefaultTheme from 'vitepress/theme'
import { getScrollOffset, onContentUpdated, useData, useRoute, type Theme } from 'vitepress'
import { defineComponent, h, onBeforeUnmount, onMounted, watch } from 'vue'
import type { MermaidViewer } from './mermaid-viewer.ts'
import type { ImageViewer } from './image-viewer.ts'
import type { MediaViewer } from './media-viewer.ts'
import { PageMarkdownActions } from './page-markdown-actions.ts'
import { DocumentTables } from './table-filter.ts'
import './media-viewer.css'
import './code-group.css'
import './page-markdown-actions.css'
import './table-filter.css'

export default {
  extends: DefaultTheme,
  Layout: defineComponent({
    name: 'DocsLayout',
    setup() {
      const { lang, isDark, frontmatter, site, page } = useData()
      const route = useRoute()
      let viewer: MermaidViewer | undefined
      let images: ImageViewer | undefined
      let media: MediaViewer | undefined
      let tables: DocumentTables | undefined
      let initialScroll: number | undefined
      let disposed = false
      onMounted(async () => {
        tables = new DocumentTables(document, () => lang.value)
        // VitePress computes the initial hash position before hydration inserts table controls.
        const anchor = document.querySelector(':target')
        if (anchor) initialScroll = window.requestAnimationFrame(() => {
          initialScroll = undefined
          if (!anchor.isConnected) return
          const top = window.scrollY + anchor.getBoundingClientRect().top - getScrollOffset()
          window.scrollTo(0, top + parseFloat(window.getComputedStyle(anchor).paddingTop))
        })
        const [{ installMermaidViewer }, { ImageViewer }, { MediaViewer }] = await Promise.all([
          import('./mermaid-viewer.ts'), import('./image-viewer.ts'), import('./media-viewer.ts'),
        ])
        if (disposed) return
        media = new MediaViewer(document, () => lang.value)
        viewer = installMermaidViewer(document, () => lang.value, media)
        images = new ImageViewer(document, () => lang.value, media)
      })
      onContentUpdated(() => { tables?.refresh() })
      watch([() => route.path, lang, isDark], () => {
        viewer?.refresh()
        images?.refresh()
      }, { flush: 'post' })
      onBeforeUnmount(() => {
        disposed = true
        if (initialScroll !== undefined) window.cancelAnimationFrame(initialScroll)
        tables?.dispose()
        tables = undefined
        viewer?.dispose()
        images?.dispose()
        media?.close()
      })
      return () => h(DefaultTheme.Layout, null, {
        'doc-before': () => {
          const path: unknown = frontmatter.value.rawMarkdownPath
          return !page.value.isNotFound && typeof path === 'string'
            ? h(PageMarkdownActions, { key: `${route.path}:${lang.value}:${path}`, path: `${site.value.base}${path}`, lang: lang.value })
            : null
        },
      })
    },
  }),
} satisfies Theme
