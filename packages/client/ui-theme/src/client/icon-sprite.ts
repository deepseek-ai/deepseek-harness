/**
 * Document icon sprite: one hidden `<svg>` whose `<symbol>` children carry
 * every product icon, so ui-primitives icons render through `<use>` and
 * inherit `currentColor` and CSS variables at each use site.
 */
import type { Context } from '@deepseek-ai/cordis'
import { ICON_SYMBOLS, type IconSymbolId } from '@deepseek-ai/dsh-client-ui-primitives'

const SVG_NS = 'http://www.w3.org/2000/svg'

/** Icon replacements keyed by sprite symbol id; see `ThemeDefinition.icons`. */
export type IconReplacements = Readonly<Partial<Record<IconSymbolId, string>>>
/** Root attributes that size or label one rendering, not the reusable artwork. */
const DROPPED_ATTRIBUTES = new Set(['width', 'height', 'xmlns', 'class', 'aria-hidden'])

function toSymbol(id: string, markup: string): SVGSymbolElement {
  const root = new DOMParser().parseFromString(markup, 'image/svg+xml').documentElement
  const symbol = document.createElementNS(SVG_NS, 'symbol')
  for (const { name, value } of root.attributes) if (!DROPPED_ATTRIBUTES.has(name)) symbol.setAttribute(name, value)
  symbol.id = id
  symbol.append(...[...root.childNodes].map(node => document.importNode(node, true)))
  return symbol
}

/**
 * Mount the sprite and keep each symbol on the active theme's replacement or
 * the ui-primitives default; plugin disposal removes the sprite.
 * @param ctx - owning plugin context; `theme/change` snapshots drive updates.
 * @param icons - replacements of the theme active at install time.
 */
export function installIconSprite(ctx: Context, icons: IconReplacements | undefined): void {
  if (typeof document === 'undefined') return
  const sprite = document.createElementNS(SVG_NS, 'svg')
  sprite.setAttribute('aria-hidden', 'true')
  sprite.setAttribute('data-dsh-icon-sprite', '')
  sprite.style.cssText = 'position: absolute; width: 0; height: 0; overflow: hidden'
  const rendered = new Map<string, SVGSymbolElement>()
  const markups = new Map<string, string>()
  const apply = (replacements: IconReplacements = {}): void => {
    for (const [id, fallback] of Object.entries(ICON_SYMBOLS) as [IconSymbolId, string][]) {
      const markup = replacements[id] ?? fallback
      if (markups.get(id) === markup) continue
      const symbol = toSymbol(id, markup)
      const previous = rendered.get(id)
      if (previous === undefined) sprite.append(symbol)
      else previous.replaceWith(symbol)
      rendered.set(id, symbol)
      markups.set(id, markup)
    }
  }
  apply(icons)
  ctx.effect(() => {
    document.body.prepend(sprite)
    return () => { sprite.remove() }
  }, 'ui-theme: icon sprite')
  ctx.on('theme/change', (snapshot) => { apply(snapshot.active.icons) })
}
