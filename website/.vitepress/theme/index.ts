/** Default documentation theme with Markdown actions and a client-only image and diagram viewer. */
import DefaultTheme from 'vitepress/theme'
import { useData, useRoute, type Theme } from 'vitepress'
import { defineComponent, h, onBeforeUnmount, onMounted, watch } from 'vue'
import type { MermaidViewer } from './mermaid-viewer.ts'
import type { ImageViewer } from './image-viewer.ts'
import type { MediaViewer } from './media-viewer.ts'
import { PageMarkdownActions } from './page-markdown-actions.ts'
import './media-viewer.css'
import './code-group.css'
import './page-markdown-actions.css'

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
      let disposed = false
      onMounted(async () => {
        const [{ installMermaidViewer }, { ImageViewer }, { MediaViewer }] = await Promise.all([
          import('./mermaid-viewer.ts'), import('./image-viewer.ts'), import('./media-viewer.ts'),
        ])
        if (disposed) return
        media = new MediaViewer(document, () => lang.value)
        viewer = installMermaidViewer(document, () => lang.value, media)
        images = new ImageViewer(document, () => lang.value, media)
      })
      watch([() => route.path, lang, isDark], () => {
        viewer?.refresh()
        images?.refresh()
      }, { flush: 'post' })
      onBeforeUnmount(() => {
        disposed = true
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
