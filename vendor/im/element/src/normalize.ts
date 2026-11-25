/**
 * `normalize()`: the structural contract adapters rely on.
 *
 * - the root is one `<message>`;
 * - flow containers (`message`, `li`, `td`, `th`, `blockquote`, `details`) contain blocks: bare inline runs are
 *   wrapped into `<p>`, whitespace-only runs between blocks are dropped;
 * - envelope elements (`quote`, `title`) only appear as direct root children, at most one each, hoisted to the
 *   front in the order `quote`, `title`; `summary` is hoisted to the front of its `details`;
 * - `<markdown>` stays one element with its source in `content` (text children are joined into it); the IM render
 *   engine expands it, so the source is never parsed here;
 * - a `<fallback>` may stand wherever its candidates may: each candidate becomes one `<case>` normalized as content
 *   of the element the `<fallback>` stands in (a fallback of phrasing content joins the surrounding inline run);
 * - T3 (reserved), alias and unknown tags are rejected, as are blocks inside phrasing content and children of
 *   elements that take none;
 * - adjacent text is merged, empty text dropped. The input is never mutated; the result is idempotent.
 */

import { elementInfo, isReservedTag, isTag, tagAliases } from './elements.ts'
import { make, toChildren } from './factory.ts'
import type { Child, Element, Tag } from './vocabulary.ts'

/** Thrown for content that violates the v4 structure. `path` locates the offending node (`message/ul[2]/li[0]`). */
export class NormalizeError extends Error {
  override name = 'NormalizeError'
  constructor(message: string, readonly path: string) {
    super(`${message} (at ${path})`)
  }
}

type Node = Element & { attrs: Record<string, unknown> }

/** Normalize any content into one `<message>` root. */
export function normalize(content: Child): Element<'message'> {
  const nodes = toChildren(content) as Node[]
  if (nodes.length === 1 && nodes[0]!.type === 'message') {
    const [root] = nodes as [Node]
    return make('message', root.attrs, normalizeChildren(root.children, 'message'), root.key) as Element<'message'>
  }
  return make('message', {}, normalizeChildren(nodes, 'message'), undefined) as Element<'message'>
}

/**
 * Normalize content as the children of an element of tag `parent` (used for fallback output and partial trees).
 * `path` is only used in error messages.
 */
export function normalizeChildren(content: Child, parent: Tag, path: string = parent): Element[] {
  const nodes = toChildren(content) as Node[]
  const model = elementInfo[parent].content
  switch (model) {
    case 'empty': {
      const extra = nodes.find(node => !isEmptyText(node))
      if (extra) throw new NormalizeError(`<${parent}> takes no children, got <${extra.type}>`, path)
      return []
    }
    case 'text': return normalizeText(nodes, parent, path)
    case 'phrasing': return normalizePhrasing(nodes, parent, path)
    case 'flow':
    case 'details': return normalizeFlow(nodes, parent, path)
    case 'list': return normalizeList(nodes, parent, path)
    case 'table': return normalizeOnly(nodes, parent, path, ['tr'])
    case 'row': return normalizeOnly(nodes, parent, path, ['th', 'td'])
    case 'buttons': return normalizeOnly(nodes, parent, path, ['button'])
    case 'options': return normalizeOnly(nodes, parent, path, ['option'])
    case 'cases':
      // A `<fallback>`'s candidates are normalized as content of *its* parent, which this function cannot see.
      if (!nodes.length) return []
      throw new NormalizeError(`the candidates of <${parent}> are normalized as content of its parent`, path)
  }
}

/** Candidates of a `<fallback>`: its `<case>` children, or each other child as a candidate of its own. */
function candidatesOf(node: Node): Node[][] {
  return (node.children as Node[]).map(child => child.type === 'case' ? toChildren(child.children) as Node[] : [child])
}

/** Whether a `<fallback>` holds only phrasing content, so it joins an inline run instead of standing as a block. */
function isInlineFallback(node: Node): boolean {
  return candidatesOf(node).every(candidate => candidate.every(child => child.type === 'fallback'
    ? isInlineFallback(child)
    : isTag(child.type) && elementInfo[child.type].position === 'inline'))
}

/** Normalize every candidate of a `<fallback>` as content of `parent`, the element the `<fallback>` stands in. */
function normalizeFallback(node: Node, parent: Tag, path: string): Node {
  const candidates = candidatesOf(node)
  if (!candidates.length) throw new NormalizeError('<fallback> needs at least one candidate', path)
  const cases = candidates.map((candidate, index) =>
    make('case', {}, normalizeChildren(candidate, parent, `${path}/case[${index}]`)))
  return make('fallback', {}, cases, node.key) as Node
}

