/**
 * Lark **card** mode (`msg_type: 'interactive'`, card JSON 2.0) — the interactive rendering of an element tree, and
 * the preferred Lark mode.
 *
 * Shape of the output. One platform message is a card `{ schema: '2.0', config: { update_multi: true }, header?,
 * body: { elements } }` whose body holds these components:
 * - `markdown` — every text block. Handlers emit one *block* per paragraph / heading / list / quote / fence / table
 *   (card markdown, escaped by `card-markdown.ts`), and `assemble` merges consecutive blocks into one component
 *   (≤ 4 tables per component, the platform limit; `small` blocks merge only with each other, as `text_size:
 *   'notation'` components). Inside lists, quotes and table cells everything is markdown (`<hr>`, `![alt](key)`).
 * - `hr`, `img` (block image; `alt` is the hover text), `collapsible_panel` (`details`, children assembled
 *   recursively — panels nest), `button` and `column_set` (`button-group`, one auto-width column per button).
 * - `title` → card `header` (`template` from `theme`; the mode declares `title` as an envelope tag, so core puts it in
 *   the envelope).
 * - `audio` / `video` / `file` split the logical message into their own messages in tree order (`message.split`),
 *   as in post mode; non-OPUS audio and non-MP4 video are published as `file` and reported `moved`.
 * Buttons: `action` → `behaviors: [{ type: 'callback', value: { v4: { id, data } } }]`, `link` → `open_url`. An `input`
 * button — a click that sends a text as the user — has no card equivalent, because a Lark card cannot post a message on
 * the clicker's behalf, so the mode does not declare that variant and the core fallback renders the label plus the
 * text. A button inside a paragraph cannot live in markdown, so it is hoisted right after its block and reported
 * `moved` (`hoisted`). Action buttons need card callbacks: with `callbacks: false` the `action` variant is not declared
 * and the core fallback renders the buttons as text.
 *
 * Element ids. Every component gets `element_id = cardElementId(ctx.stableId(el))` (`e` + base32(sha1(path))[0..15]),
 * so ids are stable across re-renders of the same structure and — for keyed elements, whose path restarts at
 * `#<key>` — across insertions above them. A merged markdown component keeps the id of its first block. Ids are
 * de-duplicated per card as a last resort.
 *
 * Element budget (`limit.elements`, 200: the platform counts every object with a `tag`, header and panel icons
 * included, and rejects a larger card with 300305). `assemble` folds the **oldest** panels (document pre-order) into
 * flat markdown — title in bold followed by the content — choosing the fewest folds that fit by binary search, and
 * reports `RenderReport.folded`. No text is dropped by folding; buttons inside a folded panel stay buttons.
 * `check()` reports what folding cannot fix: more than 200 elements or more than 30 KB of card JSON (`size`).
 *
 * Streaming. `diff(prev, next)` compares two drafts of the same message by element id (the CardKit driver applies
 * it): a markdown component whose content changed → `content` op (`append: true` when the new text extends the old
 * one: the platform types it out); another changed component → `patch` op with the changed serialized fields (a
 * panel whose children changed is diffed recursively, falling back to patching the whole panel); new components →
 * `insert` ops anchored `after`/`before` an existing sibling; removed ones → `delete`; a header change, a reorder of
 * surviving ids, a tag change under one id, media drafts or more than `maxPatchOps` ops → `'replace'` (full card
 * update). Ops carry draft components (resource refs unresolved); {@link cardKitOps} turns them into wire requests
 * against the tick's `Prepared` draft, and {@link streamingCard} adds the CardKit streaming config to a card.
 */

import { type Align, type Element, isPhrasingContainer, type Theme } from '@deepseek-ai/satori-element'
import {
  defineMode, ElementRegistry, type Envelope, type LimitKey, type LimitViolation, type Mode, type ModeTypes,
  type Prepared, type RenderContext, type RenderReport, ResourceRef, type ResolvedResource,
  type SerializeContext,
} from '@deepseek-ai/cordis-plugin-im-core'
import {
  CARD_BREAK, cardCodeSpan, cardElementId, cardFence, cardFont, cardLink, cardMention, escapeCardText, escapeLinkHref,
  fencedLines, imagePlaceholder, normalizeCardMarkdown, prefixLines, resolveImagePlaceholders, textMarkdown, wrapInline,
} from './card-markdown.ts'

// ---------------------------------------------------------------------------------------------------------------
// Draft components (one platform card before resource resolution)

/** A `markdown` component. `content` is card markdown with image placeholders; `tables` counts its GFM tables. */
export interface CardMarkdownComponent {
  tag: 'markdown'
  id: string
  content: string
  /** Image references used by placeholders in `content`. */
  refs: ResourceRef[]
  size?: 'notation'
  tables: number
}

export interface CardHrComponent { tag: 'hr'; id: string }

export interface CardImageComponent { tag: 'img'; id: string; ref: ResourceRef; alt: string }

export interface CardPanelComponent {
  tag: 'collapsible_panel'
  id: string
  /** Header title, card markdown (from `<summary>`). */
  title: string
  titleRefs: ResourceRef[]
  expanded: boolean
  elements: CardComponent[]
}

/** What a button does when clicked. */
export type CardButtonBehavior =
  | { type: 'callback'; value: { v4: { id: string; data?: string } } }
  | { type: 'open_url'; url: string }

/** Lark button `type` (style). */
export type LarkButtonType = 'default' | 'primary' | 'danger' | 'primary_filled' | 'danger_filled'

export interface CardButtonComponent {
  tag: 'button'
  id: string
  text: string
  type: LarkButtonType
  behavior: CardButtonBehavior
  disabled: boolean
}

/** `button-group` (or buttons hoisted out of one paragraph): a `column_set` with one auto-width column per button. */
export interface CardButtonRowComponent { tag: 'column_set'; id: string; buttons: CardButtonComponent[] }

export type CardComponent =
  | CardMarkdownComponent | CardHrComponent | CardImageComponent | CardPanelComponent | CardButtonComponent
  | CardButtonRowComponent

/** Card header (from `<title>`); plain text. */
export interface CardHeader { title: string; subtitle?: string; template?: string }

