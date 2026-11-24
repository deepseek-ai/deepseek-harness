/**
 * Typed factories and the JSX runtime (`@deepseek-ai/satori-element/jsx-runtime` resolves to this package's index).
 */

import { Element as createElement, isElement as isRuntimeElement, parse as parseMarkup } from '@deepseek-ai/cordis-element'
import type { Child, Element, ElementMap, Fragment as FragmentType, Tag } from './vocabulary.ts'

type OptionalKeys<A> = { [P in keyof A]-?: {} extends Pick<A, P> ? P : never }[keyof A]
type Simplify<T> = { [P in keyof T]: T[P] } & {}

/**
 * Factory input for a tag's attributes: `ElementMap[K]` where optional attributes also accept `undefined`
 * (dropped at runtime, so callers under `exactOptionalPropertyTypes` can pass `name: user.name`), plus `key`.
 */
export type Attrs<K extends Tag> = LooseAttrs<ElementMap[K]>
type LooseAttrs<A> = A extends unknown
  ? Simplify<
    & { [P in Exclude<keyof A, OptionalKeys<A>>]: A[P] }
    & { [P in OptionalKeys<A>]?: A[P] | undefined }
    & { key?: string | undefined }
  >
  : never

/** Tags whose attributes are all optional, so `h(tag, ...children)` may omit them. */
export type BareTag = { [K in Tag]: {} extends ElementMap[K] ? K : never }[Tag]

export interface ElementFactory {
  <K extends Tag>(tag: K, attrs: Attrs<K>, ...children: Child[]): Element<K>
  <K extends BareTag>(tag: K, ...children: Child[]): Element<K>
  text(content: string): Element<'text'>
  /** `<markdown content>`: GFM source, expanded into elements by the IM render engine's `markdown` service. */
  markdown(source: string): Element<'markdown'>
}

/** Element-like check: a `cordis-element` runtime element, or a plain `{ type, attrs, children }` object. */
export function isElement(value: unknown): value is Element {
  if (isRuntimeElement(value)) return true
  if (!value || typeof value !== 'object') return false
  const { type, attrs, children } = value as Record<string, unknown>
  return typeof type === 'string' && !!attrs && typeof attrs === 'object' && Array.isArray(children)
}

/** Runtime tag of a JSX fragment (`<>…</>`); flattened by the factories, `normalize` and `toText`. */
export const Fragment = ''
export type Fragment = FragmentType

/**
 * Parse the XML-ish `Element.toString()` form back into elements (goldens, logs, tests). Not an input format for
 * user content: plain strings passed to `h` / `normalize` are literal text.
 */
export function parse(source: string): Element[] {
  return parseMarkup(source) as unknown as Element[]
}

/** @internal Build a runtime element without copying children. */
export function make(type: string, attrs: Record<string, unknown>, children: Element[], key?: string): Element {
  const el = createElement(type, {}) as unknown as { attrs: Record<string, unknown>; children: Element[]; key?: string }
  for (const [name, value] of Object.entries(attrs)) {
    if (value !== undefined && value !== null) el.attrs[name] = value
  }
  el.children = children
  if (key !== undefined) el.key = key
  return el as unknown as Element
}

/** Flatten children: strings and numbers become `text`, holes are skipped, fragments and arrays are spliced. */
export function toChildren(child: unknown, out: Element[] = []): Element[] {
  if (child === null || child === undefined || typeof child === 'boolean') return out
  if (typeof child === 'string' || typeof child === 'number') {
    const content = String(child)
    if (content) out.push(make('text', { content }, []))
  } else if (Array.isArray(child)) {
    for (const item of child) toChildren(item, out)
  } else if (isElement(child)) {
    if ((child.type as string) === Fragment) toChildren(child.children, out)
    else out.push(child)
  } else {
    throw new TypeError(`invalid element child: ${Object.prototype.toString.call(child)}`)
  }
  return out
}

function isAttrs(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) && !isElement(value)
}

/**
 * Children of a `<fallback>`: every item is one candidate, kept apart as a `<case>`. A fragment or an array is one
 * candidate holding all of its nodes; holes are skipped.
 */
export function toCases(items: readonly unknown[]): Element[] {
  const out: Element[] = []
  for (const item of items) {
    if (item === null || item === undefined || typeof item === 'boolean') continue
    if (isElement(item) && item.type === 'case') out.push(item)
    else out.push(make('case', {}, toChildren(item)))
  }
  return out
}

function create(type: string, args: unknown[]): Element {
  let attrs: Record<string, unknown> = {}
  let key: string | undefined
  if (isAttrs(args[0])) {
    const { key: k, ...rest } = args.shift() as Record<string, unknown>
    attrs = rest
    if (k !== undefined && k !== null) key = String(k)
  }
  return make(type, attrs, type === 'fallback' ? toCases(args) : toChildren(args), key)
}

export const h: ElementFactory = Object.assign(
  (type: Tag, ...args: unknown[]) => create(type, args),
  {
    text: (content: string) => make('text', { content }, []) as Element<'text'>,
    markdown: (source: string) => make('markdown', { content: source }, []) as Element<'markdown'>,
  },
) as ElementFactory

// ---- JSX ----------------------------------------------------------------------------------------------------------

type AnyElement = Element

/** Function component: called eagerly while the tree is built (no React semantics, no state). */
export type Component<P = any> = (props: P) => Child

type JsxProps<K extends Tag> = K extends 'markdown'
  ? { content?: string; children?: string | readonly string[] }
  : K extends 'text'
    ? { content: string }
    : Attrs<K> & { children?: Child }

/** `<case>` is internal: JSX writes a candidate of `<fallback>` as a fragment. */
type IntrinsicMap = { [K in Exclude<Tag, 'case'>]: JsxProps<K> }

export declare namespace JSX {
  type Element = AnyElement
  type ElementType = Tag | Component
  interface ElementChildrenAttribute { children: {} }
  interface IntrinsicAttributes { key?: string | undefined }
  interface IntrinsicElements extends IntrinsicMap {}
}

/** Automatic JSX runtime entry (`jsx`, `jsxs`, `jsxDEV`). */
export function jsx(type: Tag | Component | typeof Fragment, props: Record<string, unknown> | null, key?: string): Element {
  const { children, ...attrs } = props ?? {}
  if (typeof type === 'function') {
    const result = type({ ...attrs, ...children !== undefined && { children } })
    const nodes = toChildren(result)
    return nodes.length === 1 && key === undefined ? nodes[0]! : make(Fragment, {}, nodes, key)
  }
  if (type === Fragment) return make(Fragment, {}, toChildren(children), key)
  if (type === 'markdown' && attrs.content === undefined && children !== undefined) {
    attrs.content = ([] as unknown[]).concat(children).join('')
    return make(type, attrs, [], key)
  }
  if (key === undefined && attrs.key !== undefined) key = String(attrs.key)
  delete attrs.key
  if (type === 'fallback') return make(type, attrs, toCases(Array.isArray(children) ? children : [children]), key)
  return make(type, attrs, toChildren(children), key)
}

export { jsx as jsxs, jsx as jsxDEV }