function isEmptyText(node: Node) {
  return node.type === 'text' && !node.attrs.content
}

function isBlankText(node: Node) {
  return node.type === 'text' && typeof node.attrs.content === 'string' && !node.attrs.content.trim()
}

function childPath(path: string, node: Node, index: number) {
  return `${path}/${node.type || 'fragment'}[${index}]`
}

function checkTag(node: Node, path: string): Tag {
  const type = node.type as string
  if (isTag(type)) return type
  if (isReservedTag(type)) throw new NormalizeError(`<${type}> is reserved (T3) and not supported in v1`, path)
  const alias = tagAliases[type]
  if (alias) throw new NormalizeError(`unknown element <${type}>; use <${alias}>`, path)
  if (type === 'component') throw new NormalizeError('function components must be called while building the tree', path)
  throw new NormalizeError(`unknown element <${type}>`, path)
}

function nonEmptyString(value: unknown) {
  return typeof value === 'string' && value.length > 0
}

function checkAttrs(tag: Tag, attrs: Record<string, unknown>, path: string) {
  for (const name of elementInfo[tag].required ?? []) {
    if (!nonEmptyString(attrs[name])) throw new NormalizeError(`<${tag}> requires a non-empty "${name}"`, path)
  }
  if (tag === 'text' && typeof attrs.content !== 'string') {
    throw new NormalizeError('<text> requires a string "content"', path)
  }
  if (tag === 'at') {
    if (!['user', 'all', 'here', 'role'].includes(attrs.type as string)) {
      throw new NormalizeError(`<at> type must be user | all | here | role, got ${String(attrs.type)}`, path)
    }
    if ((attrs.type === 'user' || attrs.type === 'role') && !nonEmptyString(attrs.id)) {
      throw new NormalizeError(`<at type="${attrs.type}"> requires an "id"`, path)
    }
  }
  if (tag === 'button') {
    const field = ({ action: 'id', link: 'href', input: 'text', submit: 'id' } as Record<string, string>)[attrs.type as string]
    if (!field) throw new NormalizeError(`<button> type must be action | link | input | submit, got ${String(attrs.type)}`, path)
    if (!nonEmptyString(attrs[field])) throw new NormalizeError(`<button type="${attrs.type}"> requires "${field}"`, path)
    checkButtonStyle(attrs, path)
  }
  if (tag === 'button-group') {
    checkOneOf('button-group', 'width', attrs.width, ['auto', 'fill'], path)
    checkOneOf('button-group', 'align', attrs.align, ['left', 'center', 'right'], path)
  }
  if (tag === 'input') checkInput(attrs, path)
  if (tag === 'select') checkSelect(attrs, path)
  if (tag === 'option' && attrs.selected !== undefined && typeof attrs.selected !== 'boolean') {
    throw new NormalizeError('<option> selected must be a boolean', path)
  }
}

/** A `<select>`: it names a channel (`id` or `name`), and its initial value matches the arity `multiple` asks for. */
function checkSelect(attrs: Record<string, unknown>, path: string) {
  for (const name of ['placeholder', 'data', 'name']) {
    if (attrs[name] !== undefined && !nonEmptyString(attrs[name])) {
      throw new NormalizeError(`<select> ${name} must be a non-empty string`, path)
    }
  }
  if (attrs.id !== undefined && !nonEmptyString(attrs.id)) {
    throw new NormalizeError('<select> id must be a non-empty string', path)
  }
  if (!nonEmptyString(attrs.id) && !nonEmptyString(attrs.name)) {
    throw new NormalizeError('<select> requires an "id" (reports its pick) or a "name" (feeds its form)', path)
  }
  const value = attrs.value
  if (value === undefined) return
  const ok = attrs.multiple
    ? Array.isArray(value) && value.every(item => typeof item === 'string')
    : typeof value === 'string'
  if (!ok) {
    throw new NormalizeError(`<select${attrs.multiple ? ' multiple' : ''}> value must be ${attrs.multiple ? 'string[]' : 'a string'}`, path)
  }
}