/** One interactive card message. */
export interface CardMessageDraft { kind: 'card'; header?: CardHeader; elements: CardComponent[] }

/** One media message (audio / video / file) split out of the logical message. */
export interface CardMediaDraft { kind: 'media'; msgType: 'audio' | 'media' | 'file'; ref: ResourceRef; name?: string }

export type CardDraft = CardMessageDraft | CardMediaDraft

// ---------------------------------------------------------------------------------------------------------------
// Payload

/** Card JSON 2.0 document (what `content` of an `interactive` message / a CardKit entity holds). */
export interface CardJson {
  schema: '2.0'
  config: Record<string, unknown>
  header?: Record<string, unknown>
  body: { elements: Record<string, unknown>[] }
}

/**
 * Exact request body of one platform message, `content` as an object (goldens and reports see real strings);
 * {@link cardRequestBody} gives the wire form with `content` JSON-encoded.
 */
export type CardPayload =
  | { msg_type: 'interactive'; content: CardJson }
  | { msg_type: 'audio' | 'media' | 'file'; content: { file_key: string } }

/** The wire body of a payload: `content` as the JSON string Lark expects. */
export function cardRequestBody(payload: CardPayload): { msg_type: CardPayload['msg_type']; content: string } {
  return { msg_type: payload.msg_type, content: JSON.stringify(payload.content) }
}

// ---------------------------------------------------------------------------------------------------------------
// Streaming patches

/**
 * One incremental update of a streamed card (`Mode.diff` output, consumed by the CardKit driver through
 * {@link cardKitOps}). Ids are card element ids; components are draft components of the *next* draft.
 */
export type CardPatch =
  /** `PUT …/elements/:id/content`; `append` = the new text extends the old one (typewriter). */
  | { op: 'content'; id: string; component: CardMarkdownComponent; append: boolean }
  /** `PATCH …/elements/:id` with the listed fields of the serialized component. */
  | { op: 'patch'; id: string; component: CardComponent; fields: string[] }
  /** `POST …/elements`: insert after / before a sibling; neither ⇒ append to the card body. */
  | { op: 'insert'; components: CardComponent[]; after?: string; before?: string }
  /** `DELETE …/elements/:id`. */
  | { op: 'delete'; id: string }

/** Wire form of a {@link CardPatch}: resources resolved, components serialized. */
export type CardKitOp =
  | { type: 'content'; elementId: string; content: string; append: boolean }
  | { type: 'patch'; elementId: string; partial: Record<string, unknown> }
  | { type: 'insert'; elements: Record<string, unknown>[]; after?: string; before?: string }
  | { type: 'delete'; elementId: string }

// ---------------------------------------------------------------------------------------------------------------
// Nodes (handler output)

interface Md {
  md: string
  refs: ResourceRef[]
  /** Buttons hoisted out of inline content; placed after the enclosing flow block. */
  buttons: CardButtonComponent[]
}

export type CardInlineNode = { kind: 'inline' } & Md
export type CardBlockNode = { kind: 'block'; id: string; tables: number; list?: boolean; size?: 'notation' } & Md
export interface CardComponentNode { kind: 'component'; component: CardComponent }
export interface CardMediaNode { kind: 'media'; msgType: 'audio' | 'media' | 'file'; ref: ResourceRef; name?: string; path: string }
export type CardLiNode = { kind: 'li'; checked?: boolean; tables: number } & Md
export type CardCellNode = { kind: 'cell'; header: boolean; align?: Align } & Md
export interface CardRowNode { kind: 'row'; cells: CardCellNode[] }
export type CardSummaryNode = { kind: 'summary' } & Md

/** Anything a handler returns; `assemble` consumes the flow-level members. */
export type CardNode =
  | CardInlineNode | CardBlockNode | CardComponentNode | CardMediaNode | CardLiNode | CardCellNode | CardRowNode
  | CardSummaryNode

export interface CardTypes extends ModeTypes {
  node: CardNode
  draft: CardDraft
  payload: CardPayload
  patch: CardPatch
}

// ---------------------------------------------------------------------------------------------------------------
// Config and constants

/** Configuration of the card mode; `LarkBot.createModes()` passes the adapter config — `LarkConfig` fits. */
export interface CardModeConfig {
  /** `false` leaves the `all` variant of `<at>` undeclared, so an @all mention renders as text. */
  allowAtAll?: boolean
  /** Card callbacks accepted (default true): declares the `action` variant of `<button>`. */
  callbacks?: boolean
  /** CardKit streaming (default true): `streamDriver` returns the CardKit driver and `limit.stream.interval` is set. */
  cardStreaming?: boolean
  /** `limit.elements` (default 200). */
  elementLimit?: number
  /** `limit.payload.bytes` (default 30 000). */
  payloadBytes?: number
  /** A diff with more ops than this becomes `'replace'` (default 8; one full update beats many 10-QPS calls). */
  maxPatchOps?: number
}

/** Components and elements one card JSON 2.0 may carry (platform error 300305 above). */
export const CARD_ELEMENT_LIMIT = 200
/** Card JSON bytes the platform accepts. */
export const CARD_PAYLOAD_BYTES = 30_000
/** GFM tables one markdown component may hold. */
export const CARD_TABLES_PER_MARKDOWN = 4
/** CardKit: 10 QPS per card entity. */
export const CARD_STREAM_INTERVAL = 120
/** CardKit streaming config. */
export const CARD_STREAMING_CONFIG = {
  print_frequency_ms: { default: 50 },
  print_step: { default: 2 },
  print_strategy: 'fast',
} as const

const DEFAULT_PANEL_TITLE = '详情'
const DEFAULT_IMAGE_ALT = '图片'
/** A realistic image key length for size checks before upload. */
const PLACEHOLDER_KEY = 'img_v2_00000000-0000-0000-0000-000000000000'

const BUTTON_TYPES: Readonly<Record<Theme, LarkButtonType>> = {
  default: 'default',
  info: 'primary',
  success: 'primary_filled',
  warning: 'danger',
  danger: 'danger_filled',
}

const HEADER_TEMPLATES: Readonly<Record<Theme, string>> = {
  default: 'default',
  info: 'blue',
  success: 'green',
  warning: 'orange',
  danger: 'red',
}

