/**
 * Reference modes for testkit users. Adapters register their own modes; these exist so a `FakeAdapter` needs no
 * hand-written mode to drive `bot.send`, a stream or conformance.
 */

import { type Element, type Fragment, type Tag, toText, variantTable } from '@deepseek-ai/satori-element'
import { defineMode, type Mode } from '../mode.ts'
import { ElementRegistry, type RenderContext } from '../registry.ts'

export interface TextPayload {
  mode: string
  text: string
  /** Reply target of the first part (from `<quote>`). */
  quote?: string
}

export interface TextTypes {
  /** Platform node: a text run. */
  node: string
  /** One platform message before resource resolution: the concatenated run. */
  draft: string
  /** Exact request body. */
  payload: TextPayload
  /** Streaming patch. */
  patch: { append: string }
}

export interface TextModeOptions {
  id?: string
  limits?: Mode<TextTypes>['limits']
}

function textModeSpec(id: string, registry: ElementRegistry<TextTypes, any>, options: TextModeOptions): Mode<TextTypes> {
  return defineMode<TextTypes>()({
    id,
    elements: registry as ElementRegistry<TextTypes, any>,
    limits: options.limits ?? {},
    assemble: (nodes: string[]) => [nodes.join('')],
    serialize: (msg, ctx) => ({
      mode: id,
      text: msg.draft,
      ...ctx.quote === undefined ? {} : { quote: ctx.quote },
    }),
  })
}

/**
 * A mode covering the base tags only: `text`, `p` and `br` render, every other element takes its core fallback — the
 * quickest way to see the core fallback table at work. Includes a prefix `diff()` so the stream scheduler can use the
 * `patch` path with it.
 */
export function createTextMode(options: TextModeOptions = {}): Mode<TextTypes> {
  const id = options.id ?? 'text'
  const elements = new ElementRegistry<TextTypes>()
    .register('text', el => el.attrs.content)
    .register('p', (el, ctx) => ctx.render(el.children).join(''))
    .register('br', () => '\n')
  const mode = textModeSpec(id, elements as ElementRegistry<TextTypes, any>, options)
  mode.diff = (prev, next) => {
    if (prev === next) return []
    if (next.startsWith(prev)) return [{ append: next.slice(prev.length) }]
    return 'replace'
  }
  return mode
}

/**
 * A mode registering every tag in `tags` with a handler that renders the element's plain text (`<b>x</b>` → `x`) and
 * declaring every variant of the vocabulary. It proves that a *complete* registry needs no fallback for the corpus; it
 * is deliberately lossy (no styling, no media), so it is not a reference for a real platform.
 */
export function createPlainMode(tags: readonly Tag[], options: TextModeOptions = {}): Mode<TextTypes> {
  const id = options.id ?? 'plain'
  const registry = new ElementRegistry<TextTypes>() as ElementRegistry<TextTypes, any>
  const handler = (el: Element, ctx: RenderContext<TextTypes>): string | string[] => {
    if (el.type === 'text') return el.attrs.content
    if (el.type === 'br') return '\n'
    if (el.type === 'img') return `[${el.attrs.alt ?? 'image'}]`
    if (el.type === 'audio' || el.type === 'video' || el.type === 'file') return el.attrs.name ?? toText(el.children)
    return ctx.render(el.children)
  }
  for (const tag of tags) {
    // The root is never registered; `<markdown>` is contributed by a plugin, so no mode registers it.
    if (tag === 'message' || tag === 'markdown') continue
    const variants = (variantTable as Record<string, readonly string[]>)[tag] ?? []
    registry.register(tag as never, handler as never, { variants } as never)
  }
  return textModeSpec(id, registry, options)
}

/** The `text` content of a fragment, ignoring elements (a helper for assertions and golden names). */
export function fragmentText(content: Fragment): string {
  return toText(content)
}
