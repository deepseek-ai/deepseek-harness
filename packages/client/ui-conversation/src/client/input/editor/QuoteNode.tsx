/** Atomic composer quote node and whole-node removal command. */

import type { JSX } from 'react'
import { QuotePreview } from '@deepseek-ai/dsh-client-ui-primitives'
import { formatQuoteText } from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  EditorConfig, LexicalEditor, LexicalNode, NodeKey, SerializedLexicalNode, Spread,
} from 'lexical'
import { createCommand, DecoratorNode } from 'lexical'

/** Localized non-persisted labels applied by the owning input shell. */
export interface QuoteNodeLabels {
  readonly remove: string
}

const EMPTY_LABELS: QuoteNodeLabels = { remove: '' }

/** JSON form used only by Lexical's editor-state APIs, not browser persistence. */
export type SerializedQuoteNode = Spread<{
  text: string
}, SerializedLexicalNode>

/** Remove one quote occurrence by its Lexical identity. */
export const REMOVE_QUOTE_COMMAND = createCommand<NodeKey>('REMOVE_QUOTE_COMMAND')

/** Pure React face of one quote node. */
export function QuoteNodeView({ editor, nodeKey, text, labels }: {
  readonly editor: LexicalEditor
  readonly nodeKey: NodeKey
  readonly text: string
  readonly labels: QuoteNodeLabels
}) {
  return (
    <QuotePreview
      text={text}
      removal={{
        label: labels.remove,
        onRemove: () => { editor.dispatchCommand(REMOVE_QUOTE_COMMAND, nodeKey) },
      }}
    />
  )
}

/** One selected transcript range represented as an atomic inline decorator. */
export class QuoteNode extends DecoratorNode<JSX.Element> {
  __text: string
  __labels: QuoteNodeLabels

  /** Lexical node registry type tag. */
  static override getType(): string {
    return 'quote'
  }

  /** @param node - node to clone. @returns a copy carrying the same NodeKey. */
  static override clone(node: QuoteNode): QuoteNode {
    return new QuoteNode(
      node.__text,
      node.__labels,
      node.__key,
    )
  }

  /** @param json - serialized editor node. @returns a fresh node with default runtime labels. */
  static override importJSON(json: SerializedQuoteNode): QuoteNode {
    return new QuoteNode(json.text)
  }

  /**
   * @param text - selected text.
   * @param labels - runtime-only localized labels.
   * @param key - Lexical clone-path key; absent for fresh nodes.
   */
  constructor(
    text: string,
    labels: QuoteNodeLabels = EMPTY_LABELS,
    key?: NodeKey,
  ) {
    super(key)
    this.__text = text
    this.__labels = labels
  }

  /** Serialize the quote data without its runtime presentation state. */
  override exportJSON(): SerializedQuoteNode {
    return {
      ...super.exportJSON(),
      type: 'quote',
      version: 1,
      text: this.__text,
    }
  }

  /** Mount one non-editable inline host. */
  override createDOM(_config: EditorConfig): HTMLElement {
    const element = document.createElement('span')
    element.setAttribute('data-composer-quote', '')
    element.setAttribute('contenteditable', 'false')
    return element
  }

  /** Updates reuse the existing host element. */
  override updateDOM(): boolean {
    return false
  }

  /** Quotes flow with draft text and wrap at their own text boundary. */
  override isInline(): boolean {
    return true
  }

  /** Arrow movement crosses the quote without entering a NodeSelection. */
  override isKeyboardSelectable(): boolean {
    return false
  }

  /** Clipboard text is the exact model-visible Markdown blockquote. */
  override getTextContent(): string {
    return formatQuoteText(this.__text)
  }

  /** Selected visible quote text. */
  getQuoteText(): string {
    return this.getLatest().__text
  }

  /** Update the localized remove label without changing persisted quote data. */
  setLabels(labels: QuoteNodeLabels): void {
    if (this.getLatest().__labels.remove !== labels.remove) this.getWritable().__labels = labels
  }

  /** Render the quote body and its independent close control. */
  override decorate(editor: LexicalEditor): JSX.Element {
    return (
      <QuoteNodeView
        editor={editor}
        nodeKey={this.__key}
        text={this.__text}
        labels={this.__labels}
      />
    )
  }
}

/** @param text - selected quote text. @param labels - runtime labels. @returns a fresh node. */
export function $createQuoteNode(text: string, labels: QuoteNodeLabels): QuoteNode {
  return new QuoteNode(text, labels)
}

/** @param node - possible Lexical node. @returns whether it is a QuoteNode. */
export function $isQuoteNode(node: LexicalNode | null | undefined): node is QuoteNode {
  return node instanceof QuoteNode
}
