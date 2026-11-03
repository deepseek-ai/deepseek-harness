/**
 * `@deepseek-ai/cordis-plugin-im-markdown`: the `markdown` service of the IM render engine.
 *
 * The engine of `@deepseek-ai/cordis-plugin-im-core` keeps `<markdown>` as an element until it transforms the message
 * and then hands it to this service ({@link MarkdownRenderer}). The service converts the GFM source (`convert.ts`)
 * and renders the result in place of the element through `RenderContext.transform`, so every mode sees ordinary
 * elements and keeps its own escaping.
 *
 * Streaming: under the `append` strategy the platform keeps every character it was sent, while a growing markdown
 * document re-parses as it grows — `**ab` is literal text a mode escapes, `**abc**` is bold; an open fence, a table or a
 * setext heading change lines that were already published. An intermediate state (`ctx.stream.final === false`)
 * therefore renders only the blocks later text cannot change ({@link settledMarkdown}) for the `<markdown>` that
 * ends the message, the only one that can still grow. Final states and the other strategies, which can rewrite what
 * they show, render the whole source.
 *
 * @module @deepseek-ai/cordis-plugin-im-markdown
 */

import { type Context, Service } from '@deepseek-ai/cordis'
import type { MarkdownRenderer, ModeTypes, RenderContext } from '@deepseek-ai/cordis-plugin-im-core'
import { type Element, isPhrasingContainer } from '@deepseek-ai/satori-element'
import { fromMarkdown, settledMarkdown } from './convert.ts'

export { fromMarkdown, settledMarkdown } from './convert.ts'

/**
 * Whether `el` ends the message: it is the last child of its parent, and so is every ancestor of it.
 *
 * @param el - the element.
 * @param ancestors - its ancestors, outermost first.
 * @returns `true` when nothing follows `el` in document order.
 */
function endsMessage(el: Element, ancestors: readonly Element[]): boolean {
  let child = el
  for (let index = ancestors.length - 1; index >= 0; index--) {
    const parent = ancestors[index]!
    if (parent.children[parent.children.length - 1] !== child) return false
    child = parent
  }
  return true
}

/** The `markdown` service. */
export default class Markdown extends Service implements MarkdownRenderer {
  constructor(ctx: Context) {
    super(ctx, 'markdown')
  }

  /**
   * Render one `<markdown>` element in its place.
   *
   * @param el - the element; `el.attrs.content` is the GFM source.
   * @param ctx - render context of the element.
   * @returns the platform nodes of the converted source.
   */
  render<T extends ModeTypes>(el: Element<'markdown'>, ctx: RenderContext<T>): T['node'][] {
    const stream = ctx.stream
    const growing = stream?.strategy === 'append' && !stream.final && endsMessage(el, ctx.ancestors)
    const blocks = fromMarkdown(growing ? settledMarkdown(el.attrs.content) : el.attrs.content)
    // Inside phrasing content a one-paragraph document is that paragraph's content.
    const parent = ctx.ancestors[ctx.ancestors.length - 1]
    const single = blocks.length === 1 && blocks[0]!.type === 'p' ? blocks[0]!.children : undefined
    return ctx.transform(parent !== undefined && isPhrasingContainer(parent.type) && single ? single : blocks)
  }
}
