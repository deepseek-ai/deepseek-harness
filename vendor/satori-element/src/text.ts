/**
 * `toText()`: the plain-text projection of content (fallbacks, tests, history, agent-facing inbound text).
 *
 * Total: works on unnormalized trees and never throws for unknown tags (their children are projected).
 * Blocks are separated by one newline; envelope `quote` is omitted, `title` is the first line; a `<fallback>` projects
 * its last candidate; `<markdown>` projects its source as it is (the converter lives with the IM render engine).
 */

import { elementInfo, isTag } from './elements.ts'
import { Fragment, toChildren } from './factory.ts'
import type { Child, Element } from './vocabulary.ts'

type Node = Element & { attrs: Record<string, any> }

export function toText(content: Child): string {
  return flow(toChildren(content) as Node[])
}

function isBlockNode(node: Node): boolean {
  const type = node.type as string
  if (type === Fragment || !isTag(type)) return false
  return elementInfo[type].position !== 'inline'
}

/** Children in flow position: consecutive inline nodes form one line group, blocks stand alone. */
function flow(nodes: Node[]): string {
  const chunks: string[] = []
  let run: Node[] = []
  const flush = () => {
    if (run.length) {
      const text = inline(run)
      if (text.trim()) chunks.push(text)
    }
    run = []
  }
  for (const node of nodes) {
    if (isBlockNode(node)) {
      flush()
      const text = blockText(node)
      if (text !== undefined) chunks.push(text)
    } else {
      run.push(node)
    }
  }
  flush()
  return chunks.join('\n')
}

function inline(nodes: Node[]): string {
  return nodes.map(inlineText).join('')
}

function children(node: Node): string {
  return inline(node.children as Node[])
}

function prefixLines(text: string, first: string, rest: string = ' '.repeat(first.length)) {
  return text.split('\n').map((line, index) => (index ? rest : first) + line).join('\n')
}

function label(kind: string, name: unknown) {
  return name ? `[${kind}: ${name}]` : `[${kind}]`
}

function buttonText(node: Node) {
  const text = children(node) || node.attrs.text || node.attrs.href || node.attrs.id || 'button'
  return `[${text}]`
}

/** A control's text: a checkbox keeps its box and label, every other mode names what would be entered. */
function inputText(node: Node) {
  const { label, name, type, placeholder, value } = node.attrs
  if (type === 'checkbox') return `${value ? '☑' : '☐'} ${label ?? name ?? ''}`.trimEnd()
  return `[${label ?? placeholder ?? name ?? ''}]`
}

/** A select lists what could have been chosen, so the reader sees the options a click would have offered. */
function selectText(node: Node) {
  const head = node.attrs.placeholder ?? '选择'
  const labels = (node.children as Node[])
    .filter(child => child.type === 'option')
    .map(option => children(option) || String(option.attrs.value ?? ''))
  return labels.length ? `[${head}: ${labels.join(' / ')}]` : `[${head}]`
}

/** The last candidate of a `<fallback>`: the plainest alternative, which a text projection stands for. */
function lastCandidate(node: Node): Node[] {
  const last = (node.children as Node[]).at(-1)
  if (!last) return []
  return last.type === 'case' ? last.children as Node[] : [last]
}

/** Text of a block element; `undefined` = renders nothing (envelope quote). */
function blockText(node: Node): string | undefined {
  const { attrs } = node
  const kids = node.children as Node[]
  switch (node.type) {
    case 'quote': return undefined
    case 'message': return flow(kids)
    case 'fallback': return flow(lastCandidate(node))
    case 'title': return attrs.subtitle ? `${children(node)}\n${attrs.subtitle}` : children(node)
    case 'pre': return inline(kids).replace(/\n$/, '')
    case 'hr': return '---'
    case 'blockquote': return prefixLines(flow(kids), '> ', '> ')
    case 'ul':
    case 'ol': {
      let index = node.type === 'ol' && typeof attrs.start === 'number' ? attrs.start : 1
      return kids.map((item) => {
        const marker = node.type === 'ol' ? `${index++}. ` : '• '
        const body = item.type === 'li' ? flow(item.children as Node[]) : flow([item])
        const check = item.type === 'li' && typeof item.attrs.checked === 'boolean' ? (item.attrs.checked ? '☑ ' : '☐ ') : ''
        return prefixLines(check + body, marker)
      }).join('\n')
    }
    case 'li': return prefixLines(flow(kids), '• ')
    case 'table': return kids.map(row => blockText(row) ?? '').join('\n')
    case 'tr': return kids.map(cell => flow(cell.children as Node[]).replace(/\n/g, ' ')).join(' | ')
    case 'th':
    case 'td': return flow(kids)
    case 'details': return flow(kids)
    case 'button-group': return kids.map(child => child.type === 'button' ? buttonText(child) : inlineText(child)).join(' ')
    case 'input': return inputText(node)
    case 'select': return selectText(node)
    case 'option': return children(node) || String(attrs.value ?? '')
    case 'markdown': return String(attrs.content ?? children(node))
    default: {
      if (!isTag(node.type)) return children(node)
      const info = elementInfo[node.type]
      if (info.content === 'flow' || info.content === 'details') return flow(kids)
      return info.position === 'block' ? children(node) : inlineText(node)
    }
  }
}

function inlineText(node: Node): string {
  const { attrs } = node
  switch (node.type) {
    case 'text': return String(attrs.content ?? '')
    case 'br': return '\n'
    case 'at':
      if (attrs.type === 'all') return '@all'
      if (attrs.type === 'here') return '@here'
      return `@${attrs.name ?? attrs.id ?? ''}`
    case 'channel': return `#${attrs.name ?? attrs.id ?? ''}`
    case 'emoji': return `:${attrs.name ?? attrs.id ?? ''}:`
    case 'a': {
      const text = children(node)
      return !text || text === attrs.href ? String(attrs.href ?? '') : attrs.href ? `${text} (${attrs.href})` : text
    }
    case 'img': return label('image', attrs.alt)
    case 'audio': return label('audio', attrs.name)
    case 'video': return label('video', attrs.name)
    case 'file': return label('file', attrs.name)
    case 'button': return buttonText(node)
    case 'forward': return children(node) || '[forward]'
    case 'quote': return ''
    case 'fallback': return inline(lastCandidate(node))
    case 'markdown': return String(attrs.content ?? children(node))
    default: return isTag(node.type) && elementInfo[node.type].position === 'block' ? blockText(node) ?? '' : children(node)
  }
}
