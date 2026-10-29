/**
 * `text` mode : the base tags plus `img audio video file` (one `msg_type: 7` message per
 * media element); every other element takes the core fallback. `<a>` follows `linkPolicy`: `'text'` writes only the
 * label (QQ rejects URLs that are not whitelisted in the console, `40054010`), `'keep'` writes `label (href)`.
 *
 * @module @deepseek-ai/cordis-plugin-im-adapter-qq/modes/text
 */

import { type Element, type Fragment, toText } from '@deepseek-ai/satori-element'
import { defineMode, ElementRegistry, type Mode } from '@deepseek-ai/cordis-plugin-im-core'
import { assemble, block, mediaNode, modeBase, type QqModeSettings, type QqTypes } from './shared.ts'

/** Mode-level fallback of `<a>` (both modes): the label, plus ` (href)` when `linkPolicy` keeps URLs. */
export function linkFallback(settings: QqModeSettings) {
  const keep = settings.linkPolicy === 'keep'
  return (el: Element<'a'>): Fragment => {
    const label = toText(el.children).trim()
    if (!label) return keep ? el.attrs.href : '[链接]'
    if (!keep || label === el.attrs.href) return el.children
    return [...el.children, ` (${el.attrs.href})`]
  }
}

/** Build the `text` mode. */
export function createTextMode(settings: QqModeSettings): Mode<QqTypes> {
  const elements = new ElementRegistry<QqTypes>()
    .register('text', el => el.attrs.content)
    .register('p', (el, ctx) => block(ctx.render(el.children)))
    .register('br', () => '\n')
    // Declared `inline` on purpose: without it the core renders an inline picture as its text label, which is worse
    // than the media message this handler publishes in its place.
    .register('img', mediaNode, { variants: ['inline'] })
    .register('audio', mediaNode)
    .register('video', mediaNode)
    .register('file', mediaNode)
    .fallback('a', linkFallback(settings))
  return defineMode<QqTypes>()({
    ...modeBase('text', settings),
    elements,
    assemble: (nodes, _envelope, ctx) => assemble(nodes, ctx, settings),
  })
}
