/**
 * Variant detection: which `element.<tag>.<variant>` keys an element instance needs.
 */

import { isPhrasingContainer } from './elements.ts'
import type { Element, ElementKey, Tag, VariantMap, VariantOf } from './vocabulary.ts'

/** Declared variants per tag, in `VariantMap` order. */
export const variantTable: { readonly [K in keyof VariantMap]: readonly VariantMap[K][] } = {
  at: ['user', 'all', 'here', 'role'],
  li: ['checked', 'nested'],
  pre: ['lang'],
  span: ['color'],
  table: ['align'],
  td: ['block'],
  img: ['inline'],
  button: ['action', 'link', 'input', 'submit', 'theme', 'inline'],
  input: ['checkbox'],
  select: ['multiple'],
}

/** Capability key of a tag or one of its variants: `variantKey('at', 'all')` → `'element.at.all'`. */
export function variantKey<K extends Tag>(tag: K, variant?: VariantOf<K>): ElementKey {
  return (variant ? `element.${tag}.${variant}` : `element.${tag}`) as ElementKey
}

function isInlinePosition(ancestors: readonly Element[] | undefined) {
  const parent = ancestors?.[ancestors.length - 1]
  return !!parent && isPhrasingContainer(parent.type)
}

function hasAlign(table: Element): boolean {
  return table.children.some(row => row.type === 'tr' && row.children.some(cell =>
    (cell.type === 'td' || cell.type === 'th') && cell.attrs.align !== undefined && cell.attrs.align !== 'left'))
}

/**
 * The variant keys an element instance needs, e.g. `<at type="all">` → `['all']`, `<pre lang>` → `['lang']`.
 *
 * Every variant depends only on the element itself, except the position variants `img.inline` and
 * `button.inline`, which need `ancestors` (outermost first, parent last — `RenderContext.ancestors`): they are
 * reported when the parent holds phrasing content (`p`, headings, `b`, `a` …). Without `ancestors` an element is
 * taken to stand in flow position.
 *
 * Rules: `li.checked` = `checked` is a boolean (task item); `li.nested` = the item contains a `ul`/`ol`;
 * `pre.lang` = non-empty `lang`; `span.color` = a `color` other than `default`; `table.align` = some cell has an
 * `align` other than `left` (left is every platform's default, so dropping it is lossless); `td.block` = the cell
 * holds more than one block or anything but a `<p>`; `button.theme` = a `theme` other than `default`;
 * `input.checkbox` = `type="checkbox"` (a separate platform component where one exists); `select.multiple` = the
 * `multiple` flag (a multi-value picker where one exists). `button` variants start with its `type`, so
 * `type="submit"` asks for `element.button.submit`.
 */
export function variantsOf<K extends Tag>(el: Element<K>, ancestors?: readonly Element[]): readonly VariantOf<K>[]
export function variantsOf(el: Element, ancestors?: readonly Element[]): readonly string[] {
  switch (el.type) {
    case 'at': return [el.attrs.type]
    case 'li': {
      const out: string[] = []
      if (typeof el.attrs.checked === 'boolean') out.push('checked')
      if (el.children.some(child => child.type === 'ul' || child.type === 'ol')) out.push('nested')
      return out
    }
    case 'pre': return el.attrs.lang ? ['lang'] : []
    case 'span': return el.attrs.color && el.attrs.color !== 'default' ? ['color'] : []
    case 'table': return hasAlign(el) ? ['align'] : []
    case 'td': return el.children.length > 1 || el.children.some(child => child.type !== 'p') ? ['block'] : []
    case 'img': return isInlinePosition(ancestors) ? ['inline'] : []
    case 'input': return el.attrs.type === 'checkbox' ? ['checkbox'] : []
    case 'select': return el.attrs.multiple ? ['multiple'] : []
    case 'button': {
      const out: string[] = [el.attrs.type]
      if (el.attrs.theme && el.attrs.theme !== 'default') out.push('theme')
      if (isInlinePosition(ancestors)) out.push('inline')
      return out
    }
    default: return []
  }
}

/** Capability keys an element instance needs: its tag key followed by its variant keys. */
export function keysOf(el: Element, ancestors?: readonly Element[]): ElementKey[] {
  return [variantKey(el.type), ...variantsOf(el, ancestors).map(v => variantKey(el.type, v as never))]
}
