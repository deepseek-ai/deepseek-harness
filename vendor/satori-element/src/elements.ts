/**
 * Block/inline category table of the element vocabulary and the content model `normalize` enforces.
 */

import type { Tag } from './vocabulary.ts'

/** Element category. */
export type Category =
  | 'root' | 'envelope' | 'inline' | 'block' | 'media' | 'interactive' | 'control' | 'alternative' | 'input'
  | 'inbound'

/** T1 = core fallback + at least one v1 mode; T2 = vocabulary + core fallback only. T3 tags are `reservedTags`. */
export type Tier = 1 | 2

/**
 * Where an element may stand: `inline` = phrasing content only (a bare run at flow level is wrapped into `<p>`),
 * `block` = flow content only, `any` = both (media, buttons, inbound wrappers: block when standing in a flow
 * container, inline inside phrasing content — see the `img.inline` / `button.inline` variants).
 */
export type Position = 'inline' | 'block' | 'any'

/**
 * What an element may contain:
 * - `flow`: blocks; bare inline runs are wrapped into `<p>` (message, li, td, th, blockquote);
 * - `details`: flow content with an optional leading `<summary>`;
 * - `phrasing`: inline content;
 * - `text`: text only (`br` becomes `\n`);
 * - `list` / `table` / `row` / `buttons` / `options`: only `li` / `tr` / `th|td` / `button` / `option` children;
 * - `cases`: only `case` children, each holding content of the model of the `<fallback>`'s own parent;
 * - `empty`: no children.
 */
export type ContentModel =
  | 'flow' | 'details' | 'phrasing' | 'text' | 'list' | 'table' | 'row' | 'buttons' | 'options' | 'cases' | 'empty'

export interface ElementInfo {
  readonly category: Category
  readonly tier: Tier
  readonly position: Position
  readonly content: ContentModel
  /** When set, the element may only be a direct child of these tags (e.g. `li` of `ul`/`ol`). */
  readonly parents?: readonly Tag[]
  /** Attributes that must be non-empty strings. */
  readonly required?: readonly string[]
}

const inline = (tier: Tier = 1, content: ContentModel = 'phrasing', required?: string[]): ElementInfo => ({
  category: 'inline', tier, position: 'inline', content, ...required && { required },
})
const block = (content: ContentModel, parents?: Tag[]): ElementInfo => ({
  category: 'block', tier: 1, position: 'block', content, ...parents && { parents },
})
const media: ElementInfo = { category: 'media', tier: 1, position: 'any', content: 'empty', required: ['src'] }

export const elementInfo: { readonly [K in Tag]: ElementInfo } = {
  message: { category: 'root', tier: 1, position: 'block', content: 'flow' },
  quote: { category: 'envelope', tier: 1, position: 'block', content: 'empty', parents: ['message'], required: ['id'] },
  title: { category: 'envelope', tier: 1, position: 'block', content: 'phrasing', parents: ['message'] },
  text: inline(1, 'empty'),
  b: inline(),
  i: inline(),
  u: inline(),
  s: inline(),
  spoiler: inline(2),
  code: inline(1, 'text'),
  a: inline(1, 'phrasing', ['href']),
  at: inline(1, 'empty'),
  channel: inline(2, 'empty', ['id']),
  emoji: inline(2, 'empty', ['id']),
  span: inline(2),
  br: inline(1, 'empty'),
  p: block('phrasing'),
  h1: block('phrasing'),
  h2: block('phrasing'),
  h3: block('phrasing'),
  h4: block('phrasing'),
  h5: block('phrasing'),
  h6: block('phrasing'),
  ul: block('list'),
  ol: block('list'),
  li: block('flow', ['ul', 'ol']),
  blockquote: block('flow'),
  pre: block('text'),
  hr: block('empty'),
  table: block('table'),
  tr: block('row', ['table']),
  th: block('flow', ['tr']),
  td: block('flow', ['tr']),
  details: block('details'),
  summary: block('phrasing', ['details']),
  small: block('phrasing'),
  img: media,
  audio: media,
  video: media,
  file: media,
  button: { category: 'interactive', tier: 1, position: 'any', content: 'phrasing' },
  'button-group': { category: 'interactive', tier: 1, position: 'block', content: 'buttons' },
  form: { category: 'control', tier: 1, position: 'block', content: 'flow', required: ['name'] },
  input: { category: 'control', tier: 1, position: 'block', content: 'empty' },
  select: { category: 'control', tier: 1, position: 'block', content: 'options' },
  option: { category: 'control', tier: 1, position: 'block', content: 'phrasing', parents: ['select'], required: ['value'] },
  fallback: { category: 'alternative', tier: 1, position: 'any', content: 'cases' },
  case: { category: 'alternative', tier: 1, position: 'any', content: 'cases', parents: ['fallback'] },
  markdown: { category: 'input', tier: 1, position: 'any', content: 'text' },
  forward: { category: 'inbound', tier: 1, position: 'any', content: 'phrasing', required: ['id'] },
  raw: { category: 'inbound', tier: 1, position: 'any', content: 'phrasing', required: ['platform', 'type'] },
}

/** T3: names reserved for later versions; `normalize` rejects them in v1. */
export const reservedTags = [
  'math', 'time', 'sup', 'sub', 'mark', 'sticker', 'gallery', 'figure', 'columns', 'poll', 'location', 'contact',
  'progress', 'countdown',
] as const
export type ReservedTag = typeof reservedTags[number]

/** Old Satori / HTML spellings and the v4 tag that replaces them (rejected by `normalize` with a hint). */
export const tagAliases: Readonly<Record<string, Tag>> = {
  strong: 'b',
  em: 'i',
  ins: 'u',
  del: 's',
  spl: 'spoiler',
  sharp: 'channel',
  face: 'emoji',
  strike: 's',
  image: 'img',
}

/** Every tag of the vocabulary. */
export const tags = Object.keys(elementInfo) as Tag[]

export function isTag(type: string): type is Tag {
  return Object.prototype.hasOwnProperty.call(elementInfo, type)
}

export function isReservedTag(type: string): type is ReservedTag {
  return (reservedTags as readonly string[]).includes(type)
}

/** Containers whose children are blocks (bare inline runs are wrapped into `<p>`). */
export function isFlowContainer(type: string): boolean {
  if (!isTag(type)) return false
  const { content } = elementInfo[type]
  return content === 'flow' || content === 'details'
}

/** Containers whose children are inline (phrasing) content. */
export function isPhrasingContainer(type: string): boolean {
  if (!isTag(type)) return false
  const { content } = elementInfo[type]
  return content === 'phrasing' || content === 'text'
}

export function isInline(type: string): boolean {
  return isTag(type) && elementInfo[type].position === 'inline'
}

export function isBlock(type: string): boolean {
  return isTag(type) && elementInfo[type].position === 'block'
}