// ---------------------------------------------------------------------------------------------------------------
// Node helpers

const inline = (md: string, refs: ResourceRef[] = [], buttons: CardButtonComponent[] = []): CardInlineNode =>
  ({ kind: 'inline', md, refs, buttons })

/** Markdown of a component when it has to live inside markdown (list item, quote, cell, folded panel). */
function componentMd(component: CardComponent): Md & { tables: number } {
  switch (component.tag) {
    case 'markdown': return { md: component.content, refs: [...component.refs], buttons: [], tables: component.tables }
    case 'hr': return { md: '<hr>', refs: [], buttons: [], tables: 0 }
    case 'img': return { md: imageMd(component.alt, component.ref), refs: [component.ref], buttons: [], tables: 0 }
    case 'button': return { md: '', refs: [], buttons: [component], tables: 0 }
    case 'column_set': return { md: '', refs: [], buttons: [...component.buttons], tables: 0 }
    case 'collapsible_panel': {
      const inner = joinBlocks(component.elements.map(child => ({ ...componentMd(child), list: false })), false)
      return {
        md: [`**${component.title}**`, inner.md].filter(Boolean).join('\n\n'),
        refs: [...component.titleRefs, ...inner.refs],
        buttons: inner.buttons,
        tables: inner.tables,
      }
    }
  }
}

function imageMd(alt: string, ref: ResourceRef): string {
  const label = escapeCardText((alt || DEFAULT_IMAGE_ALT).replace(/\s+/g, ' ').trim())
  return `![${label}](${imagePlaceholder(ref.src)})`
}

function mediaLink(node: CardMediaNode): string {
  const label = escapeCardText(node.name ?? node.msgType)
  return /^https?:\/\//i.test(node.ref.src) ? `[${label}](${escapeLinkHref(node.ref.src)})` : label
}

/** Flow-level markdown of any node. */
function blockOf(node: CardNode): Md & { tables: number; list: boolean } {
  switch (node.kind) {
    case 'block': return { md: node.md, refs: node.refs, buttons: node.buttons, tables: node.tables, list: !!node.list }
    case 'component': return { ...componentMd(node.component), list: false }
    case 'media': return { md: mediaLink(node), refs: [], buttons: [], tables: 0, list: false }
    case 'row': {
      const run = concatInline(node.cells)
      return { ...run, tables: 0, list: false }
    }
    case 'li': return { md: node.md, refs: node.refs, buttons: node.buttons, tables: node.tables, list: false }
    default: return { md: node.md, refs: node.refs, buttons: node.buttons, tables: 0, list: false }
  }
}

/** Join flow blocks into one markdown text: `\n\n` between blocks, `\n` before a list when `tight`. */
function joinBlocks(blocks: readonly (Md & { tables: number; list: boolean })[], tight: boolean): Md & { tables: number } {
  let md = ''
  const refs: ResourceRef[] = []
  const buttons: CardButtonComponent[] = []
  let tables = 0
  for (const block of blocks) {
    refs.push(...block.refs)
    buttons.push(...block.buttons)
    tables += block.tables
    if (!block.md) continue
    md += md ? `${tight && block.list ? '\n' : '\n\n'}${block.md}` : block.md
  }
  return { md, refs, buttons, tables }
}

/** Inline concatenation of any nodes: blocks are flattened onto one line, joined by hard breaks. */
function concatInline(nodes: readonly CardNode[]): Md {
  let md = ''
  const refs: ResourceRef[] = []
  const buttons: CardButtonComponent[] = []
  for (const node of nodes) {
    if (node.kind === 'inline') {
      md += node.md
      refs.push(...node.refs)
      buttons.push(...node.buttons)
      continue
    }
    const block = blockOf(node)
    refs.push(...block.refs)
    buttons.push(...block.buttons)
    if (!block.md) continue
    const flat = block.md.replace(/\n+/g, CARD_BREAK)
    md += md && !md.endsWith(CARD_BREAK) ? `${CARD_BREAK}${flat}` : flat
  }
  return { md, refs, buttons }
}

function wrapNode(open: string, close: string, ctx: RenderContext<CardTypes>, el: Element): CardInlineNode {
  const run = concatInline(ctx.render(el.children))
  return inline(wrapInline(open, run.md, close), run.refs, run.buttons)
}

function block(ctx: RenderContext<CardTypes>, el: Element, run: Md, extra: Partial<CardBlockNode> = {}): CardBlockNode {
  return { kind: 'block', id: cardElementId(ctx.stableId(el)), tables: 0, ...run, ...extra }
}

/** The element being rendered stands in phrasing content (the img.inline / utton.inline position). */
function inPhrasing(ctx: RenderContext<CardTypes>): boolean {
  const parent = ctx.ancestors[ctx.ancestors.length - 1]
  return !!parent && isPhrasingContainer(parent.type)
}

const HEADING_LEVELS = { h1: 1, h2: 2, h3: 3, h4: 4, h5: 5, h6: 6 } as const

function heading(level: number) {
  return (el: Element, ctx: RenderContext<CardTypes>): CardBlockNode => {
    const run = concatInline(ctx.render(el.children))
    return block(ctx, el, { ...run, md: run.md ? `${'#'.repeat(level)} ${run.md}` : '' })
  }
}

function listNode(el: Element<'ul' | 'ol'>, ctx: RenderContext<CardTypes>, ordered: boolean): CardBlockNode {
  const items = ctx.render(el.children).filter((node): node is CardLiNode => node.kind === 'li')
  const start = ordered ? (el as Element<'ol'>).attrs.start : undefined
  let number = typeof start === 'number' ? start : 1
  const lines: string[] = []
  const refs: ResourceRef[] = []
  const buttons: CardButtonComponent[] = []
  let tables = 0
  for (const item of items) {
    const bullet = ordered ? `${number++}. ` : '- '
    const marker = typeof item.checked === 'boolean' ? `${bullet}[${item.checked ? 'x' : ' '}] ` : bullet
    let content = item.md
    // A fence cannot follow the marker (it would be indented); give the marker its own line.
    if (content && fencedLines(content)[0]) content = `\n${content}`
    lines.push(content ? prefixLines(content, marker, ' '.repeat(Math.max(4, bullet.length))) : marker.trimEnd())
    refs.push(...item.refs)
    buttons.push(...item.buttons)
    tables += item.tables
  }
  return block(ctx, el, { md: lines.join('\n'), refs, buttons }, { tables, list: true })
}