/** A control's channel, its input mode, its bounds and the value type each mode takes. */
function checkInput(attrs: Record<string, unknown>, path: string) {
  checkOneOf('input', 'type', attrs.type, ['text', 'multiline', 'password', 'checkbox'], path)
  for (const name of ['label', 'placeholder', 'name', 'id']) {
    if (attrs[name] !== undefined && !nonEmptyString(attrs[name])) {
      throw new NormalizeError(`<input> ${name} must be a non-empty string`, path)
    }
  }
  if (!nonEmptyString(attrs.name) && !nonEmptyString(attrs.id)) {
    throw new NormalizeError('<input> requires a "name" (feeds its form) or an "id" (reports its toggle)', path)
  }
  const checkbox = attrs.type === 'checkbox'
  if (attrs.onChange !== undefined) {
    if (!checkbox) throw new NormalizeError('<input> onChange needs type="checkbox"', path)
    if (!nonEmptyString(attrs.id)) throw new NormalizeError('<input type="checkbox" onChange> requires an "id"', path)
  }
  if (attrs.maxLength !== undefined) {
    const max = attrs.maxLength
    if (typeof max !== 'number' || !Number.isInteger(max) || max <= 0) {
      throw new NormalizeError(`<input> maxLength must be a positive integer, got ${String(max)}`, path)
    }
  }
  if (attrs.value !== undefined && typeof attrs.value !== (checkbox ? 'boolean' : 'string')) {
    throw new NormalizeError(`<input${checkbox ? ' type="checkbox"' : ''}> value must be a ${checkbox ? 'boolean' : 'string'}`, path)
  }
}

/** Reject a present attribute outside its allowed values. */
function checkOneOf(tag: Tag, name: string, value: unknown, allowed: readonly string[], path: string) {
  if (value !== undefined && !allowed.includes(value as string)) {
    throw new NormalizeError(`<${tag}> ${name} must be ${allowed.join(' | ')}, got ${String(value)}`, path)
  }
}

/** The optional `ButtonStyle` attributes: closed values, a positive pixel width and a complete confirmation. */
function checkButtonStyle(attrs: Record<string, unknown>, path: string) {
  checkOneOf('button', 'size', attrs.size, ['tiny', 'small', 'medium', 'large'], path)
  checkOneOf('button', 'variant', attrs.variant, [
    'default', 'primary', 'danger', 'text', 'primary_text', 'danger_text', 'primary_filled', 'danger_filled', 'laser',
  ], path)
  const width = attrs.width
  if (width !== undefined && width !== 'default' && width !== 'fill'
    && !(typeof width === 'number' && Number.isFinite(width) && width > 0)) {
    throw new NormalizeError(`<button> width must be default | fill | a positive number of pixels, got ${String(width)}`, path)
  }
  for (const name of ['icon', 'tip', 'disabledTip']) {
    if (attrs[name] !== undefined && !nonEmptyString(attrs[name])) {
      throw new NormalizeError(`<button> ${name} must be a non-empty string`, path)
    }
  }
  const confirm = attrs.confirm as { title?: unknown; text?: unknown } | undefined
  if (confirm !== undefined && (typeof confirm !== 'object' || confirm === null
    || !nonEmptyString(confirm.title) || !nonEmptyString(confirm.text))) {
    throw new NormalizeError('<button> confirm requires a non-empty "title" and "text"', path)
  }
}

/** Normalize one element (its own tag, attributes and children); the caller checked its position. */
function normalizeElement(node: Node, tag: Tag, path: string): Node {
  checkAttrs(tag, node.attrs, path)
  if (tag === 'text') return make('text', node.attrs, [], node.key) as Node
  return make(tag, node.attrs, normalizeChildren(node.children, tag, path), node.key) as Node
}

function markdownSource(node: Node, path: string): string {
  if (typeof node.attrs.content === 'string') return node.attrs.content
  const children = toChildren(node.children) as Node[]
  if (children.every(child => child.type === 'text')) return children.map(child => child.attrs.content).join('')
  throw new NormalizeError('<markdown> requires a "content" string (or text children)', path)
}

/** `<markdown>` with its source in `content`; the render engine expands it (the source is never parsed here). */
function normalizeMarkdown(node: Node, path: string): Node {
  return make('markdown', { content: markdownSource(node, path) }, [], node.key) as Node
}

function normalizeText(nodes: Node[], parent: Tag, path: string): Element[] {
  let content = ''
  nodes.forEach((node, index) => {
    if (node.type === 'text' && typeof node.attrs.content === 'string') content += node.attrs.content
    else if (node.type === 'br') content += '\n'
    else throw new NormalizeError(`<${parent}> only contains text, got <${node.type}>`, childPath(path, node, index))
  })
  return content ? [make('text', { content }, [])] : []
}

function pushText(out: Node[], node: Node) {
  const content = node.attrs.content as string
  if (!content) return
  const last = out[out.length - 1]
  if (last?.type === 'text' && last.key === undefined && node.key === undefined) {
    out[out.length - 1] = make('text', { ...last.attrs, content: (last.attrs.content as string) + content }, []) as Node
  } else {
    out.push(node)
  }
}

