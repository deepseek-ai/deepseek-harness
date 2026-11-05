/**
 * Core fallback table and the render report.
 *
 * A fallback rewrites an element the mode cannot render — or a *variant* of it the mode does not support
 * (`ctx.variant`) — into strictly simpler elements. The engine (`registry.ts`) normalizes the result against the
 * element's parent (`normalizeChildren`) and transforms it again, so a chain ends when every element of the output
 * has a native handler; the core table reaches the base tags (`text`, `p`, `br`) plus `b` in ≤ 4 steps.
 *
 * Conventions of the core table:
 * - **Variant-preserving fallbacks** keep the tag and drop only the variant (`pre[lang]` → `pre`, `span[color]` →
 *   `span`, `table[align]` → `table`, `button[theme]` → `button`, `button[submit]` → `button[type=action]` (the click
 *   stays, its form values do not), `li[checked]` → `li` with a `☐`/`☑` prefix, `li[nested]` → `li` with the nested
 *   list flattened into indented paragraphs, `td[block]` → `td` with one paragraph). The output keeps the element's
 *   `key`, so stable ids survive (`stableId`).
 * - Every other variant (`at.*`, `img.inline`, `button.action|link|input|submit|inline`, `input.checkbox`,
 *   `select.multiple`) uses the element's full fallback: a variant the mode cannot render means the element as a
 *   whole is not native.
 * - Text is never lost: every `text` of the input reappears in the output.
 * - Fallbacks are pure. `ctx.report` is only for `dropped` entries (e.g. an action button without a text
 *   equivalent); the engine records the `degraded` entry itself.
 */

import { type Element, type ElementKey, type Fragment, h, type Tag, toText } from '@deepseek-ai/satori-element'

/** What a fallback sees besides the element. */
export interface FallbackContext {
  /** Whether the mode renders a key natively (e.g. `h3` falls back to the next lower heading the mode renders). */
  renders(key: ElementKey): boolean
  /** The unsupported variant being lowered; `undefined` when the tag itself is not native. */
  variant?: string
  /** Ancestors of the element, outermost first, parent last (`RenderContext.ancestors`). */
  ancestors: readonly Element[]
  /** The render's report; fallbacks add `dropped` entries (the engine adds the `degraded` entry). */
  report: RenderReport
}

/**
 * Rewrite an element the mode cannot render (or a variant it does not support, `ctx.variant`) into strictly
 * simpler v4 elements; the result is normalized against the element's parent and transformed again.
 */
export type Fallback<K extends Tag> = (el: Element<K>, ctx: FallbackContext) => Fragment

export interface RenderReport {
  degraded: { tag: Tag; variant?: string; via: string; path: string }[]
  moved: { tag: Tag; reason: string; path: string }[]
  /** Extra platform messages created. */
  split: number
  /** E.g. panels flattened by the Lark card element budget. */
  folded: number
  /** Interactions without a text equivalent etc. */
  dropped: { what: string; reason: string }[]
  /** `<fallback>` elements that rendered a candidate other than their first (`candidate` is its index). */
  fallbacks: { path: string; candidate: number }[]
  /** One-line human summary for tool results ("表格已降级为列表；按钮不可点击"). */
  summary(locale?: 'zh' | 'en'): string
}

// ---------------------------------------------------------------------------------------------------------------
// Render report

/** `dropped.reason` of an action button rendered as text (`summary()`: "按钮不可点击"). */
export const INTERACTION_DROPPED = 'interaction-dropped'

