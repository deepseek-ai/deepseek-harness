/**
 * Composer editor projections: one EditorState, three pure text views.
 * detectText feeds trigger detection and TokenSpan coordinates (every chip
 * counts as one U+FFFC — the opaque-reference invariant); clipboardText
 * feeds persistence, the InputState draft, and submit-plane decisions
 * (chips expand to their clipboard projection); the model form is not a
 * text view here — submit serializes chip nodes through their owner codec.
 * All $-functions must run inside `editor.read()` / `editor.update()`.
 */
import type { ElementNode, LexicalNode, NodeKey, Point } from 'lexical'
import {
  $getRoot, $getSelection, $isElementNode, $isLineBreakNode, $isRangeSelection, $isTextNode,
} from 'lexical'
import type { Occurrence } from '../../contract/draft-editor.ts'
import { $isReferenceChipNode } from './chip-node.tsx'

/** The detect-projection stand-in for one chip (object replacement character). */
export const ATOMIC_CHAR = '￼'

/** One leaf (or gap) of the composer document in projection coordinates. */
export interface ComposerSegment {
  /** text/linebreak carry a node; chip is atomic; gap is the newline between block elements. */
  readonly kind: 'text' | 'chip' | 'linebreak' | 'gap'
  /** The backing node; null only for gap. */
  readonly node: LexicalNode | null
  readonly detectStart: number
  readonly detectLength: number
  readonly clipboardStart: number
  readonly clipboardLength: number
  /** gap only: the block elements this newline separates. */
  readonly gapBetween?: { readonly before: NodeKey; readonly after: NodeKey }
}

/** One walk's product: segments plus the indexes point mapping needs. */
export interface ComposerLayout {
  readonly segments: readonly ComposerSegment[]
  readonly detectLength: number
  readonly detectText: string
  readonly clipboardText: string
  /** Leaf node key → its segment (text/chip/linebreak). */
  readonly byKey: ReadonlyMap<NodeKey, ComposerSegment>
  /** Element key → ordered child keys (root and every block element). */
  readonly children: ReadonlyMap<NodeKey, readonly NodeKey[]>
  /** Element key → detect bounds of its content (gaps excluded). */
  readonly bounds: ReadonlyMap<NodeKey, { readonly start: number; readonly end: number }>
}

/**
 * Walk the composer document once, producing every projection segment in
 * document order. Blocks (paragraphs) contribute a one-newline gap between
 * one another in both text projections.
 * @returns the layout for this EditorState.
 */
export function $composerLayout(): ComposerLayout {
  const segments: ComposerSegment[] = []
  const byKey = new Map<NodeKey, ComposerSegment>()
  const children = new Map<NodeKey, readonly NodeKey[]>()
  const bounds = new Map<NodeKey, { start: number; end: number }>()
  let detect = ''
  let clipboard = ''

  const pushLeaf = (kind: 'text' | 'chip' | 'linebreak', node: LexicalNode, detectPiece: string, clipboardPiece: string): void => {
    const segment: ComposerSegment = {
      kind,
      node,
      detectStart: detect.length,
      detectLength: detectPiece.length,
      clipboardStart: clipboard.length,
      clipboardLength: clipboardPiece.length,
    }
    segments.push(segment)
    byKey.set(node.getKey(), segment)
    detect += detectPiece
    clipboard += clipboardPiece
  }

  const walkElement = (element: ElementNode): void => {
    const start = detect.length
    const kids = element.getChildren()
    children.set(element.getKey(), kids.map(kid => kid.getKey()))
    for (const kid of kids) {
      if ($isReferenceChipNode(kid)) {
        pushLeaf('chip', kid, ATOMIC_CHAR, kid.getTextContent())
      } else if ($isTextNode(kid)) {
        const text = kid.getTextContent()
        pushLeaf('text', kid, text, text)
      } else if ($isLineBreakNode(kid)) {
        pushLeaf('linebreak', kid, '\n', '\n')
      } else if ($isElementNode(kid)) {
        /* v8 ignore next 4 -- plain-text composition nests no block elements today; the walk stays total for imported states. */
        walkElement(kid)
      }
      // Unknown inline decorators contribute nothing: this composer registers
      // no other decorator type, so the arm is unreachable by construction.
    }
    bounds.set(element.getKey(), { start, end: detect.length })
  }

  const root = $getRoot()
  const blocks = root.getChildren()
  children.set(root.getKey(), blocks.map(block => block.getKey()))
  const rootStart = detect.length
  blocks.forEach((block, index) => {
    const previous = blocks[index - 1]
    if (index > 0 && previous !== undefined) {
      segments.push({
        kind: 'gap',
        node: null,
        detectStart: detect.length,
        detectLength: 1,
        clipboardStart: clipboard.length,
        clipboardLength: 1,
        gapBetween: { before: previous.getKey(), after: block.getKey() },
      })
      detect += '\n'
      clipboard += '\n'
    }
    if ($isElementNode(block)) walkElement(block)
  })
  bounds.set(root.getKey(), { start: rootStart, end: detect.length })

  return {
    segments,
    detectLength: detect.length,
    detectText: detect,
    clipboardText: clipboard,
    byKey,
    children,
    bounds,
  }
}