interface Item { node: Node; path: string }

function items(nodes: Node[], path: string): Item[] {
  return nodes.map((node, index) => ({ node, path: childPath(path, node, index) }))
}

function normalizePhrasing(nodes: Node[], parent: Tag, path: string): Element[] {
  return phrasing(items(nodes, path), parent)
}

function phrasing(list: Item[], parent: Tag): Element[] {
  const out: Node[] = []
  list.forEach(({ node, path: p }) => {
    if (node.type === 'markdown') {
      out.push(normalizeMarkdown(node, p))
      return
    }
    if (node.type === 'fallback') {
      out.push(normalizeFallback(node, parent, p))
      return
    }
    const tag = checkTag(node, p)
    const info = elementInfo[tag]
    if (info.parents && !info.parents.includes(parent)) {
      throw new NormalizeError(`<${tag}> is only allowed directly inside ${info.parents.map(t => `<${t}>`).join(' or ')}`, p)
    }
    if (info.position === 'block') {
      throw new NormalizeError(`block <${tag}> inside inline content of <${parent}>`, p)
    }
    const el = normalizeElement(node, tag, p)
    if (tag === 'text') pushText(out, el)
    else out.push(el)
  })
  return out
}

function normalizeFlow(nodes: Node[], parent: Tag, path: string): Element[] {
  const out: Node[] = []
  const envelope: Partial<Record<'quote' | 'title' | 'summary', Node>> = {}
  let run: Item[] = []
  const flush = () => {
    if (run.length && !run.every(({ node }) => isBlankText(node) || isEmptyText(node))) {
      const children = phrasing(run, 'p')
      if (children.length) out.push(make('p', {}, children) as Node)
    }
    run = []
  }
  for (const { node, path: p } of items(nodes, path)) {
    if (node.type === 'markdown') {
      flush()
      out.push(normalizeMarkdown(node, p))
      continue
    }
    if (node.type === 'fallback') {
      if (isInlineFallback(node)) {
        run.push({ node, path: p })
      } else {
        flush()
        out.push(normalizeFallback(node, parent, p))
      }
      continue
    }
    const tag = checkTag(node, p)
    const info = elementInfo[tag]
    if (info.parents && !info.parents.includes(parent)) {
      throw new NormalizeError(`<${tag}> is only allowed directly inside ${info.parents.map(t => `<${t}>`).join(' or ')}`, p)
    }
    if (info.position === 'inline') {
      run.push({ node, path: p })
      continue
    }
    flush()
    if (tag === 'quote' || tag === 'title' || tag === 'summary') {
      if (envelope[tag]) throw new NormalizeError(`at most one <${tag}> per <${parent}>`, p)
      envelope[tag] = normalizeElement(node, tag, p)
      continue
    }
    if (tag === 'message') throw new NormalizeError('<message> is only allowed as the root', p)
    out.push(normalizeElement(node, tag, p))
  }
  flush()
  const head = [envelope.quote, envelope.title, envelope.summary].filter((x): x is Node => !!x)
  return [...head, ...out]
}

function normalizeList(nodes: Node[], parent: Tag, path: string): Element[] {
  const out: Element[] = []
  let run: Node[] = []
  let runPath = path
  const flush = () => {
    if (run.length && !run.every(node => isBlankText(node) || isEmptyText(node))) {
      out.push(make('li', {}, normalizeChildren(run, 'li', `${runPath}<li>`)))
    }
    run = []
  }
  for (const { node, path: p } of items(nodes, path)) {
    if (node.type === 'li') {
      flush()
      out.push(normalizeElement(node, 'li', p))
    } else if (node.type === 'fallback') {
      flush()
      out.push(normalizeFallback(node, parent, p))
    } else {
      if (!run.length) runPath = p
      run.push(node)
    }
  }
  flush()
  return out
}

function normalizeOnly(nodes: Node[], parent: Tag, path: string, allowed: Tag[]): Element[] {
  const out: Element[] = []
  nodes.forEach((node, index) => {
    const p = childPath(path, node, index)
    if (isBlankText(node) || isEmptyText(node)) return
    if (node.type === 'fallback') {
      out.push(normalizeFallback(node, parent, p))
      return
    }
    const tag = checkTag(node, p)
    if (!allowed.includes(tag)) {
      throw new NormalizeError(`<${parent}> only contains ${allowed.map(t => `<${t}>`).join(' or ')}, got <${tag}>`, p)
    }
    out.push(normalizeElement(node, tag, p))
  })
  return out
}