const TAG_NAMES: Partial<Record<Tag, { zh: string; en: string }>> = {
  title: { zh: '消息标题', en: 'title' },
  quote: { zh: '引用回复', en: 'reply quote' },
  b: { zh: '粗体', en: 'bold' },
  i: { zh: '斜体', en: 'italic' },
  u: { zh: '下划线', en: 'underline' },
  s: { zh: '删除线', en: 'strikethrough' },
  spoiler: { zh: '剧透', en: 'spoiler' },
  code: { zh: '行内代码', en: 'inline code' },
  a: { zh: '链接', en: 'link' },
  at: { zh: '提及', en: 'mention' },
  channel: { zh: '频道', en: 'channel' },
  emoji: { zh: '表情', en: 'emoji' },
  span: { zh: '彩色文字', en: 'colored text' },
  h1: { zh: '标题', en: 'heading' },
  h2: { zh: '标题', en: 'heading' },
  h3: { zh: '标题', en: 'heading' },
  h4: { zh: '标题', en: 'heading' },
  h5: { zh: '标题', en: 'heading' },
  h6: { zh: '标题', en: 'heading' },
  ul: { zh: '列表', en: 'list' },
  ol: { zh: '列表', en: 'list' },
  li: { zh: '列表项', en: 'list item' },
  blockquote: { zh: '引用块', en: 'blockquote' },
  pre: { zh: '代码块', en: 'code block' },
  hr: { zh: '分割线', en: 'divider' },
  table: { zh: '表格', en: 'table' },
  tr: { zh: '表格', en: 'table' },
  th: { zh: '表格', en: 'table' },
  td: { zh: '单元格', en: 'table cell' },
  details: { zh: '折叠面板', en: 'collapsible panel' },
  summary: { zh: '折叠面板', en: 'collapsible panel' },
  small: { zh: '小字', en: 'small text' },
  img: { zh: '图片', en: 'image' },
  audio: { zh: '语音', en: 'audio' },
  video: { zh: '视频', en: 'video' },
  file: { zh: '文件', en: 'file' },
  button: { zh: '按钮', en: 'button' },
  'button-group': { zh: '按钮组', en: 'button group' },
  form: { zh: '表单', en: 'form' },
  input: { zh: '输入框', en: 'input' },
  select: { zh: '下拉选择', en: 'select' },
  option: { zh: '选项', en: 'option' },
  forward: { zh: '合并转发', en: 'forwarded messages' },
  raw: { zh: '原始消息', en: 'raw content' },
}

const VARIANT_NAMES_ZH: Record<string, string> = {
  user: '用户', all: '所有人', here: '在线成员', role: '角色', checked: '勾选框', nested: '嵌套', lang: '语言',
  color: '颜色', align: '对齐', block: '块内容', inline: '行内', action: '回调', link: '链接', command: '指令',
  theme: '样式', submit: '提交', checkbox: '勾选框', multiple: '多选',
}

class Report implements RenderReport {
  degraded: RenderReport['degraded'] = []
  moved: RenderReport['moved'] = []
  split = 0
  folded = 0
  dropped: RenderReport['dropped'] = []
  fallbacks: RenderReport['fallbacks'] = []

  summary(locale: 'zh' | 'en' = 'zh'): string {
    return summarize(this, locale)
  }
}

function tagName(tag: Tag, locale: 'zh' | 'en') {
  return TAG_NAMES[tag]?.[locale] ?? tag
}

function summarize(report: RenderReport, locale: 'zh' | 'en'): string {
  const zh = locale === 'zh'
  const parts: string[] = []
  // Entries inside fallback output (`>` in the path) are consequences of an outer degradation, not user content.
  const labels = unique(report.degraded.filter(entry => !entry.path.includes('>')).map(({ tag, variant }) => {
    const name = tagName(tag, locale)
    if (!variant) return name
    return zh ? `${name}（${VARIANT_NAMES_ZH[variant] ?? variant}）` : `${name} (${variant})`
  }))
  if (labels.length) parts.push(zh ? `${labels.join('、')}已降级` : `degraded: ${labels.join(', ')}`)
  if (report.dropped.some(entry => entry.reason === INTERACTION_DROPPED)) {
    parts.push(zh ? '按钮不可点击' : 'buttons are not clickable')
  }
  const others = unique(report.dropped.filter(entry => entry.reason !== INTERACTION_DROPPED).map(entry => entry.what))
  if (others.length) parts.push(zh ? `已省略${others.join('、')}` : `dropped: ${others.join(', ')}`)
  if (report.moved.length) {
    parts.push(zh ? `${report.moved.length} 处元素已移位` : `${report.moved.length} element${report.moved.length > 1 ? 's' : ''} moved`)
  }
  if (report.split > 0) parts.push(zh ? `已拆分为 ${report.split + 1} 条消息` : `split into ${report.split + 1} messages`)
  if (report.folded > 0) {
    parts.push(zh ? `已折叠 ${report.folded} 个面板` : `${report.folded} panel${report.folded > 1 ? 's' : ''} folded`)
  }
  return parts.join(zh ? '；' : '; ')
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)]
}

