/**
 * Service Definition of `ctx.markdown`: how the render engine expands a `<markdown>` element.
 *
 * `normalize()` keeps `<markdown>` as an element; the engine hands it to the `markdown` service while it transforms
 * the message, so the converter sees the same {@link RenderContext} a mode handler sees — the ancestors and, for a
 * stream state, {@link RenderContext.stream}. The provider (`@deepseek-ai/cordis-plugin-im-markdown`) converts the
 * source and renders the result through {@link RenderContext.transform}. Without a provider the core fallback
 * publishes the source as literal text and reports the element as degraded.
 */

import type { Element } from '@deepseek-ai/satori-element'
import type { ModeTypes } from './mode.ts'
import type { RenderContext } from './registry.ts'

/** The `markdown` service: renders `<markdown>` elements for the render engine. */
export interface MarkdownRenderer {
  /**
   * Render one `<markdown>` element in its place.
   *
   * @param el - the element; `el.attrs.content` is the markdown source.
   * @param ctx - render context of the element: its ancestors, the stream state being rendered, and `transform`.
   * @returns the platform nodes the element renders to.
   */
  render<T extends ModeTypes>(el: Element<'markdown'>, ctx: RenderContext<T>): T['node'][]
}

declare module '@deepseek-ai/cordis' {
  export interface Context {
    markdown: MarkdownRenderer
  }
}
