/**
 * ReferenceChipNode: one inline reference as an atomic Lexical decorator.
 * The node IS the occurrence — NodeKey carries identity, the node carries
 * the owner's insert-time projections (label/appearance/clipboardText), and
 * `getTextContent()` answers the clipboard/persistence projection so native
 * copy and the draft mirror stay correct without expansion code. The detect
 * projection (trigger scanning and TokenSpan coordinates) counts every chip
 * as one U+FFFC instead; see projection.ts.
 */
import type { JSX } from 'react'
import type {
  EditorConfig, LexicalNode, NodeKey, SerializedLexicalNode, Spread,
} from 'lexical'
import { DecoratorNode } from 'lexical'
import type { ReferenceInsert } from '../../contract/draft-editor.ts'
import { ReferenceChip } from './ReferenceChip.tsx'

/** JSON form of one chip (Lexical node serialization contract). */
export type SerializedReferenceChipNode = Spread<{
  source: string
  ref: string
  label: string
  appearance?: ReferenceInsert['appearance']
  clipboardText: string
  invalid: boolean
}, SerializedLexicalNode>

/** One inline reference occurrence as an atomic decorator node. */
export class ReferenceChipNode extends DecoratorNode<JSX.Element> {
  /** Owning source name (serializer routing key). */
  __source: string
  /** Owner-scoped reference id. */
  __ref: string
  /** Inline display label (insert-time cache). */
  __label: string
  /** Optional domain glyph (insert-time cache). */
  __appearance: ReferenceInsert['appearance']
  /** Clipboard / persistence projection, e.g. `/name` (never the model form). */
  __clipboardText: string
  /** Owner-resolution failure flag: chip renders invalid; serialization must fail. */
  __invalid: boolean

  /** Lexical node registry type tag. */
  static override getType(): string {
    return 'reference-chip'
  }

  /**
   * Clone with identity (Lexical writable-copy contract).
   * @param node - node to clone.
   * @returns a copy carrying the same NodeKey.
   */
  static override clone(node: ReferenceChipNode): ReferenceChipNode {
    return new ReferenceChipNode(
      {
        source: node.__source,
        ref: node.__ref,
        label: node.__label,
        appearance: node.__appearance,
        clipboardText: node.__clipboardText,
      },
      node.__invalid,
      node.__key,
    )
  }

  /**
   * Rebuild one chip from its JSON form.
   * @param json - serialized chip.
   * @returns a fresh node (new key).
   */
  static override importJSON(json: SerializedReferenceChipNode): ReferenceChipNode {
    return new ReferenceChipNode(
      {
        source: json.source,
        ref: json.ref,
        label: json.label,
        appearance: json.appearance,
        clipboardText: json.clipboardText,
      },
      json.invalid,
    )
  }

  /**
   * @param insert - the owner's reference insertion (display projections included).
   * @param invalid - owner-resolution failure bit (defaults valid).
   * @param key - Lexical clone-path key; absent for fresh nodes.
   */
  constructor(insert: Omit<ReferenceInsert, 'appearance'> & { appearance?: ReferenceInsert['appearance'] }, invalid = false, key?: NodeKey) {
    super(key)
    this.__source = insert.source
    this.__ref = insert.ref
    this.__label = insert.label
    this.__appearance = insert.appearance
    this.__clipboardText = insert.clipboardText
    this.__invalid = invalid
  }

  /** Serialize to the JSON node form. */
  override exportJSON(): SerializedReferenceChipNode {
    return {
      ...super.exportJSON(),
      type: 'reference-chip',
      version: 1,
      source: this.__source,
      ref: this.__ref,
      label: this.__label,
      ...(this.__appearance === undefined ? {} : { appearance: this.__appearance }),
      clipboardText: this.__clipboardText,
      invalid: this.__invalid,
    }
  }

  /**
   * Mount the chip's host element; the decorator portal renders into it.
   * @returns an inline, non-editable span carrying the test/e2e anchor.
   */
  override createDOM(_config: EditorConfig): HTMLElement {
    const el = document.createElement('span')
    el.setAttribute('data-composer-chip', this.__source)
    el.setAttribute('contenteditable', 'false')
    return el
  }

  /** Host element never changes shape. */
  override updateDOM(): boolean {
    return false
  }

  /** Chips sit in the text line. */
  override isInline(): boolean {
    return true
  }

  /**
   * No keyboard-selected intermediate state: arrows step across the chip in
   * one move and Backspace/Delete remove it whole (the placeholder semantics
   * of the old textarea). `true` would put a NodeSelection between the
   * keystroke and the caret — a state the plain-text binding's handlers all
   * ignore, deadlocking arrows, typing, and deletion at the chip edge.
   */
  override isKeyboardSelectable(): boolean {
    return false
  }

  /** Clipboard / persistence projection (native copy reads this). */
  override getTextContent(): string {
    return this.__clipboardText
  }

  /**
   * Flip the owner-resolution failure bit.
   * @param invalid - next bit; no-op writes are the caller's concern.
   */
  setInvalid(invalid: boolean): void {
    const writable = this.getWritable()
    writable.__invalid = invalid
  }

  /** Owner-resolution failure bit. */
  isInvalid(): boolean {
    return this.getLatest().__invalid
  }

  /** Owning source name. */
  getSource(): string {
    return this.getLatest().__source
  }

  /** Owner-scoped reference id. */
  getReference(): string {
    return this.getLatest().__ref
  }

  /** Inline display label. */
  getLabel(): string {
    return this.getLatest().__label
  }

  /** Optional domain glyph. */
  getAppearance(): ReferenceInsert['appearance'] {
    return this.getLatest().__appearance
  }

  /** React face rendered into the host element by the decorator portal. */
  override decorate(): JSX.Element {
    return (
      <ReferenceChip
        label={this.__label}
        appearance={this.__appearance}
        invalid={this.__invalid}
      />
    )
  }
}

/**
 * Mint one chip node from a reference insertion.
 * @param insert - the owner's reference insertion.
 * @returns the fresh node.
 */
export function $createReferenceChipNode(insert: ReferenceInsert): ReferenceChipNode {
  return new ReferenceChipNode(insert)
}

/**
 * Chip type guard.
 * @param node - any node or nullish.
 * @returns whether the node is a ReferenceChipNode.
 */
export function $isReferenceChipNode(node: LexicalNode | null | undefined): node is ReferenceChipNode {
  return node instanceof ReferenceChipNode
}