function cellNode(el: Element<'th' | 'td'>, ctx: RenderContext<CardTypes>, header: boolean): CardCellNode {
  const run = concatInline(ctx.render(el.children))
  // A newline would end the table row and an unescaped pipe would split the cell.
  const md = run.md.replace(/\n/g, CARD_BREAK).replace(/(?<!\\)\|/g, '\\|').trim()
  return { kind: 'cell', header, ...el.attrs.align ? { align: el.attrs.align } : {}, md, refs: run.refs, buttons: run.buttons }
}

function tableNode(el: Element<'table'>, ctx: RenderContext<CardTypes>): CardBlockNode {
  const rows = ctx.render(el.children).filter((node): node is CardRowNode => node.kind === 'row')
  const columns = Math.max(1, ...rows.map(row => row.cells.length))
  const refs: ResourceRef[] = []
  const buttons: CardButtonComponent[] = []
  const line = (row: CardRowNode | undefined) => {
    const cells: string[] = []
    for (let column = 0; column < columns; column++) {
      const cell = row?.cells[column]
      if (cell) {
        refs.push(...cell.refs)
        buttons.push(...cell.buttons)
      }
      cells.push(cell?.md ?? '')
    }
    return `| ${cells.join(' | ')} |`
  }
  const aligns: (Align | undefined)[] = []
  for (let column = 0; column < columns; column++) {
    aligns.push(rows.map(row => row.cells[column]?.align).find(align => align !== undefined && align !== 'left'))
  }
  const separator = `| ${aligns.map(align => align === 'right' ? '---:' : align === 'center' ? ':---:' : '---').join(' | ')} |`
  const md = [line(rows[0]), separator, ...rows.slice(1).map(line)].join('\n')
  return block(ctx, el, { md, refs, buttons }, { tables: 1 })
}