/** An empty report (all lists empty, counters 0). */
export function createRenderReport(): RenderReport {
  return new Report()
}

/** Merge several reports (e.g. the parts of an edit or the frames of a stream) into a new one. */
export function mergeRenderReports(...reports: RenderReport[]): RenderReport {
  const merged = new Report()
  for (const report of reports) {
    merged.degraded.push(...report.degraded)
    merged.moved.push(...report.moved)
    merged.dropped.push(...report.dropped)
    merged.fallbacks.push(...report.fallbacks)
    merged.split += report.split
    merged.folded += report.folded
  }
  return merged
}

// ---------------------------------------------------------------------------------------------------------------
// Helpers

type Node = string | Element
type AnyElement = Element & { attrs: Record<string, any> }

const INDENT = '  '

function isHttp(src: string | undefined) {
  return !!src && /^https?:\/\//i.test(src)
}

/** `[图片: alt] (src)` — the source is shown only when it is a public http(s) URL. */
function mediaText(kind: string, name: string | undefined, src: string | undefined) {
  return `[${kind}${name ? `: ${name}` : ''}]${isHttp(src) ? ` (${src})` : ''}`
}

/** Copy an element with new attributes, keeping its children and `key`. */
function withAttrs<E extends Element>(el: E, attrs: Record<string, unknown>, children: readonly Node[] = el.children): E {
  return h(el.type as any, { ...attrs, key: el.key } as any, ...children) as unknown as E
}

function omit(attrs: Record<string, unknown>, ...names: string[]) {
  const out = { ...attrs }
  for (const name of names) delete out[name]
  return out
}

/** Text lines interleaved with `<br>`. */
function lines(text: string): Node[] {
  const out: Node[] = []
  text.split('\n').forEach((line, index) => {
    if (index) out.push(h('br'))
    if (line) out.push(line)
  })
  return out
}

/** Insert `prefix` at the start of the first paragraph (or as a paragraph of its own). */
function prefixFirst(blocks: readonly Element[], prefix: string): Element[] {
  const [first, ...rest] = blocks
  if (first?.type === 'p') return [withAttrs(first, first.attrs, [prefix, ...first.children]), ...rest]
  return [h('p', prefix.trimEnd()), ...blocks]
}

/** Inline projection of blocks (`td[block]`, table rows): paragraphs keep their inline content, other blocks text. */
function inlineOf(blocks: readonly Element[]): Node[] {
  const out: Node[] = []
  blocks.forEach((block, index) => {
    if (index) out.push(h('br'))
    if (block.type === 'p') out.push(...block.children)
    else out.push(...lines(toText(block)))
  })
  return out
}

/** A list as paragraphs: `• ` / `1. ` markers, `☐`/`☑` for task items, nested lists indented. */
function listBlocks(list: Element<'ul' | 'ol'>, depth: number): Element[] {
  const ordered = list.type === 'ol'
  let index = ordered && typeof (list as Element<'ol'>).attrs.start === 'number' ? (list as Element<'ol'>).attrs.start! : 1
  const indent = INDENT.repeat(depth)
  const out: Element[] = []
  for (const item of list.children) {
    if (item.type !== 'li') {
      out.push(item)
      continue
    }
    let marker = ordered ? `${index++}. ` : depth ? '◦ ' : '• '
    if (typeof item.attrs.checked === 'boolean') {
      const box = item.attrs.checked ? '☑ ' : '☐ '
      marker = ordered ? marker + box : box
    }
    out.push(...itemBlocks(item.children, indent + marker, indent + INDENT, depth))
  }
  return out
}

