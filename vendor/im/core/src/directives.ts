/**
 * Content directives: root-level `<meta name="…" value="…" />` children that steer a publication instead of rendering.
 * They are read and removed **before** `normalize()`, which rejects any tag outside the vocabulary, so no mode's
 * element registry ever sees one and no render report counts one.
 *
 * Without a directive the core chooses the mode from the content itself, and no caller can name one. Two
 * directives exist, both opt-in and both `value` other than `false` meaning `true`:
 *
 * - `<meta name="prefer-streamable-mode" value="true" />` — resolve the mode among those that have a stream driver,
 *   which is what a caller that intends to keep updating the message needs. `Bot.stream` implies it for every state.
 * - `<meta name="prefer-expressive-mode" value="true" />` — resolve the mode that supports the most elements for this
 *   chat, i.e. the one that can express the most, regardless of what this particular content needs. A card that could
 *   also have been a rich-text post goes out as a card.
 *
 * Both may appear together: the streamable directive narrows the candidates first, the expressive one then picks the
 * broadest of them.
 *
 * A directive is honoured only as a direct child of the root (or of a `<message>` wrapper): one nested deeper is left
 * in the tree, so `normalize()` rejects it with its own path-carrying error instead of being read from the wrong place.
 *
 * @module @deepseek-ai/cordis-plugin-im-core/directives
 */

import { type Child, type Element, h } from '@deepseek-ai/satori-element'

/** Name of the directive that asks for a streamable mode. */
export const STREAMABLE_DIRECTIVE = 'prefer-streamable-mode'

/** Name of the directive that asks for the mode supporting the most elements. */
export const EXPRESSIVE_DIRECTIVE = 'prefer-expressive-mode'

/** The directives a content tree may carry. */
export type DirectiveName = typeof STREAMABLE_DIRECTIVE | typeof EXPRESSIVE_DIRECTIVE

/**
 * Build one directive element for a content tree.
 *
 * `<meta>` is outside the v4 vocabulary by design, so the typed `h()` factory is bypassed for it: {@link
 * splitDirectives} reads the element and removes it before `normalize()` ever rejects the tag. Callers use this instead
 * of casting, so a directive is one typed call next to their content.
 *
 * @param name - which directive; an unknown name is ignored by the reader.
 * @param value - `false` turns the directive off, anything else asks for it.
 * @returns the `<meta>` element, accepted anywhere a fragment is.
 */
export function directive(name: DirectiveName, value = true): Element {
  return h('meta' as never, { name, value: String(value) } as never)
}

/** What the root-level directives of a content tree ask for. */
export interface ContentDirectives {
  /** Resolve the mode among those with a stream driver. */
  preferStreamableMode: boolean
  /** Resolve the mode supporting the most elements, whatever this content needs. */
  preferExpressiveMode: boolean
}

/** Content without the directives that were read, plus what they asked for. */
export interface SplitContent {
  /** The input with every root-level directive removed (the original value when there was none). */
  content: Child
  /** What the removed directives asked for. */
  directives: ContentDirectives
}

interface DirectiveNode {
  type: 'meta'
  attrs: { name?: unknown; value?: unknown }
}

function asDirective(node: unknown): DirectiveNode | undefined {
  if (!node || typeof node !== 'object') return undefined
  const element = node as { type?: unknown; attrs?: unknown }
  if (element.type !== 'meta') return undefined
  return { type: 'meta', attrs: (element.attrs ?? {}) as DirectiveNode['attrs'] }
}

function apply(directives: ContentDirectives, node: DirectiveNode): void {
  const on = node.attrs.value !== 'false'
  switch (node.attrs.name) {
    case STREAMABLE_DIRECTIVE:
      directives.preferStreamableMode = on
      return
    case EXPRESSIVE_DIRECTIVE:
      directives.preferExpressiveMode = on
  }
}

/**
 * The nodes a directive may stand among: the fragment's own list, or the children of a `<message>` wrapper.
 *
 * @param content - the content as the caller passed it.
 * @returns the top-level nodes.
 */
function topLevel(content: Child): readonly Child[] {
  if (Array.isArray(content)) return content as readonly Child[]
  const root = content as Element | undefined
  if (root && typeof root === 'object' && root.type === 'message') return root.children as readonly Child[]
  return [content as Child]
}

/**
 * Read the root-level directives of a content tree without copying it.
 *
 * @param content - the content as the caller passed it.
 * @returns what the directives ask for; every other name is ignored.
 */
export function readDirectives(content: Child): ContentDirectives {
  const directives: ContentDirectives = { preferStreamableMode: false, preferExpressiveMode: false }
  for (const node of topLevel(content)) {
    const directive = asDirective(node)
    if (directive) apply(directives, directive)
  }
  return directives
}

/**
 * Split a content tree into the directives and the content to render.
 *
 * A `<message>` wrapper is dropped when a directive was removed from it: `normalize()` builds the root from the
 * children anyway and a `<message>` carries no attributes of its own.
 *
 * @param content - the content as the caller passed it.
 * @returns the remaining content and what the directives asked for.
 */
export function splitDirectives(content: Child): SplitContent {
  const directives = readDirectives(content)
  const kept: Child[] = []
  let stripped = false
  for (const node of topLevel(content)) {
    if (asDirective(node)) {
      stripped = true
      continue
    }
    kept.push(node)
  }
  if (!stripped) return { content, directives }
  return { content: kept, directives }
}