function extOf(value: string | undefined): string | undefined {
  return /\.([a-z0-9]+)(?:[?#].*)?$/i.exec(value ?? '')?.[1]?.toLowerCase()
}

function mediaNode(kind: 'audio' | 'video' | 'file', el: Element<'audio' | 'video' | 'file'>, ctx: RenderContext<CardTypes>): CardMediaNode {
  const { src, name } = el.attrs
  const extension = extOf(name ?? src)
  let msgType: CardMediaNode['msgType'] = 'file'
  if (kind === 'audio' && extension === 'opus') msgType = 'audio'
  else if (kind === 'video' && extension === 'mp4') msgType = 'media'
  const path = ctx.stableId(el)
  if (kind !== 'file' && msgType === 'file') {
    ctx.report.moved.push({ tag: kind, reason: kind === 'audio' ? 'not-opus' : 'not-mp4', path })
  }
  return { kind: 'media', msgType, ref: ctx.resource(kind, src, name ? { name } : {}), ...name ? { name } : {}, path }
}

function buttonComponent(el: Element<'button'>, ctx: RenderContext<CardTypes>): CardButtonComponent {
  const attrs = el.attrs
  // `input` is not a variant of this mode, so the engine renders the core fallback before any handler runs.
  if (attrs.type === 'input') throw new TypeError('the card mode does not render input buttons')
  const label = ctx.text(el.children).replace(/\s+/g, ' ').trim()
  const behavior: CardButtonBehavior = attrs.type === 'link'
    ? { type: 'open_url', url: attrs.href }
    : { type: 'callback', value: { v4: { id: attrs.id, ...attrs.data === undefined ? {} : { data: attrs.data } } } }
  return {
    tag: 'button',
    id: cardElementId(ctx.stableId(el)),
    text: label || (attrs.type === 'link' ? attrs.href : attrs.id),
    type: BUTTON_TYPES[attrs.theme ?? 'default'] ?? 'default',
    behavior,
    disabled: !!attrs.disabled,
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Assemble

function buttonRow(buttons: CardButtonComponent[]): CardComponent {
  const [first] = buttons
  if (buttons.length === 1) return first!
  return { tag: 'column_set', id: cardElementId(`${first!.id}#row`), buttons }
}

/**
 * Turn flow nodes into components: consecutive markdown merges (same text size, ≤ 4 tables), components stand alone,
 * hoisted buttons follow their block. `report` gets a `moved` entry for media that cannot split out (inside a panel).
 */
function assembleFlow(nodes: readonly CardNode[], report?: RenderReport): CardComponent[] {
  const out: CardComponent[] = []
  let open: CardMarkdownComponent | undefined
  const pushMd = (id: string, md: string, refs: ResourceRef[], tables: number, size?: 'notation') => {
    if (!md) return
    if (open && open.size === size && open.tables + tables <= CARD_TABLES_PER_MARKDOWN) {
      open.content += `\n\n${md}`
      open.refs.push(...refs)
      open.tables += tables
      return
    }
    open = { tag: 'markdown', id, content: md, refs: [...refs], tables, ...size ? { size } : {} }
    out.push(open)
  }
  const pushComponent = (component: CardComponent) => {
    out.push(component)
    open = undefined
  }
  const pushButtons = (buttons: CardButtonComponent[]) => {
    if (buttons.length) pushComponent(buttonRow(buttons))
  }
  nodes.forEach((node, index) => {
    switch (node.kind) {
      case 'component':
        pushComponent(node.component)
        return
      case 'block':
        pushMd(node.id, node.md, node.refs, node.tables, node.size)
        pushButtons(node.buttons)
        return
      case 'media':
        report?.moved.push({ tag: node.ref.kind as 'audio' | 'video' | 'file', reason: 'linked', path: node.path })
        pushMd(cardElementId(`${node.path}#link`), mediaLink(node), [], 0)
        return
      default: {
        const flat = blockOf(node)
        pushMd(cardElementId(`~flow/${index}`), flat.md, flat.refs, flat.tables)
        pushButtons(flat.buttons)
      }
    }
  })
  return out
}

/** Merge adjacent markdown components again (after folding); the first id wins. */
function mergeMarkdown(components: readonly CardComponent[]): CardComponent[] {
  const out: CardComponent[] = []
  for (const component of components) {
    const last = out[out.length - 1]
    if (component.tag === 'markdown' && last?.tag === 'markdown' && last.size === component.size
      && last.tables + component.tables <= CARD_TABLES_PER_MARKDOWN) {
      out[out.length - 1] = {
        ...last,
        content: [last.content, component.content].filter(Boolean).join('\n\n'),
        refs: [...last.refs, ...component.refs],
        tables: last.tables + component.tables,
      }
      continue
    }
    out.push(component)
  }
  return out
}

/** Panels in document pre-order (outer before inner): the folding order ("oldest first"). */
function panelOrder(components: readonly CardComponent[], out: string[] = []): string[] {
  for (const component of components) {
    if (component.tag !== 'collapsible_panel') continue
    out.push(component.id)
    panelOrder(component.elements, out)
  }
  return out
}

function countPanels(components: readonly CardComponent[]): number {
  return panelOrder(components).length
}

/** Replace the panels in `fold` by their flat markdown (title in bold, then the content; buttons stay buttons). */
function foldPanels(components: readonly CardComponent[], fold: ReadonlySet<string>): CardComponent[] {
  const out: CardComponent[] = []
  for (const component of components) {
    if (component.tag !== 'collapsible_panel') {
      out.push(component)
      continue
    }
    if (!fold.has(component.id)) {
      out.push({ ...component, elements: foldPanels(component.elements, fold) })
      continue
    }
    const flat = componentMd(component)
    out.push({ tag: 'markdown', id: component.id, content: flat.md, refs: flat.refs, tables: flat.tables })
    if (flat.buttons.length) out.push(buttonRow(flat.buttons))
  }
  return mergeMarkdown(out)
}

/** Objects with a `tag` in a serialized card: what the platform counts against the element limit. */
export function countCardElements(value: unknown): number {
  if (Array.isArray(value)) return value.reduce((total: number, entry) => total + countCardElements(entry), 0)
  if (typeof value !== 'object' || value === null) return 0
  return ('tag' in value ? 1 : 0)
    + Object.values(value).reduce((total: number, entry) => total + countCardElements(entry), 0)
}

/**
 * Fold the fewest oldest panels so the card fits `limit` elements and `bytes` of JSON (folding drops the panel
 * chrome, so it shrinks both). Folding one more panel never adds elements, so
 * the smallest fitting prefix of the pre-order is found by binary search. Returns the number of panels removed.
 */
function fitElements(draft: CardMessageDraft, limit: number, bytes: number): number {
  const fits = (elements: CardComponent[]) => {
    const card = cardJson({ ...draft, elements }, () => PLACEHOLDER_KEY)
    return countCardElements(card) <= limit && new TextEncoder().encode(JSON.stringify(card)).length <= bytes
  }
  if (fits(draft.elements)) return 0
  const order = panelOrder(draft.elements)
  if (!order.length) return 0
  const at = (k: number) => foldPanels(draft.elements, new Set(order.slice(0, k)))
  let low = 1
  let high = order.length
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if (fits(at(middle))) high = middle
    else low = middle + 1
  }
  const before = order.length
  draft.elements = at(high)
  return before - countPanels(draft.elements)
}

/** Final pass over every component: dsh `normalizeMarkdown` port on the text, then card-unique element ids. */
function finalize(draft: CardMessageDraft): void {
  const seen = new Set<string>()
  const unique = (id: string) => {
    let candidate = id
    for (let n = 1; seen.has(candidate); n++) candidate = cardElementId(`${id}#${n}`)
    seen.add(candidate)
    return candidate
  }
  const visit = (components: CardComponent[]): CardComponent[] => components.map((component) => {
    switch (component.tag) {
      case 'markdown': return { ...component, id: unique(component.id), content: normalizeCardMarkdown(component.content) }
      case 'collapsible_panel': {
        const id = unique(component.id)
        return { ...component, id, title: normalizeCardMarkdown(component.title), elements: visit(component.elements) }
      }
      case 'column_set': {
        const id = unique(component.id)
        return { ...component, id, buttons: component.buttons.map(button => ({ ...button, id: unique(button.id) })) }
      }
      default: return { ...component, id: unique(component.id) }
    }
  })
  draft.elements = visit(draft.elements)
}

function assemble(nodes: readonly CardNode[], envelope: Envelope, ctx: RenderContext<CardTypes>, limit: number, bytes: number): CardDraft[] {
  const drafts: CardDraft[] = []
  let flow: CardNode[] = []
  const flush = () => {
    if (!flow.length) return
    const elements = assembleFlow(flow, ctx.report)
    if (elements.length) drafts.push({ kind: 'card', elements })
    flow = []
  }
  for (const node of nodes) {
    if (node.kind === 'media') {
      flush()
      drafts.push({ kind: 'media', msgType: node.msgType, ref: node.ref, ...node.name ? { name: node.name } : {} })
      continue
    }
    flow.push(node)
  }
  flush()

  const title = envelope.title
  if (title) {
    const value = ctx.text(title.children).replace(/\s+/g, ' ').trim()
    const subtitle = title.attrs.subtitle?.replace(/\s+/g, ' ').trim()
    let target = drafts.find((draft): draft is CardMessageDraft => draft.kind === 'card')
    if (!target) {
      target = { kind: 'card', elements: [] }
      drafts.unshift(target)
    }
    target.header = {
      title: value,
      ...subtitle ? { subtitle } : {},
      ...title.attrs.theme ? { template: HEADER_TEMPLATES[title.attrs.theme] ?? 'default' } : {},
    }
  }
  if (!drafts.length) {
    drafts.push({ kind: 'card', elements: [{ tag: 'markdown', id: cardElementId('message'), content: '', refs: [], tables: 0 }] })
  }
  for (const draft of drafts) {
    if (draft.kind !== 'card') continue
    ctx.report.folded += fitElements(draft, limit, bytes)
    finalize(draft)
  }
  if (drafts.length > 1) ctx.report.split += drafts.length - 1
  return drafts
}

// ---------------------------------------------------------------------------------------------------------------
// Serialize

type KeyOf = (ref: ResourceRef) => string

function markdownContent(content: string, refs: readonly ResourceRef[], key: KeyOf): string {
  return resolveImagePlaceholders(content, (src) => {
    const ref = refs.find(item => item.src === src)
    return ref ? key(ref) : ''
  })
}

function plainText(content: string): Record<string, unknown> {
  return { tag: 'plain_text', content }
}

function serializeButton(button: CardButtonComponent): Record<string, unknown> {
  const behaviors = button.behavior.type === 'open_url'
    ? [{ type: 'open_url', default_url: button.behavior.url }]
    : [{ type: 'callback', value: button.behavior.value }]
  return { tag: 'button', element_id: button.id, text: plainText(button.text), type: button.type, disabled: button.disabled, behaviors }
}

/** One draft component as card JSON 2.0 (`key` resolves resource refs). */
export function serializeComponent(component: CardComponent, key: KeyOf): Record<string, unknown> {
  switch (component.tag) {
    case 'markdown':
      return {
        tag: 'markdown',
        element_id: component.id,
        content: markdownContent(component.content, component.refs, key),
        text_align: 'left',
        ...component.size ? { text_size: component.size } : {},
      }
    case 'hr': return { tag: 'hr', element_id: component.id }
    case 'img':
      return { tag: 'img', element_id: component.id, img_key: key(component.ref), alt: plainText(component.alt), preview: true }
    case 'collapsible_panel':
      return {
        tag: 'collapsible_panel',
        element_id: component.id,
        expanded: component.expanded,
        header: {
          title: { tag: 'markdown', content: markdownContent(component.title, component.titleRefs, key) },
          vertical_align: 'center',
          icon: { tag: 'standard_icon', token: 'down-small-ccm_outlined', color: 'grey', size: '12px 12px' },
          icon_position: 'follow_text',
          icon_expanded_angle: -180,
        },
        vertical_spacing: '4px',
        padding: '2px 0px 2px 0px',
        elements: component.elements.map(child => serializeComponent(child, key)),
      }
    case 'button': return serializeButton(component)
    case 'column_set':
      return {
        tag: 'column_set',
        element_id: component.id,
        flex_mode: 'flow',
        horizontal_spacing: '8px',
        columns: component.buttons.map(button => ({ tag: 'column', width: 'auto', elements: [serializeButton(button)] })),
      }
  }
}

/** The card JSON 2.0 document of a card draft. */
export function cardJson(draft: CardMessageDraft, key: KeyOf): CardJson {
  const header = draft.header && {
    title: plainText(draft.header.title),
    ...draft.header.subtitle ? { subtitle: plainText(draft.header.subtitle) } : {},
    ...draft.header.template ? { template: draft.header.template } : {},
  }
  return {
    schema: '2.0',
    config: { update_multi: true },
    ...header ? { header } : {},
    body: { elements: draft.elements.map(component => serializeComponent(component, key)) },
  }
}

/**
 * A copy of `card` with CardKit streaming switched on (`open`: `streaming_mode: true` + `streaming_config`) or
 * off (`close`: `streaming_mode: false`, required before callbacks work).
 */
export function streamingCard(card: CardJson, streaming: boolean): CardJson {
  return {
    ...card,
    config: {
      ...card.config,
      streaming_mode: streaming,
      ...streaming ? { streaming_config: CARD_STREAMING_CONFIG } : {},
    },
  }
}

function resolver(resolved: ReadonlyMap<ResourceRef, ResolvedResource>): KeyOf {
  return ref => resolved.get(ref)?.key ?? ''
}

function serializeDraft(draft: CardDraft, key: KeyOf): CardPayload {
  if (draft.kind === 'media') return { msg_type: draft.msgType, content: { file_key: key(draft.ref) } }
  return { msg_type: 'interactive', content: cardJson(draft, key) }
}

/**
 * Turn diff ops into CardKit requests for one tick: resources resolved against the tick's prepared draft (the
 * `change.draft` the scheduler passes to the driver), components serialized, patch fields picked.
 */
export function cardKitOps(patches: readonly CardPatch[], prepared: Prepared<CardDraft> | ReadonlyMap<ResourceRef, ResolvedResource>): CardKitOp[] {
  const key = resolver(prepared instanceof Map ? prepared : (prepared as Prepared<CardDraft>).resolved)
  return patches.map((patch): CardKitOp => {
    switch (patch.op) {
      case 'content':
        return { type: 'content', elementId: patch.id, content: markdownContent(patch.component.content, patch.component.refs, key), append: patch.append }
      case 'patch': {
        const full = serializeComponent(patch.component, key)
        const partial: Record<string, unknown> = {}
        for (const field of patch.fields) if (field in full) partial[field] = full[field]
        return { type: 'patch', elementId: patch.id, partial }
      }
      case 'insert':
        return {
          type: 'insert',
          elements: patch.components.map(component => serializeComponent(component, key)),
          ...patch.after ? { after: patch.after } : {},
          ...patch.before ? { before: patch.before } : {},
        }
      case 'delete':
        return { type: 'delete', elementId: patch.id }
    }
  })
}

// ---------------------------------------------------------------------------------------------------------------
// Diff

const fingerprintKey: KeyOf = ref => `ref:${ref.kind}:${ref.src}`

function fingerprint(value: unknown): string {
  return JSON.stringify(value, (_key, item) => item instanceof ResourceRef ? `ref:${item.kind}:${item.src}` : item) ?? ''
}

function changedFields(prev: CardComponent, next: CardComponent): string[] {
  const left = serializeComponent(prev, fingerprintKey)
  const right = serializeComponent(next, fingerprintKey)
  const keys = new Set([...Object.keys(left), ...Object.keys(right)])
  keys.delete('element_id')
  return [...keys].filter(key => fingerprint(left[key]) !== fingerprint(right[key]))
}

function diffComponent(prev: CardComponent, next: CardComponent): CardPatch[] | 'replace' {
  if (prev.tag !== next.tag) return 'replace'
  if (fingerprint(prev) === fingerprint(next)) return []
  switch (next.tag) {
    case 'markdown': {
      const before = prev as CardMarkdownComponent
      if ((before.size ?? '') !== (next.size ?? '')) return 'replace'
      return [{ op: 'content', id: next.id, component: next, append: next.content.startsWith(before.content) }]
    }
    case 'collapsible_panel': {
      const before = prev as CardPanelComponent
      const inner = diffList(before.elements, next.elements, next.id)
      if (inner === 'replace') return [{ op: 'patch', id: next.id, component: next, fields: ['header', 'expanded', 'elements'] }]
      const header = before.title !== next.title || before.expanded !== next.expanded
        || fingerprint(before.titleRefs) !== fingerprint(next.titleRefs)
      return [...header ? [{ op: 'patch', id: next.id, component: next, fields: ['header', 'expanded'] } as CardPatch] : [], ...inner]
    }
    default: {
      const fields = changedFields(prev, next)
      return fields.length ? [{ op: 'patch', id: next.id, component: next, fields }] : []
    }
  }
}

/**
 * Diff two sibling lists by element id. Surviving ids must keep their relative order (else `'replace'`); removed
 * ids are deleted, new runs inserted after the previous sibling (or before the next survivor); inside a container
 * (`parent`) a run without any anchor makes the caller patch the container instead (`'replace'`).
 */
function diffList(prev: readonly CardComponent[], next: readonly CardComponent[], parent?: string): CardPatch[] | 'replace' {
  const before = new Map(prev.map(component => [component.id, component]))
  const after = new Set(next.map(component => component.id))
  if (before.size !== prev.length || after.size !== next.length) return 'replace'
  const kept = prev.filter(component => after.has(component.id)).map(component => component.id)
  const survivors = next.filter(component => before.has(component.id)).map(component => component.id)
  if (kept.join('\n') !== survivors.join('\n')) return 'replace'

  const ops: CardPatch[] = []
  for (const component of prev) if (!after.has(component.id)) ops.push({ op: 'delete', id: component.id })

  let anchor: string | undefined
  let run: CardComponent[] = []
  const flush = (next?: string): boolean => {
    if (!run.length) return true
    if (anchor) ops.push({ op: 'insert', components: run, after: anchor })
    else if (next) ops.push({ op: 'insert', components: run, before: next })
    else if (parent === undefined) ops.push({ op: 'insert', components: run })
    else return false
    anchor = run[run.length - 1]!.id
    run = []
    return true
  }
  for (const component of next) {
    if (!before.has(component.id)) {
      run.push(component)
      continue
    }
    if (!flush(component.id)) return 'replace'
    anchor = component.id
  }
  if (!flush()) return 'replace'

  for (const component of next) {
    const old = before.get(component.id)
    if (!old) continue
    const changes = diffComponent(old, component)
    if (changes === 'replace') return 'replace'
    ops.push(...changes)
  }
  return ops
}

/** `Mode.diff` of the card mode (see the module comment); exported for the CardKit driver's tests. */
export function diffCards(prev: CardDraft, next: CardDraft, maxOps = 8): CardPatch[] | 'replace' {
  if (prev.kind !== 'card' || next.kind !== 'card') {
    return prev.kind === next.kind && fingerprint(prev) === fingerprint(next) ? [] : 'replace'
  }
  if (fingerprint(prev.header ?? null) !== fingerprint(next.header ?? null)) return 'replace'
  const ops = diffList(prev.elements, next.elements)
  if (ops === 'replace' || ops.length > maxOps) return 'replace'
  return ops
}

// ---------------------------------------------------------------------------------------------------------------
// Mode

/**
 * Create the Lark card mode from the adapter configuration (`LarkBot.createModes()` passes `LarkConfig`). Pure: the
 * config shapes the element table, the limits and the element vetoes.
 */
export function createCardMode(config: CardModeConfig = {}): Mode<CardTypes> {
  const callbacks = config.callbacks !== false
  const elementLimit = config.elementLimit ?? CARD_ELEMENT_LIMIT
  const payloadLimit = config.payloadBytes ?? CARD_PAYLOAD_BYTES
  const maxOps = config.maxPatchOps ?? 8

  const elements = new ElementRegistry<CardTypes>()
    .register('text', (el, ctx) => inline(textMarkdown(el.attrs.content, !ctx.ancestors.some(item => item.type === 'a'))))
    .register('br', () => inline(CARD_BREAK))
    .register('p', (el, ctx) => block(ctx, el, concatInline(ctx.render(el.children))))
    // A root `<title>` becomes the card header through `assemble`, which is why the mode declares the envelope tag.
    .envelope('title')
    .register('b', (el, ctx) => wrapNode('**', '**', ctx, el))
    .register('i', (el, ctx) => wrapNode('*', '*', ctx, el))
    .register('s', (el, ctx) => wrapNode('~~', '~~', ctx, el))
    .register('code', (el, ctx) => inline(cardCodeSpan(ctx.text(el.children))))
    .register('a', (el, ctx) => {
      const href = el.attrs.href?.trim()
      const run = concatInline(ctx.render(el.children))
      if (!href) return inline(run.md, run.refs, run.buttons)
      const plain = ctx.text(el.children).trim()
      return inline(cardLink(plain === href ? '' : run.md, href), run.refs, run.buttons)
    })
    .register('at', (el) => {
      const mention = cardMention(el.attrs.type === 'all' ? 'all' : 'user', el.attrs.id)
      return inline(mention || escapeCardText(`@${el.attrs.name ?? ''}`))
    // A group that forbids @all rejects the whole send: with `allowAtAll: false` the variant is not declared.
    }, { variants: config.allowAtAll === false ? ['user'] : ['user', 'all'] })
    .register('span', (el, ctx) => {
      const run = concatInline(ctx.render(el.children))
      return inline(cardFont(el.attrs.color, run.md), run.refs, run.buttons)
    }, { variants: ['color'] })
    .register('h1', heading(HEADING_LEVELS.h1))
    .register('h2', heading(HEADING_LEVELS.h2))
    .register('h3', heading(HEADING_LEVELS.h3))
    .register('h4', heading(HEADING_LEVELS.h4))
    .register('h5', heading(HEADING_LEVELS.h5))
    .register('h6', heading(HEADING_LEVELS.h6))
    .register('ul', (el, ctx) => listNode(el, ctx, false))
    .register('ol', (el, ctx) => listNode(el, ctx, true))
    .register('li', (el, ctx): CardLiNode => {
      // A nested list follows its paragraph tightly; other blocks of one item are separate paragraphs.
      const run = joinBlocks(ctx.render(el.children).map(blockOf), true)
      return { kind: 'li', ...run, ...typeof el.attrs.checked === 'boolean' ? { checked: el.attrs.checked } : {} }
    }, { variants: ['checked', 'nested'] })
    .register('blockquote', (el, ctx) => {
      const run = joinBlocks(ctx.render(el.children).map(blockOf), false)
      return block(ctx, el, { ...run, md: run.md ? prefixLines(run.md, '> ', '> ') : '' }, { tables: run.tables })
    })
    .register('pre', (el, ctx) => {
      const lang = el.attrs.lang?.trim()
      return block(ctx, el, { md: cardFence(ctx.text(el.children), lang || undefined), refs: [], buttons: [] })
    }, { variants: ['lang'] })
    .register('hr', (el, ctx) => ({ kind: 'component', component: { tag: 'hr', id: cardElementId(ctx.stableId(el)) } }))
    .register('table', (el, ctx) => tableNode(el, ctx), { variants: ['align'] })
    .register('tr', (el, ctx) => ({
      kind: 'row',
      cells: ctx.render(el.children).filter((node): node is CardCellNode => node.kind === 'cell'),
    }))
    .register('th', (el, ctx) => cellNode(el, ctx, true))
    .register('td', (el, ctx) => cellNode(el, ctx, false), { variants: ['block'] })
    .register('details', (el, ctx) => {
      const nodes = ctx.render(el.children)
      const summary = nodes.find((node): node is CardSummaryNode => node.kind === 'summary')
      const rest = nodes.filter(node => node.kind !== 'summary')
      const elements = assembleFlow(rest, ctx.report)
      if (summary?.buttons.length) elements.unshift(buttonRow(summary.buttons))
      const component: CardPanelComponent = {
        tag: 'collapsible_panel',
        id: cardElementId(ctx.stableId(el)),
        title: summary?.md || DEFAULT_PANEL_TITLE,
        titleRefs: summary?.refs ?? [],
        expanded: !!el.attrs.open,
        elements,
      }
      return { kind: 'component', component }
    })
    .register('summary', (el, ctx): CardSummaryNode => ({ kind: 'summary', ...concatInline(ctx.render(el.children)) }))
    .register('small', (el, ctx) => block(ctx, el, concatInline(ctx.render(el.children)), { size: 'notation' }))
    .register('img', (el, ctx): CardNode => {
      const ref = ctx.resource('image', el.attrs.src, {
        ...el.attrs.width === undefined ? {} : { width: el.attrs.width },
        ...el.attrs.height === undefined ? {} : { height: el.attrs.height },
      })
      const alt = el.attrs.alt ?? ''
      if (inPhrasing(ctx)) return inline(imageMd(alt, ref), [ref])
      return { kind: 'component', component: { tag: 'img', id: cardElementId(ctx.stableId(el)), ref, alt } }
    }, { variants: ['inline'] })
    .register('audio', (el, ctx) => mediaNode('audio', el, ctx))
    .register('video', (el, ctx) => mediaNode('video', el, ctx))
    .register('file', (el, ctx) => mediaNode('file', el, ctx))
    .register('button', (el, ctx): CardNode => {
      const button = buttonComponent(el, ctx)
      if (!inPhrasing(ctx)) return { kind: 'component', component: button }
      ctx.report.moved.push({ tag: 'button', reason: 'hoisted', path: ctx.stableId(el) })
      return inline('', [], [button])
    // Action buttons need `card.action.trigger`: without callbacks the variant is not declared (text fallback). `input`
    // buttons are never declared — a card cannot make the clicker send a message.
    }, { variants: callbacks ? ['action', 'link', 'theme', 'inline'] : ['link', 'theme', 'inline'] })
    .register('button-group', (el, ctx) => {
      const buttons: CardButtonComponent[] = []
      for (const node of ctx.render(el.children)) {
        if (node.kind === 'component' && node.component.tag === 'button') buttons.push(node.component)
        else if (node.kind === 'inline') buttons.push(...node.buttons)
      }
      if (!buttons.length) return []
      const component: CardButtonRowComponent = { tag: 'column_set', id: cardElementId(ctx.stableId(el)), buttons }
      return { kind: 'component', component }
    })

  const limits: Partial<Record<LimitKey, number>> = {
    'limit.elements': elementLimit,
    'limit.payload.bytes': payloadLimit,
    ...config.cardStreaming !== false ? { 'limit.stream.interval': CARD_STREAM_INTERVAL } : {},
  }

  return defineMode<CardTypes>()({
    id: 'card',
    elements,
    limits,
    // The card renders `<hr>` natively; declaring it forbidden keeps that a requirement rather than an accident.
    degradation: { forbidden: ['hr'] },
    assemble: (nodes, envelope, ctx) => assemble(nodes, envelope, ctx, elementLimit, payloadLimit),
    serialize: (msg: Prepared<CardDraft>, _ctx: SerializeContext) => serializeDraft(msg.draft, resolver(msg.resolved)),
    diff: (prev, next) => diffCards(prev, next, maxOps),
    check: (draft) => {
      if (draft.kind !== 'card') return []
      const card = cardJson(draft, () => PLACEHOLDER_KEY)
      const violations: LimitViolation[] = []
      const bytes = new TextEncoder().encode(JSON.stringify(card)).length
      if (bytes > payloadLimit) {
        violations.push({
          kind: 'size', key: 'limit.payload.bytes', limit: payloadLimit, actual: bytes,
          message: `the card JSON is ${bytes} bytes and the platform accepts ${payloadLimit}`,
        })
      }
      const count = countCardElements(card)
      if (count > elementLimit) {
        violations.push({
          kind: 'size', key: 'limit.elements', limit: elementLimit, actual: count,
          message: `the card has ${count} elements and the platform accepts ${elementLimit}`,
        })
      }
      return violations
    },
  })
}