function itemBlocks(children: readonly Element[], first: string, rest: string, depth: number): Element[] {
  const out: Element[] = []
  let lead: string | undefined = first
  const lone = () => {
    if (lead !== undefined) out.push(h('p', lead.trimEnd()))
    lead = undefined
  }
  for (const child of children) {
    if (child.type === 'p') {
      out.push(withAttrs(child, child.attrs, [lead ?? rest, ...child.children]))
      lead = undefined
    } else if (child.type === 'ul' || child.type === 'ol') {
      lone()
      out.push(...listBlocks(child, depth + 1))
    } else {
      lone()
      out.push(child)
    }
  }
  lone()
  return out
}

/** Blockquote content with a `> ` prefix on every paragraph line; nested quotes stack the prefix. */
function quoteBlocks(children: readonly Element[], prefix: string): Element[] {
  const out: Element[] = []
  for (const child of children) {
    if (child.type === 'p') out.push(prefixLines(child, prefix))
    else if (child.type === 'blockquote') out.push(...quoteBlocks(child.children, `${prefix}> `))
    else if (child.type === 'ul' || child.type === 'ol') {
      out.push(...listBlocks(child, 0).map(block => block.type === 'p' ? prefixLines(block, prefix) : block))
    } else out.push(child)
  }
  return out
}

function prefixLines(p: Element<'p'>, prefix: string): Element<'p'> {
  const children: Node[] = [prefix]
  for (const child of p.children) {
    children.push(child)
    if (child.type === 'br') children.push(prefix)
  }
  return withAttrs(p, p.attrs, children)
}

// ---- tables -----------------------------------------------------------------------------------------------------

const GRID_MAX_COLUMNS = 4
const GRID_MAX_WIDTH = 40

/** Display width: East Asian wide / fullwidth characters and astral symbols (emoji) count 2. */
function displayWidth(text: string) {
  let width = 0
  for (const char of text) {
    const code = char.codePointAt(0)!
    const wide = code > 0xFFFF
      || (code >= 0x1100 && code <= 0x115F) || (code >= 0x2E80 && code <= 0xA4CF) || (code >= 0xAC00 && code <= 0xD7A3)
      || (code >= 0xF900 && code <= 0xFAFF) || (code >= 0xFE30 && code <= 0xFE4F) || (code >= 0xFF00 && code <= 0xFF60)
      || (code >= 0xFFE0 && code <= 0xFFE6)
    width += wide ? 2 : 1
  }
  return width
}

function pad(text: string, width: number, align: string | undefined) {
  const space = width - displayWidth(text)
  if (space <= 0) return text
  if (align === 'right') return ' '.repeat(space) + text
  if (align === 'center') return ' '.repeat(space >> 1) + text + ' '.repeat(space - (space >> 1))
  return text + ' '.repeat(space)
}

function cellText(cell: Element) {
  return toText(cell.children).replace(/\s*\n\s*/g, ' ').trim()
}

function tableFallback(table: Element<'table'>): Element[] {
  const rows = table.children.filter((row): row is Element<'tr'> => row.type === 'tr')
  const header = rows[0]?.children.length && rows[0].children.every(cell => cell.type === 'th') ? rows[0] : undefined
  const body = header ? rows.slice(1) : rows
  const columns = Math.max(0, ...rows.map(row => row.children.length))
  if (!columns) return []

  // Narrow tables of single-paragraph cells become a monospace grid.
  const simple = rows.every(row => row.children.every(cell => cell.children.length <= 1 && cell.children.every(c => c.type === 'p')))
  if (simple && columns <= GRID_MAX_COLUMNS) {
    const texts = rows.map(row => Array.from({ length: columns }, (_, j) => row.children[j] ? cellText(row.children[j]!) : ''))
    const widths = Array.from({ length: columns }, (_, j) => Math.max(1, ...texts.map(row => displayWidth(row[j]!))))
    const total = widths.reduce((a, b) => a + b, 0) + 3 * (columns - 1)
    if (total <= GRID_MAX_WIDTH) {
      const align = (j: number, row: Element<'tr'>) => (row.children[j] as AnyElement | undefined)?.attrs.align
        ?? (rows[0]?.children[j] as AnyElement | undefined)?.attrs.align
      const out = texts.map((row, i) => row.map((text, j) => pad(text, widths[j]!, align(j, rows[i]!))).join(' | ').trimEnd())
      if (header) out.splice(1, 0, widths.map(width => '-'.repeat(width)).join('-+-'))
      return [h('pre', out.join('\n'))]
    }
  }

  // Otherwise one paragraph per row: "header: value" lines, or "a | b | c" without a header row.
  const heads = header ? header.children.map(cellText) : []
  const out: Element[] = body.map(row => {
    const parts: Node[] = []
    row.children.forEach((cell, j) => {
      if (j) parts.push(header ? h('br') : ' | ')
      if (header && heads[j]) parts.push(`${heads[j]}: `)
      parts.push(...inlineOf(cell.children))
    })
    return h('p', ...parts)
  })
  if (header && !body.length) out.push(h('p', heads.join(' | ')))
  return out
}

