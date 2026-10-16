/**
 * CommandChipNode: the claimed slash command as one atomic Lexical decorator
 * on the document's leading seat. The node carries the claim it was inserted
 * for, so a history restore of the node restores the claim with it.
 * `getTextContent()` answers the token without its argument separator; the
 * separator is an ordinary text node after the chip. The detect projection
 * counts the chip as one U+FFFC; see projection.ts.
 */
import type { JSX } from 'react'
import type {
  LexicalEditor, LexicalNode, NodeKey, SerializedLexicalNode, Spread,
} from 'lexical'
import { $createTextNode, DecoratorNode, ParagraphNode } from 'lexical'
import { mergeRegister } from '@lexical/utils'
import type { CommandClaim } from '../../contract/input.ts'
import { CommandChip } from './CommandChip.tsx'

/** JSON form of one command chip (Lexical node serialization contract). */
export type SerializedCommandChipNode = Spread<{ text: string }, SerializedLexicalNode>

/** One claimed command as an atomic decorator node. */
export class CommandChipNode extends DecoratorNode<JSX.Element> {
  /** The claim this chip anchors; its submit closure has no JSON form. */
  __claim: CommandClaim

  /** Lexical node registry type tag. */
  static override getType(): string {
    return 'command-chip'
  }

  /**
   * Clone with identity (Lexical writable-copy contract).
   * @param node - node to clone.
   * @returns a copy carrying the same NodeKey and claim.
   */
  static override clone(node: CommandChipNode): CommandChipNode {
    return new CommandChipNode(node.__claim, node.__key)
  }

  /**
   * Rebuild one chip from its JSON form. JSON cannot carry the claim's
   * submit closure, so an imported command is its literal token text.
   * @param json - serialized chip.
   * @returns a plain text node holding the token.
   */
  static override importJSON(json: SerializedCommandChipNode): LexicalNode {
    return $createTextNode(json.text)
  }

  /**
   * @param claim - the command claim the chip anchors.
   * @param key - Lexical clone-path key; absent for fresh nodes.
   */
  constructor(claim: CommandClaim, key?: NodeKey) {
    super(key)
    this.__claim = claim
  }

  /** Serialize to the JSON node form (the token text alone). */
  override exportJSON(): SerializedCommandChipNode {
    return {
      ...super.exportJSON(),
      type: 'command-chip',
      version: 1,
      text: this.getTextContent(),
    }
  }

  /**
   * Mount the chip's host element; the decorator portal renders into it.
   * @returns an inline, non-editable span carrying the test/e2e anchor.
   */
  override createDOM(): HTMLElement {
    const el = document.createElement('span')
    el.setAttribute('data-composer-command', this.__claim.name)
    el.setAttribute('contenteditable', 'false')
    return el
  }

  /** Host element never changes shape. */
  override updateDOM(): boolean {
    return false
  }

  /** The chip sits in the text line. */
  override isInline(): boolean {
    return true
  }

  /**
   * Arrows step across the chip and the default character deletion removes
   * it whole, for the reason documented on ReferenceChipNode.isKeyboardSelectable;
   * registerCommandChipSelection inserts the selecting step before that deletion.
   */
  override isKeyboardSelectable(): boolean {
    return false
  }

  /** Clipboard / persistence projection: the token without its separator. */
  override getTextContent(): string {
    return this.__claim.token.trimEnd()
  }

  /** The claim this chip anchors. */
  getClaim(): CommandClaim {
    return this.getLatest().__claim
  }

  /** React face rendered into the host element by the decorator portal. */
  override decorate(): JSX.Element {
    return <CommandChip token={this.getTextContent()} />
  }
}

/**
 * Mint one chip node for a claim.
 * @param claim - the command claim.
 * @returns the fresh node.
 */
export function $createCommandChipNode(claim: CommandClaim): CommandChipNode {
  return new CommandChipNode(claim)
}

/**
 * Command chip type guard.
 * @param node - any node or nullish.
 * @returns whether the node is a CommandChipNode.
 */
export function $isCommandChipNode(node: LexicalNode | null | undefined): node is CommandChipNode {
  return node instanceof CommandChipNode
}

/** Replace a displaced chip with its literal token. */
function $releaseChip(chip: CommandChipNode): void {
  chip.replace($createTextNode(chip.getTextContent()))
}

/**
 * Keep command chips on the leading seat. A chip anywhere but the first
 * child of the first block (text, a line break, or a block inserted before
 * it) becomes its literal token, which releases the claim. Inserting a
 * sibling before the chip or moving it to another block marks the chip dirty;
 * a block inserted before the chip's block marks only that block dirty.
 * @param editor - the shell-owned editor.
 * @returns the unregister disposer.
 */
export function registerCommandChipSeat(editor: LexicalEditor): () => void {
  return mergeRegister(
    editor.registerNodeTransform(CommandChipNode, (chip) => {
      if (chip.getPreviousSibling() !== null || chip.getParentOrThrow().getPreviousSibling() !== null) $releaseChip(chip)
    }),
    editor.registerNodeTransform(ParagraphNode, (block) => {
      const first = block.getFirstChild()
      if ($isCommandChipNode(first) && block.getPreviousSibling() !== null) $releaseChip(first)
    }),
  )
}