/**
 * Fold one clipboard-projection offset to its detect-projection twin.
 * Offsets inside a chip's clipboard expansion snap to the chip's trailing
 * edge; callers only pass boundaries that were once a document end (submit
 * snapshots), which never split a chip.
 * @param layout - the current walk product.
 * @param clipboardOffset - offset into the clipboard projection.
 * @returns the detect offset covering the same document position.
 */
export function detectOffsetOfClipboardOffset(layout: ComposerLayout, clipboardOffset: number): number {
  for (const segment of layout.segments) {
    const end = segment.clipboardStart + segment.clipboardLength
    if (clipboardOffset > end) continue
    if (clipboardOffset === end) return segment.detectStart + segment.detectLength
    if (segment.kind === 'chip') return segment.detectStart + segment.detectLength
    return segment.detectStart + (clipboardOffset - segment.clipboardStart)
  }
  return layout.detectLength
}

/** The published projection product consumed by the shell every update. */
export interface EditorProjection {
  /** Trigger/TokenSpan coordinate text (chip = one U+FFFC). */
  readonly detectText: string
  /** Persistence/InputState draft text (chip = clipboardText). */
  readonly clipboardText: string
  /** InputState-compatible occurrence view (clipboardText coordinates). */
  readonly occurrences: readonly Occurrence[]
  /** Range selection in detect coordinates (ordered); null while absent or non-range. */
  readonly selection: { readonly start: number; readonly end: number } | null
  /** Collapsed caret in detect coordinates; null while the selection is absent or ranged. */
  readonly caret: number | null
}

/**
 * Fold one selection point to a detect offset.
 * @param layout - the current walk product.
 * @param point - selection anchor/focus point.
 * @returns detect offset, or null when the point references an unknown node.
 */
export function $detectOffsetOfPoint(layout: ComposerLayout, point: Point): number | null {
  if (point.type === 'text') {
    const segment = layout.byKey.get(point.key)
    return segment === undefined ? null : segment.detectStart + Math.min(point.offset, segment.detectLength)
  }
  const kids = layout.children.get(point.key)
  const elementBounds = layout.bounds.get(point.key)
  if (kids === undefined || elementBounds === undefined) return null
  if (point.offset >= kids.length) return elementBounds.end
  const childKey = kids[point.offset]
  if (childKey === undefined) return elementBounds.end
  const childSegment = layout.byKey.get(childKey)
  if (childSegment !== undefined) return childSegment.detectStart
  const childBounds = layout.bounds.get(childKey)
  return childBounds === undefined ? null : childBounds.start
}

/**
 * Project the composer document and its caret.
 * @param idOf - stable occurrence-id assignment per chip NodeKey (the shell
 * owns the map so ids survive across projections of the same node).
 * @returns the three-view projection product.
 */
export function $projectComposer(idOf: (key: NodeKey) => number): EditorProjection {
  const layout = $composerLayout()
  const occurrences: Occurrence[] = []
  for (const segment of layout.segments) {
    if (segment.kind !== 'chip' || !$isReferenceChipNode(segment.node)) continue
    const chip = segment.node
    occurrences.push({
      occurrenceId: idOf(chip.getKey()),
      source: chip.getSource(),
      ref: chip.getReference(),
      offset: segment.clipboardStart,
      length: segment.clipboardLength,
      label: chip.getLabel(),
      ...(chip.getAppearance() === undefined ? {} : { appearance: chip.getAppearance() }),
      clipboardText: chip.getTextContent(),
      ...(chip.isInvalid() ? { invalid: true } : {}),
    })
  }
  const selection = $getSelection()
  let range: { start: number; end: number } | null = null
  if ($isRangeSelection(selection)) {
    const anchor = $detectOffsetOfPoint(layout, selection.anchor)
    const focus = $detectOffsetOfPoint(layout, selection.focus)
    if (anchor !== null && focus !== null) {
      range = { start: Math.min(anchor, focus), end: Math.max(anchor, focus) }
    }
  }
  return {
    detectText: layout.detectText,
    clipboardText: layout.clipboardText,
    occurrences,
    selection: range,
    caret: range !== null && range.start === range.end ? range.start : null,
  }
}
