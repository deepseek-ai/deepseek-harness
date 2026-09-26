/** Isolates native code-group radios from copies rendered in local search. */

import type { HeadConfig, MarkdownRenderer } from 'vitepress'

/**
 * Keeps all code-group commands readable when MPA output omits the theme's client handlers.
 * @param mpa - Whether the resolved site uses VitePress's MPA build.
 * @returns MPA-only styles that expose every block and hide inactive controls.
 */
export function codeGroupFallbackHead(mpa: boolean | undefined): HeadConfig[] {
  return mpa ? [['style', {}, `
.vp-code-group .tabs, .vp-code-group button.copy { display: none; }
.vp-code-group .blocks > div { display: block; }
`]] : []
}

/**
 * Gives each native tab strip its own form so search excerpts cannot clear the page's selection.
 *
 * @param md - VitePress renderer with the native code-group rules installed.
 */
export function isolateCodeGroupRadios(md: MarkdownRenderer): void {
  const render = md.renderer.rules['container_code-group_open']
  if (render === undefined) throw new Error('VitePress Markdown renderer is missing the code-group opening rule.')
  md.renderer.rules['container_code-group_open'] = (...args) => {
    const html = render(...args)
    const opening = '<div class="tabs">'
    const closing = '</div><div class="blocks">'
    if (!html.includes(opening) || !html.includes(closing)) {
      throw new Error('VitePress code-group markup does not contain the expected tab strip.')
    }
    return html.replace(opening, '<form class="tabs" @submit.prevent>').replace(closing, '</form><div class="blocks">')
  }
}