function stripAlign(table: Element<'table'>): Element<'table'> {
  return withAttrs(table, table.attrs, table.children.map(row => withAttrs(row, row.attrs,
    row.children.map(cell => withAttrs(cell, omit(cell.attrs, 'align'))))))
}

// ---- headings, mentions, buttons ----------------------------------------------------------------------------------

type Heading = 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6'

/** `hN` → the next lower heading level the mode supports, else `<p><b>…</b></p>` (one step). */
function heading(level: number): Fallback<Heading> {
  return (el, { renders }) => {
    for (let next = level + 1; next <= 6; next++) {
      const tag = `h${next}` as Heading
      if (renders(`element.${tag}`)) return h(tag, { key: el.key }, ...el.children)
    }
    return h('p', { key: el.key }, h('b', ...el.children))
  }
}

function atText(el: Element<'at'>) {
  const { type, id, name } = el.attrs
  if (type === 'all') return '@所有人'
  if (type === 'here') return '@在线成员'
  return `@${name ?? id ?? ''}`
}

function emojiText(el: Element<'emoji'>) {
  const name = el.attrs.name ?? el.attrs.id
  return /^[\w+-]+$/.test(name) ? `:${name}:` : `[${name}]`
}

function buttonFallback(el: Element<'button'>, ctx: FallbackContext): Fragment {
  const attrs = el.attrs
  if (ctx.variant === 'theme') return withAttrs(el, omit(attrs, 'theme'))
  // A submit button on a mode without forms keeps its label and click, losing only the submitted values.
  if (ctx.variant === 'submit') return withAttrs(el, { ...attrs, type: 'action' })
  const label = toText(el.children).trim()
  switch (attrs.type) {
    case 'link':
      return h('a', { href: attrs.href }, ...(label ? el.children : [attrs.href]))
    case 'input':
      return label && label !== attrs.text ? [...el.children, ' ', h('code', attrs.text)] : h('code', attrs.text)
    case 'action':
    default:
      ctx.report.dropped.push({ what: `button:${(attrs as { id?: string }).id ?? label}`, reason: INTERACTION_DROPPED })
      return ['[', ...(label ? el.children : [(attrs as { id?: string }).id ?? 'button']), ']']
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The table

const children = (el: Element): Fragment => el.children

/** Core fallbacks for every T1/T2 tag. `text`, `p`, `br` and `message` have none. */
export const coreFallbacks: { readonly [K in Tag]?: Fallback<K> } = {
  quote: () => [],
  title: (el) => {
    const out: Element[] = []
    if (el.children.length) out.push(h('p', { key: el.key }, h('b', ...el.children)))
    if (el.attrs.subtitle) out.push(h('small', el.attrs.subtitle))
    return out
  },
  b: children,
  i: children,
  u: children,
  s: children,
  spoiler: children,
  code: children,
  a: (el) => {
    const text = toText(el.children)
    return !text || text === el.attrs.href ? el.attrs.href : [...el.children, ` (${el.attrs.href})`]
  },
  at: atText,
  channel: el => `#${el.attrs.name ?? el.attrs.id}`,
  emoji: emojiText,
  span: (el, { variant }) => variant === 'color' ? withAttrs(el, omit(el.attrs, 'color')) : el.children,
  h1: heading(1),
  h2: heading(2),
  h3: heading(3),
  h4: heading(4),
  h5: heading(5),
  h6: heading(6),
  ul: el => listBlocks(el, 0),
  ol: el => listBlocks(el, 0),
  li: (el, { variant }) => {
    if (variant === 'checked') {
      const box = el.attrs.checked ? '☑ ' : '☐ '
      return withAttrs(el, omit(el.attrs, 'checked'), prefixFirst(el.children, box))
    }
    if (variant === 'nested') {
      return withAttrs(el, el.attrs, el.children.flatMap(child =>
        child.type === 'ul' || child.type === 'ol' ? listBlocks(child, 1) : [child]))
    }
    return el.children
  },
  blockquote: el => quoteBlocks(el.children, '> '),
  pre: (el, { variant }) => {
    if (variant === 'lang') return withAttrs(el, omit(el.attrs, 'lang'))
    const text = toText(el.children).replace(/\n$/, '')
    return text ? h('p', ...lines(text)) : []
  },
  hr: () => h('p', '────────'),
  table: (el, { variant }) => variant === 'align' ? stripAlign(el) : tableFallback(el),
  tr: el => h('p', toText(el)),
  th: children,
  td: (el, { variant }) => variant === 'block' ? withAttrs(el, el.attrs, [h('p', ...inlineOf(el.children))]) : el.children,
  details: (el) => {
    const [first, ...rest] = el.children
    if (first?.type !== 'summary') return el.children
    return first.children.length ? [h('p', h('b', '▸ ', ...first.children)), ...rest] : rest
  },
  summary: el => h('p', h('b', ...el.children)),
  small: el => h('p', '— ', ...el.children),
  img: el => mediaText('图片', el.attrs.alt, el.attrs.src),
  audio: (el, { renders }) => renders('element.file')
    ? h('file', { src: el.attrs.src, name: el.attrs.name })
    : mediaText('语音', el.attrs.name, el.attrs.src),
  video: (el, { renders }) => renders('element.file')
    ? h('file', { src: el.attrs.src, name: el.attrs.name })
    : mediaText('视频', el.attrs.name, el.attrs.src),
  file: el => mediaText('文件', el.attrs.name, el.attrs.src),
  button: buttonFallback,
  'button-group': (el, { renders }) => {
    if (renders('element.button')) return el.children
    const out: Node[] = []
    el.children.forEach((button, index) => {
      if (index) out.push(' ')
      out.push(button)
    })
    return h('p', ...out)
  },
  // Reached while no plugin contributes `markdown`: the source is all there is to show.
  markdown: el => el.attrs.content,
  form: children,
  input: (el, ctx) => {
    ctx.report.dropped.push({ what: `input:${el.attrs.name}`, reason: INTERACTION_DROPPED })
    return h('p', toText(el))
  },
  select: (el, ctx) => {
    ctx.report.dropped.push({ what: `select:${el.attrs.id ?? el.attrs.name ?? 'select'}`, reason: INTERACTION_DROPPED })
    return h('p', toText(el))
  },
  option: children,
  forward: () => '[合并转发]',
  raw: children,
}

/** The core table entry for a tag (`undefined` for tags that need none: `text`, `p`, `br`, `message`). */
export function defaultFallback<K extends Tag>(tag: K): Fallback<K> | undefined {
  return coreFallbacks[tag] as Fallback<K> | undefined
}

/**
 * `tag.variant` pairs whose core fallback keeps the tag (only the variant is dropped). The engine treats such a
 * child of a structural container (`li` of a list, cells of a table, buttons of a group) as renderable by the
 * container; any other unsupported child makes the container itself fall back.
 */
export const preservingVariants: ReadonlySet<string> = new Set([
  'li.checked', 'li.nested', 'pre.lang', 'span.color', 'table.align', 'td.block', 'button.theme', 'button.submit',
])
