/**
 * Plain-text reference decoration (the plain-text-reference decision;
 * see .agents/notes/archived/architecture/2026-07-25-web-input-machine-and-slash-pipeline.md):
 * a `/name` or `@name` token whose name is on the trigger's lexicon, and
 * syntax-recognizable `@dir/` folder tokens, render in the chip family
 * colors. Color only, no icon: a token still carrying its trigger character
 * is editable text, not a settled chip — the domain icon marks exactly the
 * settled state. Pure derivation as before — the entity transform converts
 * matching text into TextRefNode and back as edits move it in and out of
 * match shape; no occurrence identity exists.
 */
import type { EditorConfig, LexicalEditor, SerializedTextNode } from 'lexical'
import { TextNode } from 'lexical'
import { registerLexicalTextEntity } from '@lexical/text'
import { mergeRegister } from '@lexical/utils'
import { $getRoot } from 'lexical'
import { scanTextRefs } from '../decorations.ts'
import css from './composer-editor.module.css'

/** JSON form of one text-ref node. */
export type SerializedTextRefNode = SerializedTextNode

/** One matched plain-text reference as a styled, fully editable text node. */
export class TextRefNode extends TextNode {
  /** Lexical node registry type tag. */
  static override getType(): string {
    return 'composer-text-ref'
  }

  /**
   * Clone with identity (Lexical writable-copy contract).
   * @param node - node to clone.
   * @returns a copy carrying the same NodeKey.
   */
  static override clone(node: TextRefNode): TextRefNode {
    return new TextRefNode(node.__text, node.__key)
  }

  /**
   * Rebuild one text-ref from its JSON form.
   * @param json - serialized node.
   * @returns a fresh node.
   */
  static override importJSON(json: SerializedTextRefNode): TextRefNode {
    const node = new TextRefNode(json.text)
    node.setFormat(json.format)
    node.setDetail(json.detail)
    node.setMode(json.mode)
    node.setStyle(json.style)
    return node
  }

  /** Serialize to the JSON node form. */
  override exportJSON(): SerializedTextRefNode {
    return {
      ...super.exportJSON(),
      type: 'composer-text-ref',
    }
  }

  /** Style the span the base TextNode mounts. */
  override createDOM(config: EditorConfig): HTMLElement {
    const el = super.createDOM(config)
    el.classList.add(css.textRef ?? 'textRef')
    el.setAttribute('data-composer-text-ref', '')
    return el
  }

  /** Entity nodes never merge with plain siblings (the transform owns their bounds). */
  override isTextEntity(): true {
    return true
  }

  /** Editing continues inside; the transform re-evaluates match shape per edit. */
  override canInsertTextBefore(): boolean {
    return true
  }
}

/**
 * Register the plain-text reference entity transform. The claim decoration
 * has precedence on the leading-token seat: while a command claim holds, the
 * claimed token must stay a plain TextNode (transforms register per concrete
 * node class, so a TextRefNode would never receive the TextNode claim
 * transform and the warn color would be lost).
 * @param editor - the shell-owned editor.
 * @param lexiconOf - live per-trigger name-roll accessor (the controller's aggregated store).
 * @param activeToken - live claim token accessor; null while unclaimed.
 * @returns the unregister disposer.
 */
export function registerTextRefDecoration(
  editor: LexicalEditor,
  lexiconOf: () => ReadonlyMap<'/' | '@', readonly string[]>,
  activeToken: () => string | null,
): () => void {
  const getMatch = (text: string): { start: number; end: number } | null => {
    const claim = activeToken()
    for (const range of scanTextRefs(text, lexiconOf())) {
      if (claim !== null && range.start === 0 && text.slice(range.start, range.end) === claim) continue
      return { start: range.start, end: range.end }
    }
    return null
  }
  return mergeRegister(
    ...registerLexicalTextEntity(
      editor,
      getMatch,
      TextRefNode,
      node => new TextRefNode(node.getTextContent()),
    ),
  )
}

/**
 * Force a re-scan of the whole document (transforms only visit dirty nodes;
 * a lexicon roll change dirties nothing on its own). Queued, not discrete —
 * the caller may sit inside an update listener.
 * @param editor - the shell-owned editor.
 */
export function rescanTextRefs(editor: LexicalEditor): void {
  editor.update(() => {
    for (const node of $getRoot().getAllTextNodes()) node.markDirty()
  })
}
