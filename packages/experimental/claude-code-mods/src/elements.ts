/**
 * The element vocabulary a `ui.render` hook answers with — Claude Code's
 * `Box`, `Text`, and `Button` constructors — and what the host does with a
 * tree: validate it, serialize it with callbacks replaced by action ids, and
 * search it the way a mod's test does.
 * @module
 */

import type { SerializedNode } from './types.ts'

/** One element a constructor returns; `props` are the constructor's argument, frozen. */
export interface UiElement {
  readonly type: 'Box' | 'Text' | 'Button'
  readonly props: Readonly<Record<string, unknown>>
}

/** What a `ui.render` hook returns: an element, text, nothing, or a list of those. */
export type UiNode = UiElement | string | number | null | undefined | false | readonly UiNode[]

/** `Box` props this host lays out; a prop set to `undefined` is one a mod left out. */
export interface BoxProps {
  readonly flexDirection?: 'row' | 'column' | undefined
  readonly paddingX?: number | undefined
  readonly paddingY?: number | undefined
  readonly padding?: number | undefined
  readonly gap?: number | undefined
  readonly border?: boolean | string | undefined
  readonly borderColor?: string | undefined
  readonly children?: UiNode | undefined
}

/** `Text` props this host styles. */
export interface TextProps {
  readonly color?: string | undefined
  readonly bold?: boolean | undefined
  readonly dimColor?: boolean | undefined
  readonly italic?: boolean | undefined
  readonly underline?: boolean | undefined
  readonly children?: UiNode | undefined
}

/** `Button` props: a label, an optional hotkey hint, and the callback a press runs on the host. */
export interface ButtonProps {
  readonly label: string
  readonly hotkey?: string | undefined
  readonly disabled?: boolean | undefined
  readonly onPress?: (() => unknown) | undefined
}

/** The constructors `$.ui.resolve(e)` returns. */
export interface UiElements {
  readonly Box: (props: BoxProps) => UiElement
  readonly Text: (props: TextProps) => UiElement
  readonly Button: (props: ButtonProps) => UiElement
}

export type { SerializedElement, SerializedNode } from './types.ts'

/** What a serialized tree may carry per prop: scalars only. */
function scalarProps(props: Readonly<Record<string, unknown>>): Record<string, string | number | boolean> {
  const scalars: Record<string, string | number | boolean> = {}
  for (const [name, value] of Object.entries(props)) {
    if (name === 'children' || name === 'onPress') continue
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') scalars[name] = value
  }
  return scalars
}

const elementBrand = Symbol('claude-code-mods.element')

function element(type: UiElement['type'], props: BoxProps | TextProps | ButtonProps): UiElement {
  return Object.freeze({ type, props: Object.freeze({ ...props }), [elementBrand]: true })
}

/**
 * Whether a value is an element one of this host's constructors returned.
 * @param value - the candidate.
 * @returns true for a constructor-made element.
 */
export function isUiElement(value: unknown): value is UiElement {
  return typeof value === 'object' && value !== null && (value as Record<symbol, unknown>)[elementBrand] === true
}

/**
 * The element constructors for one render.
 * @returns `Box`, `Text`, and `Button`.
 */
export function uiElements(): UiElements {
  return Object.freeze({
    Box: (props: BoxProps) => element('Box', props),
    Text: (props: TextProps) => element('Text', props),
    Button: (props: ButtonProps) => element('Button', props),
  })
}

/** Flatten a node into the elements and text runs it draws, dropping what draws nothing. */
function childrenOf(node: UiNode): (UiElement | string)[] {
  if (node === null || node === undefined || node === false) return []
  if (typeof node === 'string') return node.length === 0 ? [] : [node]
  if (typeof node === 'number') return [String(node)]
  if (isUiElement(node)) return [node]
  if (Array.isArray(node)) return (node as readonly UiNode[]).flatMap(childrenOf)
  throw new TypeError(`a tree node is ${typeof node}, not an element, text, or a list of them`)
}

/**
 * Check a `ui.render` answer against the vocabulary.
 * @param node - the hook's answer.
 * @returns undefined for a valid tree, or the reason it does not validate.
 */
export function treeProblem(node: UiNode): string | undefined {
  try {
    for (const child of childrenOf(node)) {
      if (typeof child === 'string') continue
      if (child.type === 'Button') {
        if (typeof child.props['label'] !== 'string') return 'a Button needs a string label'
        if (child.props['onPress'] !== undefined && typeof child.props['onPress'] !== 'function') return 'a Button onPress must be a function'
        continue
      }
      const nested = treeProblem(child.props['children'] as UiNode)
      if (nested !== undefined) return nested
    }
    return undefined
  } catch (error: unknown) {
    /* v8 ignore next -- childrenOf throws TypeErrors only; the String branch covers a future non-Error throw */
    return error instanceof Error ? error.message : String(error)
  }
}

/**
 * Serialize a validated tree for a client: scalars kept, children flattened,
 * each `onPress` replaced by the id `holdAction` returns for it.
 * @param node - the hook's answer, already validated with {@link treeProblem}.
 * @param holdAction - stores one callback and returns its id.
 * @returns the serialized nodes, in drawing order.
 */
export function serializeTree(node: UiNode, holdAction: (callback: () => unknown) => string): SerializedNode[] {
  return childrenOf(node).map((child): SerializedNode => {
    if (typeof child === 'string') return child
    if (child.type === 'Button') {
      const onPress = child.props['onPress']
      return {
        type: 'Button',
        props: scalarProps(child.props),
        children: [],
        ...typeof onPress === 'function' ? { actionId: holdAction(onPress as () => unknown) } : {},
      }
    }
    return { type: child.type, props: scalarProps(child.props), children: serializeTree(child.props['children'] as UiNode, holdAction) }
  })
}

/** The text a node draws, with child texts joined in order. */
function textOf(node: UiElement | string): string {
  if (typeof node === 'string') return node
  if (node.type === 'Button') return String(node.props['label'])
  return childrenOf(node.props['children'] as UiNode).map(textOf).join('')
}

/** What a tree search matches on. */
export interface TreePattern {
  readonly type?: UiElement['type']
  /** Text drawn by the element, including its descendants; a string matches as a substring. */
  readonly text?: string | RegExp
  /** A Button's label. */
  readonly label?: string | RegExp
}

function textMatches(expected: string | RegExp, actual: string): boolean {
  return typeof expected === 'string' ? actual.includes(expected) : expected.test(actual)
}

/**
 * Every element of a tree matching a pattern, in drawing order.
 * @param node - the tree.
 * @param pattern - the type, text, and label to match; an empty pattern matches every element.
 * @returns the matching elements.
 */
export function findAll(node: UiNode, pattern: TreePattern): UiElement[] {
  const found: UiElement[] = []
  const visit = (child: UiElement | string): void => {
    if (typeof child === 'string') return
    const matchesType = pattern.type === undefined || child.type === pattern.type
    const matchesText = pattern.text === undefined || textMatches(pattern.text, textOf(child))
    const matchesLabel = pattern.label === undefined || (child.type === 'Button' && textMatches(pattern.label, String(child.props['label'])))
    if (matchesType && matchesText && matchesLabel) found.push(child)
    if (child.type !== 'Button') for (const grandchild of childrenOf(child.props['children'] as UiNode)) visit(grandchild)
  }
  for (const child of childrenOf(node)) visit(child)
  return found
}

/**
 * The plain text a tree draws, one line per top-level node: the test kit's and the host log's view of a surface.
 * @param node - the tree.
 * @returns the drawn text.
 */
export function renderText(node: UiNode): string {
  return childrenOf(node).map(textOf).join('\n')
}
