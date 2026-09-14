/** Default documentation theme with a client-only Mermaid viewer. */
import DefaultTheme from 'vitepress/theme'
import { useData, useRoute, type Theme } from 'vitepress'
import { defineComponent, h, onBeforeUnmount, onMounted, watch } from 'vue'
import type { MermaidViewer } from './mermaid-viewer.ts'
import './mermaid-viewer.css'

export default {
  extends: DefaultTheme,
  Layout: defineComponent({
    name: 'DocsLayout',
    setup() {
      const { lang, isDark } = useData()
      const route = useRoute()
      let viewer: MermaidViewer | undefined
      let disposed = false
      onMounted(async () => {
        const { installMermaidViewer } = await import('./mermaid-viewer.ts')
        if (!disposed) viewer = installMermaidViewer(document, () => lang.value)
      })
      watch([() => route.path, lang, isDark], () => viewer?.refresh(), { flush: 'post' })
      onBeforeUnmount(() => {
        disposed = true
        viewer?.dispose()
      })
      return () => h(DefaultTheme.Layout)
    },
  }),
} satisfies Theme
